// CALL_RING_V1 (2026-10-17) — приём вебхука станции по HTTP: секрет и клиника,
// JSON и form, непонятное событие — 200 без выдачи, предел тела, чужой метод.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pbxRouter } from './pbx.js';
import { createLimiter } from '../lib/rate-limit.js';
import { testDb, serve, NOW } from '../test-helpers/fixture.js';
import { ringHashOf, pbxEventsSince } from '../store/pbx-events.js';
import { isoOf } from '../lib/time.js';

const TOKEN = 'ab'.repeat(16);
async function stand() {
  const { db } = testDb();
  db.prepare("INSERT INTO clinics (clinic_id, key_fp, first_seen_at, last_seen_at, ring_hash) VALUES ('c-000777', 'fp', ?, ?, ?)")
    .run(isoOf(NOW), isoOf(NOW), ringHashOf(TOKEN));
  const ctx = { db, now: () => NOW, requireHttps: false, limiter: createLimiter() };
  const srv = await serve('/_pbx/v1', pbxRouter(ctx));
  const post = (p, body, type = 'application/json') => fetch(srv.base + '/_pbx/v1/' + p, { method: 'POST', headers: { 'Content-Type': type }, body });
  return { db, post, base: srv.base, close: srv.close };
}
const EV = { event: 'call_start', direction: 'inbound', uuid: 'u-1', caller: '998901112233', callee: '101', date: Math.floor(NOW / 1000) };

test('чужой секрет, чужая клиника, GET — один и тот же 404; свой секрет — 200 и событие в ящике', async (t) => {
  const s = await stand();
  t.after(s.close);
  assert.equal((await s.post('c-000777/' + 'cd'.repeat(16), JSON.stringify(EV))).status, 404);
  assert.equal((await s.post('c-000778/' + TOKEN, JSON.stringify(EV))).status, 404);
  assert.equal((await fetch(s.base + '/_pbx/v1/c-000777/' + TOKEN)).status, 404);
  const ok = await s.post('c-000777/' + TOKEN, JSON.stringify(EV));
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true });
  const items = pbxEventsSince(s.db, 'c-000777', '', NOW);
  assert.equal(items.length, 1);
  assert.deepEqual([items[0].uuid, items[0].event, items[0].direction, items[0].caller, items[0].callee], ['u-1', 'ring', 'in', '998901112233', '101']);
});

test('form-urlencoded — то же событие; непонятное — 200 ignored и строка unknown с именами полей; пустое тело — 400; больше 16 КБ — 413', async (t) => {
  const s = await stand();
  t.after(s.close);
  const form = 'event=call_end&direction=outbound&uuid=u-2&caller=101&callee=998935550112&date=' + Math.floor(NOW / 1000);
  assert.equal((await s.post('c-000777/' + TOKEN, form, 'application/x-www-form-urlencoded')).status, 200);
  assert.equal(pbxEventsSince(s.db, 'c-000777', '', NOW)[0].event, 'end');
  const weird = await s.post('c-000777/' + TOKEN, JSON.stringify({ event: 'weird', uuid: 'u-3', caller: '998901112233' }));
  assert.deepEqual([weird.status, await weird.json()], [200, { ok: true, ignored: true }]);
  assert.equal(pbxEventsSince(s.db, 'c-000777', '', NOW).length, 1, 'непонятное событие уехало клинике');
  assert.equal(s.db.prepare("SELECT keys FROM pbx_events WHERE event = 'unknown'").get().keys, '["event","uuid","caller"]');
  assert.equal((await s.post('c-000777/' + TOKEN, '{}')).status, 400);
  assert.equal((await s.post('c-000777/' + TOKEN, JSON.stringify({ ...EV, pad: 'x'.repeat(20000) }))).status, 413);
});
