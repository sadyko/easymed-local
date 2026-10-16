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
import { noteSyncKey } from '../services/public-api.js';
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
/** Код ключа, который клиника читает с экрана «Настройки → API»: первые 8 hex, «xxxx-xxxx». */
const code = (fp) => fp.slice(0, 4) + '-' + fp.slice(4, 8);

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
  assert.deepEqual(d.body.clinic.api, { enabled: false, sync_key: null, sync_key_code: null, sync_key_accepted_at: null, sync_key_seen: null,
    sync_key_seen_at: null, candidates: [], key_pending: false, key_competing: false, replaced_seen: [], seen_key_revoked: false,
    partners_see: 'off', licence: null, revocations: [] });
  const list = await s.call('GET', '/clinics');
  assert.deepEqual([list.body.clinics[0].api_enabled, list.body.clinics[0].api_key_pending, list.body.clinics[0].api_key_competing], [false, false, false]);
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

test('новый ПК: ключ ждёт подтверждения, доска это показывает; принять — только с кодом, который клиника прочла с экрана; старый ключ потом — «прежний», не «новый»', async (t) => {
  const s = await harness(t);
  const a = syncKey();
  const b = syncKey();
  s.checkin(a.b64);
  s.checkin(b.b64);
  const d = (await s.call('GET', '/clinics/c-1')).body.clinic.api;
  assert.deepEqual([d.sync_key, d.sync_key_code, d.sync_key_seen, d.key_pending, d.key_competing], [a.fp, code(a.fp), b.fp, true, false]);
  assert.deepEqual(d.candidates.map((c) => [c.fp, c.revoked]), [[b.fp, false]]);
  assert.equal('code' in d.candidates[0], false, 'код нового ключа панель не показывает — его читает клиника');
  assert.equal((await s.call('GET', '/clinics')).body.clinics[0].api_key_pending, true);
  assert.equal((await s.call('POST', '/clinics/c-1/api/accept-key', { fingerprint: 'не отпечаток', code: code(b.fp) })).status, 400);
  const noCode = await s.call('POST', '/clinics/c-1/api/accept-key', { fingerprint: b.fp });
  assert.deepEqual([noCode.status, noCode.body.error.code], [400, 'bad_request']);
  assert.match(noCode.body.error.message, /key code/);
  const wrong = await s.call('POST', '/clinics/c-1/api/accept-key', { fingerprint: a.fp, code: code(a.fp) });
  assert.deepEqual([wrong.status, wrong.body.error.code], [409, 'conflict']);
  const mismatch = await s.call('POST', '/clinics/c-1/api/accept-key', { fingerprint: b.fp, code: code(a.fp) });
  assert.deepEqual([mismatch.status, mismatch.body.error.code], [409, 'conflict']);
  assert.match(mismatch.body.error.message, /does not match/);
  assert.ok(!JSON.stringify(mismatch.body).includes(code(b.fp)) && !JSON.stringify(mismatch.body).includes(b.fp.slice(0, 8)), 'верный код ответ не подсказывает');
  assert.equal(s.db.prepare("SELECT api_sync_key FROM clinics WHERE clinic_id = 'c-1'").get().api_sync_key, a.fp);
  const ok = await s.call('POST', '/clinics/c-1/api/accept-key', { fingerprint: b.fp, code: code(b.fp).toUpperCase() });
  assert.deepEqual([ok.status, ok.body.api.sync_key, ok.body.api.key_pending], [200, b.fp, false]);
  assert.equal((await s.call('POST', '/clinics/c-1/api/accept-key', { fingerprint: b.fp, code: code(b.fp) })).status, 409, 'ждущего больше нет');
  s.checkin(a.b64);   // старый ПК ещё работает
  const after = (await s.call('GET', '/clinics/c-1')).body.clinic.api;
  assert.deepEqual([after.key_pending, after.candidates, after.replaced_seen.map((k) => [k.fp, k.code])], [false, [], [[a.fp, code(a.fp)]]]);
});

test('ревью 8c: два разных новых ключа с одной установки — «Accept» отказывает с верным кодом любого, блокировка одного не открывает его; доска это показывает', async (t) => {
  const s = await harness(t);
  const a = syncKey();
  const b = syncKey();
  const copy = syncKey();
  s.checkin(a.b64);
  s.checkin(b.b64);
  s.checkin(copy.b64);
  const d = (await s.call('GET', '/clinics/c-1')).body.clinic.api;
  // Пришли в одну секунду — порядок по отпечатку; сравниваем без порядка.
  assert.deepEqual([d.key_pending, d.key_competing, d.candidates.map((c) => c.fp).sort()], [true, true, [b.fp, copy.fp].sort()]);
  assert.equal((await s.call('GET', '/clinics')).body.clinics[0].api_key_competing, true);
  for (const k of [b, copy]) {
    const r = await s.call('POST', '/clinics/c-1/api/accept-key', { fingerprint: k.fp, code: code(k.fp) });
    assert.deepEqual([r.status, r.body.error.code], [409, 'conflict']);
    assert.match(r.body.error.message, /2 different new keys .*possible copy.*re-enrol/s);
  }
  const blocked = await s.call('POST', '/clinics/c-1/revocations', { kind: 'sync_key', value: copy.fp, note: 'copy' });
  assert.equal(blocked.status, 201);
  assert.deepEqual(Object.fromEntries(blocked.body.api.candidates.map((c) => [c.fp, c.revoked])), { [b.fp]: false, [copy.fp]: true });
  assert.equal(blocked.body.api.key_competing, true);
  assert.equal((await s.call('POST', '/clinics/c-1/api/accept-key', { fingerprint: b.fp, code: code(b.fp) })).status, 409, 'без новой регистрации — никак');
  assert.equal(s.db.prepare("SELECT api_sync_key FROM clinics WHERE clinic_id = 'c-1'").get().api_sync_key, a.fp);
});

// Перепроверка 8c, F1: подобрать ключ Ed25519 под 8 hex принятого ключа нельзя
// в тесте (2^32 попыток), поэтому подобранный отпечаток подаётся в noteSyncKey —
// ту же функцию, которой сверка передаёт отпечаток присланного ключа.
test('перепроверка 8c, F1: новый ключ с кодом ключа, которым клиника уже пользуется, — 409 «the clinic has not changed computers»', async (t) => {
  const s = await harness(t);
  const a = syncKey();
  s.checkin(a.b64);
  const ground = a.fp.slice(0, 8) + 'f'.repeat(24);
  s.db.transaction(() => noteSyncKey(s.db, s.db.prepare("SELECT * FROM clinics WHERE clinic_id = 'c-1'").get(), ground))();
  const r = await s.call('POST', '/clinics/c-1/api/accept-key', { fingerprint: ground, code: code(a.fp) });
  assert.deepEqual([r.status, r.body.error.code], [409, 'conflict']);
  assert.match(r.body.error.message, /This is the code of the key the clinic already uses — the clinic has not changed computers\. Do not accept; this new key may be a copy\. Block it, and re-enrol the clinic if in doubt\./);
  assert.equal(s.db.prepare("SELECT api_sync_key FROM clinics WHERE clinic_id = 'c-1'").get().api_sync_key, a.fp);
});

test('заблокировать ключ обмена можно только ключ этой клиники', async (t) => {
  const s = await harness(t);
  const stranger = syncKey();
  const r = await s.call('POST', '/clinics/c-1/revocations', { kind: 'sync_key', value: stranger.fp });
  assert.equal(r.status, 400);
  assert.match(r.body.error.message, /not one of this clinic's API keys/);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM revocations').get().n, 0);
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
