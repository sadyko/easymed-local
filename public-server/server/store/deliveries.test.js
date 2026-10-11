// PUBLIC_SERVER_V1 — доставка уведомлений: тело и подпись клиники как есть,
// повторы 1/5/10/30/60 минут, шесть попыток, тело стирается по итогу, журнал
// попыток для клиники.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deliverDue, purgeDeliveries, RETRY_MINUTES } from './deliveries.js';
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
