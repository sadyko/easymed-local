// PUBLIC_LICENCE_V1 — GET /cp/v1/public-feed: без токена адреса нет, чужой
// токен — 401, свой — подписанный список, который проверяет общий проверяющий
// (vendor-feed.js), с клиниками, скрытыми от партнёров, и действующими отзывами.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { createEnrollmentCode } from '../services/enrollment.js';
import { createApp } from '../app.js';
import { listen } from '../test-helpers/listen.js';
import { publicFeedRoutes, buildFeedPayload, PUBLIC_FEED_MOUNT } from './public-feed.js';
import { verifyFeed } from '../../../server/services/control/vendor-feed.js';

const TOKEN = 'TESTONLY-feed-token-0123456789abcdef';
const FP = 'ab'.repeat(16);
const HASH = 'cd'.repeat(32);
const vendor = crypto.generateKeyPairSync('ed25519');
const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-feed-key-'));
const keyFile = path.join(keyDir, 'vendor-private.pem');
fs.writeFileSync(keyFile, vendor.privateKey.export({ type: 'pkcs8', format: 'pem' }));
test.before(() => { process.env.EASYMED_SIGNING_KEY = keyFile; });
test.after(() => { delete process.env.EASYMED_SIGNING_KEY; fs.rmSync(keyDir, { recursive: true, force: true }); });

/** Реестр: видна партнёрам только c-000001; прочие — каждая по своей причине. */
function registry() {
  const db = openDb(':memory:');
  migrate(db);
  const add = (id, sql = '') => {
    createEnrollmentCode(db, { clinicId: id, name: id });
    db.prepare(`UPDATE clinics SET api_enabled = 1, api_sync_key = ? ${sql} WHERE clinic_id = ?`).run(FP, id);
  };
  add('c-000001');
  add('c-000002', ", subscription = 'unpaid'");
  add('c-000003', ", subscription_until = '2020-01-01'");
  add('c-000004', ', api_enabled = 0');
  add('c-000005', ', api_sync_key = NULL');
  add('c-000006', ', active = 0');
  db.prepare("INSERT INTO deleted_clinics (clinic_id, name) VALUES ('c-000009', 'удалена')").run();
  db.prepare("INSERT INTO revocations (clinic_id, kind, value) VALUES ('c-000001', 'partner_key', ?), ('c-000001', 'sync_key', ?)").run(HASH, FP);
  db.prepare("INSERT INTO revocations (clinic_id, kind, value, removed_at) VALUES ('c-000001', 'partner_key', ?, '2026-10-12T00:00:00Z')").run('ef'.repeat(32));
  return db;
}

async function serve(db, env) {
  const app = express();
  app.use(PUBLIC_FEED_MOUNT, publicFeedRoutes(db, { env, now: () => new Date('2026-10-12T10:00:00.000Z') }));
  const server = await listen(app);
  return { base: 'http://127.0.0.1:' + server.address().port + PUBLIC_FEED_MOUNT, close: () => new Promise((r) => server.close(r)) };
}

test('buildFeedPayload: скрыты не оплаченные, с прошедшим сроком, выключенные, без ключа, снятые и удалённые; отзывы — только действующие', () => {
  const p = buildFeedPayload(registry(), new Date('2026-10-12T10:00:00.000Z'));
  assert.deepEqual(p, {
    kind: 'easymed-public-feed', v: 1, issued_at: '2026-10-12T10:00:00.000Z',
    clinics_off: ['c-000002', 'c-000003', 'c-000004', 'c-000005', 'c-000006', 'c-000009'],
    sync_keys_revoked: [FP], partner_keys_revoked: [HASH],
  });
});

test('нет токена в окружении или он короче 32 знаков — 404; чужой токен — 401; свой — подписанный список, no-store', async (t) => {
  const db = registry();
  for (const env of [{}, { EASYMED_CP_FEED_TOKEN: 'short' }]) {
    const errors = [];
    const orig = console.error;
    console.error = (...a) => errors.push(a.join(' '));
    const s = await serve(db, env);
    console.error = orig;
    t.after(s.close);
    const r = await fetch(s.base, { headers: { Authorization: 'Bearer ' + TOKEN } });
    assert.equal(r.status, 404);
    assert.equal(errors.length, env.EASYMED_CP_FEED_TOKEN ? 1 : 0, 'короткий токен — громкая строка в журнале');
  }
  const s = await serve(db, { EASYMED_CP_FEED_TOKEN: TOKEN });
  t.after(s.close);
  for (const auth of [undefined, 'Bearer wrong-TESTONLY', 'Basic ' + TOKEN]) {
    const r = await fetch(s.base, { headers: auth ? { Authorization: auth } : {} });
    assert.equal(r.status, 401, String(auth));
  }
  const ok = await fetch(s.base, { headers: { Authorization: 'Bearer ' + TOKEN } });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  const v = verifyFeed(await ok.text(), { publicKey: vendor.publicKey });
  assert.equal(v.ok, true);
  assert.deepEqual(v.feed.partner_keys_revoked, [HASH]);
  assert.ok(!v.feed.clinics_off.includes('c-000001'));
  assert.equal((await fetch(s.base, { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN } })).status, 404);
});

test('в приложении: адрес на месте, вход продавца ему не нужен и ничего не даёт', async (t) => {
  const db = registry();
  process.env.EASYMED_CP_FEED_TOKEN = TOKEN;
  const app = createApp(db);
  delete process.env.EASYMED_CP_FEED_TOKEN;
  const server = await listen(app);
  t.after(() => server.close());
  const base = 'http://127.0.0.1:' + server.address().port;
  assert.equal((await fetch(base + PUBLIC_FEED_MOUNT)).status, 401);
  const r = await fetch(base + PUBLIC_FEED_MOUNT, { headers: { Authorization: 'Bearer ' + TOKEN } });
  assert.equal(r.status, 200);
  assert.equal(verifyFeed(await r.text(), { publicKey: vendor.publicKey }).ok, true);
});
