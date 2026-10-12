// PUBLIC_LICENCE_V1 — список производителя на публичном сервере: принимается
// только подписанный и не старше принятого; переживает перезапуск; сбой сети —
// прежний список; страж тестов не пускает на настоящий сервер лицензий.
import test from 'node:test';
import assert from 'node:assert/strict';
import { testDb, testVendor, NOW } from '../test-helpers/fixture.js';
import { signTestFeed } from '../test-helpers/feed-fixture.js';
import {
  emptyFeed, loadFeed, applyFeedText, pullFeed, feedBlocksClinic, feedRevokedPartnerKey, feedRevokedSyncKey, feedMetrics,
  assertFeedUrlIsTestSafe,
} from './feed.js';

const FP = 'ab'.repeat(16);
const HASH = 'cd'.repeat(32);
const at = (ms) => new Date(ms).toISOString();

test('принят подписанный: в памяти и в базе; старше принятого — outdated; тот же — без записи; чужая подпись — отказ, прежний остаётся', () => {
  const { db } = testDb();
  const vendor = testVendor();
  const h = emptyFeed();
  const doc = signTestFeed(vendor, { issuedAt: at(NOW), clinicsOff: ['c-000777'], syncKeysRevoked: [FP], partnerKeysRevoked: [HASH] });
  assert.deepEqual(applyFeedText(db, h, doc, { publicKey: vendor.publicKey, now: NOW }), { ok: true, changed: true });
  assert.deepEqual([h.issued_at, [...h.clinicsOff], [...h.syncKeysRevoked], [...h.partnerKeysRevoked], h.error], [at(NOW), ['c-000777'], [FP], [HASH], '']);
  assert.equal(db.prepare('SELECT issued_at FROM vendor_feed').get().issued_at, at(NOW));
  assert.deepEqual(applyFeedText(db, h, doc, { publicKey: vendor.publicKey, now: NOW + 1000 }), { ok: true, changed: false });
  const older = signTestFeed(vendor, { issuedAt: at(NOW - 60000) });
  assert.deepEqual(applyFeedText(db, h, older, { publicKey: vendor.publicKey, now: NOW }), { ok: false, error: 'outdated' });
  assert.equal(h.clinicsOff.has('c-000777'), true, 'повтор старого списка блокировку не снимает');
  const forged = signTestFeed(testVendor(), { issuedAt: at(NOW + 60000) });
  assert.deepEqual(applyFeedText(db, h, forged, { publicKey: vendor.publicKey, now: NOW }), { ok: false, error: 'bad_signature' });
  assert.deepEqual([h.issued_at, h.error], [at(NOW), 'bad_signature']);
  const newer = signTestFeed(vendor, { issuedAt: at(NOW + 60000) });
  assert.deepEqual(applyFeedText(db, h, newer, { publicKey: vendor.publicKey, now: NOW + 60000 }), { ok: true, changed: true });
  assert.deepEqual([h.clinicsOff.size, h.error], [0, ''], 'новый список снимает блокировки, которых в нём нет');
});

test('перезапуск: последний принятый — из базы, проверенный заново; испорченная строка — пустой список', () => {
  const { db } = testDb();
  const vendor = testVendor();
  applyFeedText(db, emptyFeed(), signTestFeed(vendor, { issuedAt: at(NOW), partnerKeysRevoked: [HASH] }), { publicKey: vendor.publicKey, now: NOW });
  const again = loadFeed(db, { publicKey: vendor.publicKey });
  assert.deepEqual([again.issued_at, [...again.partnerKeysRevoked]], [at(NOW), [HASH]]);
  db.prepare("UPDATE vendor_feed SET doc = replace(doc, 'cdcd', 'eeee')").run();
  const tampered = loadFeed(db, { publicKey: vendor.publicKey });
  assert.deepEqual([tampered.issued_at, tampered.partnerKeysRevoked.size, tampered.error], [null, 0, 'stored_bad_signature']);
  assert.equal(loadFeed(testDb().db, { publicKey: vendor.publicKey }).issued_at, null, 'пустая база — пустой список');
});

test('решения по списку: клиника скрыта по номеру или по отозванному ключу обмена; ключ партнёра — по отпечатку', () => {
  const h = emptyFeed();
  h.clinicsOff = new Set(['c-1']);
  h.syncKeysRevoked = new Set([FP]);
  h.partnerKeysRevoked = new Set([HASH]);
  assert.equal(feedBlocksClinic(h, { clinic_id: 'c-1', key_fp: 'x' }), true);
  assert.equal(feedBlocksClinic(h, { clinic_id: 'c-2', key_fp: FP }), true);
  assert.equal(feedBlocksClinic(h, { clinic_id: 'c-2', key_fp: 'x' }), false);
  assert.equal(feedBlocksClinic(null, { clinic_id: 'c-1' }), false, 'нет списка — ничего не скрыто');
  assert.equal(feedRevokedPartnerKey(h, HASH), true);
  assert.equal(feedRevokedPartnerKey(undefined, HASH), false);
  assert.equal(feedRevokedSyncKey(h, FP), true);
});

test('pullFeed: токен в заголовке, без перенаправлений; сбой сети, не 200, слишком большое — причина и прежний список', async () => {
  const { db } = testDb();
  const vendor = testVendor();
  const h = emptyFeed();
  const seen = [];
  const good = signTestFeed(vendor, { issuedAt: at(NOW), clinicsOff: ['c-9'] });
  const ok = async (url, opts) => { seen.push({ url, opts }); return new Response(good, { status: 200 }); };
  const r = await pullFeed(db, h, { url: 'https://cp.test/cp/v1/public-feed', token: 'f-TESTONLY', publicKey: vendor.publicKey, fetchImpl: ok, now: NOW });
  assert.deepEqual(r, { ok: true, changed: true });
  assert.deepEqual([seen[0].url, seen[0].opts.method, seen[0].opts.headers.Authorization, seen[0].opts.redirect, seen[0].opts.body],
    ['https://cp.test/cp/v1/public-feed', 'GET', 'Bearer f-TESTONLY', 'error', undefined]);
  const cases = [
    [async () => { throw new TypeError('fetch failed'); }, 'unreachable'],
    [async () => new Response('{}', { status: 401 }), 'http_401'],
    [async () => new Response('x'.repeat(2_000_001), { status: 200 }), 'too_large'],
    [async () => new Response('не json', { status: 200 }), 'malformed'],
  ];
  for (const [fetchImpl, error] of cases) {
    assert.deepEqual(await pullFeed(db, h, { url: 'https://cp.test/f', token: 't', publicKey: vendor.publicKey, fetchImpl, now: NOW + 5000 }), { ok: false, error });
    assert.deepEqual([h.error, h.checked_at, [...h.clinicsOff]], [error, '2030-03-11T04:00:05Z', ['c-9']]);
  }
});

test('страж тестов: настоящий сервер лицензий из теста без подставного fetch — отказ; свой адрес или свой fetch — можно', () => {
  assert.throws(() => assertFeedUrlIsTestSafe('https://settings.easymed.uz/cp/v1/public-feed', globalThis.fetch), /refusing to reach the production control plane/);
  assert.throws(() => assertFeedUrlIsTestSafe('https://settings.easymed.uz/cp/v1/public-feed', undefined), /refusing/);
  assert.doesNotThrow(() => assertFeedUrlIsTestSafe('https://settings.easymed.uz/cp/v1/public-feed', async () => null));
  assert.doesNotThrow(() => assertFeedUrlIsTestSafe('http://127.0.0.1:9/cp/v1/public-feed', globalThis.fetch));
});

test('feedMetrics: только числа и время; возраст — от issued_at', () => {
  const h = emptyFeed();
  assert.deepEqual(feedMetrics(h, NOW), { feed_issued_at: null, feed_age_s: null, feed_checked_at: null, feed_error: '',
    feed_clinics_off: 0, feed_sync_keys_revoked: 0, feed_partner_keys_revoked: 0 });
  h.issued_at = at(NOW - 90000);
  h.clinicsOff = new Set(['a', 'b']);
  assert.deepEqual([feedMetrics(h, NOW).feed_age_s, feedMetrics(h, NOW).feed_clinics_off], [90, 2]);
});
