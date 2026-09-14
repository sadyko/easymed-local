// HOLDINGS_V1 — warehouse → holder → patient, counted once.
//
// The defect this guards: «Выдать со склада» to a nurse deducted the
// warehouse, and the nurse's later dispense to a patient deducted it again.
// Now an issue with a holder MOVES stock, and a dispense from a holding takes
// it from the holder only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { issueStockLines } from './procurement.js';
import { holdingsList, dispenseFromHolding, voidHoldingDispense, outpatientsToday, visitItems, resolveHolder } from './holdings.js';
import { getRpc } from './index.js';
import { dispenseAdmissionItemCore, voidDispensedAdmissionItemCore } from './inventory.js';

const inv = { id: 3, role: 'inventory' };
const nurse = { id: 5, role: 'nurse' };
const cashier = { id: 6, role: 'cashier' };

function seed() {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO users (id,username,password_hash,role,full_name) VALUES (3,'inv','x','inventory','Кладовщик'),(5,'nurse','x','nurse','Медсестра Ирина'),(6,'cash','x','cashier','Кассир')").run();
  db.prepare("INSERT INTO rooms (id, name) VALUES (7, 'Процедурный')").run();
  db.prepare("INSERT INTO departments (id, name) VALUES (9, 'Терапия')").run();
  // Bought in boxes of 10, base unit = pack? No: base 'pack', dispensed in tabs (10 per pack).
  const prod = db.prepare(`
    INSERT INTO products (name, unit, base_unit, consumption_unit, consumption_factor, sale_price, on_hand, avg_cost)
    VALUES ('Парацетамол', 'pack', 'pack', 'таб', 10, 5000, 20, 3000)`).run().lastInsertRowid;
  db.prepare("INSERT INTO patients (id, full_name, mrn) VALUES (1, 'Иванов Иван', 'EM-1')").run();
  const visit = db.prepare("INSERT INTO visits (patient_id, visit_date, status) VALUES (1, strftime('%Y-%m-%dT%H:%M:%SZ','now'), 'arrived')").run().lastInsertRowid;
  return { db, prod, visit };
}
const onHand = (db, id) => db.prepare('SELECT on_hand FROM products WHERE id = ?').get(id).on_hand;
const held = (db, type, id, prod) => (db.prepare('SELECT qty FROM stock_holdings WHERE holder_type = ? AND holder_id = ? AND product_id = ?').get(type, id, prod) || { qty: 0 }).qty;

test('issue with a holder MOVES stock: warehouse −, nurse +; the journal names the holder', () => {
  const { db, prod } = seed();
  const r = issueStockLines(db, { holder: { type: 'staff', id: 5 }, lines: [{ product_id: prod, qty: 30, unit: 'consumption' }] }, inv);
  assert.equal(r.issued[0].base_qty, 3, '30 таб = 3 упаковки');
  assert.equal(onHand(db, prod), 17);
  assert.equal(held(db, 'staff', 5, prod), 3);
  const mv = db.prepare("SELECT qty, holder_type, holder_id, note FROM stock_movements WHERE reference_type = 'issue'").get();
  assert.equal(mv.qty, -3); assert.equal(mv.holder_type, 'staff'); assert.equal(mv.holder_id, 5);
  assert.equal(mv.note, 'Медсестра Ирина', 'recipient text comes from the holder when not typed');

  // Rooms and departments hold too.
  issueStockLines(db, { holder: { type: 'room', id: 7 }, lines: [{ product_id: prod, qty: 1, unit: 'base' }] }, inv);
  issueStockLines(db, { holder: { type: 'department', id: 9 }, lines: [{ product_id: prod, qty: 2, unit: 'base' }], note: 'на неделю' }, inv);
  assert.equal(onHand(db, prod), 14);
  const list = holdingsList(db, {}, nurse).holdings;
  assert.deepEqual(list.map((h) => [h.holder_type, h.holder_name, h.qty_base, h.qty_units]),
    [['department', 'Терапия', 2, 20], ['room', 'Процедурный', 1, 10], ['staff', 'Медсестра Ирина', 3, 30]]);
  assert.equal(list[0].consumption_unit, 'таб');

  // A free-text recipient without a holder is the old plain write-off — no holding.
  issueStockLines(db, { recipient: 'Уборщица', lines: [{ product_id: prod, qty: 1, unit: 'base' }] }, inv);
  assert.equal(onHand(db, prod), 13);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM stock_holdings').get().n, 3);

  assert.throws(() => issueStockLines(db, { holder: { type: 'staff', id: 999 }, lines: [{ product_id: prod, qty: 1 }] }, inv), (e) => e.status === 404);
  assert.throws(() => resolveHolder(db, { type: 'cabinet', id: 7 }), (e) => e.status === 400);
});

test('dispense from a holding to an outpatient visit: holder −, warehouse untouched, line billed per tablet', () => {
  const { db, prod, visit } = seed();
  issueStockLines(db, { holder: { type: 'staff', id: 5 }, lines: [{ product_id: prod, qty: 30, unit: 'consumption' }] }, inv);
  const r = dispenseFromHolding(db, { holder: { type: 'staff', id: 5 }, product_id: prod, quantity: 4, visit_id: visit }, nurse);
  assert.equal(r.item_name, 'Парацетамол');
  assert.equal(r.unit_price, 500, '5000 per pack of 10 → 500 per tablet');
  assert.equal(r.total, 2000);
  assert.equal(r.left_units, 26);
  assert.equal(onHand(db, prod), 17, 'the warehouse was deducted at issue time only');
  assert.equal(held(db, 'staff', 5, prod), 2.6);
  const line = db.prepare('SELECT clinic_item_id, quantity, unit_price, total, created_by FROM visit_services WHERE id = ?').get(r.line_id);
  assert.deepEqual(line, { clinic_item_id: prod, quantity: 4, unit_price: 500, total: 2000, created_by: 5 });
  const mv = db.prepare("SELECT qty, holder_type, holder_id FROM stock_movements WHERE reference_type = 'visit' AND reference_id = ?").get(r.line_id);
  assert.deepEqual(mv, { qty: -0.4, holder_type: 'staff', holder_id: 5 });

  const items = visitItems(db, { visit_id: visit }, nurse).items;
  assert.equal(items.length, 1);
  assert.equal(items[0].product_name, 'Парацетамол'); assert.equal(items[0].unit, 'таб');
  assert.equal(items[0].from_holding, true); assert.equal(items[0].invoiced, false);
  assert.equal(items[0].created_by_name, 'Медсестра Ирина');

  // Not billable: the line is on the visit at zero, stock still moves.
  const free = dispenseFromHolding(db, { holder: { type: 'staff', id: 5 }, product_id: prod, quantity: 1, visit_id: visit, billable: false }, nurse);
  assert.equal(db.prepare('SELECT total FROM visit_services WHERE id = ?').get(free.line_id).total, 0);

  // Overdraw is refused with the human number.
  assert.throws(() => dispenseFromHolding(db, { holder: { type: 'staff', id: 5 }, product_id: prod, quantity: 100, visit_id: visit }, nurse),
    (e) => e.status === 400 && /Недостаточно на руках/.test(e.message) && /25 таб/.test(e.message));
  // The room holds nothing of it.
  assert.throws(() => dispenseFromHolding(db, { holder: { type: 'room', id: 7 }, product_id: prod, quantity: 1, visit_id: visit }, nurse), /Недостаточно/);
  assert.throws(() => dispenseFromHolding(db, { holder: { type: 'staff', id: 5 }, product_id: prod, quantity: 1, visit_id: visit }, cashier), (e) => e.status === 403);
  assert.throws(() => dispenseFromHolding(db, { holder: { type: 'staff', id: 5 }, product_id: prod, quantity: 1 }, nurse), /визит или госпитализацию/);
});

test('void returns the quantity to the holder it came from and removes the line; an invoiced line stays', () => {
  const { db, prod, visit } = seed();
  issueStockLines(db, { holder: { type: 'room', id: 7 }, lines: [{ product_id: prod, qty: 10, unit: 'consumption' }] }, inv);
  const r = dispenseFromHolding(db, { holder: { type: 'room', id: 7 }, product_id: prod, quantity: 3, visit_id: visit }, nurse);
  assert.equal(held(db, 'room', 7, prod), 0.7);
  voidHoldingDispense(db, { visit_service_id: r.line_id }, nurse);
  assert.equal(held(db, 'room', 7, prod), 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM visit_services WHERE id = ?').get(r.line_id).n, 0);
  assert.equal(onHand(db, prod), 19, 'warehouse untouched either way');

  const r2 = dispenseFromHolding(db, { holder: { type: 'room', id: 7 }, product_id: prod, quantity: 2, visit_id: visit }, nurse);
  const invId = db.prepare("INSERT INTO invoices (patient_id, visit_id) VALUES (1, ?)").run(visit).lastInsertRowid;
  const itemId = db.prepare("INSERT INTO invoice_items (invoice_id, description) VALUES (?, 'x')").run(invId).lastInsertRowid;
  db.prepare('UPDATE visit_services SET invoice_item_id = ? WHERE id = ?').run(itemId, r2.line_id);
  assert.throws(() => voidHoldingDispense(db, { visit_service_id: r2.line_id }, nurse), /уже в счёте/);
});

test('outpatients_today lists today\'s outpatient visits with patient, doctor and counts — not cancelled, not inpatient', () => {
  const { db, prod, visit } = seed();
  db.prepare("INSERT INTO users (id, username, password_hash, role, full_name, is_doctor) VALUES (8, 'doc', 'x', 'doctor', 'Врач Азиз', 1)").run();
  db.prepare('UPDATE visits SET doctor_id = 8 WHERE id = ?').run(visit);
  db.prepare("INSERT INTO visits (patient_id, visit_date, status) VALUES (1, strftime('%Y-%m-%dT%H:%M:%SZ','now'), 'cancelled')").run();
  db.prepare("INSERT INTO visits (patient_id, visit_date, status, visit_type) VALUES (1, strftime('%Y-%m-%dT%H:%M:%SZ','now'), 'arrived', 'inpatient')").run();
  db.prepare("INSERT INTO visits (patient_id, visit_date, status) VALUES (1, strftime('%Y-%m-%dT%H:%M:%SZ','now','-2 days'), 'arrived')").run();
  issueStockLines(db, { holder: { type: 'staff', id: 5 }, lines: [{ product_id: prod, qty: 10, unit: 'consumption' }] }, inv);
  dispenseFromHolding(db, { holder: { type: 'staff', id: 5 }, product_id: prod, quantity: 1, visit_id: visit }, nurse);
  const r = outpatientsToday(db, {}, nurse);
  assert.equal(r.visits.length, 1);
  assert.equal(r.visits[0].id, visit);
  assert.equal(r.visits[0].patient_name, 'Иванов Иван');
  assert.equal(r.visits[0].doctor_name, 'Врач Азиз');
  assert.equal(r.visits[0].item_count, 1);
  assert.match(r.date, /^\d{4}-\d{2}-\d{2}$/);
  for (const name of ['holdings_list', 'dispense_from_holding', 'void_holding_dispense', 'outpatients_today', 'visit_items']) {
    assert.equal(typeof getRpc(name), 'function', name);
  }
});

test('ward dose: the nurse\'s own holding is used before the warehouse, then the ward\'s department, then the warehouse; void returns to the source', () => {
  const { db, prod } = seed();
  db.prepare("INSERT INTO wards (id, name, department_id) VALUES (3, 'Палата 3', 9)").run();
  const adm = db.prepare("INSERT INTO admissions (patient_id, status, ward_id, created_at) VALUES (1, 'active', 3, '2026-09-14T00:00:00Z')").run().lastInsertRowid;
  issueStockLines(db, { holder: { type: 'staff', id: 5 }, lines: [{ product_id: prod, qty: 1, unit: 'base' }] }, inv);
  issueStockLines(db, { holder: { type: 'department', id: 9 }, lines: [{ product_id: prod, qty: 2, unit: 'base' }] }, inv);
  assert.equal(onHand(db, prod), 17);

  // 1 pack: the nurse holds exactly one → hers.
  const a = dispenseAdmissionItemCore(db, { admission_id: adm, product_id: prod, quantity: 1, prefer_holdings: true }, nurse);
  assert.deepEqual(a.from_holding, { type: 'staff', id: 5 });
  assert.equal(held(db, 'staff', 5, prod), 0);
  assert.equal(onHand(db, prod), 17, 'warehouse untouched');
  // Next pack: she has none → the department's.
  const b = dispenseAdmissionItemCore(db, { admission_id: adm, product_id: prod, quantity: 1, prefer_holdings: true }, nurse);
  assert.deepEqual(b.from_holding, { type: 'department', id: 9 });
  assert.equal(held(db, 'department', 9, prod), 1);
  // 2 packs: department holds 1 — not split; the warehouse covers it.
  const c = dispenseAdmissionItemCore(db, { admission_id: adm, product_id: prod, quantity: 2, prefer_holdings: true }, nurse);
  assert.equal(c.from_holding, null);
  assert.equal(onHand(db, prod), 15);
  assert.equal(held(db, 'department', 9, prod), 1);
  // Without the flag the warehouse is used as before (the ward console's own dialog).
  const d = dispenseAdmissionItemCore(db, { admission_id: adm, product_id: prod, quantity: 1 }, nurse);
  assert.equal(d.from_holding, null);
  assert.equal(onHand(db, prod), 14);

  // Void goes back to the source each came from.
  voidDispensedAdmissionItemCore(db, { line_id: b.line_id }, nurse);
  assert.equal(held(db, 'department', 9, prod), 2);
  voidDispensedAdmissionItemCore(db, { line_id: c.line_id }, nurse);
  assert.equal(onHand(db, prod), 16);
});
