import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { createEnrollmentCode, redeemEnrollmentCode } from '../../services/enrollment.js';

// BRANCH_IDENTITY_V1 — the relay_tokens table. Like 005 before it, these tests
// are about what the SCHEMA refuses to let happen, independently of any route:
// a credential for a relay id the relay route could never accept, a credential
// outliving the clinic it speaks for, two rows claiming one token string.

function freshDb() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

function enrol(db, clinicId = 'c-1', name = 'Test Clinic') {
  const code = createEnrollmentCode(db, { clinicId, name });
  return redeemEnrollmentCode(db, { code }).install_token;
}

const RELAY = 'b3'.repeat(16);
const insert = (db, token, clinicId = 'c-1', relayId = RELAY) => db.prepare(
  'INSERT INTO relay_tokens (token, clinic_id, relay_id) VALUES (?, ?, ?)'
).run(token, clinicId, relayId);

test('006: a token is unique — the same string cannot name two grants', () => {
  const db = freshDb();
  enrol(db);
  insert(db, 'tok-1');
  assert.throws(() => insert(db, 'tok-1'), /UNIQUE|PRIMARY/i);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM relay_tokens').get().n, 1);
});

test('006: the schema refuses a relay id the relay route could never accept', () => {
  const db = freshDb();
  enrol(db);
  // The route checks this first, so a probe never reaches here — this is the
  // second line: no future code path may create a live credential for an
  // address /cp/v1/relay would answer 404 to, which would be a support mystery
  // with no visible cause.
  for (const bad of ['', 'short', 'B3'.repeat(16), 'z'.repeat(32), '0'.repeat(31), '0'.repeat(33), '../secrets']) {
    assert.throws(() => insert(db, `tok-${bad}`, 'c-1', bad), /CHECK/i, `${JSON.stringify(bad)} must not be storable`);
  }
  insert(db, 'tok-ok', 'c-1', RELAY);   // and the real shape still is
  assert.equal(db.prepare('SELECT COUNT(*) n FROM relay_tokens').get().n, 1);
});

test('006: a token cannot exist without a clinic, and dies with it', () => {
  const db = freshDb();
  enrol(db);
  // foreign_keys is ON (db/connection.js), so a credential for a clinic that
  // does not exist is not writable in the first place.
  assert.throws(() => insert(db, 'tok-orphan', 'nobody'), /FOREIGN KEY/i);

  insert(db, 'tok-1');
  // ON DELETE CASCADE, and it must be: without it this DELETE would either fail
  // on the foreign key or leave a live token naming a clinic_id that no longer
  // exists — which routes/relay.js would then write into relay_blobs.clinic_id.
  db.prepare('DELETE FROM clinics WHERE clinic_id = ?').run('c-1');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM relay_tokens').get().n, 0,
    'a credential must never outlive the identity it speaks for');
});

test('006: created_at is stamped by the schema; last_used and revoked_at start empty', () => {
  const db = freshDb();
  enrol(db);
  insert(db, 'tok-1');
  const row = db.prepare('SELECT created_at, last_used, revoked_at FROM relay_tokens WHERE token = ?').get('tok-1');
  assert.match(row.created_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(row.last_used, null, 'never presented yet — that is what the sweep reads');
  assert.equal(row.revoked_at, null, 'live until somebody says otherwise');
});

test('006: one clinic may hold tokens for several relay ids, and several for one', () => {
  const db = freshDb();
  enrol(db);
  // Both shapes are real: several branches share ONE relay id (one token each),
  // and a clinic that re-issued its group key has tokens against the old id and
  // the new one at the same time.
  insert(db, 'tok-a', 'c-1', RELAY);
  insert(db, 'tok-b', 'c-1', RELAY);
  insert(db, 'tok-c', 'c-1', 'f'.repeat(32));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM relay_tokens WHERE clinic_id = ?').get('c-1').n, 3);
});

test('006: the table holds no secret but the token, and nothing about a payload', () => {
  const db = freshDb();
  const cols = db.prepare('PRAGMA table_info(relay_tokens)').all().map((c) => c.name);
  // Same guarantee 005 states for relay_blobs, stated as a schema fact: there is
  // no column here that could hold a catalogue, a price, a patient, or the group
  // key this service must never see. If a future change adds one, this test is
  // where it gets argued about.
  assert.deepEqual(cols.sort(), ['clinic_id', 'created_at', 'last_used', 'relay_id', 'revoked_at', 'token']);
});

test('006: the clinic index exists, so listing and counting never scan the table', () => {
  const db = freshDb();
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='relay_tokens'").all()
    .map((r) => r.name);
  assert.ok(idx.includes('relay_tokens_clinic'), idx.join(','));
  // The cap that bounds this table counts live tokens per clinic on every mint,
  // so that query must not be a table scan.
  const plan = db.prepare(
    'EXPLAIN QUERY PLAN SELECT COUNT(*) FROM relay_tokens WHERE clinic_id = ? AND revoked_at IS NULL'
  ).all('c-1').map((r) => r.detail).join(' ');
  assert.match(plan, /USING (COVERING )?INDEX relay_tokens_clinic/i, plan);
});
