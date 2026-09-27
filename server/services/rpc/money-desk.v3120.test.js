// V3120_FIX — деньги амбулатории и касса по инспекции 3.12.0 (27.09).
// Каждый тест идёт через настоящие RPC и настоящую SQLite после миграций.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import {
  createInvoiceForVisit, recordPayment, recordPaymentSplit, removeUnpaidService, changeUnpaidService,
  refundPayment,
} from './billing.js';
import {
  voidInvoice, cashierInvoices, autoCloseStaleShifts, ensureOpenShift, closeCashShift, shiftReport,
  cashShiftSummary, cashMove,
} from './cashier.js';
import { createDeposit, acceptDeposit, refundDeposit, listDeposits, depositBalance } from './deposits.js';
import { sellCard } from './card-sales.js';
import { saveLabResults } from './lab.js';
import { patientBaseAggregates } from './patient-aggregates.js';
import { walletBalance } from '../domain/wallet.js';
import { doctorPriceFor } from '../domain/pricing.js';
import { utcRange } from '../domain/day.js';

const registrar = { id: 7, role: 'registrar', full_name: 'Регистратор' };
const cashier = { id: 9, role: 'cashier', full_name: 'Кассир' };
const admin = { id: 1, role: 'admin', full_name: 'Админ' };
const lab = { id: 11, role: 'lab', full_name: 'Лаборант' };
const DOC = 20;

function seed() {
  const db = openDb(':memory:'); migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, role, full_name, is_doctor) VALUES (?,?,?,?,?,?)');
  u.run(1, 'adm', 'x', 'admin', 'Админ', 0);
  u.run(7, 'reg', 'x', 'registrar', 'Регистратор', 0);
  u.run(9, 'cash', 'x', 'cashier', 'Кассир', 0);
  u.run(10, 'cash2', 'x', 'cashier', 'Кассир 2', 0);
  u.run(11, 'lab', 'x', 'lab', 'Лаборант', 0);
  u.run(12, 'boss', 'x', 'registrar', 'Регистратор-админ', 0);
  u.run(DOC, 'doc', 'x', 'doctor', 'Врач', 1);
  return db;
}
const svc = (db, name, price, extra = {}) => {
  const cols = ['name', 'price', ...Object.keys(extra)];
  return Number(db.prepare(`INSERT INTO services (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(name, price, ...Object.values(extra)).lastInsertRowid);
};
function visitWith(db, sids, { category = null } = {}) {
  const pid = Number(db.prepare('INSERT INTO patients (full_name, category_id) VALUES (?, ?)').run('Пациент ' + Math.random(), category).lastInsertRowid);
  const vid = Number(db.prepare("INSERT INTO visits (patient_id, visit_date) VALUES (?, '2026-09-27T05:00:00Z')").run(pid).lastInsertRowid);
  const ids = sids.map((s) => Number(db.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status) VALUES (?, ?, 1, 0, 0, 'added')").run(vid, s).lastInsertRowid));
  return { pid, vid, ids };
}
const inv = (db, id) => db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
const money = (i) => [i.subtotal, i.discount_amount, i.total_amount];

// ─── FATAL-1 ────────────────────────────────────────────────────────────────
test('FATAL-1: убрать и заменить строку неоплаченного счёта VIP — скидка группы пересчитывается от новой базы', () => {
  const db = seed();
  const vip = Number(db.prepare("INSERT INTO patient_categories (name, discount_percent, active) VALUES ('VIP', 15, 1)").run().lastInsertRowid);
  const CONS = svc(db, 'Приём', 140000), BIO = svc(db, 'Биохимия', 80000), ECG = svc(db, 'ЭКГ', 35000), CBC = svc(db, 'ОАК', 45000);
  const { vid, ids } = visitWith(db, [CONS, BIO, ECG], { category: vip });
  const out = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: ids }, registrar);
  assert.deepEqual(money(out.invoice), [255000, 38250, 216750]);
  removeUnpaidService(db, { visit_service_id: ids[2] }, registrar);
  assert.deepEqual(money(inv(db, out.invoice.id)), [220000, 33000, 187000]);
  changeUnpaidService(db, { visit_service_id: ids[1], new_service_id: CBC }, registrar);
  assert.deepEqual(money(inv(db, out.invoice.id)), [185000, 27750, 157250]);
});

test('FATAL-1: ручная скидка без группы при удалении строки уменьшается пропорционально, а не ложится на остаток', () => {
  const db = seed();
  const A = svc(db, 'А', 100000), B = svc(db, 'Б', 100000);
  const { vid, ids } = visitWith(db, [A, B]);
  const out = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: ids, discount_amount: 20000 }, registrar);
  removeUnpaidService(db, { visit_service_id: ids[1] }, registrar);
  assert.deepEqual(money(inv(db, out.invoice.id)), [100000, 10000, 90000]);
});

// ─── FATAL-2 ────────────────────────────────────────────────────────────────
test('FATAL-2: строки счёта страховой уходят в очередь — лаборатория вносит результат', () => {
  const db = seed();
  const payer = Number(db.prepare("INSERT INTO payers (name, kind, active) VALUES ('Страховая', 'insurance', 1)").run().lastInsertRowid);
  const CBC = svc(db, 'ОАК', 45000, { type: 'lab', is_lab: 1 });
  const { vid, ids } = visitWith(db, [CBC]);
  const out = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: ids, payer_id: payer }, registrar);
  assert.equal(out.invoice.status, 'unpaid', 'счёт плательщику остаётся долгом страховой');
  assert.equal(db.prepare('SELECT status FROM visit_services WHERE id = ?').get(ids[0]).status, 'queued');
  saveLabResults(db, { visit_service_id: ids[0], rows: [{ parameter: 'HGB', numeric_value: 140 }] }, lab);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM lab_results WHERE visit_service_id = ?').get(ids[0]).n, 1);
});

// ─── MAJOR: частичный возврат оплаченного счёта ─────────────────────────────
test('MAJOR: частичный возврат по оплаченному счёту — скидка после продажи, счёт остаётся оплаченным', () => {
  const db = seed();
  const CONS = svc(db, 'Приём', 140000);
  const { vid, ids } = visitWith(db, [CONS]);
  const out = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: ids }, registrar);
  recordPayment(db, { invoice_id: out.invoice.id, amount: 140000, method: 'cash' }, cashier);
  const pid = db.prepare('SELECT id FROM payments WHERE invoice_id = ?').get(out.invoice.id).id;
  const r = refundPayment(db, { payment_id: pid, amount: 40000, to_balance: false }, cashier);
  const i = inv(db, out.invoice.id);
  assert.equal(i.status, 'paid');
  assert.equal(i.total_amount, 100000);
  assert.equal(i.paid_amount, 100000);
  assert.equal(i.discount_amount, 40000);
  assert.ok(i.paid_at, 'дата оплаты не стирается');
  assert.equal(r.post_sale_discount, 40000);
});

test('MAJOR: частичный возврат с reopen_balance — явный выбор «оплатят снова»: счёт снова ждёт денег', () => {
  const db = seed();
  const CONS = svc(db, 'Приём', 140000);
  const { vid, ids } = visitWith(db, [CONS]);
  const out = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: ids }, registrar);
  recordPayment(db, { invoice_id: out.invoice.id, amount: 140000, method: 'cash' }, cashier);
  const pid = db.prepare('SELECT id FROM payments WHERE invoice_id = ?').get(out.invoice.id).id;
  refundPayment(db, { payment_id: pid, amount: 40000, to_balance: false, reopen_balance: true }, cashier);
  const i = inv(db, out.invoice.id);
  assert.equal(i.status, 'partial');
  assert.equal(i.total_amount, 140000);
  recordPayment(db, { invoice_id: out.invoice.id, amount: 40000, method: 'card' }, cashier);
  assert.equal(inv(db, out.invoice.id).status, 'paid');
});

// ─── MAJOR: смена через полночь ─────────────────────────────────────────────
test('MAJOR: смена, оставленная через полночь, закрывается НЕ пересчитанной; её наличные — остаток новой смены', () => {
  const db = seed();
  const sh = Number(db.prepare("INSERT INTO cash_shifts (cashier_id, opening_float, status, opened_at) VALUES (9, 1000, 'open', '2026-01-01T06:00:00Z')").run().lastInsertRowid);
  const CONS = svc(db, 'Приём', 50000);
  const { vid, ids } = visitWith(db, [CONS]);
  const out = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: ids }, registrar);
  db.prepare("INSERT INTO payments (invoice_id, amount, method, cashier_id, shift_id) VALUES (?, 50000, 'cash', 9, ?)").run(out.invoice.id, sh);
  autoCloseStaleShifts(db);
  const s = db.prepare('SELECT * FROM cash_shifts WHERE id = ?').get(sh);
  assert.equal(s.status, 'closed');
  assert.equal(s.counted_amount, null, 'никто не пересчитывал');
  assert.equal(s.over_short, null);
  assert.equal(s.auto_closed, 1);
  assert.equal(s.expected_amount, 51000);
  const next = ensureOpenShift(db, cashier);
  assert.equal(next.opening_float, 51000, 'непересчитанные наличные остались в ящике');
});

// ─── MAJOR: админ дополнительной ролью ──────────────────────────────────────
test('MAJOR: админ дополнительной ролью закрывает и смотрит чужую смену', () => {
  const db = seed();
  const boss = { id: 12, role: 'registrar', extra_roles: ['admin'] };
  const sh = ensureOpenShift(db, cashier);
  const rep = shiftReport(db, { shift_id: sh.id }, boss);
  assert.equal(rep.shift.id, sh.id);
  const closed = closeCashShift(db, { shift_id: sh.id, counted_amount: 0 }, boss);
  assert.equal(closed.shift.status, 'closed');
  // чужой кассир без админской роли — по-прежнему отказ
  const sh2 = ensureOpenShift(db, cashier);
  assert.throws(() => shiftReport(db, { shift_id: sh2.id }, { id: 10, role: 'cashier' }), /свою смену/);
  assert.throws(() => closeCashShift(db, { shift_id: sh2.id, counted_amount: 0 }, { id: 10, role: 'cashier' }), /свою смену/);
});

// ─── MAJOR: отмена счёта возвращает товар ───────────────────────────────────
test('MAJOR: отмена счёта со списанным товаром возвращает товар на склад', () => {
  const db = seed();
  const prod = Number(db.prepare("INSERT INTO products (name, sale_price, on_hand) VALUES ('Бинт', 2000, 7)").run().lastInsertRowid);
  const pid = Number(db.prepare("INSERT INTO patients (full_name) VALUES ('П')").run().lastInsertRowid);
  const vid = Number(db.prepare("INSERT INTO visits (patient_id, visit_date) VALUES (?, '2026-09-27T05:00:00Z')").run(pid).lastInsertRowid);
  const vs = Number(db.prepare("INSERT INTO visit_services (visit_id, clinic_item_id, quantity, unit_price, total, status) VALUES (?, ?, 3, 2000, 6000, 'added')").run(vid, prod).lastInsertRowid);
  db.prepare("INSERT INTO stock_movements (product_id, kind, qty, reference_type, reference_id) VALUES (?, 'dispense', -3, 'visit', ?)").run(prod, vs);
  const out = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs] }, registrar);
  voidInvoice(db, { invoice_id: out.invoice.id }, cashier);
  assert.equal(db.prepare('SELECT on_hand FROM products WHERE id = ?').get(prod).on_hand, 10);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM visit_services WHERE id = ?').get(vs).n, 0);
});

// ─── MAJOR: частичный возврат депозита ──────────────────────────────────────
test('MAJOR: частичный возврат депозита не запирает остаток', () => {
  const db = seed();
  const pid = Number(db.prepare("INSERT INTO patients (full_name) VALUES ('П')").run().lastInsertRowid);
  const dep = createDeposit(db, { patient_id: pid, amount: 100000 }, registrar).deposit;
  acceptDeposit(db, { deposit_id: dep.id, method: 'cash' }, cashier);
  refundDeposit(db, { deposit_id: dep.id, amount: 30000 }, cashier);
  let d = db.prepare('SELECT * FROM patient_deposits WHERE id = ?').get(dep.id);
  assert.equal(d.status, 'received');
  assert.equal(d.refund_amount, 30000);
  assert.equal(walletBalance(db, pid), 70000);
  const row = listDeposits(db, { status: 'all' }, cashier).rows.find((x) => x.id === dep.id);
  assert.equal(row.refundable, 70000);
  refundDeposit(db, { deposit_id: dep.id, amount: 70000 }, cashier);
  d = db.prepare('SELECT * FROM patient_deposits WHERE id = ?').get(dep.id);
  assert.equal(d.status, 'refunded');
  assert.equal(d.refund_amount, 100000);
  assert.equal(walletBalance(db, pid), 0);
  assert.throws(() => refundDeposit(db, { deposit_id: dep.id, amount: 1 }, cashier), /уже возвращён/);
});

// ─── MAJOR: идемпотентность ─────────────────────────────────────────────────
test('MAJOR: повтор денежного RPC с тем же idempotency_key возвращает первый результат, денег не двигает', () => {
  const db = seed();
  const CONS = svc(db, 'Приём', 140000);
  const { vid, ids, pid } = visitWith(db, [CONS]);
  const out = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: ids }, registrar);
  const a = recordPayment(db, { invoice_id: out.invoice.id, amount: 40000, method: 'cash', idempotency_key: 'pay-key-0001' }, cashier);
  const b = recordPayment(db, { invoice_id: out.invoice.id, amount: 40000, method: 'cash', idempotency_key: 'pay-key-0001' }, cashier);
  assert.equal(b.repeated, true);
  assert.equal(b.invoice.paid_amount, a.invoice.paid_amount);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM payments WHERE invoice_id = ?').get(out.invoice.id).n, 1);

  recordPaymentSplit(db, { invoice_id: out.invoice.id, tenders: [{ amount: 50000, method: 'cash' }], idempotency_key: 'split-key-01' }, cashier);
  recordPaymentSplit(db, { invoice_id: out.invoice.id, tenders: [{ amount: 50000, method: 'cash' }], idempotency_key: 'split-key-01' }, cashier);
  assert.equal(inv(db, out.invoice.id).paid_amount, 90000);

  const p1 = db.prepare('SELECT id FROM payments WHERE invoice_id = ? ORDER BY id LIMIT 1').get(out.invoice.id).id;
  refundPayment(db, { payment_id: p1, amount: 10000, to_balance: false, idempotency_key: 'refund-key-1' }, cashier);
  refundPayment(db, { payment_id: p1, amount: 10000, to_balance: false, idempotency_key: 'refund-key-1' }, cashier);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM payments WHERE amount < 0').get().n, 1);

  sellCard(db, { amount: 50000, method: 'cash', patient_id: pid, idempotency_key: 'card-key-001' }, cashier);
  sellCard(db, { amount: 50000, method: 'cash', patient_id: pid, idempotency_key: 'card-key-001' }, cashier);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM invoices WHERE invoice_number LIKE 'CARD-%'").get().n, 1);

  createDeposit(db, { patient_id: pid, amount: 1000, idempotency_key: 'dep-key-0001' }, registrar);
  createDeposit(db, { patient_id: pid, amount: 1000, idempotency_key: 'dep-key-0001' }, registrar);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM patient_deposits WHERE kind = 'deposit'").get().n, 1);

  cashMove(db, { kind: 'in', amount: 500, idempotency_key: 'move-key-001' }, cashier);
  cashMove(db, { kind: 'in', amount: 500, idempotency_key: 'move-key-001' }, cashier);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM cash_movements').get().n, 1);

  // тот же ключ у ДРУГОЙ операции — отказ, а не чужой ответ
  assert.throws(() => cashMove(db, { kind: 'in', amount: 500, idempotency_key: 'pay-key-0001' }, cashier), /ключ/i);
});

// ─── MAJOR: баланс для клинических ролей ────────────────────────────────────
test('MAJOR: врач и медсестра видят баланс пациента (только чтение)', () => {
  const db = seed();
  const pid = Number(db.prepare("INSERT INTO patients (full_name) VALUES ('П')").run().lastInsertRowid);
  const dep = createDeposit(db, { patient_id: pid, amount: 25000 }, registrar).deposit;
  acceptDeposit(db, { deposit_id: dep.id, method: 'cash' }, cashier);
  for (const role of ['doctor', 'nurse', 'lab', 'head_doctor']) {
    const r = depositBalance(db, { patient_id: pid }, { id: DOC, role: role === 'head_doctor' ? 'doctor' : role, extra_roles: role === 'head_doctor' ? ['head_doctor'] : [] });
    assert.equal(r.balance, 25000, role);
  }
  assert.throws(() => refundDeposit(db, { deposit_id: dep.id, amount: 1 }, { id: DOC, role: 'doctor' }), (e) => e.status === 403);
  assert.throws(() => depositBalance(db, { patient_id: pid }, { id: 99, role: 'inventory' }), (e) => e.status === 403);
});

// ─── Владелец: кэшбэк после возврата на баланс ──────────────────────────────
test('Кэшбэк: деньги, возвращённые на баланс с настоящей оплаты, при трате считаются новыми', () => {
  const db = seed();
  db.prepare("INSERT INTO cashback_rules (name, percent, active) VALUES ('Все', 10, 1)").run();
  const NEURO = svc(db, 'Невролог', 100000), CARDIO = svc(db, 'Кардиолог', 100000);
  const { vid, ids, pid } = visitWith(db, [NEURO]);
  const a = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: ids }, registrar).invoice;
  recordPayment(db, { invoice_id: a.id, amount: 100000, method: 'cash' }, cashier);
  assert.equal(walletBalance(db, pid), 10000, 'кэшбэк 10%');
  const p = db.prepare('SELECT id FROM payments WHERE invoice_id = ?').get(a.id).id;
  refundPayment(db, { payment_id: p, to_balance: true }, cashier);   // «не мой пациент»
  assert.equal(walletBalance(db, pid), 100000, 'кэшбэк откачен, деньги на балансе');
  const vs2 = Number(db.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status) VALUES (?, ?, 1, 0, 0, 'added')").run(vid, CARDIO).lastInsertRowid);
  const b = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs2] }, registrar).invoice;
  recordPayment(db, { invoice_id: b.id, amount: 100000, method: 'wallet' }, cashier);
  assert.equal(walletBalance(db, pid), 10000, 'кэшбэк за второй счёт — деньги пациента новые');
});

test('Кэшбэк: оплата с баланса из депозита и кэшбэка по-прежнему кэшбэка не даёт', () => {
  const db = seed();
  db.prepare("INSERT INTO cashback_rules (name, percent, active) VALUES ('Все', 10, 1)").run();
  const A = svc(db, 'А', 50000);
  const { vid, ids, pid } = visitWith(db, [A]);
  const dep = createDeposit(db, { patient_id: pid, amount: 50000 }, registrar).deposit;
  acceptDeposit(db, { deposit_id: dep.id, method: 'cash' }, cashier);
  const a = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: ids }, registrar).invoice;
  recordPayment(db, { invoice_id: a.id, amount: 50000, method: 'wallet' }, cashier);
  assert.equal(walletBalance(db, pid), 0);
});

// ─── MINOR ──────────────────────────────────────────────────────────────────
test('MINOR: картотека — баланс это кошелёк, долг отдельно', () => {
  const db = seed();
  const A = svc(db, 'А', 50000);
  const { vid, ids, pid } = visitWith(db, [A]);
  createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: ids }, registrar);
  const dep = createDeposit(db, { patient_id: pid, amount: 20000 }, registrar).deposit;
  acceptDeposit(db, { deposit_id: dep.id, method: 'cash' }, cashier);
  const [r] = patientBaseAggregates(db, { p_ids: [pid] }, registrar);
  assert.equal(r.balance, 20000);
  assert.equal(r.debt, 50000);
});

test('MINOR: пустая или нечисловая личная цена врача — это «своей цены нет», а не бесплатно', () => {
  const db = seed();
  const A = svc(db, 'А', 50000), B = svc(db, 'Б', 60000), C = svc(db, 'В', 70000);
  db.prepare('UPDATE users SET service_rates = ? WHERE id = ?').run(JSON.stringify([
    { service_id: A, price: '' }, { service_id: B, price: 'abc' }, { service_id: C, price: '80000' },
  ]), DOC);
  assert.equal(doctorPriceFor(db, DOC, A), null);
  assert.equal(doctorPriceFor(db, DOC, B), null);
  assert.equal(doctorPriceFor(db, DOC, C), 80000);
});

test('MINOR: cash_shift_summary ничего не пишет (при блокировке лицензии это чтение)', () => {
  const db = seed();
  const before = db.prepare('SELECT COUNT(*) n FROM cash_shifts').get().n;
  const s = cashShiftSummary(db, {}, cashier);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM cash_shifts').get().n, before);
  assert.ok(s.shift, 'экран получает день даже без записанной смены');
  assert.equal(s.shift.id, null);
  assert.equal(s.expected_drawer, 0);
});

// ─── PERF ───────────────────────────────────────────────────────────────────
test('PERF: cashier_invoices — те же строки: долги всегда, оплаченные и отменённые — только сегодня', () => {
  const db = seed();
  const pid = Number(db.prepare("INSERT INTO patients (full_name) VALUES ('П')").run().lastInsertRowid);
  const mk = (no, status, extra = {}) => Number(db.prepare(`INSERT INTO invoices (invoice_number, patient_id, total_amount, paid_amount, status, created_at, paid_at, voided_at, payer_id)
      VALUES (?, ?, 100, ?, ?, ?, ?, ?, ?)`).run(no, pid, status === 'paid' ? 100 : 0, status,
    extra.created_at || '2020-01-01T00:00:00Z', extra.paid_at || null, extra.voided_at || null, extra.payer_id || null).lastInsertRowid);
  const now = new Date().toISOString().slice(0, 19) + 'Z';
  const old = mk('I1', 'unpaid');
  const debt = mk('I2', 'debt');
  const paidToday = mk('I3', 'paid', { paid_at: now });
  mk('I4', 'paid', { paid_at: '2020-01-01T00:00:00Z' });
  const voidToday = mk('I5', 'void', { voided_at: now });
  mk('I6', 'void', { voided_at: '2020-01-01T00:00:00Z' });
  const payer = Number(db.prepare("INSERT INTO payers (name, kind, active) VALUES ('С', 'insurance', 1)").run().lastInsertRowid);
  mk('I7', 'unpaid', { payer_id: payer });
  const r = cashierInvoices(db, {}, cashier);
  assert.deepEqual(r.rows.map((x) => x.id).sort((a, b) => a - b), [old, debt, paidToday, voidToday].sort((a, b) => a - b));
  assert.equal(r.counts.unpaid.n, 1);
  assert.equal(r.counts.debt.n, 1);
  assert.equal(r.counts.paid.n, 1);
  assert.equal(r.counts.cancelled.n, 1);
  const [from, to] = utcRange(db, '2026-09-27', '2026-09-27');
  assert.ok(from < to);
});
