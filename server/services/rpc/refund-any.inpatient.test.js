// REFUND_ANY_V1 (2026-10-29) — СТРОКА СТАЦИОНАРА ВОЗВРАЩАЕТСЯ ОТДЕЛЬНО.
//
// refund_invoice_line отказывал строке стационара («её убирают из счёта
// госпитализации (до оплаты) или возвращают оплатой по платежу»): оплаченную
// перевязку лежащему пациенту вернуть было нельзя — только деньгами по платежу,
// и тогда строка оставалась в счёте, а счёт выписки её не знал. Теперь:
//   • строка уходит со счёта, счёт пересчитывается без пола скидки группы
//     пациента (счёт стационара её не даёт — buildAdmissionInvoice);
//   • строка госпитализации освобождается (invoice_item_id = NULL) с прежней
//     работой (выполнена — 'done', иначе 'added') и отметкой
//     pay_refund_releases 'in': счёт выписки (generateAdmissionBill) её не
//     берёт, врачу она не платится;
//   • пациент на койке — счёт без денег не отменяется (closeFullyRefunded);
//     после выписки возврат — как у обычного счёта.
// Правило денег после каждой операции: сумма платежей = «оплачено» по счёту.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { createInvoiceForAdmission, recordPayment, refundInvoiceLine, refundPayment } from './billing.js';
import { openCashShift } from './cashier.js';
import { generateAdmissionBill } from './admission-bill.js';

const cashier = { id: 9, role: 'cashier', full_name: 'Кассир' };
const admin = { id: 1, role: 'admin', full_name: 'Админ' };

function seed({ category = 0 } = {}) {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, role, full_name) VALUES (1,'adm','x','admin','Админ')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, role, full_name) VALUES (9,'cash','x','cashier','Кассир')").run();
  let catId = null;
  if (category) catId = db.prepare("INSERT INTO patient_categories (name, discount_percent, active) VALUES ('VIP', ?, 1)").run(category).lastInsertRowid;
  const pid = db.prepare('INSERT INTO patients (full_name, category_id) VALUES (?, ?)').run('Пациент стационара', catId).lastInsertRowid;
  const adm = db.prepare("INSERT INTO admissions (patient_id, status, created_at) VALUES (?, 'active', strftime('%Y-%m-%dT%H:%M:%SZ','now','-3 days'))").run(pid).lastInsertRowid;
  const dressing = db.prepare("INSERT INTO services (name, price, type) VALUES ('Перевязка', 50000, 'procedure')").run().lastInsertRowid;
  const drip = db.prepare("INSERT INTO services (name, price, type) VALUES ('Капельница', 120000, 'procedure')").run().lastInsertRowid;
  const line = db.prepare(`INSERT INTO admission_services (admission_id, service_id, quantity, unit_price, total, billable, status, performed_at)
                           VALUES (?, ?, 1, ?, ?, 1, ?, ?)`);
  const a = line.run(adm, dressing, 50000, 50000, 'done', '2026-10-28T08:00:00Z').lastInsertRowid;
  const b = line.run(adm, drip, 120000, 120000, 'added', null).lastInsertRowid;
  openCashShift(db, { opening_float: 0 }, cashier);
  const inv = createInvoiceForAdmission(db, { admission_id: adm, admission_service_ids: [a, b] }, cashier).invoice;
  recordPayment(db, { invoice_id: inv.id, amount: inv.total_amount, method: 'cash' }, cashier);
  return { db, pid, adm, a, b, inv };
}
const invRow = (db, id) => db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
const line = (db, id) => db.prepare('SELECT * FROM admission_services WHERE id = ?').get(id);
const itemOf = (db, id) => line(db, id).invoice_item_id;
const ledgerOk = (db, id) => {
  const s = db.prepare('SELECT COALESCE(SUM(amount), 0) s FROM payments WHERE invoice_id = ?').get(id).s;
  assert.equal(Math.round(s * 100) / 100, invRow(db, id).paid_amount, 'сумма платежей = оплачено по счёту');
};
const marked = (db, id) => db.prepare("SELECT COUNT(*) n FROM pay_refund_releases WHERE kind = 'in' AND line_id = ?").get(id).n;

test('пациент на койке: оплаченную строку стационара возвращают отдельно — деньги вышли, строка освобождена, отметка «in»', () => {
  const f = seed();
  assert.equal(invRow(f.db, f.inv.id).total_amount, 170000);
  ledgerOk(f.db, f.inv.id);
  const r = refundInvoiceLine(f.db, { invoice_item_id: itemOf(f.db, f.a), reason: 'Не делали' }, cashier);
  assert.equal(r.refunded, 50000);
  assert.equal(r.admission_line_released, true);
  const after = invRow(f.db, f.inv.id);
  assert.deepEqual([after.total_amount, after.paid_amount, after.status], [120000, 120000, 'paid']);
  ledgerOk(f.db, f.inv.id);
  const la = line(f.db, f.a);
  assert.deepEqual([la.invoice_item_id, la.status], [null, 'done'], 'выполненная работа — со своей отметкой, без счёта');
  assert.equal(marked(f.db, f.a), 1, 'строка помечена отпущенной с возвратом');
  assert.equal(line(f.db, f.b).invoice_item_id != null, true, 'другая строка — в счёте');
  const log = f.db.prepare("SELECT notes FROM invoice_audit_log WHERE invoice_id = ? AND action = 'refund_line'").get(f.inv.id);
  assert.match(log.notes, /строка стационара — освобождена, в счёт выписки не попадёт/);
});

test('счёт выписки возвращённую строку не берёт; новая строка — берёт', () => {
  const f = seed();
  refundInvoiceLine(f.db, { invoice_item_id: itemOf(f.db, f.a) }, cashier);
  const svc = f.db.prepare("INSERT INTO services (name, price, type) VALUES ('Осмотр', 30000, 'procedure')").run().lastInsertRowid;
  const c = f.db.prepare("INSERT INTO admission_services (admission_id, service_id, quantity, unit_price, total, billable, status) VALUES (?, ?, 1, 30000, 30000, 1, 'added')").run(f.adm, svc).lastInsertRowid;
  const bill = generateAdmissionBill(f.db, f.adm, admin);
  assert.ok(bill, 'счёт выписки собран');
  assert.equal(itemOf(f.db, f.a), null, 'возвращённая строка не выставлена снова');
  const billed = f.db.prepare('SELECT invoice_id FROM invoice_items WHERE id = ?').get(itemOf(f.db, c));
  assert.equal(billed.invoice_id, bill.invoice_id, 'новая строка — в счёте выписки');
  const descr = f.db.prepare('SELECT description FROM invoice_items WHERE invoice_id = ?').all(bill.invoice_id).map((x) => x.description);
  assert.ok(!descr.includes('Перевязка'), 'перевязки в счёте выписки нет: ' + descr);
});

test('последняя строка, пациент на койке: деньги вернулись, счёт не отменён — пациент ещё лежит', () => {
  const f = seed();
  refundInvoiceLine(f.db, { invoice_item_id: itemOf(f.db, f.b) }, cashier);
  const r = refundInvoiceLine(f.db, { invoice_item_id: itemOf(f.db, f.a) }, cashier);
  assert.equal(r.voided, false);
  assert.match(r.void_note, /Пациент ещё в стационаре/);
  const after = invRow(f.db, f.inv.id);
  assert.deepEqual([after.total_amount, after.paid_amount], [0, 0]);
  ledgerOk(f.db, f.inv.id);
  assert.equal(marked(f.db, f.a) + marked(f.db, f.b), 2);
});

test('пол скидки группы пациента на счёт стационара не ложится: возврат одной строки не удешевляет другую', () => {
  const f = seed({ category: 10 });
  assert.equal(invRow(f.db, f.inv.id).discount_amount, 0, 'счёт стационара собран без скидки группы');
  const r = refundInvoiceLine(f.db, { invoice_item_id: itemOf(f.db, f.a) }, cashier);
  assert.equal(r.refunded, 50000, 'вернули ровно цену строки');
  const after = invRow(f.db, f.inv.id);
  assert.deepEqual([after.subtotal, after.discount_amount, after.total_amount, after.paid_amount, after.status], [120000, 0, 120000, 120000, 'paid']);
  ledgerOk(f.db, f.inv.id);
});

test('после выписки: возврат строки и частичный возврат по платежу — как у обычного счёта', () => {
  const f = seed();
  f.db.prepare("UPDATE admissions SET status = 'discharged', discharged_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?").run(f.adm);
  const r = refundInvoiceLine(f.db, { invoice_item_id: itemOf(f.db, f.a) }, cashier);
  assert.equal(r.refunded, 50000);
  ledgerOk(f.db, f.inv.id);
  // Частичный возврат по платежу — скидка после продажи, счёт остаётся оплаченным
  // (V3120_FIX): «пациент заплатит снова» — только явной галочкой.
  const pay = f.db.prepare('SELECT id FROM payments WHERE invoice_id = ? AND amount > 0').get(f.inv.id).id;
  const p = refundPayment(f.db, { payment_id: pay, amount: 20000 }, cashier);
  assert.equal(p.post_sale_discount, 20000);
  const after = invRow(f.db, f.inv.id);
  assert.deepEqual([after.total_amount, after.paid_amount, after.status], [100000, 100000, 'paid']);
  ledgerOk(f.db, f.inv.id);
  // Последняя строка после выписки — счёт закрывается отменой, как у обычного.
  const last = refundInvoiceLine(f.db, { invoice_item_id: itemOf(f.db, f.b) }, cashier);
  assert.equal(last.voided, true);
  assert.equal(invRow(f.db, f.inv.id).status, 'void');
  ledgerOk(f.db, f.inv.id);
});
