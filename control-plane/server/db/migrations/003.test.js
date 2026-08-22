import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { createEnrollmentCode } from '../../services/enrollment.js';

// STATS_V1 — clinics.collect_set, the vendor's per-clinic counter picklist.
// See this migration's own header for why NULL is the meaningful default
// rather than a baked-in list.

function freshDb() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

test('003: clinics.collect_set exists and defaults to NULL for a freshly enrolled clinic', () => {
  const db = freshDb();
  createEnrollmentCode(db, { clinicId: 'c-1', name: 'Test Clinic' });
  const row = db.prepare('SELECT collect_set FROM clinics WHERE clinic_id = ?').get('c-1');
  assert.equal(row.collect_set, null, 'NULL means "the default set" — never baked into the schema');
});

test('003: collect_set can store an arbitrary JSON array of counter names', () => {
  const db = freshDb();
  createEnrollmentCode(db, { clinicId: 'c-1', name: 'Test Clinic' });
  const json = JSON.stringify(['patients_total', 'billed_today']);
  db.prepare('UPDATE clinics SET collect_set = ? WHERE clinic_id = ?').run(json, 'c-1');
  const row = db.prepare('SELECT collect_set FROM clinics WHERE clinic_id = ?').get('c-1');
  assert.deepEqual(JSON.parse(row.collect_set), ['patients_total', 'billed_today']);
});

test('003: collect_set can store an explicit empty list — "collect nothing" is a real, distinct choice from NULL', () => {
  const db = freshDb();
  createEnrollmentCode(db, { clinicId: 'c-1', name: 'Test Clinic' });
  db.prepare('UPDATE clinics SET collect_set = ? WHERE clinic_id = ?').run(JSON.stringify([]), 'c-1');
  const row = db.prepare('SELECT collect_set FROM clinics WHERE clinic_id = ?').get('c-1');
  assert.notEqual(row.collect_set, null, 'an explicit empty array must not collapse back to NULL/default');
  assert.deepEqual(JSON.parse(row.collect_set), []);
});

test('003: collect_set has no CHECK or DEFAULT baked into the schema — a hand-edited non-JSON value is still accepted at the SQL layer (validated in code, not SQL, per this migration\'s own design)', () => {
  const db = freshDb();
  createEnrollmentCode(db, { clinicId: 'c-1', name: 'Test Clinic' });
  assert.doesNotThrow(() => db.prepare("UPDATE clinics SET collect_set = 'not json' WHERE clinic_id = ?").run('c-1'));
});

test('003: other clinics columns are unaffected by this migration', () => {
  const db = freshDb();
  createEnrollmentCode(db, { clinicId: 'c-1', name: 'Test Clinic' });
  const row = db.prepare('SELECT subscription, active FROM clinics WHERE clinic_id = ?').get('c-1');
  assert.equal(row.subscription, 'active');
  assert.equal(row.active, 1);
});
