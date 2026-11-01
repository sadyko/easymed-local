// REFUND_ANY_V1 (ревью B5, п. 3) — ВОЗВРАТ ОПЛАТЫ ПИШЕТ ЖУРНАЛ СЧЁТА САМ.
//
// refund_invoice_line журналирует себя в invoice_audit_log ('refund_line'), а
// refund_payment — нет: строку 'refunded' дописывал браузер, и только окно
// отмены счёта визита (invoice-actions.js cancelInvoice). Возврат оплаты из
// окна «Платежи» кассы — в том числе открытого из окна визита — в «Invoice
// activity» визита не попадал вовсе. Теперь строку пишет сервер, в той же
// транзакции, что возврат: сколько, по какому платежу, частичный или полный,
// кто. Деньги — ровно как прежде (сумма платежей = оплачено по счёту, ответ
// тот же); повтор той же формы (idempotency_key) второй строки не пишет;
// отказ — ни строки.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { createInvoiceForVisit, recordPayment, refundPayment } from './billing.js';
import { openCashShift } from './cashier.js';

const registrar = { id: 7, role: 'registrar' };
const cashier = { id: 9, role: 'cashier', full_name: 'Кассир' };

function seed() {
  const db = openDb(':memory:'); migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, role, full_name) VALUES (?,?,?,?,?)');
  u.run(7, 'reg', 'x', 'registrar', 'Регистратор');
  u.run(9, 'cash', 'x', 'cashier', 'Кассир');
  const pid = db.prepare("INSERT INTO patients (full_name) VALUES ('Пациент')").run().lastInsertRowid;
  const vid = db.prepare("INSERT INTO visits (patient_id, visit_date) VALUES (?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))").run(pid).lastInsertRowid;
  const svc = db.prepare("INSERT INTO services (name, price, type) VALUES ('Приём', 100000, 'consultation')").run().lastInsertRowid;
  const vs = db.prepare('INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total) VALUES (?, ?, 1, 0, 0)').run(vid, svc).lastInsertRowid;
  openCashShift(db, { opening_float: 0 }, cashier);
  const inv = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs] }, registrar).invoice;
  recordPayment(db, { invoice_id: inv.id, amount: 100000, method: 'cash' }, cashier);
  const pay = db.prepare('SELECT id FROM payments WHERE invoice_id = ? AND amount > 0').get(inv.id).id;
  return { db, vid, inv, pay };
}
const refundRows = (db, invId) => db.prepare("SELECT * FROM invoice_audit_log WHERE invoice_id = ? AND action = 'refunded' ORDER BY id").all(invId);
const ledgerOk = (db, id) => {
  const s = db.prepare('SELECT COALESCE(SUM(amount), 0) s FROM payments WHERE invoice_id = ?').get(id).s;
  assert.equal(Math.round(s * 100) / 100, db.prepare('SELECT paid_amount p FROM invoices WHERE id = ?').get(id).p, 'сумма платежей = оплачено по счёту');
};

test('частичный возврат оплаты — одна строка журнала счёта: сколько, по какому платежу, «частичный», кто, причина', () => {
  const f = seed();
  const res = refundPayment(f.db, { payment_id: f.pay, amount: 40000, reason: 'не всё сделали' }, cashier);
  // Деньги — как прежде: частичный возврат по оплаченному счёту — скидка после продажи.
  assert.equal(res.invoice.paid_amount, 60000);
  assert.equal(res.invoice.total_amount, 60000);
  assert.equal(res.invoice.status, 'paid');
  assert.equal(res.voided, false);
  ledgerOk(f.db, f.inv.id);
  const rows = refundRows(f.db, f.inv.id);
  assert.equal(rows.length, 1, 'строк журнала: ' + rows.length);
  const r = rows[0];
  assert.equal(r.visit_id, f.vid, 'строка не попадёт в журнал визита');
  assert.equal(r.invoice_number, f.inv.invoice_number);
  assert.equal(r.refund_amount, 40000);
  assert.equal(r.amount, 100000, 'сумма платежа, по которому вернули');
  assert.equal(r.from_status, 'paid');
  assert.equal(r.to_status, 'paid');
  assert.equal(r.reason, 'не всё сделали');
  assert.equal(r.actor_user_id, cashier.id);
  assert.equal(r.actor_name, 'Кассир');
  assert.equal(r.actor_role, 'cashier');
  assert.match(r.notes, new RegExp('платежу #' + f.pay + '\\b'));
  assert.match(r.notes, /40 000 из 100 000/);
  assert.match(r.notes, /частичный/);
});

test('остаток платежа — вторая строка «полный»; счёт закрыт отменой, как прежде', () => {
  const f = seed();
  refundPayment(f.db, { payment_id: f.pay, amount: 40000 }, cashier);
  const res = refundPayment(f.db, { payment_id: f.pay, amount: 60000, to_balance: true }, cashier);
  assert.equal(res.voided, true);
  assert.equal(res.invoice.status, 'void');
  ledgerOk(f.db, f.inv.id);
  const rows = refundRows(f.db, f.inv.id);
  assert.deepEqual(rows.map((r) => r.refund_amount), [40000, 60000]);
  assert.match(rows[1].notes, /полный/);
  assert.match(rows[1].notes, /на баланс пациента/);
  assert.equal(rows[1].to_status, 'void');
  // Отмену журналирует отмена — своей строкой, как прежде.
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM invoice_audit_log WHERE invoice_id = ? AND action = 'void'").get(f.inv.id).n, 1);
});

test('повтор той же формы (idempotency_key) второй строки не пишет; отказ — ни строки', () => {
  const f = seed();
  const args = { payment_id: f.pay, amount: 30000, idempotency_key: 'refund-key-0001' };
  const a = refundPayment(f.db, args, cashier);
  const b = refundPayment(f.db, args, cashier);
  assert.equal(b.repeated, true);
  assert.equal(a.invoice.paid_amount, b.invoice.paid_amount);
  assert.equal(refundRows(f.db, f.inv.id).length, 1, 'повтор записал вторую строку');
  assert.throws(() => refundPayment(f.db, { payment_id: f.pay, amount: 999999 }, cashier), (e) => e.status === 400);
  assert.equal(refundRows(f.db, f.inv.id).length, 1, 'отказ записал строку');
  ledgerOk(f.db, f.inv.id);
});
