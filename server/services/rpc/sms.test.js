// SMS_INFORM_V1 — RPC экрана «SMS-информирование» и клиент Play Mobile.
//
// Что закреплено:
//   * запрос — ровно форма SMS-Broker API: POST <адрес>/broker-api/send, Basic,
//     messages[].recipient / message-id / sms.originator / sms.content.text;
//   * пароль не пересекает границу RPC ни в каком виде, кроме хвоста, и в
//     базе лежит шифртекстом;
//   * раздел — только администратор (и администратор надстроечной ролью);
//   * включить без полного подключения нельзя; номер приводится к 998XXXXXXXXX;
//   * отказ Play Mobile и сеть — ok:false с причиной и строкой журнала, не 500.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';
import { smsSettingsGet, smsSettingsSave, smsPasswordClear, smsSendTest, smsLogRecent } from './sms.js';
import { getRpc } from './index.js';
import { normalizeUzPhone, sendUrl } from '../sms/playmobile.js';

const PASSWORD = 'pm-test-only-secret-9876';
const fresh = () => {
  const db = openDb(':memory:');
  migrate(db);
  const ins = db.prepare('INSERT INTO users (id, username, password_hash, role, full_name) VALUES (?,?,?,?,?)');
  ins.run(1, 'adm', 'x', 'admin', 'Администратор');
  ins.run(2, 'docadm', 'x', 'doctor', 'Врач-админ');
  ins.run(3, 'reg', 'x', 'registrar', 'Регистратор');
  return db;
};
const admin = { id: 1, role: 'admin' };
const doctorAdmin = { id: 2, role: 'doctor', extra_roles: ['admin'] };
const registrar = { id: 3, role: 'registrar' };
const kek = () => ({ kekPath: path.join(tmpDir('em-sms-rpc-'), '.api-secrets-key') });
const FULL = { base_url: 'https://pm.example.test', login: 'clinic', password: PASSWORD, originator: '3700' };

function configured(deps) {
  const db = fresh();
  smsSettingsSave(db, FULL, admin, deps);
  return db;
}

test('нормализация номера и адреса', () => {
  assert.equal(normalizeUzPhone('+998 90 123 45 67'), '998901234567');
  assert.equal(normalizeUzPhone('90 123-45-67'), '998901234567');
  assert.equal(normalizeUzPhone('+7 900 123 45 67'), null);
  assert.equal(normalizeUzPhone(''), null);
  assert.equal(sendUrl('https://pm.example.test/'), 'https://pm.example.test/broker-api/send');
  assert.equal(sendUrl('http://10.0.0.1/broker-api/send'), 'http://10.0.0.1/broker-api/send');
});

test('только администратор: регистратору — 403 на каждом вызове; администратор надстроечной ролью — проходит', async () => {
  const db = fresh();
  for (const call of [() => smsSettingsGet(db, {}, registrar), () => smsSettingsSave(db, {}, registrar), () => smsPasswordClear(db, {}, registrar), () => smsLogRecent(db, {}, registrar)]) {
    assert.throws(call, (e) => e.status === 403);
  }
  await assert.rejects(smsSendTest(db, { phone: '998901234567', text: 'x' }, registrar), (e) => e.status === 403);
  assert.equal(smsSettingsGet(db, {}, doctorAdmin).enabled, false);
});

test('пароль: в базе шифртекстом, наружу — только признак и хвост; пустой пароль при сохранении не стирает прежний', () => {
  const deps = kek();
  const db = configured(deps);
  const pub = smsSettingsGet(db, {}, admin);
  assert.equal(pub.password_set, true);
  assert.equal(pub.password_tail, PASSWORD.slice(-4));
  assert.ok(!JSON.stringify(pub).includes(PASSWORD));
  const row = db.prepare('SELECT password_sealed FROM sms_settings WHERE id = 1').get();
  assert.ok(row.password_sealed && !row.password_sealed.includes(PASSWORD), 'пароль в базе открытым текстом');
  smsSettingsSave(db, { login: 'clinic2', password: '' }, admin, deps);
  assert.equal(smsSettingsGet(db, {}, admin).password_set, true, 'пустое поле пароля стёрло сохранённый');
  assert.equal(smsSettingsGet(db, {}, admin).login, 'clinic2');
  const cleared = smsPasswordClear(db, {}, admin);
  assert.equal(cleared.password_set, false);
  assert.equal(cleared.enabled, false);
});

test('включить без полного подключения нельзя (400); с полным — можно', () => {
  const deps = kek();
  const db = fresh();
  assert.throws(() => smsSettingsSave(db, { enabled: true }, admin, deps), (e) => e.status === 400);
  assert.throws(() => smsSettingsSave(db, { base_url: 'pm.example.test' }, admin, deps), (e) => e.status === 400, 'адрес без http(s)');
  smsSettingsSave(db, FULL, admin, deps);
  assert.equal(smsSettingsSave(db, { enabled: true }, admin, deps).enabled, true);
});

test('проверочное SMS: запрос — форма SMS-Broker API; успех пишет журнал «sent»', async () => {
  const deps = kek();
  const db = configured(deps);
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return { status: 200, text: async () => 'Request is received' }; };
  const r = await smsSendTest(db, { phone: '+998 90 123 45 67', text: 'Привет' }, admin, { ...deps, fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://pm.example.test/broker-api/send');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Basic ' + Buffer.from('clinic:' + PASSWORD).toString('base64'));
  assert.deepEqual(JSON.parse(calls[0].init.body), { messages: [{ recipient: '998901234567', 'message-id': r.message_id,
    sms: { originator: '3700', content: { text: 'Привет' } } }] });
  const log = smsLogRecent(db, {}, admin);
  assert.equal(log.length, 1);
  assert.equal(log[0].status, 'sent');
  assert.equal(log[0].phone, '998901234567');
  assert.equal(log[0].created_by_name, 'Администратор');
});

test('проверочное SMS: отказ Play Mobile и сеть — ok:false с причиной и строкой «failed», не исключение', async () => {
  const deps = kek();
  const db = configured(deps);
  const refused = async () => ({ status: 400, text: async () => JSON.stringify({ 'error-code': 401, 'error-description': 'Empty originator' }) });
  let r = await smsSendTest(db, { phone: '998901234567', text: 'x' }, admin, { ...deps, fetchImpl: refused });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'http');
  assert.equal(r.detail, '401 Empty originator');
  const denied = async () => ({ status: 401, text: async () => '' });
  r = await smsSendTest(db, { phone: '998901234567', text: 'x' }, admin, { ...deps, fetchImpl: denied });
  assert.equal(r.reason, 'auth');
  const offline = async () => { throw new TypeError('fetch failed'); };
  r = await smsSendTest(db, { phone: '998901234567', text: 'x' }, admin, { ...deps, fetchImpl: offline });
  assert.equal(r.reason, 'network');
  assert.deepEqual(smsLogRecent(db, {}, admin).map((m) => m.status), ['failed', 'failed', 'failed']);
});

test('проверочное SMS: неверный номер и неполное подключение — 400/409 до сети', async () => {
  const deps = kek();
  const fetchImpl = async () => { throw new Error('сеть трогать нельзя'); };
  const db = fresh();
  await assert.rejects(smsSendTest(db, { phone: '998901234567', text: 'x' }, admin, { ...deps, fetchImpl }), (e) => e.status === 409);
  const db2 = configured(deps);
  await assert.rejects(smsSendTest(db2, { phone: '12345', text: 'x' }, admin, { ...deps, fetchImpl }), (e) => e.status === 400);
  await assert.rejects(smsSendTest(db2, { phone: '998901234567', text: '  ' }, admin, { ...deps, fetchImpl }), (e) => e.status === 400);
});

test('RPC зарегистрированы', () => {
  for (const n of ['sms_settings_get', 'sms_settings_save', 'sms_password_clear', 'sms_send_test', 'sms_log_recent']) {
    assert.equal(typeof getRpc(n), 'function', n);
  }
});
