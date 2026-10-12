import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';

// Both halves of the contract, imported directly — this cross-check across
// control-plane/ and server/ is the whole reason both live in one repository.
// See control-plane/README.md.
import { canonical } from '../../../server/services/control/canonical.js';
import { verifyLicence } from '../../../server/services/control/licence.js';

import { signLicence, loadSigningKey, ensureSigningKey, signFeed, signingKeyIsProduction } from './signing.js';
import { makeFeedPayload, verifyFeed } from '../../../server/services/control/vendor-feed.js';

// --- test helpers -----------------------------------------------------------

const tmpDirs = [];

// Writes a throwaway private key to a fresh temp file and points
// EASYMED_SIGNING_KEY at it. Each call gets its own directory, so tests never
// collide over signing.js's per-path key cache.
function useKey(privateKey) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'signing-test-'));
  tmpDirs.push(dir);
  const p = path.join(dir, 'vendor-private.pem');
  fs.writeFileSync(p, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  process.env.EASYMED_SIGNING_KEY = p;
  return p;
}

function useBadKeyFile(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'signing-test-'));
  tmpDirs.push(dir);
  const p = path.join(dir, 'bad.pem');
  fs.writeFileSync(p, contents);
  process.env.EASYMED_SIGNING_KEY = p;
  return p;
}

test.after(() => {
  delete process.env.EASYMED_SIGNING_KEY;
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort cleanup of an OS temp dir */ }
  }
});

// --- 1: cross-verifies with the clinic's own verifier -----------------------

test('a licence signed here verifies with the clinic-side verifier, with the right modules', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  useKey(privateKey);

  const doc = signLicence({ clinicId: 'c-000047', clinicName: 'Нурафшон Мед', modules: ['crm', 'telegram'] });
  const r = verifyLicence(JSON.stringify(doc), { publicKey, clinicId: 'c-000047' });

  assert.equal(r.ok, true);
  assert.deepEqual(r.licence.modules, ['crm', 'telegram']);
});

// --- 2: exactly six keys, no more, no fewer ---------------------------------

test('the payload carries exactly clinic_id, clinic_name, modules, valid_until, issued_at, nonce', () => {
  useKey(generateKeyPairSync('ed25519').privateKey);
  const { payload } = signLicence({ clinicId: 'c-1', clinicName: 'X', modules: [] });
  assert.deepEqual(
    Object.keys(payload).sort(),
    ['clinic_id', 'clinic_name', 'issued_at', 'modules', 'nonce', 'valid_until'],
  );
});

// --- 3: nonce makes two licences for the same clinic differ ----------------

test('two licences for the same clinic differ (the nonce)', () => {
  useKey(generateKeyPairSync('ed25519').privateKey);
  const a = signLicence({ clinicId: 'c-1', clinicName: 'X', modules: ['crm'] });
  const b = signLicence({ clinicId: 'c-1', clinicName: 'X', modules: ['crm'] });
  assert.notEqual(a.payload.nonce, b.payload.nonce);
  assert.notEqual(a.sig, b.sig);
});

// --- 4: valid_until is 14 days out, to the minute ---------------------------

test('valid_until defaults to 14 days from now, to the minute', () => {
  useKey(generateKeyPairSync('ed25519').privateKey);
  const { payload } = signLicence({ clinicId: 'c-1', clinicName: 'X', modules: [] });
  const expected = Date.now() + 14 * 24 * 60 * 60 * 1000;
  const actual = new Date(payload.valid_until).getTime();
  assert.ok(Math.abs(actual - expected) < 60_000, `expected ~${expected}, got ${actual}`);
});

// --- 5: wrong_clinic when presented as a different clinic ------------------

test('a licence for clinic A is rejected by the verifier when presented as clinic B', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  useKey(privateKey);
  const doc = signLicence({ clinicId: 'c-A', clinicName: 'A', modules: [] });
  const r = verifyLicence(JSON.stringify(doc), { publicKey, clinicId: 'c-B' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'wrong_clinic');
});

// --- 6: missing / unreadable / unparseable key --------------------------------

test('an unset EASYMED_SIGNING_KEY produces a clear error, not a crash', () => {
  delete process.env.EASYMED_SIGNING_KEY;
  assert.throws(
    () => signLicence({ clinicId: 'c-1', clinicName: 'X', modules: [] }),
    /EASYMED_SIGNING_KEY/,
  );
});

test('a missing key file produces a clear error, not a crash', () => {
  process.env.EASYMED_SIGNING_KEY = path.join(os.tmpdir(), `no-such-key-${Date.now()}.pem`);
  assert.throws(
    () => signLicence({ clinicId: 'c-1', clinicName: 'X', modules: [] }),
    /could not read|signing key/i,
  );
});

test('a key file that is not a valid Ed25519 key produces a clear error', () => {
  useBadKeyFile('not a real key');
  assert.throws(
    () => signLicence({ clinicId: 'c-1', clinicName: 'X', modules: [] }),
    /valid Ed25519/i,
  );
});

// --- 7: zero modules is a normal, valid licence -----------------------------

test('a licence with zero modules is valid — the free core, not an error', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  useKey(privateKey);
  const doc = signLicence({ clinicId: 'c-1', clinicName: 'Free Core Clinic', modules: [] });
  const r = verifyLicence(JSON.stringify(doc), { publicKey, clinicId: 'c-1' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.licence.modules, []);
});

// --- key material must never leak -------------------------------------------

test('key material never appears in a thrown error message or stack', () => {
  const { privateKey } = generateKeyPairSync('ed25519');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  useKey(privateKey);

  signLicence({ clinicId: 'c-1', clinicName: 'X', modules: [] }); // warms the per-path key cache

  try {
    signLicence({ clinicId: null, clinicName: 'X', modules: [] }); // a validation error, AFTER the key is loaded
    assert.fail('expected signLicence to throw for a null clinicId');
  } catch (err) {
    assert.ok(!err.message.includes(pem), 'error message must not contain key material');
    assert.ok(!(err.stack || '').includes(pem), 'error stack must not contain key material');
  }
});

test('a malformed key file\'s own bytes never appear in the resulting error', () => {
  const secretLooking = 'SUPER-SECRET-KEY-BYTES-DO-NOT-LEAK-1234567890';
  useBadKeyFile(secretLooking);
  try {
    signLicence({ clinicId: 'c-1', clinicName: 'X', modules: [] });
    assert.fail('expected a throw for a malformed key file');
  } catch (err) {
    assert.ok(!err.message.includes(secretLooking));
    assert.ok(!(err.stack || '').includes(secretLooking));
  }
});

// --- ensureSigningKey: the startup check ------------------------------------

test('ensureSigningKey does not throw when a usable key is configured', () => {
  useKey(generateKeyPairSync('ed25519').privateKey);
  assert.doesNotThrow(() => ensureSigningKey());
});

test('ensureSigningKey throws when no key is configured — refuses to boot, not silently unable to sign', () => {
  delete process.env.EASYMED_SIGNING_KEY;
  assert.throws(() => ensureSigningKey(), /EASYMED_SIGNING_KEY/);
});

// --- loadSigningKey: usable directly -----------------------------------------

test('loadSigningKey returns a KeyObject that can actually sign, verifiable against its own public key', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const p = useKey(privateKey);
  const keyObj = loadSigningKey(p);
  const sig = cryptoSign(null, Buffer.from('probe'), keyObj);
  assert.ok(cryptoVerify(null, Buffer.from('probe'), publicKey, sig));
});

// --- modules: normalised, deduplicated, sorted ------------------------------

test('modules are deduplicated and sorted regardless of the order given', () => {
  useKey(generateKeyPairSync('ed25519').privateKey);
  const a = signLicence({ clinicId: 'c-1', clinicName: 'X', modules: ['telegram', 'crm', 'crm'] });
  assert.deepEqual(a.payload.modules, ['crm', 'telegram']);
});

test('two logically-identical module lists given in different order sign identically shaped payloads', () => {
  // canonical() sorts object keys but preserves array order verbatim — without
  // sorting modules ourselves, these two calls would serialise (and sign)
  // differently for what should be the exact same grant.
  useKey(generateKeyPairSync('ed25519').privateKey);
  const a = signLicence({ clinicId: 'c-1', clinicName: 'X', modules: ['telegram', 'crm'] });
  const b = signLicence({ clinicId: 'c-1', clinicName: 'X', modules: ['crm', 'telegram'] });
  assert.deepEqual(a.payload.modules, b.payload.modules);
});

test('modules containing "__proto__" is signed as an ordinary string, not an object-pollution vector', () => {
  // state.js consumes licence.modules through a Set (`has: (key) => set.has(key)`),
  // never as object property keys, so this is safe by construction — pinned here
  // so that guarantee can't quietly regress.
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  useKey(privateKey);
  const doc = signLicence({ clinicId: 'c-1', clinicName: 'X', modules: ['__proto__', 'crm'] });
  const r = verifyLicence(JSON.stringify(doc), { publicKey, clinicId: 'c-1' });
  assert.equal(r.ok, true);
  assert.ok(r.licence.modules.includes('__proto__'));
  assert.equal(({}).polluted, undefined);
});

// --- valid_until: computed here, never caller-supplied ----------------------

test('a caller-supplied valid_until is ignored — this is not an API for forging expiry dates', () => {
  useKey(generateKeyPairSync('ed25519').privateKey);
  const { payload } = signLicence({
    clinicId: 'c-1', clinicName: 'X', modules: [], valid_until: '2099-01-01T00:00:00Z',
  });
  assert.notEqual(payload.valid_until, '2099-01-01T00:00:00Z');
});

// --- days: zero/negative allowed (lockout testing), NaN rejected (a bug) ---

test('days=0 issues an already-expired licence rather than being rejected', () => {
  useKey(generateKeyPairSync('ed25519').privateKey);
  const { payload } = signLicence({ clinicId: 'c-1', clinicName: 'X', modules: [], days: 0 });
  assert.ok(new Date(payload.valid_until).getTime() <= Date.now());
});

test('a negative days issues a licence already expired in the past', () => {
  useKey(generateKeyPairSync('ed25519').privateKey);
  const { payload } = signLicence({ clinicId: 'c-1', clinicName: 'X', modules: [], days: -5 });
  assert.ok(new Date(payload.valid_until).getTime() < Date.now());
});

test('days=NaN is rejected as a bug, not silently signed', () => {
  useKey(generateKeyPairSync('ed25519').privateKey);
  assert.throws(() => signLicence({ clinicId: 'c-1', clinicName: 'X', modules: [], days: NaN }), /days/i);
});

test('a non-numeric days string is rejected', () => {
  useKey(generateKeyPairSync('ed25519').privateKey);
  assert.throws(() => signLicence({ clinicId: 'c-1', clinicName: 'X', modules: [], days: 'soon' }), /days/i);
});

test('a numeric days string is coerced, matching the CLI\'s own --days handling', () => {
  useKey(generateKeyPairSync('ed25519').privateKey);
  const { payload } = signLicence({ clinicId: 'c-1', clinicName: 'X', modules: [], days: '7' });
  const expected = Date.now() + 7 * 24 * 60 * 60 * 1000;
  assert.ok(Math.abs(new Date(payload.valid_until).getTime() - expected) < 60_000);
});

test('an absurdly large days value is rejected with a clear error, not a raw RangeError from toISOString', () => {
  useKey(generateKeyPairSync('ed25519').privateKey);
  assert.throws(() => signLicence({ clinicId: 'c-1', clinicName: 'X', modules: [], days: 1e20 }), /days/i);
});

// --- attack tests: garbage input must be rejected or normalised, never signed as-is ---

test('a null clinicId is rejected', () => {
  useKey(generateKeyPairSync('ed25519').privateKey);
  assert.throws(() => signLicence({ clinicId: null, clinicName: 'X', modules: [] }), /clinicId/);
});

test('a numeric clinicId is rejected, not silently stringified', () => {
  useKey(generateKeyPairSync('ed25519').privateKey);
  assert.throws(() => signLicence({ clinicId: 47, clinicName: 'X', modules: [] }), /clinicId/);
});

test('an object clinicId is rejected', () => {
  useKey(generateKeyPairSync('ed25519').privateKey);
  assert.throws(() => signLicence({ clinicId: { id: 'c-1' }, clinicName: 'X', modules: [] }), /clinicId/);
});

test('a clinicId containing a quote character signs and verifies safely (escaped by canonical, not special-cased)', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  useKey(privateKey);
  const weirdId = 'c-1" ; DROP TABLE clinics; --';
  const doc = signLicence({ clinicId: weirdId, clinicName: 'X', modules: [] });
  const r = verifyLicence(JSON.stringify(doc), { publicKey, clinicId: weirdId });
  assert.equal(r.ok, true);
});

test('a 10,000-character clinicName is truncated, not signed as-is', () => {
  useKey(generateKeyPairSync('ed25519').privateKey);
  const huge = 'A'.repeat(10_000);
  const { payload } = signLicence({ clinicId: 'c-1', clinicName: huge, modules: [] });
  assert.ok(payload.clinic_name.length < 10_000);
});

test('a non-string clinicName (e.g. an object) is rejected, not stringified to "[object Object]"', () => {
  useKey(generateKeyPairSync('ed25519').privateKey);
  assert.throws(() => signLicence({ clinicId: 'c-1', clinicName: { x: 1 }, modules: [] }), /clinicName/);
});

test('modules containing a non-string entry is rejected, not silently dropped', () => {
  useKey(generateKeyPairSync('ed25519').privateKey);
  assert.throws(() => signLicence({ clinicId: 'c-1', clinicName: 'X', modules: ['crm', 42] }), /modules/i);
});

test('modules that is not an array at all is rejected', () => {
  useKey(generateKeyPairSync('ed25519').privateKey);
  assert.throws(() => signLicence({ clinicId: 'c-1', clinicName: 'X', modules: 'crm,telegram' }), /modules/i);
});

// --- payload flatness: canonical() must never see nesting it can't handle ---

test('the signed payload is flat — no field can become an object or array-of-objects', () => {
  useKey(generateKeyPairSync('ed25519').privateKey);
  const { payload } = signLicence({ clinicId: 'c-1', clinicName: 'X', modules: ['crm'] });
  for (const [key, value] of Object.entries(payload)) {
    if (key === 'modules') {
      assert.ok(Array.isArray(value) && value.every((m) => typeof m === 'string'), `${key} must be an array of strings`);
    } else {
      assert.equal(typeof value, 'string', `${key} must be a string`);
    }
  }
  // And canonical() — which recurses unboundedly and can blow the stack on a
  // deeply nested payload — must handle it trivially.
  assert.doesNotThrow(() => canonical(payload));
});

// --- PUBLIC_LICENCE_V1: payment mark, sync key, issued_at order, the feed -----

test('PUBLIC_LICENCE_V1: subscription and apiSyncKey are signed in — eight keys; the clinic verifier accepts them', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  useKey(privateKey);
  const doc = signLicence({ clinicId: 'c-1', clinicName: 'X', modules: ['crm'], subscription: 'unpaid', apiSyncKey: 'ab'.repeat(16) });
  assert.deepEqual(Object.keys(doc.payload).sort(),
    ['api_sync_key', 'clinic_id', 'clinic_name', 'issued_at', 'modules', 'nonce', 'subscription', 'valid_until']);
  const r = verifyLicence(JSON.stringify(doc), { publicKey, clinicId: 'c-1' });
  assert.equal(r.ok, true);
  assert.equal(r.licence.subscription, 'unpaid');
  assert.equal(r.licence.api_sync_key, 'ab'.repeat(16));
  const noKey = signLicence({ clinicId: 'c-1', clinicName: 'X', modules: [], subscription: 'active', apiSyncKey: null });
  assert.equal('api_sync_key' in noKey.payload, false, 'null — no field, the switch is off');
  assert.equal(noKey.payload.subscription, 'active');
});

test('PUBLIC_LICENCE_V1: a wrong subscription word or a malformed sync key is a caller bug — refused, never signed', () => {
  useKey(generateKeyPairSync('ed25519').privateKey);
  for (const subscription of ['paid', '', 'ACTIVE', null]) {
    assert.throws(() => signLicence({ clinicId: 'c-1', modules: [], subscription }), /subscription/);
  }
  for (const apiSyncKey of ['AB'.repeat(16), 'ab'.repeat(15), 'ab'.repeat(32), 42, {}]) {
    assert.throws(() => signLicence({ clinicId: 'c-1', modules: [], apiSyncKey }), /apiSyncKey/);
  }
});

test('PUBLIC_LICENCE_V1: notAfter only ever shortens valid_until; a malformed one is refused', () => {
  useKey(generateKeyPairSync('ed25519').privateKey);
  const soon = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
  assert.equal(signLicence({ clinicId: 'c-1', modules: [], notAfter: soon }).payload.valid_until, soon);
  const far = new Date(Date.now() + 400 * 24 * 3600 * 1000).toISOString();
  const capped = Date.parse(signLicence({ clinicId: 'c-1', modules: [], notAfter: far }).payload.valid_until);
  assert.ok(Math.abs(capped - (Date.now() + 14 * 24 * 3600 * 1000)) < 60_000, 'a later notAfter never lengthens the 14 days');
  assert.throws(() => signLicence({ clinicId: 'c-1', modules: [], notAfter: 'tomorrow' }), /notAfter/);
});

test('PUBLIC_LICENCE_V1: issued_at is strictly after issuedAfter even when the vendor clock is behind it', () => {
  useKey(generateKeyPairSync('ed25519').privateKey);
  const ahead = new Date(Date.now() + 3_600_000).toISOString();
  const doc = signLicence({ clinicId: 'c-1', modules: [], issuedAfter: ahead });
  assert.equal(Date.parse(doc.payload.issued_at), Date.parse(ahead) + 1);
  const past = new Date(Date.now() - 3_600_000).toISOString();
  assert.ok(Math.abs(Date.parse(signLicence({ clinicId: 'c-1', modules: [], issuedAfter: past }).payload.issued_at) - Date.now()) < 60_000);
  assert.throws(() => signLicence({ clinicId: 'c-1', modules: [], issuedAfter: 'yesterday' }), /issuedAfter/);
});

test('PUBLIC_LICENCE_V1: signFeed verifies with the shared feed verifier; a throwaway key is not the production key', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  useKey(privateKey);
  const payload = makeFeedPayload({ issuedAt: new Date().toISOString(), clinicsOff: ['c-1'], partnerKeysRevoked: ['cd'.repeat(32)] });
  const doc = signFeed(payload);
  const r = verifyFeed(JSON.stringify(doc), { publicKey });
  assert.equal(r.ok, true);
  assert.deepEqual(r.feed.clinics_off, ['c-1']);
  assert.equal(verifyLicence(JSON.stringify(doc), { publicKey, clinicId: 'c-1' }).ok, false, 'a feed is never a licence');
  assert.equal(signingKeyIsProduction(), false);
});
