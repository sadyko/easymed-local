// PUBLIC_SERVER_V1 — отправка уведомления: адрес проверяется ещё раз; тело и
// подпись уходят как есть; имя, ведущее во внутреннюю сеть, — отказ ДО
// соединения; ответ — только код.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { httpsSend, checkWebhookUrl, makeSender } from './webhook-send.js';
import { guardedLookup } from './net-guard.js';

test('адрес: только https и доменное имя в интернете', () => {
  assert.equal(checkWebhookUrl('https://med24.uz/hooks'), '');
  for (const bad of ['http://med24.uz/hooks', 'https://127.0.0.1/x', 'https://localhost/x', 'https://srv.local/x', 'https://u:p@med24.uz/', 'мусор', '']) {
    assert.equal(checkWebhookUrl(bad), 'bad_url', bad);
  }
});

function fakeRequest(status, seen) {
  return (opts) => {
    const req = new EventEmitter();
    seen.opts = opts;
    req.end = (payload) => {
      seen.payload = payload.toString('utf8');
      setImmediate(() => { const res = new EventEmitter(); res.statusCode = status; res.resume = () => {}; res.destroy = () => {}; req.emit('response', res); });
    };
    req.destroy = () => {};
    return req;
  };
}

test('тело и подпись клиники уходят как есть; ответ — код', async () => {
  const seen = {};
  const body = '{"event":"booking.confirmed","request_id":"rq_x"}';
  const r = await httpsSend({ url: 'https://med24.uz/hooks?x=1', body, headers: { 'X-EasyMed-Signature': 'sha256=ab' }, request: fakeRequest(204, seen) });
  assert.deepEqual(r, { status: 204 });
  assert.equal(seen.payload, body);
  assert.equal(seen.opts.hostname, 'med24.uz');
  assert.equal(seen.opts.path, '/hooks?x=1');
  assert.equal(seen.opts.method, 'POST');
  assert.equal(seen.opts.headers['X-EasyMed-Signature'], 'sha256=ab');
  assert.equal(seen.opts.headers['Content-Length'], Buffer.byteLength(body));
  assert.equal(seen.opts.agent, false);
});

test('имя ведёт во внутреннюю сеть — отказ до соединения (настоящий https.request с охраной lookup)', async () => {
  const lookup = guardedLookup({ resolve: async () => [{ address: '127.0.0.1', family: 4 }] });
  const r = await httpsSend({ url: 'https://hook.partner.uz/x', body: '{}', lookup, timeoutMs: 3000 });
  assert.deepEqual(r, { status: 0, error: 'blocked_address' });
  const meta = guardedLookup({ resolve: async () => [{ address: '169.254.169.254', family: 4 }] });
  assert.deepEqual(await httpsSend({ url: 'https://hook.partner.uz/x', body: '{}', lookup: meta, timeoutMs: 3000 }), { status: 0, error: 'blocked_address' });
});

test('неверный адрес — отказ без запроса; зависший партнёр — timeout', async () => {
  assert.deepEqual(await httpsSend({ url: 'http://med24.uz/x', body: '{}' }), { status: 0, error: 'bad_url' });
  const hang = () => { const req = new EventEmitter(); req.end = () => {}; req.destroy = () => {}; return req; };
  assert.deepEqual(await httpsSend({ url: 'https://med24.uz/x', body: '{}', request: hang, timeoutMs: 50 }), { status: 0, error: 'timeout' });
});

test('настоящая отправка фона: адрес самой машины (PUBLIC_SELF_IPS) — тоже отказ', async () => {
  const send = makeSender({ selfIps: ['45.77.242.169'], timeoutMs: 3000, resolve: async () => [{ address: '45.77.242.169', family: 4 }] });
  assert.deepEqual(await send({ url: 'https://hook.partner.uz/x', body: '{}', headers: {} }), { status: 0, error: 'blocked_address' });
});
