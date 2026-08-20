import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

test('009 adds conclusion + conclusion_type to visits', () => {
  const db = openDb(':memory:'); migrate(db);
  const pid = db.prepare("INSERT INTO patients (full_name, branch_id) VALUES ('P',1)").run().lastInsertRowid;
  const vid = db.prepare("INSERT INTO visits (patient_id, branch_id, visit_date) VALUES (?,1,'2026-08-12T09:00:00Z')").run(pid).lastInsertRowid;
  const row = db.prepare('SELECT conclusion, conclusion_type FROM visits WHERE id=?').get(vid);
  assert.equal(row.conclusion, '');                 // default empty
  assert.equal(row.conclusion_type, 'consultation'); // default
  db.prepare("UPDATE visits SET conclusion='All normal', conclusion_type='diagnostic' WHERE id=?").run(vid);
  assert.equal(db.prepare('SELECT conclusion_type FROM visits WHERE id=?').get(vid).conclusion_type, 'diagnostic');
  // CHECK constraint rejects unknown type
  assert.throws(() => db.prepare("UPDATE visits SET conclusion_type='bogus' WHERE id=?").run(vid));
});
