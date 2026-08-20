import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { receiveStock, dispenseItem, voidDispense } from './inventory.js';

function seed() {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO users (id,username,password_hash,role) VALUES (3,'inv','x','inventory'),(4,'doc','x','doctor'),(5,'lab','x','lab')").run();
  const pid = db.prepare("INSERT INTO patients (full_name,branch_id) VALUES ('P',1)").run().lastInsertRowid;
  const vid = db.prepare("INSERT INTO visits (patient_id,branch_id,visit_date) VALUES (?,1,'2026-08-12T09:00:00Z')").run(pid).lastInsertRowid;
  const prod = db.prepare("INSERT INTO products (name,unit,sale_price,on_hand) VALUES ('Paracetamol','box',12000,0)").run().lastInsertRowid;
  return { db, pid, vid, prod };
}
const inv = { id:3, role:'inventory' };
const doc = { id:4, role:'doctor' };
const lab = { id:5, role:'lab' };

test('receive_stock increases on_hand and writes a ledger row', () => {
  const { db, prod } = seed();
  const r = receiveStock(db, { product_id: prod, quantity: 10, unit_cost: 8000 }, inv);
  assert.equal(r.on_hand, 10);
  const m = db.prepare("SELECT kind,qty FROM stock_movements WHERE product_id=?").get(prod);
  assert.equal(m.kind, 'receive'); assert.equal(m.qty, 10);
  assert.throws(() => receiveStock(db, { product_id: prod, quantity: 0 }, inv), /quantity/);
  assert.throws(() => receiveStock(db, { product_id: prod, quantity: 5 }, lab), /(role|allow)/i);
});

test('dispense_item decrements stock, prices from catalog, links a visit line', () => {
  const { db, vid, prod } = seed();
  receiveStock(db, { product_id: prod, quantity: 10 }, inv);
  const r = dispenseItem(db, { product_id: prod, quantity: 3, visit_id: vid }, doc);
  assert.equal(r.on_hand, 7);
  assert.ok(r.visit_service_id);
  const vs = db.prepare('SELECT clinic_item_id, service_id, quantity, unit_price, total, status FROM visit_services WHERE id=?').get(r.visit_service_id);
  assert.equal(vs.clinic_item_id, prod);
  assert.equal(vs.service_id, null);
  assert.equal(vs.unit_price, 12000);          // from product.sale_price, server-stamped
  assert.equal(vs.total, 36000);
  const m = db.prepare("SELECT qty FROM stock_movements WHERE kind='dispense'").get();
  assert.equal(m.qty, -3);
});

test('dispense_item NEVER goes negative (atomic reject on insufficient stock)', () => {
  const { db, vid, prod } = seed();
  receiveStock(db, { product_id: prod, quantity: 2 }, inv);
  assert.throws(() => dispenseItem(db, { product_id: prod, quantity: 5, visit_id: vid }, doc), /insufficient|stock/i);
  assert.equal(db.prepare('SELECT on_hand FROM products WHERE id=?').get(prod).on_hand, 2); // unchanged
  assert.equal(db.prepare("SELECT COUNT(*) n FROM visit_services").get().n, 0);              // no line
  assert.equal(db.prepare("SELECT COUNT(*) n FROM stock_movements WHERE kind='dispense'").get().n, 0); // no movement
});

test('dispense_item validates qty/product/role; stock-only (no visit) works', () => {
  const { db, prod } = seed();
  receiveStock(db, { product_id: prod, quantity: 10 }, inv);
  assert.throws(() => dispenseItem(db, { product_id: prod, quantity: -1 }, doc), /quantity/);
  assert.throws(() => dispenseItem(db, { product_id: 99999, quantity: 1 }, doc), /not found|product/i);
  assert.throws(() => dispenseItem(db, { product_id: prod, quantity: 1 }, lab), /(role|allow)/i);
  const r = dispenseItem(db, { product_id: prod, quantity: 2 }, inv);  // no visit_id → stock-only
  assert.equal(r.on_hand, 8);
  assert.equal(r.visit_service_id, null);
});

test('void_dispense restores stock and deletes the line; blocked once invoiced', () => {
  const { db, vid, prod } = seed();
  receiveStock(db, { product_id: prod, quantity: 10 }, inv);
  const d = dispenseItem(db, { product_id: prod, quantity: 4, visit_id: vid }, doc);
  const v = voidDispense(db, { visit_service_id: d.visit_service_id }, inv);
  assert.equal(v.on_hand, 10);   // restored
  assert.equal(db.prepare('SELECT COUNT(*) n FROM visit_services WHERE id=?').get(d.visit_service_id).n, 0); // deleted
  assert.equal(db.prepare("SELECT qty FROM stock_movements WHERE kind='void'").get().qty, 4);
  // a fresh dispense that then gets invoiced can't be voided
  const d2 = dispenseItem(db, { product_id: prod, quantity: 1, visit_id: vid }, doc);
  db.prepare("INSERT INTO invoices (patient_id) VALUES (1)").run();
  db.prepare("INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, total) VALUES (1,'x',1,1,1)").run();
  db.prepare("UPDATE visit_services SET invoice_item_id=1 WHERE id=?").run(d2.visit_service_id);
  assert.throws(() => voidDispense(db, { visit_service_id: d2.visit_service_id }, inv), /invoiced/i);
});

test('receive/dispense reject absurdly large quantities (no overflow)', () => {
  const { db, prod } = seed();
  assert.throws(() => receiveStock(db, { product_id: prod, quantity: 1e308 }, inv), /quantity/);
  assert.throws(() => receiveStock(db, { product_id: prod, quantity: 2_000_000 }, inv), /quantity/);
  assert.equal(db.prepare('SELECT on_hand FROM products WHERE id=?').get(prod).on_hand, 0);
});

test('dispense rejects bad visit_id/doctor_id types with 400 not 500', () => {
  const { db, prod } = seed();
  receiveStock(db, { product_id: prod, quantity: 5 }, inv);
  assert.throws(() => dispenseItem(db, { product_id: prod, quantity: 1, visit_id: {} }, doc), /visit_id/);
  assert.throws(() => dispenseItem(db, { product_id: prod, quantity: 1, doctor_id: 'x' }, doc), /doctor_id/);
  assert.equal(db.prepare('SELECT on_hand FROM products WHERE id=?').get(prod).on_hand, 5); // unchanged
});
