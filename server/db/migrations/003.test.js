import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

test('003 creates visits with FK to patients and a status CHECK', () => {
  const db = openDb(':memory:');
  migrate(db);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  assert.ok(tables.includes('visits'));

  // seed a patient (migration 002 seeded branch id 1)
  const p = db.prepare("INSERT INTO patients (full_name, branch_id) VALUES ('P', 1)").run().lastInsertRowid;
  const info = db.prepare("INSERT INTO visits (patient_id, doctor_id, branch_id, visit_date) VALUES (?,?,?,?)")
    .run(p, null, 1, '2026-08-10T09:00:00Z');
  const row = db.prepare('SELECT status, visit_type, duration_minutes FROM visits WHERE id=?').get(info.lastInsertRowid);
  assert.equal(row.status, 'scheduled');          // default
  assert.equal(row.visit_type, 'outpatient');     // default
  assert.equal(row.duration_minutes, 30);         // default

  // status CHECK rejects an unknown value
  assert.throws(() => db.prepare("INSERT INTO visits (patient_id, branch_id, visit_date, status) VALUES (?,?,?,?)")
    .run(p, 1, '2026-08-10T10:00:00Z', 'bogus_status'));
});
