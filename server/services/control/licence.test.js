import { test } from 'node:test';
import assert from 'node:assert';
import { generateKeyPairSync, sign } from 'node:crypto';
import { canonical } from './canonical.js';
import { verifyLicence } from './licence.js';

// A throwaway key pair per run: no private key is ever committed to this repo.
const { publicKey, privateKey } = generateKeyPairSync('ed25519');

const PAYLOAD = {
  clinic_id:   'c-000047',
  clinic_name: 'Нурафшон Мед',
  modules:     ['crm', 'telegram'],
  valid_until: '2026-09-03T00:00:00Z',
  issued_at:   '2026-08-20T03:14:00Z',
  nonce:       'abc123',
};

const issue = (payload = PAYLOAD) => JSON.stringify({
  payload,
  sig: sign(null, Buffer.from(canonical(payload), 'utf8'), privateKey).toString('base64'),
});

test('a correctly signed licence verifies', () => {
  const r = verifyLicence(issue(), { publicKey, clinicId: 'c-000047' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.licence.modules, ['crm', 'telegram']);
  assert.equal(r.licence.valid_until, '2026-09-03T00:00:00Z');
});

test('adding a module to the file invalidates it', () => {
  const raw = JSON.parse(issue());
  raw.payload.modules.push('marketing');           // exactly what an operator would try
  const r = verifyLicence(JSON.stringify(raw), { publicKey, clinicId: 'c-000047' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad_signature');
});

test('extending the expiry date in the file invalidates it', () => {
  const raw = JSON.parse(issue());
  raw.payload.valid_until = '2099-01-01T00:00:00Z';
  const r = verifyLicence(JSON.stringify(raw), { publicKey, clinicId: 'c-000047' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad_signature');
});

test("another clinic's valid licence is refused", () => {
  const r = verifyLicence(issue(), { publicKey, clinicId: 'c-000099' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'wrong_clinic');
});

test('a licence signed by a different key is refused', () => {
  const other = generateKeyPairSync('ed25519');
  const forged = JSON.stringify({
    payload: PAYLOAD,
    sig: sign(null, Buffer.from(canonical(PAYLOAD), 'utf8'), other.privateKey).toString('base64'),
  });
  const r = verifyLicence(forged, { publicKey, clinicId: 'c-000047' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad_signature');
});

// The app must never crash on a bad file — an unreadable licence is "unlicensed",
// never a stack trace on a clinic's screen.
for (const [label, raw] of [
  ['empty string',       ''],
  ['not json',           'hello'],
  ['json but no sig',    '{"payload":{"clinic_id":"c-000047"}}'],
  ['json but no payload','{"sig":"AAAA"}'],
  ['sig not base64',     '{"payload":{"clinic_id":"c-000047"},"sig":"!!!!"}'],
  ['null',               null],
]) {
  test(`malformed licence (${label}) is refused without throwing`, () => {
    const r = verifyLicence(raw, { publicKey, clinicId: 'c-000047' });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'malformed');
  });
}

// --- attack-testing added beyond the spec's own list -----------------------

test('check order: a forged licence claiming the right clinic id is still bad_signature, not wrong_clinic', () => {
  // If clinic_id were ever checked before the signature, a forged file could
  // pick the id that makes it through. PAYLOAD.clinic_id already equals the
  // clinicId passed in here — the only thing wrong is the signing key.
  const other = generateKeyPairSync('ed25519');
  const forged = JSON.stringify({
    payload: PAYLOAD,
    sig: sign(null, Buffer.from(canonical(PAYLOAD), 'utf8'), other.privateKey).toString('base64'),
  });
  const r = verifyLicence(forged, { publicKey, clinicId: PAYLOAD.clinic_id });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad_signature');
});

test('the compiled-in placeholder key never verifies anyone (no publicKey override)', () => {
  // This is what makes an un-replaced build fail closed: the real vendor
  // private key can't exist in this test, so any signature — from any key —
  // must be refused when checked against the default embedded key.
  const someVendor = generateKeyPairSync('ed25519');
  const raw = JSON.stringify({
    payload: PAYLOAD,
    sig: sign(null, Buffer.from(canonical(PAYLOAD), 'utf8'), someVendor.privateKey).toString('base64'),
  });
  const r = verifyLicence(raw, { clinicId: PAYLOAD.clinic_id }); // no publicKey opt
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad_signature');
});

test('a Buffer (what fs.readFileSync returns without an encoding) verifies the same as a string', () => {
  const r = verifyLicence(Buffer.from(issue(), 'utf8'), { publicKey, clinicId: 'c-000047' });
  assert.equal(r.ok, true);
  assert.equal(r.licence.clinic_name, 'Нурафшон Мед'); // multi-byte UTF-8 survives the Buffer round-trip
});

test('a licence file truncated mid-write (power cut) is refused without throwing', () => {
  const truncated = Buffer.from(issue(), 'utf8').subarray(0, 40); // cuts inside the JSON, not at a boundary
  const r = verifyLicence(truncated, { publicKey, clinicId: 'c-000047' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'malformed');
});

test('a payload nested 100,000 levels deep is refused, not a stack overflow', () => {
  // Found by attacking this file: JSON.parse happily parses this (it is not
  // recursive over the whole document the way our own serializer is), but
  // canonical()'s serialize() recurses one call frame per nesting level and
  // blew the stack (RangeError) before licence.js caught it around this call.
  // Left uncaught, a single hostile or corrupted licence file would crash
  // every attempt to read the patient list, not just fail licensing.
  const depth = 100_000;
  const nestedPayload = '{"a":'.repeat(depth) + '1' + '}'.repeat(depth);
  const raw = `{"payload":${nestedPayload},"sig":"AAAA"}`;
  const r = verifyLicence(raw, { publicKey, clinicId: 'c-000047' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'malformed');
});

test('a payload that is a JSON array (not an object) is refused, not thrown', () => {
  const raw = JSON.stringify({ payload: [1, 2, 3], sig: 'AAAA' });
  const r = verifyLicence(raw, { publicKey, clinicId: 'c-000047' });
  assert.equal(r.ok, false);
});

test('a top-level JSON array instead of a {payload,sig} document is refused as malformed', () => {
  const r = verifyLicence('[1,2,3]', { publicKey, clinicId: 'c-000047' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'malformed');
});

test('a base64url signature (uses - and _) is refused as malformed, not silently mis-decoded', () => {
  const raw = JSON.stringify({ payload: PAYLOAD, sig: 'AAAA-_BB' });
  const r = verifyLicence(raw, { publicKey, clinicId: 'c-000047' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'malformed');
});

test('an empty-string signature is refused as malformed', () => {
  const raw = JSON.stringify({ payload: PAYLOAD, sig: '' });
  const r = verifyLicence(raw, { publicKey, clinicId: 'c-000047' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'malformed');
});

test('a valid-base64 signature that decodes to the wrong byte count fails as bad_signature, not malformed', () => {
  // Ed25519 signatures are exactly 64 bytes. node:crypto's verify() returns
  // false (not a throw) for a wrong-length signature buffer — confirmed with
  // a standalone probe before relying on it here — so this is a signature
  // failure, not a document-shape failure.
  const real = JSON.parse(issue());
  const tooLong = real.sig.replace(/=+$/, '') + 'AAAA'; // append valid base64 chars → more than 64 bytes decoded
  const raw = JSON.stringify({ payload: real.payload, sig: tooLong });
  const r = verifyLicence(raw, { publicKey, clinicId: 'c-000047' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad_signature');
});
