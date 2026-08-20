import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { receivePurchaseOrder, approveRequisitionAndIssue, postStockCount } from './procurement.js';

const inv = { id: 3, role: 'inventory' };
const doc = { id: 4, role: 'doctor' };

function base() {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO users (id,username,password_hash,role) VALUES (3,'inv','x','inventory'),(4,'doc','x','doctor')").run();
  return db;
}
function product(db, on_hand = 0, avg_cost = 0) {
  return db.prepare("INSERT INTO products (name, unit, base_unit, on_hand, avg_cost) VALUES ('Gauze','pcs','pcs',?,?)").run(on_hand, avg_cost).lastInsertRowid;
}

// ---------------------------------------------------------------------------
// receive_purchase_order
// ---------------------------------------------------------------------------
test('receive_purchase_order: full receipt raises on_hand + WAC and marks PO received', () => {
  const db = base();
  const p = product(db, 10, 200);   // start with 10 @ 200
  const sup = db.prepare("INSERT INTO suppliers (name) VALUES ('Acme')").run().lastInsertRowid;
  const po = db.prepare("INSERT INTO purchase_orders (po_number, supplier_id) VALUES ('PO-1', ?)").run(sup).lastInsertRowid;
  const li = db.prepare("INSERT INTO purchase_order_items (po_id, product_id, qty_ordered, unit_cost) VALUES (?,?,?,?)").run(po, p, 30, 100).lastInsertRowid;

  const r = receivePurchaseOrder(db, { po_id: po }, inv);
  assert.equal(r.status, 'received');
  assert.equal(r.received[0].qty, 30);
  // WAC: (200*10 + 100*30) / 40 = 125
  assert.equal(r.received[0].on_hand, 40);
  assert.equal(r.received[0].avg_cost, 125);

  const poRow = db.prepare('SELECT status, received_at FROM purchase_orders WHERE id=?').get(po);
  assert.equal(poRow.status, 'received');
  assert.ok(poRow.received_at, 'received_at set');
  assert.equal(db.prepare('SELECT qty_received FROM purchase_order_items WHERE id=?').get(li).qty_received, 30);
  const mv = db.prepare("SELECT qty, unit_cost, reference_type, reference_id FROM stock_movements WHERE kind='receive'").get();
  assert.deepEqual([mv.qty, mv.unit_cost, mv.reference_type, mv.reference_id], [30, 100, 'purchase_order', po]);
});

test('receive_purchase_order: partial receipt -> partial, then completing -> received', () => {
  const db = base();
  const p = product(db, 0, 0);
  const po = db.prepare("INSERT INTO purchase_orders (po_number) VALUES ('PO-2')").run().lastInsertRowid;
  const li = db.prepare("INSERT INTO purchase_order_items (po_id, product_id, qty_ordered, unit_cost) VALUES (?,?,?,?)").run(po, p, 50, 10).lastInsertRowid;

  const r1 = receivePurchaseOrder(db, { po_id: po, lines: [{ po_item_id: li, qty: 20 }] }, inv);
  assert.equal(r1.status, 'partial');
  assert.equal(db.prepare('SELECT on_hand FROM products WHERE id=?').get(p).on_hand, 20);
  assert.equal(db.prepare('SELECT status FROM purchase_orders WHERE id=?').get(po).status, 'partial');

  const r2 = receivePurchaseOrder(db, { po_id: po }, inv);   // rest (30)
  assert.equal(r2.status, 'received');
  assert.equal(db.prepare('SELECT on_hand FROM products WHERE id=?').get(p).on_hand, 50);
});

test('receive_purchase_order: rejects over-receipt, re-receipt, bad role — nothing persists', () => {
  const db = base();
  const p = product(db, 0, 0);
  const po = db.prepare("INSERT INTO purchase_orders (po_number) VALUES ('PO-3')").run().lastInsertRowid;
  const li = db.prepare("INSERT INTO purchase_order_items (po_id, product_id, qty_ordered, unit_cost) VALUES (?,?,?,?)").run(po, p, 10, 5).lastInsertRowid;

  assert.throws(() => receivePurchaseOrder(db, { po_id: po, lines: [{ po_item_id: li, qty: 999 }] }, inv), /exceeds/i);
  assert.throws(() => receivePurchaseOrder(db, { po_id: po }, doc), /(role|allow)/i);
  assert.throws(() => receivePurchaseOrder(db, { po_id: 9999 }, inv), /not found/i);
  assert.equal(db.prepare('SELECT on_hand FROM products WHERE id=?').get(p).on_hand, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM stock_movements').get().n, 0);

  receivePurchaseOrder(db, { po_id: po }, inv);   // now fully received
  assert.throws(() => receivePurchaseOrder(db, { po_id: po }, inv), /already/i);
});

// ---------------------------------------------------------------------------
// approve_requisition_and_issue
// ---------------------------------------------------------------------------
test('approve_requisition_and_issue: lowers on_hand, writes dispense, marks issued', () => {
  const db = base();
  const p = product(db, 100, 50);
  const req = db.prepare("INSERT INTO purchase_requisitions (req_number, status) VALUES ('REQ-1','submitted')").run().lastInsertRowid;
  db.prepare("INSERT INTO purchase_requisition_items (req_id, product_id, qty) VALUES (?,?,?)").run(req, p, 30);

  const r = approveRequisitionAndIssue(db, { req_id: req }, inv);
  assert.equal(r.status, 'issued');
  assert.equal(r.issued[0].on_hand, 70);
  assert.equal(db.prepare('SELECT on_hand FROM products WHERE id=?').get(p).on_hand, 70);
  const mv = db.prepare("SELECT qty, unit_cost, reference_type FROM stock_movements WHERE kind='dispense'").get();
  assert.deepEqual([mv.qty, mv.unit_cost, mv.reference_type], [-30, 50, 'requisition']);
  assert.equal(db.prepare('SELECT status FROM purchase_requisitions WHERE id=?').get(req).status, 'issued');
});

test('approve_requisition_and_issue: rejects insufficient stock, double-issue, bad role', () => {
  const db = base();
  const p = product(db, 10, 50);
  const req = db.prepare("INSERT INTO purchase_requisitions (req_number, status) VALUES ('REQ-2','submitted')").run().lastInsertRowid;
  db.prepare("INSERT INTO purchase_requisition_items (req_id, product_id, qty) VALUES (?,?,?)").run(req, p, 40);

  assert.throws(() => approveRequisitionAndIssue(db, { req_id: req }, inv), /insufficient/i);
  assert.equal(db.prepare('SELECT on_hand FROM products WHERE id=?').get(p).on_hand, 10);   // untouched
  assert.throws(() => approveRequisitionAndIssue(db, { req_id: req }, doc), /(role|allow)/i);

  // enough stock now -> issues, then a second issue is refused
  db.prepare('UPDATE products SET on_hand = 100 WHERE id=?').run(p);
  approveRequisitionAndIssue(db, { req_id: req }, inv);
  assert.throws(() => approveRequisitionAndIssue(db, { req_id: req }, inv), /cannot be issued/i);
});

// ---------------------------------------------------------------------------
// post_stock_count
// ---------------------------------------------------------------------------
test('post_stock_count: sets on_hand to counted qty, writes signed adjust, marks posted', () => {
  const db = base();
  const p = product(db, 100, 50);
  const cnt = db.prepare("INSERT INTO stock_counts (count_number, status) VALUES ('SC-1','counting')").run().lastInsertRowid;
  db.prepare("INSERT INTO stock_count_items (count_id, product_id, system_qty, counted_qty) VALUES (?,?,?,?)").run(cnt, p, 100, 93);

  const r = postStockCount(db, { count_id: cnt }, inv);
  assert.equal(r.status, 'posted');
  assert.equal(r.adjustments[0].delta, -7);
  assert.equal(r.adjustments[0].on_hand, 93);
  assert.equal(db.prepare('SELECT on_hand FROM products WHERE id=?').get(p).on_hand, 93);
  const mv = db.prepare("SELECT qty, reference_type FROM stock_movements WHERE kind='adjust'").get();
  assert.deepEqual([mv.qty, mv.reference_type], [-7, 'stock_count']);
  const cRow = db.prepare('SELECT status, posted_at FROM stock_counts WHERE id=?').get(cnt);
  assert.equal(cRow.status, 'posted');
  assert.ok(cRow.posted_at);
});

test('post_stock_count: ignores uncounted lines, no movement on zero variance, refuses re-post', () => {
  const db = base();
  const p1 = product(db, 40, 10);   // will be counted at 40 -> zero variance, no movement
  const p2 = product(db, 5, 10);    // uncounted -> ignored entirely
  const cnt = db.prepare("INSERT INTO stock_counts (count_number, status) VALUES ('SC-2','counting')").run().lastInsertRowid;
  db.prepare("INSERT INTO stock_count_items (count_id, product_id, system_qty, counted_qty) VALUES (?,?,?,?)").run(cnt, p1, 40, 40);
  db.prepare("INSERT INTO stock_count_items (count_id, product_id, system_qty, counted_qty) VALUES (?,?,?,NULL)").run(cnt, p2, 5);

  const r = postStockCount(db, { count_id: cnt }, inv);
  assert.equal(r.adjustments.length, 1);   // only the counted line
  assert.equal(db.prepare('SELECT COUNT(*) n FROM stock_movements').get().n, 0);   // zero variance -> no movement
  assert.equal(db.prepare('SELECT on_hand FROM products WHERE id=?').get(p2).on_hand, 5);   // uncounted untouched
  assert.throws(() => postStockCount(db, { count_id: cnt }, inv), /already/i);
});

test('post_stock_count: rejects a count with no counted lines, and bad role', () => {
  const db = base();
  const p = product(db, 10, 10);
  const cnt = db.prepare("INSERT INTO stock_counts (count_number, status) VALUES ('SC-3','open')").run().lastInsertRowid;
  db.prepare("INSERT INTO stock_count_items (count_id, product_id, system_qty, counted_qty) VALUES (?,?,?,NULL)").run(cnt, p, 10);
  assert.throws(() => postStockCount(db, { count_id: cnt }, inv), /no counted/i);
  assert.throws(() => postStockCount(db, { count_id: cnt }, doc), /(role|allow)/i);
});
