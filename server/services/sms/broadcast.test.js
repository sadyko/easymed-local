// SMS_PUSH_V1 — SMS-рассылка: отбор, подтверждение числом, пачки Play Mobile.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';
import { resolveSmsAudience, runSmsBroadcast, smsParts, BATCH_SIZE } from './broadcast.js';
import { smsSettingsSave, smsBroadcastPreview, smsBroadcastSend, smsBroadcastStatusRpc } from '../rpc/sms.js';
import { getRpc } from '../rpc/index.js';

const admin = { id: 1, role: 'admin' };
const registrar = { id: 3, role: 'registrar' };
const FULL = { base_url: 'https://pm.example.test', login: 'clinic', password: 'pm-test-only-secret', originator: '3700' };

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?,?,?,?)');
  u.run(1, 'adm', 'x', 'admin');
  u.run(3, 'reg', 'x', 'registrar');
  const p = db.prepare('INSERT INTO patients (full_name, phone, gender, active) VALUES (?,?,?,?)');
  p.run('Мама', '+998 90 111 22 33', 'female', 1);
  p.run('Сын', '90 111 22 33', 'male', 1);          // тот же номер — одно SMS
  p.run('Отец', '+998 91 444 55 66', 'male', 1);
  p.run('Архив', '+998 93 777 88 99', 'female', 0);  // неактивная карта — нет
  p.run('Россия', '+7 900 123 45 67', 'female', 1);  // не Узбекистан — нет
  p.run('Без номера', '', 'male', 1);
  return db;
}

test('отбор: активные карты с номером Узбекистана, один номер — один получатель; фильтры Telegram работают', () => {
  const db = fresh();
  const all = resolveSmsAudience(db, {});
  assert.deepEqual(all.map((a) => a.phone).sort(), ['998901112233', '998914445566']);
  const women = resolveSmsAudience(db, { gender: 'female' });
  assert.deepEqual(women.map((a) => a.full_name), ['Мама']);
});

test('части SMS: кириллица 70/67, латиница 160/153', () => {
  assert.equal(smsParts(''), 0);
  assert.equal(smsParts('а'.repeat(70)), 1);
  assert.equal(smsParts('а'.repeat(71)), 2);
  assert.equal(smsParts('a'.repeat(160)), 1);
  assert.equal(smsParts('a'.repeat(161)), 2);
});

test('RPC: только администратор; отправка — при включённой отправке и с верным числом', () => {
  const deps = { kekPath: path.join(tmpDir('em-sms-bc-'), '.api-secrets-key') };
  const db = fresh();
  assert.throws(() => smsBroadcastPreview(db, {}, registrar), (e) => e.status === 403);
  assert.equal(smsBroadcastPreview(db, { fresh: true }, admin).count, 2);
  assert.throws(() => smsBroadcastSend(db, { text: 'x', confirm_count: 2 }, admin, deps), (e) => e.status === 409, 'без подключения');
  smsSettingsSave(db, FULL, admin, deps);
  assert.throws(() => smsBroadcastSend(db, { text: 'x', confirm_count: 2 }, admin, deps), (e) => e.status === 409, 'отправка выключена');
  smsSettingsSave(db, { enabled: true }, admin, deps);
  assert.throws(() => smsBroadcastSend(db, { text: 'x', confirm_count: 5 }, admin, deps), (e) => e.status === 409 && /сейчас 2/.test(e.message));
  assert.throws(() => smsBroadcastSend(db, { text: '  ', confirm_count: 2 }, admin, deps), (e) => e.status === 400);
});

test('рассылка: одна пачка — один запрос со всеми номерами; итог sent', async () => {
  const deps = { kekPath: path.join(tmpDir('em-sms-bc-'), '.api-secrets-key') };
  const db = fresh();
  smsSettingsSave(db, { ...FULL, enabled: true }, admin, deps);
  const bodies = [];
  let done;
  const finished = new Promise((r) => { done = r; });
  const fetchImpl = async (_url, init) => { bodies.push(JSON.parse(init.body)); setTimeout(done, 10); return { status: 200, text: async () => '' }; };
  const started = smsBroadcastSend(db, { text: 'Акция', confirm_count: 2 }, admin, { ...deps, fetchImpl });
  assert.equal(started.audience_count, 2);
  await finished;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(bodies.length, 1);
  assert.deepEqual(bodies[0].messages.map((m) => m.recipient).sort(), ['998901112233', '998914445566']);
  assert.ok(bodies[0].messages.every((m) => m.sms.originator === '3700' && m.sms.content.text === 'Акция'));
  const st = smsBroadcastStatusRpc(db, { id: started.id }, admin);
  assert.equal(st.status, 'done');
  assert.equal(st.sent_count, 2);
});

test('рассылка: пачки по BATCH_SIZE; отказ пачки помечает её номера failed, остальные уходят', async () => {
  const db = fresh();
  const bc = db.prepare("INSERT INTO sms_broadcasts (text, audience_count) VALUES ('t', ?) RETURNING id").get(BATCH_SIZE + 3);
  const add = db.prepare('INSERT INTO sms_broadcast_targets (broadcast_id, phone, message_id) VALUES (?, ?, ?)');
  for (let i = 0; i < BATCH_SIZE + 3; i++) add.run(bc.id, '99890' + String(1000000 + i), 'm' + i);
  let call = 0;
  const fetchImpl = async () => (++call === 1
    ? { status: 400, text: async () => JSON.stringify({ 'error-code': 205, 'error-description': 'Empty message-id' }) }
    : { status: 200, text: async () => '' });
  const conn = { base_url: 'https://pm.example.test', login: 'l', password: 'p', originator: 'o' };
  const r = await runSmsBroadcast(db, conn, bc.id, 't', { fetchImpl });
  assert.equal(call, 2);
  assert.deepEqual(r, { sent: 3, failed: BATCH_SIZE });
  const failed = db.prepare("SELECT error FROM sms_broadcast_targets WHERE status = 'failed'").all();
  assert.equal(failed.length, BATCH_SIZE);
  assert.equal(failed[0].error, '205 Empty message-id');
});

test('RPC рассылки зарегистрированы', () => {
  for (const n of ['sms_broadcast_preview', 'sms_broadcast_send', 'sms_broadcast_status']) assert.equal(typeof getRpc(n), 'function', n);
});
