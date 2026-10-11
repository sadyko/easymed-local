// PUBLIC_SERVER_V1 — приложение целиком: служебные адреса, канал клиники и
// адреса партнёров на своих местах; /_health без ключа; /_metrics только с
// токеном и только числа; фон: уборка закрывает и стирает, доставка не
// перекрывает себя.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicServer } from './app.js';
import { runMaintenance, startJobs } from './jobs.js';
import { testDb, testVendor, testClinic, syncCall, NOW } from './test-helpers/fixture.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';
import { createRequest } from './store/requests.js';
import { clinicRow } from './store/clinics.js';
import { isoOf } from './lib/time.js';

async function up(over = {}) {
  const { db, dir } = testDb();
  const vendor = testVendor();
  const { app, ctx } = createPublicServer({ db, dataDir: dir, now: () => NOW, licencePublicKey: vendor.publicKey, requireHttps: false,
    trustProxy: false, version: '0.1.0', ...over });
  const server = await listen(app);
  return { db, dir, vendor, ctx, base: 'http://127.0.0.1:' + server.address().port, close: () => new Promise((r) => server.close(r)) };
}

test('/_health — без ключа, только «жив»; /_metrics — без токена нет, с токеном — числа', async (t) => {
  const s = await up({ metricsToken: 'm-TESTONLY' });
  t.after(s.close);
  const h = await fetch(s.base + '/_health');
  assert.equal(h.status, 200);
  assert.deepEqual(Object.keys(await h.json()).sort(), ['status', 'uptime_s', 'version']);
  assert.equal((await fetch(s.base + '/_metrics')).status, 401);
  assert.equal((await fetch(s.base + '/_metrics', { headers: { Authorization: 'Bearer wrong-TESTONLY' } })).status, 401);
  const m = await (await fetch(s.base + '/_metrics', { headers: { Authorization: 'Bearer m-TESTONLY' } })).json();
  assert.equal(m.clinics, 0);
  assert.ok(Object.values(m).every((v) => v === null || ['number', 'string'].includes(typeof v)), 'только числа и время');
  const off = await up();
  t.after(off.close);
  assert.equal((await fetch(off.base + '/_metrics', { headers: { Authorization: 'Bearer m-TESTONLY' } })).status, 404, 'без токена в настройках — адреса нет');
});

test('маршруты: канал клиники и адреса партнёров не путаются; неизвестное — 404 JSON', async (t) => {
  const s = await up();
  t.after(s.close);
  const c = testClinic(s.vendor);
  const r = await syncCall(s.base, c, 'GET', '/_sync/v1/inbox?after=', undefined, { time: isoOf(NOW) });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.items, []);
  const p = await fetch(s.base + '/shifo/v1/clinic');
  assert.deepEqual([p.status, (await p.json()).error.code], [404, 'clinic_not_found']);
  const x = await fetch(s.base + '/nothing');
  assert.deepEqual([x.status, x.headers.get('cache-control'), (await x.json()).error.code], [404, 'no-store', 'not_found']);
});

test('уборка: закрывает не забранное за сутки (решение владельца 20), стирает шифротекст; срок — из настроек; повтор — ничего', async (t) => {
  const s = await up();
  t.after(s.close);
  const c = testClinic(s.vendor);
  await syncCall(s.base, c, 'PUT', '/_sync/v1/keys', { generated_at: isoOf(NOW), box_key: c.identity.boxPublic, connections: [] }, { time: isoOf(NOW) });
  createRequest(s.db, { clinic: clinicRow(s.db, c.clinicId), connectionId: 3, kind: 'request', patient: { name: 'Имя', phone: '+998901234567', comment: '' }, now: NOW });
  const HOUR = 3600000;
  assert.equal(runMaintenance(s.db, s.dir, NOW + 23 * HOUR, s.ctx.limiter).not_collected, 0, 'сутки ещё не прошли');
  const jobs = startJobs({ db: s.db, dataDir: s.dir, now: () => NOW + 25 * HOUR, send: async () => ({ status: 200 }), webhooks: false,
    uncollectedMaxMs: 48 * HOUR, maintainEveryMs: 1e9 });
  try {
    assert.equal(jobs.maintainTick().not_collected, 0, 'фон берёт срок из настройки PUBLIC_UNCOLLECTED_MAX_HOURS');
  } finally { jobs.stop(); }
  const r = runMaintenance(s.db, s.dir, NOW + 25 * HOUR, s.ctx.limiter);
  assert.equal(r.not_collected, 1);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM inbox').get().n, 0);
  assert.equal(runMaintenance(s.db, s.dir, NOW + 25 * HOUR).not_collected, 0);
});

test('фон: доставка не перекрывает себя, сбой — в состояние, не наружу', async () => {
  const { db, dir } = testDb();
  let release;
  const slow = new Promise((r) => { release = r; });
  const logs = [];
  const jobs = startJobs({ db, dataDir: dir, now: () => NOW, send: async () => { await slow; return { status: 200 }; }, deliverEveryMs: 1e9, maintainEveryMs: 1e9,
    log: { error: (...a) => logs.push(a.join(' ')) } });
  try {
    db.prepare("INSERT INTO deliveries (clinic_id, event_id, event, url, body, signature, next_at, created_at, updated_at) VALUES ('c', 'e', 'request.accepted', 'https://med24.uz/h', '{}', 's', ?, ?, ?)")
      .run(isoOf(NOW), isoOf(NOW), isoOf(NOW));
    const first = jobs.deliverTick();
    assert.equal(await jobs.deliverTick(), null, 'второй такт, пока идёт первый, — пропуск');
    release();
    assert.equal((await first).delivered, 1);
    db.close();
    assert.equal(jobs.maintainTick(), null);
    assert.equal(jobs.status().last_error, 'maintenance');
    assert.equal(logs.length, 1);
  } finally { jobs.stop(); }
});

test('ревью 8b, C3: запуск службы поднимает счётчик курсоров очереди до часов — после восстановления базы он не идёт назад', async (t) => {
  const s = await up();
  t.after(s.close);
  const c = testClinic(s.vendor);
  await syncCall(s.base, c, 'PUT', '/_sync/v1/keys', { generated_at: isoOf(NOW), box_key: c.identity.boxPublic, connections: [] }, { time: isoOf(NOW) });
  createRequest(s.db, { clinic: clinicRow(s.db, c.clinicId), connectionId: 3, kind: 'request', patient: { name: 'Имя', phone: '+998901234567', comment: '' }, now: NOW });
  const r = await syncCall(s.base, c, 'GET', '/_sync/v1/inbox?after=', undefined, { time: isoOf(NOW) });
  assert.ok(Number(r.json.items[0].cursor) > NOW, 'курсор — не меньше часов запуска');
});
