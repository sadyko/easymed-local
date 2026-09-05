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

test('010: the error is SQLITE_CONSTRAINT_TRIGGER, not assumed', () => {
  // routes/admin.js:82-92 documents a real prior instance of this codebase
  // guessing a SQLite error code wrong (PRIMARYKEY vs UNIQUE) and having the
  // guess go unnoticed because the message text was identical either way. Pin
  // the code AND the message here so Task 4's 409 mapping has a fact to code
  // against instead of another guess.
  const db = freshDb();
  db.prepare('INSERT INTO deleted_clinics (clinic_id, name) VALUES (?,?)').run('c-000009', 'Gone');
  let caught;
  try {
    db.prepare('INSERT INTO clinics (clinic_id, name, install_token, unlock_secret) VALUES (?,?,?,?)')
      .run('c-000009', 'X', 'tok', 'secret');
  } catch (e) {
    caught = e;
  }
  assert.ok(caught, 'expected the insert to throw');
  assert.equal(caught.code, 'SQLITE_CONSTRAINT_TRIGGER');
  assert.match(caught.message, /permanently deleted/);
});

test('010: every insert path onto a tombstoned id is refused, not only a plain INSERT', () => {
  // The migration's own comment claims the trigger catches every insert path,
  // not just the one createEnrollmentCode happens to use. SQLite conflict
  // resolution (OR IGNORE, OR REPLACE) and ON CONFLICT clauses all still fire
  // BEFORE INSERT triggers before the conflict resolution is applied, but that
  // is exactly the kind of claim worth pinning rather than trusting.
  const db = freshDb();
  db.prepare('INSERT INTO deleted_clinics (clinic_id, name) VALUES (?,?)').run('c-000009', 'Gone');

  assert.throws(
    () => db.prepare(
      'INSERT OR IGNORE INTO clinics (clinic_id, name, install_token, unlock_secret) VALUES (?,?,?,?)'
    ).run('c-000009', 'X', 'tok-a', 'secret-a'),
    /permanently deleted/i,
    'INSERT OR IGNORE must still hit the wall',
  );

  assert.throws(
    () => db.prepare(
      'INSERT OR REPLACE INTO clinics (clinic_id, name, install_token, unlock_secret) VALUES (?,?,?,?)'
    ).run('c-000009', 'X', 'tok-b', 'secret-b'),
    /permanently deleted/i,
    'INSERT OR REPLACE must still hit the wall',
  );

  assert.equal(db.prepare('SELECT COUNT(*) n FROM clinics WHERE clinic_id = ?').get('c-000009').n, 0);
});

test('010: renaming a live clinic onto a tombstoned id is refused too', () => {
  // A BEFORE INSERT trigger is structurally blind to UPDATE clinics SET
  // clinic_id = .... A rename is the same threat as a resurrection-by-insert:
  // the row ends up carrying an id whose old signed licence is still valid
  // somewhere else. clinics_no_resurrection_rename is the second trigger that
  // covers this path.
  const db = freshDb();
  createEnrollmentCode(db, { clinicId: 'c-000001', name: 'Renamed Clinic' });
  db.prepare('INSERT INTO deleted_clinics (clinic_id, name) VALUES (?,?)').run('c-000009', 'Gone');

  assert.throws(
    () => db.prepare('UPDATE clinics SET clinic_id = ? WHERE clinic_id = ?').run('c-000009', 'c-000001'),
    /permanently deleted/i,
  );
  assert.equal(db.prepare('SELECT COUNT(*) n FROM clinics WHERE clinic_id = ?').get('c-000001').n, 1,
    'the rename must not have partially applied');
});

test('010: both resurrection triggers exist by name', () => {
  // Same style as 008.test.js:132 pinning an index by name: a rename of the
  // trigger, or a future migration accidentally dropping one, should fail a
  // test here rather than being discovered only when someone actually renames
  // a clinic onto a dead id.
  const db = freshDb();
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all().map((r) => r.name);
  assert.ok(names.includes('clinics_no_resurrection'), names.join(','));
  assert.ok(names.includes('clinics_no_resurrection_rename'), names.join(','));
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
  // Simulate a clinic that was ALREADY retired under the pre-010 schema, then
  // watch 010 land on top of it — the actual sequence of events for c-000008 on
  // the live registry. Creating the clinic after migrate() has already run (as
  // the first draft of this test did) only ever exercises the ADD COLUMN
  // default; it cannot distinguish "no backfill" from "backfill to today", so it
  // could not fail against the mistake it names. Rewind pattern from
  // 008.test.js:43-53.
  const db = openDb(':memory:');
  migrate(db);
  db.prepare('DELETE FROM schema_migrations WHERE name = ?').run('010_deleted_clinics.sql');
  db.exec('DROP TRIGGER clinics_no_resurrection');
  db.exec('DROP TRIGGER clinics_no_resurrection_rename');
  db.exec('DROP TABLE deleted_clinics');
  db.exec('ALTER TABLE clinics DROP COLUMN retired_at');

  createEnrollmentCode(db, { clinicId: 'c-000008', name: 'test on laptop' });
  db.prepare('UPDATE clinics SET active = 0 WHERE clinic_id = ?').run('c-000008');

  migrate(db);   // 010 lands on a clinic already retired under the old schema

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
