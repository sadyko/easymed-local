// PUBLIC_LICENCE_V1 — панель через HTTP: переключатель онлайн-записи, новый ключ
// обмена (принять), срочный отзыв ключей; ключ партнёра целиком не принимается.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { hashPassword } from '../services/vendor-auth.js';
import { createEnrollmentCode, redeemEnrollmentCode } from '../services/enrollment.js';
import { checkIn } from '../services/checkin.js';
import { signLicence } from '../services/signing.js';
import { createApp } from '../app.js';
import { listen } from '../test-helpers/listen.js';
import { newApiKey, keyHash } from '../../../server/services/api/secret-box.js';

const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-admin-api-key-'));
const keyFile = path.join(keyDir, 'vendor-private.pem');
fs.writeFileSync(keyFile, crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }));
test.before(() => { process.env.EASYMED_SIGNING_KEY = keyFile; });
test.after(() => { delete process.env.EASYMED_SIGNING_KEY; fs.rmSync(keyDir, { recursive: true, force: true }); });

function syncKey() {
  const pub = crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' });
  return { b64: pub.toString('base64'), fp: crypto.createHash('sha256').update(pub).digest('hex').slice(0, 32) };
}

async function harness(t) {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare('INSERT INTO vendor_users (username, password_hash, full_name) VALUES (?,?,?)').run('vendor', hashPassword('secret123'), 'Vendor');
  const token = redeemEnrollmentCode(db, { code: createEnrollmentCode(db, { clinicId: 'c-1', name: 'Шифо' }) }).install_token;
  const server = await listen(createApp(db));
  t.after(() => server.close());
  const base = 'http://127.0.0.1:' + server.address().port + '/cp/v1';
  const login = await fetch(base + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'vendor', password: 'secret123' }) });
  const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const call = async (method, p, body) => {
    const res = await fetch(base + '/admin' + p, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const checkin = (b64) => checkIn(db, { installToken: token, ...(b64 ? { apiSyncPublicKey: b64 } : {}) }, { signLicence });
  return { db, call, checkin };
}

test('карточка клиники: блок «Online booking / API» — выключено, ключа нет, лицензии 8c нет, блокировок нет', async (t) => {
  const s = await harness(t);
  const d = await s.call('GET', '/clinics/c-1');
  assert.deepEqual(d.body.clinic.api, { enabled: false, sync_key: null, sync_key_accepted_at: null, sync_key_seen: null, sync_key_seen_at: null,
    key_pending: false, seen_key_revoked: false, partners_see: 'off', licence: null, revocations: [] });
  const list = await s.call('GET', '/clinics');
  assert.deepEqual([list.body.clinics[0].api_enabled, list.body.clinics[0].api_key_pending], [false, false]);
});

test('переключатель: только true/false; включили — «нет ключа», пока клиника его не прислала; потом — видна, и лицензия это говорит', async (t) => {
  const s = await harness(t);
  for (const enabled of ['yes', 1, null, undefined]) assert.equal((await s.call('POST', '/clinics/c-1/api', { enabled })).status, 400);
  assert.equal((await s.call('POST', '/clinics/c-нет/api', { enabled: true })).status, 404);
  const on = await s.call('POST', '/clinics/c-1/api', { enabled: true });
  assert.deepEqual([on.status, on.body.api.enabled, on.body.api.partners_see], [200, true, 'no_key']);
  assert.match(on.body.note, /within a minute/);
  const k = syncKey();
  s.checkin(k.b64);
  const d = (await s.call('GET', '/clinics/c-1')).body.clinic.api;
  assert.deepEqual([d.sync_key, d.partners_see, d.licence.subscription, d.licence.api_sync_key], [k.fp, 'visible', 'active', k.fp]);
  const off = await s.call('POST', '/clinics/c-1/api', { enabled: false });
  assert.equal(off.body.api.partners_see, 'off');
});

test('новый ПК: ключ ждёт подтверждения, доска это показывает; принять можно только тот, что на экране', async (t) => {
  const s = await harness(t);
  const a = syncKey();
  const b = syncKey();
  s.checkin(a.b64);
  s.checkin(b.b64);
  const d = (await s.call('GET', '/clinics/c-1')).body.clinic.api;
  assert.deepEqual([d.sync_key, d.sync_key_seen, d.key_pending], [a.fp, b.fp, true]);
  assert.equal((await s.call('GET', '/clinics')).body.clinics[0].api_key_pending, true);
  assert.equal((await s.call('POST', '/clinics/c-1/api/accept-key', { fingerprint: 'не отпечаток' })).status, 400);
  const wrong = await s.call('POST', '/clinics/c-1/api/accept-key', { fingerprint: a.fp });
  assert.deepEqual([wrong.status, wrong.body.error.code], [409, 'conflict']);
  const ok = await s.call('POST', '/clinics/c-1/api/accept-key', { fingerprint: b.fp });
  assert.deepEqual([ok.status, ok.body.api.sync_key, ok.body.api.key_pending], [200, b.fp, false]);
  assert.equal((await s.call('POST', '/clinics/c-1/api/accept-key', { fingerprint: b.fp })).status, 409, 'ждущего больше нет');
});

test('блокировка ключа партнёра: только SHA-256; сам ключ — отказ без следа; повтор — «уже»; снять — один раз', async (t) => {
  const s = await harness(t);
  const key = newApiKey();
  const raw = await s.call('POST', '/clinics/c-1/revocations', { kind: 'partner_key', value: key, note: 'утёк' });
  assert.equal(raw.status, 400);
  assert.match(raw.body.error.message, /SHA-256 of the key, not the key itself/, 'узнан именно ключ, а не «неверный отпечаток»');
  assert.ok(!JSON.stringify(raw.body).includes(key), 'ключ не возвращается в ответе');
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM revocations').get().n, 0);
  for (const value of ['ab'.repeat(16), 'zz'.repeat(32), '', 42]) {
    assert.equal((await s.call('POST', '/clinics/c-1/revocations', { kind: 'partner_key', value })).status, 400);
  }
  assert.equal((await s.call('POST', '/clinics/c-1/revocations', { kind: 'clinic', value: keyHash(key) })).status, 400);
  const add = await s.call('POST', '/clinics/c-1/revocations', { kind: 'partner_key', value: keyHash(key).toUpperCase(), note: '  med24: ключ утёк  ' });
  assert.equal(add.status, 201);
  assert.match(add.body.note, /even while the clinic is offline/);
  assert.deepEqual(add.body.api.revocations.map((r) => [r.kind, r.value, r.note, r.created_by]), [['partner_key', keyHash(key), 'med24: ключ утёк', 'vendor']]);
  const again = await s.call('POST', '/clinics/c-1/revocations', { kind: 'partner_key', value: keyHash(key) });
  assert.deepEqual([again.status, again.body.already, again.body.id], [200, true, add.body.id]);
  assert.equal((await s.call('DELETE', '/clinics/c-1/revocations/' + add.body.id)).status, 200);
  assert.equal((await s.call('DELETE', '/clinics/c-1/revocations/' + add.body.id)).status, 404);
  const row = s.db.prepare('SELECT removed_at, removed_by FROM revocations WHERE id = ?').get(add.body.id);
  assert.ok(row.removed_at && row.removed_by === 'vendor', 'снятие помнится: кто и когда');
});

test('блокировка ключа обмена: принятый ключ уходит из лицензии, клиника скрыта; тот же ключ больше не «ждёт подтверждения»', async (t) => {
  const s = await harness(t);
  await s.call('POST', '/clinics/c-1/api', { enabled: true });
  const k = syncKey();
  s.checkin(k.b64);
  const blocked = await s.call('POST', '/clinics/c-1/revocations', { kind: 'sync_key', value: k.fp, note: 'ПК украден' });
  assert.equal(blocked.status, 201);
  assert.deepEqual([blocked.body.api.sync_key, blocked.body.api.partners_see, blocked.body.api.seen_key_revoked, blocked.body.api.key_pending],
    [null, 'no_key', true, false]);
  const next = s.checkin(k.b64);
  assert.equal('api_sync_key' in next.licence.payload, false, 'следующая лицензия — без ключа');
  const fresh = syncKey();
  s.checkin(fresh.b64);
  const d = (await s.call('GET', '/clinics/c-1')).body.clinic.api;
  assert.deepEqual([d.sync_key, d.key_pending], [null, true], 'новый ключ после кражи — только подтверждением');
});
