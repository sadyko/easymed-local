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

// ─── Ревью S5 H-1 — СКИДКА КАССЫ НА СТРОКЕ ПО СТАВКАМ ПЕРЕЖИВАЕТ ЗАМЕНУ УСЛУГИ ─────────
//
// «Сотрудники» 20 %, Консультации 100 %: консультация + УЗИ = 160 000, касса −10 %
// «постоянный пациент» → 144 000 (16 000 легли на УЗИ своей скидкой строки сверх ставки).
// Замена УЗИ → УЗИ почек сбрасывала строку и ставила только ставку группы: 120 000 —
// 16 000 кассы пропадали молча (без ставок — 216 000 → 180 000, скидка в той же доле).
// Теперь доля кассы на строке — та же доля от остатка строки после новой ставки:
// УЗИ почек 150 000 − 20 % = 120 000, касса 10 % = 12 000 → к оплате 108 000.

function staffWithDesk(db, { reduces = false } = {}) {
  const pid = patient(db, group(db, { rates: STAFF }));
  const { vid, ids } = visitWith(db, pid, [30, 31]);
  const inv = call('create_invoice_for_visit', db, { visit_id: vid, visit_service_ids: ids, discount_amount: 0 }).invoice;
  const r = call('cashier_invoice_discount', db, { invoice_id: inv.id, mode: 'pct', value: 10, reason: 'постоянный пациент', reduces_doctor_share: reduces }, cashier);
  assert.equal(r.discount, 16000);
  assert.deepEqual(money(invOf(db, inv.id)), [300000, 156000, 144000]);
  return { pid, vid, ids, inv };
}
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} ≠ ${b}`);

test('ревью S5 H-1: замена услуги в неоплаченном счёте — 10 % кассы остаются: 144 000 → УЗИ почек 108 000 → обратно 144 000', () => {
  const db = seed();
  const { ids, inv } = staffWithDesk(db);
  call('cashier_line_change_service', db, { visit_service_id: ids[1], new_service_id: 32 });
  // УЗИ почек 150 000: ставка 20 % = 30 000, касса 10 % от 120 000 = 12 000
  assert.deepEqual(money(invOf(db, inv.id)), [250000, 142000, 108000], 'скидка кассы пропала при замене услуги');
  const uzk = items(db, inv.id)[1];
  assert.deepEqual(uzk.slice(0, 4), [32, 150000, 42000, 20]);
  near(uzk[4], 30000 / 42000, 'доля врача: ставка группы уменьшает 30 000, касса (переключатель выкл.) — нет 12 000');
  call('cashier_line_change_service', db, { visit_service_id: ids[1], new_service_id: 31 });
  assert.deepEqual(money(invOf(db, inv.id)), [300000, 156000, 144000], 'обратно — снова 144 000');
  near(items(db, inv.id)[1][4], 40000 / 56000, 'доля врача вернулась');
  // замена консультации (своей скидки кассы на ней нет: 100 %) — касса на УЗИ не тронута
  call('change_unpaid_service', db, { visit_service_id: ids[0], new_service_id: 40 });
  // ОАК 40 000 − 20 % = 32 000; УЗИ 144 000 → 176 000
  assert.deepEqual(money(invOf(db, inv.id)), [240000, 64000, 176000]);
});

test('ревью S5 H-1: замена в ОПЛАЧЕННОМ счёте — возврат 36 000 (как без ставок), а не 24 000', () => {
  const db = seed();
  call('open_cash_shift', db, { opening_float: 0 }, cashier);
  const { ids, inv } = staffWithDesk(db);
  call('record_payment', db, { invoice_id: inv.id, amount: 144000, method: 'cash' }, cashier);
  const r = call('cashier_line_swap_paid', db, { visit_service_id: ids[1], new_service_id: 32 });
  assert.equal(r.refunded, 36000, 'пациент недополучил возврат части скидки кассы');
  const after = invOf(db, inv.id);
  assert.deepEqual([...money(after), after.paid_amount, after.status], [250000, 142000, 108000, 108000, 'paid']);
});

test('ревью S5 H-1: «Вернуть услугу и выставить новую» (работа начата) — скидка кассы переходит на новую строку', () => {
  const db = seed();
  call('open_cash_shift', db, { opening_float: 0 }, cashier);
  const { ids, inv } = staffWithDesk(db);
  call('record_payment', db, { invoice_id: inv.id, amount: 144000, method: 'cash' }, cashier);
  db.prepare("UPDATE visit_services SET status = 'in_progress' WHERE id = ?").run(ids[1]);
  const r = call('cashier_line_rebill_paid', db, { visit_service_id: ids[1], new_service_id: 32 });
  assert.equal(r.refunded, 36000);
  assert.deepEqual(money(invOf(db, inv.id)), [250000, 142000, 108000]);
});

test('ревью S5 H-1: ставки у группы сняли, пока счёт открыт — замена берёт процент группы, и 10 % кассы остаются', () => {
  const db = seed();
  const { pid, ids, inv } = staffWithDesk(db);
  db.prepare("UPDATE patient_categories SET discount_rates = '{}' WHERE id = (SELECT category_id FROM patients WHERE id = ?)").run(pid);
  call('cashier_line_change_service', db, { visit_service_id: ids[1], new_service_id: 32 });
  // УЗИ почек: 20 % группы = 30 000 (тот же пол), касса 10 % от 120 000 = 12 000
  assert.deepEqual(money(invOf(db, inv.id)), [250000, 142000, 108000]);
});

test('ревью S5 H-1: промокод по ставкам — замена услуги снимает ставку промокода (правило S5), но не скидку кассы', () => {
  const db = seed();
  const pid = patient(db);
  const promo = Number(db.prepare(`INSERT INTO patient_discounts (name, kind, percent, active, discount_rates)
    VALUES ('ЛЕТО', 'promo', 10, 1, '{"g":{"consultation":50}}')`).run().lastInsertRowid);
  const { vid, ids } = visitWith(db, pid, [30, 31]);
  const inv = call('create_invoice_for_visit', db, { visit_id: vid, visit_service_ids: ids, discount_amount: 0, discount_choice: 'promo', discount_id: promo }).invoice;
  assert.deepEqual(money(inv), [300000, 70000, 230000]);
  call('cashier_invoice_discount', db, { invoice_id: inv.id, mode: 'pct', value: 10, reason: 'акция', reduces_doctor_share: true }, cashier);
  // 23 000 кассы: консультация 5 000 (из остатка 50 000), УЗИ 18 000 (из 180 000)
  assert.deepEqual(money(invOf(db, inv.id)), [300000, 93000, 207000]);
  call('cashier_line_change_service', db, { visit_service_id: ids[1], new_service_id: 32 });
  // УЗИ почек 150 000: промокод на заменённую строку не ложится; касса — 10 % = 15 000
  assert.deepEqual(money(invOf(db, inv.id)), [250000, 70000, 180000]);
  assert.deepEqual(items(db, inv.id)[1].slice(0, 4), [32, 150000, 15000, 0]);
});

// ─── Ревью S5 M-1 — «БЕЗ СКИДКИ» НЕ ДОПИСЫВАЕТСЯ В СЧЁТ ПО СТАВКАМ ГРУППЫ ────────────
//
// УЗИ выставлено «Скидкой группы» по ставкам (160 000). Тот же день ОАК «Без скидки»:
// у счёта по ставкам остаток скидки 0 и пол 0 — часть дописывалась в него, счёт оставался
// «группа», и следующая правка кассы клала пол группы на ОАК (8 000 = 20 % на «Без
// скидки»). Без ставок такая часть — своим счётом. Теперь и со ставками — своим счётом.
test('ревью S5 M-1: «Без скидки» после счёта по ставкам группы — отдельный счёт; правка кассы скидку на него не кладёт', () => {
  const db = seed();
  const pid = patient(db, group(db, { rates: STAFF }));
  const { vid, ids } = visitWith(db, pid, [31]);
  const first = call('create_invoice_for_visit', db, { visit_id: vid, visit_service_ids: ids, discount_amount: 0, discount_choice: 'group' }).invoice;
  assert.deepEqual(money(first), [200000, 40000, 160000]);
  const oak = addLines(db, vid, [40]);
  const res = call('create_invoice_for_visit', db, { visit_id: vid, visit_service_ids: oak, discount_amount: 0, discount_choice: 'none' });
  assert.ok(!res.appended, '«Без скидки» дописана в счёт по ставкам группы');
  assert.notEqual(res.invoice.id, first.id);
  assert.deepEqual(money(res.invoice), [40000, 0, 40000]);
  // касса добавляет ЭКГ в счёт «Без скидки» — скидки нет ни на ОАК, ни на ЭКГ
  call('cashier_line_add', db, { invoice_id: res.invoice.id, service_id: 41, doctor_id: 20 });
  assert.deepEqual(money(invOf(db, res.invoice.id)), [90000, 0, 90000]);
  // и счёт группы не тронут
  assert.deepEqual(money(invOf(db, first.id)), [200000, 40000, 160000]);
});

test('ревью S5 M-1: часть по ставкам группы по-прежнему дописывается в счёт по ставкам (без изменений)', () => {
  const db = seed();
  const pid = patient(db, group(db, { rates: STAFF }));
  const { vid, ids } = visitWith(db, pid, [31]);
  const first = call('create_invoice_for_visit', db, { visit_id: vid, visit_service_ids: ids, discount_amount: 0 }).invoice;
  const res = call('create_invoice_for_visit', db, { visit_id: vid, visit_service_ids: addLines(db, vid, [40]), discount_amount: 0 });
  assert.equal(res.appended, true);
  assert.equal(res.invoice.id, first.id);
  assert.deepEqual(money(res.invoice), [240000, 48000, 192000]);
});

// ─── Ревью S5 M-2 — «ВРУЧНУЮ» СВЕРХ СТАВОК: ПРАВКА КАССЫ НЕ КЛАДЁТ СТАВКИ СВЕРХУ ─────
//
// «Вручную» 200 000 на консультацию + УЗИ (300 000) больше скидки по ставкам (140 000) —
// своя скидка регистратора, как прежде (ставки не ложатся). Касса добавляла услугу или
// меняла её — invoiceRateSource отдавал ставки группы, и новая строка получала их поверх
// ручной скидки: две скидки сразу (правило «одна скидка») и копейки в счёте. Теперь у
// такого счёта правка — правилом без ставок, ровно как у группы без ставок.
function manualOver(db, rates) {
  const pid = patient(db, group(db, { rates }));
  const { vid, ids } = visitWith(db, pid, [30, 31]);
  const inv = call('create_invoice_for_visit', db, { visit_id: vid, visit_service_ids: ids, discount_amount: 200000, discount_choice: 'manual' }).invoice;
  assert.deepEqual(money(inv), [300000, 200000, 100000]);
  return { ids, inv };
}

test('ревью S5 M-2: «вручную» сверх ставок, касса добавила ЭКГ — 150 000, как без ставок (не 140 000 со ставкой сверху)', () => {
  for (const rates of [STAFF, {}]) {
    const db = seed();
    const { inv } = manualOver(db, rates);
    call('cashier_line_add', db, { invoice_id: inv.id, service_id: 41, doctor_id: 20 });
    // ручные 200 000 (база выросла — не больше данной суммы), пол 20 % от 350 000 = 70 000 меньше
    assert.deepEqual(money(invOf(db, inv.id)), [350000, 200000, 150000], 'ставки: ' + JSON.stringify(rates));
    assert.deepEqual(items(db, inv.id).map((r) => [r[2], r[3]]), [[0, null], [0, null], [0, null]]);
  }
});

test('ревью S5 M-2: «вручную» сверх ставок, касса заменила консультацию на ОАК — 80 000 без копеек, как без ставок', () => {
  for (const rates of [STAFF, {}]) {
    const db = seed();
    const { ids, inv } = manualOver(db, rates);
    call('change_unpaid_service', db, { visit_service_id: ids[0], new_service_id: 40 });
    // ручные 200 000 × 240 000 / 300 000 = 160 000
    assert.deepEqual(money(invOf(db, inv.id)), [240000, 160000, 80000], 'ставки: ' + JSON.stringify(rates));
  }
});

test('ревью S5 M-2: «вручную» не больше ставок — счёт по ставкам, касса добавляет строку своей ставкой (как прежде)', () => {
  const db = seed();
  const pid = patient(db, group(db, { rates: STAFF }));
  const { vid, ids } = visitWith(db, pid, [30, 31]);
  const inv = call('create_invoice_for_visit', db, { visit_id: vid, visit_service_ids: ids, discount_amount: 140000, discount_choice: 'manual' }).invoice;
  assert.deepEqual(money(inv), [300000, 140000, 160000]);
  call('cashier_line_add', db, { invoice_id: inv.id, service_id: 41, doctor_id: 20 });
  assert.deepEqual(money(invOf(db, inv.id)), [350000, 150000, 200000]);
});
