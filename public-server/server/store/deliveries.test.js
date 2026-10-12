// PUBLIC_SERVER_V1 — доставка уведомлений: тело и подпись клиники как есть,
// повторы 1/5/10/30/60 минут, шесть попыток, тело стирается по итогу, журнал
// попыток для клиники.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deliverDue, purgeDeliveries, RETRY_MINUTES, MAX_ATTEMPTS, DELIVERY_WINDOW_MS, createHostBreaker, endpointOf, pendingCount, PENDING_PER_CLINIC_MAX }
  from './deliveries.js';
import { applyEvents } from './requests.js';
import { admitClinic } from './clinics.js';
import { deliveryLogSince } from './logs.js';
import { testDb, testVendor, testClinic, NOW } from '../test-helpers/fixture.js';
import { isoOf } from '../lib/time.js';

const vendor = testVendor();
const SIG = 'sha256=' + 'b'.repeat(64);

function setup(url = 'https://med24.uz/hooks') {
  const { db } = testDb();
  const c = testClinic(vendor);
  admitClinic(db, { clinicId: c.clinicId, fingerprint: c.identity.fingerprint,
    licence: { issued_at: '2030-03-10T00:00:00Z', valid_until: '2030-04-01T00:00:00Z', subscription: 'active' } }, NOW);
  const body = JSON.stringify({ event_id: 'ev_1', event: 'request.accepted', request_id: 'rq_abcdef', external_id: 'x', status: 'accepted', occurred_at: isoOf(NOW) });
  applyEvents(db, c.clinicId, [{ seq: 1, event: 'request.accepted', status: 'accepted', body, webhook_url: url, signature: SIG }], NOW);
  return { db, c, body };
}

test('доставлено с первого раза: тело и подпись клиники как есть, тело стёрто, в журнале — попытка', async () => {
  const s = setup();
  const sent = [];
  const r = await deliverDue(s.db, { now: NOW, send: async (m) => { sent.push(m); return { status: 200 }; } });
  assert.deepEqual(r, { attempts: 1, delivered: 1, failed: 0, retrying: 0 });
  assert.equal(sent[0].url, 'https://med24.uz/hooks');
  assert.equal(sent[0].body, s.body);
  assert.equal(sent[0].headers['X-EasyMed-Signature'], SIG);
  assert.equal(sent[0].headers['X-EasyMed-Event'], 'request.accepted');
  assert.equal(sent[0].headers['X-EasyMed-Event-Id'], 'ev_1');
  const d = s.db.prepare('SELECT * FROM deliveries').get();
  assert.deepEqual([d.state, d.body, d.attempts, d.last_code], ['delivered', null, 1, 200]);
  const log = deliveryLogSince(s.db, s.c.clinicId, 0);
  assert.deepEqual(log.map((l) => [l.attempt, l.code, l.final, l.request_id]), [[1, 200, 'delivered', 'rq_abcdef']]);
  assert.deepEqual(await deliverDue(s.db, { now: NOW + 3600000, send: async () => ({ status: 200 }) }), { attempts: 0, delivered: 0, failed: 0, retrying: 0 });
});

test('не отвечает: повторы через 1, 5, 10, 30, 60 минут, после шестой попытки — не доставлено', async () => {
  const s = setup();
  let t = NOW;
  const codes = [];
  for (let i = 0; i < 6; i += 1) {
    const r = await deliverDue(s.db, { now: t, send: async () => ({ status: 503 }) });
    assert.equal(r.attempts, 1, 'попытка ' + (i + 1));
    const d = s.db.prepare('SELECT * FROM deliveries').get();
    codes.push(d.state);
    if (i < 5) {
      assert.equal(d.next_at, isoOf(t + RETRY_MINUTES[i] * 60000));
      assert.equal((await deliverDue(s.db, { now: t + RETRY_MINUTES[i] * 60000 - 1000, send: async () => ({ status: 200 }) })).attempts, 0, 'раньше срока не шлём');
      t += RETRY_MINUTES[i] * 60000;
    }
  }
  assert.deepEqual(codes, ['pending', 'pending', 'pending', 'pending', 'pending', 'failed']);
  const d = s.db.prepare('SELECT * FROM deliveries').get();
  assert.deepEqual([d.attempts, d.body, d.next_at], [6, null, null]);
  assert.equal(deliveryLogSince(s.db, s.c.clinicId, 0).at(-1).final, 'failed');
});

test('сбой отправки и негодный адрес в строке — не роняют волну; негодный — сразу не доставлено', async () => {
  const s = setup();
  s.db.prepare("INSERT INTO deliveries (clinic_id, event_id, event, url, body, signature, next_at, created_at, updated_at) VALUES (?, 'ev_2', 'request.accepted', 'http://10.0.0.1/x', '{}', ?, ?, ?, ?)")
    .run(s.c.clinicId, SIG, isoOf(NOW), isoOf(NOW), isoOf(NOW));
  const r = await deliverDue(s.db, { now: NOW, send: async () => { throw new Error('сеть'); } });
  assert.deepEqual(r, { attempts: 2, delivered: 0, failed: 1, retrying: 1 });
  assert.equal(s.db.prepare("SELECT last_error FROM deliveries WHERE event_id = 'ev_2'").get().last_error, 'bad_url');
  assert.equal(s.db.prepare("SELECT last_error FROM deliveries WHERE event_id = 'ev_1'").get().last_error, 'send_failed');
});

test('уборка: законченные старше 30 дней', async () => {
  const s = setup();
  await deliverDue(s.db, { now: NOW, send: async () => ({ status: 204 }) });
  assert.equal(purgeDeliveries(s.db, NOW + 29 * 86400000), 0);
  assert.equal(purgeDeliveries(s.db, NOW + 31 * 86400000), 1);
});

// ── Честная очередь (проверка 8b, C8): зависший адрес не держит чужие уведомления ──
const TARPIT = 'https://hooks.tarpit.uz/h';
const HEALTHY = 'https://med24.uz/hooks';
const later = (ms) => new Promise((r) => setTimeout(r, ms));
function queue(db, clinicId, url, n, from) {
  const ins = db.prepare(`INSERT INTO deliveries (clinic_id, connection_id, event_id, event, url, body, signature, next_at, created_at, updated_at)
                          VALUES (?, 1, ?, 'booking.declined', ?, '{}', ?, ?, ?, ?)`);
  for (let i = 0; i < n; i += 1) ins.run(clinicId, clinicId + '-' + url.length + '-' + from + '-' + i, url, SIG, isoOf(from + i), isoOf(NOW), isoOf(NOW));
}
function tarpitSend(sent) {
  return async ({ url }) => {
    sent.push(url);
    if (url === TARPIT) { await later(30); return { status: 0, error: 'timeout' }; }
    return { status: 200 };
  };
}

test('честная очередь: 40 уведомлений одной клиники на зависший адрес не задерживают другую клинику — та же волна', async () => {
  const { db } = testDb();
  queue(db, 'c-a', TARPIT, 40, NOW - 60000);
  queue(db, 'c-b', HEALTHY, 1, NOW - 1000);
  const sent = [];
  const r = await deliverDue(db, { now: NOW, send: tarpitSend(sent), breaker: createHostBreaker() });
  assert.ok(sent.includes(HEALTHY), 'чужая клиника — в первой же волне');
  assert.equal(sent.filter((u) => u === TARPIT).length, 2, 'на зависший адрес — не больше двух отправок за волну (потолок адреса)');
  assert.deepEqual(r, { attempts: 3, delivered: 1, failed: 0, retrying: 2 });
});

test('честная очередь внутри клиники: её же другой партнёр не ждёт, пока разберётся зависший', async () => {
  const { db } = testDb();
  queue(db, 'c-a', TARPIT, 30, NOW - 60000);
  queue(db, 'c-a', HEALTHY, 1, NOW - 1000);
  const sent = [];
  await deliverDue(db, { now: NOW, send: tarpitSend(sent), breaker: createHostBreaker() });
  assert.ok(sent.includes(HEALTHY));
});

test('отказавший адрес: две неудачи подряд — отдых без отправок; отсрочка не тратит попыток; отдых растёт 15 → 30 с', async () => {
  const { db } = testDb();
  queue(db, 'c-a', TARPIT, 10, NOW - 60000);
  const breaker = createHostBreaker();
  const sent = [];
  await deliverDue(db, { now: NOW, send: tarpitSend(sent), breaker });
  assert.equal(sent.length, 2, 'две неудачи подряд — адрес отдыхает');
  const r2 = await deliverDue(db, { now: NOW + 5000, send: tarpitSend(sent), breaker });
  assert.equal(sent.length, 2, 'в отдых — ни одной отправки');
  assert.deepEqual([r2.attempts, r2.retrying], [0, 8], 'подошедшие строки отложены до конца отдыха — попытки не тратятся (проверка исправлений 8b, A)');
  assert.deepEqual(db.prepare('SELECT attempts, last_error, next_at FROM deliveries WHERE id = 3').get(),
    { attempts: 0, last_error: 'host_down', next_at: isoOf(NOW + 15000) });
  assert.equal((await deliverDue(db, { now: NOW + 10000, send: tarpitSend(sent), breaker })).retrying, 0, 'в отдых ничего не подходит');
  await deliverDue(db, { now: NOW + 15000, send: tarpitSend(sent), breaker });
  assert.equal(sent.length, 3, 'после отдыха — одна попытка; снова неудача — снова отдых');
  assert.equal(db.prepare('SELECT next_at FROM deliveries WHERE id = 4').get().next_at, isoOf(NOW + 45000), 'второй отдых — 30 с');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM delivery_log WHERE error = 'host_down'").get().n, 8, 'в журнал — одна строка на переход строки в отсрочку');
});

test('случайный обрыв у живого адреса не отправляет его отдыхать; первый ответ сбрасывает счёт неудач', () => {
  const b = createHostBreaker();
  b.fail('h:443', NOW);
  assert.equal(b.isDown('h:443', NOW), false);
  b.ok('h:443');
  b.fail('h:443', NOW);
  assert.equal(b.isDown('h:443', NOW), false, 'после ответа — снова с нуля');
  b.fail('h:443', NOW);
  assert.deepEqual([b.isDown('h:443', NOW + 14999), b.until('h:443')], [true, NOW + 15000]);
  b.fail('h:443', NOW);
  b.fail('h:443', NOW);
  b.fail('h:443', NOW);
  assert.equal(b.until('h:443'), NOW + 60000, 'отдых — не больше минуты');
});

test('одновременно — не больше четырёх отправок и не больше одной на адрес; волна берёт всех по очереди', async () => {
  const { db } = testDb();
  for (let h = 0; h < 10; h += 1) queue(db, 'c-' + h, 'https://h' + h + '.partner.uz/x', 2, NOW - 60000 + h);
  let now = 0;
  let peak = 0;
  let hostPeak = 0;
  const per = new Map();
  const send = async ({ url }) => {
    now += 1; peak = Math.max(peak, now);
    per.set(url, (per.get(url) || 0) + 1); hostPeak = Math.max(hostPeak, per.get(url));
    await later(5);
    now -= 1; per.set(url, per.get(url) - 1);
    return { status: 200 };
  };
  const r = await deliverDue(db, { now: NOW, send, breaker: createHostBreaker() });
  assert.equal(r.delivered, 20);
  assert.equal(peak, 4);
  assert.equal(hostPeak, 1);
});

test('для приёма событий: сколько у клиники ждёт доставки, и потолок очереди', () => {
  const { db } = testDb();
  queue(db, 'c-a', HEALTHY, 3, NOW);
  queue(db, 'c-b', HEALTHY, 1, NOW);
  db.prepare("UPDATE deliveries SET state = 'delivered' WHERE id = 1").run();
  assert.equal(pendingCount(db, 'c-a'), 2);
  assert.ok(PENDING_PER_CLINIC_MAX >= 1000);
});

// ── Отдых хоста — отсрочка, а не попытка (проверка исправлений 8b, A) ──
const PARTNER = 'https://hooks.partner.uz/easymed';
function seeded(seed) {
  let s = seed;
  return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
}
async function simulate(db, { minutes, feedMinutes, perMin, send, url = () => PARTNER, clinics = 4 }) {
  const breaker = createHostBreaker();
  const ins = db.prepare(`INSERT INTO deliveries (clinic_id, connection_id, event_id, event, url, body, signature, next_at, created_at, updated_at)
                          VALUES (?, 1, ?, 'booking.offered_other_time', ?, '{}', ?, ?, ?, ?)`);
  let n = 0;
  for (let now = NOW; now < NOW + minutes * 60000; now += 5000) {
    if (now < NOW + feedMinutes * 60000 && (now - NOW) % 60000 === 0) {
      for (let i = 0; i < perMin; i += 1) { const c = 'c' + (n % clinics); ins.run(c, 'ev' + n, url(c), SIG, isoOf(now), isoOf(now), isoOf(now)); n += 1; }
    }
    await deliverDue(db, { now, send, breaker });
  }
  const by = (s) => db.prepare('SELECT COUNT(*) AS n FROM deliveries WHERE state = ?').get(s).n;
  return { total: n, delivered: by('delivered'), failed: by('failed'), pending: by('pending') };
}

test('случайные обрывы у партнёра (1 из 8) при 12 уведомлениях в минуту: отдых не сжигает попытки — всё доставлено', async () => {
  const { db } = testDb();
  const rnd = seeded(7);
  const r = await simulate(db, { minutes: 240, feedMinutes: 120, perMin: 12, send: async () => (rnd() < 1 / 8 ? { status: 0, error: 'timeout' } : { status: 200 }) });
  assert.deepEqual(r, { total: 1440, delivered: 1440, failed: 0, pending: 0 });
});

test('всегда лежащий адрес: строки кончаются «не доставлено» по возрасту — не позже окна расписания 1/5/10/30/60', async () => {
  const { db } = testDb();
  let sends = 0;
  const r = await simulate(db, { minutes: 180, feedMinutes: 10, perMin: 5, send: async () => { sends += 1; return { status: 0, error: 'connect' }; } });
  assert.deepEqual(r, { total: 50, delivered: 0, failed: 50, pending: 0 });
  const life = db.prepare('SELECT MAX(julianday(updated_at) - julianday(created_at)) * 1440 AS m FROM deliveries').get().m;
  assert.ok(life <= DELIVERY_WINDOW_MS / 60000 + 2, 'дольше окна не живёт: ' + life);
  assert.ok(sends <= 200, 'отправок на лежащий адрес — около одной в минуту отдыха, а не по каждой строке: ' + sends);
  const perRow = db.prepare("SELECT MAX(n) AS m FROM (SELECT delivery_id, COUNT(*) AS n FROM delivery_log WHERE error = 'host_down' GROUP BY delivery_id)").get().m;
  assert.ok(perRow <= MAX_ATTEMPTS + 1, 'строк «host_down» в журнале на доставку — не больше попыток: ' + perRow);
});

test('неверный порт одной клиники на хосте партнёра не усыпляет сам адрес партнёра для других клиник', async () => {
  const { db } = testDb();
  const BAD = 'https://hooks.partner.uz:8443/x';
  const r = await simulate(db, { minutes: 150, feedMinutes: 30, perMin: 4, url: (c) => (c === 'c0' ? BAD : PARTNER),
    send: async ({ url }) => (url === BAD ? { status: 0, error: 'timeout' } : { status: 200 }) });
  assert.equal(r.failed, 30, 'не доходят только уведомления с неверным портом');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE url = ? AND state = 'delivered' AND attempts = 1").get(PARTNER).n, 90);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM delivery_log l JOIN deliveries d ON d.id = l.delivery_id WHERE d.url = ? AND l.error = 'host_down'").get(PARTNER).n, 0);
  assert.equal(endpointOf(BAD), 'hooks.partner.uz:8443');
  assert.equal(endpointOf(PARTNER), 'hooks.partner.uz:443');
});
