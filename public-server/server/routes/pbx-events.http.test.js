// CALL_RING_V1 (2026-10-17) — клиника забирает события станции по подписанному
// каналу: курсор, свежее по пустому курсору, длинный опрос просыпается от
// вставки, секрет приезжает в теле ключей и отпирает приём.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { syncRouter } from './sync.js';
import { pbxRouter } from './pbx.js';
import { insertPbxEvent, ringHashOf } from '../store/pbx-events.js';
import { clinicRow } from '../store/clinics.js';
import { createLimiter } from '../lib/rate-limit.js';
import { testDb, testVendor, testClinic, serve, syncCall, NOW } from '../test-helpers/fixture.js';
import { isoOf } from '../lib/time.js';
import express from 'express';
import { listen } from '../../../control-plane/server/test-helpers/listen.js';
import { errorHandler } from '../lib/errors.js';

const vendor = testVendor();
const time = isoOf(NOW);
const TOKEN = 'ab'.repeat(16);
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');

async function stand() {
  const { db, dir } = testDb();
  const ctx = { db, dataDir: dir, now: () => NOW, licencePublicKey: vendor.publicKey, requireHttps: false, limiter: createLimiter() };
  const app = express();
  app.use('/_pbx/v1', pbxRouter(ctx));
  app.use('/_sync/v1', syncRouter(ctx));
  app.use(errorHandler());
  const server = await listen(app);
  const base = 'http://127.0.0.1:' + server.address().port;
  return { db, base, close: () => new Promise((r) => server.close(r)) };
}
const keys = (c, ring) => ({ generated_at: time, box_key: c.identity.boxPublic, ring_token: ring,
  connections: [{ id: 3, kind: 'partner', active: true, key_hash: hash('k'), scopes: ['clinic'], rate_limit: 60, key_expires_at: null, ip_allow: [], origins: [] }] });
const EV = (uuid, event = 'ring') => ({ uuid, event, direction: 'in', caller: '998901112233', callee: '101', at: time });

test('ключи с секретом отпирают приём; GET /pbx-events отдаёт по курсору, пустой курсор — свежее', async (t) => {
  const s = await stand();
  t.after(s.close);
  const c = testClinic(vendor);
  const call = (m, p, b) => syncCall(s.base, c, m, p, b, { time });
  assert.deepEqual((await call('PUT', '/_sync/v1/keys', keys(c, TOKEN))).json, { ok: true });
  assert.equal(clinicRow(s.db, c.clinicId).ring_hash, ringHashOf(TOKEN));
  // Станция шлёт событие по адресу с секретом — без подписи клиники.
  const hook = await fetch(s.base + '/_pbx/v1/' + c.clinicId + '/' + TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: 'call_start', direction: 'inbound', uuid: 'u-1', caller: '998901112233', callee: '101', date: Math.floor(NOW / 1000) }) });
  assert.equal(hook.status, 200);
  const first = await call('GET', '/_sync/v1/pbx-events?after=&wait=0');
  assert.equal(first.status, 200);
  assert.equal(first.json.items.length, 1);
  const it = first.json.items[0];
  assert.deepEqual([it.uuid, it.event, it.direction, it.caller, it.callee, it.at], ['u-1', 'ring', 'in', '998901112233', '101', time]);
  assert.deepEqual((await call('GET', '/_sync/v1/pbx-events?after=' + it.id + '&wait=0')).json, { items: [] });
  const other = testClinic(vendor, { clinicId: 'c-000778' });
  await syncCall(s.base, other, 'PUT', '/_sync/v1/keys', keys(other, 'cd'.repeat(16)), { time });
  assert.deepEqual((await syncCall(s.base, other, 'GET', '/_sync/v1/pbx-events?after=&wait=0', undefined, { time })).json, { items: [] }, 'чужая клиника увидела событие');
  assert.equal((await fetch(s.base + '/_pbx/v1/' + c.clinicId + '/' + 'cd'.repeat(16), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"event":"call_start"}' })).status, 404);
});

test('длинный опрос: запрос висит, пока не ляжет событие, и отвечает им сразу; без события — пустой ответ по сроку', async (t) => {
  const s = await stand();
  t.after(s.close);
  const c = testClinic(vendor);
  await syncCall(s.base, c, 'PUT', '/_sync/v1/keys', keys(c, TOKEN), { time });
  const started = Date.now();
  const pending = syncCall(s.base, c, 'GET', '/_sync/v1/pbx-events?after=&wait=5', undefined, { time });
  setTimeout(() => insertPbxEvent(s.db, c.clinicId, EV('u-7'), NOW), 150);
  const res = await pending;
  const took = Date.now() - started;
  assert.equal(res.json.items.length, 1);
  assert.equal(res.json.items[0].uuid, 'u-7');
  assert.ok(took < 3000, 'ответ пришёл не по вставке, а по сроку: ' + took + ' мс');
  const t2 = Date.now();
  const quiet = await syncCall(s.base, c, 'GET', '/_sync/v1/pbx-events?after=' + res.json.items[0].id + '&wait=1', undefined, { time });
  assert.deepEqual(quiet.json, { items: [] });
  assert.ok(Date.now() - t2 >= 900, 'пустой ответ пришёл раньше срока ожидания');
});
