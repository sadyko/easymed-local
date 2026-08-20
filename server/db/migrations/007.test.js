import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

test('007 creates products + stock_movements and adds visit_services.clinic_item_id', () => {
  const db = openDb(':memory:'); migrate(db);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name);
  assert.ok(tables.includes('products'));
  assert.ok(tables.includes('stock_movements'));

  const pid = db.prepare("INSERT INTO products (name, unit, sale_price) VALUES ('Paracetamol','box',12000)").run().lastInsertRowid;
  const p = db.prepare('SELECT on_hand, category, active, reorder_level FROM products WHERE id=?').get(pid);
  assert.equal(p.on_hand, 0);            // default
  assert.equal(p.category, 'other');     // default
  assert.equal(p.active, 1);
  // category CHECK
  assert.throws(() => db.prepare("INSERT INTO products (name, category) VALUES ('X','bogus')").run());
  // stock_movements kind CHECK
  assert.throws(() => db.prepare("INSERT INTO stock_movements (product_id, kind, qty) VALUES (?, 'bogus', 1)").run(pid));
  db.prepare("INSERT INTO stock_movements (product_id, kind, qty) VALUES (?, 'receive', 10)").run(pid);

  // visit_services.clinic_item_id exists (nullable FK)
  const patient = db.prepare("INSERT INTO patients (full_name, branch_id) VALUES ('P',1)").run().lastInsertRowid;
  const vid = db.prepare("INSERT INTO visits (patient_id, branch_id, visit_date) VALUES (?,1,'2026-08-12T09:00:00Z')").run(patient).lastInsertRowid;
  const vs = db.prepare("INSERT INTO visit_services (visit_id, clinic_item_id, quantity, unit_price, total) VALUES (?,?,1,12000,12000)").run(vid, pid).lastInsertRowid;
  assert.equal(db.prepare('SELECT clinic_item_id FROM visit_services WHERE id=?').get(vs).clinic_item_id, pid);
});
