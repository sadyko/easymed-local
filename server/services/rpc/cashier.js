// Server-side cash-shift RPCs (cash register / drawer reconciliation).
// All money math (expected drawer, over/short) is computed here from DB
// rows — client-supplied amounts are never trusted. Every handler runs its
// DB work inside db.transaction(...)() for atomicity.

import { isLocalToday } from '../domain/day.js';
import { outstandingWhere } from '../domain/money.js';
import { assertTransition } from '../domain/lifecycle.js';
import { hasAnyRole } from '../roles.js';
import { countsAsInflow } from '../../../public/js/shared/payment-methods.js';   // DEPOSIT_REVENUE_V1
// BRANCH_MONEY_GUARD_V1 — тот же запрет и та же формулировка, что в billing.js:
// чужие деньги отсюда только для чтения. Импорт, а не своя копия проверки:
// правило одно, и звучать оно обязано одинаково, с какого бы экрана в счёт ни
// пришли. Касса — последний экран, у которого счёт открыт целиком, и первый, с
// которого его можно стереть.
import { assertOwnBuilding } from './billing.js';

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

function requireRole(user, allowed) {
  // MULTI_ROLE_SERVER_V1 — extras count too, not the primary role alone.
  if (!hasAnyRole(user, allowed)) {
    throw new RpcError('Your role is not allowed to perform this action.', 403);
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

// SHIFT_AUTOCLOSE_V1 — смена живёт один календарный день (00:00–00:00).
// Любая смена, открытая до сегодняшней локальной даты, закрывается автоматически:
// counted = expected (пересчёта не было, недостача не фиксируется), closed_at =
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
      db.prepare(`
        UPDATE cash_shifts
        SET status = 'closed',
            closed_at = strftime('%Y-%m-%dT%H:%M:%SZ', datetime(date(opened_at, 'localtime'), '+1 day', 'utc')),
            counted_amount = ?,
            expected_amount = ?,
            over_short = 0,
            notes = CASE WHEN notes IS NULL OR notes = '' THEN ? ELSE notes || ' · ' || ? END
        WHERE id = ? AND status = 'open'
      `).run(expected, expected, 'Закрыта автоматически (конец дня 00:00)', 'Закрыта автоматически (конец дня 00:00)', shift.id);
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
    const info = db.prepare(`
      INSERT INTO cash_shifts (cashier_id, opening_float, status, notes)
      VALUES (?, 0, 'open', 'Открыта автоматически (начало дня)')
    `).run(user.id);
    shift = db.prepare('SELECT * FROM cash_shifts WHERE id = ?').get(info.lastInsertRowid);
  }
  return shift;
}

export function openCashShift(db, args, user) {
  requireRole(user, SHIFT_ROLES);

  const rawFloat = args && args.opening_float !== undefined ? args.opening_float : 0;
  if (!isValidMoney(rawFloat)) {
    throw new RpcError('opening_float must be a finite number between 0 and 1e12.', 400);
  }
  const openingFloat = round2(rawFloat);

  const rawBranch = args && args.branch_id;
  const branchId = isPositiveInt(rawBranch) ? rawBranch : null;

  autoCloseStaleShifts(db);   // SHIFT_AUTOCLOSE_V1 — вчерашняя смена не блокирует новую
  const run = db.transaction(() => {
    const existing = db.prepare("SELECT id FROM cash_shifts WHERE cashier_id=? AND status='open'").get(user.id);
    if (existing) {
      throw new RpcError('You already have an open shift.', 400);
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
    throw new RpcError('shift_id must be a positive integer.', 400);
  }

  const rawCounted = args && args.counted_amount;
  if (!isValidMoney(rawCounted)) {
    throw new RpcError('counted_amount must be a finite number between 0 and 1e12.', 400);
  }
  const countedAmount = round2(rawCounted);

  const rawNotes = args && args.notes !== undefined ? args.notes : '';
  const notes = (typeof rawNotes === 'string' ? rawNotes : String(rawNotes)).slice(0, 500);

  const run = db.transaction(() => {
    const shift = db.prepare('SELECT * FROM cash_shifts WHERE id = ?').get(shiftId);
    if (!shift) {
      throw new RpcError('shift not found.', 400);
    }
    if (shift.status !== 'open') {
      throw new RpcError('shift is already closed.', 400);
    }
    if (user.role !== 'admin' && shift.cashier_id !== user.id) {
      throw new RpcError('You may only close your own shift.', 403);
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
          notes = ?
      WHERE id = ?
    `).run(countedAmount, expected, overShort, notes, shiftId);

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
function paymentTotals(db, shiftId) {
  const rows = db.prepare('SELECT method, COALESCE(SUM(amount),0) s, COUNT(*) n FROM payments WHERE shift_id=? GROUP BY method').all(shiftId);
  const totals = { cash: 0, card: 0, transfer: 0, acquiring: 0, wallet: 0, total: 0, count: 0 };
  for (const row of rows) {
    if (Object.prototype.hasOwnProperty.call(totals, row.method)) {
      totals[row.method] = round2(row.s);
    }
    if (countsAsInflow(row.method)) {
      totals.total = round2(totals.total + row.s);
      totals.count += row.n;
    }
  }
  return totals;
}

export function cashShiftSummary(db, args, user) {
  requireRole(user, SHIFT_ROLES);
  ensureOpenShift(db, user);   // SHIFT_AUTO_V2 — день открывается сам, «Смена не открыта» не существует

  const shift = db.prepare("SELECT * FROM cash_shifts WHERE cashier_id=? AND status='open' ORDER BY id DESC LIMIT 1").get(user.id);
  if (!shift) {
    return { shift: null, totals: null, expected_drawer: null };
  }

  const totals = paymentTotals(db, shift.id);
  const moves = movementTotals(db, shift.id);
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

  const kind = args && args.kind;
  if (kind !== 'in' && kind !== 'out') {
    throw new RpcError("kind must be 'in' or 'out'.", 400);
  }
  const rawAmount = args && args.amount;
  if (!isValidMoney(rawAmount) || rawAmount <= 0) {
    throw new RpcError('amount must be a positive finite number (capped at 1e12).', 400);
  }
  const amount = round2(rawAmount);
  const article = String((args && args.article) || '').slice(0, 200);
  const note = String((args && args.note) || '').slice(0, 500);

  const run = db.transaction(() => {
    const shift = db.prepare("SELECT * FROM cash_shifts WHERE cashier_id=? AND status='open' ORDER BY id DESC LIMIT 1").get(user.id);
    if (!shift) {
      throw new RpcError('Нет открытой смены — откройте смену, чтобы двигать наличные.', 400);
    }
    if (kind === 'out') {
      const cashSum = db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE shift_id=? AND method='cash'").get(shift.id).s;
      const moves = movementTotals(db, shift.id);
      const drawer = round2(shift.opening_float + cashSum + moves.cash_in - moves.cash_out);
      if (amount > drawer) {
        throw new RpcError(`В кассе только ${drawer} — изъять ${amount} нельзя.`, 400);
      }
    }
    const info = db.prepare(`
      INSERT INTO cash_movements (shift_id, kind, amount, article, note, created_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(shift.id, kind, amount, article, note, user.id);
    return { movement: db.prepare('SELECT * FROM cash_movements WHERE id = ?').get(info.lastInsertRowid) };
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
      throw new RpcError('shift_id must be a positive integer.', 400);
    }
    shift = db.prepare('SELECT * FROM cash_shifts WHERE id = ?').get(shiftId);
    if (!shift) {
      throw new RpcError('shift not found.', 400);
    }
    if (user.role !== 'admin' && shift.cashier_id !== user.id) {
      throw new RpcError('You may only view your own shift.', 403);
    }
  } else {
    shift = db.prepare("SELECT * FROM cash_shifts WHERE cashier_id=? AND status='open' ORDER BY id DESC LIMIT 1").get(user.id);
    if (!shift) {
      throw new RpcError('Нет открытой смены.', 400);
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

// CASHIER_DESIGN_V2 — the «Приём оплат» invoice list, joined server-side:
// patient (name/MRN/phone), doctor (via the visit), first service + item
// count, distinct payment methods, plus per-status aggregates for the chips.
export function cashierInvoices(db, args, user) {
  requireRole(user, SHIFT_ROLES);

  const rows = db.prepare(`
    SELECT i.id, i.invoice_number, i.status, i.subtotal, i.discount_amount,
           i.total_amount, i.paid_amount, i.created_at, i.paid_at,
           pt.full_name AS patient_name, pt.mrn AS mrn, pt.phone AS phone,
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
      FROM invoices i
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
       AND (${outstandingWhere('i.status')}                                            -- DAY_ZERO_V1: неоплаченные висят, пока не оплачены
        OR (i.status = 'paid' AND ${isLocalToday('COALESCE(i.paid_at, i.created_at)')})
        OR (i.status IN ('void', 'refunded') AND ${isLocalToday('i.created_at')}))
     ORDER BY i.created_at DESC, i.id DESC
     LIMIT 500
  `).all();

  const counts = { unpaid: { n: 0, sum: 0 }, debt: { n: 0, sum: 0 }, partial: { n: 0, sum: 0 },
                   paid: { n: 0, sum: 0 }, cancelled: { n: 0, sum: 0 }, all: { n: 0, sum: 0 } };
  // DAY_ZERO_V1 — счётчики чипов по тем же правилам: оплаченные/отменённые
  // считаются только за сегодня, неоплаченные — накопительно.
  for (const r of db.prepare(`
    SELECT status, COUNT(*) n, COALESCE(SUM(total_amount),0) s FROM invoices
    WHERE payer_id IS NULL                                                             -- COVERAGE_SPLIT_V1: чипы считают только кассовые счета
      AND (${outstandingWhere()}
       OR (status = 'paid' AND ${isLocalToday('COALESCE(paid_at, created_at)')})
       OR (status IN ('void', 'refunded') AND ${isLocalToday('created_at')}))
    GROUP BY status
  `).all()) {
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
    throw new RpcError('invoice_id must be a positive integer.', 400);
  }

  const run = db.transaction(() => {
    const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
    if (!invoice) throw new RpcError('invoice not found.', 400);
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
    // Журнал правок этого счёта уходит вместе с ним: строки со ссылкой на
    // несуществующий документ FK не переживёт, а с обнулённой ссылкой они
    // ничего не значат.
    db.prepare('DELETE FROM invoice_audit_log WHERE invoice_id = ?').run(invoiceId);

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
    throw new RpcError('invoice_id must be a positive integer.', 400);
  }

  const run = db.transaction(() => {
    const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
    if (!invoice) {
      throw new RpcError('invoice not found.', 400);
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

    assertTransition('invoice', invoice.status, 'void');
    db.prepare("UPDATE invoices SET status = 'void' WHERE id = ?").run(invoiceId);
    // Free the visit lines for re-billing (started/finished work keeps its link).
    db.prepare(`
      UPDATE visit_services
         SET invoice_item_id = NULL, status = 'added'
       WHERE invoice_item_id IN (SELECT id FROM invoice_items WHERE invoice_id = ?)
         AND status NOT IN ('in_progress', 'completed')
    `).run(invoiceId);

    // ADM_LINE_RELEASE_V1 — inpatient lines must be released too. Voiding used
    // to touch visit_services only, so an admission's lines kept pointing at the
    // voided invoice: create_invoice_for_admission then refused them as "already
    // invoiced" and remove_admission_line_from_invoice refused them because the
    // invoice was no longer 'unpaid'. The treatment became permanently unbillable.
    db.prepare(`
      UPDATE admission_services
         SET invoice_item_id = NULL, status = 'added'
       WHERE invoice_item_id IN (SELECT id FROM invoice_items WHERE invoice_id = ?)
    `).run(invoiceId);

    return { invoice: db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId) };
  });

  return run();
}
