import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

test('023 widens services.type to allow radiology; keeps CHECK + FK integrity', () => {
  const db = openDb(':memory:'); migrate(db);

  // «Лучевая диагностика» (radiology) now allowed…
  const rad = db.prepare("INSERT INTO services (name, type) VALUES ('CT scan','radiology')").run().lastInsertRowid;
  assert.equal(db.prepare('SELECT type FROM services WHERE id=?').get(rad).type, 'radiology');
  // …but an unknown type is still rejected by the (widened) CHECK.
  assert.throws(() => db.prepare("INSERT INTO services (name, type) VALUES ('X','bogus')").run());

  // services is still FK-referenceable after the table rebuild.
  const s = db.prepare("INSERT INTO services (name, price) VALUES ('Consult', 50000)").run().lastInsertRowid;
  const p = db.prepare("INSERT INTO patients (full_name) VALUES ('P')").run().lastInsertRowid;
  const v = db.prepare("INSERT INTO visits (patient_id, visit_date) VALUES (?, '2026-08-12T09:00:00Z')").run(p).lastInsertRowid;
  db.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total) VALUES (?,?,1,50000,50000)").run(v, s);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
});
