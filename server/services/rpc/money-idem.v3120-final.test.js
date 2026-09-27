// V3120_FINAL (I1) — КЛЮЧ ПОВТОРА ДЕНЕЖНОЙ ОПЕРАЦИИ ОТВЕЧАЕТ СОХРАНЁННЫМ
// ОТВЕТОМ, ТОЛЬКО ЕСЛИ ФОРМА ТА ЖЕ.
//
// Квитанция (money_idempotency, мигр. 193) сверяла лишь имя RPC: повтор с тем
// же ключом, но ДРУГОЙ суммой получал прежний ответ «принято», и деньги не
// проводились. Касса держала один ключ на открытое окно: частичная оплата
// записана, «Оставить как долг» упал, кассир нажимает «Принять оплату» на
// остаток — сервер отвечал квитанцией первой оплаты, остаток не записывался,
// а экран говорил «Оплата принята». Теперь квитанция хранит отпечаток формы
// (мигр. 213), и тот же ключ с другой формой — отказ 409.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { createInvoiceForVisit, recordPayment, recordPaymentSplit, markInvoiceDebt, refundPayment } from './billing.js';
import { cashMove } from './cashier.js';
import { createDeposit } from './deposits.js';

const registrar = { id: 7, role: 'registrar', full_name: 'Регистратор' };
const cashier = { id: 9, role: 'cashier', full_name: 'Кассир' };
const doctor = { id: 20, role: 'doctor', full_name: 'Врач' };

function seed() {
  const db = openDb(':memory:'); migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, role, full_name, is_doctor) VALUES (?,?,?,?,?,?)');
  u.run(7, 'reg', 'x', 'registrar', 'Регистратор', 0);
  u.run(9, 'cash', 'x', 'cashier', 'Кассир', 0);
  u.run(20, 'doc', 'x', 'doctor', 'Врач', 1);
  const sid = db.prepare("INSERT INTO services (name, price) VALUES ('Приём', 140000)").run().lastInsertRowid;
  const pid = db.prepare("INSERT INTO patients (full_name) VALUES ('Пациент')").run().lastInsertRowid;
  const vid = db.prepare("INSERT INTO visits (patient_id, visit_date) VALUES (?, '2026-09-27T05:00:00Z')").run(pid).lastInsertRowid;
  const vs = db.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status) VALUES (?, ?, 1, 0, 0, 'added')").run(vid, sid).lastInsertRowid;
  const invoice = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs] }, registrar).invoice;
  return { db, invoice, pid };
}
const paidOf = (db, id) => db.prepare('SELECT paid_amount p FROM invoices WHERE id = ?').get(id).p;

test('I1: частичная оплата, «Оставить как долг» упал, «Принять оплату» на остаток — остаток записан', () => {
  const { db, invoice } = seed();
  const key1 = 'desk-key-0001';
  recordPayment(db, { invoice_id: invoice.id, amount: 40000, method: 'cash', idempotency_key: key1 }, cashier);
  // mark_invoice_debt падает (здесь — роль без права; у кассы — сеть, отказ).
  assert.throws(() => markInvoiceDebt(db, { invoice_id: invoice.id }, doctor));
  assert.equal(paidOf(db, invoice.id), 40000);
  // Старое окно повторило бы тот же ключ с другой суммой: это отказ, а не чужая квитанция.
  assert.throws(
    () => recordPayment(db, { invoice_id: invoice.id, amount: 100000, method: 'cash', idempotency_key: key1 }, cashier),
    (e) => e.status === 409 && /ключ/i.test(e.message),
  );
  assert.equal(paidOf(db, invoice.id), 40000, 'ничего не проведено молча');
  // Экран после удачной оплаты берёт новый ключ — остаток записывается.
  const r = recordPayment(db, { invoice_id: invoice.id, amount: 100000, method: 'cash', idempotency_key: 'desk-key-0002' }, cashier);
  assert.notEqual(r.repeated, true);
  assert.equal(paidOf(db, invoice.id), 140000);
  assert.equal(db.prepare('SELECT status s FROM invoices WHERE id = ?').get(invoice.id).s, 'paid');
});

test('I1: повтор ТОЙ ЖЕ формы с тем же ключом — прежний ответ; порядок полей и сам ключ на отпечаток не влияют', () => {
  const { db, invoice } = seed();
  recordPaymentSplit(db, { invoice_id: invoice.id, tenders: [{ amount: 30000, method: 'cash' }, { amount: 20000, method: 'card' }], idempotency_key: 'split-key-01' }, cashier);
  const again = recordPaymentSplit(db, { idempotency_key: 'split-key-01', tenders: [{ method: 'cash', amount: 30000 }, { method: 'card', amount: 20000 }], invoice_id: invoice.id }, cashier);
  assert.equal(again.repeated, true);
  assert.equal(paidOf(db, invoice.id), 50000);
  // Другая разбивка тех же денег — другая форма.
  assert.throws(() => recordPaymentSplit(db, { invoice_id: invoice.id, tenders: [{ amount: 50000, method: 'cash' }], idempotency_key: 'split-key-01' }, cashier),
    (e) => e.status === 409);
});

test('I1: возврат, внесение наличных и депозит — тот же ключ с другой суммой отказывает', () => {
  const { db, invoice, pid } = seed();
  recordPayment(db, { invoice_id: invoice.id, amount: 140000, method: 'cash' }, cashier);
  const p = db.prepare('SELECT id FROM payments WHERE invoice_id = ?').get(invoice.id).id;
  refundPayment(db, { payment_id: p, amount: 10000, to_balance: false, idempotency_key: 'refund-key-1' }, cashier);
  assert.throws(() => refundPayment(db, { payment_id: p, amount: 20000, to_balance: false, idempotency_key: 'refund-key-1' }, cashier), (e) => e.status === 409);
  cashMove(db, { kind: 'in', amount: 500, idempotency_key: 'move-key-001' }, cashier);
  assert.throws(() => cashMove(db, { kind: 'in', amount: 700, idempotency_key: 'move-key-001' }, cashier), (e) => e.status === 409);
  createDeposit(db, { patient_id: pid, amount: 1000, idempotency_key: 'dep-key-0001' }, registrar);
  assert.throws(() => createDeposit(db, { patient_id: pid, amount: 2000, idempotency_key: 'dep-key-0001' }, registrar), (e) => e.status === 409);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM cash_movements').get().n, 1);
});
