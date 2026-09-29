// OWN_PRICE_REPEAT_V1 (2026-09-30) — СВОЯ ЦЕНА ВРАЧА И НА ПОВТОРНЫЙ ВИЗИТ.
//
// Владелец: «Own price for repeat too». Своя цена (users.service_rates[].price)
// действовала только на первичный приём: второй и повторный визит в окне дней
// выставлялся по цене каталога для этого визита. Теперь правило одно для всех
// дверей: у врача по услуге есть своя цена — она и есть цена строки на любом
// ярусе; своей цены нет — цена яруса, как прежде. Ярус строки (price_tier)
// по-прежнему пишется: по нему считаются визиты.
//
// Здесь — серверные двери, через настоящие RPC и SQLite после миграций:
// котировка, выставление счёта, «Ждут счёта» кассы, «Добавить» кассы, замена
// услуги и врача в неоплаченном счёте, исполнители строки, замена в
// оплаченном счёте, счёт врача по своим строкам (REFBILL), строка
// колл-центра, доля врача от суммы строки. Экранные двери (мастер визита,
// Калькулятор, «Добавить» окна счёта) — в public/js/admin/__tests__.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { RPC } from './index.js';
import { createInvoiceForVisit, recordPayment } from './billing.js';
import { openCashShift, cashierUnbilled } from './cashier.js';
import { doctorPaySummary } from './reports.js';
import { priceFor } from '../crm/booking-mirror.js';
import { doctorPriceFor, doctorPriceLookup } from '../domain/pricing.js';
import { serviceLinePrice, ownPriceValue, ownPriceFromRates } from '../../../public/js/shared/own-price-rule.js';

const admin = { id: 1, role: 'admin', full_name: 'Админ' };
const registrar = { id: 7, role: 'registrar', full_name: 'Регистратура' };
const cashier = { id: 9, role: 'cashier', full_name: 'Кассир' };
const OWN = 20;      // своя цена 150 000 на приём, 10 %
const PLAIN = 21;    // своей цены нет, 10 %
const doctorOwn = { id: OWN, role: 'doctor', full_name: 'Врач со своей ценой' };

function seed() {
  const db = openDb(':memory:'); migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, role, full_name, is_doctor, extra_roles, is_active) VALUES (?,?,?,?,?,?,?,1)');
  u.run(1, 'adm', 'x', 'admin', 'Админ', 0, '[]');
  u.run(7, 'reg', 'x', 'registrar', 'Регистратура', 0, '[]');
  u.run(9, 'cash', 'x', 'cashier', 'Кассир', 0, '[]');
  u.run(OWN, 'own', 'x', 'doctor', 'Врач со своей ценой', 1, '[]');
  u.run(PLAIN, 'plain', 'x', 'doctor', 'Врач без своей цены', 1, '[]');
  // Приём: первый 200 000, второй за 1–10 дней — 60 000, третий и дальше — 30 000.
  const CONS = Number(db.prepare(`INSERT INTO services (name, price, tax_rate, type, price_secondary, secondary_days_from, secondary_days_to, price_repeat)
                                  VALUES ('Приём терапевта', 200000, 0, 'consultation', 60000, 1, 10, 30000)`).run().lastInsertRowid);
  const USG = Number(db.prepare("INSERT INTO services (name, price, tax_rate, type) VALUES ('УЗИ', 80000, 0, 'imaging')").run().lastInsertRowid);
  db.prepare('UPDATE users SET service_rates = ? WHERE id = ?').run(JSON.stringify([
    { service_id: CONS, pct: 10, price: 150000, branches: [] }, { service_id: USG, pct: 10, branches: [] }]), OWN);
  db.prepare('UPDATE users SET service_rates = ? WHERE id = ?').run(JSON.stringify([
    { service_id: CONS, pct: 10, branches: [] }, { service_id: USG, pct: 10, branches: [] }]), PLAIN);
  const grant = db.prepare('SELECT permissions FROM role_permissions WHERE role = ?').get('cashier');
  const perms = grant && grant.permissions ? JSON.parse(grant.permissions) : { sections: [], levels: {} };
  perms.grants = { ...(perms.grants || {}), 'cashier.lines': 'edit' };
  if (grant) db.prepare('UPDATE role_permissions SET permissions = ? WHERE role = ?').run(JSON.stringify(perms), 'cashier');
  else db.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?)').run('cashier', JSON.stringify(perms));
  const pid = Number(db.prepare("INSERT INTO patients (full_name) VALUES ('Пациент Повторный')").run().lastInsertRowid);
  return { db, CONS, USG, pid };
}

// Местный полдень дня «сегодня + offset» — день визита сервер считает тем же
// 'localtime' (как в billing.refbill-review.test.js).
const dayAt = (db, offset) => db.prepare(
  "SELECT strftime('%Y-%m-%dT%H:%M:%SZ', date('now', 'localtime', ?) || ' 12:00:00', 'utc') AS t",
).get(`${offset >= 0 ? '+' : ''}${offset} days`).t;
const dayOf = (db, offset) => db.prepare("SELECT date('now', 'localtime', ?) AS d").get(`${offset >= 0 ? '+' : ''}${offset} days`).d;

function visit(db, pid, offset, { status = 'arrived', by = 7 } = {}) {
  return Number(db.prepare('INSERT INTO visits (patient_id, visit_date, status, created_by) VALUES (?, ?, ?, ?)')
    .run(pid, dayAt(db, offset), status, by).lastInsertRowid);
}
function line(db, vid, { service_id, doctor_id, tier = null, status = 'added', by = 7 }) {
  return Number(db.prepare(`INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, created_by, price_tier)
                            VALUES (?, ?, ?, 1, 0, 0, ?, ?, ?)`).run(vid, service_id, doctor_id, status, by, tier).lastInsertRowid);
}
const patient = (db) => Number(db.prepare("INSERT INTO patients (full_name) VALUES ('Пациент Второй')").run().lastInsertRowid);
// Прошлый приём этой услуги у пациента: первичный (или указанный ярус), выполнен.
function history(db, pid, serviceId, offset, tier = 'primary') {
  const v = visit(db, pid, offset);
  line(db, v, { service_id: serviceId, doctor_id: PLAIN, tier, status: 'completed' });
  return v;
}
const quote = (db, pid, serviceId, offset, doctorId) => RPC.service_price_quote(db, {
  patient_id: pid, service_ids: [serviceId], date: dayOf(db, offset), ...(doctorId ? { doctor_id: doctorId } : {}),
}, registrar).quotes[serviceId];
const vsRow = (db, id) => db.prepare('SELECT * FROM visit_services WHERE id = ?').get(id);
const inv = (db, id) => db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);

// ─── правило ─────────────────────────────────────────────────────────────────
test('правило: своя цена сильнее яруса; своей нет — цена яруса; 0 — настоящая бесплатная цена', () => {
  assert.equal(serviceLinePrice(150000, 60000), 150000);
  assert.equal(serviceLinePrice(null, 60000), 60000);
  assert.equal(serviceLinePrice(0, 60000), 0);
  assert.equal(ownPriceValue('80000'), 80000);
  assert.equal(ownPriceValue(''), null);
  assert.equal(ownPriceValue('abc'), null);
  assert.equal(ownPriceValue(-5), null);
  assert.equal(ownPriceValue(null), null);
  // При дублях услуги — запись С ЦЕНОЙ (FINAL_MONEY_FIX_V1 M4, как у сервера).
  assert.equal(ownPriceFromRates([{ service_id: 5, pct: 30 }, { service_id: '5', price: 90000 }], 5), 90000);
  assert.equal(ownPriceFromRates([{ service_id: 5, price: '' }], 5), null);
  assert.equal(ownPriceFromRates(null, 5), null);
});

// Ревью 1 — экран разбирает сохранённую цену РОВНО как сервер: любая строка,
// которую сервер прочтёт как свою цену, экраном читается тем же числом, а
// отброшенная сервером — отброшена и экраном. Иначе смета мастера или
// Калькулятора назвала бы одну сумму, а счёт выставил бы другую.
test('правило: разбор своей цены на экране = разбор сервера (OWN_PRICE_ENTRY + CAST), в том числе кривые строки', () => {
  const db = openDb(':memory:'); migrate(db);
  const RAW = [80000, 80000.5, 0, -1, '80000', '80000.5', ' 80000 ', '80.000.5', '80.', '80..5', '1.2.3', '0',
    '', ' ', 'abc', '80 000', '80,5', '.5', '-5', '\t80', '80\t', '1e3', null, true, false, '٣٠'];
  const ins = db.prepare("INSERT INTO users (id, username, password_hash, role, service_rates) VALUES (?, ?, 'x', 'doctor', ?)");
  RAW.forEach((price, i) => ins.run(100 + i, 'd' + i, JSON.stringify([{ service_id: 7, pct: 10, price }])));
  const lookup = doctorPriceLookup(db, RAW.map((_, i) => 100 + i));
  const got = RAW.map((price, i) => ({ price, server: doctorPriceFor(db, 100 + i, 7), batch: lookup(100 + i, 7), screen: ownPriceFromRates([{ service_id: 7, pct: 10, price }], 7) }));
  for (const g of got) {
    assert.equal(g.screen, g.server, 'цена ' + JSON.stringify(g.price) + ': экран ' + g.screen + ', сервер ' + g.server);
    assert.equal(g.batch, g.server, 'цена ' + JSON.stringify(g.price) + ': выборка кассы ' + g.batch + ', сервер ' + g.server);
  }
  // Прямо — то, что нашло ревью: '80.000.5' сервер читает как 80.
  assert.equal(ownPriceValue('80.000.5'), 80);
  assert.equal(doctorPriceFor(db, 100 + RAW.indexOf('80.000.5'), 7), 80);
});

// ─── котировка = счёт ────────────────────────────────────────────────────────
test('второй визит в окне: котировка и счёт — своя цена 150 000, ярус «второй» записан; без своей цены — 60 000', () => {
  const { db, CONS, pid } = seed();
  history(db, pid, CONS, -3);
  const q = quote(db, pid, CONS, 0, OWN);
  assert.equal(q.tier, 'secondary', 'ярус считается как прежде');
  assert.equal(q.price, 150000, 'котировка: своя цена врача, а не 60 000 каталога');
  assert.equal(q.own_price, 150000);
  const plain = quote(db, pid, CONS, 0, PLAIN);
  assert.deepEqual([plain.tier, plain.price], ['secondary', 60000], 'без своей цены — как прежде');
  assert.equal(quote(db, pid, CONS, 0, null).price, 60000, 'без врача — цена яруса');

  const v = visit(db, pid, 0);
  const own = line(db, v, { service_id: CONS, doctor_id: OWN, tier: q.tier });
  const out = createInvoiceForVisit(db, { visit_id: v, visit_service_ids: [own] }, registrar);
  assert.equal(out.invoice.total_amount, q.price, 'котировка ≠ счёт');
  assert.equal(vsRow(db, own).price_tier, 'secondary', 'ярус строки не пропал');

  const v2 = visit(db, pid, 0);
  const pl = line(db, v2, { service_id: CONS, doctor_id: PLAIN, tier: plain.tier });
  assert.equal(createInvoiceForVisit(db, { visit_id: v2, visit_service_ids: [pl] }, registrar).invoice.total_amount, 60000);
});

test('третий визит (повторный): своя цена 150 000; без своей — 30 000 каталога', () => {
  const { db, CONS, pid } = seed();
  history(db, pid, CONS, -6);
  history(db, pid, CONS, -3, 'secondary');
  const q = quote(db, pid, CONS, 0, OWN);
  assert.deepEqual([q.tier, q.price], ['repeat', 150000]);
  assert.deepEqual([quote(db, pid, CONS, 0, PLAIN).tier, quote(db, pid, CONS, 0, PLAIN).price], ['repeat', 30000]);
  const v = visit(db, pid, 0);
  const own = line(db, v, { service_id: CONS, doctor_id: OWN, tier: 'repeat' });
  const pl = line(db, v, { service_id: CONS, doctor_id: PLAIN, tier: 'repeat' });
  const out = createInvoiceForVisit(db, { visit_id: v, visit_service_ids: [own, pl] }, registrar);
  assert.equal(out.invoice.total_amount, 150000 + 30000);
});

// ─── доля врача от своей цены ────────────────────────────────────────────────
test('доля врача за второй визит — от своей цены: выставленная и оплаченная строка, и выполненная без счёта', () => {
  const { db, CONS, pid } = seed();
  history(db, pid, CONS, -3);
  const v = visit(db, pid, 0);
  const l = line(db, v, { service_id: CONS, doctor_id: OWN, tier: 'secondary' });
  const out = createInvoiceForVisit(db, { visit_id: v, visit_service_ids: [l] }, registrar);
  openCashShift(db, { opening_float: 0 }, cashier);
  recordPayment(db, { invoice_id: out.invoice.id, amount: out.invoice.total_amount, method: 'cash' }, cashier);
  db.prepare("UPDATE visit_services SET status = 'completed' WHERE id = ?").run(l);
  const range = { doctor_id: OWN, from: dayOf(db, -30), to: dayOf(db, 1) };
  assert.equal(doctorPaySummary(db, range, admin).outpatient.fee, 15000, '10 % от 150 000');

  // Выполнено, счёта ещё нет: доля считается от той цены, что выставит касса.
  const v2 = visit(db, pid, 0);
  const l2 = line(db, v2, { service_id: CONS, doctor_id: OWN, tier: 'secondary', status: 'completed' });
  assert.ok(l2);
  assert.equal(doctorPaySummary(db, range, admin).outpatient.fee, 30000);
});

// ─── «Ждут счёта» кассы ──────────────────────────────────────────────────────
test('«Ждут счёта»: сумма визита второго приёма — своя цена врача; без своей — цена яруса', () => {
  const { db, CONS, pid } = seed();
  history(db, pid, CONS, -3);
  const v = visit(db, pid, 0);
  line(db, v, { service_id: CONS, doctor_id: OWN, tier: 'secondary' });
  const pid2 = patient(db);
  history(db, pid2, CONS, -3);
  const v2 = visit(db, pid2, 0);
  line(db, v2, { service_id: CONS, doctor_id: PLAIN, tier: 'secondary' });
  const rows = cashierUnbilled(db, {}, cashier).rows;
  assert.equal(rows.find((r) => r.visit_id === v).total, 150000);
  assert.equal(rows.find((r) => r.visit_id === v2).total, 60000);
});

// ─── правки кассы ────────────────────────────────────────────────────────────
test('касса «Добавить» в счёт второго визита: своя цена врача, ярус «второй»', () => {
  const { db, CONS, pid } = seed();
  history(db, pid, CONS, -3);
  const v = visit(db, pid, 0);
  const r = RPC.cashier_line_add(db, { visit_id: v, service_id: CONS, doctor_id: OWN }, cashier);
  const row = db.prepare('SELECT * FROM visit_services WHERE visit_id = ? AND service_id = ?').get(v, CONS);
  assert.ok(r);
  assert.deepEqual([row.unit_price, row.price_tier], [150000, 'secondary']);
  // Другой пациент: у первого сегодняшний приём уже есть, и следующий в тот же
  // день для сервера — снова первичный (окно «от 1 дня»).
  const pid2 = patient(db);
  history(db, pid2, CONS, -3);
  const v2 = visit(db, pid2, 0);
  RPC.cashier_line_add(db, { visit_id: v2, service_id: CONS, doctor_id: PLAIN }, cashier);
  const row2 = db.prepare('SELECT * FROM visit_services WHERE visit_id = ? AND service_id = ?').get(v2, CONS);
  assert.deepEqual([row2.unit_price, row2.price_tier], [60000, 'secondary']);
});

test('касса: замена услуги в неоплаченном счёте на приём второго визита — своя цена врача строки', () => {
  const { db, CONS, USG, pid } = seed();
  history(db, pid, CONS, -3);
  const v = visit(db, pid, 0);
  const l = line(db, v, { service_id: USG, doctor_id: OWN });
  const out = createInvoiceForVisit(db, { visit_id: v, visit_service_ids: [l] }, registrar);
  const res = RPC.cashier_line_change_service(db, { visit_service_id: l, new_service_id: CONS }, cashier);
  assert.deepEqual([res.line.unit_price, res.line.price_tier], [150000, 'secondary']);
  assert.equal(inv(db, out.invoice.id).total_amount, 150000);
});

test('касса: смена врача в неоплаченной строке второго визита — цена нового врача (своя 150 000 ↔ ярус 60 000)', () => {
  const { db, CONS, pid } = seed();
  history(db, pid, CONS, -3);
  const v = visit(db, pid, 0);
  const l = line(db, v, { service_id: CONS, doctor_id: PLAIN, tier: 'secondary' });
  const out = createInvoiceForVisit(db, { visit_id: v, visit_service_ids: [l] }, registrar);
  assert.equal(out.invoice.total_amount, 60000);
  RPC.cashier_line_set_doctor(db, { visit_service_id: l, doctor_id: OWN }, cashier);
  assert.deepEqual([vsRow(db, l).unit_price, vsRow(db, l).price_tier], [150000, 'secondary']);
  assert.equal(inv(db, out.invoice.id).total_amount, 150000);
  RPC.cashier_line_set_doctor(db, { visit_service_id: l, doctor_id: PLAIN }, cashier);
  assert.equal(inv(db, out.invoice.id).total_amount, 60000);
});

test('касса: исполнители строки второго визита — у каждого его цена по правилу', () => {
  const { db, CONS, pid } = seed();
  history(db, pid, CONS, -3);
  const v = visit(db, pid, 0);
  const l = line(db, v, { service_id: CONS, doctor_id: PLAIN, tier: 'secondary' });
  const r = RPC.cashier_line_performers(db, { visit_service_id: l }, cashier);
  assert.equal(r.tier, 'secondary');
  assert.equal(r.performers.find((p) => p.id === OWN).unit_price, 150000);
  assert.equal(r.performers.find((p) => p.id === PLAIN).unit_price, 60000);
});

test('касса: замена в ОПЛАЧЕННОМ счёте на приём второго визита — доплата до своей цены; без своей — возврат до цены яруса', () => {
  const { db, CONS, USG, pid } = seed();
  openCashShift(db, { opening_float: 0 }, cashier);
  history(db, pid, CONS, -3);
  const pay = (patientId, serviceId, doctorId) => {
    const v = visit(db, patientId, 0);
    const l = line(db, v, { service_id: serviceId, doctor_id: doctorId });
    const out = createInvoiceForVisit(db, { visit_id: v, visit_service_ids: [l] }, registrar);
    recordPayment(db, { invoice_id: out.invoice.id, amount: out.invoice.total_amount, method: 'cash' }, cashier);
    return { l, invoiceId: out.invoice.id };
  };
  const a = pay(pid, USG, OWN);   // оплачено 80 000
  const preview = RPC.cashier_line_swap_quote(db, { visit_service_id: a.l, new_service_id: CONS }, cashier);
  assert.equal(preview.due, 70000, 'предпросмотр: доплата до своей цены 150 000');
  const r = RPC.cashier_line_swap_paid(db, { visit_service_id: a.l, new_service_id: CONS }, cashier);
  assert.equal(r.due, 70000);
  assert.deepEqual([vsRow(db, a.l).unit_price, vsRow(db, a.l).price_tier], [150000, 'secondary']);
  assert.equal(inv(db, a.invoiceId).total_amount, 150000);

  const pid2 = patient(db);   // у первого пациента сегодняшний приём уже есть
  history(db, pid2, CONS, -3);
  const b = pay(pid2, USG, PLAIN);   // оплачено 80 000
  const r2 = RPC.cashier_line_swap_paid(db, { visit_service_id: b.l, new_service_id: CONS }, cashier);
  assert.equal(r2.refunded, 20000, 'без своей цены — цена яруса 60 000, как прежде');
  assert.equal(inv(db, b.invoiceId).total_amount, 60000);
});

// ─── счёт врача по своим строкам (REFBILL) ───────────────────────────────────
test('REFBILL: врач выставляет свой второй приём — ярус сверяется с сервером, цена — своя', () => {
  const { db, CONS, pid } = seed();
  history(db, pid, CONS, -3);
  const v = visit(db, pid, 0, { status: 'scheduled', by: OWN });
  const l = line(db, v, { service_id: CONS, doctor_id: OWN, tier: 'secondary', by: OWN });
  const out = createInvoiceForVisit(db, { visit_id: v, visit_service_ids: [l], discount_amount: 0, payer_id: null }, doctorOwn);
  assert.equal(out.invoice.total_amount, 150000);
  // Ярус по-прежнему сверяется: «первичный» при втором визите — отказ.
  const bad = line(db, v, { service_id: CONS, doctor_id: OWN, tier: 'primary', by: OWN });
  assert.throws(() => createInvoiceForVisit(db, { visit_id: v, visit_service_ids: [bad], discount_amount: 0, payer_id: null }, doctorOwn),
    (e) => e.status === 403 && /не совпадает с расчётом сервера/.test(e.message));
});

// ─── строка колл-центра / зеркало записи ─────────────────────────────────────
test('колл-центр: строка второго визита — своя цена врача, ярус «второй»', () => {
  const { db, CONS, pid } = seed();
  history(db, pid, CONS, -3);
  const v = visit(db, pid, 0, { status: 'scheduled' });
  assert.deepEqual(priceFor(db, { patientId: pid, visitId: v, day: dayOf(db, 0), serviceId: CONS, doctorId: OWN }), { unit: 150000, tier: 'secondary' });
  assert.deepEqual(priceFor(db, { patientId: pid, visitId: v, day: dayOf(db, 0), serviceId: CONS, doctorId: PLAIN }), { unit: 60000, tier: 'secondary' });
});
