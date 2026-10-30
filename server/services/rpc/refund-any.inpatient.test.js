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
//   • ревью B2: вернули последнюю строку — пустой счёт закрывается сразу, и у
//     лежащего пациента: отпускать нечего, а открытый счёт 0/0 обещал бы
//     «закроется при выписке» и при выписке с долгом стал бы долгом на 0;
//     после выписки возврат — как у обычного счёта;
//   • ревью B2: доза, отметку которой сняли, уходит вместе со строкой (лекарство
//     — обратно на полку медсестры), возврат на баланс, проживание.
// Правило денег после каждой операции: сумма платежей = «оплачено» по счёту.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { createInvoiceForAdmission, recordPayment, refundInvoiceLine, refundPayment } from './billing.js';
import { openCashShift } from './cashier.js';
import { generateAdmissionBill } from './admission-bill.js';
import { admissionDischargeFinalize } from './inpatient.js';
import { walletBalance } from '../domain/wallet.js';
import { treatmentOrderCreate, treatmentAdminMark, treatmentAdminUnmark } from './treatment-orders.js';
import { billAccommodation, computeAccommodation } from './accommodation.js';

const cashier = { id: 9, role: 'cashier', full_name: 'Кассир' };
const admin = { id: 1, role: 'admin', full_name: 'Админ' };
const SENIOR = { id: 5, role: 'nurse', extra_roles: ['senior_nurse'] };   // выписку оформляет старшая медсестра

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
// Новая строка, начисленная после возврата, — ещё не в счёте.
const newLine = (f, price = 30000) => {
  const svc = f.db.prepare("INSERT INTO services (name, price, type) VALUES ('Осмотр', ?, 'procedure')").run(price).lastInsertRowid;
  return f.db.prepare("INSERT INTO admission_services (admission_id, service_id, quantity, unit_price, total, billable, status) VALUES (?, ?, 1, ?, ?, 1, 'added')").run(f.adm, svc, price, price).lastInsertRowid;
};

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
  const c = newLine(f);
  const bill = generateAdmissionBill(f.db, f.adm, admin);
  assert.ok(bill, 'счёт выписки собран');
  assert.equal(itemOf(f.db, f.a), null, 'возвращённая строка не выставлена снова');
  const billed = f.db.prepare('SELECT invoice_id FROM invoice_items WHERE id = ?').get(itemOf(f.db, c));
  assert.equal(billed.invoice_id, bill.invoice_id, 'новая строка — в счёте выписки');
  const descr = f.db.prepare('SELECT description FROM invoice_items WHERE invoice_id = ?').all(bill.invoice_id).map((x) => x.description);
  assert.ok(!descr.includes('Перевязка'), 'перевязки в счёте выписки нет: ' + descr);
});

test('последняя строка, пациент на койке: деньги вернулись, пустой счёт закрыт сразу — отпускать нечего', () => {
  const f = seed();
  refundInvoiceLine(f.db, { invoice_item_id: itemOf(f.db, f.b) }, cashier);
  // Ревью B2: невыполненная строка (капельницу не ставили) — снова «начислено», без счёта.
  assert.deepEqual([line(f.db, f.b).invoice_item_id, line(f.db, f.b).status], [null, 'added']);
  // Галочку «отменить счёт» окно лежащему пациенту не показывает — сервер её здесь не читает.
  const r = refundInvoiceLine(f.db, { invoice_item_id: itemOf(f.db, f.a), void_when_zero: false }, cashier);
  assert.equal(r.refunded, 50000);
  assert.equal(r.voided, true, 'пустой счёт лежащего пациента закрыт');
  assert.equal(r.void_note, undefined, '«счёт закроется при выписке» — не про пустой счёт');
  const after = invRow(f.db, f.inv.id);
  assert.deepEqual([after.total_amount, after.paid_amount, after.status], [0, 0, 'void']);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM invoice_items WHERE invoice_id = ?').get(f.inv.id).n, 0);
  ledgerOk(f.db, f.inv.id);
  assert.equal(marked(f.db, f.a) + marked(f.db, f.b), 2);
  assert.equal(f.db.prepare('SELECT status FROM admissions WHERE id = ?').get(f.adm).status, 'active', 'закрытие счёта пациента не выписывает');
});

test('после пустого счёта выписка выставляет только невыставленное; долг при выписке — без счёта на 0', () => {
  const f = seed();
  refundInvoiceLine(f.db, { invoice_item_id: itemOf(f.db, f.b) }, cashier);
  refundInvoiceLine(f.db, { invoice_item_id: itemOf(f.db, f.a) }, cashier);
  const c = newLine(f);
  f.db.prepare("INSERT INTO users (id, username, password_hash, role, full_name) VALUES (5,'snur','x','nurse','Старшая')").run();
  f.db.prepare("UPDATE admissions SET status = 'discharging', discharge_outcome = 'home' WHERE id = ?").run(f.adm);
  const res = admissionDischargeFinalize(f.db, { admission_id: f.adm, debt_ack: true }, SENIOR);
  assert.equal(res.admission.status, 'discharged');
  assert.deepEqual(res.debt_invoices.map((d) => d.balance), [30000], 'долг — только за новую строку, без счёта на 0: ' + JSON.stringify(res.debt_invoices));
  const debtInv = res.debt_invoices[0].id;
  assert.notEqual(debtInv, f.inv.id);
  assert.equal(f.db.prepare('SELECT invoice_id FROM invoice_items WHERE id = ?').get(itemOf(f.db, c)).invoice_id, debtInv);
  assert.deepEqual([itemOf(f.db, f.a), itemOf(f.db, f.b)], [null, null], 'возвращённые строки при выписке не выставлены');
  assert.equal(invRow(f.db, f.inv.id).status, 'void');
  ledgerOk(f.db, f.inv.id);
  ledgerOk(f.db, debtInv);
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

test('ревью B2: возврат строки стационара на баланс — деньги на балансе пациента', () => {
  const f = seed();
  const r = refundInvoiceLine(f.db, { invoice_item_id: itemOf(f.db, f.a), to_balance: true }, cashier);
  assert.equal(r.refunded, 50000);
  assert.equal(r.to_balance, true);
  assert.equal(walletBalance(f.db, f.pid), 50000, 'возврат лёг на баланс');
  assert.equal(f.db.prepare("SELECT COALESCE(SUM(amount), 0) s FROM patient_deposits WHERE patient_id = ? AND kind = 'credit'").get(f.pid).s, 50000);
  const after = invRow(f.db, f.inv.id);
  assert.deepEqual([after.total_amount, after.paid_amount, after.status], [120000, 120000, 'paid']);
  ledgerOk(f.db, f.inv.id);
});

// Доза по листу назначений: введена, выставлена, оплачена; отметку сняли
// (не вводили) — строка ждала счёта, лекарство списано с полки медсестры.
const DOSE_DAY = '2026-09-04';
function doseSeed() {
  const db = openDb(':memory:'); migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, full_name, role) VALUES (?,?,?,?,?)');
  u.run(1, 'doc', 'x', 'Лечащий', 'doctor'); u.run(2, 'nur', 'x', 'Медсестра', 'nurse'); u.run(5, 'snur', 'x', 'Старшая', 'nurse');
  u.run(6, 'reg', 'x', 'Регистратор', 'registrar'); u.run(9, 'boss', 'x', 'Админ', 'admin');
  db.prepare("INSERT INTO patients (id, full_name) VALUES (1, 'Пациент')").run();
  db.prepare("INSERT INTO wards (id, name, billing_mode, price_per_day) VALUES (1, 'Терапия', 'daily', 150000)").run();
  db.prepare("INSERT INTO beds (id, code, ward_id, status) VALUES (1, 'K-1', 1, 'occupied')").run();
  db.prepare("INSERT INTO services (id, name, price) VALUES (1, 'Инъекция', 20000)").run();
  db.prepare("INSERT INTO products (id, name, unit, category, sale_price, on_hand, active) VALUES (1, 'Цефтриаксон', 'шт', 'drug', 12000, 20, 1)").run();
  db.prepare("INSERT INTO stock_holdings (holder_type, holder_id, product_id, qty) VALUES ('staff', 2, 1, 20)").run();
  const adm = db.prepare("INSERT INTO admissions (patient_id, ward_id, bed_id, doctor_id, attending_doctor_id, status) VALUES (1, 1, 1, 1, 1, 'active')").run().lastInsertRowid;
  const order = treatmentOrderCreate(db, { admission_id: adm, kind: 'med', name: 'Цефтриаксон', dose: '1 шт', route: 'в/м', freq_code: '3x', starts_on: DOSE_DAY, days: 5, service_id: 1, stock_item_id: 1 }, { id: 1, role: 'doctor' }).order;
  const mark = treatmentAdminMark(db, { order_id: order.id, date: DOSE_DAY, slot: 6, status: 'given' }, { id: 2, role: 'nurse' });
  const lines = db.prepare('SELECT * FROM admission_services WHERE admission_id = ? ORDER BY id').all(adm);
  openCashShift(db, { opening_float: 0 }, { id: 9, role: 'admin' });
  const { invoice } = createInvoiceForAdmission(db, { admission_id: adm, admission_service_ids: lines.map((l) => l.id) }, { id: 6, role: 'registrar' });
  recordPayment(db, { invoice_id: invoice.id, amount: invoice.total_amount, method: 'cash' }, { id: 9, role: 'admin' });
  return { db, adm, mark, lines, invoice };
}
const shelf = (db) => (db.prepare("SELECT qty FROM stock_holdings WHERE holder_type = 'staff' AND holder_id = 2 AND product_id = 1").get() || { qty: 0 }).qty;

test('ревью B2: доза, отметку которой сняли, — возврат строки убирает её совсем, лекарство — обратно на полку', () => {
  const f = doseSeed();
  assert.equal(f.lines.length, 1, 'стенд не тот: у дозы одна строка');
  const [dose] = f.lines;
  assert.equal(dose.clinic_item_id, 1);
  const back = treatmentAdminUnmark(f.db, { administration_id: f.mark.administration.id, reason: 'не вводили' }, { id: 5, role: 'nurse', extra_roles: ['senior_nurse'] });
  assert.equal(back.reversal.kept, 1, 'строка в счёте — снятая отметка её не трогает');
  assert.equal(shelf(f.db), 19, 'лекарство пока списано');
  const r = refundInvoiceLine(f.db, { invoice_item_id: itemOf(f.db, dose.id) }, { id: 9, role: 'admin' });
  assert.equal(r.refunded, 12000);
  assert.equal(r.admission_line_released, true);
  assert.equal(line(f.db, dose.id), undefined, 'строки несостоявшейся дозы больше нет');
  assert.equal(shelf(f.db), 20, 'лекарство вернулось на полку медсестры');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM pay_refund_releases').get().n, 0, 'отметки об удалённой строке не осталось');
  assert.equal(r.voided, true, 'строк не осталось — пустой счёт закрыт');
  ledgerOk(f.db, f.invoice.id);
});

test('ревью B2: возвращённое проживание при выписке снова не выставляется', () => {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, role, full_name) VALUES (1,'adm','x','admin','Админ')").run();
  const pid = db.prepare("INSERT INTO patients (full_name) VALUES ('Пациент')").run().lastInsertRowid;
  db.prepare("INSERT INTO wards (id, name, billing_mode, price_per_day) VALUES (1, 'Терапия', 'daily', 100000)").run();
  db.prepare("INSERT INTO beds (id, code, ward_id, status) VALUES (1, 'K-1', 1, 'occupied')").run();
  const adm = db.prepare("INSERT INTO admissions (patient_id, ward_id, bed_id, status, admitted_at) VALUES (?, 1, 1, 'active', strftime('%Y-%m-%dT%H:%M:%SZ','now','-2 days','-1 hours'))").run(pid).lastInsertRowid;
  billAccommodation(db, { admission_id: adm }, admin);
  const stay = db.prepare('SELECT * FROM admission_services WHERE admission_id = ?').get(adm);
  assert.equal(stay.total, 200000, 'стенд не тот: двое суток');
  openCashShift(db, { opening_float: 0 }, admin);
  const { invoice } = createInvoiceForAdmission(db, { admission_id: adm, admission_service_ids: [stay.id] }, admin);
  recordPayment(db, { invoice_id: invoice.id, amount: invoice.total_amount, method: 'cash' }, admin);
  const r = refundInvoiceLine(db, { invoice_item_id: itemOf(db, stay.id) }, admin);
  assert.equal(r.refunded, 200000);
  const c = computeAccommodation(db, db.prepare('SELECT * FROM admissions WHERE id = ?').get(adm));
  assert.equal(c.units, 0, 'возвращённые сутки не «к начислению» снова');
  assert.equal(generateAdmissionBill(db, adm, admin), null, 'счёт выписки проживание снова не выставил');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM admission_services WHERE admission_id = ? AND invoice_item_id IS NOT NULL').get(adm).n, 0);
  ledgerOk(db, invoice.id);
});
