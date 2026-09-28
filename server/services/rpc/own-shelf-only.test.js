// OWN_SHELF_ONLY_V1 — «выдача пациенту только со своих полок» (владелец 28.09).
//
// Владелец: «in the doctor's cabinet or in the procedures, items should be
// dispensed from their shelf not from the procurement overall. Also in the
// stationary too.» Решение (спросили): со склада напрямую выдают ТОЛЬКО
// администратор и склад. Врач, главный врач, медсестра, старшая медсестра,
// лаборант и своя роль клиники на их основе — только со своих полок
// (подотчёт → кабинет → отдел); не хватило — отказ «Нет на ваших полках …
// Запросите у склада.», и ничего не записано.
//
// Каждая дверь, через которую товар уходит пациенту, проиграна здесь через
// НАСТОЯЩИЕ обработчики (getRpc) для каждой роли:
//   dispense_visit_item      — кабинет врача, окно визита, процедуры;
//   dispense_item            — счёт визита;
//   dispense_admission_item  — консоль койки, история болезни «Добавить расход»;
//   dispense_from_holding    — вкладка медсестры (амбулатория и стационар);
//   treatment_admin_mark     — отметка «введено» в листе назначений.
//
// Ревью F6 — ЛИСТ НАЗНАЧЕНИЙ — ИСКЛЮЧЕНИЕ: отметка «введено» (и расход сверх
// дозы) не отказывается никогда. Дозы нет на полках — отметка записана, пациенту
// начислено как при обычной выдаче, склад не тронут, а остаток ждёт склада в
// «не списано со склада» (подробно — mar-pending-writeoff.test.js).
//
// Ревью F5 — правило — ПЕРЕКЛЮЧАТЕЛЬ клиники «Только со своих полок» (мигр.
// 226), выключенный по умолчанию: «Clinics keep working as today». Этот файл —
// спецификация ВКЛЮЧЁННОГО правила, и seed() его включает. Выключенное (всё как
// в 3.12.1) — own-shelf-switch.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { compile } from '../../db/query-compiler.js';
import { getRpc } from './index.js';
import { treatmentOrderCreate, treatmentAdminMark } from './treatment-orders.js';
import { mayDispenseFromWarehouse, OWN_SHELF_SHORT } from './inventory.js';

const U = {
  admin:    { id: 1, role: 'admin' },
  inv:      { id: 2, role: 'inventory' },
  adminDoc: { id: 3, role: 'doctor', extra_roles: ['admin'] },           // ADMIN_DOCTOR_V1 — администратор, который ещё и принимает
  doctor:   { id: 10, role: 'doctor' },
  nurse:    { id: 11, role: 'nurse' },
  senior:   { id: 12, role: 'nurse', extra_roles: ['senior_nurse'] },
  other:    { id: 13, role: 'nurse' },
  head:     { id: 14, role: 'doctor', extra_roles: ['head_doctor'] },
  lab:      { id: 15, role: 'lab' },
  custom:   { id: 16, role: 'nurse', custom_role_code: 'proc_nurse' },  // своя роль на основе медсестры
  invDoc:   { id: 17, role: 'doctor', extra_roles: ['inventory'] },       // врач, которому дали и склад
};
const CLINICAL = ['doctor', 'nurse', 'senior', 'head', 'custom'];
const WAREHOUSE = ['admin', 'inv', 'adminDoc'];
const P = 1;   // Бинт, штука = базовая единица
const K = 2;   // Кеторол: коробка по 10 ампул

function seed() {
  const db = openDb(':memory:'); migrate(db);
  db.prepare('UPDATE stock_settings SET own_shelf_only = 1 WHERE id = 1').run();   // ревью F5 — правило включено
  db.prepare("INSERT INTO departments (id, name) VALUES (30, 'Терапия'), (31, 'Хирургия')").run();
  db.prepare("INSERT INTO rooms (id, name, department_id) VALUES (20, 'Кабинет врача', 30), (21, 'Процедурный', 30), (22, 'Перевязочная', 31)").run();
  db.prepare("INSERT INTO custom_roles (code, name, base_role, active) VALUES ('proc_nurse', 'Процедурная медсестра', 'nurse', 1)").run();
  db.prepare(`INSERT INTO role_permissions (role, permissions) VALUES ('proc_nurse', '{"sections":["patients","procedures","beds"]}')`).run();
  const u = db.prepare('INSERT INTO users (id, username, password_hash, role, full_name, room_id, department_id, extra_roles, custom_role_code) VALUES (?,?,?,?,?,?,?,?,?)');
  u.run(1, 'admin', 'x', 'admin', 'Админ', null, null, '[]', null);
  u.run(2, 'inv', 'x', 'inventory', 'Кладовщик', null, null, '[]', null);
  u.run(3, 'admdoc', 'x', 'doctor', 'Главный администратор-врач', null, null, '["admin"]', null);
  u.run(10, 'doc', 'x', 'doctor', 'Врач Азиз', 20, 30, '[]', null);
  u.run(11, 'nurse', 'x', 'nurse', 'Медсестра Ирина', 21, 30, '[]', null);
  u.run(12, 'senior', 'x', 'nurse', 'Старшая Ольга', null, 31, '["senior_nurse"]', null);
  u.run(13, 'other', 'x', 'nurse', 'Медсестра Чужая', 22, 31, '[]', null);
  u.run(14, 'head', 'x', 'doctor', 'Главный врач', null, 30, '["head_doctor"]', null);
  u.run(15, 'lab', 'x', 'lab', 'Лаборант', null, null, '[]', null);
  u.run(16, 'proc', 'x', 'nurse', 'Процедурная Нигора', 21, 30, '[]', 'proc_nurse');
  u.run(17, 'invdoc', 'x', 'doctor', 'Врач-кладовщик', null, null, '["inventory"]', null);
  db.prepare("INSERT INTO products (id, name, unit, base_unit, sale_price, on_hand, avg_cost, is_drug) VALUES (1, 'Бинт', 'шт', 'шт', 1000, 100, 400, 1)").run();
  db.prepare("INSERT INTO products (id, name, unit, base_unit, consumption_unit, consumption_factor, sale_price, on_hand, avg_cost, is_drug) VALUES (2, 'Кеторол', 'уп', 'уп', 'амп', 10, 50000, 10, 20000, 1)").run();
  db.prepare("INSERT INTO patients (id, full_name, mrn) VALUES (1, 'Иванов Иван', 'EM-1')").run();
  db.prepare("INSERT INTO wards (id, name, department_id) VALUES (1, 'Палата 1', 30)").run();
  db.prepare("INSERT INTO beds (id, code, ward_id) VALUES (1, '1-1', 1)").run();
  db.prepare("INSERT INTO services (id, name, price) VALUES (1, 'Инъекция', 20000)").run();
  return db;
}
const rpc = (db, name, args, user) => getRpc(name)(db, args, user);
const onHand = (db, pid = P) => db.prepare('SELECT on_hand FROM products WHERE id = ?').get(pid).on_hand;
const held = (db, type, id, pid = P) => (db.prepare('SELECT qty FROM stock_holdings WHERE holder_type = ? AND holder_id = ? AND product_id = ?').get(type, id, pid) || { qty: 0 }).qty;
const put = (db, type, id, qty, pid = P) => rpc(db, 'issue_stock_lines', { holder: { type, id }, lines: [{ product_id: pid, qty, unit: 'base' }] }, U.inv);
const visit = (db, roomId = 20) => Number(db.prepare("INSERT INTO visits (patient_id, doctor_id, room_id, visit_date, status) VALUES (1, 10, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'), 'arrived')").run(roomId).lastInsertRowid);
const admission = (db) => Number(db.prepare("INSERT INTO admissions (patient_id, status, ward_id, bed_id, doctor_id, attending_doctor_id) VALUES (1, 'active', 1, 1, 10, 10)").run().lastInsertRowid);
const src = (r) => (r.sources || []).map((s) => `${s.type}${s.id == null ? '' : ':' + s.id}=${s.qty}`).join(' + ');
const count = (db, sql) => db.prepare(sql).get().n;
const patientLines = (db) => count(db, 'SELECT COUNT(*) n FROM visit_services') + count(db, 'SELECT COUNT(*) n FROM admission_services');
const patientMoves = (db) => count(db, "SELECT COUNT(*) n FROM stock_movements WHERE reference_type IN ('visit','admission','manual')");

const VISIT_DOORS = {
  dispense_visit_item: (db, v, qty, user, pid = P) => rpc(db, 'dispense_visit_item', { p_visit_id: v, p_item_id: pid, p_qty: qty, p_doctor_id: 10 }, user),
  dispense_item: (db, v, qty, user, pid = P) => rpc(db, 'dispense_item', { visit_id: v, product_id: pid, quantity: qty }, user),
  dispense_from_holding: (db, v, qty, user, pid = P) => rpc(db, 'dispense_from_holding', { product_id: pid, quantity: qty, visit_id: v }, user),
};
const ADM_DOORS = {
  dispense_admission_item: (db, a, qty, user, pid = P) => rpc(db, 'dispense_admission_item', { p_admission_id: a, p_item_id: pid, p_qty: qty }, user),
  dispense_from_holding: (db, a, qty, user, pid = P) => rpc(db, 'dispense_from_holding', { product_id: pid, quantity: qty, admission_id: a }, user),
};
const DOORS = [
  ...Object.entries(VISIT_DOORS).map(([name, call]) => ({ name: `${name} (визит)`, call, place: (db) => visit(db, 20) })),
  ...Object.entries(ADM_DOORS).map(([name, call]) => ({ name: `${name} (койка)`, call, place: admission })),
];

/** Отказ «нет на ваших полках»: 400, свой код, слова владельца. */
function assertOwnShelfRefusal(fn, message) {
  assert.throws(fn, (e) => {
    assert.equal(e.status, 400, e.message);
    assert.equal(e.code, OWN_SHELF_SHORT, e.message);
    if (message) assert.equal(e.message, message);
    return true;
  });
}

// ─── 0. Правило — одно: склад только администратору и складу ─────────────────

test('правило: со склада — только «Администратор» и «Склад» (основная или дополнительная); своя роль — по основе', () => {
  for (const k of WAREHOUSE) assert.equal(mayDispenseFromWarehouse(U[k]), true, k);
  assert.equal(mayDispenseFromWarehouse(U.invDoc), true, 'врач с дополнительной ролью «Склад»');
  for (const k of [...CLINICAL, 'lab', 'other']) assert.equal(mayDispenseFromWarehouse(U[k]), false, k);
  assert.equal(mayDispenseFromWarehouse({ id: 99, role: 'inventory', custom_role_code: 'sklad2' }), true, 'своя роль на основе склада');
  assert.equal(mayDispenseFromWarehouse(null), false, 'нет вошедшего — нет склада');
});

// ─── 1. Клинические роли: только свои полки на КАЖДОЙ двери ──────────────────

for (const door of DOORS) {
  for (const who of CLINICAL) {
    test(`${door.name}, ${who}: своя полка покрывает — выдано с неё, склад не тронут`, () => {
      const db = seed();
      const place = door.place(db);
      put(db, 'staff', U[who].id, 2);
      assert.equal(onHand(db), 98);
      const r = door.call(db, place, 2, U[who]);
      assert.equal(src(r), `staff:${U[who].id}=2`);
      assert.equal(onHand(db), 98, 'склад не тронут');
      assert.equal(held(db, 'staff', U[who].id), 0);
    });

    test(`${door.name}, ${who}: на полках не хватает — отказ «Нет на ваших полках», склад НЕ добирает, ничего не записано`, () => {
      const db = seed();
      const place = door.place(db);
      put(db, 'staff', U[who].id, 1);
      assertOwnShelfRefusal(() => door.call(db, place, 3, U[who]),
        'Нет на ваших полках: Бинт — нужно 3 шт, есть 1 шт. Запросите у склада.');
      assert.equal(onHand(db), 99, 'склад не тронут');
      assert.equal(held(db, 'staff', U[who].id), 1, 'своя полка не тронута');
      assert.equal(patientLines(db), 0, 'строки счёта нет');
      assert.equal(patientMoves(db), 0, 'движения на пациента нет');
    });

    test(`${door.name}, ${who}: на полках пусто — отказ «есть 0», хотя на складе 100`, () => {
      const db = seed();
      const place = door.place(db);
      assertOwnShelfRefusal(() => door.call(db, place, 1, U[who]),
        'Нет на ваших полках: Бинт — нужно 1 шт, есть 0 шт. Запросите у склада.');
      assert.equal(onHand(db), 100);
      assert.equal(patientLines(db), 0);
    });
  }

  // ─── 2. Администратор и склад: склад — последним, как прежде ────────────────
  for (const who of WAREHOUSE) {
    test(`${door.name}, ${who}: своего нет — со склада; своего мало — своё и добор со склада`, () => {
      const db = seed();
      const place = door.place(db);
      assert.equal(src(door.call(db, place, 3, U[who])), 'warehouse=3');
      assert.equal(onHand(db), 97);
      put(db, 'staff', U[who].id, 1);
      assert.equal(src(door.call(db, place, 3, U[who])), `staff:${U[who].id}=1 + warehouse=2`);
      assert.equal(onHand(db), 94);
    });
  }
}

test('врач с дополнительной ролью «Склад» — склад доступен (роли считаются вместе с дополнительными)', () => {
  const db = seed();
  const v = visit(db, 20);
  assert.equal(src(VISIT_DOORS.dispense_visit_item(db, v, 2, U.invDoc)), 'warehouse=2');
});

test('лаборант: двери выдачи закрыты ролью, как и прежде (403, ничего не записано)', () => {
  const db = seed();
  const v = visit(db, 20);
  const a = admission(db);
  put(db, 'staff', U.lab.id, 5);
  for (const door of DOORS) {
    const place = door.name.includes('визит') ? v : a;
    assert.throws(() => door.call(db, place, 1, U.lab), (e) => e.status === 403, door.name);
  }
  assert.equal(held(db, 'staff', U.lab.id), 5);
  assert.equal(patientLines(db), 0);
});

// ─── 3. Цепочка своих полок по-прежнему собирает дозу по частям ───────────────

test('медсестра: доза собирается с нескольких своих полок; своих не хватило — отказ, склад не добирает', () => {
  const db = seed();
  const v = visit(db, 20);
  put(db, 'staff', 11, 1); put(db, 'room', 20, 1); put(db, 'room', 21, 1); put(db, 'department', 30, 1);
  put(db, 'staff', 13, 5); put(db, 'room', 22, 5); put(db, 'department', 31, 5);   // чужое
  const r = VISIT_DOORS.dispense_visit_item(db, v, 4, U.nurse);
  assert.equal(src(r), 'staff:11=1 + room:20=1 + room:21=1 + department:30=1');
  assertOwnShelfRefusal(() => VISIT_DOORS.dispense_visit_item(db, v, 1, U.nurse),
    'Нет на ваших полках: Бинт — нужно 1 шт, есть 0 шт. Запросите у склада.');
  assert.deepEqual([held(db, 'staff', 13), held(db, 'room', 22), held(db, 'department', 31)], [5, 5, 5], 'чужое не тронуто');
  assert.equal(onHand(db), 81, 'склад не тронут выдачей');
});

test('отказ считает ВСЕ свои полки: «есть» — сумма подотчёта, кабинета и отдела', () => {
  const db = seed();
  const a = admission(db);
  put(db, 'staff', 11, 1); put(db, 'room', 21, 1); put(db, 'department', 30, 1);
  assertOwnShelfRefusal(() => ADM_DOORS.dispense_admission_item(db, a, 5, U.nurse),
    'Нет на ваших полках: Бинт — нужно 5 шт, есть 3 шт. Запросите у склада.');
  assert.deepEqual([held(db, 'staff', 11), held(db, 'room', 21), held(db, 'department', 30)], [1, 1, 1]);
});

test('дверь медсестры говорит в единицах расхода: «нужно 3 амп, есть 1 амп»; счёт визита — в упаковках', () => {
  const db = seed();
  const v = visit(db, 20);
  put(db, 'staff', 11, 0.1, K);   // 1 ампула
  assertOwnShelfRefusal(() => VISIT_DOORS.dispense_from_holding(db, v, 3, U.nurse, K),
    'Нет на ваших полках: Кеторол — нужно 3 амп, есть 1 амп. Запросите у склада.');
  assertOwnShelfRefusal(() => VISIT_DOORS.dispense_item(db, v, 2, U.nurse, K),
    'Нет на ваших полках: Кеторол — нужно 2 уп, есть 0.1 уп. Запросите у склада.');
  assert.equal(onHand(db, K), 9.9);
});

test('dispense_from_holding: «Склад», названный врачом или медсестрой, значит «со своих полок» — склад не списывается', () => {
  const db = seed();
  const v = visit(db, 20);
  put(db, 'staff', 11, 1);
  const r = rpc(db, 'dispense_from_holding', { holder: { type: 'warehouse' }, product_id: P, quantity: 1, visit_id: v }, U.nurse);
  assert.equal(src(r), 'staff:11=1');
  assertOwnShelfRefusal(() => rpc(db, 'dispense_from_holding', { holder: { type: 'warehouse' }, product_id: P, quantity: 1, visit_id: v }, U.nurse));
  assert.equal(onHand(db), 99);
  // Администратор выбирает склад явно — и склад отдаёт.
  assert.equal(src(rpc(db, 'dispense_from_holding', { holder: { type: 'warehouse' }, product_id: P, quantity: 2, visit_id: v }, U.admin)), 'warehouse=2');
  assert.equal(onHand(db), 97);
});

test('отключённый товар у медсестры: пусто на полках — тот же отказ «запросите у склада», а не слова о складе', () => {
  const db = seed();
  const v = visit(db, 20);
  db.prepare('UPDATE products SET active = 0 WHERE id = ?').run(P);
  assertOwnShelfRefusal(() => VISIT_DOORS.dispense_visit_item(db, v, 1, U.nurse));
  // У администратора прежнее правило: со склада отключённый товар не выдаётся.
  assert.throws(() => VISIT_DOORS.dispense_visit_item(db, v, 1, U.admin), (e) => e.status === 400 && /отключён/.test(e.message));
});

// ─── 4. Отмена возвращает на свои полки ─────────────────────────────────────

test('отмена выдачи, собранной с нескольких своих полок, — каждая часть на свою полку, склад не меняется', () => {
  const db = seed();
  const v = visit(db, 20);
  const a = admission(db);
  put(db, 'staff', 11, 1); put(db, 'room', 21, 1);
  const r1 = VISIT_DOORS.dispense_visit_item(db, v, 2, U.nurse);
  assert.equal(src(r1), 'staff:11=1 + room:21=1');
  rpc(db, 'void_dispensed_visit_item', { p_line: r1.visit_service_id }, U.nurse);
  assert.deepEqual([held(db, 'staff', 11), held(db, 'room', 21), onHand(db)], [1, 1, 98]);
  const r2 = ADM_DOORS.dispense_from_holding(db, a, 2, U.nurse);
  rpc(db, 'void_holding_dispense', { admission_service_id: r2.line_id }, U.nurse);
  assert.deepEqual([held(db, 'staff', 11), held(db, 'room', 21), onHand(db)], [1, 1, 98]);
  const r3 = ADM_DOORS.dispense_admission_item(db, a, 2, U.nurse);
  rpc(db, 'void_dispensed_admission_item', { p_line: r3.line_id }, U.nurse);
  assert.deepEqual([held(db, 'staff', 11), held(db, 'room', 21), onHand(db)], [1, 1, 98]);
});

// ─── 5. Лист назначений: нет дозы на полках — отметка НЕ ставится ───────────

function medOrder(db, adm, over = {}) {
  return treatmentOrderCreate(db, {
    admission_id: adm, kind: 'med', name: 'Бинт', dose: '1', route: 'в/м', freq_code: '1x',
    starts_on: '2026-09-04', days: 1, service_id: 1, stock_item_id: P, ...over,
  }, U.doctor).order;
}
const markGiven = (db, order, user, extra) => treatmentAdminMark(db, {
  order_id: order.id, date: '2026-09-04', slot: 10, status: 'given', ...(extra ? { extra } : {}),
}, user);
const marks = (db) => count(db, 'SELECT COUNT(*) n FROM treatment_administrations');
function grant(db, role, key, level) {
  const row = db.prepare('SELECT permissions FROM role_permissions WHERE role = ?').get(role);
  const perms = row ? JSON.parse(row.permissions || '{}') : {};
  perms.grants = { ...(perms.grants || {}), [key]: level };
  if (row) db.prepare('UPDATE role_permissions SET permissions = ? WHERE role = ?').run(JSON.stringify(perms), role);
  else db.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?)').run(role, JSON.stringify(perms));
}

test('MAR, медсестра: доза с её полки или с отдела палаты — отметка стоит, склад не тронут', () => {
  const db = seed();
  const a = admission(db);
  put(db, 'staff', 11, 1);
  const m1 = markGiven(db, medOrder(db, a), U.nurse);
  assert.equal(m1.stock.status, 'ok', JSON.stringify(m1.warnings));
  assert.equal(held(db, 'staff', 11), 0);
  put(db, 'department', 30, 1);
  const m2 = markGiven(db, medOrder(db, a), U.nurse);
  assert.equal(m2.stock.status, 'ok');
  assert.equal(held(db, 'department', 30), 0, 'доза — с отдела палаты');
  assert.equal(onHand(db), 98, 'склад не тронут отметками');
});

// Ревью F6 (владелец 28.09) — было: отметка НЕ ставилась, отказ «запросите у
// склада». Стало: «The dose is recorded, so the patient's chart is never
// blocked. The drug is marked «не списано со склада», and the warehouse sees it
// in a list to settle.»
const pendingRows = (db) => db.prepare('SELECT status, kind, base_qty FROM stock_pending_writeoffs ORDER BY id').all();
for (const who of ['nurse', 'senior', 'custom']) {
  test(`MAR, ${who}: дозы нет на своих полках — «введено» записано и начислено, склад не тронут, «не списано со склада» (ревью F6)`, () => {
    const db = seed();
    const a = admission(db);
    const m = markGiven(db, medOrder(db, a), U[who]);
    assert.equal(m.administration.status, 'given');
    assert.equal(m.stock.status, 'pending');
    assert.equal(marks(db), 1, 'отметка есть');
    assert.equal(patientLines(db), 1, 'начислено один раз');
    assert.equal(onHand(db), 100, 'склад не тронут');
    assert.deepEqual(pendingRows(db), [{ status: 'pending', kind: 'dose', base_qty: 1 }]);
    // Склад выдал в отдел палаты — следующая доза уходит с полки, как обычно.
    put(db, 'department', 30, 1);
    const m2 = markGiven(db, medOrder(db, a), U[who]);
    assert.equal(m2.stock.status, 'ok');
    assert.equal(pendingRows(db).length, 1);
  });
}

test('MAR, старшая медсестра другого отдела: доза с отдела ПАЛАТЫ, а не со склада', () => {
  const db = seed();
  const a = admission(db);
  put(db, 'department', 31, 1);   // её собственный отдел
  const m = markGiven(db, medOrder(db, a), U.senior);
  assert.equal(m.stock.status, 'ok');
  assert.equal(held(db, 'department', 31), 0);
  assert.equal(onHand(db), 99);
});

test('MAR, лаборант с правом «отметки введения»: только свои полки; нехватка — «не списано со склада» (ревью F6), склад не тронут', () => {
  const db = seed();
  grant(db, 'lab', 'inpatient.marks', 'edit');
  const a = admission(db);
  assert.equal(markGiven(db, medOrder(db, a), U.lab).stock.status, 'pending');
  assert.equal(onHand(db), 100);
  put(db, 'staff', 15, 1);
  assert.equal(markGiven(db, medOrder(db, a), U.lab).stock.status, 'ok');
  assert.equal(held(db, 'staff', 15), 0);
  assert.equal(onHand(db), 99, 'склад отдал лаборанту одну при выдаче на полку; отметки его не трогают');
});

test('MAR, администратор: своих полок нет — доза со склада, как прежде', () => {
  const db = seed();
  const a = admission(db);
  const m = markGiven(db, medOrder(db, a), U.admin);
  assert.equal(m.stock.status, 'ok');
  assert.equal(onHand(db), 99);
});

test('MAR, администратор: пустой склад — по-прежнему предупреждение, а не отказ (отметка стоит)', () => {
  const db = seed();
  db.prepare('UPDATE products SET on_hand = 0 WHERE id = ?').run(P);
  const a = admission(db);
  const m = markGiven(db, medOrder(db, a), U.admin);
  assert.equal(m.stock.status, 'short');
  assert.equal(marks(db), 1);
});

test('MAR, медсестра: непонятная доза — по-прежнему предупреждение (отметка стоит)', () => {
  const db = seed();
  const a = admission(db);
  const m = markGiven(db, medOrder(db, a, { dose: 'по схеме' }), U.nurse);
  assert.equal(m.stock.status, 'skipped');
  assert.equal(marks(db), 1);
});

test('MAR, медсестра: расход сверх дозы не на полках — отметка стоит, доза с полки, расход — «не списано со склада» (ревью F6)', () => {
  const db = seed();
  const a = admission(db);
  put(db, 'staff', 11, 1);   // доза есть, лишней ампулы — нет
  const m = markGiven(db, medOrder(db, a), U.nurse, [{ product_id: P, qty: 1, billable: false, name: 'брак' }]);
  assert.equal(m.stock.status, 'pending');
  assert.equal(marks(db), 1);
  assert.equal(held(db, 'staff', 11), 0, 'доза — с её полки');
  assert.equal(patientLines(db), 2, 'доза и расход — две строки, как всегда');
  assert.deepEqual(pendingRows(db), [{ status: 'pending', kind: 'extra', base_qty: 1 }]);
  assert.equal(onHand(db), 99, 'склад отдал медсестре дозу при выдаче на полку; отметка его не трогает');
});

// ─── 6. Что экран узнаёт от сервера ─────────────────────────────────────────

test('holdings_list reachable: сервер говорит экрану, можно ли этому человеку брать со склада', () => {
  const db = seed();
  const v = visit(db, 20);
  for (const k of WAREHOUSE) assert.equal(rpc(db, 'holdings_list', { reachable: true, visit_id: v }, U[k]).warehouse_allowed, true, k);
  for (const k of [...CLINICAL, 'lab']) assert.equal(rpc(db, 'holdings_list', { reachable: true, visit_id: v }, U[k]).warehouse_allowed, false, k);
  assert.equal(rpc(db, 'holdings_list', { reachable: true }, U.nurse).warehouse_allowed, false, 'и без места выдачи');
});

test('ответ двери выдачи не называет остаток склада тому, кто склад не видит', () => {
  const db = seed();
  const v = visit(db, 20);
  const a = admission(db);
  put(db, 'staff', 11, 3);
  assert.equal(VISIT_DOORS.dispense_visit_item(db, v, 1, U.nurse).on_hand, null);
  assert.equal(ADM_DOORS.dispense_admission_item(db, a, 1, U.nurse).on_hand, null);
  assert.equal(VISIT_DOORS.dispense_visit_item(db, v, 1, U.admin).on_hand, 96);
  assert.equal(ADM_DOORS.dispense_admission_item(db, a, 1, U.inv).on_hand, 95);
});

// ─── 7. /api/db: остаток склада пустой для тех, кто склад не видит ───────────

const PRODUCTS = { op: 'select', table: 'products', columns: 'id,name,unit,on_hand,sale_price', filters: [{ col: 'id', op: 'eq', val: P }] };
const readAs = (db, user, desc = PRODUCTS) => { const q = compile(desc, user, { db }); return db.prepare(q.sql).all(...q.params); };

test('products.on_hand: врач, медсестра, лаборант, регистратура — пусто; остальное о товаре — как было', () => {
  const db = seed();
  for (const user of [U.doctor, U.nurse, U.senior, U.head, U.lab, U.custom, { id: 50, role: 'registrar' }]) {
    const [row] = readAs(db, user);
    assert.equal(row.on_hand, null, JSON.stringify(user));
    assert.equal(row.name, 'Бинт');
    assert.equal(row.sale_price, 1000, 'цена продажи видна: по ней выставляют счёт');
  }
  const [star] = readAs(db, U.nurse, { op: 'select', table: 'products', columns: '*', filters: [] });
  assert.equal(star.on_hand, null, 'и через «*»');
});

test('products.on_hand: администратор, кладовщик, врач-администратор — число; раздел «Закупки и склад» или «Закупки: Просмотр» открывает', () => {
  const db = seed();
  for (const user of [U.admin, U.inv, U.adminDoc, U.invDoc]) assert.equal(readAs(db, user)[0].on_hand, 100, JSON.stringify(user));
  grant(db, 'nurse', 'procurement', 'view');
  assert.equal(readAs(db, U.nurse)[0].on_hand, 100, 'медсестре выдали «Закупки: Просмотр» — видит склад');
  db.prepare(`UPDATE role_permissions SET permissions = '{"sections":["inventory","patients"]}' WHERE role = 'doctor'`).run();
  assert.equal(readAs(db, U.doctor)[0].on_hand, 100, 'роли выдан раздел «Закупки и склад»');
});

test('products.on_hand: по скрытому остатку нельзя сортировать', () => {
  const db = seed();
  assert.throws(() => readAs(db, U.nurse, { ...PRODUCTS, order: [{ col: 'on_hand', asc: false }] }), (e) => e.status === 400);
  assert.doesNotThrow(() => readAs(db, U.admin, { ...PRODUCTS, order: [{ col: 'on_hand', asc: false }] }));
});

test('сводка (дашборд): «Низкий остаток» склада — тем, кто видит склад; врачу и медсестре — пусто', () => {
  const db = seed();
  db.prepare('UPDATE products SET reorder_level = 200 WHERE id = ?').run(P);   // 100 на складе < 200 — низкий остаток
  assert.equal(rpc(db, 'dashboard_summary', {}, U.admin).low_stock_count, 1);
  assert.equal(rpc(db, 'dashboard_summary', {}, U.inv).low_stock_count, 1);
  for (const k of ['doctor', 'nurse', 'senior', 'head', 'lab', 'custom']) {
    assert.equal(rpc(db, 'dashboard_summary', {}, U[k]).low_stock_count, null, k);
  }
});
