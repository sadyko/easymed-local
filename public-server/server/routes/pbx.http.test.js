// CALL_RING_V1 (2026-10-17) — приём вебхука станции по HTTP: секрет и клиника,
// JSON и form, непонятное событие — 200 без выдачи, предел тела, чужой метод.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pbxRouter, PBX_LIMIT_PER_MIN, PBX_CLINIC_LIMIT_PER_MIN } from './pbx.js';
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

// FIX_318_V1 (C6) — огромная дата роняла разбор (RangeError → 400, станция
// повторяла событие 7 раз); «call_missed» угадывался как «звонит», «pending» — как
// «конец». Теперь: дата вне диапазона — время приёма; неизвестное имя — 200
// ignored, клинике не выдаётся, имя — в строке unknown для сверки схемы.
test('FIX_318_V1: дата вне диапазона — 200 и событие со временем приёма; call_missed и pending — 200 ignored, клинике не выдаются, имя — в строке unknown', async (t) => {
  const s = await stand();
  t.after(s.close);
  const big = await s.post('c-000777/' + TOKEN, JSON.stringify({ ...EV, uuid: 'u-big', date: 1e20 }));
  assert.equal(big.status, 200);
  const items = pbxEventsSince(s.db, 'c-000777', '', NOW);
  assert.deepEqual(items.map((x) => [x.uuid, x.at]), [['u-big', isoOf(NOW)]]);
  for (const event of ['call_missed', 'pending']) {
    const r = await s.post('c-000777/' + TOKEN, JSON.stringify({ ...EV, uuid: 'u-' + event, event }));
    assert.deepEqual([r.status, await r.json()], [200, { ok: true, ignored: true }], event);
  }
  assert.deepEqual(pbxEventsSince(s.db, 'c-000777', '', NOW).map((x) => x.uuid), ['u-big'], 'непонятное событие уехало клинике');
  const keys = s.db.prepare("SELECT keys FROM pbx_events WHERE event = 'unknown'").all().map((x) => JSON.parse(x.keys));
  assert.ok(keys.some((k) => k.includes('event=call_missed')), JSON.stringify(keys));
  assert.ok(!JSON.stringify(keys).includes('998901112233'), 'номер в строке unknown');
});

// FIX_318_V1 (C1) — onlinePBX шлёт вебхуки ВСЕХ клиник с одних и тех же адресов:
// общий потолок по IP отдавал клинике B 429 из-за событий клиники A. Теперь по
// IP считаются только неверные секреты и чужие адреса; верный секрет — потолок
// своей клиники, после проверки секрета.
test('FIX_318_V1: события клиники A с того же IP не отнимают приём у клиники B; неверные секреты — потолок по IP; верный — потолок клиники', async (t) => {
  const { db } = testDb();
  const TA = 'aa'.repeat(16);
  const TB = 'bb'.repeat(16);
  const ins = db.prepare("INSERT INTO clinics (clinic_id, key_fp, first_seen_at, last_seen_at, ring_hash) VALUES (?, 'fp', ?, ?, ?)");
  ins.run('c-A', isoOf(NOW), isoOf(NOW), ringHashOf(TA));
  ins.run('c-B', isoOf(NOW), isoOf(NOW), ringHashOf(TB));
  const srv = await serve('/_pbx/v1', pbxRouter({ db, now: () => NOW, requireHttps: false, limiter: createLimiter() }));
  t.after(srv.close);
  const post = (p, uuid) => fetch(srv.base + '/_pbx/v1/' + p, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...EV, uuid }) });
  assert.ok(PBX_CLINIC_LIMIT_PER_MIN > PBX_LIMIT_PER_MIN);
  for (let i = 0; i < PBX_LIMIT_PER_MIN; i++) assert.equal((await post('c-A/' + TA, 'a-' + i)).status, 200, 'событие клиники A №' + i);
  assert.equal((await post('c-B/' + TB, 'b-1')).status, 200, 'клиника B получила отказ из-за событий клиники A');
  // Неверный секрет с этого же IP: свой потолок, отдельный от клиник.
  for (let i = 0; i < PBX_LIMIT_PER_MIN; i++) assert.equal((await post('c-A/' + 'cd'.repeat(16), 'x-' + i)).status, 404);
  const over = await post('c-B/' + 'ef'.repeat(16), 'x-over');
  assert.equal(over.status, 429, 'перебор неверных секретов не упёрся в потолок по IP');
  assert.ok(Number(over.headers.get('retry-after')) >= 1);
  assert.equal((await post('c-B/' + TB, 'b-2')).status, 200, 'перебор чужих секретов отнял приём у верного');
  // Потолок клиники: A исчерпывает свой — B живёт.
  for (let i = PBX_LIMIT_PER_MIN; i < PBX_CLINIC_LIMIT_PER_MIN; i++) assert.equal((await post('c-A/' + TA, 'a-' + i)).status, 200, 'событие клиники A №' + i);
  const aOver = await post('c-A/' + TA, 'a-over');
  assert.equal(aOver.status, 429, 'потолок клиники не сработал');
  assert.equal((await post('c-B/' + TB, 'b-3')).status, 200, 'потолок клиники A задел клинику B');
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
  assert.equal(s.db.prepare("SELECT keys FROM pbx_events WHERE event = 'unknown'").get().keys, '["event","uuid","caller","event=weird"]');
  assert.equal((await s.post('c-000777/' + TOKEN, '{}')).status, 400);
  assert.equal((await s.post('c-000777/' + TOKEN, JSON.stringify({ ...EV, pad: 'x'.repeat(20000) }))).status, 413);
});
