import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';

import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { createEnrollmentCode } from '../services/enrollment.js';
import { createApp } from '../app.js';

// The clinic side — a different database, a different schema, imported
// across the control-plane/ ↔ server/ boundary the same way signing.test.js
// does. This is what makes the acceptance test below prove something real:
// not just that this route returns 200, but that a clinic-side controlState()
// accepts what it produced.
import { openDb as openClinicDb } from '../../../server/db/connection.js';
import { migrate as migrateClinic } from '../../../server/db/migrate.js';
import { controlState, __setPublicKeyForTests } from '../../../server/services/control/state.js';
import { listen } from '../test-helpers/listen.js';

// --- test harness ------------------------------------------------------------

const tmpDirs = [];
function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

// Points EASYMED_SIGNING_KEY at a fresh throwaway key. Each call gets its own
// file so tests never collide over signing.js's per-path key cache — same
// convention as control-plane/server/services/signing.test.js's useKey().
function useSigningKey(privateKey) {
  const dir = tmpDir('enroll-key-');
  const p = path.join(dir, 'vendor-private.pem');
  fs.writeFileSync(p, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  process.env.EASYMED_SIGNING_KEY = p;
}

function freshRegistry() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

function harness() {
  const db = freshRegistry();
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  useSigningKey(privateKey);
  __setPublicKeyForTests(publicKey); // the clinic-side verifier's key, for the acceptance test
  const app = createApp(db);
  return { db, app, publicKey, privateKey };
}

async function post(server, body) {
  return fetch(`http://127.0.0.1:${server.address().port}/cp/v1/enroll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// Mutates a valid code into a syntactically identical but different one —
// used for the "wrong code" arm of the generic-failure test. Only the last
// character changes, to exactly one of two fixed values guaranteed not to
// equal what was there before.
function wrongify(code) {
  const last = code[code.length - 1];
  return code.slice(0, -1) + (last === 'A' ? 'B' : 'A');
}

test.after(() => {
  delete process.env.EASYMED_SIGNING_KEY;
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort temp cleanup */ }
  }
});

// --- THE acceptance test: a clinic set up over the wire, no USB stick --------

test('a clinic enrolled over HTTP is accepted by the clinic-side controlState — unlocked, with its modules', async (t) => {
  const { db } = harness();
  const code = createEnrollmentCode(db, { clinicId: 'c-000047', name: 'Нурафшон Мед' });
  db.prepare('INSERT INTO clinic_modules (clinic_id, module_key) VALUES (?, ?)').run('c-000047', 'crm');
  db.prepare('INSERT INTO clinic_modules (clinic_id, module_key) VALUES (?, ?)').run('c-000047', 'telegram');

  const app = createApp(db);
  const server = await listen(app); t.after(() => server.close());

  const res = await post(server, { code, fingerprint: 'test-machine-fp' });
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.clinic_id, 'c-000047');
  assert.equal(body.clinic_name, 'Нурафшон Мед');
  assert.equal(body.subscription, 'active');
  assert.ok(body.install_token, 'an install_token must be issued');
  assert.ok(body.unlock_secret, 'unlock_secret must be handed to the install');
  assert.ok(body.licence && body.licence.payload && body.licence.sig, 'a freshly signed licence must come back');
  assert.deepEqual(body.licence.payload.modules, ['crm', 'telegram']);

  // --- write exactly what the CLI's `enroll` command would have written ----
  const dir = tmpDir('enroll-clinic-');
  fs.writeFileSync(path.join(dir, 'control.json'), JSON.stringify({
    clinic_id: body.clinic_id,
    clinic_name: body.clinic_name,
    unlock_secret: body.unlock_secret,
    subscription: body.subscription,
  }));
  fs.writeFileSync(path.join(dir, 'licence.dat'), JSON.stringify(body.licence));

  // --- the clinic side, a wholly different database and schema -------------
  const clinicDb = openClinicDb(':memory:');
  migrateClinic(clinicDb);

  const state = controlState(clinicDb, dir);
  assert.equal(state.locked, false, 'a clinic enrolled this way must come up unlocked');
  assert.equal(state.clinicId, 'c-000047');
  assert.equal(state.clinicName, 'Нурафшон Мед');
  assert.deepEqual(state.modules, ['crm', 'telegram']);
  assert.ok(state.has('crm'));
  assert.ok(!state.has('some-module-never-granted'));
});

// --- generic failure: wrong / reused / unknown / malformed, indistinguishable ---

test('a wrong, reused, unknown, or malformed code all produce the exact same response', async (t) => {
  const { db } = harness();
  const app = createApp(db);
  const server = await listen(app); t.after(() => server.close());

  const validCode = createEnrollmentCode(db, { clinicId: 'c-1', name: 'Clinic One' });

  const reusedCode = createEnrollmentCode(db, { clinicId: 'c-2', name: 'Clinic Two' });
  const firstRedeem = await post(server, { code: reusedCode });
  assert.equal(firstRedeem.status, 200, 'sanity check: the reused code must have worked once');

  const wrong = await post(server, { code: wrongify(validCode) });
  const reused = await post(server, { code: reusedCode }); // second time
  const unknown = await post(server, { code: 'EM-NOPE-0000' });
  const malformed = await post(server, { code: { nested: 'object, not a string' } });

  const responses = { wrong, reused, unknown, malformed };
  const bodies = {};
  for (const [name, res] of Object.entries(responses)) {
    assert.equal(res.status, 400, `${name} must respond 400`);
    bodies[name] = await res.json();
  }

  assert.deepEqual(bodies.wrong, bodies.reused);
  assert.deepEqual(bodies.reused, bodies.unknown);
  assert.deepEqual(bodies.unknown, bodies.malformed);
  assert.deepEqual(bodies.wrong, {
    error: { code: 'invalid_code', message: 'That code is not valid. Check it and try again, or contact your vendor.' },
  });
});

// --- case / whitespace tolerance, through the real HTTP layer ----------------

test('a code typed lowercase with stray whitespace still enrolls, over HTTP', async (t) => {
  const { db } = harness();
  const code = createEnrollmentCode(db, { clinicId: 'c-1', name: 'Clinic' });
  const app = createApp(db);
  const server = await listen(app); t.after(() => server.close());

  const res = await post(server, { code: ' ' + code.toLowerCase() + ' ' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).clinic_id, 'c-1');
});

// --- fingerprint: advisory only, never breaks the request --------------------

test('an absent, oversized, or object fingerprint never fails the enrollment', async (t) => {
  const { db } = harness();
  const app = createApp(db);
  const server = await listen(app); t.after(() => server.close());

  const codeA = createEnrollmentCode(db, { clinicId: 'c-a', name: 'A' });
  assert.equal((await post(server, { code: codeA })).status, 200, 'absent fingerprint');

  const codeB = createEnrollmentCode(db, { clinicId: 'c-b', name: 'B' });
  assert.equal((await post(server, { code: codeB, fingerprint: 'x'.repeat(10_000) })).status, 200, 'oversized fingerprint');

  const codeC = createEnrollmentCode(db, { clinicId: 'c-c', name: 'C' });
  assert.equal((await post(server, { code: codeC, fingerprint: { odd: true } })).status, 200, 'object fingerprint');
});

// --- rate limiting -----------------------------------------------------------

test('the per-IP limit engages under a flood of attempts', async (t) => {
  const { db } = harness();
  const app = createApp(db);
  const server = await listen(app); t.after(() => server.close());

  let sawThrottled = false;
  for (let i = 0; i < 10; i++) {
    const res = await post(server, { code: 'EM-NOPE-0000' });
    if (res.status === 429) { sawThrottled = true; break; }
    assert.equal(res.status, 400); // invalid code, not yet throttled
  }
  assert.ok(sawThrottled, 'a flood of attempts from one IP must eventually be throttled');
});

// --- never logs the code, token, or secret -----------------------------------

test('a successful enrollment never logs the code, install_token, unlock_secret, or fingerprint', async (t) => {
  const { db } = harness();
  const code = createEnrollmentCode(db, { clinicId: 'c-1', name: 'Clinic' });
  const app = createApp(db);
  const server = await listen(app); t.after(() => server.close());

  const original = { log: console.log, warn: console.warn, error: console.error };
  const captured = [];
  console.log = (...a) => captured.push(a);
  console.warn = (...a) => captured.push(a);
  console.error = (...a) => captured.push(a);
  t.after(() => Object.assign(console, original));

  const res = await post(server, { code, fingerprint: 'unmistakable-fingerprint-value' });
  assert.equal(res.status, 200);
  const body = await res.json();

  const dump = JSON.stringify(captured);
  assert.ok(!dump.includes(code), 'the enrollment code must never be logged');
  assert.ok(!dump.includes(body.install_token), 'install_token must never be logged');
  assert.ok(!dump.includes(body.unlock_secret), 'unlock_secret must never be logged');
  assert.ok(!dump.includes('unmistakable-fingerprint-value'), 'fingerprint must never be logged');
});

// --- failure ordering: signing fails AFTER the code would be consumed --------

test('a signing failure leaves the code usable — it is not consumed until signing succeeds', async (t) => {
  const { db } = harness();
  const code = createEnrollmentCode(db, { clinicId: 'c-1', name: 'Clinic' });
  const app = createApp(db);
  const server = await listen(app); t.after(() => server.close());

  // Break signing: point EASYMED_SIGNING_KEY at a file that doesn't exist.
  // signLicence() runs as enrollment.js's beforeCommit hook, INSIDE the
  // transaction that would otherwise clear the code and issue a token — so
  // this must fail closed with the code left completely untouched.
  process.env.EASYMED_SIGNING_KEY = path.join(os.tmpdir(), `no-such-key-${Date.now()}.pem`);

  const failed = await post(server, { code });
  assert.equal(failed.status, 500, 'a broken signer must not be reported as an invalid code');
  const failedBody = await failed.json();
  assert.equal(failedBody.error.code, 'internal');
  assert.ok(
    !JSON.stringify(failedBody).match(/EASYMED_SIGNING_KEY|could not read|pem/i),
    'the internal signing error must not leak key-path details to the client',
  );

  // Repair signing, and confirm the SAME code still works — proving it was
  // never burned by the failed attempt above.
  useSigningKey(generateKeyPairSync('ed25519').privateKey);
  const succeeded = await post(server, { code });
  assert.equal(succeeded.status, 200, 'the untouched code must redeem once signing is fixed');
});
