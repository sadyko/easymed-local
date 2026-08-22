import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';

import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { createEnrollmentCode, redeemEnrollmentCode } from '../services/enrollment.js';
import { createApp } from '../app.js';

// The clinic side — a different database, a different schema, imported
// across the control-plane/ <-> server/ boundary the same way
// enroll.test.js does. This is what makes the acceptance test below prove
// something real: not just that this route returns 200, but that a real
// clinic-side controlState() accepts and unlocks with what it produced.
import { openDb as openClinicDb } from '../../../server/db/connection.js';
import { migrate as migrateClinic } from '../../../server/db/migrate.js';
import { controlState, __setPublicKeyForTests } from '../../../server/services/control/state.js';
import { COUNTER_NAMES } from '../../../server/services/control/metrics.js';

// --- test harness ------------------------------------------------------------

const tmpDirs = [];
function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

// Points EASYMED_SIGNING_KEY at a fresh throwaway key — same convention as
// control-plane/server/services/signing.test.js's useKey() and
// routes/enroll.test.js's useSigningKey().
function useSigningKey(privateKey) {
  const dir = tmpDir('checkin-key-');
  const p = path.join(dir, 'vendor-private.pem');
  fs.writeFileSync(p, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  process.env.EASYMED_SIGNING_KEY = p;
}

function freshRegistry() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function harness() {
  const db = freshRegistry();
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  useSigningKey(privateKey);
  __setPublicKeyForTests(publicKey); // the clinic-side verifier's key, for the acceptance test
  const app = createApp(db);
  return { db, app, publicKey, privateKey };
}

async function post(server, path_, body) {
  return fetch(`http://127.0.0.1:${server.address().port}${path_}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function checkin(server, body) {
  return post(server, '/cp/v1/checkin', body);
}

// Enrols a clinic straight through the service layer, the same shortcut the
// task instructions themselves call out ("reuse the enrollment service").
function enrol(db, clinicId, name = 'Test Clinic') {
  const code = createEnrollmentCode(db, { clinicId, name });
  return redeemEnrollmentCode(db, { code }).install_token;
}

function grantModule(db, clinicId, moduleKey) {
  db.prepare('INSERT INTO clinic_modules (clinic_id, module_key) VALUES (?, ?)').run(clinicId, moduleKey);
}

function isoDaysFromToday(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

test.after(() => {
  delete process.env.EASYMED_SIGNING_KEY;
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort temp cleanup */ }
  }
});

// --- THE acceptance test: the dead-man's switch, end to end through HTTP ---

test('acceptance: a paid clinic is re-armed, an unpaid one is not, and a lapsed paid-until is not paid', async (t) => {
  const { db } = harness();
  const app = createApp(db);
  const server = await listen(app); t.after(() => server.close());

  // --- 1. Enrol a clinic (reuse the enrollment service), grant it crm -----
  const installToken = enrol(db, 'c-000047', 'Нурафшон Мед');
  grantModule(db, 'c-000047', 'crm');

  // --- 2. Check in: a licence comes back and the CLINIC-side verifier -----
  //        accepts it, unlocked, with ['crm'].
  const res1 = await checkin(server, { install_token: installToken, version: '1.0.0', fingerprint: 'fp-1' });
  assert.equal(res1.status, 200, 'result 2a: check-in for a paid clinic must succeed');
  const body1 = await res1.json();
  assert.ok(body1.licence && body1.licence.payload && body1.licence.sig, 'result 2b: a freshly signed licence must come back');
  assert.equal(body1.subscription, 'active', 'result 2c: subscription must read active');
  assert.deepEqual(body1.collect.slice().sort(), COUNTER_NAMES.slice().sort(),
    'result 2d: collect defaults to every known counter when collect_set has never been set (STATS_V1)');

  const dir = tmpDir('checkin-clinic-');
  fs.writeFileSync(path.join(dir, 'control.json'), JSON.stringify({
    clinic_id: 'c-000047', clinic_name: 'Нурафшон Мед', unlock_secret: 'x', subscription: 'active',
  }));
  fs.writeFileSync(path.join(dir, 'licence.dat'), JSON.stringify(body1.licence));

  const clinicDb = openClinicDb(':memory:');
  migrateClinic(clinicDb);
  const state1 = controlState(clinicDb, dir);
  assert.equal(state1.locked, false, 'result 2e: the clinic-side verifier must report unlocked');
  assert.deepEqual(state1.modules, ['crm'], 'result 2f: modules must be exactly [\'crm\']');

  // --- 3. subscription = 'unpaid' -> no fresh licence, subscription:'unpaid'
  db.prepare("UPDATE clinics SET subscription = 'unpaid' WHERE clinic_id = ?").run('c-000047');
  const res2 = await checkin(server, { install_token: installToken });
  assert.equal(res2.status, 200, 'result 3a: an unpaid clinic still gets a 200 (it is not an auth failure)');
  const body2 = await res2.json();
  assert.equal(body2.licence, null, 'result 3b: no fresh licence for an unpaid clinic');
  assert.equal(body2.subscription, 'unpaid', 'result 3c: the response must say unpaid');

  // --- 4. subscription_until = yesterday, subscription = 'active' -> still -
  //        no fresh licence. Paid-until in the past is not paid.
  db.prepare("UPDATE clinics SET subscription = 'active', subscription_until = ? WHERE clinic_id = ?")
    .run(isoDaysFromToday(-1), 'c-000047');
  const res3 = await checkin(server, { install_token: installToken });
  assert.equal(res3.status, 200, 'result 4a: still a 200, not an auth failure');
  const body3 = await res3.json();
  assert.equal(body3.licence, null, 'result 4b: a lapsed subscription_until must not re-arm, even though the column says active');
  assert.equal(body3.subscription, 'unpaid', 'result 4c: the response must show money wording, not the raw active column');
});

// --- rule 1: unknown / inactive / missing token — byte-identical failure ---

test('an unknown, deactivated, or missing token all produce the exact same 401 body', async (t) => {
  const { db } = harness();
  const app = createApp(db);
  const server = await listen(app); t.after(() => server.close());

  const deactivatedToken = enrol(db, 'c-1');
  db.prepare('UPDATE clinics SET active = 0 WHERE clinic_id = ?').run('c-1');

  const unknown = await checkin(server, { install_token: 'no-such-token' });
  const deactivated = await checkin(server, { install_token: deactivatedToken });
  const missing = await checkin(server, {});

  const responses = { unknown, deactivated, missing };
  const bodies = {};
  for (const [name, res] of Object.entries(responses)) {
    assert.equal(res.status, 401, `${name} must respond 401`);
    bodies[name] = await res.json();
  }

  assert.deepEqual(bodies.unknown, bodies.deactivated);
  assert.deepEqual(bodies.deactivated, bodies.missing);
  assert.deepEqual(bodies.unknown, {
    error: { code: 'invalid_token', message: 'This install is not recognised.' },
  });
});

// --- rule 2 & the "signLicence throws" attack -------------------------------

test('a broken signing key still leaves the check-in recorded, and reports 500 — not a silent success or a leaked path', async (t) => {
  const { db } = harness();
  const app = createApp(db);
  const server = await listen(app); t.after(() => server.close());

  const installToken = enrol(db, 'c-1');

  // Break signing AFTER enrolment (which needs no signer here) — same
  // technique as enroll.test.js's own "signing failure" test.
  process.env.EASYMED_SIGNING_KEY = path.join(os.tmpdir(), `no-such-key-${Date.now()}.pem`);

  const res = await checkin(server, { install_token: installToken, version: '9.9.9' });
  assert.equal(res.status, 500, 'a broken signer must not be reported as an invalid token, and must not silently succeed');
  const body = await res.json();
  assert.equal(body.error.code, 'internal');
  assert.ok(
    !JSON.stringify(body).match(/EASYMED_SIGNING_KEY|could not read|pem/i),
    'the internal signing error must not leak key-path details to the client',
  );

  // The whole point of rule 2: the check-in itself must be recorded anyway.
  const row = db.prepare('SELECT * FROM checkins WHERE clinic_id = ?').get('c-1');
  assert.ok(row, 'the check-in must be recorded even though signing failed afterwards');
  assert.equal(row.version, '9.9.9');
});

// --- rule 4: fingerprint change never blocks the call -----------------------

test('a changed fingerprint never fails the check-in, over the real HTTP route', async (t) => {
  const { db } = harness();
  const app = createApp(db);
  const server = await listen(app); t.after(() => server.close());
  const installToken = enrol(db, 'c-1');

  assert.equal((await checkin(server, { install_token: installToken, fingerprint: 'fp-a' })).status, 200);
  const res2 = await checkin(server, { install_token: installToken, fingerprint: 'fp-b' });
  assert.equal(res2.status, 200, 'a changed fingerprint must not lock the clinic out');
});

// --- rule 6 & 7: module_requests carried up, deduplicated, idempotent ------

test('module_requests are carried up and deduplicated across two separate check-ins', async (t) => {
  const { db } = harness();
  const app = createApp(db);
  const server = await listen(app); t.after(() => server.close());
  const installToken = enrol(db, 'c-1');

  const body = { install_token: installToken, module_requests: [{ module_key: 'telegram', requested_at: '2026-08-20T00:00:00Z' }] };
  assert.equal((await checkin(server, body)).status, 200);
  assert.equal((await checkin(server, body)).status, 200); // the clinic retries — this WILL happen

  const rows = db.prepare("SELECT * FROM module_requests WHERE clinic_id = ? AND module_key = 'telegram'").all('c-1');
  assert.equal(rows.length, 1, 'a retried identical check-in must not create a second lead');

  const checkins = db.prepare('SELECT COUNT(*) n FROM checkins WHERE clinic_id = ?').get('c-1');
  assert.equal(checkins.n, 2, 'but check-ins themselves are evidence — two calls, two rows');
});

// --- attack: malformed module_requests, over HTTP ---------------------------

test('malformed module_requests (not an array, 500 entries, unsellable keys, __proto__) never crash the endpoint', async (t) => {
  const { db } = harness();
  const app = createApp(db);
  const server = await listen(app); t.after(() => server.close());

  const tokenA = enrol(db, 'c-a');
  assert.equal((await checkin(server, { install_token: tokenA, module_requests: 'not-an-array' })).status, 200);

  const tokenB = enrol(db, 'c-b');
  const many = Array.from({ length: 500 }, (_, i) => ({ module_key: `bogus-${i}`, requested_at: 't' }));
  assert.equal((await checkin(server, { install_token: tokenB, module_requests: many })).status, 200);

  const tokenC = enrol(db, 'c-c');
  assert.equal((await checkin(server, {
    install_token: tokenC,
    module_requests: [{ module_key: '__proto__', requested_at: 't' }, { module_key: 'not-real', requested_at: 't' }],
  })).status, 200);
  assert.equal(({}).polluted, undefined);
});

// --- attack: version / fingerprint are advisory only, over HTTP ------------

test('an absurd version or fingerprint (10,000 chars, an object) never fails the check-in over HTTP', async (t) => {
  const { db } = harness();
  const app = createApp(db);
  const server = await listen(app); t.after(() => server.close());
  const installToken = enrol(db, 'c-1');

  const huge = 'x'.repeat(10_000);
  assert.equal((await checkin(server, { install_token: installToken, version: huge, fingerprint: huge })).status, 200);

  const installToken2 = enrol(db, 'c-2');
  assert.equal((await checkin(server, { install_token: installToken2, version: { v: 1 }, fingerprint: { f: 1 } })).status, 200);
});

// --- attack: a stale token whose clinic row was deleted ---------------------

test('a token whose clinic row was since deleted is refused exactly like an unknown token, over HTTP', async (t) => {
  const { db } = harness();
  const app = createApp(db);
  const server = await listen(app); t.after(() => server.close());
  const installToken = enrol(db, 'c-1');

  assert.equal((await checkin(server, { install_token: installToken })).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM checkins').get().n, 1);

  db.prepare('DELETE FROM clinics WHERE clinic_id = ?').run('c-1');

  const res = await checkin(server, { install_token: installToken });
  assert.equal(res.status, 401);
  // History survives the delete (checkins.clinic_id is deliberately not a
  // foreign key) — the count must stay at 1, not grow, since the second
  // call never authenticated.
  assert.equal(db.prepare('SELECT COUNT(*) n FROM checkins').get().n, 1);
});
