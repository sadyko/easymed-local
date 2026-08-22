import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { createEnrollmentCode } from '../../services/enrollment.js';

// UPDATE_DELIVERY_V1 — the releases table, and clinics.ring/pinned_version.
// See this migration's own header for why ring lives on both rows for
// different reasons, and why pinned_version's NULL is "not pinned" rather
// than some sentinel version string.

function freshDb() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

function insertRelease(db, overrides = {}) {
  const row = { version: '2.4.0', notes_ru: 'Тест', url: 'https://example/2.4.0.tar.gz', sha256: 'abc123', manifest: '{}', ...overrides };
  db.prepare(
    `INSERT INTO releases (version, notes_ru, url, sha256, manifest${row.ring !== undefined ? ', ring' : ''}${row.halted !== undefined ? ', halted' : ''})
     VALUES (?, ?, ?, ?, ?${row.ring !== undefined ? ', ?' : ''}${row.halted !== undefined ? ', ?' : ''})`
  ).run(...[row.version, row.notes_ru, row.url, row.sha256, row.manifest, ...(row.ring !== undefined ? [row.ring] : []), ...(row.halted !== undefined ? [row.halted] : [])]);
  return row.version;
}

// --- releases: defaults ------------------------------------------------------

test('004: a freshly registered release defaults to ring=-1 (not published) and halted=0', () => {
  const db = freshDb();
  insertRelease(db);
  const row = db.prepare('SELECT ring, halted, outcome_failures, outcome_successes FROM releases WHERE version = ?').get('2.4.0');
  assert.equal(row.ring, -1, 'registered-but-not-published is a real, distinct default — never NULL');
  assert.equal(row.halted, 0);
  assert.equal(row.outcome_failures, 0);
  assert.equal(row.outcome_successes, 0);
});

test('004: releases stores notes_ru, url, sha256 and the manifest JSON verbatim', () => {
  const db = freshDb();
  const manifest = JSON.stringify({ payload: { version: '2.4.0' }, sig: 'deadbeef' });
  insertRelease(db, { manifest });
  const row = db.prepare('SELECT notes_ru, url, sha256, manifest FROM releases WHERE version = ?').get('2.4.0');
  assert.equal(row.notes_ru, 'Тест');
  assert.equal(row.url, 'https://example/2.4.0.tar.gz');
  assert.equal(row.sha256, 'abc123');
  assert.equal(row.manifest, manifest, 'stored opaquely — byte for byte what was given');
});

test('004: version is the primary key — registering the same version twice throws', () => {
  const db = freshDb();
  insertRelease(db);
  assert.throws(() => insertRelease(db), /UNIQUE constraint failed|PRIMARY KEY/);
});

// --- releases: CHECK constraints --------------------------------------------

test('004: releases.ring only accepts -1, 0, 1, or 2 — a stray value is rejected, not silently stored', () => {
  const db = freshDb();
  for (const ring of [-1, 0, 1, 2]) {
    assert.doesNotThrow(() => insertRelease(db, { version: `ok-${ring}`, ring }), `ring=${ring} must be accepted`);
  }
  assert.throws(() => insertRelease(db, { version: 'bad', ring: 3 }), /CHECK constraint failed/);
  assert.throws(() => insertRelease(db, { version: 'bad2', ring: -2 }), /CHECK constraint failed/);
});

test('004: releases.halted only accepts 0 or 1', () => {
  const db = freshDb();
  assert.doesNotThrow(() => insertRelease(db, { version: 'h0', halted: 0 }));
  assert.doesNotThrow(() => insertRelease(db, { version: 'h1', halted: 1 }));
  assert.throws(() => insertRelease(db, { version: 'h2', halted: 2 }), /CHECK constraint failed/);
});

// --- clinics.ring ------------------------------------------------------------

test('004: a freshly enrolled clinic defaults to ring=2 (everyone), not an early ring by accident', () => {
  const db = freshDb();
  createEnrollmentCode(db, { clinicId: 'c-1', name: 'Test Clinic' });
  const row = db.prepare('SELECT ring FROM clinics WHERE clinic_id = ?').get('c-1');
  assert.equal(row.ring, 2);
});

test('004: clinics.ring only accepts 0, 1, or 2', () => {
  const db = freshDb();
  createEnrollmentCode(db, { clinicId: 'c-1', name: 'Test Clinic' });
  assert.doesNotThrow(() => db.prepare('UPDATE clinics SET ring = 0 WHERE clinic_id = ?').run('c-1'));
  assert.doesNotThrow(() => db.prepare('UPDATE clinics SET ring = 1 WHERE clinic_id = ?').run('c-1'));
  assert.throws(() => db.prepare('UPDATE clinics SET ring = 3 WHERE clinic_id = ?').run('c-1'), /CHECK constraint failed/);
  assert.throws(() => db.prepare('UPDATE clinics SET ring = -1 WHERE clinic_id = ?').run('c-1'), /CHECK constraint failed/,
    'a clinic itself is never ring -1 — that sentinel means "unpublished release", not a clinic cohort');
});

// --- clinics.pinned_version --------------------------------------------------

test('004: pinned_version defaults to NULL — "not pinned" for a freshly enrolled clinic', () => {
  const db = freshDb();
  createEnrollmentCode(db, { clinicId: 'c-1', name: 'Test Clinic' });
  const row = db.prepare('SELECT pinned_version FROM clinics WHERE clinic_id = ?').get('c-1');
  assert.equal(row.pinned_version, null);
});

test('004: pinned_version can be set to an arbitrary version string and cleared back to NULL', () => {
  const db = freshDb();
  createEnrollmentCode(db, { clinicId: 'c-1', name: 'Test Clinic' });
  db.prepare('UPDATE clinics SET pinned_version = ? WHERE clinic_id = ?').run('2.4.0', 'c-1');
  assert.equal(db.prepare('SELECT pinned_version FROM clinics WHERE clinic_id = ?').get('c-1').pinned_version, '2.4.0');

  db.prepare('UPDATE clinics SET pinned_version = NULL WHERE clinic_id = ?').run('c-1');
  assert.equal(db.prepare('SELECT pinned_version FROM clinics WHERE clinic_id = ?').get('c-1').pinned_version, null);
});

// --- existing clinics/other migrations are unaffected -----------------------

test('004: pre-existing clinics columns (subscription, active, collect_set) are unaffected', () => {
  const db = freshDb();
  createEnrollmentCode(db, { clinicId: 'c-1', name: 'Test Clinic' });
  const row = db.prepare('SELECT subscription, active, collect_set, ring, pinned_version FROM clinics WHERE clinic_id = ?').get('c-1');
  assert.equal(row.subscription, 'active');
  assert.equal(row.active, 1);
  assert.equal(row.collect_set, null);
  assert.equal(row.ring, 2);
  assert.equal(row.pinned_version, null);
});
