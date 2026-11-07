// DISCOUNT_RATES_V1 (3.22.0, владелец 2026-11-07) — СКИДКА ПО УСЛУГАМ: ставки группы,
// категории и услуги у скидки группы пациентов и у промокода. Деньги — числами.
//
// «Сотрудники»: по умолчанию 20 %, Консультации 100 % → консультация 100 000 → 0,
// УЗИ 200 000 → 160 000, один счёт на 160 000. Каждая строка несёт свою скидку
// (invoice_items.discount_amount), свой процент (discount_rate) и долю врача.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { RPC } from './index.js';

const admin = { id: 1, role: 'admin', full_name: 'Админ' };
const cashier = { id: 9, role: 'cashier', full_name: 'Кассир' };
const DAY = new Date(); DAY.setHours(9, 0, 0, 0);

function seed() {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, role, full_name, is_doctor, is_active) VALUES (1,'adm','x','admin','Админ',0,1), (9,'cash','x','cashier','Кассир',0,1), (20,'doc','x','doctor','Врач',1,1)").run();
  db.prepare("INSERT INTO service_categories (id, name) VALUES (7, 'УЗИ брюшной полости'), (8, 'Анализы крови')").run();
  db.prepare(`INSERT INTO services (id, name, price, type, category_id) VALUES
    (30, 'Консультация', 100000, 'consultation', NULL),
    (31, 'УЗИ', 200000, 'imaging', 7),
    (32, 'УЗИ почек', 150000, 'imaging', 7),
    (40, 'ОАК', 40000, 'lab', 8),
    (41, 'ЭКГ', 50000, 'imaging', NULL)`).run();
  return db;
}
const call = (name, db, args, user = admin) => RPC[name](db, args, user);
const group = (db, { pct = 20, rates = {}, reduces = 1, name = 'Сотрудники' } = {}) => Number(db.prepare(
  'INSERT INTO patient_categories (name, discount_percent, active, reduces_doctor_share, discount_rates) VALUES (?, ?, 1, ?, ?)',
).run(name, pct, reduces, JSON.stringify(rates)).lastInsertRowid);
const patient = (db, category = null) => Number(db.prepare('INSERT INTO patients (full_name, category_id) VALUES (?, ?)').run('Пациент', category).lastInsertRowid);
function visitWith(db, pid, services) {
  const vid = Number(db.prepare('INSERT INTO visits (patient_id, visit_date) VALUES (?, ?)').run(pid, DAY.toISOString()).lastInsertRowid);
  return { vid, ids: addLines(db, vid, services) };
}
function addLines(db, vid, services) {
  return services.map((sid) => {
    const price = db.prepare('SELECT price FROM services WHERE id = ?').get(sid).price;
    return Number(db.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, created_by) VALUES (?, ?, 20, 1, ?, ?, 'added', 1)")
      .run(vid, sid, price, price).lastInsertRowid);
  });
}
const money = (inv) => [inv.subtotal, inv.discount_amount, inv.total_amount];
const invOf = (db, id) => db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
const items = (db, invId) => db.prepare('SELECT service_id, total, discount_amount, discount_rate, discount_doctor_share FROM invoice_items WHERE invoice_id = ? ORDER BY id').all(invId)
  .map((r) => [r.service_id, r.total, r.discount_amount, r.discount_rate, r.discount_doctor_share]);
const STAFF = { g: { consultation: 100 } };

test('«Сотрудники» 20 %, Консультации 100 %: консультация 100 000 → 0, УЗИ 200 000 → 160 000, один счёт на 160 000', () => {
  for (const choice of [undefined, 'group']) {
    const db = seed();
    const pid = patient(db, group(db, { rates: STAFF }));
    const { vid, ids } = visitWith(db, pid, [30, 31]);
    const inv = call('create_invoice_for_visit', db, { visit_id: vid, visit_service_ids: ids, discount_amount: 0, ...(choice ? { discount_choice: choice } : {}) }).invoice;
    assert.deepEqual(money(inv), [300000, 140000, 160000], 'выбор: ' + choice);
    assert.deepEqual(items(db, inv.id), [[30, 100000, 100000, 100, 1], [31, 200000, 40000, 20, 1]]);
    assert.equal(inv.discount_note, 'Скидка группы «Сотрудники» — по услугам (по умолчанию 20%)');
    assert.equal(inv.manual_discount, 0, 'своей скидки регистратора нет — правка счёта её не повторит');
  }
});

test('группа БЕЗ ставок — ровно как прежде: скидка счёта на остаток, у строк своей скидки нет', () => {
  const db = seed();
  const pid = patient(db, group(db, { pct: 20 }));
  const { vid, ids } = visitWith(db, pid, [30, 31]);
  const inv = call('create_invoice_for_visit', db, { visit_id: vid, visit_service_ids: ids, discount_amount: 0 }).invoice;
  assert.deepEqual(money(inv), [300000, 60000, 240000]);
  assert.deepEqual(items(db, inv.id), [[30, 100000, 0, null, null], [31, 200000, 0, null, null]]);
  assert.equal(inv.discount_note, 'Скидка группы «Сотрудники» — 20%');
});

test('ставка услуги 0 % — полная цена; категория сильнее группы', () => {
  const db = seed();
  const pid = patient(db, group(db, { pct: 20, rates: { g: { consultation: 100, imaging: 30 }, c: { 7: 50 }, s: { 31: 0 } } }));
  const { vid, ids } = visitWith(db, pid, [30, 31, 32, 41]);
  const inv = call('create_invoice_for_visit', db, { visit_id: vid, visit_service_ids: ids, discount_amount: 0, discount_choice: 'group' }).invoice;
  // консультация 100 % · УЗИ 0 % (услуга) · УЗИ почек 50 % (категория) · ЭКГ 30 % (группа)
  assert.deepEqual(items(db, inv.id).map((r) => [r[0], r[2], r[3]]), [[30, 100000, 100], [31, 0, 0], [32, 75000, 50], [41, 15000, 30]]);
  assert.deepEqual(money(inv), [500000, 190000, 310000]);
});

test('группа с 0 % по умолчанию и ставкой «Консультации 100 %»: консультация бесплатно, остальное — полная цена', () => {
  const db = seed();
  const pid = patient(db, group(db, { pct: 0, rates: STAFF }));
  const { vid, ids } = visitWith(db, pid, [30, 31]);
  const inv = call('create_invoice_for_visit', db, { visit_id: vid, visit_service_ids: ids, discount_amount: 0 }).invoice;
  assert.deepEqual(money(inv), [300000, 100000, 200000]);
});

test('«вручную» больше скидки по ставкам — своя скидка регистратора (как прежде); не больше — ставки', () => {
  const db = seed();
  const pid = patient(db, group(db, { rates: STAFF }));
  const a = visitWith(db, pid, [30, 31]);
  const inv = call('create_invoice_for_visit', db, { visit_id: a.vid, visit_service_ids: a.ids, discount_amount: 200000, discount_choice: 'manual' }).invoice;
  assert.deepEqual(money(inv), [300000, 200000, 100000]);
  assert.deepEqual(items(db, inv.id).map((r) => r[2]), [0, 0], 'своя скидка — на счёт, строки без своей');
  assert.equal(inv.discount_note, 'Скидка вручную');
  const b = visitWith(db, pid, [30, 31]);
  const inv2 = call('create_invoice_for_visit', db, { visit_id: b.vid, visit_service_ids: b.ids, discount_amount: 140000, discount_choice: 'manual' }).invoice;
  assert.deepEqual(money(inv2), [300000, 140000, 160000]);
  assert.deepEqual(items(db, inv2.id).map((r) => r[2]), [100000, 40000]);
});

test('промокод 10 % со ставкой категории 50 %: УЗИ брюшной полости — 50 %, ЭКГ — 10 %; «Только на эти услуги» — вне списка 0 %', () => {
  const db = seed();
  const pid = patient(db);
  const promo = Number(db.prepare(`INSERT INTO patient_discounts (name, kind, percent, active, service_ids, discount_rates)
    VALUES ('ЛЕТО', 'promo', 10, 1, '[31, 41]', '{"c":{"7":50}}')`).run().lastInsertRowid);
  const { vid, ids } = visitWith(db, pid, [30, 31, 41]);
  const inv = call('create_invoice_for_visit', db, { visit_id: vid, visit_service_ids: ids, discount_amount: 0, discount_choice: 'promo', discount_id: promo }).invoice;
  assert.deepEqual(items(db, inv.id).map((r) => [r[0], r[2], r[3]]), [[30, 0, 0], [31, 100000, 50], [41, 5000, 10]]);
  assert.deepEqual(money(inv), [350000, 105000, 245000]);
  assert.equal(inv.discount_source, 'promo:' + promo);
  assert.equal(inv.discount_note, 'Промокод «ЛЕТО» — по услугам (по умолчанию 10%)');
});

test('счёт плательщику — без скидки группы и её ставок (B5)', () => {
  const db = seed();
  const pid = patient(db, group(db, { rates: STAFF }));
  const payer = Number(db.prepare("INSERT INTO payers (name, kind, active) VALUES ('Страховая', 'insurance', 1)").run().lastInsertRowid);
  const { vid, ids } = visitWith(db, pid, [30, 31]);
  const inv = call('create_invoice_for_visit', db, { visit_id: vid, visit_service_ids: ids, discount_amount: 0, payer_id: payer }).invoice;
  assert.deepEqual(money(inv), [300000, 0, 300000]);
  assert.deepEqual(items(db, inv.id).map((r) => [r[2], r[3]]), [[0, null], [0, null]]);
});

test('дописывание в неоплаченный счёт: новые строки — своими ставками, прежние не меняются', () => {
  const db = seed();
  const pid = patient(db, group(db, { rates: STAFF }));
  const { vid, ids } = visitWith(db, pid, [31]);
  const first = call('create_invoice_for_visit', db, { visit_id: vid, visit_service_ids: ids, discount_amount: 0, discount_choice: 'group' }).invoice;
  assert.deepEqual(money(first), [200000, 40000, 160000]);
  const more = addLines(db, vid, [30, 40]);
  const res = call('create_invoice_for_visit', db, { visit_id: vid, visit_service_ids: more, discount_amount: 0, discount_choice: 'group' });
  assert.equal(res.appended, true, 'строки легли в тот же счёт');
  assert.equal(res.invoice.id, first.id);
  assert.deepEqual(money(res.invoice), [340000, 148000, 192000]);
  assert.deepEqual(items(db, first.id).map((r) => [r[0], r[2], r[3]]), [[31, 40000, 20], [30, 100000, 100], [40, 8000, 20]]);
});

test('касса добавляет услугу в счёт по ставкам — у новой строки своя ставка; убрать консультацию — УЗИ остаётся 160 000', () => {
  const db = seed();
  const pid = patient(db, group(db, { rates: STAFF }));
  const { vid, ids } = visitWith(db, pid, [31]);
  const inv = call('create_invoice_for_visit', db, { visit_id: vid, visit_service_ids: ids, discount_amount: 0 }).invoice;
  const added = call('cashier_line_add', db, { invoice_id: inv.id, service_id: 30, doctor_id: 20 });
  assert.deepEqual(money(invOf(db, inv.id)), [300000, 140000, 160000]);
  assert.deepEqual(items(db, inv.id).map((r) => [r[0], r[2], r[3]]), [[31, 40000, 20], [30, 100000, 100]]);
  call('remove_unpaid_service', db, { visit_service_id: added.line.id });
  assert.deepEqual(money(invOf(db, inv.id)), [200000, 40000, 160000]);
});

test('замена услуги в неоплаченном счёте: ставка — по новой услуге (консультация 100 % → ОАК 20 %)', () => {
  const db = seed();
  const pid = patient(db, group(db, { rates: STAFF }));
  const { vid, ids } = visitWith(db, pid, [30, 31]);
  const inv = call('create_invoice_for_visit', db, { visit_id: vid, visit_service_ids: ids, discount_amount: 0 }).invoice;
  call('change_unpaid_service', db, { visit_service_id: ids[0], new_service_id: 40 });
  assert.deepEqual(items(db, inv.id).map((r) => [r[0], r[2], r[3]]), [[40, 8000, 20], [31, 40000, 20]]);
  assert.deepEqual(money(invOf(db, inv.id)), [240000, 48000, 192000]);
  call('change_unpaid_service', db, { visit_service_id: ids[0], new_service_id: 30 });
  assert.deepEqual(money(invOf(db, inv.id)), [300000, 140000, 160000], 'обратно — снова 100 %');
});

test('возврат строки оплаченного счёта по ставкам: УЗИ — 160 000 назад, консультация (100 %) — 0', () => {
  const db = seed();
  call('open_cash_shift', db, { opening_float: 0 }, cashier);
  const pid = patient(db, group(db, { rates: STAFF }));
  const { vid, ids } = visitWith(db, pid, [30, 31]);
  const inv = call('create_invoice_for_visit', db, { visit_id: vid, visit_service_ids: ids, discount_amount: 0 }).invoice;
  call('record_payment', db, { invoice_id: inv.id, amount: 160000, method: 'cash' }, cashier);
  const uzi = db.prepare('SELECT id FROM invoice_items WHERE invoice_id = ? AND service_id = 31').get(inv.id).id;
  const r = call('refund_invoice_line', db, { invoice_item_id: uzi, reason: 'тест' }, cashier);
  assert.equal(r.refunded ?? r.refund_amount ?? r.amount, 160000, JSON.stringify(r).slice(0, 300));
  assert.deepEqual(money(invOf(db, inv.id)), [100000, 100000, 0]);
});

test('скидка кассы на счёт по ставкам ложится на остаток строк (10 % от к оплате) — своей скидкой строки', () => {
  const db = seed();
  const pid = patient(db, group(db, { rates: STAFF }));
  const { vid, ids } = visitWith(db, pid, [30, 31]);
  const inv = call('create_invoice_for_visit', db, { visit_id: vid, visit_service_ids: ids, discount_amount: 0 }).invoice;
  const r = call('cashier_invoice_discount', db, { invoice_id: inv.id, mode: 'pct', value: 10, reason: 'постоянный пациент', reduces_doctor_share: false }, cashier);
  assert.equal(r.discount, 16000);
  assert.deepEqual(money(invOf(db, inv.id)), [300000, 156000, 144000]);
  const uzi = items(db, inv.id)[1];
  assert.deepEqual([uzi[2], uzi[3]], [56000, 20]);
  assert.ok(Math.abs(uzi[4] - 40000 / 56000) < 1e-9, 'доля врача строки — смесь: группа уменьшает 40 000, касса — нет 16 000');
});

test('счёт только из консультации (100 %) — на 0, оплачен, виден в «Приёме оплат» со скидкой', () => {
  const db = seed();
  call('open_cash_shift', db, { opening_float: 0 }, cashier);
  const pid = patient(db, group(db, { rates: STAFF }));
  const { vid, ids } = visitWith(db, pid, [30]);
  const inv = call('create_invoice_for_visit', db, { visit_id: vid, visit_service_ids: ids, discount_amount: 0 }).invoice;
  assert.deepEqual([...money(inv), inv.status], [100000, 100000, 0, 'paid']);
  const { rows } = call('cashier_invoices', db, {}, cashier);
  const row = rows.find((x) => x.id === inv.id);
  assert.ok(row, 'счёт со скидкой 100 % не виден в кассе');
  assert.equal(row.discount_note, 'Скидка группы «Сотрудники» — по услугам (по умолчанию 20%)');
  assert.equal(db.prepare("SELECT status FROM visit_services WHERE id = ?").get(ids[0]).status, 'queued', 'бесплатная консультация — сразу в очередь');
});
