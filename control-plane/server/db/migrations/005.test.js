import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { createEnrollmentCode, redeemEnrollmentCode } from '../../services/enrollment.js';

// BRANCH_SYNC_RELAY_V1 — the relay_blobs table. Its whole job is to hold bytes
// this service cannot read, so the tests below are mostly about what the SCHEMA
// refuses to let happen: two blobs per group, a blob outliving its clinic, a
// text column tempting someone to look inside.

function freshDb() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

function enrol(db, clinicId = 'c-1', name = 'Test Clinic') {
  const code = createEnrollmentCode(db, { clinicId, name });
  return redeemEnrollmentCode(db, { code }).install_token;
}

const put = (db, relayId, clinicId, bytes) => db.prepare(
  `INSERT INTO relay_blobs (relay_id, clinic_id, bytes, size) VALUES (?, ?, ?, ?)`
).run(relayId, clinicId, bytes, bytes.length);

const ID = 'a'.repeat(32);

test('005: a blob round-trips as BYTES, not as text', () => {
  const db = freshDb();
  enrol(db);
  // Deliberately bytes that are not valid UTF-8 — real ciphertext is not, and a
  // column that quietly transcoded would corrupt every payload.
  const bytes = Buffer.from([0x00, 0xff, 0xfe, 0x45, 0x4d, 0x52, 0x31, 0x80, 0x00]);
  put(db, ID, 'c-1', bytes);
  const row = db.prepare('SELECT bytes, size FROM relay_blobs WHERE relay_id = ?').get(ID);
  assert.ok(Buffer.isBuffer(row.bytes), 'the column must come back a Buffer, never a string');
  assert.deepEqual(row.bytes, bytes);
  assert.equal(row.size, bytes.length);
});

test('005: one blob per group — a second upload replaces, never accumulates', () => {
  const db = freshDb();
  enrol(db);
  put(db, ID, 'c-1', Buffer.from('first'));
  // The route uses ON CONFLICT DO UPDATE; the PRIMARY KEY is what makes that
  // the only possible shape. A plain second INSERT must fail rather than
  // silently doubling what the vendor stores.
  assert.throws(() => put(db, ID, 'c-1', Buffer.from('second')), /UNIQUE|PRIMARY/i);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM relay_blobs').get().n, 1);
});

test('005: a blob cannot exist without a clinic, and dies with it', () => {
  const db = freshDb();
  enrol(db);
  // foreign_keys is ON (db/connection.js), so an orphan blob is not writable.
  assert.throws(() => put(db, ID, 'nobody', Buffer.from('x')), /FOREIGN KEY/i);

  put(db, ID, 'c-1', Buffer.from('x'));
  db.prepare('DELETE FROM clinics WHERE clinic_id = ?').run('c-1');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM relay_blobs').get().n, 0,
    'a deleted clinic must not leave its bytes behind on the vendor disk');
});

test('005: updated_at is stamped by the schema, read_at starts empty', () => {
  const db = freshDb();
  enrol(db);
  put(db, ID, 'c-1', Buffer.from('x'));
  const row = db.prepare('SELECT updated_at, read_at FROM relay_blobs WHERE relay_id = ?').get(ID);
  assert.match(row.updated_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(row.read_at, null, 'nobody has read it yet — that is what retention needs to know');
});

test('005: the table holds nothing that describes the payload', () => {
  const db = freshDb();
  const cols = db.prepare('PRAGMA table_info(relay_blobs)').all().map((c) => c.name);
  // The guarantee stated as a schema fact: there is no column here that could
  // hold a service name, a price, a patient, or a decrypted anything. If a
  // future change adds one, this test is where it gets argued about.
  assert.deepEqual(cols.sort(), ['bytes', 'clinic_id', 'read_at', 'relay_id', 'size', 'updated_at']);
});
