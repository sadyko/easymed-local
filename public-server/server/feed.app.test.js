// PUBLIC_LICENCE_V1 — фон забирает список производителя по HTTP (свой «сервер
// лицензий» на случайном порту), служба держит его после перезапуска, /_metrics
// показывает его свежесть и каким ключом проверяются лицензии.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createPublicServer } from './app.js';
import { startJobs } from './jobs.js';
import { testDb, testVendor, NOW } from './test-helpers/fixture.js';
import { signTestFeed } from './test-helpers/feed-fixture.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';

const TOKEN = 'f-TESTONLY-0123456789abcdef0123456789';

async function fakeControlPlane(vendor, body) {
  const app = express();
  const seen = [];
  app.get('/cp/v1/public-feed', (req, res) => {
    seen.push(req.get('authorization'));
    if (req.get('authorization') !== 'Bearer ' + TOKEN) return res.status(401).json({ error: { code: 'unauthorized' } });
    return res.type('application/json').send(body());
  });
  const server = await listen(app);
  return { url: 'http://127.0.0.1:' + server.address().port + '/cp/v1/public-feed', seen, close: () => new Promise((r) => server.close(r)) };
}

test('фон забирает список; /_metrics — свежесть и ключ; после перезапуска список тот же', async (t) => {
  const { db, dir } = testDb();
  const vendor = testVendor();
  let issued = NOW;
  const cp = await fakeControlPlane(vendor, () => signTestFeed(vendor, { issuedAt: new Date(issued).toISOString(), clinicsOff: ['c-000777'] }));
  t.after(cp.close);
  const s = createPublicServer({ db, dataDir: dir, now: () => NOW + 30000, licencePublicKey: vendor.publicKey, requireHttps: false,
    trustProxy: false, metricsToken: 'm-TESTONLY', licenceKeySource: 'override' });
  const jobs = startJobs({ db, dataDir: dir, now: () => NOW + 30000, send: async () => ({ status: 200 }), webhooks: false,
    maintainEveryMs: 3600000, feedEveryMs: 3600000, feed: { holder: s.ctx.feed, url: cp.url, token: TOKEN, publicKey: vendor.publicKey } });
  t.after(() => jobs.stop());
  s.ctx.jobs = jobs;
  assert.deepEqual(await jobs.feedTick(), { ok: true, changed: true });
  assert.deepEqual(cp.seen, ['Bearer ' + TOKEN]);
  assert.equal(s.ctx.feed.clinicsOff.has('c-000777'), true);
  const server = await listen(s.app);
  t.after(() => new Promise((r) => server.close(r)));
  const m = await (await fetch('http://127.0.0.1:' + server.address().port + '/_metrics', { headers: { Authorization: 'Bearer m-TESTONLY' } })).json();
  assert.deepEqual([m.feed_issued_at, m.feed_age_s, m.feed_clinics_off, m.feed_error, m.licence_key, m.jobs.feed],
    [new Date(NOW).toISOString(), 30, 1, '', 'override', true]);
  const again = createPublicServer({ db, dataDir: dir, now: () => NOW, licencePublicKey: vendor.publicKey, requireHttps: false, trustProxy: false });
  assert.equal(again.ctx.feed.clinicsOff.has('c-000777'), true, 'перезапуск: последний принятый список — из базы');
  issued = NOW - 60000;
  assert.deepEqual(await jobs.feedTick(), { ok: false, error: 'outdated' });
});

test('неверный токен у сервера лицензий — причина http_401, партнёрам ничего не меняется', async (t) => {
  const { db, dir } = testDb();
  const vendor = testVendor();
  const cp = await fakeControlPlane(vendor, () => signTestFeed(vendor, { issuedAt: new Date(NOW).toISOString() }));
  t.after(cp.close);
  const s = createPublicServer({ db, dataDir: dir, now: () => NOW, licencePublicKey: vendor.publicKey, requireHttps: false, trustProxy: false });
  const jobs = startJobs({ db, dataDir: dir, now: () => NOW, send: async () => ({ status: 200 }), webhooks: false, maintainEveryMs: 3600000,
    feedEveryMs: 3600000, feed: { holder: s.ctx.feed, url: cp.url, token: 'wrong-TESTONLY', publicKey: vendor.publicKey } });
  t.after(() => jobs.stop());
  assert.deepEqual(await jobs.feedTick(), { ok: false, error: 'http_401' });
  assert.deepEqual([s.ctx.feed.issued_at, s.ctx.feed.error], [null, 'http_401']);
});
