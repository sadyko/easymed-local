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
import { createEnrollmentCode, redeemEnrollmentCode, reissueEnrollmentCode } from '../services/enrollment.js';
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
/** Непрозрачный id строки ключа — им панель обращается к новому ключу, не зная его отпечатка. */
const keyIdOf = (s, fp) => s.db.prepare("SELECT id FROM sync_keys_seen WHERE clinic_id = 'c-1' AND fp = ?").get(fp).id;

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
  assert.deepEqual(d.body.clinic.api, { enabled: false, sync_key: null, sync_key_code: null, sync_key_accepted_at: null,
    candidates: [], key_pending: false, key_competing: false, replaced_seen: [], former_keys: [], seen_key_revoked: false,
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
  assert.deepEqual([d.sync_key, d.sync_key_code, d.key_pending, d.key_competing], [a.fp, code(a.fp), true, false]);
  assert.deepEqual(d.candidates.map((c) => [c.id, c.revoked]), [[keyIdOf(s, b.fp), false]]);
  assert.equal('code' in d.candidates[0] || 'fp' in d.candidates[0], false, 'ни кода, ни отпечатка нового ключа панель не получает — код читает клиника');
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
  const ok = await s.call('POST', '/clinics/c-1/api/accept-key', { key_id: d.candidates[0].id, code: code(b.fp).toUpperCase() });
  assert.deepEqual([ok.status, ok.body.api.sync_key, ok.body.api.key_pending], [200, b.fp, false]);
  assert.equal((await s.call('POST', '/clinics/c-1/api/accept-key', { fingerprint: b.fp, code: code(b.fp) })).status, 409, 'ждущего больше нет');
  s.checkin(a.b64);   // старый ПК ещё работает
  const after = (await s.call('GET', '/clinics/c-1')).body.clinic.api;
  assert.deepEqual([after.key_pending, after.candidates, after.replaced_seen.map((k) => [k.id, k.code])], [false, [], [[keyIdOf(s, a.fp), code(a.fp)]]]);
  assert.equal('fp' in after.replaced_seen[0], false);
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
  assert.deepEqual([d.key_pending, d.key_competing, d.candidates.map((c) => c.id).sort()], [true, true, [keyIdOf(s, b.fp), keyIdOf(s, copy.fp)].sort()]);
  assert.equal((await s.call('GET', '/clinics')).body.clinics[0].api_key_competing, true);
  for (const k of [b, copy]) {
    const r = await s.call('POST', '/clinics/c-1/api/accept-key', { fingerprint: k.fp, code: code(k.fp) });
    assert.deepEqual([r.status, r.body.error.code], [409, 'conflict']);
    assert.match(r.body.error.message, /2 different new keys .*possible copy.*re-enrol/s);
  }
  // «Block this key» у нового ключа шлёт его id — отпечаток сервер находит сам.
  const blocked = await s.call('POST', '/clinics/c-1/revocations', { kind: 'sync_key', key_id: keyIdOf(s, copy.fp), note: 'copy' });
  assert.equal(blocked.status, 201);
  assert.equal(s.db.prepare("SELECT value FROM revocations WHERE kind = 'sync_key'").get().value, copy.fp);
  assert.deepEqual(Object.fromEntries(blocked.body.api.candidates.map((c) => [c.id, c.revoked])), { [keyIdOf(s, b.fp)]: false, [keyIdOf(s, copy.fp)]: true });
  assert.deepEqual(blocked.body.api.revocations.map((r) => [r.kind, r.value, r.code]), [['sync_key', null, null]], 'ни отпечатка, ни кода не принятого ни разу ключа');
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
  // По id — только строка этой клиники.
  createEnrollmentCode(s.db, { clinicId: 'c-2', name: 'Другая' });
  s.db.prepare("INSERT INTO sync_keys_seen (clinic_id, fp, first_seen, last_seen, state, state_at) VALUES ('c-2', ?, 'x', 'x', 'candidate', 'x')").run(stranger.fp);
  const otherId = s.db.prepare("SELECT id FROM sync_keys_seen WHERE clinic_id = 'c-2'").get().id;
  for (const key_id of [otherId, 9999, 'x']) {
    const byId = await s.call('POST', '/clinics/c-1/revocations', { kind: 'sync_key', key_id });
    assert.equal(byId.status, 400, String(key_id));
  }
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM revocations').get().n, 0);
});

// Перепроверка 8c, F4: отпечаток нового ключа — это и его код (первые 8 hex).
// Его не должно быть ни в одном ответе панели — иначе код читается в DevTools.
test('перепроверка 8c, F4: ни один ответ панели не несёт отпечатка нового ключа — ни карточка, ни доска, ни ответы на действия', async (t) => {
  const s = await harness(t);
  const a = syncKey();
  const b = syncKey();
  s.checkin(a.b64);
  s.checkin(b.b64);
  const secret = b.fp.slice(0, 8);
  const answers = [
    await s.call('GET', '/clinics/c-1'),
    await s.call('GET', '/clinics'),
    await s.call('POST', '/clinics/c-1/api', { enabled: true }),
    await s.call('POST', '/clinics/c-1/api/accept-key', { key_id: keyIdOf(s, b.fp), code: '0000-0000' }),
  ];
  const blk = await s.call('POST', '/clinics/c-1/revocations', { kind: 'sync_key', key_id: keyIdOf(s, b.fp) });
  answers.push(blk, await s.call('DELETE', '/clinics/c-1/revocations/' + blk.body.id));
  for (const r of answers) assert.ok(!JSON.stringify(r.body).includes(secret), JSON.stringify(r.body).slice(0, 120));
  const gone = await s.call('POST', '/clinics/c-1/api/accept-key', { key_id: 9999, code: code(b.fp) });
  assert.deepEqual([gone.status, gone.body.error.code], [409, 'conflict'], 'ключа с таким id у клиники нет — перезагрузить страницу');
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

// Перепроверка 8c, F2: принятый ключ заблокировали по ошибке и сняли блокировку —
// прежде клиника оставалась без онлайн-записи навсегда (ключ не «новый» и не
// «принятый»). Теперь снятие блокировки возвращает его принятым, как до неё.
test('перепроверка 8c, F2: заблокированный по ошибке принятый ключ после снятия блокировки — снова принятый, лицензия снова с ним', async (t) => {
  const s = await harness(t);
  await s.call('POST', '/clinics/c-1/api', { enabled: true });
  const a = syncKey();
  s.checkin(a.b64);
  const blk = await s.call('POST', '/clinics/c-1/revocations', { kind: 'sync_key', value: a.fp, note: 'по ошибке' });
  assert.equal(blk.body.api.sync_key, null);
  assert.equal('api_sync_key' in s.checkin(a.b64).licence.payload, false, 'пока заблокирован — лицензия без ключа');
  const un = await s.call('DELETE', '/clinics/c-1/revocations/' + blk.body.id);
  assert.deepEqual([un.status, un.body.api.sync_key, un.body.api.key_pending, un.body.api.partners_see], [200, a.fp, false, 'visible']);
  assert.equal(s.checkin(a.b64).licence.payload.api_sync_key, a.fp, 'следующая лицензия — снова с ключом');
});

test('перепроверка 8c, F2: если после блокировки принят другой ключ, снятие блокировки старого его не возвращает', async (t) => {
  const s = await harness(t);
  const a = syncKey();
  const b = syncKey();
  s.checkin(a.b64);
  const blk = await s.call('POST', '/clinics/c-1/revocations', { kind: 'sync_key', value: a.fp, note: 'ПК украден' });
  s.checkin(b.b64);
  assert.equal((await s.call('POST', '/clinics/c-1/api/accept-key', { fingerprint: b.fp, code: code(b.fp) })).status, 200);
  const un = await s.call('DELETE', '/clinics/c-1/revocations/' + blk.body.id);
  assert.deepEqual([un.status, un.body.api.sync_key], [200, b.fp]);
});

// Перепроверка 8c, раунд 2 (п. 3 и 5): после новой регистрации прежний ключ
// клиники (ПК A сменили на B, потом A украли) по-прежнему можно заблокировать
// по отпечатку, и в «Blocked keys» у него — его код, а не «new key (blocked)».
test('перепроверка 8c, раунд 2: прежний ключ после новой регистрации блокируется по отпечатку и сохраняет свой код в «Blocked keys»', async (t) => {
  const s = await harness(t);
  const a = syncKey();
  const b = syncKey();
  const c3 = syncKey();
  s.checkin(a.b64);
  s.checkin(b.b64);
  assert.equal((await s.call('POST', '/clinics/c-1/api/accept-key', { fingerprint: b.fp, code: code(b.fp) })).status, 200);
  s.checkin(c3.b64);
  const early = await s.call('POST', '/clinics/c-1/revocations', { kind: 'sync_key', value: c3.fp });   // никогда не принятый
  assert.equal(early.status, 201);
  redeemEnrollmentCode(s.db, { code: reissueEnrollmentCode(s.db, { clinicId: 'c-1' }) });
  const blocked = await s.call('POST', '/clinics/c-1/revocations', { kind: 'sync_key', value: a.fp, note: 'ПК A украден' });
  assert.equal(blocked.status, 201, blocked.body && blocked.body.error && blocked.body.error.message);
  const byKind = Object.fromEntries(blocked.body.api.revocations.map((r) => [r.note || 'early', r.code]));
  assert.deepEqual(byKind, { 'ПК A украден': code(a.fp), early: null }, 'у прежнего — код, у ни разу не принятого — нет');
});

// Перепроверка 8c, раунд 3 (R3-4): после новой регистрации прежний ключ (ПК A
// сменили на B, потом A украли) виден на карточке своим кодом и блокируется из
// панели — по непрозрачному id строки истории, как новые ключи (F4), не по отпечатку.
test('перепроверка 8c, раунд 3 (R3-4): прежний ключ после новой регистрации — на карточке кодом, блокируется из панели по своему id', async (t) => {
  const s = await harness(t);
  const a = syncKey();
  const b = syncKey();
  s.checkin(a.b64);
  s.checkin(b.b64);
  assert.equal((await s.call('POST', '/clinics/c-1/api/accept-key', { fingerprint: b.fp, code: code(b.fp) })).status, 200);
  redeemEnrollmentCode(s.db, { code: reissueEnrollmentCode(s.db, { clinicId: 'c-1' }) });
  const api = (await s.call('GET', '/clinics/c-1')).body.clinic.api;
  assert.deepEqual(api.former_keys.map((f) => [f.code, f.other_clinic, 'fp' in f]), [[code(a.fp), null, false]]);
  assert.ok(api.former_keys[0].last_accepted_at && api.former_keys[0].replaced_at);
  const formerId = api.former_keys[0].id;
  // Свои пространства id: номер строки истории в key_id и чужая строка истории — 400.
  createEnrollmentCode(s.db, { clinicId: 'c-2', name: 'Другая' });
  const otherId = Number(s.db.prepare("INSERT INTO sync_keys_history (clinic_id, fp, first_accepted_at, last_accepted_at) VALUES ('c-2', ?, 'x', 'x')")
    .run('dd'.repeat(16)).lastInsertRowid);
  assert.equal((await s.call('POST', '/clinics/c-1/revocations', { kind: 'sync_key', former_id: otherId })).status, 400);
  assert.equal((await s.call('POST', '/clinics/c-1/revocations', { kind: 'sync_key', former_id: 'x' })).status, 400);
  const blk = await s.call('POST', '/clinics/c-1/revocations', { kind: 'sync_key', former_id: formerId, note: 'ПК A украден' });
  assert.equal(blk.status, 201, blk.body && blk.body.error && blk.body.error.message);
  assert.equal(s.db.prepare("SELECT value FROM revocations WHERE kind = 'sync_key'").get().value, a.fp);
  assert.deepEqual(blk.body.api.revocations.map((r) => r.code), [code(a.fp)]);
  assert.deepEqual(blk.body.api.former_keys, [], 'заблокированный — в «Blocked keys»');
});
