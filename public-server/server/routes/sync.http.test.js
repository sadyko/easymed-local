// PUBLIC_SERVER_V1 — канал клиники по HTTP: подписанные запросы стенда, ответы
// протокола §10 (те же, что у поддельного сервера 8a), лицензия и лимит.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { syncRouter } from './sync.js';
import { createRequest } from '../store/requests.js';
import { clinicRow } from '../store/clinics.js';
import { recordAccess } from '../store/logs.js';
import { PENDING_PER_CLINIC_MAX } from '../store/deliveries.js';
import { testDb, testVendor, testClinic, serve, syncCall, signedHeaders, NOW } from '../test-helpers/fixture.js';
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

// Ревью 8b, C1: тело читается только после проверки заголовков (лицензия,
// отпечаток ключа, часы, состояние лицензии), сжатое тело не распаковывается
// (415), предел тела — свой у каждого адреса.
test('C1: до проверки заголовков тело не читается — чужой не заставит распаковывать и держать мегабайты', async (t) => {
  const s = await stand();
  t.after(s.close);
  const c = testClinic(vendor);
  const big = Buffer.alloc(5 * 1024 * 1024, 0x20);
  const plain = await fetch(s.base + '/_sync/v1/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: big });
  assert.equal(plain.status, 401, 'без подписи — 401, а не 413: тело не читали');
  const bomb = zlib.gzipSync(big);
  const gz = await fetch(s.base + '/_sync/v1/events', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }, body: bomb });
  assert.equal(gz.status, 401, 'сжатое без подписи — 401 до распаковки');
  const late = signedHeaders(c, { method: 'POST', path: '/_sync/v1/events', body: big, time: isoOf(NOW - 3600000) });
  const skew = await fetch(s.base + '/_sync/v1/events', { method: 'POST', headers: late, body: big });
  assert.deepEqual([skew.status, (await skew.json()).error.code], [401, 'clock_skew']);
  const lapsed = testClinic(vendor, { clinicId: 'c-000779', validUntil: '2030-03-01T00:00:00Z' });
  const lh = signedHeaders(lapsed, { method: 'POST', path: '/_sync/v1/events', body: big, time });
  const l = await fetch(s.base + '/_sync/v1/events', { method: 'POST', headers: lh, body: big });
  assert.deepEqual([l.status, (await l.json()).error.code], [503, 'licence_lapsed']);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM clinics').get().n, 0, 'до проверки подписи клиника не записывается');
});

test('C1: сжатое тело клиники — 415 без распаковки; предел тела — свой у адреса', async (t) => {
  const s = await stand();
  t.after(s.close);
  const c = testClinic(vendor);
  const raw = zlib.gzipSync(Buffer.from(JSON.stringify({ events: [] })));
  const h = { ...signedHeaders(c, { method: 'POST', path: '/_sync/v1/events', body: raw, time }), 'Content-Encoding': 'gzip' };
  const gz = await fetch(s.base + '/_sync/v1/events', { method: 'POST', headers: h, body: raw });
  assert.deepEqual([gz.status, (await gz.json()).error.code], [415, 'unsupported_encoding']);
  const pad = 'x'.repeat(1536 * 1024);
  const events = await syncCall(s.base, c, 'POST', '/_sync/v1/events', { events: [], pad }, { time });
  assert.deepEqual([events.status, events.json.error.code], [413, 'too_large'], 'события — до 1 МБ');
  const snap = { ...snapshot('shifo'), clinic: { name: { ru: 'Шифо' }, about: pad } };
  assert.deepEqual((await syncCall(s.base, c, 'PUT', '/_sync/v1/snapshot', snap, { time })).json, { ok: true }, 'снимок — до 4 МБ');
});

test('ревью 8b, C8: очередь уведомлений клиники полна — ответ протокола прежний ({accepted}), пропуск считается', async (t) => {
  const s = await stand();
  t.after(s.close);
  const c = testClinic(vendor);
  await syncCall(s.base, c, 'PUT', '/_sync/v1/keys', keys(c), { time });
  s.db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
                INSERT INTO deliveries (clinic_id, event_id, event, url, body, signature, next_at, created_at, updated_at)
                SELECT ?, 'ev_' || i, 'booking.confirmed', 'https://med24.uz/h', '{}', 's', ?, ?, ? FROM n`)
    .run(PENDING_PER_CLINIC_MAX, c.clinicId, time, time, time);
  const body = JSON.stringify({ event_id: 'ev_x', event: 'booking.confirmed', request_id: 'rq_nonexistent00', status: 'booked' });
  const r = await syncCall(s.base, c, 'POST', '/_sync/v1/events', { events: [{ seq: 7, event: 'booking.confirmed', status: 'booked', body,
    webhook_url: 'https://med24.uz/hooks', signature: 'sha256=' + 'a'.repeat(64) }] }, { time });
  assert.deepEqual(r.json, { accepted: [7] });
  assert.equal(s.ctx.counters.queue_full, 1);
});
