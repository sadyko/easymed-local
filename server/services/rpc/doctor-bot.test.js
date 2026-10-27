// REFERRALS_CRM_V1 — RPC бота для врачей-источников: только администратор; токен не утекает.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import {
  doctorBotSettingsGet, doctorBotSettingsSave, doctorBotTokenClear, doctorBotTestConnection,
  doctorBotStats, doctorBotLinksList, doctorBotLinkRevoke, RpcError,
} from './doctor-bot.js';
import { getRpc } from './index.js';

const TOKEN = '1234567890:AAEabcdefghijklmnopqrstuvwxyz0123456';
function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  const ins = db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?,?,?,?)');
  ins.run(1, 'adm', 'x', 'admin'); ins.run(2, 'reg', 'x', 'registrar');
  return db;
}
const admin = { id: 1, role: 'admin' };
const registrar = { id: 2, role: 'registrar' };
const okMe = { fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, result: { id: 42, username: 'clinic_doctors_bot', first_name: 'Clinic' } }) }) };
const badMe = { fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ ok: false, description: 'Unauthorized' }) }) };

test('только администратор; все RPC зарегистрированы', async () => {
  const db = fresh();
  for (const fn of [doctorBotSettingsGet, doctorBotStats, doctorBotLinksList]) {
    assert.throws(() => fn(db, {}, registrar), (e) => e instanceof RpcError && e.status === 403);
    fn(db, {}, admin);
  }
  await assert.rejects(() => doctorBotSettingsSave(db, { enabled: true }, registrar), (e) => e.status === 403);
  for (const n of ['doctor_bot_settings_get', 'doctor_bot_settings_save', 'doctor_bot_token_clear', 'doctor_bot_test_connection',
    'doctor_bot_stats', 'doctor_bot_links_list', 'doctor_bot_link_revoke']) {
    assert.equal(typeof getRpc(n), 'function', n);
  }
});

test('токен: сохраняется зашифрованным, проверяется у Telegram и включает бота сам; наружу — только хвост', async () => {
  const db = fresh();
  const before = doctorBotSettingsGet(db, {}, admin);
  assert.deepEqual([before.enabled, before.has_token], [false, false]);
  await assert.rejects(() => doctorBotSettingsSave(db, { enabled: true }, admin), (e) => e.status === 400, 'включить без токена нельзя');
  await assert.rejects(() => doctorBotSettingsSave(db, { bot_token: 'nope' }, admin), (e) => e.status === 400);

  const out = await doctorBotSettingsSave(db, { bot_token: TOKEN }, admin, okMe);
  assert.equal(out.has_token, true);
  assert.equal(out.enabled, true, 'удачно проверенный токен включает бота');
  assert.equal(out.auto_enabled, true);
  assert.equal(out.bot_username, 'clinic_doctors_bot');
  assert.ok(!JSON.stringify(out).includes(TOKEN), 'токен не покидает сервер');
  const raw = db.prepare('SELECT bot_token_enc FROM doctor_bot_settings WHERE id = 1').get().bot_token_enc;
  assert.ok(raw && !raw.includes(TOKEN), 'в базе — шифртекст');

  const bad = await doctorBotSettingsSave(db, { bot_token: TOKEN.replace('AAE', 'BBB') }, admin, badMe);
  assert.ok(bad.check_error, 'Telegram не принял — ошибка на экран');
  assert.equal(bad.last_check_status, 'error');

  const t = await doctorBotTestConnection(db, {}, admin, okMe);
  assert.equal(t.ok, true);
  assert.equal(t.settings.last_check_status, 'ok');

  const cleared = doctorBotTokenClear(db, {}, admin);
  assert.deepEqual([cleared.has_token, cleared.enabled], [false, false]);
  await assert.rejects(() => doctorBotTestConnection(db, {}, admin, okMe), (e) => e.status === 400);
});

test('охват и подключённые: внешние активные, с телефоном, подключили, без телефона; отключение', () => {
  const db = fresh();
  const src = db.prepare('INSERT INTO referral_sources (name, first_name, phone, active) VALUES (?,?,?,?)');
  src.run('А', 'А', '+998901111111', 1); src.run('Б', 'Б', '', 1); src.run('В', 'В', '+998902222222', 1); src.run('Г', 'Г', '+998903333333', 0);
  const A = db.prepare("SELECT id FROM referral_sources WHERE name = 'А'").get().id;
  db.prepare("INSERT INTO doctor_bot_links (referral_source_id, chat_id, phone, tg_name) VALUES (?, '800', '998901111111', 'Доктор А')").run(A);
  const link = db.prepare('SELECT id FROM doctor_bot_links').get().id;
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (3, 'd', 'x', 'doctor')").run();
  db.prepare("INSERT INTO patients (id, full_name, phone) VALUES (10, 'П', '+998900000001')").run();
  db.prepare("INSERT INTO visits (id, patient_id, doctor_id, visit_date, status) VALUES (100, 10, 3, '2026-10-26T07:00:00.000Z', 'arrived')").run();
  db.prepare("INSERT INTO doctor_bot_notifications (visit_id, referral_source_id, link_id, chat_id, text, viewed_at) VALUES (100, ?, ?, '800', 'x', strftime('%Y-%m-%dT%H:%M:%SZ','now'))").run(A, link);

  const s = doctorBotStats(db, {}, admin);
  assert.deepEqual(s, { doctors_active: 3, with_phone: 2, connected: 1, without_phone: 1, notifications_30d: 1, viewed_30d: 1 });
  const list = doctorBotLinksList(db, {}, admin);
  assert.equal(list.length, 1);
  assert.equal(list[0].source_name, 'А');
  assert.equal(list[0].tg_name, 'Доктор А');
  assert.equal(list[0].notifications, 1);
  assert.ok(list[0].last_notified_at);

  assert.throws(() => doctorBotLinkRevoke(db, { id: 'x' }, admin), (e) => e.status === 400);
  assert.deepEqual(doctorBotLinkRevoke(db, { id: link }, admin), { id: link, revoked: true });
  assert.deepEqual(doctorBotLinkRevoke(db, { id: link }, admin), { id: link, revoked: false }, 'повторно — уже отозвана');
  assert.equal(doctorBotLinksList(db, {}, admin).length, 0);
  assert.equal(doctorBotStats(db, {}, admin).connected, 0);
});
