// OWN_SHELF_ONLY_V1 — поправки по ревью ветки.
//
// M1. Лист назначений, ОТКЛЮЧЁННЫЙ товар. План, §5: «прочие беды склада
//     (непонятная доза, пустой склад у администратора, отключённый товар)
//     остаются предупреждением, как было». А у медсестры отказ «нет на ваших
//     полках» звучал раньше проверки «товар отключён» — и отметку «введено»
//     не ставили. Теперь отключённый товар — предупреждение у всех; двери
//     выдачи отвечают, как прежде («запросите у склада» — склад и отключённый
//     остаток выдаёт на полку).
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { getRpc } from './index.js';
import { treatmentOrderCreate, treatmentAdminMark } from './treatment-orders.js';
import { OWN_SHELF_SHORT } from './inventory.js';

const U = {
  admin:  { id: 1, role: 'admin' },
  inv:    { id: 2, role: 'inventory' },
  doctor: { id: 10, role: 'doctor' },
  nurse:  { id: 11, role: 'nurse' },
};
const P = 1;

function seed() {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO departments (id, name) VALUES (30, 'Терапия')").run();
  db.prepare("INSERT INTO rooms (id, name, department_id) VALUES (20, 'Кабинет врача', 30), (21, 'Процедурный', 30)").run();
  const u = db.prepare('INSERT INTO users (id, username, password_hash, role, full_name, room_id, department_id) VALUES (?,?,?,?,?,?,?)');
  u.run(1, 'admin', 'x', 'admin', 'Админ', null, null);
  u.run(2, 'inv', 'x', 'inventory', 'Кладовщик', null, null);
  u.run(10, 'doc', 'x', 'doctor', 'Врач Азиз', 20, 30);
  u.run(11, 'nurse', 'x', 'nurse', 'Медсестра Ирина', 21, 30);
  db.prepare("INSERT INTO products (id, name, unit, base_unit, sale_price, on_hand, avg_cost, is_drug) VALUES (1, 'Бинт', 'шт', 'шт', 1000, 100, 400, 1)").run();
  db.prepare("INSERT INTO patients (id, full_name, mrn) VALUES (1, 'Иванов Иван', 'EM-1')").run();
  db.prepare("INSERT INTO wards (id, name, department_id) VALUES (1, 'Палата 1', 30)").run();
  db.prepare("INSERT INTO beds (id, code, ward_id) VALUES (1, '1-1', 1)").run();
  db.prepare("INSERT INTO services (id, name, price) VALUES (1, 'Инъекция', 20000)").run();
  return db;
}
const rpc = (db, name, args, user) => getRpc(name)(db, args, user);
const admission = (db) => Number(db.prepare("INSERT INTO admissions (patient_id, status, ward_id, bed_id, doctor_id, attending_doctor_id) VALUES (1, 'active', 1, 1, 10, 10)").run().lastInsertRowid);
const visit = (db) => Number(db.prepare("INSERT INTO visits (patient_id, doctor_id, room_id, visit_date, status) VALUES (1, 10, 20, strftime('%Y-%m-%dT%H:%M:%SZ','now'), 'arrived')").run().lastInsertRowid);
const onHand = (db) => db.prepare('SELECT on_hand FROM products WHERE id = ?').get(P).on_hand;
const count = (db, sql) => db.prepare(sql).get().n;
const medOrder = (db, adm) => treatmentOrderCreate(db, {
  admission_id: adm, kind: 'med', name: 'Бинт', dose: '1', route: 'в/м', freq_code: '1x',
  starts_on: '2026-09-04', days: 1, service_id: 1, stock_item_id: P,
}, U.doctor).order;
const markGiven = (db, order, user, extra) => treatmentAdminMark(db, {
  order_id: order.id, date: '2026-09-04', slot: 10, status: 'given', ...(extra ? { extra } : {}),
}, user);

test('ревью M1: MAR, медсестра, отключённый товар не на её полках — отметка стоит с предупреждением, как у администратора', () => {
  const db = seed();
  try {
    const a = admission(db);
    const o = medOrder(db, a);
    db.prepare('UPDATE products SET active = 0 WHERE id = ?').run(P);
    const m = markGiven(db, o, U.nurse);
    assert.equal(m.stock.status, 'short', JSON.stringify(m));
    assert.ok(m.warnings.some((w) => w.code === 'stock'), 'предупреждение о складе');
    assert.equal(count(db, 'SELECT COUNT(*) n FROM treatment_administrations'), 1, 'отметка «введено» записана');
    assert.equal(count(db, 'SELECT COUNT(*) n FROM admission_services'), 0, 'списания и начисления нет');
    assert.equal(onHand(db), 100, 'склад не тронут');
    // Расход сверх дозы отключённым товаром — тоже предупреждение, а не отказ всей отметки.
    const a2 = admission(db);
    const o2 = medOrder(db, a2);
    const m2 = markGiven(db, o2, U.nurse, [{ product_id: P, qty: 1, billable: false, name: 'брак' }]);
    assert.ok(m2.warnings.some((w) => w.code === 'stock_extra'), JSON.stringify(m2.warnings));
    assert.equal(count(db, 'SELECT COUNT(*) n FROM treatment_administrations'), 2);
    // Администратор — как прежде: пусто на полках, склад отключённый товар не выдаёт — предупреждение.
    const a3 = admission(db);
    assert.equal(markGiven(db, medOrder(db, a3), U.admin).stock.status, 'short');
  } finally { db.close(); }
});

test('ревью M1: двери выдачи не меняются — медсестре отключённый товар не с полок: «запросите у склада»', () => {
  const db = seed();
  try {
    const v = visit(db);
    db.prepare('UPDATE products SET active = 0 WHERE id = ?').run(P);
    assert.throws(() => rpc(db, 'dispense_visit_item', { p_visit_id: v, p_item_id: P, p_qty: 1, p_doctor_id: 10 }, U.nurse),
      (e) => e.status === 400 && e.code === OWN_SHELF_SHORT);
    // Склад выдаёт остаток отключённого товара на полку — и медсестра его довыдаёт.
    rpc(db, 'issue_stock_lines', { holder: { type: 'staff', id: 11 }, lines: [{ product_id: P, qty: 1, unit: 'base' }] }, U.inv);
    const r = rpc(db, 'dispense_visit_item', { p_visit_id: v, p_item_id: P, p_qty: 1, p_doctor_id: 10 }, U.nurse);
    assert.ok(r.visit_service_id || r.id || r.line_id, JSON.stringify(r));
  } finally { db.close(); }
});

// M2. Два правила «склада»: брать со склада решала роль (администратор и
//     склад), видеть его остаток — право «Закупки». Своя роль на основе
//     администратора или склада с «Закупки: Нет» брала со склада, а число
//     получала пустым — и экраны печатали «(остаток: null)», «склад 0» или
//     прятали склад, который сервер всё равно добирал. Теперь одна функция
//     (inventory.js warehouseAccess) отвечает на оба вопроса, и ответ
//     holdings_list несёт оба: берёт ли (warehouse_allowed) и видит ли число
//     (warehouse_visible); тому, кто берёт, но число не видит, — только
//     «есть на складе» по каждому товару (warehouse_in_stock), без количества.
test('ревью M2: holdings_list — берёт ли со склада, видит ли число и, без числа, что на складе есть', () => {
  const db = seed();
  try {
    db.prepare("INSERT INTO products (id, name, unit, base_unit, sale_price, on_hand, active) VALUES (5, 'Вата', 'шт', 'шт', 500, 0, 1), (6, 'Маска', 'шт', 'шт', 500, 3, 0)").run();
    db.prepare("INSERT INTO custom_roles (code, name, base_role, active) VALUES ('senior_admin', 'Старший администратор', 'admin', 1)").run();
    db.prepare(`INSERT INTO role_permissions (role, permissions) VALUES ('senior_admin', '{"sections":["patients"],"grants":{"procurement":"none"}}')`).run();
    db.prepare("INSERT INTO users (id, username, password_hash, role, full_name, custom_role_code) VALUES (20, 'sadm', 'x', 'admin', 'Старший администратор', 'senior_admin')").run();
    const senior = { id: 20, role: 'admin', custom_role_code: 'senior_admin' };
    const v = visit(db);
    const r = rpc(db, 'holdings_list', { reachable: true, visit_id: v }, senior);
    assert.equal(r.warehouse_allowed, true, 'основа — администратор: со склада берёт');
    assert.equal(r.warehouse_visible, false, '«Закупки: Нет»: числа склада не видит');
    assert.deepEqual(r.warehouse_in_stock, [P], 'только «есть на складе»: действующие товары с остатком');
    // Дверь выдачи этому человеку числа тоже не называет — и склад всё равно добирает.
    const d = rpc(db, 'dispense_item', { visit_id: v, product_id: P, quantity: 1 }, senior);
    assert.equal(d.on_hand, null);
    assert.equal(onHand(db), 99);
    // Администратор и склад: видят число — список «есть» им не нужен.
    for (const u of [U.admin, U.inv]) {
      const a = rpc(db, 'holdings_list', { reachable: true, visit_id: v }, u);
      assert.deepEqual([a.warehouse_allowed, a.warehouse_visible, a.warehouse_in_stock], [true, true, undefined], u.role);
    }
    // Медсестра: со склада не берёт — ни числа, ни списка.
    const n = rpc(db, 'holdings_list', { reachable: true, visit_id: v }, U.nurse);
    assert.deepEqual([n.warehouse_allowed, n.warehouse_visible, n.warehouse_in_stock], [false, false, undefined]);
  } finally { db.close(); }
});
