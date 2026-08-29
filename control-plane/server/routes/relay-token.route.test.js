import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, randomBytes } from 'node:crypto';

import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { createEnrollmentCode, redeemEnrollmentCode } from '../services/enrollment.js';
import { createApp } from '../app.js';
import { relayPathFor, RELAY_MOUNT, RELAY_ID_RE as RELAY_ID_RE_ROUTE } from './relay.js';
import {
  RELAY_TOKEN_MOUNT, RELAY_ID_RE as RELAY_ID_RE_MINT, clinicForRelayToken, pruneRelayTokens,
} from './relay-token.js';

// BRANCH_IDENTITY_V1 — the credential a SECONDARY branch uses on the relay.
//
// What this file is protecting, in one sentence: this token must be able to do
// EXACTLY ONE THING — read and write ONE relay id — and must be worth nothing
// anywhere else in the control plane. Everything below is that sentence, taken
// apart: it is refused on another relay id, refused by check-in, refused once
// revoked, refused once its clinic is deactivated or deleted, and cannot mint
// another one of itself.

// --- test harness (copied from relay.route.test.js on purpose, so the two -----
// --- files cannot drift about what "an enrolled clinic" means) ---------------

const tmpDirs = [];
function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function useSigningKey() {
  const { privateKey } = generateKeyPairSync('ed25519');
  const p = path.join(tmpDir('relay-token-test-key-'), 'vendor-private.pem');
  fs.writeFileSync(p, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  process.env.EASYMED_SIGNING_KEY = p;
}

test.after(() => {
  delete process.env.EASYMED_SIGNING_KEY;
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort temp cleanup */ }
  }
});

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function harness(t) {
  useSigningKey();
  const db = openDb(':memory:');
  migrate(db);
  const server = await listen(createApp(db));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  return { db, server, base };
}

function enrol(db, clinicId = 'c-1', name = 'Test Clinic') {
  const code = createEnrollmentCode(db, { clinicId, name });
  return redeemEnrollmentCode(db, { code }).install_token;
}

const RELAY_ID = 'b3'.repeat(16);        // 32 hex characters, the real shape
const OTHER_RELAY_ID = 'f'.repeat(32);

const GENERIC_401 = { error: { code: 'invalid_token', message: 'This install is not recognised.' } };

const mint = (base, token, body) => fetch(base + RELAY_TOKEN_MOUNT, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
  },
  body: JSON.stringify(body),
});

const put = (base, id, bytes, token) => fetch(base + relayPathFor(id), {
  method: 'PUT',
  headers: { 'Content-Type': 'application/octet-stream', Authorization: `Bearer ${token}` },
  body: bytes,
});
const get = (base, id, token) => fetch(base + relayPathFor(id), {
  headers: { Authorization: `Bearer ${token}` },
});

async function mintedToken(base, installToken, relayId = RELAY_ID) {
  const res = await mint(base, installToken, { relay_id: relayId });
  assert.equal(res.status, 201, 'the harness needs a minted token to work with');
  return (await res.json()).token;
}

// --- minting ------------------------------------------------------------------

test('an enrolled, active clinic mints a token for a relay id', async (t) => {
  const { db, base } = await harness(t);
  const installToken = enrol(db);

  const res = await mint(base, installToken, { relay_id: RELAY_ID });
  assert.equal(res.status, 201);
  const body = await res.json();
  // base64url, because this string is copied into the branch key by hand and
  // '+', '/' and '=' are exactly what gets mangled on that journey.
  assert.match(body.token, /^[A-Za-z0-9_-]{32,}$/);
  assert.equal(body.relay_id, RELAY_ID);

  const row = db.prepare('SELECT * FROM relay_tokens WHERE token = ?').get(body.token);
  assert.equal(row.clinic_id, 'c-1');
  assert.equal(row.relay_id, RELAY_ID);
  assert.equal(row.revoked_at, null);
  assert.equal(row.last_used, null, 'never used yet');
});

test('minting is refused with the SAME generic 401 as check-in, byte for byte', async (t) => {
  const { db, base } = await harness(t);
  const deactivated = enrol(db, 'c-dead');
  db.prepare('UPDATE clinics SET active = 0 WHERE clinic_id = ?').run('c-dead');
  const deleted = enrol(db, 'c-gone');
  db.prepare('DELETE FROM clinics WHERE clinic_id = ?').run('c-gone');

  // The relay token itself must not be able to mint another one: a credential
  // that can issue credentials is not scoped to one relay id any more.
  const alive = enrol(db, 'c-1');
  const relayToken = await mintedToken(base, alive);

  const cases = {
    missing: null,
    empty: '',
    unknown: 'no-such-token',
    scheme: 'Bearer',
    deactivated,
    deleted,
    relayToken,
  };
  const texts = {};
  for (const [name, token] of Object.entries(cases)) {
    const res = await mint(base, token, { relay_id: RELAY_ID });
    assert.equal(res.status, 401, `${name} must be refused`);
    texts[name] = await res.text();
  }

  // Compared against what /cp/v1/checkin actually answers, fetched live rather
  // than transcribed here — a copied constant would still "pass" the day one of
  // the two files changed its wording.
  const checkin = await fetch(`${base}/cp/v1/checkin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ install_token: 'no-such-token' }),
  });
  const checkinText = await checkin.text();
  assert.equal(checkin.status, 401);
  for (const [name, body] of Object.entries(texts)) {
    assert.equal(body, checkinText, `${name} must be indistinguishable from check-in's own refusal`);
  }
  assert.deepEqual(JSON.parse(checkinText), GENERIC_401);

  assert.equal(db.prepare('SELECT COUNT(*) n FROM relay_tokens').get().n, 1,
    'only the one token the test minted for itself');
});

test('a relay_id that is not 32 lowercase hex is refused before it can become a row', async (t) => {
  const { db, base } = await harness(t);
  const installToken = enrol(db);

  const bad = [
    'short', 'B3'.repeat(16), 'z'.repeat(32), '0'.repeat(31), '0'.repeat(33),
    '../secrets', '', null, 42, { relay_id: RELAY_ID }, ['x'],
  ];
  for (const relayId of bad) {
    const res = await mint(base, installToken, { relay_id: relayId });
    assert.equal(res.status, 400, `${JSON.stringify(relayId)} must not be mintable`);
    assert.equal((await res.json()).error.code, 'bad_relay_id');
  }
  const res = await mint(base, installToken, {});
  assert.equal(res.status, 400, 'no relay_id at all is the same refusal');

  assert.equal(db.prepare('SELECT COUNT(*) n FROM relay_tokens').get().n, 0,
    'a probing request must never have written anything');

  // Second line of the same rule: even bypassing the route, the SCHEMA refuses
  // a relay id the relay route could never accept — a live token that
  // mysteriously never works is a support mystery nobody would solve.
  assert.throws(
    () => db.prepare('INSERT INTO relay_tokens (token, clinic_id, relay_id) VALUES (?,?,?)')
      .run('t', 'c-1', 'NOT-32-LOWERCASE-HEX'),
    /CHECK/i,
  );
});

// --- the bound on the table --------------------------------------------------
//
// THE ATTACK THIS REPLACES A WEAKER TEST FOR: relay_id comes out of the request
// body, from a 2^128 space, so a cap counted per (clinic, relay id) bounds
// nothing — one enrolled clinic names a new id every time and writes rows for
// ever (3,000 rows in 1.77 s, measured). An earlier version of this file
// asserted "the cap is per relay id, not per clinic" and so pinned the hole open
// as if it were the design. It is per CLINIC, and these are the tests that say so.

// Seeds live tokens straight into the table, each on a DIFFERENT relay id —
// which is exactly the shape of the attack. Done in SQL rather than over HTTP
// because the per-IP throttle makes 60-odd mints in one minute impossible, which
// is itself part of the fix (see the throttle test below).
function seedTokens(db, clinicId, n, at = new Date().toISOString()) {
  const ins = db.prepare('INSERT INTO relay_tokens (token, clinic_id, relay_id, created_at, last_used) VALUES (?,?,?,?,?)');
  for (let i = 0; i < n; i++) {
    ins.run(`seed-${clinicId}-${i}`, clinicId, i.toString(16).padStart(32, '0'), at, at);
  }
}

test('the cap counts a CLINIC\'s live tokens, not one relay id\'s — a fresh relay id does not buy a fresh 64', async (t) => {
  const { db, base } = await harness(t);
  const installToken = enrol(db);
  seedTokens(db, 'c-1', 63);

  assert.equal((await mint(base, installToken, { relay_id: RELAY_ID })).status, 201, 'the 64th is still allowed');

  // The 65th, on a relay id this clinic has never used and nobody has ever seen.
  // Counted per relay id this would be "0 live, go ahead" — which is the whole
  // bug. Counted per clinic it is 64, and refused.
  const over = await mint(base, installToken, { relay_id: OTHER_RELAY_ID });
  assert.equal(over.status, 409);
  assert.equal((await over.json()).error.code, 'too_many_tokens');
  // A DISTINCT error, not the generic 401, deliberately: the caller has already
  // proved it holds a live install_token, so a specific answer tells an attacker
  // nothing and tells the clinic exactly what happened.

  assert.equal(db.prepare('SELECT COUNT(*) n FROM relay_tokens WHERE clinic_id = ?').get('c-1').n, 64,
    'the table stops growing for this clinic, whatever relay id is named');
});

test('the cap is per clinic, so one clinic at its limit cannot stop another minting', async (t) => {
  const { db, base } = await harness(t);
  enrol(db, 'c-full');
  const other = enrol(db, 'c-2', 'Second Clinic');
  seedTokens(db, 'c-full', 64);

  assert.equal((await mint(base, other, { relay_id: RELAY_ID })).status, 201);
});

test('revoking frees a slot — un-pairing a branch must not make a clinic permanently poorer', async (t) => {
  const { db, base } = await harness(t);
  const installToken = enrol(db);
  seedTokens(db, 'c-1', 64);
  assert.equal((await mint(base, installToken, { relay_id: RELAY_ID })).status, 409);

  db.prepare('UPDATE relay_tokens SET revoked_at = ? WHERE token = ?')
    .run(new Date().toISOString(), 'seed-c-1-0');   // not "UPDATE ... LIMIT 1": needs a compile-time SQLite option
  assert.equal((await mint(base, installToken, { relay_id: RELAY_ID })).status, 201);
});

test('minting is throttled per IP, and a refused burst writes nothing', async (t) => {
  const { db, base } = await harness(t);
  const installToken = enrol(db);

  for (let i = 0; i < 20; i++) {
    assert.equal((await mint(base, installToken, { relay_id: RELAY_ID })).status, 201, `mint ${i}`);
  }
  const over = await mint(base, installToken, { relay_id: RELAY_ID });
  assert.equal(over.status, 429, 'the 21st in a minute is a burst, not a clinic adding branches');
  assert.deepEqual(await over.json(), { error: { code: 'too_many_attempts', message: 'Too many attempts. Try again later.' } });

  assert.equal(db.prepare('SELECT COUNT(*) n FROM relay_tokens').get().n, 20, 'a throttled call wrote nothing');

  // The throttle answer depends on the IP's request count and NOTHING else — a
  // garbage token gets the same 429 once the window is spent, so it cannot be
  // used to tell a live install_token from a dead one.
  const garbage = await mint(base, 'no-such-token', { relay_id: RELAY_ID });
  assert.equal(garbage.status, 429);
});

// --- retention ---------------------------------------------------------------

test('a token nobody has used in 30 days is swept, and one in use never is', async (t) => {
  const { db, base } = await harness(t);
  const installToken = enrol(db);
  const live = await mintedToken(base, installToken);
  await put(base, RELAY_ID, randomBytes(32), live);   // used just now

  seedTokens(db, 'c-1', 1, '2000-01-01T00:00:00Z');   // last used in another decade
  db.prepare('INSERT INTO relay_tokens (token, clinic_id, relay_id, created_at) VALUES (?,?,?,?)')
    .run('never-used-old', 'c-1', OTHER_RELAY_ID, '2000-01-01T00:00:00Z');
  db.prepare('INSERT INTO relay_tokens (token, clinic_id, relay_id, created_at) VALUES (?,?,?,?)')
    .run('minted-today', 'c-1', OTHER_RELAY_ID, new Date().toISOString());

  assert.equal(pruneRelayTokens(db, { days: 30 }), 2, 'the two ancient ones, and only those');
  const left = db.prepare('SELECT token FROM relay_tokens ORDER BY token').all().map((r) => r.token);
  assert.deepEqual(left.sort(), [live, 'minted-today'].sort(),
    'a token minted today but not yet carried to the branch must survive, and one in daily use must too');
});

test('a revocation is kept as evidence for the window, then dropped', async (t) => {
  const { db } = await harness(t);
  enrol(db);
  seedTokens(db, 'c-1', 1);
  db.prepare('UPDATE relay_tokens SET revoked_at = ? WHERE token = ?').run(new Date().toISOString(), 'seed-c-1-0');
  assert.equal(pruneRelayTokens(db, { days: 30 }), 0, 'a fresh revocation still answers "when was this branch cut off"');

  db.prepare('UPDATE relay_tokens SET revoked_at = ?, last_used = ? WHERE token = ?')
    .run('2000-01-01T00:00:00Z', '2000-01-01T00:00:00Z', 'seed-c-1-0');
  assert.equal(pruneRelayTokens(db, { days: 30 }), 1);
});

test('the sweep runs on the way into a mint, so a stranded clinic un-strands itself', async (t) => {
  const { db, base } = await harness(t);
  const installToken = enrol(db);
  // A clinic that re-paired its branches over a year and burned every slot. With
  // no sweep and no vendor revoke route, this clinic could never add a branch
  // again without a phone call.
  seedTokens(db, 'c-1', 64, '2000-01-01T00:00:00Z');

  assert.equal((await mint(base, installToken, { relay_id: RELAY_ID })).status, 201,
    'the attempt that would hit the cap is the attempt that reclaims the slots');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM relay_tokens').get().n, 1, 'the 64 dead ones are gone');
});

test('the sweep never throws, whatever the table is doing', async (t) => {
  const { db } = await harness(t);
  db.exec('DROP TABLE relay_tokens');
  // Housekeeping attached to a mint must never be the thing that fails the mint
  // — pruneRelayBlobs' own rule, and relay.route.test.js pins the same for blobs.
  assert.equal(pruneRelayTokens(db, { days: 30 }), 0);
});

test('the mint route and the relay route agree, character for character, on what a relay id is', () => {
  // relay-token.js deliberately re-states the pattern rather than importing it
  // (relay.js imports clinicForRelayToken from there — importing back would make
  // the two circular). This is what keeps the restatement honest.
  assert.equal(String(RELAY_ID_RE_MINT), String(RELAY_ID_RE_ROUTE));
});

// --- what the minted token can do ---------------------------------------------

test('a minted token opens the relay for its OWN relay id, and the blob is the minting clinic\'s', async (t) => {
  const { db, base } = await harness(t);
  const installToken = enrol(db);
  const token = await mintedToken(base, installToken);
  const blob = randomBytes(2048);

  assert.equal((await put(base, RELAY_ID, blob, token)).status, 200);
  const res = await get(base, RELAY_ID, token);
  assert.equal(res.status, 200);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), blob, 'a branch reads exactly what was published');

  assert.equal(db.prepare('SELECT clinic_id FROM relay_blobs WHERE relay_id = ?').get(RELAY_ID).clinic_id, 'c-1',
    'the blob is attributed to the clinic that minted the token, not to nobody');
  assert.ok(db.prepare('SELECT last_used FROM relay_tokens WHERE token = ?').get(token).last_used,
    'a use is recorded, so support can see which branch is still reaching the relay');
});

// --- what it cannot do --------------------------------------------------------

test('a minted token is refused on ANY other relay id', async (t) => {
  const { db, base } = await harness(t);
  const installToken = enrol(db);
  const token = await mintedToken(base, installToken);

  // Someone else's blob, put there with a perfectly good install_token.
  assert.equal((await put(base, OTHER_RELAY_ID, Buffer.from('theirs'), installToken)).status, 200);

  const wrote = await put(base, OTHER_RELAY_ID, Buffer.from('mine'), token);
  assert.equal(wrote.status, 401, 'the scope is the whole point of this credential');
  assert.deepEqual(await wrote.json(), GENERIC_401);
  const read = await get(base, OTHER_RELAY_ID, token);
  assert.equal(read.status, 401, 'reading is scoped exactly like writing');

  assert.deepEqual(db.prepare('SELECT bytes FROM relay_blobs WHERE relay_id = ?').get(OTHER_RELAY_ID).bytes,
    Buffer.from('theirs'), 'a refused write must not have damaged the blob it was aimed at');
});

test('a minted token is refused by /cp/v1/checkin — the property the whole design rests on', async (t) => {
  const { db, base } = await harness(t);
  const installToken = enrol(db);
  const token = await mintedToken(base, installToken);

  const checkin = (body, headers = {}) => fetch(`${base}/cp/v1/checkin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

  // In the body, where check-in actually reads its credential...
  const asBody = await checkin({ install_token: token, version: '1.0.0' });
  assert.equal(asBody.status, 401, 'a relay token must never re-arm a licence, report statistics or accept an update');
  assert.deepEqual(await asBody.json(), GENERIC_401);

  // ...and in the header, in case anyone ever teaches check-in to read one.
  const asHeader = await checkin({}, { Authorization: `Bearer ${token}` });
  assert.equal(asHeader.status, 401);

  assert.equal(db.prepare('SELECT COUNT(*) n FROM checkins').get().n, 0,
    'a refused check-in must not have been recorded as a visit');
  assert.equal(db.prepare('SELECT last_seen_at FROM clinics WHERE clinic_id = ?').get('c-1').last_seen_at, null);

  // And the install_token still works, so this proves a refusal, not a broken app.
  assert.equal((await checkin({ install_token: installToken })).status, 200);
});

test('a revoked token stops working immediately, and only that one', async (t) => {
  const { db, base } = await harness(t);
  const installToken = enrol(db);
  // Two branches of the same clinic, sharing one relay id — minting is ADDITIVE,
  // never rotating, because every branch in a group is on the same relay id and
  // issuing a key to the third must not cut off the second.
  const branchB = await mintedToken(base, installToken);
  const branchC = await mintedToken(base, installToken);
  assert.notEqual(branchB, branchC);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM relay_tokens WHERE revoked_at IS NULL').get().n, 2);

  assert.equal((await put(base, RELAY_ID, randomBytes(32), branchB)).status, 200);
  assert.equal((await put(base, RELAY_ID, randomBytes(32), branchC)).status, 200);

  db.prepare('UPDATE relay_tokens SET revoked_at = ? WHERE token = ?').run(new Date().toISOString(), branchB);

  const res = await put(base, RELAY_ID, randomBytes(32), branchB);
  assert.equal(res.status, 401, 'revocation takes effect on the very next request');
  assert.deepEqual(await res.json(), GENERIC_401);
  assert.equal((await get(base, RELAY_ID, branchB)).status, 401, 'reading too');

  assert.equal((await put(base, RELAY_ID, randomBytes(32), branchC)).status, 200,
    'un-pairing one branch must not un-pair the others');
});

test('deactivating the clinic takes the relay away from its branches too, not just its main', async (t) => {
  const { db, base } = await harness(t);
  const installToken = enrol(db);
  const token = await mintedToken(base, installToken);
  assert.equal((await put(base, RELAY_ID, randomBytes(32), token)).status, 200);

  db.prepare('UPDATE clinics SET active = 0 WHERE clinic_id = ?').run('c-1');

  // The install_token loses the relay here (relay.route.test.js pins that). A
  // relay token that survived would make deactivation a switch that only half
  // works — every secondary branch would keep syncing.
  assert.equal((await put(base, RELAY_ID, randomBytes(32), installToken)).status, 401);
  const res = await put(base, RELAY_ID, randomBytes(32), token);
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), GENERIC_401);
});

test('deleting the clinic deletes its relay tokens, rather than leaving credentials for a clinic that is gone', async (t) => {
  const { db, base } = await harness(t);
  const installToken = enrol(db);
  const token = await mintedToken(base, installToken);

  // No foreign-key error: a credential must never be the thing that stops a
  // clinic row being removed, and must never outlive it either.
  db.prepare('DELETE FROM clinics WHERE clinic_id = ?').run('c-1');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM relay_tokens').get().n, 0);

  assert.equal((await put(base, RELAY_ID, randomBytes(32), token)).status, 401);
});

// --- bookkeeping must never cost a branch its catalogue -----------------------

test('a last_used write that fails does not fail the request it is attached to', async (t) => {
  const { db, base } = await harness(t);
  const installToken = enrol(db);
  const token = await mintedToken(base, installToken);

  // The only honest way to make just the bookkeeping write fail while the lookup
  // still succeeds. Same rule as relay.js's read_at touch: a branch cut off from
  // its catalogue because a support timestamp could not be written would be a
  // spectacularly bad trade.
  db.exec("CREATE TRIGGER no_touch BEFORE UPDATE ON relay_tokens BEGIN SELECT RAISE(ABORT,'nope'); END");

  const res = await put(base, RELAY_ID, randomBytes(32), token);
  assert.equal(res.status, 200);
  assert.equal(db.prepare('SELECT last_used FROM relay_tokens WHERE token = ?').get(token).last_used, null);
});

// --- the exported helper, directly -------------------------------------------

// --- one URL parser, not two -------------------------------------------------

test('the scope is checked against the SAME relay id the blob is stored under, escapes included', async (t) => {
  const { db, base } = await harness(t);
  const installToken = enrol(db);
  const token = await mintedToken(base, installToken);   // scoped to the decoded id

  // '%62%33' decodes to 'b3'. Express decodes req.params for the handler, so the
  // handler stores under the DECODED id; the auth middleware must therefore
  // check the scope against the decoded id too. While this file had its own
  // req.url reader, the middleware saw the raw escapes, refused, and the two
  // halves of the request disagreed about which relay id this even was.
  const encoded = '%62%33' + 'b3'.repeat(15);
  const res = await put(base, encoded, Buffer.from('through the escape'), token);
  assert.equal(res.status, 200, 'one parser: what the scope allowed is what gets written');

  const rows = db.prepare('SELECT relay_id FROM relay_blobs').all().map((r) => r.relay_id);
  assert.deepEqual(rows, [RELAY_ID], 'stored under the decoded id, which is the one the token names');
  assert.equal((await get(base, RELAY_ID, token)).status, 200);
});

test('the mount root is a 404 for everyone, so it cannot be asked whether a token is live', async (t) => {
  const { db, base } = await harness(t);
  const installToken = enrol(db);

  // Before the auth middleware moved onto '/:relayId', this path answered 401 to
  // an unknown token and 404 to a valid one — a one-bit oracle on the bare mount.
  const withGood = await fetch(base + RELAY_MOUNT, { method: 'PUT', headers: { Authorization: `Bearer ${installToken}` }, body: 'x' });
  const withBad = await fetch(base + RELAY_MOUNT, { method: 'PUT', headers: { Authorization: 'Bearer nonsense' }, body: 'x' });
  assert.equal(withGood.status, withBad.status);
  assert.equal(withGood.status, 404);
  assert.equal(await withGood.text(), await withBad.text());
});

// --- a blob changing hands is visible ----------------------------------------

test('one clinic overwriting another\'s blob is logged loudly, and the ordinary case is silent', async (t) => {
  const { db, base } = await harness(t);
  const a = enrol(db, 'c-a', 'Clinic A');
  const b = enrol(db, 'c-b', 'Clinic B');

  const lines = [];
  const realError = console.error;
  console.error = (...args) => lines.push(args.join(' '));
  t.after(() => { console.error = realError; });

  assert.equal((await put(base, RELAY_ID, Buffer.from('A owns this'), a)).status, 200);
  assert.equal((await put(base, RELAY_ID, Buffer.from('A again'), a)).status, 200);
  assert.deepEqual(lines, [], 'a clinic republishing its own blob is not an event');

  // Not refused — see routes/relay.js's header for why first-writer-wins was
  // rejected (it would strand a re-enrolled clinic out of its own blob). Made
  // VISIBLE instead: the one thing worse than a cross-clinic overwrite is one
  // nobody can see afterwards.
  assert.equal((await put(base, RELAY_ID, Buffer.from('B took it'), b)).status, 200);
  assert.equal(lines.length, 1, lines.join(' | '));
  assert.match(lines[0], /RELAY BLOB CHANGED HANDS/);
  assert.match(lines[0], /c-a/);
  assert.match(lines[0], /c-b/);
  assert.equal(lines[0].includes('B took it'), false, 'metadata only — never the bytes');
});

test('clinicForRelayToken refuses rubbish without a database round-trip', async (t) => {
  const { db, base } = await harness(t);
  const installToken = enrol(db);
  const token = await mintedToken(base, installToken);

  assert.equal(clinicForRelayToken(db, token, RELAY_ID), 'c-1');
  for (const bad of [null, undefined, '', 42, {}]) {
    assert.equal(clinicForRelayToken(db, bad, RELAY_ID), null, `token ${JSON.stringify(bad)}`);
    assert.equal(clinicForRelayToken(db, token, bad), null, `relay id ${JSON.stringify(bad)}`);
  }
  assert.equal(clinicForRelayToken(db, token, 'B3'.repeat(16)), null, 'uppercase is not the same relay id');
});
