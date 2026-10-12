// PUBLIC_LICENCE_V1 — список производителя для публичного сервера: подпись
// своим контекстом (не путается с лицензией), строгий вид, потолки, никогда не
// бросает.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { canonical } from './canonical.js';
import { verifyLicence } from './licence.js';
import { feedMessage, makeFeedPayload, verifyFeed, FEED_LIMITS, FEED_CONTEXT } from './vendor-feed.js';

const vendor = crypto.generateKeyPairSync('ed25519');
const FP = 'ab'.repeat(16);
const HASH = 'cd'.repeat(32);
const signFeed = (payload, key = vendor.privateKey) => JSON.stringify({ payload, sig: crypto.sign(null, feedMessage(payload), key).toString('base64') });
const base = () => makeFeedPayload({ issuedAt: '2026-10-12T10:00:00.000Z', clinicsOff: ['c-000002', 'c-000001', 'c-000002'],
  syncKeysRevoked: [FP], partnerKeysRevoked: [HASH] });

test('makeFeedPayload: вид и версия, списки без повторов и по порядку', () => {
  assert.deepEqual(base(), { kind: 'easymed-public-feed', v: 1, issued_at: '2026-10-12T10:00:00.000Z', clinics_off: ['c-000001', 'c-000002'],
    sync_keys_revoked: [FP], partner_keys_revoked: [HASH] });
});

test('подписанный список проверяется; правка любого поля — bad_signature; чужой ключ — bad_signature', () => {
  const ok = verifyFeed(signFeed(base()), { publicKey: vendor.publicKey });
  assert.deepEqual(ok, { ok: true, feed: { issued_at: '2026-10-12T10:00:00.000Z', clinics_off: ['c-000001', 'c-000002'], sync_keys_revoked: [FP], partner_keys_revoked: [HASH] } });
  const doc = JSON.parse(signFeed(base()));
  doc.payload.clinics_off = ['c-000001'];
  assert.deepEqual(verifyFeed(JSON.stringify(doc), { publicKey: vendor.publicKey }), { ok: false, reason: 'bad_signature' });
  const other = crypto.generateKeyPairSync('ed25519');
  assert.deepEqual(verifyFeed(signFeed(base(), other.privateKey), { publicKey: vendor.publicKey }), { ok: false, reason: 'bad_signature' });
  assert.deepEqual(verifyFeed(signFeed(base()), {}), { ok: false, reason: 'bad_signature' }, 'без ключа в параметрах — ключ, вшитый в программу');
});

test('список и лицензия не подменяют друг друга, даже подписанные одним ключом', () => {
  const feedDoc = JSON.parse(signFeed(base()));
  const asLicence = verifyLicence(JSON.stringify({ payload: { ...feedDoc.payload, clinic_id: 'c-000001' }, sig: feedDoc.sig }), { publicKey: vendor.publicKey, clinicId: 'c-000001' });
  assert.equal(asLicence.ok, false);
  const plain = verifyLicence(JSON.stringify(feedDoc), { publicKey: vendor.publicKey, clinicId: 'c-000001' });
  assert.equal(plain.reason, 'bad_signature', 'подпись списка — над FEED_CONTEXT + canonical, лицензия — над canonical');
  const licenceSig = crypto.sign(null, Buffer.from(canonical(feedDoc.payload)), vendor.privateKey).toString('base64');
  assert.deepEqual(verifyFeed(JSON.stringify({ payload: feedDoc.payload, sig: licenceSig }), { publicKey: vendor.publicKey }),
    { ok: false, reason: 'bad_signature' }, 'подпись «как у лицензии» над теми же полями списком не считается');
  assert.ok(feedMessage(feedDoc.payload).toString('utf8').startsWith(FEED_CONTEXT));
});

test('строгий вид: чужой kind или v, плохое время, неверные записи — malformed; мусор — malformed, без исключений', () => {
  const bad = [
    { ...base(), kind: 'licence' }, { ...base(), v: 2 }, { ...base(), issued_at: 'вчера' },
    { ...base(), clinics_off: ['../x'] }, { ...base(), sync_keys_revoked: ['AB'.repeat(16)] }, { ...base(), partner_keys_revoked: ['em_live_x'] },
    { ...base(), clinics_off: 'c-1' }, { ...base(), partner_keys_revoked: [HASH, 5] },
  ];
  for (const p of bad) assert.deepEqual(verifyFeed(signFeed(p), { publicKey: vendor.publicKey }), { ok: false, reason: 'malformed' }, JSON.stringify(p).slice(0, 60));
  for (const raw of [null, undefined, '', 'не json', '[]', '{}', '{"payload":null}', JSON.stringify({ payload: base(), sig: 'не base64!' }), Buffer.from('{')]) {
    assert.deepEqual(verifyFeed(raw, { publicKey: vendor.publicKey }), { ok: false, reason: 'malformed' });
  }
});

test('потолки: тело больше 2 МБ — too_large; клиник больше потолка — malformed', () => {
  assert.deepEqual(verifyFeed('x'.repeat(FEED_LIMITS.bytes + 1), { publicKey: vendor.publicKey }), { ok: false, reason: 'too_large' });
  const many = makeFeedPayload({ issuedAt: '2026-10-12T10:00:00.000Z', clinicsOff: Array.from({ length: FEED_LIMITS.clinics + 1 }, (_, i) => 'c-' + i) });
  assert.deepEqual(verifyFeed(signFeed(many), { publicKey: vendor.publicKey }), { ok: false, reason: 'malformed' });
});
