// BILLING_AUDIT_FIX_V1 — деньги кассы по результатам аудита 27.09 (UTC+5).
// Каждый тест идёт через настоящие RPC и настоящую SQLite после миграций.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import {
  createInvoiceForVisit, recordPayment, removeUnpaidService, changeUnpaidService,
} from './billing.js';
import { voidInvoice } from './cashier.js';

const registrar = { id: 7, role: 'registrar' };
const cashier = { id: 9, role: 'cashier', full_name: 'Кассир' };
const DOC = 20;

function seed() {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, role, full_name) VALUES (7,'reg','x','registrar','Регистратор')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, role, full_name) VALUES (9,'cash','x','cashier','Кассир')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, role, full_name, is_doctor) VALUES (?,'doc','x','doctor','Врач',1)").run(DOC);
  const pid = db.prepare("INSERT INTO patients (full_name) VALUES ('Пациент')").run().lastInsertRowid;
  const vid = db.prepare("INSERT INTO visits (patient_id, visit_date) VALUES (?, '2026-09-27T05:00:00Z')").run(pid).lastInsertRowid;
  return { db, pid, vid };
}
const addService = (db, name, price, extra = {}) => {
  const cols = ['name', 'price', ...Object.keys(extra)];
  return db.prepare(`INSERT INTO services (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(name, price, ...Object.values(extra)).lastInsertRowid;
};
const addLine = (db, vid, row) => {
  const r = { quantity: 1, unit_price: 0, total: 0, ...row, visit_id: vid };
  const cols = Object.keys(r);
  return db.prepare(`INSERT INTO visit_services (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(...Object.values(r)).lastInsertRowid;
};
const inv = (db, id) => db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);

// ─── B7 ─────────────────────────────────────────────────────────────────────
test('B7: консультация — имя и цена врача по виду приёма с сервера, а не из браузера', () => {
  const { db, vid } = seed();
  const ct = db.prepare("INSERT INTO consultation_types (name, name_ru, price) VALUES ('Consult', 'Первичный приём', 90000)").run().lastInsertRowid;
  db.prepare("INSERT INTO doctor_consultation_prices (doctor_id, consultation_type_id, price, available, is_free, name_ru) VALUES (?, ?, 120000, 1, 0, 'Приём кардиолога')").run(DOC, ct);
  // Браузер прислал 1 сум — счёт его не слушает.
  const vs = addLine(db, vid, { service_id: null, consultation_type_id: ct, doctor_id: DOC, unit_price: 1, total: 1 });
  const out = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs] }, registrar);
  assert.equal(out.invoice.total_amount, 120000);
  assert.equal(out.items[0].description, 'Приём кардиолога');
  assert.equal(out.items[0].unit_price, 120000);
  assert.equal(db.prepare('SELECT unit_price FROM visit_services WHERE id=?').get(vs).unit_price, 120000);
});

test('B7: врач без строки цены — цена вида приёма клиники; бесплатный у врача — ноль', () => {
  const { db, vid } = seed();
  const ct = db.prepare("INSERT INTO consultation_types (name, price) VALUES ('Повторный приём', 70000)").run().lastInsertRowid;
  const vs1 = addLine(db, vid, { service_id: null, consultation_type_id: ct, doctor_id: DOC, unit_price: 5 });
  const a = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs1] }, registrar);
  assert.equal(a.invoice.total_amount, 70000);
  assert.equal(a.items[0].description, 'Повторный приём');

  db.prepare('INSERT INTO doctor_consultation_prices (doctor_id, consultation_type_id, price, is_free) VALUES (?, ?, 50000, 1)').run(DOC, ct);
  const vs2 = addLine(db, vid, { service_id: null, consultation_type_id: ct, doctor_id: DOC, unit_price: 50000 });
  const b = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs2] }, registrar);
  assert.equal(b.invoice.total_amount, 0);
  assert.equal(b.invoice.status, 'paid');
});

// ─── B3 ─────────────────────────────────────────────────────────────────────
test('B3: замена услуги берёт личную цену врача строки, а не каталог', () => {
  const { db, vid } = seed();
  const a = addService(db, 'Анализ', 40000);
  const b = addService(db, 'Консультация', 100000);
  db.prepare('UPDATE users SET service_rates = ? WHERE id = ?').run(JSON.stringify([{ service_id: b, price: 150000 }]), DOC);
  const vs = addLine(db, vid, { service_id: a, doctor_id: DOC, unit_price: 40000, total: 40000 });
  const out = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs] }, registrar);
  const res = changeUnpaidService(db, { visit_service_id: vs, new_service_id: b }, registrar);
  assert.equal(res.line.unit_price, 150000);
  assert.equal(res.invoice.total_amount, 150000);
  assert.equal(db.prepare('SELECT unit_price FROM invoice_items WHERE invoice_id=?').get(out.invoice.id).unit_price, 150000);
});

test('B3: тариф строки спрашивается заново — «второй визит» старой услуги не переезжает на новую', () => {
  const { db, pid, vid } = seed();
  const old = addService(db, 'Приём невролога', 200000, { price_secondary: 60000, secondary_days_from: 1, secondary_days_to: 30 });
  const fresh = addService(db, 'Приём кардиолога', 180000, { price_secondary: 50000, secondary_days_from: 1, secondary_days_to: 30 });
  const vs = addLine(db, vid, { service_id: old, unit_price: 60000, total: 60000, price_tier: 'secondary' });
  createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs] }, registrar);
  const res = changeUnpaidService(db, { visit_service_id: vs, new_service_id: fresh }, registrar);
  assert.equal(res.line.price_tier, 'primary', 'кардиолога пациент ещё не посещал');
  assert.equal(res.invoice.total_amount, 180000);

  // А если кардиолог был 3 дня назад — тариф второго визита.
  const past = db.prepare("INSERT INTO visits (patient_id, visit_date, status) VALUES (?, '2026-09-24T05:00:00Z', 'arrived')").run(pid).lastInsertRowid;
  addLine(db, past, { service_id: fresh, unit_price: 180000, total: 180000, status: 'completed' });
  const back = changeUnpaidService(db, { visit_service_id: vs, new_service_id: old }, registrar);
  assert.equal(back.line.price_tier, 'primary');
  const again = changeUnpaidService(db, { visit_service_id: vs, new_service_id: fresh }, registrar);
  assert.equal(again.line.price_tier, 'secondary');
  assert.equal(again.invoice.total_amount, 50000);
});

// ─── B4 ─────────────────────────────────────────────────────────────────────
test('B4: счёт, ставший нулевым после замены, оплачен, и строки в очереди', () => {
  const { db, vid } = seed();
  const paid = addService(db, 'Платная', 30000);
  const free = addService(db, 'Бесплатная', 0);
  const vs = addLine(db, vid, { service_id: paid, unit_price: 30000, total: 30000, status: 'added' });
  const out = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs] }, registrar);
  assert.equal(out.invoice.status, 'unpaid');
  const res = changeUnpaidService(db, { visit_service_id: vs, new_service_id: free }, registrar);
  assert.equal(res.invoice.total_amount, 0);
  assert.equal(res.invoice.status, 'paid');
  assert.ok(res.invoice.paid_at);
  assert.equal(db.prepare('SELECT status FROM visit_services WHERE id=?').get(vs).status, 'queued');
});

test('B4: удаление платной строки оставляет бесплатную — счёт оплачен, не висит «Не оплачен»', () => {
  const { db, vid } = seed();
  const paid = addService(db, 'Платная', 30000);
  const free = addService(db, 'Бесплатная', 0);
  const vs1 = addLine(db, vid, { service_id: paid, unit_price: 30000, total: 30000 });
  const vs2 = addLine(db, vid, { service_id: free, unit_price: 0, total: 0 });
  createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs1, vs2] }, registrar);
  const res = removeUnpaidService(db, { visit_service_id: vs1 }, registrar);
  assert.equal(res.invoice.total_amount, 0);
  assert.equal(res.invoice.status, 'paid');
  assert.equal(db.prepare('SELECT status FROM visit_services WHERE id=?').get(vs2).status, 'queued');
});

// ─── B5 ─────────────────────────────────────────────────────────────────────
test('B5: счёт страховой не получает скидку группы пациента; счёт пациенту — получает', () => {
  const { db, pid, vid } = seed();
  const cat = db.prepare("INSERT INTO patient_categories (name, discount_percent, active) VALUES ('VIP', 10, 1)").run().lastInsertRowid;
  db.prepare('UPDATE patients SET category_id = ? WHERE id = ?').run(cat, pid);
  const payer = db.prepare("INSERT INTO payers (name, kind, active) VALUES ('Страховая', 'insurance', 1)").run().lastInsertRowid;
  const s = addService(db, 'УЗИ', 100000);
  const vs1 = addLine(db, vid, { service_id: s, unit_price: 100000, total: 100000 });
  const vs2 = addLine(db, vid, { service_id: s, unit_price: 100000, total: 100000 });
  const ins = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs1], payer_id: payer }, registrar);
  assert.equal(ins.invoice.discount_amount, 0);
  assert.equal(ins.invoice.total_amount, 100000);
  const own = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs2] }, registrar);
  assert.equal(own.invoice.total_amount, 90000);
  // Пересчёт счёта страховой тоже без пола группы.
  const other = addService(db, 'Рентген', 50000);
  const r = changeUnpaidService(db, { visit_service_id: vs1, new_service_id: other }, registrar);
  assert.equal(r.invoice.total_amount, 50000);
});

// ─── B-minor ────────────────────────────────────────────────────────────────
test('B-minor: из бесплатного автооплаченного счёта строку можно убрать и заменить; отказ — по-русски', () => {
  const { db, vid } = seed();
  const free = addService(db, 'Бесплатная', 0);
  const paid = addService(db, 'Платная', 25000);
  const vs1 = addLine(db, vid, { service_id: free });
  const vs2 = addLine(db, vid, { service_id: free });
  const out = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs1, vs2] }, registrar);
  assert.equal(out.invoice.status, 'paid');
  const rm = removeUnpaidService(db, { visit_service_id: vs1 }, registrar);
  assert.equal(rm.removed, true);
  assert.equal(rm.invoice.status, 'paid');
  // Замена на платную делает счёт снова неоплаченным — денег на нём нет.
  const ch = changeUnpaidService(db, { visit_service_id: vs2, new_service_id: paid }, registrar);
  assert.equal(ch.invoice.total_amount, 25000);
  assert.equal(ch.invoice.status, 'unpaid');
  assert.equal(ch.invoice.paid_at, null);
  // Оплаченный деньгами — отказ русскими словами, без кода статуса.
  recordPayment(db, { invoice_id: out.invoice.id, amount: 25000, method: 'cash' }, cashier);
  assert.throws(() => removeUnpaidService(db, { visit_service_id: vs2 }, registrar),
    (e) => /счёт уже оплачен/.test(e.message) && !/paid/.test(e.message));
});

test('B-minor: бесплатный автооплаченный счёт можно отменить в кассе', () => {
  const { db, vid } = seed();
  const free = addService(db, 'Бесплатная', 0);
  const vs = addLine(db, vid, { service_id: free });
  const out = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs] }, registrar);
  const v = voidInvoice(db, { invoice_id: out.invoice.id }, cashier);
  assert.equal(v.invoice.status, 'void');
  assert.equal(inv(db, out.invoice.id).status, 'void');
});
