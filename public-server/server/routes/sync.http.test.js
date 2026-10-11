// PUBLIC_SERVER_V1 — канал клиники по HTTP: подписанные запросы стенда, ответы
// протокола §10 (те же, что у поддельного сервера 8a), лицензия и лимит.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { syncRouter } from './sync.js';
import { createRequest } from '../store/requests.js';
import { clinicRow } from '../store/clinics.js';
import { recordAccess } from '../store/logs.js';
import { testDb, testVendor, testClinic, serve, syncCall, NOW } from '../test-helpers/fixture.js';
import { fakePng } from '../../../server/test-helpers/fake-png.js';
import { openSealed } from '../../../server/services/api/sync-identity.js';
import { isoOf } from '../lib/time.js';

const vendor = testVendor();
const time = isoOf(NOW);
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');

async function stand(over = {}) {
  const { db, dir } = testDb();
  const ctx = { db, dataDir: dir, now: () => NOW, licencePublicKey: vendor.publicKey, requireHttps: false, ...over };
  const srv = await serve('/_sync/v1', syncRouter(ctx));
  return { db, dir, ctx, ...srv };
}
const keys = (c, at = NOW) => ({ generated_at: isoOf(at), box_key: c.identity.boxPublic, connections: [{ id: 3, kind: 'partner', active: true,
  key_hash: hash('k'), scopes: ['clinic'], rate_limit: 60, key_expires_at: null, ip_allow: [], origins: [] }] });
const snapshot = (slug) => ({ version: 1, generated_at: time, slug, clinic: { name: { ru: 'Шифо' } }, branches: [], doctors: [], services: [], packages: [] });

test('ключи, снимок, время, файлы, события — ответы протокола; чужое имя — 409 slug_taken', async (t) => {
  const s = await stand();
  t.after(s.close);
  const c = testClinic(vendor);
  const call = (m, p, b, o) => syncCall(s.base, c, m, p, b, { time, ...o });
  assert.deepEqual((await call('PUT', '/_sync/v1/keys', keys(c))).json, { ok: true });
  assert.deepEqual((await call('PUT', '/_sync/v1/snapshot', snapshot('shifo'))).json, { ok: true });
  assert.deepEqual((await call('PUT', '/_sync/v1/slots', { generated_at: time, slot_minutes: 15, doctors: {} })).json, { ok: true });
  const png = fakePng(32, 32);
  const sha = crypto.createHash('sha256').update(png).digest('hex');
  assert.deepEqual((await call('POST', '/_sync/v1/media/check', { hashes: [sha] })).json, { missing: [sha] });
  assert.deepEqual((await call('PUT', '/_sync/v1/media/' + sha + '.png', png, { type: 'image/png' })).json, { ok: true });
  assert.deepEqual((await call('POST', '/_sync/v1/media/check', { hashes: [sha] })).json, { missing: [] });
  assert.equal((await call('PUT', '/_sync/v1/media/' + sha + '.png', Buffer.from('чужое'), { type: 'image/png' })).status, 400);
  assert.deepEqual((await call('POST', '/_sync/v1/events', { events: [{ seq: 5, event: 'booking.confirmed', body: '{}' }] })).json, { accepted: [5] });
  const other = testClinic(vendor, { clinicId: 'c-000778' });
  const taken = await syncCall(s.base, other, 'PUT', '/_sync/v1/snapshot', snapshot('shifo'), { time });
  assert.deepEqual([taken.status, taken.json.error.code], [409, 'slug_taken']);
  assert.equal((await call('PUT', '/_sync/v1/snapshot', Buffer.from('{не json'))).status, 400, 'не JSON — 400');
  assert.equal((await call('GET', '/_sync/v1/nothing')).status, 404);
  assert.equal(clinicRow(s.db, c.clinicId).slug, 'shifo');
});

test('очередь: элементы по курсору с запечатанным пациентом; подтверждение стирает; last_used и журналы для 8d — по просьбе', async (t) => {
  const s = await stand();
  t.after(s.close);
  const c = testClinic(vendor);
  const call = (m, p, b) => syncCall(s.base, c, m, p, b, { time });
  await call('PUT', '/_sync/v1/keys', keys(c));
  const made = createRequest(s.db, { clinic: clinicRow(s.db, c.clinicId), connectionId: 3, kind: 'request',
    patient: { name: 'ИМЯ_ПАЦИЕНТА', phone: '+998901112233', comment: '' }, now: NOW });
  recordAccess(s.db, { clinicId: c.clinicId, connectionId: 3, at: time, method: 'GET', path: '/shifo/v1/doctors', status: 200 });
  s.db.prepare('UPDATE connections SET last_used_at = ?').run(time);
  const inbox = await call('GET', '/_sync/v1/inbox?after=');
  assert.equal(inbox.status, 200);
  assert.equal(inbox.json.items.length, 1);
  assert.equal(inbox.json.items[0].public_id, made.row.id);
  assert.equal(openSealed(c.identity, inbox.json.items[0].sealed).name, 'ИМЯ_ПАЦИЕНТА');
  assert.deepEqual(inbox.json.last_used, { 3: time });
  assert.equal(inbox.json.access, undefined, 'клиника 8a журналов не просит — их нет');
  const more = await call('GET', '/_sync/v1/inbox?after=0&access_after=0&deliveries_after=0');
  assert.equal(more.json.access.length, 1);
  assert.deepEqual(more.json.deliveries, []);
  assert.deepEqual((await call('POST', '/_sync/v1/inbox/ack', { cursor: inbox.json.items[0].cursor, held: [] })).json, { ok: true });
  assert.deepEqual((await call('GET', '/_sync/v1/inbox?after=' + inbox.json.items[0].cursor)).json.items, []);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM inbox').get().n, 0, 'шифротекст стёрт при подтверждении');
});

test('отказы: подпись, часы, срок лицензии — 503; «не оплачено» канал не закрывает; лимит — 429 с Retry-After', async (t) => {
  const s = await stand();
  t.after(s.close);
  const c = testClinic(vendor);
  const forged = await fetch(s.base + '/_sync/v1/keys', { method: 'PUT', headers: { 'X-EasyMed-Clinic': c.clinicId }, body: '{}' });
  assert.equal(forged.status, 401);
  const skew = await syncCall(s.base, c, 'PUT', '/_sync/v1/keys', keys(c), { time: isoOf(NOW - 3600000) });
  assert.deepEqual([skew.status, skew.json.error.code, skew.json.error.server_time], [401, 'clock_skew', time]);
  const lapsed = testClinic(vendor, { clinicId: 'c-000779', validUntil: '2030-03-01T00:00:00Z' });
  const l = await syncCall(s.base, lapsed, 'GET', '/_sync/v1/inbox?after=', undefined, { time });
  assert.deepEqual([l.status, l.json.error.code], [503, 'licence_lapsed']);
  const unpaid = testClinic(vendor, { clinicId: 'c-000780', subscription: 'unpaid' });
  assert.equal((await syncCall(s.base, unpaid, 'GET', '/_sync/v1/inbox?after=', undefined, { time })).status, 200);

  const limited = await stand({ limiter: { hit: () => ({ ok: false, retryAfterSec: 12 }) } });
  t.after(limited.close);
  const r = await syncCall(limited.base, c, 'GET', '/_sync/v1/inbox?after=', undefined, { time });
  assert.deepEqual([r.status, r.headers.get('retry-after'), r.json.error.code], [429, '12', 'rate_limited']);
});

test('только https: без него канал не открывается', async (t) => {
  const s = await stand({ requireHttps: true });
  t.after(s.close);
  const c = testClinic(vendor);
  const r = await syncCall(s.base, c, 'GET', '/_sync/v1/inbox?after=', undefined, { time });
  assert.deepEqual([r.status, r.json.error.code], [400, 'https_required']);
});
