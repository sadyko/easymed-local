// INPATIENT_MONEY_FIX_V1 — деньги стационара: акт, остаток, счёт и долг
// говорят ОДНО число.
//
// Аудит (2026-09-27) нашёл, что пациент платит не то, что написано в акте:
//   D1 товар из подотчёта — акт 20 000, счёт 400 000 (цена коробки × таблетки);
//      операция с личной ценой врача — акт 500 000, счёт 700 000;
//      проживание со скидкой 10% — акт 270 000, счёт 300 000, строка без имени;
//   D2 отмена счёта за койку, пока пациент лежит, — сутки выставляются дважды;
//   D3 перевод на дорогую койку переоценивает весь срок;
//   D4 проживание считается у заявки без койки, у отменённой и после выписки;
//   D5 отмена лежащего пациента оставляет невыставленные строки; услуги
//      начисляются заявке без койки; операцию ставит кто угодно;
//   C4 медсестра выдаёт, но не может отменить свою выдачу;
//   D-minor charge_amount брал ОДНУ строку проживания из нескольких.
//
// Правило исправления одно: строка оценивается ОДИН раз, когда её заводят, и
// счёт берёт сохранённую цену у товара и у проживания. Тесты проверяют
// равенство акт = остаток = счёт на живых обработчиках и настоящей SQLite.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { admitPatient, admissionBalance, setAdmissionDiscount, transferAdmission, admissionOrderCancel, dischargePatient } from './inpatient.js';
import { billAccommodation, accommodationState } from './accommodation.js';
import { dispenseFromHolding } from './holdings.js';
import { dispenseAdmissionItem, voidDispensedAdmissionItem, dispenseItem, voidDispense } from './inventory.js';
import { createInvoiceForAdmission, createInvoiceForVisit } from './billing.js';
import { voidInvoice } from './cashier.js';
import { admissionCharges, admissionServiceAdd } from './admission-charges.js';

const ADMIN = { id: 1, role: 'admin', full_name: 'Админ' };
const NURSE = { id: 2, role: 'nurse', full_name: 'Медсестра' };
const DOC   = { id: 3, role: 'doctor', full_name: 'Др. Азиза' };
const DOC2  = { id: 4, role: 'doctor', full_name: 'Др. Чужой' };
const CASH  = { id: 9, role: 'cashier', full_name: 'Касса' };
const REG   = { id: 8, role: 'registrar', full_name: 'Регистратура' };

function seed({ rate = 100000, daysAgo = 3 } = {}) {
  const db = openDb(':memory:'); migrate(db);
  const u = db.prepare('INSERT INTO users (id,username,password_hash,role,full_name,service_rates) VALUES (?,?,?,?,?,?)');
  u.run(1, 'a', 'x', 'admin', 'Админ', '[]');
  u.run(2, 'n', 'x', 'nurse', 'Медсестра', '[]');
  u.run(4, 'd2', 'x', 'doctor', 'Др. Чужой', '[]');
  u.run(8, 'r', 'x', 'registrar', 'Регистратура', '[]');
  u.run(9, 'c', 'x', 'cashier', 'Касса', '[]');
  const pid = db.prepare("INSERT INTO patients (full_name) VALUES ('Пациент')").run().lastInsertRowid;
  const wid = db.prepare("INSERT INTO wards (name, billing_mode, price_per_day) VALUES ('Палата 1','daily',?)").run(rate).lastInsertRowid;
  const bed = db.prepare("INSERT INTO beds (ward_id, code, status, price_per_day) VALUES (?,'B-1','free',0)").run(wid).lastInsertRowid;
  // Операция: каталог 500 000, у врача своя цена 700 000.
  const surgery = db.prepare("INSERT INTO services (name, price, type) VALUES ('Операция', 500000, 'other')").run().lastInsertRowid;
  const dressing = db.prepare("INSERT INTO services (name, price, type) VALUES ('Перевязка', 50000, 'procedure')").run().lastInsertRowid;
  u.run(3, 'd', 'x', 'doctor', 'Др. Азиза', JSON.stringify([{ service_id: surgery, price: 700000, pct: 10 }]));
  // Коробка 40 000, в коробке 20 таблеток.
  const tabs = db.prepare(`INSERT INTO products (name, unit, base_unit, consumption_unit, consumption_factor, sale_price, on_hand, avg_cost)
                           VALUES ('Цефтриаксон', 'box', 'box', 'таб', 20, 40000, 10, 20000)`).run().lastInsertRowid;
  // Подотчёт медсестры: 2 коробки = 40 таблеток.
  db.prepare("INSERT INTO stock_holdings (holder_type, holder_id, product_id, qty) VALUES ('staff', 2, ?, 2)").run(tabs);
  // Старый путь поступления — только по заявке «до обновления» (см. accommodation.daily.test.js).
  db.prepare("INSERT INTO admissions (patient_id, doctor_id, status, created_at) VALUES (?,3,'ordered','2000-01-01T00:00:00Z')").run(pid);
  const adm = admitPatient(db, { patient_id: pid, bed_id: bed, doctor_id: 3 }, NURSE).admission;
  setAdmittedDaysAgo(db, adm.id, daysAgo);
  return { db, adm: db.prepare('SELECT * FROM admissions WHERE id = ?').get(adm.id), pid, wid, bed, surgery, dressing, tabs };
}
function setAdmittedDaysAgo(db, id, days) {
  db.prepare("UPDATE admissions SET admitted_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?) WHERE id = ?").run('-' + days + ' days', id);
  db.prepare("UPDATE admission_transfers SET transferred_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?) WHERE admission_id = ? AND kind = 'admit'")
    .run('-' + days + ' days', id);
}
const lines = (db, id) => db.prepare('SELECT * FROM admission_services WHERE admission_id = ? ORDER BY id').all(id);
const openStay = (db, id) => db.prepare("SELECT * FROM admission_services WHERE admission_id = ? AND notes LIKE 'ACCOMMODATION%' AND invoice_item_id IS NULL").all(id);
const allIds = (db, id) => db.prepare('SELECT id FROM admission_services WHERE admission_id = ? AND invoice_item_id IS NULL AND billable = 1 ORDER BY id').all(id).map((r) => r.id);

// ─── D1 ──────────────────────────────────────────────────────────────────────

test('D1a: таблетки из подотчёта — счёт берёт цену строки (2 000 за таблетку), а не коробки', () => {
  const { db, adm, tabs } = seed();
  try {
    const out = dispenseFromHolding(db, { holder: { type: 'staff', id: 2 }, product_id: tabs, quantity: 10, admission_id: adm.id }, NURSE);
    assert.equal(out.total, 20000);
    const act = admissionCharges(db, { admission_id: adm.id }, CASH);
    assert.equal(act.totals.pending, 20000);
    const inv = createInvoiceForAdmission(db, { admission_id: adm.id, admission_service_ids: [out.line_id] }, CASH);
    assert.equal(inv.invoice.total_amount, 20000, 'было 400 000: цена коробки × число таблеток');
    assert.equal(inv.items[0].unit_price, 2000);
    assert.equal(inv.items[0].quantity, 10);
  } finally { db.close(); }
});

test('D1a: со склада коробками — цена коробки, как и прежде', () => {
  const { db, adm, tabs } = seed();
  try {
    const out = dispenseAdmissionItem(db, { admission_id: adm.id, product_id: tabs, quantity: 1, billable: true }, NURSE);
    const inv = createInvoiceForAdmission(db, { admission_id: adm.id, admission_service_ids: [out.line_id] }, CASH);
    assert.equal(inv.invoice.total_amount, 40000);
  } finally { db.close(); }
});

test('D1a амбулаторно: выдача из подотчёта на визит — счёт визита 20 000, а не 400 000', () => {
  const { db, pid, tabs } = seed();
  try {
    const visit = db.prepare("INSERT INTO visits (patient_id, visit_date, status) VALUES (?, strftime('%Y-%m-%dT%H:%M:%SZ','now'), 'arrived')").run(pid).lastInsertRowid;
    const out = dispenseFromHolding(db, { holder: { type: 'staff', id: 2 }, product_id: tabs, quantity: 10, visit_id: visit }, NURSE);
    const inv = createInvoiceForVisit(db, { visit_id: visit, visit_service_ids: [out.line_id] }, REG);
    assert.equal(inv.invoice.total_amount, 20000);
  } finally { db.close(); }
});

test('D1b: услуга оценивается при заведении по личной цене врача — акт = счёт = 700 000', () => {
  const { db, adm, surgery } = seed();
  try {
    const { line } = admissionServiceAdd(db, { admission_id: adm.id, service_id: surgery, doctor_id: 3 }, DOC);
    assert.equal(line.unit_price, 700000, 'в акте была цена каталога 500 000');
    assert.equal(line.total, 700000);
    const inv = createInvoiceForAdmission(db, { admission_id: adm.id, admission_service_ids: [line.id] }, CASH);
    assert.equal(inv.invoice.total_amount, 700000);
  } finally { db.close(); }
});

test('D1c: проживание со скидкой — счёт = нетто строки (270 000), описание — метка проживания', () => {
  const { db, adm } = seed({ daysAgo: 3 });
  try {
    setAdmissionDiscount(db, { admission_id: adm.id, percent: 10 }, CASH);
    const { line } = billAccommodation(db, { admission_id: adm.id }, NURSE);
    assert.equal(line.total, 270000);
    const inv = createInvoiceForAdmission(db, { admission_id: adm.id, admission_service_ids: [line.id] }, CASH);
    assert.equal(inv.invoice.total_amount, 270000, 'было 300 000 — скидка терялась');
    assert.equal(inv.items[0].description, 'Проживание в палате', 'строка счёта не пустая');
    assert.equal(inv.items[0].total, 270000);
  } finally { db.close(); }
});

test('D1: акт = остаток к выписке = счёт — на всех трёх родах строк сразу', () => {
  const { db, adm, tabs, surgery } = seed({ daysAgo: 3 });
  try {
    setAdmissionDiscount(db, { admission_id: adm.id, percent: 10 }, CASH);
    billAccommodation(db, { admission_id: adm.id }, NURSE);
    admissionServiceAdd(db, { admission_id: adm.id, service_id: surgery, doctor_id: 3 }, DOC);
    dispenseFromHolding(db, { holder: { type: 'staff', id: 2 }, product_id: tabs, quantity: 10, admission_id: adm.id }, NURSE);

    const act = admissionCharges(db, { admission_id: adm.id }, CASH).totals.pending;
    const bal = admissionBalance(db, adm.id).balance;
    const inv = createInvoiceForAdmission(db, { admission_id: adm.id, admission_service_ids: allIds(db, adm.id) }, CASH).invoice.total_amount;
    assert.equal(act, 270000 + 700000 + 20000);
    assert.equal(bal, act, 'остаток к выписке');
    assert.equal(inv, act, 'счёт');
    assert.equal(admissionBalance(db, adm.id).balance, act, 'после счёта долг тот же');
  } finally { db.close(); }
});

// ─── D2 ──────────────────────────────────────────────────────────────────────

test('D2: отмена счёта за сутки, пока пациент лежит, — за 3 суток 300 000, а не 400 000', () => {
  const { db, adm } = seed({ daysAgo: 1 });
  try {
    const first = billAccommodation(db, { admission_id: adm.id }, NURSE).line;
    const inv = createInvoiceForAdmission(db, { admission_id: adm.id, admission_service_ids: [first.id] }, CASH).invoice;
    voidInvoice(db, { invoice_id: inv.id, in_bed_ack: true }, CASH);
    setAdmittedDaysAgo(db, adm.id, 3);
    billAccommodation(db, { admission_id: adm.id }, NURSE);
    const open = openStay(db, adm.id);
    assert.equal(open.length, 1, 'открытые строки проживания сливаются в одну');
    assert.equal(open[0].quantity, 3);
    assert.equal(open[0].total, 300000);
    assert.equal(admissionBalance(db, adm.id).balance, 300000);
  } finally { db.close(); }
});

// ─── D3 ──────────────────────────────────────────────────────────────────────

test('D3: перевод на дорогую койку — старые сутки по старой ставке (2×100 000 + 1×300 000)', () => {
  const { db, adm } = seed({ daysAgo: 3 });
  try {
    const w2 = db.prepare("INSERT INTO wards (name, billing_mode, price_per_day) VALUES ('VIP','daily',300000)").run().lastInsertRowid;
    const b2 = db.prepare("INSERT INTO beds (ward_id, code, status, price_per_day) VALUES (?,'V-1','free',0)").run(w2).lastInsertRowid;
    transferAdmission(db, { admission_id: adm.id, to_bed_id: b2 }, NURSE);
    db.prepare("UPDATE admission_transfers SET transferred_at = strftime('%Y-%m-%dT%H:%M:%SZ','now','-1 days') WHERE admission_id = ? AND kind = 'transfer'").run(adm.id);
    const { line } = billAccommodation(db, { admission_id: adm.id }, NURSE);
    assert.equal(line.quantity, 3);
    assert.equal(line.total, 500000, 'было 900 000 — весь срок по новой ставке');
    assert.equal(accommodationState(db, { admission_id: adm.id }, NURSE).current.net, 500000);
  } finally { db.close(); }
});

// ─── D4 ──────────────────────────────────────────────────────────────────────

test('D4: заявка без койки и отменённая — проживание не начисляется', () => {
  const { db, pid, wid } = seed();
  try {
    const ordered = db.prepare("INSERT INTO admissions (patient_id, ward_id, status) VALUES (?,?,'ordered')").run(pid, wid).lastInsertRowid;
    db.prepare("UPDATE admissions SET admitted_at = strftime('%Y-%m-%dT%H:%M:%SZ','now','-2 days') WHERE id = ?").run(ordered);
    assert.throws(() => billAccommodation(db, { admission_id: ordered }, NURSE), /не на койке|не размещ/);
    assert.equal(accommodationState(db, { admission_id: ordered }, NURSE).current.units, 0);
    db.prepare("UPDATE admissions SET status = 'cancelled' WHERE id = ?").run(ordered);
    assert.throws(() => billAccommodation(db, { admission_id: ordered }, NURSE), /отмен/);
    assert.equal(lines(db, ordered).length, 0);
  } finally { db.close(); }
});

test('D4: после выписки срок кончается датой выписки, а не «сейчас»', () => {
  const { db, adm } = seed({ daysAgo: 5 });
  try {
    db.prepare("UPDATE admissions SET status = 'discharged', discharged_at = strftime('%Y-%m-%dT%H:%M:%SZ','now','-2 days') WHERE id = ?").run(adm.id);
    const { line } = billAccommodation(db, { admission_id: adm.id }, CASH);
    assert.equal(line.quantity, 3);
    assert.equal(line.total, 300000);
  } finally { db.close(); }
});

// ─── D5 ──────────────────────────────────────────────────────────────────────

test('D5: отмена размещённого пациента убирает невыставленные строки', () => {
  const { db, pid, wid, bed, dressing } = seed();
  try {
    // Первый пациент занимает койку seed — даём этому свою.
    const bed2 = db.prepare("INSERT INTO beds (ward_id, code, status, price_per_day) VALUES (?,'B-2','occupied',0)").run(wid).lastInsertRowid;
    const pid2 = db.prepare("INSERT INTO patients (full_name) VALUES ('Второй')").run().lastInsertRowid;
    const id = db.prepare(`INSERT INTO admissions (patient_id, bed_id, ward_id, status, admitted_at, attending_doctor_id)
                           VALUES (?,?,?,'admitted', strftime('%Y-%m-%dT%H:%M:%SZ','now','-1 days'), 3)`).run(pid2, bed2, wid).lastInsertRowid;
    void pid; void bed;
    admissionServiceAdd(db, { admission_id: id, service_id: dressing }, DOC);
    billAccommodation(db, { admission_id: id }, NURSE);
    assert.equal(lines(db, id).length, 2);
    admissionOrderCancel(db, { admission_id: id, reason: 'передумали' }, ADMIN);
    assert.equal(lines(db, id).length, 0, 'осталось 150 000 невыставленных строк');
    assert.equal(admissionBalance(db, id).balance, 0);
  } finally { db.close(); }
});

test('D5: услугу не начисляют заявке без койки и отменённой', () => {
  const { db, pid, wid, dressing } = seed();
  try {
    const pid2 = db.prepare("INSERT INTO patients (full_name) VALUES ('Второй')").run().lastInsertRowid;
    const ordered = db.prepare("INSERT INTO admissions (patient_id, ward_id, status) VALUES (?,?,'ordered')").run(pid2, wid).lastInsertRowid;
    void pid;
    assert.throws(() => admissionServiceAdd(db, { admission_id: ordered, service_id: dressing }, DOC), /койк/);
    db.prepare("UPDATE admissions SET status = 'cancelled' WHERE id = ?").run(ordered);
    assert.throws(() => admissionServiceAdd(db, { admission_id: ordered, service_id: dressing }, DOC), /закрыта|отмен/);
    assert.equal(lines(db, ordered).length, 0);
  } finally { db.close(); }
});

test('D5: операцию ставят лечащий врач, главный врач или администратор — не чужой врач', () => {
  const { db, adm, surgery, dressing } = seed();
  try {
    assert.throws(() => admissionServiceAdd(db, { admission_id: adm.id, service_id: surgery }, DOC2), (e) => e.status === 403);
    // Обычную услугу чужой врач по-прежнему ставит.
    admissionServiceAdd(db, { admission_id: adm.id, service_id: dressing }, DOC2);
    admissionServiceAdd(db, { admission_id: adm.id, service_id: surgery }, DOC);
    admissionServiceAdd(db, { admission_id: adm.id, service_id: surgery, doctor_id: 3 }, ADMIN);
    assert.equal(lines(db, adm.id).length, 3);
  } finally { db.close(); }
});

// ─── C4 ──────────────────────────────────────────────────────────────────────

test('C4: медсестра отменяет свою невыставленную выдачу — у койки и в амбулатории', () => {
  const { db, adm, pid, tabs } = seed();
  try {
    const out = dispenseAdmissionItem(db, { admission_id: adm.id, product_id: tabs, quantity: 1, billable: true }, NURSE);
    voidDispensedAdmissionItem(db, { line_id: out.line_id }, NURSE);
    assert.equal(lines(db, adm.id).length, 0);
    const visit = db.prepare("INSERT INTO visits (patient_id, visit_date, status) VALUES (?, strftime('%Y-%m-%dT%H:%M:%SZ','now'), 'arrived')").run(pid).lastInsertRowid;
    const v = dispenseItem(db, { product_id: tabs, quantity: 1, visit_id: visit }, NURSE);
    voidDispense(db, { visit_service_id: v.visit_service_id }, NURSE);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM visit_services WHERE visit_id = ?').get(visit).n, 0);
  } finally { db.close(); }
});

// ─── D-minor ─────────────────────────────────────────────────────────────────

test('D-minor: charge_amount при выписке — сумма ВСЕХ строк проживания, а не первой', () => {
  const { db, adm } = seed({ daysAgo: 1 });
  try {
    const first = billAccommodation(db, { admission_id: adm.id }, NURSE).line;
    createInvoiceForAdmission(db, { admission_id: adm.id, admission_service_ids: [first.id] }, CASH);
    setAdmittedDaysAgo(db, adm.id, 3);
    billAccommodation(db, { admission_id: adm.id }, NURSE);
    const out = dischargePatient(db, { admission_id: adm.id }, ADMIN);
    assert.equal(out.admission.charge_amount, 300000);
  } finally { db.close(); }
});

// ─── D6 ──────────────────────────────────────────────────────────────────────

test('D6: дата поступления без зоны — местное время, а не UTC', async () => {
  const { setAdmissionDate } = await import('./admission-date.js');
  const { db, adm } = seed();
  try {
    const d = new Date(Date.now() - 2 * 86400000);
    d.setSeconds(0, 0);
    const pad = (n) => String(n).padStart(2, '0');
    const local = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const out = setAdmissionDate(db, { admission_id: adm.id, admitted_at: local }, NURSE);
    assert.equal(out.admission.admitted_at, d.toISOString().slice(0, 19) + 'Z');
  } finally { db.close(); }
});

// BILLING_AUDIT_FIX_V1 — единица в акте — та, в которой записано количество:
// со склада — коробки, из подотчёта — таблетки.
test('акт: товар со склада подписан коробкой, из подотчёта — таблеткой', () => {
  const { db, adm, tabs } = seed();
  try {
    const box = dispenseAdmissionItem(db, { admission_id: adm.id, product_id: tabs, quantity: 1, billable: true }, NURSE);
    const pill = dispenseFromHolding(db, { holder: { type: 'staff', id: 2 }, product_id: tabs, quantity: 10, admission_id: adm.id }, NURSE);
    const act = admissionCharges(db, { admission_id: adm.id }, CASH);
    const byId = new Map(act.lines.map((l) => [l.id, l]));
    assert.equal(byId.get(box.line_id).unit, 'box', 'было «таб»: 1 таб × 40 000');
    assert.equal(byId.get(box.line_id).quantity, 1);
    assert.equal(byId.get(pill.line_id).unit, 'таб');
    assert.equal(byId.get(pill.line_id).quantity, 10);
    // Старая строка без движений склада — по цене: цена коробки → коробка.
    db.prepare("DELETE FROM stock_movements WHERE reference_type = 'admission'").run();
    const again = new Map(admissionCharges(db, { admission_id: adm.id }, CASH).lines.map((l) => [l.id, l]));
    assert.equal(again.get(box.line_id).unit, 'box');
    assert.equal(again.get(pill.line_id).unit, 'таб');
  } finally { db.close(); }
});
