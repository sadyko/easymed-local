import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { createEnrollmentCode } from '../../services/enrollment.js';

// CONTROL_PLANE_V2 — deleted_clinics is the reason a hard DELETE is safe at all.
//
// 001_registry.sql states the danger in its own words: clinic_id is baked into
// every signed licence, and routes/admin.js:nextClinicId allocates
// max(numeric suffix) + 1 read straight off the clinics table. Delete the
// newest clinic and the next one created takes its number back; the deleted
// clinic's licence file — still on its old computer — then verifies against a
// different clinic. These tests are about what the SCHEMA guarantees on its
// own, with no route involved, because the route is not the only thing that
// will ever insert into clinics.

function freshDb() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

test('010: a deleted clinic_id can never be inserted again', () => {
  const db = freshDb();
  createEnrollmentCode(db, { clinicId: 'c-000009', name: 'Last Test Clinic' });
  db.prepare('DELETE FROM clinics WHERE clinic_id = ?').run('c-000009');
  db.prepare('INSERT INTO deleted_clinics (clinic_id, name, deleted_by) VALUES (?,?,?)')
    .run('c-000009', 'Last Test Clinic', 'vendor');

  // The trigger, not the application. A future route, a hand-run INSERT and a
  // replayed backup must all hit the same wall.
  assert.throws(
    () => createEnrollmentCode(db, { clinicId: 'c-000009', name: 'A Different Clinic' }),
    /permanently deleted/i,
  );
});

test('010: the tombstone does not block any other id', () => {
  const db = freshDb();
  db.prepare('INSERT INTO deleted_clinics (clinic_id, name) VALUES (?,?)').run('c-000009', 'Gone');
  createEnrollmentCode(db, { clinicId: 'c-000010', name: 'Fine' });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM clinics').get().n, 1);
});

test('010: a tombstone records who and when, and stamps itself', () => {
  const db = freshDb();
  db.prepare('INSERT INTO deleted_clinics (clinic_id, name, deleted_by) VALUES (?,?,?)')
    .run('c-000008', 'test on laptop', 'vendor');
  const row = db.prepare('SELECT * FROM deleted_clinics WHERE clinic_id = ?').get('c-000008');
  assert.equal(row.name, 'test on laptop');
  assert.equal(row.deleted_by, 'vendor');
  assert.match(row.deleted_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
    'deleted_at defaults to a UTC timestamp, same shape as clinics.created_at');
});

test('010: one id cannot be tombstoned twice', () => {
  const db = freshDb();
  const ins = db.prepare('INSERT INTO deleted_clinics (clinic_id, name) VALUES (?,?)');
  ins.run('c-000008', 'test on laptop');
  assert.throws(() => ins.run('c-000008', 'test on laptop'), /UNIQUE|PRIMARY/i);
});

test('010: the tombstone holds no patient data and no credential', () => {
  const db = freshDb();
  const cols = db.prepare('PRAGMA table_info(deleted_clinics)').all().map((c) => c.name).sort();
  // Same guarantee 001 and 005 state as a schema fact. install_token and
  // unlock_secret must die with the row, never be preserved in the tombstone.
  assert.deepEqual(cols, ['clinic_id', 'deleted_at', 'deleted_by', 'name']);
});

test('010: retired_at exists and is null for clinics retired before this migration', () => {
  const db = freshDb();
  createEnrollmentCode(db, { clinicId: 'c-000008', name: 'test on laptop' });
  db.prepare('UPDATE clinics SET active = 0 WHERE clinic_id = ?').run('c-000008');
  const row = db.prepare('SELECT retired_at FROM clinics WHERE clinic_id = ?').get('c-000008');
  assert.equal(row.retired_at, null,
    'no backfill: a date we do not know must read as unknown, never as today');
});

test('010: migrate() is idempotent — a second run is a no-op', () => {
  const db = freshDb();
  migrate(db);
  migrate(db);
  const n = db.prepare("SELECT COUNT(*) n FROM schema_migrations WHERE name = '010_deleted_clinics.sql'").get().n;
  assert.equal(n, 1);
});
