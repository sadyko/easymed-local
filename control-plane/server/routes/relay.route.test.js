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
import { relayPathFor, pruneRelayBlobs } from './relay.js';
import { RELAY_TOKEN_MOUNT } from './relay-token.js';   // BRANCH_RECORDS_V1 (Задача 7a)
import { sealPayload } from '../../../server/services/branch-sync/relay-crypto.js';
import { b64url, GROUP_KEY_BYTES } from '../../../server/services/branch-sync/pairing.js';

// BRANCH_SYNC_RELAY_V1 — the vendor's half of Route B.
//
// What this file is protecting, in one sentence: this service must be
// STRUCTURALLY unable to read what it stores. Everything else here (auth, caps,
// retention) is ordinary route hygiene; the marker test is the feature.

const tmpDirs = [];
function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

// createApp() builds every router, and the enrollment/admin side needs a signing
// key present — a throwaway one per run, exactly like deploy.test.js's.
function useSigningKey() {
  const { privateKey } = generateKeyPairSync('ed25519');
  const p = path.join(tmpDir('relay-test-key-'), 'vendor-private.pem');
  fs.writeFileSync(p, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  process.env.EASYMED_SIGNING_KEY = p;
}

test.after(() => {
  delete process.env.EASYMED_SIGNING_KEY;
  delete process.env.EASYMED_CP_MAX_RELAY_BYTES;
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

const RELAY_ID = 'b3'.repeat(16);           // 32 hex characters, the real shape
const put = (base, id, bytes, token) => fetch(base + relayPathFor(id), {
  method: 'PUT',
  headers: {
    'Content-Type': 'application/octet-stream',
    ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
  },
  body: bytes,
});
const get = (base, id, token) => fetch(base + relayPathFor(id), {
  headers: token === null ? {} : { Authorization: `Bearer ${token}` },
});

// --- the one that matters ----------------------------------------------------

test('the vendor stores ciphertext: a marker from the clinic database is nowhere in it', async (t) => {
  const { db, base } = await harness(t);
  const token = enrol(db);
  const MARKER = 'ZZPATIENTMARKER';

  // Sealed exactly the way a clinic seals it — the same function, not a
  // hand-rolled imitation. The clinic's own e2e test proves the catalogue that
  // goes in carries no clinical data; this proves that even the NON-clinical
  // data does not reach the vendor in readable form.
  const key = b64url(randomBytes(GROUP_KEY_BYTES));
  const sealed = sealPayload(key, {
    ok: true,
    group_id: 'BR-000000000001',
    catalogue: { services: [{ id: 1, name: MARKER + ' Приём кардиолога', price: 250000 }] },
  });

  const res = await put(base, RELAY_ID, sealed, token);
  assert.equal(res.status, 200);

  const row = db.prepare('SELECT bytes, size, clinic_id FROM relay_blobs WHERE relay_id = ?').get(RELAY_ID);
  assert.ok(Buffer.isBuffer(row.bytes));
  assert.equal(row.bytes.includes(MARKER), false, 'the marker must not be in what the vendor holds');
  assert.equal(row.bytes.toString('latin1').includes('Приём'), false);
  assert.equal(row.bytes.toString('latin1').includes('250000'), false);
  assert.equal(row.bytes.toString('latin1').includes('catalogue'), false, 'not even the field names');
  assert.deepEqual(row.bytes, sealed, 'stored byte-for-byte — the service never transforms the payload');
  assert.equal(row.size, sealed.length);
  assert.equal(row.clinic_id, 'c-1');
});

test('what goes up comes back byte-identical', async (t) => {
  const { db, base } = await harness(t);
  const token = enrol(db);
  // Random bytes, deliberately not valid UTF-8: if anything anywhere in the
  // path treated the body as text, this is the test that would notice.
  const blob = randomBytes(9_000);

  assert.equal((await put(base, RELAY_ID, blob, token)).status, 200);
  const res = await get(base, RELAY_ID, token);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/octet-stream');
  assert.equal(res.headers.get('cache-control'), 'no-store', 'a clinic catalogue must not sit in a proxy cache');
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), blob);
});

// --- authentication ----------------------------------------------------------

test('an unauthenticated call is refused, and stores nothing', async (t) => {
  const { db, base } = await harness(t);
  enrol(db);
  const blob = randomBytes(64);

  for (const token of [null, '', 'not-a-real-token', 'Bearer']) {
    const res = await put(base, RELAY_ID, blob, token);
    assert.equal(res.status, 401, `token ${JSON.stringify(token)} must not be accepted`);
    const body = await res.json();
    assert.equal(body.error.code, 'invalid_token');
  }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM relay_blobs').get().n, 0,
    'a refused upload must never have written anything');

  assert.equal((await get(base, RELAY_ID, null)).status, 401, 'reading needs the same credential');
});

test('a deactivated clinic loses the relay exactly when it loses check-in', async (t) => {
  const { db, base } = await harness(t);
  const token = enrol(db);
  assert.equal((await put(base, RELAY_ID, randomBytes(64), token)).status, 200);

  db.prepare('UPDATE clinics SET active = 0 WHERE clinic_id = ?').run('c-1');
  const res = await put(base, RELAY_ID, randomBytes(64), token);
  assert.equal(res.status, 401);
  // Identical body to an unknown token: nothing here may help someone work out
  // which install_tokens are live (routes/checkin.js's own rule).
  assert.deepEqual(await res.json(), { error: { code: 'invalid_token', message: 'This install is not recognised.' } });
});

test('a vendor panel session buys nothing here', async (t) => {
  const { db, base } = await harness(t);
  enrol(db);
  // The relay is mounted above attachVendorUser precisely so a vendor cookie is
  // never even looked at. Presenting one must change nothing.
  const res = await fetch(base + relayPathFor(RELAY_ID), {
    method: 'PUT',
    headers: { Cookie: 'cp_session=whatever' },
    body: randomBytes(32),
  });
  assert.equal(res.status, 401);
});

// --- shape, caps, absence ----------------------------------------------------

test('a relay id that is not 32 hex characters is not an endpoint', async (t) => {
  const { db, base } = await harness(t);
  const token = enrol(db);
  for (const bad of ['short', 'A'.repeat(32), 'z'.repeat(32), '../secrets', '0'.repeat(31)]) {
    const res = await put(base, encodeURIComponent(bad), randomBytes(32), token);
    assert.equal(res.status, 404, `${bad} must not be storable`);
  }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM relay_blobs').get().n, 0);
});

test('nothing published yet is a plain 404, not an error', async (t) => {
  const { db, base } = await harness(t);
  const token = enrol(db);
  const res = await get(base, RELAY_ID, token);
  assert.equal(res.status, 404, 'the clinic turns this into "the main branch has not sent a copy yet"');
});

test('an empty body is refused rather than stored as an empty blob', async (t) => {
  const { db, base } = await harness(t);
  const token = enrol(db);
  const res = await put(base, RELAY_ID, Buffer.alloc(0), token);
  assert.equal(res.status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM relay_blobs').get().n, 0);
});

test('an oversized upload is refused and does not replace a good blob', async (t) => {
  const { db, base } = await harness(t);
  const token = enrol(db);
  const good = randomBytes(256);
  assert.equal((await put(base, RELAY_ID, good, token)).status, 200);

  // The cap is read per request, so it can be tightened between two calls on a
  // running server — which is exactly what makes it testable without moving 12 MB.
  process.env.EASYMED_CP_MAX_RELAY_BYTES = '128';
  const res = await put(base, RELAY_ID, randomBytes(4096), token);
  delete process.env.EASYMED_CP_MAX_RELAY_BYTES;
  assert.equal(res.status, 413);

  const row = db.prepare('SELECT bytes FROM relay_blobs WHERE relay_id = ?').get(RELAY_ID);
  assert.deepEqual(row.bytes, good, 'a refused upload must not have damaged the copy already there');
});

test('a second upload replaces the copy, it does not add one', async (t) => {
  const { db, base } = await harness(t);
  const token = enrol(db);
  await put(base, RELAY_ID, Buffer.from('one'), token);
  await put(base, RELAY_ID, Buffer.from('two-longer'), token);

  assert.equal(db.prepare('SELECT COUNT(*) n FROM relay_blobs').get().n, 1,
    'the relay is a letterbox, not an archive');
  const row = db.prepare('SELECT bytes, size FROM relay_blobs WHERE relay_id = ?').get(RELAY_ID);
  assert.equal(row.bytes.toString(), 'two-longer');
  assert.equal(row.size, 10);
});

// --- retention ---------------------------------------------------------------

test('a read touches the blob so retention cannot delete a link that is in use', async (t) => {
  const { db, base } = await harness(t);
  const token = enrol(db);
  await put(base, RELAY_ID, randomBytes(64), token);
  db.prepare('UPDATE relay_blobs SET updated_at = ?, read_at = NULL').run('2000-01-01T00:00:00Z');

  await get(base, RELAY_ID, token);
  const row = db.prepare('SELECT read_at FROM relay_blobs WHERE relay_id = ?').get(RELAY_ID);
  assert.ok(row.read_at, 'the read must be recorded');

  // A group whose price list has not changed in years still reads every day —
  // pruning it by upload date alone would break a working link.
  assert.equal(pruneRelayBlobs(db, { days: 30 }), 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM relay_blobs').get().n, 1);
});

test('an untouched blob is swept up, and the sweep runs on upload', async (t) => {
  const { db, base } = await harness(t);
  const token = enrol(db);
  await put(base, RELAY_ID, randomBytes(64), token);

  const dead = 'c'.repeat(32);
  db.prepare('INSERT INTO relay_blobs (relay_id, clinic_id, bytes, size, updated_at) VALUES (?,?,?,?,?)')
    .run(dead, 'c-1', Buffer.from('abandoned'), 9, '2000-01-01T00:00:00Z');

  // The upload path prunes; nothing schedules it, so a server that only ever
  // receives uploads still cannot grow without bound.
  await put(base, RELAY_ID, randomBytes(64), token);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM relay_blobs WHERE relay_id = ?').get(dead).n, 0,
    'a blob nobody has touched in a month is gone');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM relay_blobs WHERE relay_id = ?').get(RELAY_ID).n, 1,
    'the live one stays');
});

test('retention never throws, whatever the table is doing', async (t) => {
  const { db } = await harness(t);
  db.exec('DROP TABLE relay_blobs');
  // Housekeeping attached to an upload must never be the thing that fails the
  // upload — see pruneRelayBlobs' own comment.
  assert.equal(pruneRelayBlobs(db, { days: 30 }), 0);
});

// --- a branch token reaches EVERY address in its scope, and none outside it ---
//
// BRANCH_RECORDS_V1 (Задача 7a). This is the half of the change that decides
// whether Phase 2 works at all, and it is invisible on one machine: the MAIN
// branch authenticates on install_token, which is not scoped to an address, so
// its own journal upload passes whatever this code does. Only a SECONDARY branch
// — which holds nothing but the token from its branch key — can show it.

test('a token minted for two addresses works at both, and is refused at a third', async (t) => {
  const { db, base } = await harness(t);
  const installToken = enrol(db);

  const catalogue = RELAY_ID;
  const nodeB = 'ab'.repeat(16);
  const nodeC = 'cd'.repeat(16);

  const res = await fetch(base + RELAY_TOKEN_MOUNT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${installToken}` },
    body: JSON.stringify({ relay_ids: [catalogue, nodeB] }),
  });
  assert.equal(res.status, 201);
  const token = (await res.json()).token;

  // Its own node address: this is the write that was a 401 for every secondary
  // branch in the group before the scope existed.
  assert.equal((await put(base, nodeB, Buffer.from('journal of B'), token)).status, 200);
  assert.equal(await (await get(base, nodeB, token)).text(), 'journal of B');
  // And the catalogue, which is what it already had.
  assert.equal((await put(base, catalogue, Buffer.from('catalogue'), token)).status, 200);
  assert.equal((await get(base, catalogue, token)).status, 200);

  // A third address it was not granted stays shut, in both directions. The scope
  // got wider; it did not stop being a scope.
  assert.equal((await get(base, nodeC, token)).status, 401);
  assert.equal((await put(base, nodeC, Buffer.from('not mine'), token)).status, 401);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM relay_blobs WHERE relay_id = ?').get(nodeC).n, 0,
    'a refused request must not have stored anything');

  // Every blob it did write belongs to the MINTING clinic, not to a branch
  // identity of its own: the vendor still knows only which clinic uploaded.
  const owners = db.prepare('SELECT DISTINCT clinic_id FROM relay_blobs').all().map((r) => r.clinic_id);
  assert.deepEqual(owners, ['c-1']);
});

test('a token minted the legacy way still reaches its one address, and no other', async (t) => {
  const { db, base } = await harness(t);
  const installToken = enrol(db);
  // The shape already sitting inside branch keys in other buildings. Migration
  // 008 backfilled it a scope of exactly one address; if that had missed, this
  // branch would have been 401ed by a deploy it never asked for.
  const res = await fetch(base + RELAY_TOKEN_MOUNT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${installToken}` },
    body: JSON.stringify({ relay_id: RELAY_ID }),
  });
  const token = (await res.json()).token;

  assert.equal((await put(base, RELAY_ID, Buffer.from('mine'), token)).status, 200);
  assert.equal((await get(base, RELAY_ID, token)).status, 200);
  assert.equal((await get(base, 'ab'.repeat(16), token)).status, 401);
  assert.deepEqual(db.prepare('SELECT relay_id FROM relay_token_scopes WHERE token = ?').all(token),
    [{ relay_id: RELAY_ID }]);
});

test('revocation is per token, so it closes every address at once', async (t) => {
  const { db, base } = await harness(t);
  const installToken = enrol(db);
  const catalogue = RELAY_ID;
  const nodeB = 'ab'.repeat(16);

  const res = await fetch(base + RELAY_TOKEN_MOUNT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${installToken}` },
    body: JSON.stringify({ relay_ids: [catalogue, nodeB] }),
  });
  const token = (await res.json()).token;
  assert.equal((await put(base, nodeB, Buffer.from('x'), token)).status, 200);

  // One UPDATE, one branch cut off — everywhere. A scope spread over rows would
  // have made "revoke this branch" a multi-row operation that could half-finish.
  db.prepare('UPDATE relay_tokens SET revoked_at = ? WHERE token = ?').run(new Date().toISOString(), token);

  for (const id of [catalogue, nodeB]) {
    assert.equal((await get(base, id, token)).status, 401, id);
    assert.equal((await put(base, id, Buffer.from('y'), token)).status, 401, id);
  }
  // The clinic itself has lost nothing: it was the branch's credential that was
  // revoked, not the clinic's.
  assert.equal((await get(base, nodeB, installToken)).status, 200);
});
