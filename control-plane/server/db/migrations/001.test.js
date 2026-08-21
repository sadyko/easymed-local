import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

function freshDb() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

test('001: a clinic requires a unique clinic_id — inserting the same one twice throws', () => {
  // THE guarantee: settings.easymed.uz must never confuse two clinics. If this
  // insert were allowed to succeed twice, a second clinic could silently start
  // reusing the identity baked into another clinic's signed licence.
  const db = freshDb();
  const insert = () => db.prepare(
    `INSERT INTO clinics (clinic_id, name, unlock_secret) VALUES (?, ?, ?)`
  ).run('c-000001', 'First Clinic', 'secret-1');

  insert();
  assert.throws(() => insert(), /UNIQUE constraint failed/);
});

test('001: enrollment_code is unique, and nullable (cleared after enrollment)', () => {
  const db = freshDb();
  const insertWithCode = (clinicId, code) => db.prepare(
    `INSERT INTO clinics (clinic_id, name, unlock_secret, enrollment_code) VALUES (?, ?, ?, ?)`
  ).run(clinicId, 'Clinic ' + clinicId, 'secret', code);

  insertWithCode('c-000001', 'EM-AAAA-1111');
  assert.throws(
    () => insertWithCode('c-000002', 'EM-AAAA-1111'),
    /UNIQUE constraint failed/
  );

  // Multiple NULLs must be allowed — every enrolled clinic clears its code to
  // NULL, and there can be many enrolled clinics.
  db.prepare(`UPDATE clinics SET enrollment_code = NULL WHERE clinic_id = 'c-000001'`).run();
  assert.doesNotThrow(() => insertWithCode('c-000003', null));
  assert.doesNotThrow(() => insertWithCode('c-000004', null));
});

test('001: install_token is unique — two installs cannot share one', () => {
  const db = freshDb();
  const insertWithToken = (clinicId, token) => db.prepare(
    `INSERT INTO clinics (clinic_id, name, unlock_secret, install_token) VALUES (?, ?, ?, ?)`
  ).run(clinicId, 'Clinic ' + clinicId, 'secret', token);

  insertWithToken('c-000001', 'tok-aaa');
  assert.throws(
    () => insertWithToken('c-000002', 'tok-aaa'),
    /UNIQUE constraint failed/
  );
});

test('001: an entitlement is (clinic_id, module_key) unique — a module cannot be granted twice', () => {
  const db = freshDb();
  db.prepare(`INSERT INTO clinics (clinic_id, name, unlock_secret) VALUES (?, ?, ?)`)
    .run('c-000001', 'Clinic', 'secret');

  const grant = () => db.prepare(
    `INSERT INTO clinic_modules (clinic_id, module_key) VALUES (?, ?)`
  ).run('c-000001', 'crm');

  grant();
  assert.throws(() => grant(), /UNIQUE constraint failed/);
});

test('001: deleting a clinic cascades to entitlements but leaves check-in history', () => {
  const db = freshDb();
  db.prepare(`INSERT INTO clinics (clinic_id, name, unlock_secret) VALUES (?, ?, ?)`)
    .run('c-000001', 'Clinic', 'secret');
  db.prepare(`INSERT INTO clinic_modules (clinic_id, module_key) VALUES (?, ?)`)
    .run('c-000001', 'crm');
  db.prepare(
    `INSERT INTO checkins (clinic_id, version, fingerprint, payload) VALUES (?, ?, ?, ?)`
  ).run('c-000001', '1.0.0', 'fp-1', '{}');

  assert.equal(db.prepare('SELECT COUNT(*) n FROM clinic_modules').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM checkins').get().n, 1);

  db.prepare('DELETE FROM clinics WHERE clinic_id = ?').run('c-000001');

  assert.equal(db.prepare('SELECT COUNT(*) n FROM clinic_modules').get().n, 0);
  // History is evidence, not state — it survives the clinic row it points at.
  assert.equal(db.prepare('SELECT COUNT(*) n FROM checkins').get().n, 1);
});

test('001: subscription_until is nullable — a clinic in trial or unpaid has none', () => {
  const db = freshDb();
  assert.doesNotThrow(() => db.prepare(
    `INSERT INTO clinics (clinic_id, name, unlock_secret) VALUES (?, ?, ?)`
  ).run('c-000001', 'Clinic', 'secret'));

  const row = db.prepare('SELECT subscription_until FROM clinics WHERE clinic_id = ?').get('c-000001');
  assert.equal(row.subscription_until, null);
});

test('001: a check-in row records clinic_id, at, version, fingerprint and a JSON payload', () => {
  const db = freshDb();
  db.prepare(`INSERT INTO clinics (clinic_id, name, unlock_secret) VALUES (?, ?, ?)`)
    .run('c-000001', 'Clinic', 'secret');

  const payload = JSON.stringify({ patients: 1234, doctors: 12 });
  db.prepare(
    `INSERT INTO checkins (clinic_id, version, fingerprint, payload) VALUES (?, ?, ?, ?)`
  ).run('c-000001', '1.2.3', 'fp-abc', payload);

  const row = db.prepare('SELECT * FROM checkins WHERE clinic_id = ?').get('c-000001');
  assert.equal(row.clinic_id, 'c-000001');
  assert.ok(row.at, 'at should be auto-populated');
  assert.equal(row.version, '1.2.3');
  assert.equal(row.fingerprint, 'fp-abc');
  assert.deepEqual(JSON.parse(row.payload), { patients: 1234, doctors: 12 });
});

test('001: module_requests records a lead with a status that defaults to open', () => {
  const db = freshDb();
  db.prepare(`INSERT INTO clinics (clinic_id, name, unlock_secret) VALUES (?, ?, ?)`)
    .run('c-000001', 'Clinic', 'secret');

  db.prepare(
    `INSERT INTO module_requests (clinic_id, module_key, requested_at) VALUES (?, ?, ?)`
  ).run('c-000001', 'crm', '2026-08-20T00:00:00Z');

  const row = db.prepare('SELECT * FROM module_requests WHERE clinic_id = ?').get('c-000001');
  assert.equal(row.status, 'open');
  assert.equal(row.module_key, 'crm');
  assert.equal(row.handled_at, null);
});

// --- Attack tests: things the schema could get wrong without a test noticing ---

test('001: clinic_id is case-sensitive by design — c-000047 and C-000047 are different rows', () => {
  // These ids appear in signed licences and get typed by humans on the phone.
  // A binary (case-sensitive) comparison is deliberate here: clinic_id is
  // GENERATED by the vendor (never typed as the primary lookup key — the
  // enrollment_code and unlock challenge are what a human types), so the
  // upside of case-insensitivity (typo tolerance) doesn't apply, and folding
  // case would let 'c-000047' and 'C-000047' collide in ways the licence
  // signer never intended. If this ever needs to change, COLLATE NOCASE on
  // the column is the tool — this test pins the current, deliberate choice.
  const db = freshDb();
  db.prepare(`INSERT INTO clinics (clinic_id, name, unlock_secret) VALUES (?, ?, ?)`)
    .run('c-000047', 'Lower', 'secret');
  assert.doesNotThrow(() => db.prepare(
    `INSERT INTO clinics (clinic_id, name, unlock_secret) VALUES (?, ?, ?)`
  ).run('C-000047', 'Upper', 'secret'));

  assert.equal(db.prepare('SELECT COUNT(*) n FROM clinics').get().n, 2);
});

test('001: a clinic_id can be reused after the row that held it is deleted (no reuse guard in this schema)', () => {
  // Documents the current behaviour rather than prescribing it: this schema
  // does not forbid re-inserting a clinic_id once its row is deleted. That
  // matters because a licence signed for the OLD clinic would then verify
  // successfully against the NEW row sharing that id. The decision taken for
  // v1 is to never actually delete a clinic row for this reason — `active =
  // 0` is how a clinic is retired (see the `active` column) — and to leave
  // deletion available only for tests/ops cleanup. This test pins today's
  // literal behaviour so a future change is a deliberate, visible diff here.
  const db = freshDb();
  db.prepare(`INSERT INTO clinics (clinic_id, name, unlock_secret) VALUES (?, ?, ?)`)
    .run('c-000099', 'Original', 'secret-a');
  db.prepare('DELETE FROM clinics WHERE clinic_id = ?').run('c-000099');

  assert.doesNotThrow(() => db.prepare(
    `INSERT INTO clinics (clinic_id, name, unlock_secret) VALUES (?, ?, ?)`
  ).run('c-000099', 'Reused', 'secret-b'));
});

test('001: subscription only accepts active or unpaid — a typo is rejected, not silently stored', () => {
  const db = freshDb();
  assert.doesNotThrow(() => db.prepare(
    `INSERT INTO clinics (clinic_id, name, unlock_secret, subscription) VALUES (?, ?, ?, ?)`
  ).run('c-000001', 'Clinic', 'secret', 'active'));
  assert.doesNotThrow(() => db.prepare(
    `INSERT INTO clinics (clinic_id, name, unlock_secret, subscription) VALUES (?, ?, ?, ?)`
  ).run('c-000002', 'Clinic', 'secret', 'unpaid'));

  assert.throws(
    () => db.prepare(
      `INSERT INTO clinics (clinic_id, name, unlock_secret, subscription) VALUES (?, ?, ?, ?)`
    ).run('c-000003', 'Clinic', 'secret', 'aktive'),
    /CHECK constraint failed/
  );
});

test('001: subscription defaults to active when not specified', () => {
  const db = freshDb();
  db.prepare(`INSERT INTO clinics (clinic_id, name, unlock_secret) VALUES (?, ?, ?)`)
    .run('c-000001', 'Clinic', 'secret');
  const row = db.prepare('SELECT subscription FROM clinics WHERE clinic_id = ?').get('c-000001');
  assert.equal(row.subscription, 'active');
});
