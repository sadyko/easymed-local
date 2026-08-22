import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { canonical } from './canonical.js';
import { controlState, __setPublicKeyForTests as __setStateKey } from './state.js';
import { enrollUrl, enrollWithCode, __setPublicKeyForTests } from './enroll.js';

// ENROLLMENT_SCREEN_V1 — the clinic's half of first-run enrollment: the admin
// types an EM- code, this module posts it to the control plane and writes the
// two identity files. The control-plane half (code issue/redeem) already has
// its own suite; this file only ever talks to an injected fetch.
//
// The rule under test throughout: NOTHING is written to disk until the
// returned licence has verified against the compiled-in vendor key for the
// clinic_id the response claims. A control plane that answers garbage (or an
// attacker who answers in its place) must leave the install exactly as it
// was — 'not_enrolled', re-typeable code, no half-identity on disk.

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
__setPublicKeyForTests(publicKey);
// The post-enrollment controlState() reads below verify through state.js's own
// seam — same throwaway key, so "the files enrollWithCode wrote" and "the files
// controlState trusts" agree the way the real compiled-in key makes them agree
// in production.
__setStateKey(publicKey);

const signLic = (payload) => ({
  payload,
  sig: sign(null, Buffer.from(canonical(payload), 'utf8'), privateKey).toString('base64'),
});

const fresh = () => { const db = openDb(':memory:'); migrate(db); return db; };
const freshDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'em-enroll-'));

const goodBody = (over = {}) => ({
  clinic_id: 'c-000051',
  clinic_name: 'Нурафшон Мед',
  install_token: 'tok-AAAA',
  unlock_secret: 'sec-BBBB',
  subscription: 'active',
  licence: signLic({
    clinic_id: 'c-000051', clinic_name: 'Нурафшон Мед', modules: ['crm'],
    valid_until: '2099-01-01T00:00:00Z', issued_at: '2026-08-22T00:00:00Z', nonce: 'n-1',
  }),
  ...over,
});

// Fetch-shaped helpers. enrollWithCode reads the body via the same bounded
// reader checkin.js uses, which prefers res.body.getReader() — absent here on
// purpose so the res.text() fallback path is what these fakes exercise.
const okFetch = (body) => async () => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
const errFetch = (status) => async () => ({ ok: false, status, text: async () => '{}' });

test('enrollUrl defaults to the production control plane', () => {
  assert.equal(enrollUrl({}), 'https://settings.easymed.uz/cp/v1/enroll');
});

test('enrollUrl honours EASYMED_CONTROL_URL and strips trailing slashes', () => {
  assert.equal(
    enrollUrl({ EASYMED_CONTROL_URL: 'http://127.0.0.1:8091///' }),
    'http://127.0.0.1:8091/cp/v1/enroll',
  );
});

test('a valid code writes both identity files and reports the clinic', async () => {
  const dir = freshDir();
  let sent = null;
  const fetchImpl = async (url, init) => { sent = { url, init }; return okFetch(goodBody())(); };

  const r = await enrollWithCode(dir, 'EM-7K4Q-9XZP', { fetchImpl });

  assert.equal(r.ok, true);
  assert.equal(r.clinic_id, 'c-000051');
  assert.equal(r.clinic_name, 'Нурафшон Мед');

  const identity = JSON.parse(fs.readFileSync(path.join(dir, 'control.json'), 'utf8'));
  assert.deepEqual(identity, {
    clinic_id: 'c-000051', clinic_name: 'Нурафшон Мед',
    install_token: 'tok-AAAA', unlock_secret: 'sec-BBBB', subscription: 'active',
  });
  // licence.dat must be the licence EXACTLY as signed — any re-serialisation
  // here could reorder keys and still verify (canonical() exists for that),
  // but byte-identical is the only shape with nothing to argue about.
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'licence.dat'), 'utf8')), goodBody().licence);

  assert.equal(sent.url, 'https://settings.easymed.uz/cp/v1/enroll');
  assert.equal(sent.init.method, 'POST');
  assert.equal(sent.init.headers['Content-Type'], 'application/json');
  const body = JSON.parse(sent.init.body);
  assert.equal(body.code, 'EM-7K4Q-9XZP');
  // The fingerprint is advisory on the vendor side but must actually be sent —
  // it is what lets the panel notice a code redeemed from an unexpected machine.
  assert.match(body.fingerprint, /^[0-9a-f]{64}$/);
});

test('the acceptance loop: enroll → controlState reads enrolled and unlocked', async () => {
  // docs/plans/2026-08-20-control-plane-service.md Task 3: "enroll → write the
  // response to a control.json → the clinic app's controlState reads it as
  // enrolled and unlocked." This is that loop, minus the network.
  const dir = freshDir();
  const db = fresh();
  const r = await enrollWithCode(dir, 'EM-7K4Q-9XZP', { fetchImpl: okFetch(goodBody()) });
  assert.equal(r.ok, true);

  const s = controlState(db, dir, new Date('2026-08-22T12:00:00Z'));
  assert.equal(s.locked, false);
  assert.equal(s.clinicId, 'c-000051');
  assert.deepEqual(s.modules, ['crm']);
});

test('the typed code is normalised before sending: case, spaces', async () => {
  const dir = freshDir();
  let body = null;
  const fetchImpl = async (url, init) => { body = JSON.parse(init.body); return okFetch(goodBody())(); };
  await enrollWithCode(dir, '  em-7k4q-9xzp ', { fetchImpl });
  assert.equal(body.code, 'EM-7K4Q-9XZP');
});

test('an empty or non-string code fails locally — the network is never touched', async () => {
  const dir = freshDir();
  let calls = 0;
  const fetchImpl = async () => { calls++; return okFetch(goodBody())(); };
  for (const code of ['', '   ', null, undefined, 42, {}]) {
    const r = await enrollWithCode(dir, code, { fetchImpl });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'empty_code');
  }
  assert.equal(calls, 0);
  assert.equal(fs.existsSync(path.join(dir, 'control.json')), false);
});

test('a 400 (wrong/reused code) is invalid_code and writes nothing', async () => {
  const dir = freshDir();
  const r = await enrollWithCode(dir, 'EM-WRONG-CODE', { fetchImpl: errFetch(400) });
  assert.deepEqual(r, { ok: false, reason: 'invalid_code' });
  assert.equal(fs.readdirSync(dir).length, 0);
});

test('a 429 is too_many_attempts', async () => {
  const dir = freshDir();
  const r = await enrollWithCode(dir, 'EM-7K4Q-9XZP', { fetchImpl: errFetch(429) });
  assert.deepEqual(r, { ok: false, reason: 'too_many_attempts' });
});

test('a 500 is server_error — retryable, the code is not burned (signing rolls back server-side)', async () => {
  const dir = freshDir();
  const r = await enrollWithCode(dir, 'EM-7K4Q-9XZP', { fetchImpl: errFetch(500) });
  assert.deepEqual(r, { ok: false, reason: 'server_error' });
  assert.equal(fs.readdirSync(dir).length, 0);
});

test('a network failure (DNS, refused, timeout) is offline and writes nothing', async () => {
  const dir = freshDir();
  const r = await enrollWithCode(dir, 'EM-7K4Q-9XZP', {
    fetchImpl: async () => { throw new TypeError('fetch failed'); },
  });
  assert.deepEqual(r, { ok: false, reason: 'offline' });
  assert.equal(fs.readdirSync(dir).length, 0);
});

test('ATTACK: a licence signed with the wrong key writes NOTHING', async () => {
  const dir = freshDir();
  const { privateKey: mallory } = generateKeyPairSync('ed25519');
  const payload = {
    clinic_id: 'c-000051', clinic_name: 'Нурафшон Мед', modules: ['crm'],
    valid_until: '2099-01-01T00:00:00Z', issued_at: '2026-08-22T00:00:00Z', nonce: 'n-1',
  };
  const forged = goodBody({
    licence: { payload, sig: sign(null, Buffer.from(canonical(payload), 'utf8'), mallory).toString('base64') },
  });
  const r = await enrollWithCode(dir, 'EM-7K4Q-9XZP', { fetchImpl: okFetch(forged) });
  assert.deepEqual(r, { ok: false, reason: 'bad_response' });
  assert.equal(fs.readdirSync(dir).length, 0, 'a forged licence must leave no file behind');
});

test('ATTACK: a licence for a DIFFERENT clinic than the response claims writes nothing', async () => {
  const dir = freshDir();
  const body = goodBody({
    licence: signLic({
      clinic_id: 'c-000099', clinic_name: 'Другая клиника', modules: [],
      valid_until: '2099-01-01T00:00:00Z', issued_at: '2026-08-22T00:00:00Z', nonce: 'n-2',
    }),
  });
  const r = await enrollWithCode(dir, 'EM-7K4Q-9XZP', { fetchImpl: okFetch(body) });
  assert.deepEqual(r, { ok: false, reason: 'bad_response' });
  assert.equal(fs.readdirSync(dir).length, 0);
});

test('a response missing any identity field writes nothing', async () => {
  const dir = freshDir();
  for (const missing of ['clinic_id', 'install_token', 'unlock_secret', 'licence']) {
    const body = goodBody();
    delete body[missing];
    const r = await enrollWithCode(dir, 'EM-7K4Q-9XZP', { fetchImpl: okFetch(body) });
    assert.equal(r.ok, false, missing + ' missing must fail');
    assert.equal(r.reason, 'bad_response');
  }
  assert.equal(fs.readdirSync(dir).length, 0);
});

test('a body that is not JSON at all is bad_response, never a throw', async () => {
  const dir = freshDir();
  const r = await enrollWithCode(dir, 'EM-7K4Q-9XZP', {
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<html>gateway error</html>' }),
  });
  assert.deepEqual(r, { ok: false, reason: 'bad_response' });
});

test('ATTACK: a gigantic body is refused, not buffered into a parse attempt', async () => {
  const dir = freshDir();
  const r = await enrollWithCode(dir, 'EM-7K4Q-9XZP', {
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => '"' + 'x'.repeat(2_000_000) + '"' }),
  });
  assert.deepEqual(r, { ok: false, reason: 'bad_response' });
});

test('an install that already holds an install_token refuses to re-enroll — no call, no overwrite', async () => {
  const dir = freshDir();
  fs.writeFileSync(path.join(dir, 'control.json'), JSON.stringify({
    clinic_id: 'c-000001', install_token: 'tok-EXISTING', unlock_secret: 's', subscription: 'active',
  }));
  let calls = 0;
  const r = await enrollWithCode(dir, 'EM-7K4Q-9XZP', {
    fetchImpl: async () => { calls++; return okFetch(goodBody())(); },
  });
  assert.deepEqual(r, { ok: false, reason: 'already_enrolled' });
  assert.equal(calls, 0, 'the code must not be burned against an already-enrolled install');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'control.json'), 'utf8')).install_token, 'tok-EXISTING');
});

test('a hand-licensed install (control.json with NO install_token) may enroll — the designed migration path', async () => {
  // make-licence.mjs enroll writes control.json without install_token, so such
  // an install never checks in. Typing a panel-issued code is exactly how it
  // graduates to the wire — the vendor made the code, the overwrite is theirs.
  const dir = freshDir();
  fs.writeFileSync(path.join(dir, 'control.json'), JSON.stringify({
    clinic_id: 'c-000051', unlock_secret: 'old-secret', subscription: 'active',
  }));
  const r = await enrollWithCode(dir, 'EM-7K4Q-9XZP', { fetchImpl: okFetch(goodBody()) });
  assert.equal(r.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'control.json'), 'utf8')).install_token, 'tok-AAAA');
});

test('write order: identity first, licence second — a crash between them self-heals via check-in', async () => {
  // The INVERSE of checkin.js's licence-first rule, deliberately. Check-in
  // renews files that both already exist; enrollment creates them. If only
  // control.json lands (crash/full disk before licence.dat), the install reads
  // as 'unlicensed' WITH an install_token — and the next daily check-in
  // fetches a fresh licence and completes the pair with no human involved.
  // Licence-first would instead leave 'not_enrolled' with the code already
  // burned server-side: a stuck install only the vendor can rescue.
  const dir = freshDir();
  const db = fresh();
  const renameSync = (from, to) => {
    if (String(to).endsWith('licence.dat')) throw new Error('EDQUOT: disk full');
    return fs.renameSync(from, to);
  };
  const r = await enrollWithCode(dir, 'EM-7K4Q-9XZP', { fetchImpl: okFetch(goodBody()), renameSync });
  assert.deepEqual(r, { ok: false, reason: 'write_failed' });
  assert.equal(fs.existsSync(path.join(dir, 'control.json')), true, 'identity must already be on disk');
  const s = controlState(db, dir, new Date('2026-08-22T12:00:00Z'));
  assert.equal(s.reason, 'unlicensed', 'recoverable by the next check-in, not stuck at not_enrolled');
});

test('write order, other direction: if control.json itself cannot land, nothing does', async () => {
  const dir = freshDir();
  const db = fresh();
  const renameSync = (from, to) => {
    if (String(to).endsWith('control.json')) throw new Error('EDQUOT: disk full');
    return fs.renameSync(from, to);
  };
  const r = await enrollWithCode(dir, 'EM-7K4Q-9XZP', { fetchImpl: okFetch(goodBody()), renameSync });
  assert.deepEqual(r, { ok: false, reason: 'write_failed' });
  assert.equal(fs.existsSync(path.join(dir, 'licence.dat')), false, 'no orphan licence for an identity that never landed');
  assert.equal(controlState(db, dir, new Date('2026-08-22T12:00:00Z')).reason, 'not_enrolled');
});
