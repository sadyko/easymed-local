// PATIENT_BOT_INVITE_V1 — бот пациента в списке пациентов: кто подключён
// (только id, по ключу номера) и «Ссылка на бот» по SMS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { patientBotStatus, patientBotInvite, inviteText, RpcError } from './patient-bot.js';
import { getRpc } from './index.js';
import { smsSettingsSave } from './sms.js';
import path from 'node:path';
import { tmpDir } from '../../test-helpers/tmpdir.js';

function fresh({ bot = 'clinic_bot', enabled = 1 } = {}) {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, role, full_name) VALUES (1, 'adm', 'x', 'admin', 'Админ')").run();
  db.prepare('UPDATE telegram_settings SET bot_username = ?, enabled = ? WHERE id = 1').run(bot, enabled);
  const ins = db.prepare('INSERT INTO patients (id, full_name, phone) VALUES (?,?,?)');
  ins.run(10, 'В боте', '+998 90 310 65 70');
  ins.run(11, 'Не в боте', '998912098887');
  ins.run(12, 'Без телефона', '');
  // Связка на тот же номер, записанный иначе (только цифры), — подключён.
  db.prepare("INSERT INTO telegram_links (chat_id, phone) VALUES ('555', '998903106570')").run();
  // Отозванная связка второго — НЕ подключён.
  db.prepare("INSERT INTO telegram_links (chat_id, phone, revoked_at) VALUES ('556', '998912098887', '2026-10-01T00:00:00Z')").run();
  return db;
}
const admin = { id: 1, role: 'admin' };

test('RPC зарегистрированы; без входа — 401', async () => {
  for (const n of ['patient_bot_status', 'patient_bot_invite']) assert.equal(typeof getRpc(n), 'function', n);
  const db = fresh();
  assert.throws(() => patientBotStatus(db, { ids: [10] }, null), (e) => e instanceof RpcError && e.status === 401);
});

test('статус: подключён — по ключу номера и живой связке; наружу только id', () => {
  const db = fresh();
  const r = patientBotStatus(db, { ids: [10, 11, 12, 'x', -1] }, admin);
  assert.deepEqual(r.linked, [10]);
  assert.equal(r.bot, true);
  assert.equal(r.sms_ready, false, 'SMS не настроено');
  assert.ok(!JSON.stringify(r).includes('998'), 'номер телефона утёк в ответ');
});

test('статус: бот выключен или без имени — bot:false и никого не перечисляем', () => {
  assert.deepEqual(patientBotStatus(fresh({ enabled: 0 }), { ids: [10] }, admin).linked, []);
  assert.equal(patientBotStatus(fresh({ bot: '' }), { ids: [10] }, admin).bot, false);
});

test('приглашение: SMS не настроено — ссылка для буфера; уже в боте и без телефона — отказ', async () => {
  const db = fresh();
  const r = await patientBotInvite(db, { patient_id: 11 }, admin);
  assert.deepEqual(r, { ok: false, sms: false, link: 'https://t.me/clinic_bot' });
  await assert.rejects(() => patientBotInvite(db, { patient_id: 10 }, admin), (e) => e.status === 409);
  await assert.rejects(() => patientBotInvite(db, { patient_id: 12 }, admin), (e) => e.status === 400);
  await assert.rejects(() => patientBotInvite(fresh({ enabled: 0 }), { patient_id: 11 }, admin), (e) => e.status === 409);
});

test('приглашение по SMS: уходит на номер пациента, журнал, повтор в 10 минут — 429', async () => {
  const db = fresh();
  const deps0 = { kekPath: path.join(tmpDir('em-patbot-'), '.api-secrets-key') };
  smsSettingsSave(db, { base_url: 'https://pm.example.test', login: 'clinic', password: 'secret', originator: '3700' }, admin, deps0);
  smsSettingsSave(db, { enabled: true }, admin, deps0);
  const calls = [];
  const deps = { ...deps0, fetchImpl: async (url, init) => { calls.push(String(init && init.body)); return { status: 200, text: async () => 'Request is received' }; } };
  const r = await patientBotInvite(db, { patient_id: 11 }, admin, deps);
  assert.deepEqual(r, { ok: true, sms: true, link: 'https://t.me/clinic_bot' });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('998912098887'), 'не на номер пациента: ' + calls[0]);
  assert.ok(calls[0].includes('https://t.me/clinic_bot'), 'в SMS нет ссылки');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM patient_bot_invites WHERE patient_id = 11 AND status = 'sent'").get().n, 1);
  await assert.rejects(() => patientBotInvite(db, { patient_id: 11 }, admin, deps), (e) => e.status === 429);
  assert.equal(calls.length, 1, 'повтор ушёл провайдеру');
});

test('текст SMS содержит ссылку и обе строки (рус/узб)', () => {
  const t = inviteText('https://t.me/x');
  assert.ok(t.includes('https://t.me/x') && t.includes('Telegram-бот клиники') && t.includes('Klinika Telegram boti'));
});

// PATIENT_BOT_INVITE_V1 — карточка заявки CRM: то же по НОМЕРУ.
import { phoneBotStatus, phoneBotInvite } from './patient-bot.js';

test('по номеру: статус без номера наружу, подключённый — linked; оператор CRM пускается, посторонний — нет', () => {
  const db = fresh();
  db.prepare("INSERT INTO users (id, username, password_hash, role, full_name) VALUES (5, 'cc', 'x', 'callcenter', 'Оператор')").run();
  const st = phoneBotStatus(db, { phone: '+998 90 310-65-70' }, admin);
  assert.deepEqual({ bot: st.bot, valid: st.valid, linked: st.linked }, { bot: true, valid: true, linked: true });
  assert.ok(!JSON.stringify(st).includes('998'), 'номер утёк в ответ');
  assert.equal(phoneBotStatus(db, { phone: '998912098887' }, admin).linked, false, 'отозванная связка — не подключён');
  assert.equal(phoneBotStatus(db, { phone: '123' }, admin).valid, false);
  assert.throws(() => phoneBotStatus(db, { phone: '998912098887' }, null), (e) => e.status === 401);
});

test('по номеру: приглашение — SMS на номер заявки, журнал заявок; повтор в 10 минут по номеру — и из списка пациентов', async () => {
  const db = fresh();
  const deps0 = { kekPath: path.join(tmpDir('em-leadbot-'), '.api-secrets-key') };
  smsSettingsSave(db, { base_url: 'https://pm.example.test', login: 'clinic', password: 'secret', originator: '3700' }, admin, deps0);
  smsSettingsSave(db, { enabled: true }, admin, deps0);
  const calls = [];
  const deps = { ...deps0, fetchImpl: async (url, init) => { calls.push(String(init && init.body)); return { status: 200, text: async () => 'ok' }; } };
  // Номер, которого нет среди пациентов, — заявка без карты.
  const r = await phoneBotInvite(db, { phone: '+998 93 777 11 22', lead_id: 42 }, admin, deps);
  assert.deepEqual(r, { ok: true, sms: true, link: 'https://t.me/clinic_bot' });
  assert.ok(calls[0].includes('998937771122'));
  assert.equal(db.prepare("SELECT lead_id FROM lead_bot_invites WHERE status = 'sent'").get().lead_id, 42);
  await assert.rejects(() => phoneBotInvite(db, { phone: '998937771122' }, admin, deps), (e) => e.status === 429);
  await assert.rejects(() => phoneBotInvite(db, { phone: '998903106570' }, admin, deps), (e) => e.status === 409, 'уже в боте');

  // Пациент 11 получил ссылку из карточки заявки — кнопка в списке пациентов не шлёт второе SMS.
  await phoneBotInvite(db, { phone: '998912098887' }, admin, deps);
  await assert.rejects(() => patientBotInvite(db, { patient_id: 11 }, admin, deps), (e) => e.status === 429);
  assert.equal(calls.length, 2, 'повтор ушёл провайдеру');
});
