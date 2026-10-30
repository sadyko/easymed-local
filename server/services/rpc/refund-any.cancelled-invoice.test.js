// REFUND_ANY_V1 (ревью B5, повторное) — ВОЗВРАТ ОПЛАТЫ ПО ОТМЕНЁННОМУ СЧЁТУ,
// НА КОТОРОМ ОСТАЛИСЬ ДЕНЬГИ.
//
// Отмена счёта до BILLING_AUDIT_FIX_V1 денег не трогала: бывают счета 'void'
// (и 'refunded') с оплатой на них. Окно визита теперь даёт по ним «Возврат»
// (ревью B5, п. 5), и refund_payment пересчитывал такому счёту статус по
// деньгам (invoiceStatusFor 'void' не знает): частичный возврат делал его
// «оплачен частично» с долгом 40 000, полный без «отменить счёт» — «не
// оплачен» с долгом 100 000 (оба — OUTSTANDING_STATUSES: касса, дашборд,
// долги), полный по умолчанию — отменял счёт второй раз (снова снимал строки
// с визита). Отменённый счёт пациенту ничего не должен: возврат по нему
// двигает только деньги (платёж возврата, баланс или карта, откат кэшбэка) и
// «оплачено»; статус, сумма и строки визита — как были. Журнал — одна строка.
//
// Строкой (refund_invoice_line) и заменой (cashier_line_swap_paid) отменённый
// счёт не тронуть — отказ словами (закреплено здесь же).
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { createInvoiceForVisit, recordPayment, refundPayment, refundInvoiceLine, swapPaidLine } from './billing.js';
import { openCashShift, cashierInvoices } from './cashier.js';
import { OUTSTANDING_STATUSES, outstandingWhere } from '../domain/money.js';

const registrar = { id: 7, role: 'registrar' };
const cashier = { id: 9, role: 'cashier', full_name: 'Кассир' };
const admin = { id: 1, role: 'admin', full_name: 'Админ' };

function seed(cancelledStatus) {
  const db = openDb(':memory:'); migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, role, full_name) VALUES (?,?,?,?,?)');
  u.run(1, 'adm', 'x', 'admin', 'Админ');
  u.run(7, 'reg', 'x', 'registrar', 'Регистратор');
  u.run(9, 'cash', 'x', 'cashier', 'Кассир');
  const pid = db.prepare("INSERT INTO patients (full_name) VALUES ('Пациент')").run().lastInsertRowid;
  const vid = db.prepare("INSERT INTO visits (patient_id, visit_date) VALUES (?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))").run(pid).lastInsertRowid;
  const svc = db.prepare('INSERT INTO services (name, price, type) VALUES (?, ?, ?)');
  const consult = svc.run('Приём', 100000, 'consultation').lastInsertRowid;
  const other = svc.run('УЗИ', 150000, 'imaging').lastInsertRowid;
  const vs = db.prepare('INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total) VALUES (?, ?, 1, 0, 0)').run(vid, consult).lastInsertRowid;
  openCashShift(db, { opening_float: 0 }, cashier);
  const inv = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs] }, registrar).invoice;
  recordPayment(db, { invoice_id: inv.id, amount: 100000, method: 'cash' }, cashier);
  // Отмена прежних сборок: статус сменили, деньги остались на счёте.
  db.prepare('UPDATE invoices SET status = ? WHERE id = ?').run(cancelledStatus, inv.id);
  const pay = db.prepare('SELECT id FROM payments WHERE invoice_id = ? AND amount > 0').get(inv.id).id;
  return { db, vid, vs, inv, pay, other };
}
const invRow = (db, id) => db.prepare('SELECT status, total_amount, paid_amount, discount_amount, voided_at FROM invoices WHERE id = ?').get(id);
const ledgerOk = (db, id) => {
  const s = db.prepare('SELECT COALESCE(SUM(amount), 0) s FROM payments WHERE invoice_id = ?').get(id).s;
  assert.equal(Math.round(s * 100) / 100, db.prepare('SELECT paid_amount p FROM invoices WHERE id = ?').get(id).p, 'сумма платежей = оплачено по счёту');
};
function notOwed(db, id) {
  const st = invRow(db, id).status;
  assert.ok(!OUTSTANDING_STATUSES.includes(st), 'отменённый счёт стал долгом: ' + st);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM invoices WHERE id = ? AND ${outstandingWhere()}`).get(id).n, 0);
  const { counts } = cashierInvoices(db, {}, cashier);
  assert.equal(counts.unpaid.n + counts.partial.n + counts.debt.n, 0, 'касса считает отменённый счёт долгом: ' + JSON.stringify(counts));
}
const auditRows = (db, id, action) => db.prepare('SELECT * FROM invoice_audit_log WHERE invoice_id = ? AND action = ? ORDER BY id').all(id, action);
const visitLine = (db, vs) => db.prepare('SELECT id, invoice_item_id, status FROM visit_services WHERE id = ?').get(vs);

for (const st of ['void', 'refunded']) {
  test(`${st}: частичный возврат 40 000 — статус прежний, оплачено 60 000, не долг, одна строка журнала`, () => {
    const f = seed(st);
    const before = invRow(f.db, f.inv.id);
    const line0 = visitLine(f.db, f.vs);
    const res = refundPayment(f.db, { payment_id: f.pay, amount: 40000 }, cashier);
    assert.equal(res.voided, false);
    assert.equal(res.post_sale_discount, undefined, 'отменённому счёту — скидка после продажи');
    const after = invRow(f.db, f.inv.id);
    assert.deepEqual(after, { ...before, paid_amount: 60000 }, 'по отменённому счёту изменилось не только «оплачено»');
    ledgerOk(f.db, f.inv.id);
    notOwed(f.db, f.inv.id);
    assert.deepEqual(visitLine(f.db, f.vs), line0, 'строка визита тронута');
    const log = auditRows(f.db, f.inv.id, 'refunded');
    assert.equal(log.length, 1);
    assert.equal(log[0].refund_amount, 40000);
    assert.equal(log[0].from_status, st);
    assert.equal(log[0].to_status, st);
    // Деньги — как у обычного возврата: платёж возврата в смену, наличными.
    const back = f.db.prepare('SELECT amount, method, notes FROM payments WHERE invoice_id = ? AND amount < 0').all(f.inv.id);
    assert.deepEqual(back.map((p) => [p.amount, p.method]), [[-40000, 'cash']]);
    assert.ok(String(back[0].notes).startsWith('REFUND#' + f.pay));
  });

  test(`${st}: полный возврат без «отменить счёт» — статус прежний, оплачено 0, не долг`, () => {
    const f = seed(st);
    const before = invRow(f.db, f.inv.id);
    const res = refundPayment(f.db, { payment_id: f.pay, amount: 100000, void_when_zero: false }, cashier);
    assert.equal(res.voided, false);
    assert.deepEqual(invRow(f.db, f.inv.id), { ...before, paid_amount: 0 });
    ledgerOk(f.db, f.inv.id);
    notOwed(f.db, f.inv.id);
    assert.equal(auditRows(f.db, f.inv.id, 'refunded').length, 1);
  });

  test(`${st}: полный возврат по умолчанию — статус прежний, второй отмены нет, строки визита на месте, одна строка журнала`, () => {
    const f = seed(st);
    const before = invRow(f.db, f.inv.id);
    const line0 = visitLine(f.db, f.vs);
    const res = refundPayment(f.db, { payment_id: f.pay, amount: 100000, to_balance: true }, cashier);
    assert.equal(res.voided, false, 'отменённый счёт отменён второй раз');
    assert.deepEqual(invRow(f.db, f.inv.id), { ...before, paid_amount: 0 });
    ledgerOk(f.db, f.inv.id);
    notOwed(f.db, f.inv.id);
    assert.deepEqual(visitLine(f.db, f.vs), line0, 'строки визита сняты второй отменой');
    assert.equal(auditRows(f.db, f.inv.id, 'void').length, 0, 'вторая отмена в журнале');
    const log = auditRows(f.db, f.inv.id, 'refunded');
    assert.equal(log.length, 1);
    assert.equal(log[0].to_status, st);
    assert.match(log[0].notes, /полный · на баланс пациента/);
    // На баланс — как у обычного возврата.
    assert.equal(res.to_balance, true);
  });

  test(`${st}: строкой и заменой отменённый счёт не тронуть — отказ словами`, () => {
    const f = seed(st);
    const item = f.db.prepare('SELECT invoice_item_id i FROM visit_services WHERE id = ?').get(f.vs).i;
    assert.throws(() => refundInvoiceLine(f.db, { invoice_item_id: item }, cashier),
      (e) => e.status === 400 && e.message === 'Счёт уже отменён — возвращать по нему нечего.');
    assert.throws(() => swapPaidLine(f.db, { visit_service_id: f.vs, new_service_id: f.other }, admin),
      (e) => e.status === 400 && e.message === 'Счёт отменён — менять в нём нечего.');
    assert.deepEqual(invRow(f.db, f.inv.id).paid_amount, 100000);
    ledgerOk(f.db, f.inv.id);
  });
}
