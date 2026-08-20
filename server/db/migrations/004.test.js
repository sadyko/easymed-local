import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

test('004 creates billing tables with constraints', () => {
  const db = openDb(':memory:');
  migrate(db);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  for (const t of ['services','visit_services','invoices','invoice_items','payments']) assert.ok(tables.includes(t), 'missing ' + t);

  // a service exists with just name + price
  const sid = db.prepare("INSERT INTO services (name, price) VALUES ('Consultation', 50000)").run().lastInsertRowid;
  assert.equal(db.prepare('SELECT active FROM services WHERE id=?').get(sid).active, 1); // default active

  // invoice defaults + status CHECK
  const p = db.prepare("INSERT INTO patients (full_name, branch_id) VALUES ('P',1)").run().lastInsertRowid;
  const inv = db.prepare("INSERT INTO invoices (patient_id) VALUES (?)").run(p).lastInsertRowid;
  const row = db.prepare('SELECT status, paid_amount, total_amount FROM invoices WHERE id=?').get(inv);
  assert.equal(row.status, 'unpaid');
  assert.equal(row.paid_amount, 0);
  assert.throws(() => db.prepare("INSERT INTO invoices (patient_id, status) VALUES (?, 'bogus')").run(p));

  // invoice_number is UNIQUE
  db.prepare("UPDATE invoices SET invoice_number='INV-26-00001' WHERE id=?").run(inv);
  const inv2 = db.prepare("INSERT INTO invoices (patient_id) VALUES (?)").run(p).lastInsertRowid;
  assert.throws(() => db.prepare("UPDATE invoices SET invoice_number='INV-26-00001' WHERE id=?").run(inv2));
});
