import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { createEnrollmentCode, redeemEnrollmentCode } from '../../services/enrollment.js';

// BRANCH_RECORDS_V1 (Задача 7a) — relay_token_scopes: a relay token belongs to a
// BRANCH and names a SET of relay ids, not one.
//
// WHY THE TABLE EXISTS, in one sentence: 006 gave a token exactly one address,
// which was right while the whole group shared ONE address (the catalogue). Phase
// 2 gives every branch its OWN address for its journal (relay-crypto.js
// relayIdFor(key, letter)), so a secondary must reach its own address AND every
// peer's — and under 006 every one of those requests is a 401 that the clinic
// app reports as "your access was revoked", which is a wrong remedy for a code
// bug.
//
// Like 006's tests before it, these are about what the SCHEMA guarantees
// independently of any route: the backfill leaves no existing token narrower or
// wider than it was, a scope cannot outlive its token, and one pair cannot be
// stored twice.

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
const OTHER = 'f'.repeat(32);

test('008: every token carried over from 006 keeps exactly its own single address', () => {
  // The tokens this matters for are ALREADY IN THE FIELD — inside branch keys
  // that were carried to other buildings by hand and cannot be re-issued
  // remotely. A backfill that missed one would 401 a working branch on the next
  // deploy, and the branch's owner would have no way to tell that from the
  // access having been revoked.
  const db = openDb(':memory:');
  migrate(db);   // full run, then rewind to what 006 alone would have left
  db.prepare('DELETE FROM schema_migrations WHERE name = ?').run('008_relay_token_scopes.sql');
  db.exec('DROP TABLE relay_token_scopes');
  enrol(db);
  const ins = db.prepare('INSERT INTO relay_tokens (token, clinic_id, relay_id) VALUES (?,?,?)');
  ins.run('tok-a', 'c-1', RELAY);
  ins.run('tok-b', 'c-1', RELAY);
  ins.run('tok-c', 'c-1', OTHER);

  migrate(db);

  const scopes = db.prepare('SELECT token, relay_id FROM relay_token_scopes ORDER BY token').all();
  assert.deepEqual(scopes, [
    { token: 'tok-a', relay_id: RELAY },
    { token: 'tok-b', relay_id: RELAY },
    { token: 'tok-c', relay_id: OTHER },
  ], 'one scope row per pre-existing token, equal to the address it already had');
});

test('008: the pair is the primary key — one address cannot be granted twice to one token', () => {
  const db = freshDb();
  enrol(db);
  db.prepare('INSERT INTO relay_tokens (token, clinic_id, relay_id) VALUES (?,?,?)').run('tok-1', 'c-1', RELAY);
  const scope = db.prepare('INSERT INTO relay_token_scopes (token, relay_id) VALUES (?,?)');
  scope.run('tok-1', RELAY);
  assert.throws(() => scope.run('tok-1', RELAY), /UNIQUE|PRIMARY/i);
  scope.run('tok-1', OTHER);   // a SECOND address for the same token is the point
  assert.equal(db.prepare('SELECT COUNT(*) n FROM relay_token_scopes WHERE token = ?').get('tok-1').n, 2);

  const pk = db.prepare("SELECT name FROM pragma_index_list('relay_token_scopes') WHERE origin = 'pk'").get();
  assert.ok(pk, 'the primary key must exist as an index, not merely as a declaration');
  const cols = db.prepare(`SELECT name FROM pragma_index_info(?)`).all(pk.name).map((r) => r.name);
  assert.deepEqual(cols, ['token', 'relay_id'], 'token first: every lookup is "what may THIS token touch"');
});

test('008: a scope cannot exist without its token, and dies with it', () => {
  const db = freshDb();
  enrol(db);
  // foreign_keys is ON (db/connection.js): a grant naming a token that was never
  // minted is not writable at all.
  assert.throws(
    () => db.prepare('INSERT INTO relay_token_scopes (token, relay_id) VALUES (?,?)').run('never-minted', RELAY),
    /FOREIGN KEY/i,
  );

  db.prepare('INSERT INTO relay_tokens (token, clinic_id, relay_id) VALUES (?,?,?)').run('tok-1', 'c-1', RELAY);
  db.prepare('INSERT INTO relay_token_scopes (token, relay_id) VALUES (?,?)').run('tok-1', RELAY);

  // ON DELETE CASCADE twice over: the retention sweep deletes from relay_tokens
  // (routes/relay-token.js pruneRelayTokens) and deleting a clinic cascades into
  // relay_tokens. Neither may leave a grant behind for a token string that could
  // one day be minted again.
  db.prepare('DELETE FROM relay_tokens WHERE token = ?').run('tok-1');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM relay_token_scopes').get().n, 0, 'the sweep must take the grants too');

  db.prepare('INSERT INTO relay_tokens (token, clinic_id, relay_id) VALUES (?,?,?)').run('tok-2', 'c-1', RELAY);
  db.prepare('INSERT INTO relay_token_scopes (token, relay_id) VALUES (?,?)').run('tok-2', RELAY);
  db.prepare('DELETE FROM clinics WHERE clinic_id = ?').run('c-1');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM relay_token_scopes').get().n, 0,
    'a grant must never outlive the clinic whose identity it speaks for');
});

test('008: the schema refuses a relay id the relay route could never accept', () => {
  const db = freshDb();
  enrol(db);
  db.prepare('INSERT INTO relay_tokens (token, clinic_id, relay_id) VALUES (?,?,?)').run('tok-1', 'c-1', RELAY);
  // Same second line 006 draws for relay_tokens.relay_id, and it has to be drawn
  // again here because THIS is now the column authorisation reads. A grant for
  // an address /cp/v1/relay answers 404 to would be a live credential that
  // mysteriously never works.
  for (const bad of ['', 'short', 'B3'.repeat(16), 'z'.repeat(32), '0'.repeat(31), '0'.repeat(33), '../secrets']) {
    assert.throws(
      () => db.prepare('INSERT INTO relay_token_scopes (token, relay_id) VALUES (?,?)').run('tok-1', bad),
      /CHECK/i,
      `${JSON.stringify(bad)} must not be storable`,
    );
  }
});

test('008: the table holds addresses and nothing else', () => {
  const db = freshDb();
  const cols = db.prepare('PRAGMA table_info(relay_token_scopes)').all().map((c) => c.name);
  // Same guarantee 005 and 006 state as a schema fact: there is no column here
  // that could hold a catalogue, a price, a patient or the group key this
  // service must never see.
  assert.deepEqual(cols.sort(), ['relay_id', 'token']);
});

test('008: the relay_id index exists, so "who may touch this address" never scans', () => {
  const db = freshDb();
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='relay_token_scopes'").all()
    .map((r) => r.name);
  assert.ok(idx.includes('relay_token_scopes_relay'), idx.join(','));
});

test('008: authorisation by scope is an index lookup, not a scan of every grant', () => {
  const db = freshDb();
  // The EXISTS in routes/relay-token.js clinicForRelayToken runs on EVERY relay
  // request from every secondary branch in the country. Under 006 it was a
  // primary-key hit on relay_tokens; it must not have become a table scan.
  const plan = db.prepare(
    'SELECT 1 FROM relay_token_scopes WHERE token = ? AND relay_id = ?'
  ).all('t', RELAY) && db.prepare(
    'EXPLAIN QUERY PLAN SELECT 1 FROM relay_token_scopes WHERE token = ? AND relay_id = ?'
  ).all('t', RELAY).map((r) => r.detail).join(' ');
  assert.match(plan, /USING (COVERING )?INDEX/i, plan);
});
