// V3120_FIX — «врач и медсестра выдают пациенту со СВОЕЙ полки» (владелец 27.09).
//
// Вопрос владельца: «подтвердите, что выдача товара врачом или медсестрой идёт
// с их собственной полки (личный подотчёт, кабинет, отдел); если нет —
// исправьте». Правило HOLDINGS_FIRST_V1: свой подотчёт → кабинет → отдел →
// склад, и никогда — чужой карман или чужой отдел.
//
// Каждая дверь, через которую товар уходит пациенту, проиграна здесь через
// НАСТОЯЩИЕ обработчики (getRpc), как их зовёт экран, для врача, медсестры и
// старшей медсестры (надстройка поверх медсестры):
//   dispense_visit_item      — кабинет врача (service-workspace), окно визита
//                              (visit-modal), процедуры (procedures);
//   dispense_item            — счёт визита (visit-bill);
//   dispense_admission_item  — консоль койки «Товары для пациента» (ward-beds),
//                              история болезни «Добавить расход» (case-workspace);
//   treatment_admin_mark     — отметка «введено» в листе назначений (MAR);
//   dispense_from_holding    — амбулаторная вкладка медсестры (mar-outpatients).
//
// Где у сотрудника «свой кабинет» и «свой отдел»: users.room_id и
// users.department_id (карточка сотрудника). У визита кабинет приёма —
// visits.room_id, его отдел — rooms.department_id; у койки — отдел палаты
// (wards.department_id).
//
// OWN_SHELF_ONLY_V1 (владелец 28.09) — склад в конце цепочки остался только
// у администратора и склада. Врачу и медсестре своих полок не хватило — отказ
// «Нет на ваших полках … Запросите у склада.», склад не добирает (полная
// матрица «дверь × роль» — own-shelf-only.test.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { getRpc } from './index.js';
import { treatmentOrderCreate, treatmentAdminMark } from './treatment-orders.js';

const U = {
  admin: { id: 1, role: 'admin' },
  inv: { id: 2, role: 'inventory' },
  doctor: { id: 10, role: 'doctor' },
  nurse: { id: 11, role: 'nurse' },
  senior: { id: 12, role: 'nurse', extra_roles: ['senior_nurse'] },
  other: { id: 13, role: 'nurse' },
};
const P = 1;   // Бинт, штука = базовая единица

function seed() {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO departments (id, name) VALUES (30, 'Терапия'), (31, 'Хирургия')").run();
  db.prepare("INSERT INTO rooms (id, name, department_id) VALUES (20, 'Кабинет врача', 30), (21, 'Процедурный', 30), (22, 'Перевязочная', 31)").run();
  const u = db.prepare('INSERT INTO users (id, username, password_hash, role, full_name, room_id, department_id, extra_roles) VALUES (?,?,?,?,?,?,?,?)');
  u.run(1, 'admin', 'x', 'admin', 'Админ', null, null, '[]');
  u.run(2, 'inv', 'x', 'inventory', 'Кладовщик', null, null, '[]');
  u.run(10, 'doc', 'x', 'doctor', 'Врач Азиз', 20, 30, '[]');
  u.run(11, 'nurse', 'x', 'nurse', 'Медсестра Ирина', 21, 30, '[]');
  u.run(12, 'senior', 'x', 'nurse', 'Старшая Ольга', null, 31, '["senior_nurse"]');
  u.run(13, 'other', 'x', 'nurse', 'Медсестра Чужая', 22, 31, '[]');
  db.prepare("INSERT INTO products (id, name, unit, base_unit, sale_price, on_hand, avg_cost, is_drug) VALUES (1, 'Бинт', 'шт', 'шт', 1000, 100, 400, 1)").run();
  db.prepare("INSERT INTO patients (id, full_name, mrn) VALUES (1, 'Иванов Иван', 'EM-1')").run();
  db.prepare("INSERT INTO wards (id, name, department_id) VALUES (1, 'Палата 1', 30)").run();
  db.prepare("INSERT INTO beds (id, code, ward_id) VALUES (1, '1-1', 1)").run();
  db.prepare("INSERT INTO services (id, name, price) VALUES (1, 'Инъекция', 20000)").run();
  return db;
}
const rpc = (db, name, args, user) => getRpc(name)(db, args, user);
const onHand = (db) => db.prepare('SELECT on_hand FROM products WHERE id = ?').get(P).on_hand;
const held = (db, type, id) => (db.prepare('SELECT qty FROM stock_holdings WHERE holder_type = ? AND holder_id = ? AND product_id = ?').get(type, id, P) || { qty: 0 }).qty;
const put = (db, type, id, qty) => rpc(db, 'issue_stock_lines', { holder: { type, id }, lines: [{ product_id: P, qty, unit: 'base' }] }, U.inv);
const visit = (db, roomId = 20) => Number(db.prepare("INSERT INTO visits (patient_id, doctor_id, room_id, visit_date, status) VALUES (1, 10, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'), 'arrived')").run(roomId).lastInsertRowid);
const admission = (db) => Number(db.prepare("INSERT INTO admissions (patient_id, status, ward_id, bed_id, doctor_id, attending_doctor_id) VALUES (1, 'active', 1, 1, 10, 10)").run().lastInsertRowid);
const src = (r) => (r.sources || []).map((s) => `${s.type}${s.id == null ? '' : ':' + s.id}=${s.qty}`).join(' + ');

// Двери визита: одна функция на каждую — как её зовёт экран.
const VISIT_DOORS = {
  dispense_visit_item: (db, v, qty, user) => rpc(db, 'dispense_visit_item', { p_visit_id: v, p_item_id: P, p_qty: qty, p_doctor_id: 10 }, user),
  dispense_item: (db, v, qty, user) => rpc(db, 'dispense_item', { visit_id: v, product_id: P, quantity: qty }, user),
  dispense_from_holding: (db, v, qty, user) => rpc(db, 'dispense_from_holding', { product_id: P, quantity: qty, visit_id: v }, user),
};
const ADM_DOORS = {
  dispense_admission_item: (db, a, qty, user) => rpc(db, 'dispense_admission_item', { p_admission_id: a, p_item_id: P, p_qty: qty }, user),
  dispense_from_holding: (db, a, qty, user) => rpc(db, 'dispense_from_holding', { product_id: P, quantity: qty, admission_id: a }, user),
};

// ─── 1. Порядок: свой подотчёт → кабинет → отдел, на каждой двери ────────────

// OWN_SHELF_ONLY_V1 — своих полок не хватило: отказ, склад не добирает.
const refused = (fn) => assert.throws(fn, (e) => e.status === 400 && e.code === 'own_shelf_short');

for (const [door, call] of Object.entries(VISIT_DOORS)) {
  test(`${door} (визит), ВРАЧ: свой подотчёт → свой кабинет → отдел; пусто — отказ, а не склад`, () => {
    const db = seed();
    const v = visit(db, 20);
    put(db, 'staff', 10, 1); put(db, 'room', 20, 2); put(db, 'department', 30, 3);
    put(db, 'staff', 13, 5); put(db, 'room', 22, 5); put(db, 'department', 31, 5);   // чужое — не трогать
    assert.equal(onHand(db), 79);
    assert.equal(src(call(db, v, 1, U.doctor)), 'staff:10=1');
    assert.equal(src(call(db, v, 2, U.doctor)), 'room:20=2');
    assert.equal(src(call(db, v, 3, U.doctor)), 'department:30=3');
    refused(() => call(db, v, 1, U.doctor));
    assert.equal(onHand(db), 79, 'склад не тронут: врачу он не источник');
    assert.deepEqual([held(db, 'staff', 13), held(db, 'room', 22), held(db, 'department', 31)], [5, 5, 5], 'чужое не тронуто');
  });

  test(`${door} (визит), МЕДСЕСТРА: свой подотчёт → кабинет приёма → свой процедурный → отдел; чужое — никогда`, () => {
    const db = seed();
    const v = visit(db, 20);
    put(db, 'staff', 11, 1); put(db, 'room', 20, 1); put(db, 'room', 21, 1); put(db, 'department', 30, 1);
    put(db, 'staff', 13, 5); put(db, 'staff', 10, 5); put(db, 'room', 22, 5); put(db, 'department', 31, 5);
    // На 5 своих полок не хватает — отказ; на 4 — частичное покрытие по всей цепочке.
    refused(() => call(db, v, 5, U.nurse));
    const r = call(db, v, 4, U.nurse);
    assert.equal(src(r), 'staff:11=1 + room:20=1 + room:21=1 + department:30=1');
    assert.deepEqual([held(db, 'staff', 13), held(db, 'staff', 10), held(db, 'room', 22), held(db, 'department', 31)], [5, 5, 5, 5],
      'ни личный подотчёт врача или другой медсестры, ни чужой кабинет и отдел не тронуты');
  });

  test(`${door} (визит), СТАРШАЯ МЕДСЕСТРА без кабинета: свой подотчёт → кабинет приёма → его отдел → свой отдел`, () => {
    const db = seed();
    const v = visit(db, 20);
    put(db, 'staff', 12, 1); put(db, 'room', 20, 1); put(db, 'department', 30, 1); put(db, 'department', 31, 1);
    put(db, 'room', 21, 5);   // процедурный — не её кабинет и не кабинет приёма
    refused(() => call(db, v, 5, U.senior));
    assert.equal(src(call(db, v, 4, U.senior)), 'staff:12=1 + room:20=1 + department:30=1 + department:31=1');
    assert.equal(held(db, 'room', 21), 5);
  });
}

for (const [door, call] of Object.entries(ADM_DOORS)) {
  test(`${door} (койка), ВРАЧ и МЕДСЕСТРА: свой подотчёт → свой кабинет → отдел палаты → свой отдел`, () => {
    const db = seed();
    const a = admission(db);
    put(db, 'staff', 10, 1); put(db, 'room', 20, 1); put(db, 'department', 30, 1);
    put(db, 'staff', 11, 1); put(db, 'room', 21, 1);
    put(db, 'staff', 13, 5); put(db, 'room', 22, 5); put(db, 'department', 31, 5);
    assert.equal(src(call(db, a, 2, U.doctor)), 'staff:10=1 + room:20=1');
    refused(() => call(db, a, 4, U.nurse));
    assert.equal(src(call(db, a, 3, U.nurse)), 'staff:11=1 + room:21=1 + department:30=1');
    assert.deepEqual([held(db, 'staff', 13), held(db, 'room', 22), held(db, 'department', 31)], [5, 5, 5]);
  });

  test(`${door} (койка), СТАРШАЯ МЕДСЕСТРА другого отдела: отдел палаты, потом свой отдел`, () => {
    const db = seed();
    const a = admission(db);
    put(db, 'department', 30, 1); put(db, 'department', 31, 1);
    refused(() => call(db, a, 3, U.senior));
    assert.equal(src(call(db, a, 2, U.senior)), 'department:30=1 + department:31=1');
  });
}

// ─── 2. Отмена возвращает КАЖДУЮ часть на её полку ────────────────────────────

test('отмена выдачи по частям: каждая часть — на свою полку (визит и койка, все двери отмены)', () => {
  const db = seed();
  const v = visit(db, 20);
  const a = admission(db);
  put(db, 'staff', 11, 1); put(db, 'room', 21, 1); put(db, 'department', 30, 1);
  const r1 = VISIT_DOORS.dispense_visit_item(db, v, 3, U.nurse);
  assert.equal(src(r1), 'staff:11=1 + room:21=1 + department:30=1');
  rpc(db, 'void_dispensed_visit_item', { p_line: r1.visit_service_id }, U.nurse);
  assert.deepEqual([held(db, 'staff', 11), held(db, 'room', 21), held(db, 'department', 30), onHand(db)], [1, 1, 1, 97]);

  const r2 = VISIT_DOORS.dispense_from_holding(db, v, 3, U.nurse);
  rpc(db, 'void_holding_dispense', { visit_service_id: r2.line_id }, U.nurse);
  assert.deepEqual([held(db, 'staff', 11), held(db, 'room', 21), held(db, 'department', 30), onHand(db)], [1, 1, 1, 97]);

  const r3 = ADM_DOORS.dispense_admission_item(db, a, 3, U.nurse);
  rpc(db, 'void_dispensed_admission_item', { p_line: r3.line_id }, U.nurse);
  assert.deepEqual([held(db, 'staff', 11), held(db, 'room', 21), held(db, 'department', 30), onHand(db)], [1, 1, 1, 97]);

  // Часть со склада (выдал администратор) при отмене возвращается на склад.
  const r4 = VISIT_DOORS.dispense_visit_item(db, v, 2, U.admin);
  assert.equal(src(r4), 'department:30=1 + warehouse=1');
  rpc(db, 'void_dispensed_visit_item', { p_line: r4.visit_service_id }, U.admin);
  assert.deepEqual([held(db, 'department', 30), onHand(db)], [1, 97]);
});

// ─── 3. Отметка «введено» в листе назначений ───────────────────────────────────

test('MAR: отметка «введено» медсестрой берёт дозу с её полки, а не со склада и не у соседки', () => {
  const db = seed();
  const a = admission(db);
  put(db, 'staff', 11, 1); put(db, 'staff', 13, 5);
  const order = treatmentOrderCreate(db, {
    admission_id: a, kind: 'med', name: 'Бинт', dose: '1', route: 'в/м', freq_code: '1x',
    starts_on: '2026-09-04', days: 1, service_id: 1, stock_item_id: P,
  }, U.doctor).order;
  const m = treatmentAdminMark(db, { order_id: order.id, date: '2026-09-04', slot: 10, status: 'given' }, U.nurse);
  assert.equal(m.stock.status, 'ok', JSON.stringify(m.warnings));
  assert.equal(held(db, 'staff', 11), 0, 'доза — из её подотчёта');
  assert.equal(held(db, 'staff', 13), 5, 'чужой подотчёт не тронут');
  assert.equal(onHand(db), 94, 'склад не тронут');
});

// ─── 4. Амбулаторная дверь медсестры: названный источник — только свой ────────

test('dispense_from_holding: чужой личный подотчёт, чужой кабинет и чужой отдел — отказ 403, ничего не списано', () => {
  const db = seed();
  const v = visit(db, 20);
  put(db, 'staff', 13, 5); put(db, 'room', 22, 5); put(db, 'department', 31, 5); put(db, 'staff', 10, 5);
  for (const holder of [{ type: 'staff', id: 13 }, { type: 'staff', id: 10 }, { type: 'room', id: 22 }, { type: 'department', id: 31 }]) {
    assert.throws(() => rpc(db, 'dispense_from_holding', { holder, product_id: P, quantity: 1, visit_id: v }, U.nurse),
      (e) => e.status === 403, JSON.stringify(holder));
  }
  assert.deepEqual([held(db, 'staff', 13), held(db, 'room', 22), held(db, 'department', 31), held(db, 'staff', 10), onHand(db)], [5, 5, 5, 5, 80]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM visit_services').get().n, 0);
});

test('dispense_from_holding: названа своя полка — берётся первой, недостача добирается по цепочке, а не отказом', () => {
  const db = seed();
  const v = visit(db, 20);
  put(db, 'staff', 11, 1); put(db, 'room', 21, 2); put(db, 'department', 30, 1);
  const r = rpc(db, 'dispense_from_holding', { holder: { type: 'room', id: 21 }, product_id: P, quantity: 4, visit_id: v }, U.nurse);
  assert.equal(src(r), 'room:21=2 + staff:11=1 + department:30=1');
  assert.equal(onHand(db), 96, 'склад не тронут');
});

test('dispense_from_holding: выбран «Склад», а своё есть — сначала своё; склад — только остаток и только администратору', () => {
  const db = seed();
  const v = visit(db, 20);
  put(db, 'staff', 11, 1); put(db, 'staff', 1, 1);
  // OWN_SHELF_ONLY_V1 — медсестре своего мало: отказ, склад не добирает.
  refused(() => rpc(db, 'dispense_from_holding', { holder: { type: 'warehouse' }, product_id: P, quantity: 3, visit_id: v }, U.nurse));
  const r = rpc(db, 'dispense_from_holding', { holder: { type: 'warehouse' }, product_id: P, quantity: 3, visit_id: v }, U.admin);
  assert.equal(src(r), 'staff:1=1 + warehouse=2');
});

test('dispense_from_holding: админ и кладовщик могут назвать любой кабинет или отдел, но не чужой карман', () => {
  const db = seed();
  const v = visit(db, 20);
  put(db, 'room', 22, 2); put(db, 'department', 31, 2); put(db, 'staff', 13, 2);
  assert.equal(src(rpc(db, 'dispense_from_holding', { holder: { type: 'room', id: 22 }, product_id: P, quantity: 1, visit_id: v }, U.admin)), 'room:22=1');
  assert.equal(src(rpc(db, 'dispense_from_holding', { holder: { type: 'department', id: 31 }, product_id: P, quantity: 1, visit_id: v }, U.inv)), 'department:31=1');
  assert.throws(() => rpc(db, 'dispense_from_holding', { holder: { type: 'staff', id: 13 }, product_id: P, quantity: 1, visit_id: v }, U.admin), (e) => e.status === 403);
});

// ─── 5. Что экран предлагает: только свои полки, по порядку цепочки ───────────

test('holdings_list reachable: только полки этой выдачи, в порядке цепочки, чужих нет', () => {
  const db = seed();
  const v = visit(db, 20);
  const a = admission(db);
  put(db, 'staff', 11, 1); put(db, 'room', 20, 1); put(db, 'room', 21, 1); put(db, 'department', 30, 1);
  put(db, 'staff', 13, 5); put(db, 'staff', 10, 5); put(db, 'room', 22, 5); put(db, 'department', 31, 5);
  const byVisit = rpc(db, 'holdings_list', { reachable: true, visit_id: v }, U.nurse).holdings;
  assert.deepEqual(byVisit.map((h) => `${h.holder_type}:${h.holder_id}`), ['staff:11', 'room:20', 'room:21', 'department:30']);
  const byAdm = rpc(db, 'holdings_list', { reachable: true, admission_id: a }, U.nurse).holdings;
  assert.deepEqual(byAdm.map((h) => `${h.holder_type}:${h.holder_id}`), ['staff:11', 'room:21', 'department:30']);
  // Без места — свой подотчёт, свой кабинет, свой отдел.
  const bare = rpc(db, 'holdings_list', { reachable: true }, U.senior).holdings;
  assert.deepEqual(bare.map((h) => `${h.holder_type}:${h.holder_id}`), ['department:31']);
});
