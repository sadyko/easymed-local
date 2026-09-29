// Server-side cash-shift RPCs (cash register / drawer reconciliation).
// All money math (expected drawer, over/short) is computed here from DB
// rows — client-supplied amounts are never trusted. Every handler runs its
// DB work inside db.transaction(...)() for atomicity.

import { rpcT } from '../server-message.js';   // V3120_I18N — собранные фразы переводятся на экране
import { today as localToday, localRangeWhere } from '../domain/day.js';   // V3120_FIX (PERF) — дневные ветки по индексам
import { outstandingWhere, idemReplay, idemRemember } from '../domain/money.js';   // V3120_FIX — ключ повтора
import { assertTransition } from '../domain/lifecycle.js';
import { hasAnyRole, explicitSectionLevel } from '../roles.js';
import { countsAsInflow } from '../../../public/js/shared/payment-methods.js';   // DEPOSIT_REVENUE_V1
import { IN_BED_STATUSES } from '../../../public/js/shared/admission-status.js';   // DEBT_FLOW_V1 — «пациент ещё на койке»
// BRANCH_MONEY_GUARD_V1 — тот же запрет и та же формулировка, что в billing.js:
// чужие деньги отсюда только для чтения. Импорт, а не своя копия проверки:
// правило одно, и звучать оно обязано одинаково, с какого бы экрана в счёт ни
// пришли. Касса — последний экран, у которого счёт открыт целиком, и первый, с
// которого его можно стереть.
import { assertOwnBuilding, PERFORMED_LINE_STATUSES } from './billing.js';
import { markRefundRelease, refundedLineIds, notRefundReleasedSql } from '../domain/pay-releases.js';   // PAY_REFUND_V1 — отпущено со счёта с возвратом; CASHIER_PAID_SWAP_V1 — «возвращено» у строк; REFERRAL_BILL_V1 — «Ждут счёта»
import { lineUnitPrice, consultationFor } from '../domain/pricing.js';   // REFERRAL_BILL_V1 — сумма «Ждут счёта» по правилу цены счёта
// V3120_FIX (MAJOR) — снятая при отмене товарная строка возвращает товар туда,
// откуда его взяли (одно правило на сервер, rpc/inventory.js).
import { restoreSources } from './inventory.js';
import { voidReleasedDoseLines } from './treatment-orders.js';   // V3120_FINAL (S1) — снятая доза не остаётся к оплате

export class RpcError extends Error {
  constructor(msg, status = 400) {
    super(msg);
    this.status = status;
  }
}

const SHIFT_ROLES = ['admin', 'cashier'];
// Upper bound on any single money input. Guards round2() from overflowing a
// huge-but-finite value (e.g. 1e308) to Infinity, which would poison a shift's
// stored expected/over_short and any report that SUMs across shifts.
const MAX_MONEY = 1e12;

// CASHIER_HEAD_V1 (2026-09-28) — «СТАРШИЙ КАССИР» ПРОВЕРЯЕТ И СЕРВЕР.
//
// Экран «Старший кассир» (раздел `cashier-head`) показывал все смены, но
// открыть отчёт чужой смены или закрыть её сервер позволял одному
// администратору — старший кассир видел смену, с которой ничего не мог
// сделать. Теперь уровень раздела решает:
//   «Просмотр»  — X-отчёт любой смены (shift_report с чужим shift_id);
//   «Изменение» — ещё и пересчитать и закрыть чужую смену (close_cash_shift).
// Раздел выдаётся надстройкой head_cashier (миграция 218) или в «Ролях».
// Администратор — всё, как и раньше. Ревью: раздел, записанный без уровня
// (старый экран), — только просмотр; закрывать чужие смены даёт лишь
// явное «Изменение» (explicitSectionLevel).
export function headCashierLevel(db, user) {
  if (hasAnyRole(user, ['admin'])) return 'edit';
  const lvl = explicitSectionLevel(db, user, 'cashier-head');
  if (lvl === 'editor' || lvl === 'admin') return 'edit';
  return lvl === 'viewer' ? 'view' : 'none';
}

function requireRole(user, allowed) {
  // MULTI_ROLE_SERVER_V1 — extras count too, not the primary role alone.
  if (!hasAnyRole(user, allowed)) {
    // REPORTS_AUDIT_FIX_V1 — отказ читает человек: по-русски.
    throw new RpcError('Касса доступна кассиру и администратору — вашей роли это действие недоступно.', 403);
  }
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// A money amount the cashier declares (float / counted): finite, >= 0, capped.
function isValidMoney(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_MONEY;
}

function isPositiveInt(v) {
  return Number.isInteger(v) && v > 0;
}

const AUTO_CLOSE_NOTE = 'Закрыта автоматически (конец дня 00:00) — не пересчитана';

// SHIFT_AUTOCLOSE_V1 — смена живёт один календарный день (00:00–00:00).
// Любая смена, открытая до сегодняшней локальной даты, закрывается автоматически:
// БЕЗ пересчёта (V3120_FIX: counted/over_short пустые, auto_closed = 1), closed_at =
// локальная полночь после дня открытия (в UTC). Вызывается лениво из шифтовых
// RPC и периодически из server/index.js — работает и если сервер был выключен
// в полночь: закрытие произойдёт при первом же обращении утром.
export function autoCloseStaleShifts(db) {
  const stale = db.prepare(`
    SELECT * FROM cash_shifts
    WHERE status = 'open'
      AND date(opened_at, 'localtime') < date('now', 'localtime')
  `).all();
  const run = db.transaction(() => {
    for (const shift of stale) {
      const cashSum = db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE shift_id=? AND method='cash'").get(shift.id).s;
      const moves = movementTotals(db, shift.id);
      const expected = round2(shift.opening_float + cashSum + moves.cash_in - moves.cash_out);
      // V3120_FIX (MAJOR) — НЕ ПЕРЕСЧИТАНА. Прежде counted = expected и
      // over_short = 0: история смен показывала «сошлось», хотя ящик никто не
      // открывал. Теперь пересчёта нет (NULL), отметка auto_closed = 1, а
      // наличные этой смены становятся остатком следующей (ensureOpenShift) —
      // их пересчитают на её закрытии.
      db.prepare(`
        UPDATE cash_shifts
        SET status = 'closed',
            closed_at = strftime('%Y-%m-%dT%H:%M:%SZ', datetime(date(opened_at, 'localtime'), '+1 day', 'utc')),
            counted_amount = NULL,
            expected_amount = ?,
            over_short = NULL,
            auto_closed = 1,
            notes = CASE WHEN notes IS NULL OR notes = '' THEN ? ELSE notes || ' · ' || ? END
        WHERE id = ? AND status = 'open'
      `).run(expected, AUTO_CLOSE_NOTE, AUTO_CLOSE_NOTE, shift.id);
    }
    return stale.length;
  });
  return { closed: run() };
}

// SHIFT_AUTO_V2 — касса полностью автоматическая: если у кассира нет открытой
// смены (новая смена = новый день), она открывается сама с нулевым остатком.
// Кассир не видит ни «Открыть смену», ни «Закрыть смену» — день закрывается
// в полночь (autoCloseStaleShifts), день начинается с первого обращения.
export function ensureOpenShift(db, user) {
  autoCloseStaleShifts(db);
  let shift = db.prepare("SELECT * FROM cash_shifts WHERE cashier_id=? AND status='open' ORDER BY id DESC LIMIT 1").get(user.id);
  if (!shift) {
    const carry = uncountedCarry(db, user.id);
    const info = db.prepare(`
      INSERT INTO cash_shifts (cashier_id, opening_float, status, notes)
      VALUES (?, ?, 'open', ?)
    `).run(user.id, carry, carry > 0
      ? 'Открыта автоматически (начало дня); остаток — наличные непересчитанной смены'
      : 'Открыта автоматически (начало дня)');
    shift = db.prepare('SELECT * FROM cash_shifts WHERE id = ?').get(info.lastInsertRowid);
  }
  return shift;
}

// V3120_FIX (MAJOR) — ОСТАТОК, С КОТОРОГО НАЧИНАЕТСЯ НОВАЯ СМЕНА КАССИРА.
// Последняя смена этого кассира закрыта автоматически, без пересчёта: её
// наличные никто не вынимал, они лежат в ящике — новая смена начинается с них
// (expected_amount той смены), и её пересчёт проверяет и вчерашние деньги.
// Пересчитанная вручную смена ничего не переносит (кассир сдал ящик).
function uncountedCarry(db, cashierId) {
  const last = db.prepare('SELECT auto_closed, expected_amount FROM cash_shifts WHERE cashier_id = ? ORDER BY id DESC LIMIT 1').get(cashierId);
  return last && last.auto_closed === 1 ? Math.max(0, round2(Number(last.expected_amount) || 0)) : 0;
}

export function openCashShift(db, args, user) {
  requireRole(user, SHIFT_ROLES);

  const rawFloat = args && args.opening_float !== undefined ? args.opening_float : 0;
  if (!isValidMoney(rawFloat)) {
    throw new RpcError('Начальный остаток должен быть неотрицательным числом.', 400);
  }
  const openingFloat = round2(rawFloat);

  const rawBranch = args && args.branch_id;
  const branchId = isPositiveInt(rawBranch) ? rawBranch : null;

  autoCloseStaleShifts(db);   // SHIFT_AUTOCLOSE_V1 — вчерашняя смена не блокирует новую
  const run = db.transaction(() => {
    const existing = db.prepare("SELECT id FROM cash_shifts WHERE cashier_id=? AND status='open'").get(user.id);
    if (existing) {
      throw new RpcError('У вас уже открыта смена.', 400);
    }

    const info = db.prepare(`
      INSERT INTO cash_shifts (cashier_id, branch_id, opening_float, status)
      VALUES (?, ?, ?, 'open')
    `).run(user.id, branchId, openingFloat);

    const shift = db.prepare('SELECT * FROM cash_shifts WHERE id = ?').get(info.lastInsertRowid);
    return { shift };
  });

  return run();
}

export function closeCashShift(db, args, user) {
  requireRole(user, SHIFT_ROLES);
  autoCloseStaleShifts(db);   // SHIFT_AUTOCLOSE_V1

  const shiftId = args && args.shift_id;
  if (!isPositiveInt(shiftId)) {
    throw new RpcError('Смена указана неверно.', 400);
  }

  const rawCounted = args && args.counted_amount;
  if (!isValidMoney(rawCounted)) {
    throw new RpcError('Пересчитанная сумма должна быть неотрицательным числом.', 400);
  }
  const countedAmount = round2(rawCounted);

  const rawNotes = args && args.notes !== undefined ? args.notes : '';
  const notes = (typeof rawNotes === 'string' ? rawNotes : String(rawNotes)).slice(0, 500);

  const run = db.transaction(() => {
    const shift = db.prepare('SELECT * FROM cash_shifts WHERE id = ?').get(shiftId);
    if (!shift) {
      throw new RpcError('Смена не найдена.', 400);
    }
    if (shift.status !== 'open') {
      throw new RpcError('Смена уже закрыта.', 400);
    }
    // V3120_FIX (MAJOR) — админ дополнительной ролью тоже админ (hasAnyRole).
    // CASHIER_HEAD_V1 — и старший кассир с «Изменением» своего раздела.
    if (shift.cashier_id !== user.id && headCashierLevel(db, user) !== 'edit') {
      throw new RpcError('Закрыть можно только свою смену.', 403);
    }

    const cashSum = db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE shift_id=? AND method='cash'").get(shiftId).s;
    const moves = movementTotals(db, shiftId);
    const expected = round2(shift.opening_float + cashSum + moves.cash_in - moves.cash_out);
    const overShort = round2(countedAmount - expected);

    db.prepare(`
      UPDATE cash_shifts
      SET status = 'closed',
          closed_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
          counted_amount = ?,
          expected_amount = ?,
          over_short = ?,
          notes = ?,
          closed_by = ?
      WHERE id = ?
    `).run(countedAmount, expected, overShort, notes, user.id, shiftId);   // CASHIER_HEAD_V1 (мигр. 219) — кто закрыл

    return { shift: db.prepare('SELECT * FROM cash_shifts WHERE id = ?').get(shiftId) };
  });

  return run();
}

// SUM of drawer movements («Внести»/«Изъять») for a shift.
function movementTotals(db, shiftId) {
  const r = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN kind='in'  THEN amount END), 0) AS cash_in,
           COALESCE(SUM(CASE WHEN kind='out' THEN amount END), 0) AS cash_out
      FROM cash_movements WHERE shift_id = ?
  `).get(shiftId);
  return { cash_in: round2(r.cash_in), cash_out: round2(r.cash_out) };
}

// DEPOSIT_REVENUE_V1 — «кошелёк» показываем отдельной строкой, но в ИТОГ смены
// не кладём: этих денег кассир при себе не видел, они пришли раньше — когда
// принимали депозит. Иначе на пересчёте смена требовала бы объяснить сумму,
// которой в кассе никогда не было.
// REPORTS_AUDIT_FIX_V1 — «платежей: N» считало и возвраты (отрицательные
// платежи): смена с одной оплатой и её возвратом показывала «2 платежа».
// Теперь count — только оплаты, возвраты — отдельно (refund_count, refunds —
// сумма возвращённого, положительным числом). Итог total по-прежнему чистый:
// оплаты минус возвраты — ровно то, что осталось в кассе.
function paymentTotals(db, shiftId) {
  const rows = db.prepare(`SELECT method, COALESCE(SUM(amount),0) s,
                                  SUM(CASE WHEN amount >= 0 THEN 1 ELSE 0 END) n,
                                  SUM(CASE WHEN amount < 0 THEN 1 ELSE 0 END) rn,
                                  COALESCE(SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END),0) rs
                             FROM payments WHERE shift_id=? GROUP BY method`).all(shiftId);
  const totals = { cash: 0, card: 0, transfer: 0, acquiring: 0, wallet: 0, gift_card: 0, total: 0, count: 0, refund_count: 0, refunds: 0 };   // CARD_BALANCE_V1
  for (const row of rows) {
    if (Object.prototype.hasOwnProperty.call(totals, row.method)) {
      totals[row.method] = round2(row.s);
    }
    if (countsAsInflow(row.method)) {
      totals.total = round2(totals.total + row.s);
      totals.count += row.n || 0;
      totals.refund_count += row.rn || 0;
      totals.refunds = round2(totals.refunds + (row.rs || 0));
    }
  }
  return totals;
}

export function cashShiftSummary(db, args, user) {
  requireRole(user, SHIFT_ROLES);
  // V3120_FIX (MINOR) — СВОДКА ТОЛЬКО ЧИТАЕТ. Она стоит в READ_ONLY_RPCS
  // (control/gate.js) и отвечает клинике с просроченной лицензией, а открывала
  // смену (ensureOpenShift) — то есть писала мимо блокировки. Смену открывает
  // первый платёж / возврат / движение дня (ensureOpenShift там); до него
  // сводка показывает ДЕНЬ БЕЗ ЗАПИСАННОЙ СМЕНЫ: shift.id = null, остаток —
  // наличные непересчитанной вчерашней смены (uncountedCarry), итоги нулевые.
  // Незакрытая вчерашняя смена показывается как есть (экран помечает её
  // «вчерашней»); закроет её первая запись дня.
  let shift = db.prepare("SELECT * FROM cash_shifts WHERE cashier_id=? AND status='open' ORDER BY id DESC LIMIT 1").get(user.id);
  if (!shift) {
    const now = db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now') n").get().n;
    shift = { id: null, cashier_id: user.id, branch_id: null, opening_float: uncountedCarry(db, user.id), opened_at: now,
              closed_at: null, counted_amount: null, expected_amount: null, over_short: null, status: 'open',
              notes: '', auto_closed: 0, virtual: true };
  }

  const totals = shift.id ? paymentTotals(db, shift.id) : paymentTotals(db, -1);
  const moves = shift.id ? movementTotals(db, shift.id) : { cash_in: 0, cash_out: 0 };
  // Остаток наличных = старт смены + приход наличных (оплаты + внесения) − расход.
  const expectedDrawer = round2(shift.opening_float + totals.cash + moves.cash_in - moves.cash_out);

  const branch = shift.branch_id
    ? db.prepare('SELECT name FROM branches WHERE id = ?').get(shift.branch_id)
    : db.prepare('SELECT name FROM branches ORDER BY id LIMIT 1').get();

  return {
    shift, totals,
    cash_in: moves.cash_in,
    cash_out: moves.cash_out,
    expected_drawer: expectedDrawer,
    cashier_name: (db.prepare('SELECT full_name, username FROM users WHERE id = ?').get(shift.cashier_id) || {}).full_name || null,
    branch_name: branch ? branch.name : null,
  };
}

// CASHIER_DESIGN_V2 — «Внести» / «Изъять»: a drawer movement on the caller's
// own open shift. Withdrawals may not overdraw the drawer.
export function cashMove(db, args, user) {
  requireRole(user, SHIFT_ROLES);
  { const seen = idemReplay(db, 'cash_move', args); if (seen) return seen; }   // V3120_FIX — повтор той же формы

  const kind = args && args.kind;
  if (kind !== 'in' && kind !== 'out') {
    throw new RpcError('Укажите движение: внести или изъять.', 400);
  }
  const rawAmount = args && args.amount;
  if (!isValidMoney(rawAmount) || rawAmount <= 0) {
    throw new RpcError('Сумма должна быть положительным числом.', 400);
  }
  const amount = round2(rawAmount);
  const article = String((args && args.article) || '').slice(0, 200);
  const note = String((args && args.note) || '').slice(0, 500);

  const run = db.transaction(() => {
    // V3120_FIX — движение дня, как платёж, открывает смену само (сводка
    // больше не открывает её, см. cashShiftSummary).
    const shift = ensureOpenShift(db, user);
    if (kind === 'out') {
      const cashSum = db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE shift_id=? AND method='cash'").get(shift.id).s;
      const moves = movementTotals(db, shift.id);
      const drawer = round2(shift.opening_float + cashSum + moves.cash_in - moves.cash_out);
      if (amount > drawer) {
        throw rpcT(RpcError, 'В кассе только {drawer} — изъять {amount} нельзя.', { drawer, amount }, 400);
      }
    }
    const info = db.prepare(`
      INSERT INTO cash_movements (shift_id, kind, amount, article, note, created_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(shift.id, kind, amount, article, note, user.id);
    return idemRemember(db, 'cash_move', args, user, { movement: db.prepare('SELECT * FROM cash_movements WHERE id = ?').get(info.lastInsertRowid) });
  });

  return run();
}

// CASHIER_DESIGN_V2 — data for «X-отчёт» / «Внутренний отчёт» / «История»:
// the shift row + per-method totals + drawer movements + the payment log.
// Defaults to the caller's open shift; admins may pass any shift_id.
export function shiftReport(db, args, user) {
  requireRole(user, SHIFT_ROLES);

  let shift;
  const shiftId = args && args.shift_id;
  if (shiftId !== undefined && shiftId !== null) {
    if (!isPositiveInt(shiftId)) {
      throw new RpcError('Смена указана неверно.', 400);   // REPORTS_AUDIT_FIX_V1 — по-русски
    }
    shift = db.prepare('SELECT * FROM cash_shifts WHERE id = ?').get(shiftId);
    if (!shift) {
      throw new RpcError('Смена не найдена.', 400);
    }
    if (shift.cashier_id !== user.id && headCashierLevel(db, user) === 'none') {   // V3120_FIX — и дополнительной ролью; CASHIER_HEAD_V1 — и старший кассир
      throw new RpcError('Можно смотреть только свою смену.', 403);
    }
  } else {
    shift = db.prepare("SELECT * FROM cash_shifts WHERE cashier_id=? AND status='open' ORDER BY id DESC LIMIT 1").get(user.id);
    if (!shift) {
      // V3120_FIX — сводка больше не открывает смену сама (cashShiftSummary),
      // поэтому X-отчёт до первой записи дня — пустой день, а не отказ.
      const now = db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now') n").get().n;
      const opening = uncountedCarry(db, user.id);
      return {
        shift: { id: null, cashier_id: user.id, opening_float: opening, opened_at: now, status: 'open', virtual: true },
        totals: paymentTotals(db, -1), payments: [], movements: [], cash_in: 0, cash_out: 0,
        expected_drawer: opening,
        cashier_name: (db.prepare('SELECT full_name FROM users WHERE id = ?').get(user.id) || {}).full_name || null,
      };
    }
  }

  const totals = paymentTotals(db, shift.id);
  const moves = movementTotals(db, shift.id);
  const payments = db.prepare(`
    SELECT p.paid_at, p.amount, p.method,
           i.invoice_number AS invoice, pt.full_name AS patient
      FROM payments p
      JOIN invoices i ON i.id = p.invoice_id
      JOIN patients pt ON pt.id = i.patient_id
     WHERE p.shift_id = ?
     ORDER BY p.paid_at DESC
  `).all(shift.id);
  const movements = db.prepare('SELECT * FROM cash_movements WHERE shift_id = ? ORDER BY id DESC').all(shift.id);

  return {
    shift, totals, payments, movements,
    cash_in: moves.cash_in,
    cash_out: moves.cash_out,
    expected_drawer: round2(shift.opening_float + totals.cash + moves.cash_in - moves.cash_out),
    cashier_name: (db.prepare('SELECT full_name FROM users WHERE id = ?').get(shift.cashier_id) || {}).full_name || null,
  };
}

// V3120_FIX (PERF) — КАКИЕ СЧЕТА В «ПРИЁМЕ ОПЛАТ»: ОБЪЕДИНЕНИЕ ВЕТОК ПО ИНДЕКСАМ.
//
// Правило прежнее (DAY_ZERO_V1, CANCEL_MEANS_CANCEL_V1): неоплаченные, частично
// оплаченные и долги — всегда; оплаченные — за сегодня по дню оплаты;
// отменённые и возвращённые — за сегодня по дню отмены (без отметки — по дню
// создания). Прежде оно было одним WHERE с date(col,'localtime') через OR, и
// SQLite читал все счета клиники: на 354 тыс. счетов — 1,7–2,2 с на каждое
// открытие кассы, а база однопоточная, и всё это время ждали остальные экраны.
// Теперь каждая часть — своя ветка со своим индексом (миграция 210:
// status+created_at, paid_at, voided_at, created_at), а день — диапазон по самой
// колонке (day.js localRangeWhere: точный для любого формата времени). Ответ
// — id счетов; список и чипы читают одно и то же множество.
function cashierInvoiceIds(db) {
  const d = localToday(db);
  const paid = localRangeWhere('paid_at', d, d);
  const voided = localRangeWhere('voided_at', d, d);
  const created = localRangeWhere('created_at', d, d);
  return {
    sql: `SELECT id FROM invoices WHERE ${outstandingWhere('status')}
          UNION SELECT id FROM invoices WHERE status = 'paid' AND ${paid.sql}
          UNION SELECT id FROM invoices WHERE status = 'paid' AND paid_at IS NULL AND ${created.sql}
          UNION SELECT id FROM invoices WHERE status IN ('void', 'refunded') AND ${voided.sql}
          UNION SELECT id FROM invoices WHERE status IN ('void', 'refunded') AND voided_at IS NULL AND ${created.sql}`,
    params: [...paid.params, ...created.params, ...voided.params, ...created.params],
  };
}

// CASHIER_DESIGN_V2 — the «Приём оплат» invoice list, joined server-side:
// patient (name/MRN/phone), doctor (via the visit), first service + item
// count, distinct payment methods, plus per-status aggregates for the chips.
export function cashierInvoices(db, args, user) {
  requireRole(user, SHIFT_ROLES);

  const ids = cashierInvoiceIds(db);
  const rows = db.prepare(`
    SELECT i.id, i.invoice_number, i.status, i.subtotal, i.discount_amount,
           i.total_amount, i.paid_amount, i.created_at, i.paid_at,
           pt.full_name AS patient_name, pt.mrn AS mrn, pt.phone AS phone,
           -- DEPOSIT_WALLET_V1 — окно оплаты спрашивает баланс пациента.
           i.patient_id AS patient_id,
           -- DEBT_FLOW_V1 — счёт стационара: окно отмены обязано знать, лежит
           -- ли пациент ещё на койке (тогда отмена его не выписывает).
           i.admission_id AS admission_id,
           -- CASHIER_HEAD_V1 — «Исправить услуги» добавляет строку в визит счёта.
           i.visit_id AS visit_id,
           (SELECT a.status FROM admissions a WHERE a.id = i.admission_id) AS admission_status,
           -- RECEIPT_PATIENT_ID_V1 — чек предъявляют в лаборатории как талон:
           -- по нему сверяют, ТОТ ли это пациент (ФИО + дата рождения + пол +
           -- номер карты). Без этих полей чек не отличает однофамильцев.
           pt.date_of_birth AS date_of_birth, pt.gender AS gender,
           doc.full_name AS doctor_name,
           -- COVERAGE_SPLIT_V1 — счёт может быть выставлен НЕ пациенту: часть
           -- услуг визита покрывает страховая/организация. Кассир обязан это
           -- видеть, иначе он потребует с пациента чужие деньги.
           i.payer_id AS payer_id, py.name AS payer_name, py.kind AS payer_kind,
           (SELECT COUNT(*) FROM invoice_items ii WHERE ii.invoice_id = i.id) AS items_count,
           (SELECT ii.description FROM invoice_items ii WHERE ii.invoice_id = i.id ORDER BY ii.id LIMIT 1) AS first_item,
           (SELECT GROUP_CONCAT(DISTINCT p.method) FROM payments p WHERE p.invoice_id = i.id) AS methods
      FROM (${ids.sql}) sel
      JOIN invoices i  ON i.id = sel.id
      JOIN patients pt ON pt.id = i.patient_id
      LEFT JOIN visits v ON v.id = i.visit_id
      LEFT JOIN users doc ON doc.id = v.doctor_id
      LEFT JOIN payers py ON py.id = i.payer_id
     -- COVERAGE_SPLIT_V1 — счета, выставленные страховой/организации, в кассу НЕ
     -- попадают: наличных по ним не берут, расчёт идёт по акту и договору.
     -- Иначе кассир видел бы «долг», который пациент не должен и оплатить не может.
     WHERE i.payer_id IS NULL
       -- FREE_SERVICE_V1 — счёт на ноль в кассу не попадает: взять по нему
       -- нечего, он закрыт в момент создания. Бесплатные консультации создавали
       -- по счёту на каждую и засоряли «Приём оплат» строками на 0 сум.
       AND i.total_amount > 0
     ORDER BY i.created_at DESC, i.id DESC
     LIMIT 500
  `).all(...ids.params);

  const counts = { unpaid: { n: 0, sum: 0 }, debt: { n: 0, sum: 0 }, partial: { n: 0, sum: 0 },
                   paid: { n: 0, sum: 0 }, cancelled: { n: 0, sum: 0 }, all: { n: 0, sum: 0 } };
  // DAY_ZERO_V1 — счётчики чипов по тем же правилам: оплаченные/отменённые
  // считаются только за сегодня, неоплаченные — накопительно.
  for (const r of db.prepare(`
    SELECT i.status, COUNT(*) n, COALESCE(SUM(i.total_amount),0) s
      FROM (${ids.sql}) sel JOIN invoices i ON i.id = sel.id
     WHERE i.payer_id IS NULL                                                          -- COVERAGE_SPLIT_V1: чипы считают только кассовые счета
     GROUP BY i.status
  `).all(...ids.params)) {
    const key = (r.status === 'void' || r.status === 'refunded') ? 'cancelled' : r.status;
    if (counts[key]) {
      counts[key].n += r.n;
      counts[key].sum = round2(counts[key].sum + r.s);
    }
    counts.all.n += r.n;
    counts.all.sum = round2(counts.all.sum + r.s);
  }

  return { rows, counts };
}

// CASHIER_DESIGN_V2 — cancel an invoice. Refund-less v1: only an invoice with
// no money on it can be voided (refunds are a follow-up); its not-yet-started
// visit services are unlinked so they can be re-billed.
// INVOICE_DELETE_V1 — убрать отменённый счёт из списка совсем.
//
// Отмена оставляет документ в «Приёме оплат» навсегда: за день набегает два
// десятка отменённых, и вкладка превращается в свалку, где рабочие счета не
// найти. Удаление — это уборка, а не правка денег, поэтому границы жёсткие:
//
//   • ТОЛЬКО главный админ. Касса отменяет (void), но не стирает: тот, кто
//     принимает деньги, не должен уметь убирать следы своих же документов.
//   • ТОЛЬКО status='void'. Оплаченный, неоплаченный, долг и частичный — это
//     живые деньги или обещание денег, их удаление не уборка, а потеря.
//   • ТОЛЬКО без единого платежа. 'refunded' под это правило не попадает
//     никогда: за возвратом стоит движение наличных, а payments кормят итоги
//     смены и X-отчёт — удали строку, и касса перестанет сходиться.
//
// Внешние ключи включены (connection.js: foreign_keys = ON), поэтому порядок
// удаления не косметика, а условие работоспособности: сначала снимаем ссылки
// на строки счёта, потом строки, и только потом сам счёт.
const DELETE_INVOICE_ROLES = ['admin'];

export function deleteInvoice(db, args, user) {
  requireRole(user, DELETE_INVOICE_ROLES);

  const invoiceId = args && args.invoice_id;
  if (!isPositiveInt(invoiceId)) {
    throw new RpcError('Счёт указан неверно.', 400);
  }

  const run = db.transaction(() => {
    const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
    if (!invoice) throw new RpcError('Счёт не найден.', 400);
    // BRANCH_MONEY_GUARD_V1 — ЧУЖОЙ СЧЁТ ОТСЮДА НЕ УДАЛЯЕТСЯ НИКОГДА, и это
    // проверяется раньше статуса: «не отменён» — не та причина, по которой
    // нельзя.
    //
    // Удаление здесь не остаётся здесь. Триггер invoices_journal_del (миграция
    // 087) на каждый DELETE чеканит надгробие, надгробие уезжает соседу — и
    // документ исчезает в ТОМ здании, где касса эти деньги приняла. Уборка
    // мусора в одной базе стала бы потерей чужого документа в другой, а узнали
    // бы об этом не здесь, а по несходящейся смене у соседа.
    assertOwnBuilding(db, invoice, 'Счёт');

    if (invoice.status !== 'void') {
      throw new RpcError('Удалить можно только отменённый счёт (Отменён). Этот — «' + invoice.status + '».', 400);
    }
    const pays = db.prepare('SELECT COUNT(*) n FROM payments WHERE invoice_id = ?').get(invoiceId);
    if ((pays && pays.n) > 0) {
      throw new RpcError('По счёту есть платежи — он остаётся в истории кассы.', 400);
    }

    // Ссылки на строки этого счёта: услуги визита и стационара продолжают жить,
    // просто перестают быть выставленными (void это уже сделал — повторяем на
    // случай строк, доставшихся от прежних версий).
    db.prepare(`UPDATE visit_services SET invoice_item_id = NULL
                 WHERE invoice_item_id IN (SELECT id FROM invoice_items WHERE invoice_id = ?)`).run(invoiceId);
    db.prepare(`UPDATE admission_services SET invoice_item_id = NULL
                 WHERE invoice_item_id IN (SELECT id FROM invoice_items WHERE invoice_id = ?)`).run(invoiceId);
    // Госпитализация помнит свой счёт отдельным полем — иначе FK не даст удалить.
    db.prepare('UPDATE admissions SET invoice_id = NULL WHERE invoice_id = ?').run(invoiceId);
    // CASHIER_HEAD_V1 (ревью) — журнал правок счёта ОСТАЁТСЯ: удаление —
    // уборка списка кассы, а не повод стереть, кто что менял в счёте. Ссылку
    // на удаляемый документ строки отпускают (FK), номер счёта в них остаётся
    // — так же, как при удалении счёта, оставшегося без строк (billing.js).
    db.prepare('UPDATE invoice_audit_log SET invoice_id = NULL WHERE invoice_id = ?').run(invoiceId);

    db.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').run(invoiceId);
    db.prepare('DELETE FROM invoices WHERE id = ?').run(invoiceId);

    // След в журнале сервера: сам документ стёрт, и это единственное место, где
    // потом можно будет узнать, кто и что убрал.
    console.warn('[invoice-delete] ' + (invoice.invoice_number || ('#' + invoiceId))
      + ' на ' + invoice.total_amount + ' удалён пользователем '
      + (user && (user.full_name || user.username || user.id)));

    return { deleted: true, invoice_number: invoice.invoice_number, total: invoice.total_amount };
  });

  return run();
}

export function voidInvoice(db, args, user) {
  requireRole(user, SHIFT_ROLES);

  const invoiceId = args && args.invoice_id;
  if (!isPositiveInt(invoiceId)) {
    throw new RpcError('Счёт указан неверно.', 400);
  }

  const run = db.transaction(() => {
    const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
    if (!invoice) {
      throw new RpcError('Счёт не найден.', 400);
    }
    // BRANCH_MONEY_GUARD_V1 — отменить чужой счёт отсюда нельзя. status — та
    // самая колонка, которая ЕЗДИТ (journal.js, SHIPPED.invoices): отмена ушла
    // бы соседу следующей же порцией и погасила бы там живой документ, по
    // которому его касса уже взяла деньги. Дальше по коду отмена ещё и снимает
    // с чужих строк визита ссылку на счёт — то есть переписывает работу
    // соседнего здания.
    assertOwnBuilding(db, invoice, 'Счёт');

    if (invoice.status === 'void' || invoice.status === 'refunded') {
      throw new RpcError('Счёт уже отменён.', 400);
    }
    if (invoice.paid_amount > 0) {
      throw new RpcError('По счёту уже приняты деньги — сначала оформите возврат.', 400);
    }

    // DEBT_FLOW_V1 — ПАЦИЕНТ ЕЩЁ НА КОЙКЕ: отмена счёта его НЕ выписывает.
    //
    // Владелец: «when we have cancelled the invoice the patient is still in
    // the stationary». Кассир отменял счёт как способ «закрыть вопрос» с
    // неплательщиком — а получал пациента в койке и пустой счёт: строки
    // возвращались в невыставленные (ADM_LINE_RELEASE_V1 ниже), долг исчезал
    // из всех цифр, и человек лежал «бесплатно». Правильный путь для ухода без
    // оплаты — выписка с подписью «Долг согласован»: счёт становится долгом.
    //
    // Это ПРЕДУПРЕЖДЕНИЕ, а не запрет (правило стационара: деньги
    // предупреждают, не блокируют): ошибочный счёт лежащему пациенту по-прежнему
    // можно отменить и выставить заново — с явным подтверждением in_bed_ack,
    // которое окно отмены показывает вместе с этим текстом.
    if (invoice.admission_id) {
      const adm = db.prepare(`
        SELECT a.status, w.name AS ward_name, b.code AS bed_code
          FROM admissions a
          LEFT JOIN wards w ON w.id = a.ward_id
          LEFT JOIN beds b ON b.id = a.bed_id
         WHERE a.id = ?`).get(invoice.admission_id);
      const inBedAck = args.in_bed_ack === true || args.in_bed_ack === 1;
      if (adm && IN_BED_STATUSES.includes(adm.status) && !inBedAck) {
        const place = [adm.ward_name, adm.bed_code].filter(Boolean).join(' · ');
        throw new RpcError(
          'Пациент ещё в стационаре' + (place ? ' (' + place + ')' : '') + '. Отмена счёта его не выписывает: '
          + 'услуги вернутся в невыставленные и попадут в новый счёт при выписке. '
          + 'Если пациент уходит не заплатив — оформите выписку, и счёт станет долгом. '
          + 'Чтобы всё же отменить счёт, подтвердите это в окне отмены.', 400);
      }
    }

    assertTransition('invoice', invoice.status, 'void');
    db.prepare("UPDATE invoices SET status = 'void', voided_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?").run(invoiceId);

    // CANCEL_MEANS_CANCEL_V1 (2026-09-18) — ОТМЕНА СЧЁТА СНИМАЕТ УСЛУГИ С ВИЗИТА.
    //
    // Владелец: «why in the cashier's cancelled invoices goes to the unpaid? and
    // if we were to cancel it should be cancelled».
    //
    // Раньше отмена возвращала неначатые услуги в «не выставлено» (status
    // 'added' без счёта) — «чтобы выставить заново». Но 'added' без счёта во
    // всей программе значит «ждёт кассу»: доска очереди показывала пациента как
    // «ожидает оплату», лаборатория — во вкладке «Не оплачено», кабинет врача
    // отказывал «услуга ещё не проведена кассой», а регистратура нажимала
    // «Выставить счёт» — и отменённый счёт возрождался в «НЕ ОПЛАЧЕН». Отмена
    // выглядела как ничего.
    //
    // Теперь неначатая услуга уходит вместе со счётом (как её убирает и
    // «Убрать услугу» в карте пациента); строки счёта остаются навсегда — это
    // и есть запись о том, что было выставлено. Начатая или оказанная работа
    // не удаляется никогда (что с ней происходит — ревью C1 ниже). Кассир, который отменяет счёт, чтобы выставить
    // его заново (скидка, другой плательщик), ставит галочку keep_services —
    // тогда услуги остаются в визите, как раньше. Услуга со следом работы
    // (результат анализа, документ, сообщение прибора) не удаляется никогда:
    // она остаётся в визите невыставленной, и это названо в ответе.
    // Стационар (admission_services) живёт по своему правилу ниже.
    //
    // PAY_BASIS_PERFORMED_V1, ревью C1 (2026-09-26) — СДЕЛАННАЯ РАБОТА ОТПУСКАЕТСЯ
    // СО СЧЁТА, А НЕ ОСТАЁТСЯ ПРИВЯЗАННОЙ К ОТМЕНЁННОМУ. Прежде начатая или
    // оказанная строка (in_progress / completed) оставалась со ссылкой на
    // отменённый счёт: выставить её снова было нельзя («already invoiced»), а
    // доля врача, считаемая по выполненному, выпадала вместе со счётом. Теперь
    // она, как строки стационара ниже (ADM_LINE_RELEASE_V1), просто теряет
    // ссылку на счёт и СОХРАНЯЕТ свой статус — работа сделана, её выставят
    // заново. То же для анализа, у которого взят материал или есть результат
    // (collected / resulted): его статус больше не откатывается в 'added'.
    // Строка со следом работы (результат, документ, сообщение прибора) тоже
    // сохраняет статус. В 'added' возвращается только неначатая строка без
    // следа, оставленная галочкой keep_services, — как прежде.
    const keepServices = args.keep_services === true || args.keep_services === 1;
    const PERFORMED = PERFORMED_LINE_STATUSES;   // INPATIENT_MONEY_FIX_V1 — один список с remove/change_unpaid_service
    const lines = db.prepare(`
      SELECT vs.id, vs.status, vs.clinic_item_id, vs.quantity, COALESCE(s.name, p.name, '') AS name
        FROM visit_services vs
        LEFT JOIN services s ON s.id = vs.service_id
        LEFT JOIN products p ON p.id = vs.clinic_item_id
       WHERE vs.invoice_item_id IN (SELECT id FROM invoice_items WHERE invoice_id = ?)`).all(invoiceId);
    const hasTrace = db.prepare(`
      SELECT (EXISTS(SELECT 1 FROM lab_results WHERE visit_service_id = ?)
           OR EXISTS(SELECT 1 FROM visit_documents WHERE visit_service_id = ?)
           OR EXISTS(SELECT 1 FROM lab_device_messages WHERE visit_service_id = ?)) AS t`);
    const release = db.prepare("UPDATE visit_services SET invoice_item_id = NULL, status = 'added' WHERE id = ?");
    const releaseKeepStatus = db.prepare('UPDATE visit_services SET invoice_item_id = NULL WHERE id = ?');
    const removed = [];
    const released = [];
    const releasedIds = [];
    for (const l of lines) {
      const trace = !!hasTrace.get(l.id, l.id, l.id).t;
      if (PERFORMED.includes(l.status) || trace) {
        releaseKeepStatus.run(l.id);
        released.push(l.name);
        releasedIds.push(l.id);
      } else if (!keepServices) {
        // V3120_FIX (MAJOR) — товарная строка (списанный бинт) уходила вместе со
        // счётом, а товар не возвращался никому: склад / подотчёт оставались
        // пустыми, в журнале висел расход без строки. Возврат — ДО удаления:
        // источники читаются из движений этой строки (как remove_unpaid_service).
        if (l.clinic_item_id != null) restoreSources(db, 'visit', l.id, l.clinic_item_id, l.quantity, user);
        // Талон очереди на снятую услугу тоже уходит: номер без услуги — мусор на доске.
        db.prepare('DELETE FROM service_queue_tickets WHERE visit_service_id = ?').run(l.id);
        db.prepare('DELETE FROM visit_services WHERE id = ?').run(l.id);
        removed.push(l.name);
      } else {
        release.run(l.id);
        released.push(l.name);
        releasedIds.push(l.id);
      }
    }
    // PAY_REFUND_V1 (владелец, 27.09) — отмена ПОСЛЕ ВОЗВРАТА: отпущенная
    // работа врачу не платится, пока её не выставят и не оплатят снова.
    // Отмена неоплаченного счёта без возвратов ничего не пишет.
    markRefundRelease(db, { invoiceId, kind: 'out', lineIds: releasedIds });
    // Журнал счёта: кто отменил и что стало с услугами. Раньше строку писал
    // только облачный экран, и «История» кассы об отменах молчала.
    const actor = db.prepare('SELECT full_name, role FROM users WHERE id = ?').get(user.id) || {};
    // RPC_PORT_V1 (ревью I1) — причина из окна отмены (окно визита требует её).
    const reason = (typeof args.reason === 'string' && args.reason.trim()) ? args.reason.trim().slice(0, 300) : null;
    const note = (removed.length ? 'Сняты с визита: ' + removed.join(', ') : '')
      + (removed.length && released.length ? '. ' : '')
      + (released.length ? 'Оставлены в визите невыставленными: ' + released.join(', ') : '');
    db.prepare(`
      INSERT INTO invoice_audit_log (invoice_id, invoice_number, visit_id, action, from_status, to_status, amount, refund_amount, actor_user_id, actor_name, actor_role, reason, notes)
      VALUES (?, ?, ?, 'void', ?, 'void', 0, 0, ?, ?, ?, ?, ?)`)
      .run(invoiceId, invoice.invoice_number || null, invoice.visit_id || null, invoice.status, user.id, actor.full_name || null, actor.role || null, reason, note || null);

    // ADM_LINE_RELEASE_V1 — inpatient lines must be released too. Voiding used
    // to touch visit_services only, so an admission's lines kept pointing at the
    // voided invoice: create_invoice_for_admission then refused them as "already
    // invoiced" and remove_admission_line_from_invoice refused them because the
    // invoice was no longer 'unpaid'. The treatment became permanently unbillable.
    const admLineIds = db.prepare(`SELECT id FROM admission_services
       WHERE invoice_item_id IN (SELECT id FROM invoice_items WHERE invoice_id = ?)`).all(invoiceId).map((r) => r.id);
    markRefundRelease(db, { invoiceId, kind: 'in', lineIds: admLineIds });   // PAY_REFUND_V1
    db.prepare(`
      UPDATE admission_services
         SET invoice_item_id = NULL, status = 'added'
       WHERE invoice_item_id IN (SELECT id FROM invoice_items WHERE invoice_id = ?)
    `).run(invoiceId);
    voidReleasedDoseLines(db, admLineIds, user);   // V3120_FINAL (S1)

    return { invoice: db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId), removed_services: removed, released_services: released };
  });

  return run();
}

// CASHIER_PAID_SWAP_V1 (2026-09-28) — «ВОЗВРАТЫ И ОТМЕНЫ» В КАССЕ.
//
// Владелец: «Refunded bills in the cashier window disappear completely, so we
// need to see them somewhere so we can change the service».
//
// Список «Приёма оплат» показывает отменённые счета только за сегодня, а
// частичный возврат (строкой, заменой, уступкой) по оплаченному счёту не
// показывает вовсе — счёт выглядит обычным оплаченным. Здесь — счета, по
// которым за период был хоть один возврат (отрицательный платёж) или которые
// отменены, с тем, что вернули: сумма, способ, когда, кто, причина; события
// журнала счёта (возврат строки, отмена, замена в оплаченном счёте); и
// невыставленные строки визита — их касса выставляет заново («Выставить
// заново»), при необходимости поменяв услугу или врача.
//
// Видят все, у кого касса (кассир, старший кассир, администратор): это касса
// клиники, и список счетов кассы общий. Депозиты (DEP-) и продажи карт (CARD-)
// возвращаются в своих вкладках — здесь их нет. Только чтение.
const REFUND_EVENTS = ['refund_line', 'void', 'line_swap_paid'];
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

function refundKind(notes) {
  const n = String(notes || '');
  if (/ SWAP#\d+/.test(n)) return 'swap';
  if (/ LINE#\d+/.test(n)) return 'line';
  return 'payment';
}
function refundReason(notes) {
  const n = String(notes || '');
  const i = n.indexOf(' — ');
  return i >= 0 ? n.slice(i + 3) : '';
}

export function cashierRefunds(db, args, user) {
  requireRole(user, SHIFT_ROLES);
  const d = localToday(db);
  const from = args && YMD_RE.test(String(args.from || '')) ? String(args.from) : d;
  const to = args && YMD_RE.test(String(args.to || '')) ? String(args.to) : from;
  if (to < from) throw new RpcError('Период указан неверно: «по» раньше «с».', 400);

  const pay = localRangeWhere('p.paid_at', from, to);
  const vd = localRangeWhere('i.voided_at', from, to);
  const cr = localRangeWhere('i.created_at', from, to);
  const ev = localRangeWhere('l.created_at', from, to);
  const holes = REFUND_EVENTS.map(() => '?').join(',');
  const ids = db.prepare(`
    SELECT p.invoice_id AS id FROM payments p WHERE p.amount < 0 AND ${pay.sql}
    UNION SELECT i.id FROM invoices i WHERE i.status IN ('void', 'refunded') AND ${vd.sql}
    UNION SELECT i.id FROM invoices i WHERE i.status IN ('void', 'refunded') AND i.voided_at IS NULL AND ${cr.sql}
    UNION SELECT l.invoice_id FROM invoice_audit_log l WHERE l.invoice_id IS NOT NULL AND l.action IN (${holes}) AND ${ev.sql}
  `).all(...pay.params, ...vd.params, ...cr.params, ...REFUND_EVENTS, ...ev.params).map((r) => r.id).filter((x) => x != null);
  if (!ids.length) return { from, to, rows: [], totals: { n: 0, refunded: 0 } };

  const inList = ids.map(() => '?').join(',');
  const invs = db.prepare(`
    SELECT i.id AS invoice_id, i.invoice_number, i.status, i.subtotal, i.discount_amount, i.total_amount, i.paid_amount,
           i.created_at, i.paid_at, i.voided_at, i.visit_id, i.admission_id, i.patient_id, i.payer_id, i.sync_origin,
           pt.full_name AS patient_name, pt.mrn AS mrn, pt.phone AS phone, pt.date_of_birth AS date_of_birth, pt.gender AS gender,
           v.sync_origin AS visit_origin
      FROM invoices i
      LEFT JOIN patients pt ON pt.id = i.patient_id
      LEFT JOIN visits v ON v.id = i.visit_id
     WHERE i.id IN (${inList})
       AND COALESCE(i.invoice_number, '') NOT LIKE 'DEP-%' AND COALESCE(i.invoice_number, '') NOT LIKE 'CARD-%'
  `).all(...ids);

  const refundsOf = db.prepare(`SELECT p.id, p.amount, p.method, p.paid_at, p.notes, u.full_name AS who
                                  FROM payments p LEFT JOIN users u ON u.id = p.cashier_id
                                 WHERE p.invoice_id = ? AND p.amount < 0 ORDER BY p.id`);
  const eventsOf = db.prepare(`SELECT action, created_at, actor_name, reason, notes, amount, refund_amount
                                 FROM invoice_audit_log WHERE invoice_id = ? AND action IN (${holes}) ORDER BY id`);
  const openLinesOf = db.prepare(`SELECT vs.id, vs.status, vs.quantity, vs.unit_price, vs.total, vs.service_id, vs.consultation_type_id,
                                         vs.clinic_item_id, vs.doctor_id, s.name AS service_name, pr.name AS product_name, u.full_name AS doctor_name
                                    FROM visit_services vs
                                    LEFT JOIN services s ON s.id = vs.service_id
                                    LEFT JOIN products pr ON pr.id = vs.clinic_item_id
                                    LEFT JOIN users u ON u.id = vs.doctor_id
                                   WHERE vs.visit_id = ? AND vs.invoice_item_id IS NULL
                                     AND COALESCE(vs.status, '') <> 'cancelled' AND vs.sync_origin IS NULL
                                   ORDER BY vs.id`);
  const rows = [];
  let refundedAll = 0;
  for (const r of invs) {
    const refunds = refundsOf.all(r.invoice_id).map((p) => ({
      payment_id: p.id, amount: round2(-p.amount), method: p.method, at: p.paid_at, who: p.who || null,
      kind: refundKind(p.notes), reason: refundReason(p.notes),
    }));
    const refundedTotal = round2(refunds.reduce((a, x) => a + x.amount, 0));
    refundedAll = round2(refundedAll + refundedTotal);
    const events = eventsOf.all(r.invoice_id, ...REFUND_EVENTS).map((e) => ({
      action: e.action, at: e.created_at, who: e.actor_name || null, reason: e.reason || '', notes: e.notes || '',
      amount: e.amount, refund_amount: e.refund_amount,
    }));
    const own = r.sync_origin == null && r.visit_origin == null;
    const open = r.visit_id && own ? openLinesOf.all(r.visit_id) : [];
    const refundedIds = new Set(refundedLineIds(db, 'out', open.map((l) => l.id)));
    const rebill = open.map((l) => ({
      id: l.id, status: l.status, name: l.service_name || l.product_name || null, doctor_name: l.doctor_name || null,
      price: round2((Number(l.unit_price) || 0) * (Number(l.quantity) || 1)), refunded: refundedIds.has(l.id),
      performed: PERFORMED_LINE_STATUSES.includes(l.status), product: l.clinic_item_id != null,
    }));
    const lastAt = [r.voided_at, ...refunds.map((x) => x.at), ...events.map((x) => x.at)].filter(Boolean).sort().pop() || r.created_at;
    rows.push({ ...r, refunds, refunded_total: refundedTotal, events, rebill_lines: rebill,
      can_rebill: !!(r.visit_id && own && !r.payer_id && rebill.length), last_at: lastAt });
  }
  rows.sort((a, b) => String(b.last_at || '').localeCompare(String(a.last_at || '')) || b.invoice_id - a.invoice_id);
  return { from, to, rows: rows.slice(0, 300), totals: { n: rows.length, refunded: refundedAll } };
}

// REFERRAL_BILL_V1 (2026-09-29) — «ЖДУТ СЧЁТА» В КАССЕ.
//
// Владелец: «While we are seeing the patient as a doctor and refer to another
// service or a doctor we cannot see them in the cashier's window. Which means
// flow is broken.» «Приём оплат» строится из одних счетов (cashier_invoices):
// визит со строками и без счёта кассе не виден вовсе, а обещание «счёт
// выставит касса» выполнить было нечем. Направление врача теперь выставляет
// счёт само (billing.js, DOCTOR_INVOICE_ROLES); это — страховка на всё, что
// всё-таки осталось без счёта: снятая галочка, отказ сервера, строки
// плательщика у врача, отмена счёта с «Оставить услуги», строка из кабинета.
//
// Визит (одна строка ответа на визит) попадает, если у него есть строки визита:
//   • без счёта (invoice_item_id IS NULL) и не отменённые;
//   • своего здания — и строка, и визит (у соседа своя касса);
//   • не отпущенные с возвратом — те в «Возвратах и отменах»
//     (pay_refund_releases, как у refundedLineIds);
// у живого визита (не 'cancelled', не 'no_show' — словарь миграции 003),
// местный день которого не старше UNBILLED_DAYS (будущие — да). Визит с
// нулевой суммой пропускается: бесплатным строкам платить нечего.
//
// Сумма — ДО скидок, по тому же правилу цены, что у счёта (lineUnitPrice:
// личная цена врача, каталог, тариф визита, сохранённая цена товара); скидки
// группы и пакета посчитает сам счёт. Только чтение (READ_ONLY_RPCS).
//
// План: визиты окна берутся по индексу дня (idx_visits_date), строки — по
// визиту (idx_visit_services_visit). CROSS JOIN держит этот порядок: иначе
// SQLite мог бы пойти от «строк без счёта» по всей истории клиники.
const UNBILLED_DAYS = 30;
const UNBILLED_LIMIT = 300;
const UNBILLED_NAMES = 5;

export function cashierUnbilled(db, args, user) {
  requireRole(user, SHIFT_ROLES);
  const d = localToday(db);
  const from = db.prepare('SELECT date(?, ?) AS d').get(d, `-${UNBILLED_DAYS} days`).d;
  const since = localRangeWhere('v.visit_date', from, null);
  const lines = db.prepare(`
    SELECT vs.id, vs.visit_id, vs.service_id, vs.clinic_item_id, vs.consultation_type_id, vs.doctor_id,
           vs.quantity, vs.unit_price, vs.price_tier, vs.created_at,
           ub.full_name AS added_by,
           v.visit_date, v.patient_id,
           pt.full_name AS patient_name, pt.mrn AS mrn, pt.phone AS phone,
           pt.date_of_birth AS date_of_birth, pt.gender AS gender
      FROM visits v
     CROSS JOIN visit_services vs ON vs.visit_id = v.id
      JOIN patients pt ON pt.id = v.patient_id
      LEFT JOIN users ub ON ub.id = vs.created_by
     WHERE ${since.sql}
       AND COALESCE(v.status, '') NOT IN ('cancelled', 'no_show')
       AND v.sync_origin IS NULL
       AND vs.invoice_item_id IS NULL
       AND COALESCE(vs.status, '') <> 'cancelled'
       AND vs.sync_origin IS NULL
       AND ${notRefundReleasedSql('vs', 'out')}
     ORDER BY vs.created_at DESC, vs.id DESC
  `).all(...since.params);

  const getService = db.prepare('SELECT price, name, price_secondary, secondary_days_from, secondary_days_to, price_repeat, repeat_days_from, repeat_days_to FROM services WHERE id = ?');
  const getProduct = db.prepare('SELECT sale_price, name FROM products WHERE id = ?');
  const services = new Map();
  const products = new Map();
  const once = (cache, id, stmt) => { if (!cache.has(id)) cache.set(id, stmt.get(id) || null); return cache.get(id); };

  // Строки идут от самой свежей: первая строка визита задаёт его место в
  // списке и «добавил» (автор самой свежей строки).
  const byVisit = new Map();
  for (const l of lines) {
    let svc = null, prod = null, name = null;
    if (l.service_id != null) { svc = once(services, l.service_id, getService); name = svc && svc.name; }
    else if (l.clinic_item_id != null) { prod = once(products, l.clinic_item_id, getProduct); name = prod && prod.name; }
    else if (l.consultation_type_id != null) { const c = consultationFor(db, l.consultation_type_id, l.doctor_id); name = c && c.name; }
    const qty = Number(l.quantity);
    const unit = Number(lineUnitPrice(db, l, { service: svc, product: prod })) || 0;
    const sum = Number.isFinite(qty) && qty > 0 ? round2(unit * qty) : 0;
    let g = byVisit.get(l.visit_id);
    if (!g) {
      g = {
        visit_id: l.visit_id, visit_date: l.visit_date, patient_id: l.patient_id,
        patient_name: l.patient_name, mrn: l.mrn, phone: l.phone, date_of_birth: l.date_of_birth, gender: l.gender,
        lines_count: 0, total: 0, names: [], added_by: l.added_by || null, last_line_at: l.created_at, line_ids: [],
      };
      byVisit.set(l.visit_id, g);
    }
    g.lines_count += 1;
    g.total = round2(g.total + sum);
    g.line_ids.push(l.id);
    if (name && !g.names.includes(name) && g.names.length < UNBILLED_NAMES) g.names.push(name);
  }
  const waiting = [...byVisit.values()].filter((g) => g.total > 0);
  const sum = round2(waiting.reduce((a, g) => a + g.total, 0));
  return { from, rows: waiting.slice(0, UNBILLED_LIMIT), totals: { n: waiting.length, sum } };
}
