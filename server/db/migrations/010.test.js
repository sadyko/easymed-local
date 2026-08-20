import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

test('010 adds unit-engine + costing columns to products and branch_id to stock_movements', () => {
  const db = openDb(':memory:'); migrate(db);
  const pid = db.prepare("INSERT INTO products (name, unit, sale_price, on_hand) VALUES ('Paracetamol','tab',500,0)").run().lastInsertRowid;
  const p = db.prepare('SELECT base_unit, pack_factor, consumption_factor, avg_cost, track_batches, is_drug, procurement_category FROM products WHERE id=?').get(pid);
  assert.equal(p.pack_factor, 1);            // defaults
  assert.equal(p.consumption_factor, 1);
  assert.equal(p.avg_cost, 0);
  assert.equal(p.track_batches, 0);
  assert.equal(p.procurement_category, 'consumables'); // default
  // procurement_category CHECK
  assert.throws(() => db.prepare("INSERT INTO products (name, procurement_category) VALUES ('X','bogus')").run());
  // stock_movements has branch_id (nullable, defaults null ok)
  db.prepare("INSERT INTO stock_movements (product_id, kind, qty, branch_id) VALUES (?, 'receive', 5, 1)").run(pid);
  assert.equal(db.prepare("SELECT branch_id FROM stock_movements WHERE product_id=?").get(pid).branch_id, 1);
});
