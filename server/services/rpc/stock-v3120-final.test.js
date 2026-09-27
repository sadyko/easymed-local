// V3120_FINAL — склад (2026-09-28): «пыль» полки, количество-ноль, возврат
// на полку отключённого.
//
//   M1  правило пыли обнулило полку — движение пишет, СКОЛЬКО УШЛО с полки на
//       самом деле, а не сколько просили: иначе отмена возвращала меньше;
//   M3  выдача с количеством, которое округляется в ноль, — отказ, как у
//       dispense_from_holding (раньше — строка без списания);
//   M4  отмена выдачи не кладёт товар на полку отключённого сотрудника
//       (кабинета, отдела) — он возвращается на склад, с подписью в журнале.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { getRpc } from './index.js';

const U = {
  admin: { id: 1, role: 'admin' },
  inv: { id: 2, role: 'inventory' },
  nurse: { id: 3, role: 'nurse' },
  nurse2: { id: 4, role: 'nurse' },
  doctor: { id: 5, role: 'doctor' },
};

function seed() {
  const db = openDb(':memory:'); migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, role, full_name) VALUES (?,?,?,?,?)');
  u.run(1, 'admin', 'x', 'admin', 'Админ');
  u.run(2, 'inv', 'x', 'inventory', 'Кладовщик');
  u.run(3, 'nurse', 'x', 'nurse', 'Медсестра Ирина');
  u.run(4, 'nurse2', 'x', 'nurse', 'Медсестра Ольга');
  u.run(5, 'doc', 'x', 'doctor', 'Лечащий');
  db.prepare("INSERT INTO suppliers (id, name) VALUES (1, 'Фарм-Опт')").run();
  const P = db.prepare(`INSERT INTO products (id, name, unit, base_unit, consumption_unit, consumption_factor, sale_price, on_hand, avg_cost, is_drug)
                        VALUES (?,?,?,?,?,?,?,?,?,1)`);
  P.run(1, 'Аспирин 30', 'уп', 'уп', 'таб', 30, 30000, 10, 12000);
  P.run(2, 'Физраствор 1л', 'л', 'л', 'мл', 1000, 10000, 10, 4000);
  P.run(3, 'Витамин 7', 'уп', 'уп', 'таб', 7, 7000, 10, 3500);
  P.run(4, 'Кеторол', 'уп', 'уп', 'амп', 10, 50000, 10, 20000);
  P.run(5, 'Бинт', 'шт', 'шт', null, 1, 5000, 10, 2000);
  db.prepare("INSERT INTO patients (id, full_name, mrn) VALUES (1, 'Иванов Иван', 'EM-1')").run();
  db.prepare("INSERT INTO wards (id, name) VALUES (1, 'Палата 1')").run();
  db.prepare("INSERT INTO beds (id, code, ward_id) VALUES (1, '1-1', 1)").run();
  db.prepare("INSERT INTO services (id, name, price) VALUES (1, 'Инъекция', 20000)").run();
  return db;
}
const rpc = (db, name, args, user) => getRpc(name)(db, args, user);
const onHand = (db, id) => db.prepare('SELECT on_hand FROM products WHERE id = ?').get(id).on_hand;
const held = (db, type, id, pid) => (db.prepare('SELECT qty FROM stock_holdings WHERE holder_type = ? AND holder_id = ? AND product_id = ?').get(type, id, pid) || { qty: 0 }).qty;
const visit = (db) => Number(db.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date, status) VALUES (1, 5, strftime('%Y-%m-%dT%H:%M:%SZ','now'), 'arrived')").run().lastInsertRowid);
const admission = (db) => Number(db.prepare("INSERT INTO admissions (patient_id, status, ward_id, bed_id, doctor_id, attending_doctor_id) VALUES (1, 'active', 1, 1, 5, 5)").run().lastInsertRowid);
const issueTo = (db, userId, productId, units) => rpc(db, 'issue_stock_lines', { holder: { type: 'staff', id: userId }, lines: [{ product_id: productId, qty: units, unit: 'consumption' }] }, U.inv);

const setHeld = (db, type, id, pid, qty) => db.prepare(
  'INSERT INTO stock_holdings (holder_type, holder_id, product_id, qty) VALUES (?,?,?,?)').run(type, id, pid, qty);

test('M1: полка с пылью (1.0005 шт) и выдача 1 — в журнале ушло 1.0005, отмена кладёт ровно 1.0005', () => {
  const db = seed();
  const v = visit(db);
  setHeld(db, 'staff', 3, 5, 1.0005);
  const r = rpc(db, 'dispense_visit_item', { p_item_id: 5, p_qty: 1, p_visit_id: v }, U.nurse);
  assert.equal(held(db, 'staff', 3, 5), 0, 'пыль обнулена');
  const moved = db.prepare("SELECT SUM(qty) s FROM stock_movements WHERE product_id = 5 AND kind = 'dispense' AND holder_type = 'staff'").get().s;
  assert.equal(moved, -1.0005, 'журнал пишет запрошенное, а с полки ушло больше');
  rpc(db, 'void_dispense', { visit_service_id: r.visit_service_id }, U.nurse);
  assert.equal(held(db, 'staff', 3, 5), 1.0005, 'отмена вернула не то, что ушло');
  assert.equal(onHand(db, 5), 10);
});

test('M3: количество, которое округляется в ноль, — отказ во всех дверях выдачи', () => {
  const db = seed();
  const v = visit(db);
  const a = admission(db);
  assert.throws(() => rpc(db, 'dispense_item', { product_id: 5, quantity: 1e-7, visit_id: v }, U.nurse), /слишком мало/);
  assert.throws(() => rpc(db, 'dispense_visit_item', { p_item_id: 5, p_qty: 1e-7, p_visit_id: v }, U.nurse), /слишком мало/);
  assert.throws(() => rpc(db, 'dispense_admission_item', { p_admission_id: a, p_item_id: 5, p_qty: 1e-7 }, U.nurse), /слишком мало/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM visit_services').get().n, 0, 'строка без списания');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM admission_services').get().n, 0);
});

test('M4: отмена выдачи не кладёт товар на полку отключённого сотрудника — он идёт на склад', () => {
  const db = seed();
  const v = visit(db);
  setHeld(db, 'staff', 3, 5, 3);
  const r = rpc(db, 'dispense_visit_item', { p_item_id: 5, p_qty: 2, p_visit_id: v }, U.nurse);
  assert.equal(held(db, 'staff', 3, 5), 1);
  db.prepare('UPDATE users SET is_active = 0 WHERE id = 3').run();
  const back = rpc(db, 'void_dispense', { visit_service_id: r.visit_service_id }, U.admin);
  assert.equal(held(db, 'staff', 3, 5), 1, 'товар вернулся на руки уволенной');
  assert.equal(onHand(db, 5), 12, 'товар не вернулся на склад');
  assert.deepEqual(back.sources.map((s) => s.type), ['warehouse']);
  const note = db.prepare("SELECT note FROM stock_movements WHERE product_id = 5 AND kind = 'void' ORDER BY id DESC").get().note;
  assert.match(note || '', /отключ/);
});

test('M4: то же для отключённого кабинета — возврат на склад', () => {
  const db = seed();
  const v = visit(db);
  db.prepare("INSERT INTO rooms (id, name, active) VALUES (7, 'Процедурный', 1)").run();
  db.prepare('UPDATE users SET room_id = 7 WHERE id = 3').run();
  setHeld(db, 'room', 7, 5, 2);
  const r = rpc(db, 'dispense_visit_item', { p_item_id: 5, p_qty: 1, p_visit_id: v }, U.nurse);
  assert.equal(held(db, 'room', 7, 5), 1);
  db.prepare('UPDATE rooms SET active = 0 WHERE id = 7').run();
  rpc(db, 'void_dispense', { visit_service_id: r.visit_service_id }, U.admin);
  assert.equal(held(db, 'room', 7, 5), 1);
  assert.equal(onHand(db, 5), 11);
});
