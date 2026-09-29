// REFERRAL_BILL_V1 (2026-09-29) — СЧЁТ ПО НАПРАВЛЕНИЮ ВЫСТАВЛЯЕТ САМ ВРАЧ.
//
// Владелец: «While we are seeing the patient as a doctor and refer to another
// service or a doctor we cannot see them in the cashier's window. Which means
// flow is broken.» Решение 29.09: направление врача сразу выставляет
// неоплаченный счёт — касса видит его как обычный. Прежнее правило
// INVOICE_ROLE_HONEST_V1 (16.09: «врач счёта не выставляет») этим отменено.
//
// Ограничения врача без денежной роли (ни администратора, ни регистратуры, ни
// кассы): ручной скидки не даёт, плательщику (страховой, организации) счёт не
// выставляет. Автоматические скидки (группа, пакет, тариф визита) сервер
// считает сам — как у всех. Принимает деньги по-прежнему касса.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { createInvoiceForVisit, createInvoiceForAdmission, removeAdmissionLineFromInvoice, recordPayment } from './billing.js';
import { RPC } from './index.js';

const DOC = 20;
const doctor = { id: DOC, role: 'doctor', full_name: 'Врач' };
const headDoctor = { id: 21, role: 'doctor', extra_roles: ['head_doctor'], full_name: 'Главный врач' };
const doctorCashier = { id: 22, role: 'doctor', extra_roles: ['cashier'], full_name: 'Врач с кассой' };
const adminDoctor = { id: 23, role: 'admin', is_doctor: 1, full_name: 'Администратор-врач' };
const admin = { id: 1, role: 'admin', full_name: 'Админ' };
const registrar = { id: 7, role: 'registrar', full_name: 'Регистратура' };
const cashier = { id: 9, role: 'cashier', full_name: 'Кассир' };
const nurse = { id: 30, role: 'nurse', full_name: 'Медсестра' };
const lab = { id: 31, role: 'lab', full_name: 'Лаборант' };
const callcenter = { id: 32, role: 'callcenter', full_name: 'Оператор' };

function seed() {
  const db = openDb(':memory:'); migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, role, full_name, is_doctor, extra_roles) VALUES (?,?,?,?,?,?,?)');
  u.run(1, 'adm', 'x', 'admin', 'Админ', 0, '[]');
  u.run(7, 'reg', 'x', 'registrar', 'Регистратура', 0, '[]');
  u.run(9, 'cash', 'x', 'cashier', 'Кассир', 0, '[]');
  u.run(DOC, 'doc', 'x', 'doctor', 'Врач', 1, '[]');
  u.run(21, 'head', 'x', 'doctor', 'Главный врач', 1, '["head_doctor"]');
  u.run(22, 'doccash', 'x', 'doctor', 'Врач с кассой', 1, '["cashier"]');
  u.run(23, 'admdoc', 'x', 'admin', 'Администратор-врач', 1, '[]');
  u.run(30, 'nurse', 'x', 'nurse', 'Медсестра', 0, '[]');
  u.run(31, 'lab', 'x', 'lab', 'Лаборант', 0, '[]');
  u.run(32, 'cc', 'x', 'callcenter', 'Оператор', 0, '[]');
  const CONS = Number(db.prepare("INSERT INTO services (name, price) VALUES ('Приём терапевта', 100000)").run().lastInsertRowid);
  const LAB = Number(db.prepare("INSERT INTO services (name, price, is_lab) VALUES ('Анализ крови', 40000, 1)").run().lastInsertRowid);
  // У врача своя цена приёма — счёт берёт её, как у кассы (DOCTOR_OWN_PRICE_V1).
  db.prepare('UPDATE users SET service_rates = ? WHERE id = ?').run(JSON.stringify([{ service_id: CONS, price: 150000, pct: 10 }]), DOC);
  const pid = Number(db.prepare("INSERT INTO patients (full_name) VALUES ('Пациент')").run().lastInsertRowid);
  const payer = Number(db.prepare("INSERT INTO payers (name, kind, active) VALUES ('Страховая', 'insurance', 1)").run().lastInsertRowid);
  return { db, CONS, LAB, pid, payer };
}

/**
 * Визит врача с направленными строками — цена в строке «от браузера» (1 сум).
 * День визита — сейчас: «Ждут счёта» (cashier_unbilled) смотрит 30 дней назад.
 * REFBILL_REVIEW_V1 (ревью M4) — `by`: кто завёл строки. Врач без денежной
 * роли выставляет только СВОИ строки (created_by).
 */
function referral(db, pid, lines, by = DOC) {
  const vid = Number(db.prepare("INSERT INTO visits (patient_id, visit_date, created_by) VALUES (?, strftime('%Y-%m-%dT%H:%M:%SZ','now'), ?)").run(pid, by).lastInsertRowid);
  const ids = lines.map(({ service_id, doctor_id = null }) => Number(db.prepare(
    "INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, created_by) VALUES (?, ?, ?, 1, 1, 1, 'added', ?)",
  ).run(vid, service_id, doctor_id, by).lastInsertRowid));
  return { vid, ids };
}
const countInvoices = (db) => db.prepare('SELECT COUNT(*) n FROM invoices').get().n;
const refused = (fn, re, status = 403) => assert.throws(fn, (e) => e.status === status && re.test(e.message), 'ожидался отказ ' + status + ' ' + re);

test('врач выставляет счёт по строкам визита: неоплаченный, по ценам сервера (каталог и личная цена врача)', () => {
  const { db, CONS, LAB, pid } = seed();
  const { vid, ids } = referral(db, pid, [{ service_id: CONS, doctor_id: DOC }, { service_id: LAB }]);
  const out = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: ids, discount_amount: 0, payer_id: null }, doctor);
  assert.equal(out.invoice.status, 'unpaid');
  assert.equal(out.invoice.paid_amount, 0);
  assert.equal(out.invoice.payer_id, null);
  assert.equal(out.invoice.created_by, DOC);
  assert.equal(out.invoice.subtotal, 190000, 'приём по личной цене врача 150 000 + анализ по каталогу 40 000 — не присланные 1 + 1');
  assert.equal(out.invoice.total_amount, 190000);
  assert.deepEqual(out.items.map((i) => [i.description, i.total]), [['Приём терапевта', 150000], ['Анализ крови', 40000]]);
  const linked = db.prepare('SELECT COUNT(*) n FROM visit_services WHERE visit_id = ? AND invoice_item_id IS NOT NULL').get(vid).n;
  assert.equal(linked, 2, 'строки визита привязаны к счёту');
  // Без discount_amount и payer_id вовсе — тоже можно.
  const second = referral(db, pid, [{ service_id: LAB }]);
  assert.equal(createInvoiceForVisit(db, { visit_id: second.vid, visit_service_ids: second.ids }, doctor).invoice.total_amount, 40000);
  // Через карту RPC — та же дверь.
  const third = referral(db, pid, [{ service_id: LAB }]);
  assert.equal(RPC.create_invoice_for_visit(db, { visit_id: third.vid, visit_service_ids: third.ids }, doctor).invoice.status, 'unpaid');
});

test('врач с ручной скидкой — 403 с понятным текстом, и не записано ничего', () => {
  const { db, LAB, pid } = seed();
  const { vid, ids } = referral(db, pid, [{ service_id: LAB }]);
  const seq = () => JSON.stringify(db.prepare('SELECT year, next_seq FROM invoice_counters ORDER BY year').all());
  const before = seq();
  refused(() => createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: ids, discount_amount: 5000 }, doctor),
    /^Скидку в счёт ставят касса, регистратура или администратор\.$/);
  refused(() => createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: ids, discount_amount: 0.5 }, headDoctor),
    /Скидку в счёт ставят касса, регистратура или администратор/);
  assert.equal(countInvoices(db), 0, 'отказ не оставил счёта');
  assert.equal(db.prepare('SELECT invoice_item_id FROM visit_services WHERE id = ?').get(ids[0]).invoice_item_id, null);
  assert.equal(seq(), before, 'номер счёта не израсходован');
});

test('врач со счётом плательщику — 403 с понятным текстом', () => {
  const { db, LAB, pid, payer } = seed();
  const { vid, ids } = referral(db, pid, [{ service_id: LAB }]);
  refused(() => createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: ids, discount_amount: 0, payer_id: payer }, doctor),
    /^Счёт организации или страховой выставляют касса, регистратура или администратор\.$/);
  refused(() => createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: ids, payer_id: payer }, headDoctor),
    /Счёт организации или страховой выставляют касса, регистратура или администратор/);
  assert.equal(countInvoices(db), 0);
});

test('главный врач (надстройка над врачом) — как врач: счёт можно, скидку и плательщика нельзя', () => {
  const { db, LAB, pid, payer } = seed();
  // REFBILL_REVIEW_V1 (ревью M4) — строки главного врача заводит он сам.
  const { vid, ids } = referral(db, pid, [{ service_id: LAB }], headDoctor.id);
  assert.equal(createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: ids, discount_amount: 0, payer_id: null }, headDoctor).invoice.total_amount, 40000);
  // Право даёт и сама надстройка «Главный врач» (решение владельца: роли doctor
  // и head_doctor), даже поверх не врачебной основной роли — с теми же границами.
  const onlyHead = { id: 30, role: 'nurse', extra_roles: ['head_doctor'], full_name: 'Медсестра' };
  const b = referral(db, pid, [{ service_id: LAB }], onlyHead.id);
  assert.equal(createInvoiceForVisit(db, { visit_id: b.vid, visit_service_ids: b.ids }, onlyHead).invoice.status, 'unpaid');
  const c = referral(db, pid, [{ service_id: LAB }]);
  refused(() => createInvoiceForVisit(db, { visit_id: c.vid, visit_service_ids: c.ids, discount_amount: 1000 }, onlyHead), /Скидку в счёт ставят/);
  refused(() => createInvoiceForVisit(db, { visit_id: c.vid, visit_service_ids: c.ids, payer_id: payer }, onlyHead), /Счёт организации или страховой/);
});

test('скидка группы пациента действует и в счёте врача — её считает сервер', () => {
  const { db, LAB, pid } = seed();
  const cat = db.prepare("INSERT INTO patient_categories (name, discount_percent, active) VALUES ('VIP', 10, 1)").run().lastInsertRowid;
  db.prepare('UPDATE patients SET category_id = ? WHERE id = ?').run(cat, pid);
  const { vid, ids } = referral(db, pid, [{ service_id: LAB }]);
  const out = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: ids, discount_amount: 0, payer_id: null }, doctor);
  assert.equal(out.invoice.subtotal, 40000);
  assert.equal(out.invoice.discount_amount, 4000, 'скидка группы — сама, без ручной');
  assert.equal(out.invoice.total_amount, 36000);
});

test('медсестра, лаборант и колл-центр по-прежнему счёта не выставляют', () => {
  const { db, LAB, pid } = seed();
  const { vid, ids } = referral(db, pid, [{ service_id: LAB }]);
  for (const who of [nurse, lab, callcenter]) {
    refused(() => createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: ids }, who), /Вашей роли это действие недоступно/);
  }
  assert.equal(countInvoices(db), 0);
});

test('администратор, регистратура и касса — как прежде: и скидка, и плательщик', () => {
  for (const who of [admin, registrar, cashier]) {
    const { db, LAB, pid, payer } = seed();
    const a = referral(db, pid, [{ service_id: LAB }]);
    const disc = createInvoiceForVisit(db, { visit_id: a.vid, visit_service_ids: a.ids, discount_amount: 5000 }, who);
    assert.equal(disc.invoice.total_amount, 35000, who.role + ': ручная скидка');
    const b = referral(db, pid, [{ service_id: LAB }]);
    const byPayer = createInvoiceForVisit(db, { visit_id: b.vid, visit_service_ids: b.ids, payer_id: payer }, who);
    assert.equal(byPayer.invoice.payer_id, payer, who.role + ': счёт плательщику');
  }
});

test('врач с денежной ролью и администратор-врач — по своей денежной роли, без ограничений врача', () => {
  for (const who of [doctorCashier, adminDoctor]) {
    const { db, LAB, pid, payer } = seed();
    const a = referral(db, pid, [{ service_id: LAB }]);
    assert.equal(createInvoiceForVisit(db, { visit_id: a.vid, visit_service_ids: a.ids, discount_amount: 5000 }, who).invoice.total_amount, 35000, who.full_name);
    const b = referral(db, pid, [{ service_id: LAB }]);
    assert.equal(createInvoiceForVisit(db, { visit_id: b.vid, visit_service_ids: b.ids, payer_id: payer }, who).invoice.payer_id, payer, who.full_name);
  }
});

test('врачу по-прежнему закрыты оплата, счёт стационара и снятие строки из него', () => {
  const { db, LAB, pid } = seed();
  const { vid, ids } = referral(db, pid, [{ service_id: LAB }]);
  const { invoice } = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: ids }, doctor);
  refused(() => recordPayment(db, { invoice_id: invoice.id, amount: 40000, method: 'cash' }, doctor), /Вашей роли это действие недоступно/);
  refused(() => createInvoiceForAdmission(db, { admission_id: 1, admission_service_ids: [1] }, doctor), /Вашей роли это действие недоступно/);
  refused(() => removeAdmissionLineFromInvoice(db, { line_id: 1 }, doctor), /Вашей роли это действие недоступно/);
});

// ─── Дополнение владельца (2026-09-29) ──────────────────────────────────────
// 1. Плательщик в карте пациента («Leave for Касса»): врач счёта не выставляет
//    вовсе — строки ждут кассу в «Ждут счёта», а касса выставит счёт нужному
//    плательщику. Плательщик в карте — patients.payer_id на ДЕЙСТВУЮЩЕГО
//    плательщика (выключенному счёт не выставит никто).
// 2. Возвращённые услуги заново выставляет только касса.
const cardPayer = (db, pid, payer) => db.prepare('UPDATE patients SET payer_id = ? WHERE id = ?').run(payer, pid);

test('плательщик в карте пациента: врач — 403 до записи, визит ждёт кассу в «Ждут счёта»', () => {
  const { db, LAB, pid, payer } = seed();
  cardPayer(db, pid, payer);
  const { vid, ids } = referral(db, pid, [{ service_id: LAB }]);
  const seq = () => JSON.stringify(db.prepare('SELECT year, next_seq FROM invoice_counters ORDER BY year').all());
  const before = seq();
  refused(() => createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: ids, discount_amount: 0, payer_id: null }, doctor),
    /^У пациента в карте указан плательщик — счёт выставляет касса\.$/);
  refused(() => RPC.create_invoice_for_visit(db, { visit_id: vid, visit_service_ids: ids }, headDoctor),
    /У пациента в карте указан плательщик — счёт выставляет касса/);
  assert.equal(countInvoices(db), 0, 'отказ не оставил счёта');
  assert.equal(seq(), before, 'номер счёта не израсходован');
  assert.equal(db.prepare('SELECT invoice_item_id FROM visit_services WHERE id = ?').get(ids[0]).invoice_item_id, null);
  const waiting = RPC.cashier_unbilled(db, {}, cashier).rows.find((r) => r.visit_id === vid);
  assert.ok(waiting, 'визит врача не виден кассе в «Ждут счёта»');
  assert.equal(waiting.total, 40000);
});

test('плательщик в карте: касса, регистратура и администратор — как прежде; врач с денежной ролью — по ней', () => {
  for (const who of [admin, registrar, cashier, doctorCashier, adminDoctor]) {
    const { db, LAB, pid, payer } = seed();
    cardPayer(db, pid, payer);
    const a = referral(db, pid, [{ service_id: LAB }]);
    assert.equal(createInvoiceForVisit(db, { visit_id: a.vid, visit_service_ids: a.ids, payer_id: payer }, who).invoice.payer_id, payer, who.full_name + ': счёт плательщику');
    const b = referral(db, pid, [{ service_id: LAB }]);
    assert.equal(createInvoiceForVisit(db, { visit_id: b.vid, visit_service_ids: b.ids }, who).invoice.payer_id, null, who.full_name + ': счёт пациенту');
  }
});

test('плательщик в карте выключен — это уже не плательщик: врач выставляет счёт пациенту', () => {
  const { db, LAB, pid, payer } = seed();
  cardPayer(db, pid, payer);
  db.prepare('UPDATE payers SET active = 0 WHERE id = ?').run(payer);
  const { vid, ids } = referral(db, pid, [{ service_id: LAB }]);
  const out = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: ids }, doctor);
  assert.equal(out.invoice.payer_id, null);
  assert.equal(out.invoice.status, 'unpaid');
});

test('возвращённые услуги заново выставляет касса: врач с rebill_refunded — 403 до записи; касса — да', () => {
  const { db, LAB, pid } = seed();
  // Строку выставили, оплатили, работа сделана — и вернули деньги строкой:
  // она осталась в визите без счёта, с отметкой «возвращено».
  const { vid, ids } = referral(db, pid, [{ service_id: LAB }]);
  const inv = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: ids }, registrar).invoice;
  recordPayment(db, { invoice_id: inv.id, amount: 40000, method: 'cash' }, cashier);
  db.prepare("UPDATE visit_services SET status = 'completed' WHERE id = ?").run(ids[0]);
  const item = db.prepare('SELECT id FROM invoice_items WHERE invoice_id = ?').get(inv.id).id;
  RPC.refund_invoice_line(db, { invoice_item_id: item, reason: 'передумал' }, cashier);
  assert.equal(db.prepare('SELECT invoice_item_id FROM visit_services WHERE id = ?').get(ids[0]).invoice_item_id, null);
  const count = countInvoices(db);
  refused(() => createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: ids, rebill_refunded: true }, doctor),
    /^Возвращённые услуги заново выставляет касса\.$/);
  refused(() => createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: ids, rebill_refunded: 1 }, headDoctor),
    /Возвращённые услуги заново выставляет касса/);
  // Без флага сервер врачу тоже не выставит — прежнее правило (409).
  refused(() => createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: ids }, doctor), /уже вернули деньги/, 409);
  assert.equal(countInvoices(db), count, 'отказы врачу не оставили счёта');
  // Касса выставляет заново явным выбором — как прежде.
  const again = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: ids, rebill_refunded: true }, cashier);
  assert.equal(again.invoice.status, 'unpaid');
});
