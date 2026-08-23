import { test } from 'node:test';
import assert from 'node:assert/strict';
import { binotelCall, BINOTEL_API_BASE } from './binotel.js';

// A fetch Response fake. body:null steers readBounded onto its text()
// fallback — no streams needed to test this module's own decisions.
const fakeRes = (status, bodyText) => ({
  ok: status >= 200 && status < 300,
  status,
  body: null,
  text: async () => bodyText,
});

const CREDS = { key: 'test-key', secret: 'sup3r-s3cret-value' };

test('posts to <base><method>.json with key/secret merged into the JSON body', async () => {
  let seenUrl, seenInit;
  const fetchImpl = async (url, init) => { seenUrl = url; seenInit = init; return fakeRes(200, '{"status":"success","callDetails":{}}'); };
  const r = await binotelCall('stats/all-incoming-calls-since', { timestamp: 123 }, { ...CREDS, fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.data.status, 'success');
  assert.equal(seenUrl, BINOTEL_API_BASE + 'stats/all-incoming-calls-since.json');
  const body = JSON.parse(seenInit.body);
  assert.deepEqual(body, { timestamp: 123, key: 'test-key', secret: 'sup3r-s3cret-value' });
  // The timeout must be real, not cosmetic: the request carries an abort signal.
  assert.ok(seenInit.signal instanceof AbortSignal);
});

test('params can never override the credentials', async () => {
  let seenInit;
  const fetchImpl = async (_url, init) => { seenInit = init; return fakeRes(200, '{"status":"success"}'); };
  await binotelCall('m', { key: 'attacker', secret: 'attacker' }, { ...CREDS, fetchImpl });
  const body = JSON.parse(seenInit.body);
  assert.equal(body.key, 'test-key');
  assert.equal(body.secret, 'sup3r-s3cret-value');
});

test('the fixed reason vocabulary, never a throw', async () => {
  // Network down / DNS dead / timeout → offline.
  assert.deepEqual(
    await binotelCall('m', {}, { ...CREDS, fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND'); } }),
    { ok: false, reason: 'offline' },
  );
  // HTTP 401/403 → the credentials.
  assert.deepEqual(await binotelCall('m', {}, { ...CREDS, fetchImpl: async () => fakeRes(401, '') }), { ok: false, reason: 'bad_credentials' });
  assert.deepEqual(await binotelCall('m', {}, { ...CREDS, fetchImpl: async () => fakeRes(403, '') }), { ok: false, reason: 'bad_credentials' });
  // HTTP 5xx (and other non-ok) → their problem.
  assert.deepEqual(await binotelCall('m', {}, { ...CREDS, fetchImpl: async () => fakeRes(500, 'boom') }), { ok: false, reason: 'server_error' });
  // Unparseable / non-object bodies → bad_response.
  assert.deepEqual(await binotelCall('m', {}, { ...CREDS, fetchImpl: async () => fakeRes(200, 'not json') }), { ok: false, reason: 'bad_response' });
  assert.deepEqual(await binotelCall('m', {}, { ...CREDS, fetchImpl: async () => fakeRes(200, '[1,2]') }), { ok: false, reason: 'bad_response' });
});

test('a body over the size bound is discarded as bad_response', async () => {
  const huge = '{"status":"success","x":"' + 'a'.repeat(2000) + '"}';
  const r = await binotelCall('m', {}, { ...CREDS, maxBytes: 100, fetchImpl: async () => fakeRes(200, huge) });
  assert.deepEqual(r, { ok: false, reason: 'bad_response' });
});

test('in-body errors: credential words → bad_credentials, anything else → server_error', async () => {
  // Binotel reports a wrong key at HTTP 200 with status:'error' in the body.
  const bad = await binotelCall('m', {}, { ...CREDS, fetchImpl: async () => fakeRes(200, '{"status":"error","message":"Wrong api key or secret"}') });
  assert.deepEqual(bad, { ok: false, reason: 'bad_credentials' });
  // An unrecognised in-body error blames the vendor, never the admin's typing.
  const other = await binotelCall('m', {}, { ...CREDS, fetchImpl: async () => fakeRes(200, '{"status":"error","message":"internal failure"}') });
  assert.deepEqual(other, { ok: false, reason: 'server_error' });
});

test('never writes to the console — so the secret can never reach a log', async () => {
  // Capture EVERY console channel around both a network failure and an
  // in-body error, the two paths where a naive client would log the request.
  const captured = [];
  const channels = ['log', 'info', 'warn', 'error', 'debug'];
  const original = {};
  for (const c of channels) { original[c] = console[c]; console[c] = (...a) => captured.push(a.map(String).join(' ')); }
  try {
    await binotelCall('m', { timestamp: 1 }, { ...CREDS, fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
    await binotelCall('m', { timestamp: 1 }, { ...CREDS, fetchImpl: async () => fakeRes(200, '{"status":"error","message":"Wrong api secret"}') });
    await binotelCall('m', { timestamp: 1 }, { ...CREDS, fetchImpl: async () => fakeRes(500, 'x') });
  } finally {
    for (const c of channels) console[c] = original[c];
  }
  // The stronger claim first: this module logs NOTHING at all…
  assert.deepEqual(captured, []);
  // …which subsumes the actual requirement: no line ever carries the secret.
  assert.ok(captured.every((line) => !line.includes(CREDS.secret)));
});
