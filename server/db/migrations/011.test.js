import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

test('011 creates the settings config tables with defaults/CHECKs and FKs', () => {
  const db = openDb(':memory:'); migrate(db);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name);
  for (const t of ['departments','service_types','consultation_types','patient_categories','floors','rooms','wards','beds']) assert.ok(tables.includes(t), 'missing '+t);

  // departments kind CHECK + default active
  const d = db.prepare("INSERT INTO departments (name) VALUES ('Cardiology')").run().lastInsertRowid;
  assert.equal(db.prepare('SELECT kind, active FROM departments WHERE id=?').get(d).kind, 'clinical');
  assert.throws(() => db.prepare("INSERT INTO departments (name, kind) VALUES ('X','bogus')").run());

  // service_types billing_mode CHECK
  db.prepare("INSERT INTO service_types (name) VALUES ('Lab')").run();
  assert.throws(() => db.prepare("INSERT INTO service_types (name, billing_mode) VALUES ('Y','bogus')").run());

  // rooms -> floors FK, beds -> wards FK
  const f = db.prepare("INSERT INTO floors (name, level) VALUES ('Ground', 0)").run().lastInsertRowid;
  const r = db.prepare("INSERT INTO rooms (name, floor_id) VALUES ('Room 101', ?)").run(f).lastInsertRowid;
  assert.equal(db.prepare('SELECT floor_id FROM rooms WHERE id=?').get(r).floor_id, f);
  const w = db.prepare("INSERT INTO wards (name) VALUES ('Ward A')").run().lastInsertRowid;
  const b = db.prepare("INSERT INTO beds (code, ward_id) VALUES ('A-01', ?)").run(w).lastInsertRowid;
  assert.equal(db.prepare('SELECT status FROM beds WHERE id=?').get(b).status, 'free'); // default
  assert.throws(() => db.prepare("INSERT INTO beds (code, ward_id, status) VALUES ('A-02', ?, 'bogus')").run(w));
});
