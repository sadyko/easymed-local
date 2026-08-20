import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { compile, CompileError } from '../query-compiler.js';

// Seed a product + supplier + user so the FK chains below have real parents.
function seed(db) {
  const uid = db.prepare("INSERT INTO users (username,password_hash,full_name,role) VALUES ('inv','x','Inv User','inventory')").run().lastInsertRowid;
  const pid = db.prepare("INSERT INTO products (name, unit, sale_price, on_hand) VALUES ('Paracetamol','tab',1200,100)").run().lastInsertRowid;
  const sid = db.prepare("INSERT INTO suppliers (name, phone) VALUES ('Acme Pharma','+998')").run().lastInsertRowid;
  const did = db.prepare("INSERT INTO departments (name, code, kind) VALUES ('Pharmacy','PH','clinical')").run().lastInsertRowid;
  return { uid, pid, sid, did };
}

test('028 creates the procurement document tables', () => {
  const db = openDb(':memory:'); migrate(db);
  const have = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
  for (const t of ['suppliers','item_suppliers','purchase_orders','purchase_order_items',
                   'purchase_requisitions','purchase_requisition_items','stock_counts','stock_count_items']) {
    assert.ok(have.has(t), `missing table ${t}`);
  }
});

test('028 purchase orders: FK chain + GENERATED line_total + cascade + CHECK', () => {
  const db = openDb(':memory:'); migrate(db);
  const { uid, pid, sid } = seed(db);

  const po = db.prepare("INSERT INTO purchase_orders (po_number, supplier_id, created_by) VALUES ('PO-1', ?, ?)").run(sid, uid).lastInsertRowid;
  assert.equal(db.prepare('SELECT status FROM purchase_orders WHERE id=?').get(po).status, 'draft');   // default
  assert.throws(() => db.prepare("INSERT INTO purchase_orders (po_number, status) VALUES ('PO-X','bogus')").run());  // CHECK

  const li = db.prepare("INSERT INTO purchase_order_items (po_id, product_id, qty_ordered, unit_cost) VALUES (?,?,?,?)").run(po, pid, 10, 950).lastInsertRowid;
  assert.equal(db.prepare('SELECT line_total FROM purchase_order_items WHERE id=?').get(li).line_total, 9500);  // 10 * 950, GENERATED

  db.prepare('DELETE FROM purchase_orders WHERE id=?').run(po);   // ON DELETE CASCADE
  assert.equal(db.prepare('SELECT count(*) c FROM purchase_order_items WHERE po_id=?').get(po).c, 0);
});

test('028 requisitions + stock counts: cascade, CHECK, GENERATED variance', () => {
  const db = openDb(':memory:'); migrate(db);
  const { uid, pid, did } = seed(db);

  const req = db.prepare("INSERT INTO purchase_requisitions (req_number, department_id, requested_by) VALUES ('REQ-1', ?, ?)").run(did, uid).lastInsertRowid;
  db.prepare("INSERT INTO purchase_requisition_items (req_id, product_id, qty) VALUES (?,?,?)").run(req, pid, 5);
  assert.throws(() => db.prepare("INSERT INTO purchase_requisitions (req_number, status) VALUES ('R2','nope')").run());  // CHECK
  db.prepare('DELETE FROM purchase_requisitions WHERE id=?').run(req);
  assert.equal(db.prepare('SELECT count(*) c FROM purchase_requisition_items WHERE req_id=?').get(req).c, 0);

  const cnt = db.prepare("INSERT INTO stock_counts (count_number, counted_by) VALUES ('SC-1', ?)").run(uid).lastInsertRowid;
  const ci = db.prepare("INSERT INTO stock_count_items (count_id, product_id, system_qty, counted_qty) VALUES (?,?,?,?)").run(cnt, pid, 100, 93).lastInsertRowid;
  assert.equal(db.prepare('SELECT variance FROM stock_count_items WHERE id=?').get(ci).variance, -7);  // 93 - 100, GENERATED
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
});

test('028 registry: inventory can write, unauthorized roles are blocked', () => {
  const INV = { id: 1, role: 'inventory' };
  const CASH = { id: 2, role: 'cashier' };

  // inventory may create a supplier and a PO…
  assert.ok(compile({ table: 'suppliers', op: 'insert', values: { name: 'X' } }, INV).sql);
  assert.ok(compile({ table: 'purchase_orders', op: 'insert', values: { po_number: 'PO-9', status: 'draft' } }, INV).sql);
  // …cashier may not write procurement docs…
  assert.throws(() => compile({ table: 'suppliers', op: 'insert', values: { name: 'X' } }, CASH),
    (e) => e instanceof CompileError && e.status === 403);
  // …and nobody may delete a supplier (retired via active=0).
  assert.throws(() => compile({ table: 'suppliers', op: 'delete', filters: [{ col: 'id', op: 'eq', val: 1 }] }, INV),
    (e) => e instanceof CompileError && e.status === 403);
});

test('028 registry: PO select resolves the suppliers embed to a JOIN', () => {
  const c = compile({ table: 'purchase_orders', op: 'select', columns: 'id,po_number,total,suppliers(id,name)',
                      filters: [{ col: 'status', op: 'eq', val: 'draft' }] }, { id: 1, role: 'inventory' });
  assert.match(c.sql, /join/i);
  assert.ok(c.meta.embeds.some((e) => e.name === 'suppliers'));
});
