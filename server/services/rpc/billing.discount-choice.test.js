// DISCOUNT_V2 (решение владельца 2026-11-07, п. 4) — ОДНА СКИДКА, ВЫБРАННАЯ У СТОЙКИ.
// create_invoice_for_visit по discount_choice: группа / «Без скидки» / промокод /
// вручную; без выбора — правило 3.21. Деньги — числами.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { RPC } from './index.js';

const admin = { id: 1, role: 'admin', full_name: 'Админ' };
const doctor = { id: 20, role: 'doctor', full_name: 'Врач' };
const DAY = new Date(); DAY.setHours(9, 0, 0, 0);

function seed() {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, role, full_name, is_doctor, is_active) VALUES (1,'adm','x','admin','Админ',0,1), (20,'doc','x','doctor','Врач',1,1)").run();
  db.prepare("INSERT INTO services (id, name, price) VALUES (30, 'Консультация', 100000), (31, 'УЗИ', 50000), (40, 'ОАК', 40000)").run();
  return db;
}
const call = (name, db, args, user = admin) => RPC[name](db, args, user);
function patient(db, { category = null } = {}) {
  return Number(db.prepare('INSERT INTO patients (full_name, category_id) VALUES (?, ?)').run('Пациент', category).lastInsertRowid);
}
function visitWith(db, pid, services, { by = 1 } = {}) {
  const vid = Number(db.prepare('INSERT INTO visits (patient_id, visit_date) VALUES (?, ?)').run(pid, DAY.toISOString()).lastInsertRowid);
  const ids = services.map((sid) => {
    const price = db.prepare('SELECT price FROM services WHERE id = ?').get(sid).price;
    return Number(db.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, created_by) VALUES (?, ?, 20, 1, ?, ?, 'added', ?)")
      .run(vid, sid, price, price, by).lastInsertRowid);
  });
  return { vid, ids };
}
const vip = (db, pct = 10, reduces = 1) => Number(db.prepare("INSERT INTO patient_categories (name, discount_percent, active, reduces_doctor_share) VALUES ('VIP', ?, 1, ?)").run(pct, reduces).lastInsertRowid);
const promo = (db, fields) => {
  const row = { kind: 'promo', percent: 0, amount: 0, active: 1, service_ids: '[]', reduces_doctor_share: 1, ...fields };
  const cols = Object.keys(row);
  return Number(db.prepare(`INSERT INTO patient_discounts (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...Object.values(row)).lastInsertRowid);
};
const money = (inv) => [inv.subtotal, inv.discount_amount, inv.total_amount];

test('без выбора — как 3.21: VIP 10 % на 100 000 → 90 000, причина «Скидка группы «VIP» — 10%», доля врача 1', () => {
  const db = seed();
  const pid = patient(db, { category: vip(db, 10) });
  const { vid, ids } = visitWith(db, pid, [30]);
  const inv = call('create_invoice_for_visit', db, { visit_id: vid, visit_service_ids: ids, discount_amount: 0 }).invoice;
  assert.deepEqual(money(inv), [100000, 10000, 90000]);
  assert.equal(inv.discount_source, null);
  assert.equal(inv.discount_note, 'Скидка группы «VIP» — 10%');
  assert.equal(inv.doctor_discount_share, 1);
});

test('«Скидка группы»: ровно скидка группы — присланное сверх неё не берётся', () => {
  const db = seed();
  const pid = patient(db, { category: vip(db, 10) });
  const { vid, ids } = visitWith(db, pid, [30]);
  const inv = call('create_invoice_for_visit', db, { visit_id: vid, visit_service_ids: ids, discount_amount: 99999, discount_choice: 'group' }).invoice;
  assert.deepEqual(money(inv), [100000, 10000, 90000]);
  assert.equal(inv.discount_source, 'group');
});

test('«Без скидки» у пациента VIP: 100 000 к оплате; правка строк кассой пол группы не возвращает', () => {
  const db = seed();
  const pid = patient(db, { category: vip(db, 10) });
  const { vid, ids } = visitWith(db, pid, [30]);
  const inv = call('create_invoice_for_visit', db, { visit_id: vid, visit_service_ids: ids, discount_amount: 0, discount_choice: 'none' }).invoice;
  assert.deepEqual(money(inv), [100000, 0, 100000]);
  assert.equal(inv.discount_source, 'none');
  assert.equal(inv.discount_note, null);
  call('cashier_line_add', db, { invoice_id: inv.id, service_id: 40, doctor_id: 20 });
  const after = db.prepare('SELECT * FROM invoices WHERE id = ?').get(inv.id);
  assert.deepEqual(money(after), [140000, 0, 140000], 'пол группы вернулся при правке строк');
});

test('промокод «ЛЕТО» 15 % у пациента VIP — одна скидка: 15 000, а не 10 % + 15 %; больше стоимости промокода не берётся', () => {
  const db = seed();
  const pid = patient(db, { category: vip(db, 10) });
  const id = promo(db, { name: 'ЛЕТО', percent: 15 });
  const a = visitWith(db, pid, [30]);
  const inv = call('create_invoice_for_visit', db, { visit_id: a.vid, visit_service_ids: a.ids, discount_amount: 15000, discount_choice: 'promo', discount_id: id }).invoice;
  assert.deepEqual(money(inv), [100000, 15000, 85000]);
  assert.equal(inv.discount_source, 'promo:' + id);
  assert.equal(inv.discount_note, 'Промокод «ЛЕТО» — 15%');
  const b = visitWith(db, pid, [30]);
  const inv2 = call('create_invoice_for_visit', db, { visit_id: b.vid, visit_service_ids: b.ids, discount_amount: 50000, discount_choice: 'promo', discount_id: id }).invoice;
  assert.equal(inv2.discount_amount, 15000, 'присланное больше стоимости промокода');
});

test('промокод суммой 5 000 только на УЗИ: в счёте УЗИ + ОАК — 5 000; без УЗИ — отказ словами', () => {
  const db = seed();
  const pid = patient(db);
  const id = promo(db, { name: 'УЗИ-5000', amount: 5000, service_ids: '[31]' });
  const a = visitWith(db, pid, [31, 40]);
  const inv = call('create_invoice_for_visit', db, { visit_id: a.vid, visit_service_ids: a.ids, discount_amount: 5000, discount_choice: 'promo', discount_id: id }).invoice;
  assert.deepEqual(money(inv), [90000, 5000, 85000]);
  const b = visitWith(db, pid, [40]);
  assert.throws(() => call('create_invoice_for_visit', db, { visit_id: b.vid, visit_service_ids: b.ids, discount_amount: 5000, discount_choice: 'promo', discount_id: id }),
    (e) => e.status === 400 && /действует на другие услуги/.test(e.message));
});

test('промокод: истёк, чужая группа, карта вместо промокода — отказ; счёта нет', () => {
  const db = seed();
  const pid = patient(db, { category: vip(db, 10) });
  const old = promo(db, { name: 'Истёк', percent: 20, valid_until: '2020-01-01' });
  const other = promo(db, { name: 'Другим', percent: 20, category_id: vip(db, 5) });
  const card = promo(db, { name: 'Подарок', kind: 'gift_card', amount: 100000 });
  const { vid, ids } = visitWith(db, pid, [30]);
  assert.throws(() => call('create_invoice_for_visit', db, { visit_id: vid, visit_service_ids: ids, discount_amount: 1, discount_choice: 'promo', discount_id: old }), /Срок промокода «Истёк» истёк/);
  assert.throws(() => call('create_invoice_for_visit', db, { visit_id: vid, visit_service_ids: ids, discount_amount: 1, discount_choice: 'promo', discount_id: other }), /другой группы/);
  assert.throws(() => call('create_invoice_for_visit', db, { visit_id: vid, visit_service_ids: ids, discount_amount: 1, discount_choice: 'promo', discount_id: card }), /Промокод не найден/);
  assert.throws(() => call('create_invoice_for_visit', db, { visit_id: vid, visit_service_ids: ids, discount_choice: 'всё сразу' }), /Скидка выбрана неверно/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM invoices').get().n, 0);
});

test('«вручную»: не меньше скидки группы (как 3.21) — 20 000 → 20 000, 5 000 → 10 000', () => {
  const db = seed();
  const pid = patient(db, { category: vip(db, 10) });
  const a = visitWith(db, pid, [30]);
  const inv = call('create_invoice_for_visit', db, { visit_id: a.vid, visit_service_ids: a.ids, discount_amount: 20000, discount_choice: 'manual' }).invoice;
  assert.deepEqual(money(inv), [100000, 20000, 80000]);
  assert.equal(inv.discount_note, 'Скидка вручную');
  const b = visitWith(db, pid, [30]);
  const inv2 = call('create_invoice_for_visit', db, { visit_id: b.vid, visit_service_ids: b.ids, discount_amount: 5000, discount_choice: 'manual' }).invoice;
  assert.deepEqual(money(inv2), [100000, 10000, 90000]);
  assert.equal(inv2.discount_note, 'Скидка группы «VIP» — 10%');
});

test('счёт плательщику скидки группы не получает и при выборе «группа»; врач выбор не задаёт — пол группы', () => {
  const db = seed();
  const pid = patient(db, { category: vip(db, 10) });
  const payer = Number(db.prepare("INSERT INTO payers (name, kind, active) VALUES ('Страховая', 'insurance', 1)").run().lastInsertRowid);
  const a = visitWith(db, pid, [30]);
  const inv = call('create_invoice_for_visit', db, { visit_id: a.vid, visit_service_ids: a.ids, discount_amount: 0, payer_id: payer, discount_choice: 'group' }).invoice;
  assert.deepEqual(money(inv), [100000, 0, 100000]);
  const b = visitWith(db, pid, [30], { by: 20 });
  const inv2 = call('create_invoice_for_visit', db, { visit_id: b.vid, visit_service_ids: b.ids, discount_amount: 0, discount_choice: 'none' }, doctor).invoice;
  assert.deepEqual(money(inv2), [100000, 10000, 90000], 'врач снял скидку группы');
});

test('переключатель «Скидка уменьшает долю врача»: у группы выключен — доля 0; у промокода выключен — доля 0', () => {
  const db = seed();
  const pid = patient(db, { category: vip(db, 10, 0) });
  const a = visitWith(db, pid, [30]);
  assert.equal(call('create_invoice_for_visit', db, { visit_id: a.vid, visit_service_ids: a.ids, discount_amount: 0, discount_choice: 'group' }).invoice.doctor_discount_share, 0);
  const id = promo(db, { name: 'ДРУГ', percent: 15, reduces_doctor_share: 0 });
  const b = visitWith(db, pid, [30]);
  assert.equal(call('create_invoice_for_visit', db, { visit_id: b.vid, visit_service_ids: b.ids, discount_amount: 15000, discount_choice: 'promo', discount_id: id }).invoice.doctor_discount_share, 0);
  const c = visitWith(db, pid, [30]);
  assert.equal(call('create_invoice_for_visit', db, { visit_id: c.vid, visit_service_ids: c.ids, discount_amount: 0, discount_choice: 'none' }).invoice.doctor_discount_share, 1);
});

test('дописывание в счёт визита: часть «группа» — в тот же счёт; часть с промокодом — новым счётом', () => {
  const db = seed();
  const pid = patient(db, { category: vip(db, 10) });
  const { vid, ids } = visitWith(db, pid, [30]);
  const first = call('create_invoice_for_visit', db, { visit_id: vid, visit_service_ids: ids, discount_amount: 0, discount_choice: 'group' }).invoice;
  const l2 = Number(db.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, created_by) VALUES (?, 40, 20, 1, 40000, 40000, 'added', 1)").run(vid).lastInsertRowid);
  const r2 = call('create_invoice_for_visit', db, { visit_id: vid, visit_service_ids: [l2], discount_amount: 4000, discount_choice: 'group' });
  assert.equal(r2.appended, true);
  assert.deepEqual(money(db.prepare('SELECT * FROM invoices WHERE id = ?').get(first.id)), [140000, 14000, 126000]);
  const id = promo(db, { name: 'ЛЕТО', percent: 15 });
  const l3 = Number(db.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, created_by) VALUES (?, 31, 20, 1, 50000, 50000, 'added', 1)").run(vid).lastInsertRowid);
  const r3 = call('create_invoice_for_visit', db, { visit_id: vid, visit_service_ids: [l3], discount_amount: 7500, discount_choice: 'promo', discount_id: id });
  assert.ok(!r3.appended);
  assert.deepEqual(money(r3.invoice), [50000, 7500, 42500]);
});
