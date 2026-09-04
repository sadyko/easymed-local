// DEPOSIT_V1 — предоплата пациента: регистратура заводит, касса принимает.
//
// Депозит НЕ выручка. Пациент вносит деньги вперёд, услуга ещё не оказана и
// счёт не выставлен — до момента, когда баланс уйдёт в оплату счёта, это чужие
// деньги на хранении. Поэтому здесь не создаётся ни invoices, ни payments:
// иначе дневная выручка выросла бы дважды — сначала при взносе, потом при
// списании баланса в счёт.
//
// Но в ящике деньги ЛЕЖАТ, и на закрытии смены их надо объяснить. Поэтому приём
// наличного депозита пишет строку cash_movements (kind='in'): формула ящика
// (opening_float + наличные оплаты + in − out) сходится, и X-отчёт показывает
// ровно то, что кассир пересчитает руками. Карта и перевод в ящик не попадают —
// наличных по ним не прибавилось.
//
// Статусы (колонки уже были в миграции 024):
//   pending  — регистратура завела, кассир денег ещё не взял
//   received — деньги приняты; с этого момента баланс можно тратить
//   spent / refunded — списание в счёт и возврат (существующие потоки)

import { hasAnyRole } from '../roles.js';
import { ensureOpenShift } from './cashier.js';
// BRANCH_MONEY_NUMBER_V1 — буква здания для номера депозита. Импорт из
// billing.js, а не своя копия: номер депозита СТАНОВИТСЯ номером счёта (см.
// acceptDeposit ниже), то есть попадает в тот же UNIQUE-индекс, и правило
// уникальности у них обязано быть буквально одно.
import { branchLetter, assertOwnBuilding } from './billing.js';

export class RpcError extends Error {
  constructor(msg, status = 400) {
    super(msg);
    this.status = status;
  }
}

const CREATE_ROLES = ['admin', 'registrar'];
const ACCEPT_ROLES = ['admin', 'cashier'];
// Тот же словарь, что у оплат (billing.js) — способ на депозите читается теми
// же экранами, что и способ на платеже.
// DEPOSIT_METHOD_BY_CASHIER_V1 — ровно три способа, те, что берёт касса у
// окошка. «Перевод» убран: депозит вносят на месте, а лишняя строка в списке
// кассира — это выбор, который потом придётся объяснять в сверке смены.
const METHODS = ['cash', 'card', 'acquiring'];
const MAX_MONEY = 1e12;

function requireRole(user, allowed) {
  if (!hasAnyRole(user, allowed)) {
    throw new RpcError('Your role is not allowed to perform this action.', 403);
  }
}
const round2 = (n) => Math.round(n * 100) / 100;
const isPositiveInt = (v) => Number.isInteger(v) && v > 0;

// DEP-<буква здания>-<ГГ>-<00001>. Зеркалит nextInvoiceNumber (billing.js) —
// см. миграции 069 и 088.
//
// БУКВА ЗДЕСЬ ОБЯЗАТЕЛЬНА РОВНО ПОТОМУ, что приём депозита создаёт настоящий
// счёт и кладёт номер депозита в invoices.invoice_number (DEPOSIT_REVENUE_V1,
// ниже). Значит номер депозита живёт в том же уникальном индексе, что и номера
// счетов, и ездит между зданиями вместе с ними: два здания без буквы выдали бы
// одинаковый 'DEP-26-00001', и депозит соседа был бы отвергнут при приёме.
// Старые номера не переписываются — буква только у новых.
export function nextDepositNumber(db) {
  const year4 = db.prepare("SELECT strftime('%Y','now') AS y").get().y;
  const yy = year4.slice(-2);
  const letter = branchLetter(db);
  db.prepare('INSERT INTO deposit_counters (year, next_seq) VALUES (?, 1) ON CONFLICT(year) DO NOTHING').run(year4);
  const seq = db.prepare('SELECT next_seq FROM deposit_counters WHERE year = ?').get(year4).next_seq;
  db.prepare('UPDATE deposit_counters SET next_seq = next_seq + 1 WHERE year = ?').run(year4);
  return `DEP-${letter}-${yy}-${String(seq).padStart(5, '0')}`;
}

export function createDeposit(db, args, user) {
  requireRole(user, CREATE_ROLES);
  const a = args || {};

  if (!isPositiveInt(a.patient_id)) throw new RpcError('patient_id must be a positive integer.', 400);
  const amount = a.amount;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0 || amount > MAX_MONEY) {
    throw new RpcError('amount must be a positive number.', 400);
  }
  // DEPOSIT_METHOD_BY_CASHIER_V1 — способ здесь НЕ выбирается и НЕ принимается,
  // даже если его прислали: регистратура денег не берёт, а чем пациент заплатит,
  // выяснится только у окошка — он передумывает по дороге. До приёма способа
  // нет (NULL), иначе список кассы обещал бы наличные, которых никто не обещал.
  const method = null;

  const run = db.transaction(() => {
    const patient = db.prepare('SELECT id, branch_id FROM patients WHERE id = ?').get(a.patient_id);
    if (!patient) throw new RpcError('patient not found.', 400);

    const number = nextDepositNumber(db);
    const info = db.prepare(`
      INSERT INTO patient_deposits
        (deposit_number, patient_id, branch_id, amount, method, status, notes, created_by, created_by_name)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
    `).run(number, patient.id, patient.branch_id || null, round2(amount), method,
           String(a.notes || '').slice(0, 500), user.id, String(user.full_name || user.username || ''));

    return { deposit: db.prepare('SELECT * FROM patient_deposits WHERE id = ?').get(info.lastInsertRowid) };
  });

  return run();
}

export function acceptDeposit(db, args, user) {
  requireRole(user, ACCEPT_ROLES);
  const a = args || {};
  if (!isPositiveInt(a.deposit_id)) throw new RpcError('deposit_id must be a positive integer.', 400);

  const run = db.transaction(() => {
    const dep = db.prepare('SELECT * FROM patient_deposits WHERE id = ?').get(a.deposit_id);
    if (!dep) throw new RpcError('deposit not found.', 400);
    if (dep.status !== 'pending') {
      throw new RpcError(`deposit is already ${dep.status}.`, 400);
    }
    // DEPOSIT_METHOD_BY_CASHIER_V1 — способ называет ТОТ, КТО ВЗЯЛ ДЕНЬГИ.
    // Молчаливой подстановки 'cash' здесь больше нет: она означала, что «Принять»
    // одним щелчком записывало наличные, и ящик расходился с тем, что кассир
    // действительно взял. Ошибиться дороже, чем спросить.
    const method = a.method;
    if (method === undefined || method === null || method === '') {
      throw new RpcError('Укажите способ оплаты: наличные, карта или эквайринг.', 400);
    }
    if (!METHODS.includes(method)) throw new RpcError(`unknown method: ${method}`, 400);

    db.prepare(`
      UPDATE patient_deposits
      SET status = 'received', method = ?, received_by = ?, received_by_name = ?,
          received_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
      WHERE id = ?
    `).run(method, user.id, String(user.full_name || user.username || ''), dep.id);

    // DEPOSIT_REVENUE_V1 — деньги взяли, значит это ВЫРУЧКА, и у неё должен быть
    // документ. Приём создаёт настоящий счёт и настоящий платёж — те же таблицы,
    // что у оплаты услуг. Поэтому депозит виден в «Приёме оплат», попадает в
    // смену, в X-отчёт и в выручку без единой особой ветки в отчётах.
    //
    // Строку в cash_movements здесь больше НЕ пишем: ящик считается как
    // opening_float + наличные ПЛАТЕЖИ + внесения − изъятия, и платёж уже учтён.
    // Оставь мы обе записи — одни и те же деньги легли бы в ящик дважды.
    //
    // Номер счёта — номер депозита (DEP-…): один документ, один номер, и в
    // списке счетов сразу видно, что это предоплата, а не оплата услуг.
    ensureOpenShift(db, user);
    const shift = db.prepare("SELECT * FROM cash_shifts WHERE cashier_id=? AND status='open' ORDER BY id DESC LIMIT 1").get(user.id);
    if (!shift) throw new RpcError('Нет открытой смены — откройте смену, чтобы принять депозит.', 400);

    const amount = round2(dep.amount);
    const now = db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now') n").get().n;
    const invInfo = db.prepare(`
      INSERT INTO invoices
        (invoice_number, visit_id, patient_id, branch_id, subtotal, discount_amount,
         total_amount, paid_amount, status, created_by, paid_at)
      VALUES (?, NULL, ?, ?, ?, 0, ?, ?, 'paid', ?, ?)`)
      .run(dep.deposit_number, dep.patient_id, dep.branch_id || null, amount, amount, amount, user.id, now);
    const invoiceId = invInfo.lastInsertRowid;

    db.prepare(`
      INSERT INTO invoice_items (invoice_id, service_id, description, quantity, unit_price, total)
      VALUES (?, NULL, ?, 1, ?, ?)`)
      .run(invoiceId, 'Депозит (предоплата) ' + (dep.deposit_number || ''), amount, amount);

    db.prepare(`
      INSERT INTO payments (invoice_id, amount, method, cashier_id, shift_id, notes)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(invoiceId, amount, method, user.id, shift.id, 'Депозит ' + (dep.deposit_number || ''));

    db.prepare('UPDATE patient_deposits SET invoice_id = ? WHERE id = ?').run(invoiceId, dep.id);

    return {
      deposit: db.prepare('SELECT * FROM patient_deposits WHERE id = ?').get(dep.id),
      invoice: db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId),
    };
  });

  return run();
}

// Ошибка регистратуры не должна оставаться в списке кассы навсегда. Отменить
// можно только НЕ принятый депозит: за принятым уже стоят деньги в ящике, и его
// путь назад — возврат (refund), а не отмена.
export function cancelDeposit(db, args, user) {
  requireRole(user, ACCEPT_ROLES.concat(CREATE_ROLES));
  const a = args || {};
  if (!isPositiveInt(a.deposit_id)) throw new RpcError('deposit_id must be a positive integer.', 400);

  const run = db.transaction(() => {
    const dep = db.prepare('SELECT * FROM patient_deposits WHERE id = ?').get(a.deposit_id);
    if (!dep) throw new RpcError('deposit not found.', 400);
    if (dep.status !== 'pending') throw new RpcError(`deposit is ${dep.status} — cancel is only for pending.`, 400);
    db.prepare("UPDATE patient_deposits SET status = 'cancelled', closed_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?").run(dep.id);
    return { deposit: db.prepare('SELECT * FROM patient_deposits WHERE id = ?').get(dep.id) };
  });

  return run();
}

// DEPOSIT_REFUND_V1 — вернуть депозит пациенту.
//
// Депозит — чужие деньги на хранении, и забрать их пациент вправе в любой
// момент. Возврат зеркалит приём:
//   • только КАССА и только принятый (received) депозит;
//   • наличный возврат ВЫХОДИТ из ящика строкой cash_movements (kind='out') —
//     без неё смена не сойдётся при пересчёте, а деньги из ящика уже ушли;
//   • безналичный ящик не трогает: наличных в нём не убавилось.
//
// Главная защита — потолок по БАЛАНСУ, а не по сумме депозита. Часть предоплаты
// могла уже уйти в оплату услуг (строки 'spent'), и эти деньги клиника пациенту
// не должна: вернуть их значило бы отдать выручку за оказанную помощь.
export function refundDeposit(db, args, user) {
  requireRole(user, ACCEPT_ROLES);
  const a = args || {};
  if (!isPositiveInt(a.deposit_id)) throw new RpcError('deposit_id must be a positive integer.', 400);

  const run = db.transaction(() => {
    const dep = db.prepare('SELECT * FROM patient_deposits WHERE id = ?').get(a.deposit_id);
    if (!dep) throw new RpcError('deposit not found.', 400);
    if (dep.status === 'refunded') throw new RpcError('Депозит уже возвращён.', 400);
    if (dep.status !== 'received') {
      throw new RpcError('Вернуть можно только принятый депозит — этот в статусе «' + dep.status + '».', 400);
    }

    // Сумма: по умолчанию весь депозит. Явную сумму проверяем как деньги.
    const raw = (a.amount === undefined || a.amount === null) ? Number(dep.amount) : a.amount;
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
      throw new RpcError('amount must be a positive number.', 400);
    }
    const amount = round2(raw);
    if (amount > round2(dep.amount)) {
      throw new RpcError('Возврат больше самого депозита.', 400);
    }

    // Остаток по пациенту: принято − потрачено − уже возвращённое.
    const rows = db.prepare('SELECT amount, refund_amount, status FROM patient_deposits WHERE patient_id = ?').all(dep.patient_id);
    let balance = 0;
    for (const d of rows) {
      if (d.status === 'received') balance += Number(d.amount || 0);
      else if (d.status === 'refunded') balance += Number(d.amount || 0) - Number(d.refund_amount || 0);
      else if (d.status === 'spent') balance -= Number(d.amount || 0);
    }
    balance = round2(Math.max(0, balance));
    if (amount > balance) {
      throw new RpcError('На балансе пациента только ' + balance
        + ' — остальное уже ушло в оплату услуг. Вернуть больше остатка нельзя.', 400);
    }

    db.prepare(`
      UPDATE patient_deposits
         SET status = 'refunded', refund_amount = ?,
             closed_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
       WHERE id = ?`).run(amount, dep.id);

    // DEPOSIT_REVENUE_V1 — возврат зеркалит приём: раз приём был платежом, то и
    // возврат — платёж, только отрицательный. Так он сам вычитается из выручки,
    // из итога смены и из ящика (для наличных), без отдельной строки «изъято».
    // Отдают тем же способом, каким принимали.
    ensureOpenShift(db, user);
    const shift = db.prepare("SELECT * FROM cash_shifts WHERE cashier_id=? AND status='open' ORDER BY id DESC LIMIT 1").get(user.id);
    if (!shift) throw new RpcError('Нет открытой смены — откройте смену, чтобы оформить возврат.', 400);

    if (dep.invoice_id) {
      db.prepare(`
        INSERT INTO payments (invoice_id, amount, method, cashier_id, shift_id, notes)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(dep.invoice_id, -amount, (dep.method || 'cash'), user.id, shift.id,
             'Возврат депозита ' + (dep.deposit_number || ''));

      // Счёт депозита закрыт возвратом — полным или частичным.
      const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(dep.invoice_id);
      // BRANCH_MONEY_GUARD_V1 — сам депозит между зданиями не ездит, поэтому
      // его счёт здешний почти по определению; проверка стоит на случай, когда
      // «почти» перестанет быть правдой, и стоит она ровно там, где пишутся
      // деньги.
      if (inv) assertOwnBuilding(db, inv, 'Счёт депозита');
      if (inv) {
        const paid = round2(Number(inv.paid_amount || 0) - amount);
        db.prepare('UPDATE invoices SET paid_amount = ?, status = ? WHERE id = ?')
          .run(paid, paid <= 0 ? 'refunded' : 'partial', inv.id);
      }
    } else if ((dep.method || 'cash') === 'cash') {
      // DEPOSIT_REVENUE_V1 — депозит, принятый ДО перехода на счета: у него нет
      // invoice_id, а деньги вошли в ящик строкой cash_movements. Возвращаем
      // тем же способом, каким принимали, иначе деньги ушли бы из кассы, а
      // остаток ящика остался бы прежним — и смена не сошлась бы на пересчёте.
      db.prepare(`
        INSERT INTO cash_movements (shift_id, kind, amount, article, note, created_by)
        VALUES (?, 'out', ?, ?, ?, ?)`)
        .run(shift.id, amount, 'Возврат депозита ' + (dep.deposit_number || ('#' + dep.id)),
             'Возврат предоплаты (депозит принят до перехода на счета)', user.id);
    }

    return { deposit: db.prepare('SELECT * FROM patient_deposits WHERE id = ?').get(dep.id) };
  });

  return run();
}

// Список для кассы: кто ждёт приёма. По умолчанию — только pending.
export function listDeposits(db, args, user) {
  requireRole(user, ACCEPT_ROLES.concat(CREATE_ROLES));
  const a = args || {};
  const status = a.status === undefined || a.status === null ? 'pending' : String(a.status);
  const rows = status === 'all'
    ? db.prepare(`SELECT d.*, p.full_name AS patient_name, p.mrn AS patient_mrn
                    FROM patient_deposits d LEFT JOIN patients p ON p.id = d.patient_id
                   ORDER BY d.id DESC LIMIT 300`).all()
    : db.prepare(`SELECT d.*, p.full_name AS patient_name, p.mrn AS patient_mrn
                    FROM patient_deposits d LEFT JOIN patients p ON p.id = d.patient_id
                   WHERE d.status = ? ORDER BY d.id DESC LIMIT 300`).all(status);
  return { rows };
}

// Баланс пациента: принято − потрачено − возвращено. Ровно та же арифметика,
// что читает мастер визита, но посчитанная на сервере — карточка пациента и
// смета не должны расходиться в цифре.
export function depositBalance(db, args, user) {
  requireRole(user, ACCEPT_ROLES.concat(CREATE_ROLES));
  const a = args || {};
  if (!isPositiveInt(a.patient_id)) throw new RpcError('patient_id must be a positive integer.', 400);
  const rows = db.prepare('SELECT amount, refund_amount, status FROM patient_deposits WHERE patient_id = ?').all(a.patient_id);
  let balance = 0;
  for (const d of rows) {
    if (d.status === 'received') balance += Number(d.amount || 0);
    else if (d.status === 'refunded') balance += Number(d.amount || 0) - Number(d.refund_amount || 0);
    else if (d.status === 'spent') balance -= Number(d.amount || 0);
  }
  return { balance: round2(Math.max(0, balance)), rows };
}
