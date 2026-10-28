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
  db.prepare("INSERT INTO doctor_bot_links (referral_source_id, chat_id, phone, tg_name, status) VALUES (?, '800', '998901111111', 'Доктор А', 'confirmed')").run(A);
  const link = db.prepare('SELECT id FROM doctor_bot_links').get().id;
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (3, 'd', 'x', 'doctor')").run();
  db.prepare("INSERT INTO patients (id, full_name, phone) VALUES (10, 'П', '+998900000001')").run();
  db.prepare("INSERT INTO visits (id, patient_id, doctor_id, visit_date, status) VALUES (100, 10, 3, '2026-10-26T07:00:00.000Z', 'arrived')").run();
  db.prepare("INSERT INTO doctor_bot_notifications (visit_id, referral_source_id, link_id, chat_id, text, viewed_at) VALUES (100, ?, ?, '800', 'x', strftime('%Y-%m-%dT%H:%M:%SZ','now'))").run(A, link);

  const s = doctorBotStats(db, {}, admin);
  assert.deepEqual(s, { doctors_active: 3, with_phone: 2, connected: 1, pending: 0, without_phone: 1, notifications_30d: 1, viewed_30d: 1 });
  const list = doctorBotLinksList(db, {}, admin);
  assert.equal(list.length, 1);
  assert.equal(list[0].source_name, 'А');
  assert.equal(list[0].tg_name, 'Доктор А');
  assert.equal(list[0].status, 'confirmed');
  assert.equal(list[0].notifications, 1);
  assert.ok(list[0].last_notified_at);

  assert.throws(() => doctorBotLinkRevoke(db, { id: 'x' }, admin), (e) => e.status === 400);
  assert.deepEqual(doctorBotLinkRevoke(db, { id: link }, admin), { id: link, revoked: true });
  assert.deepEqual(doctorBotLinkRevoke(db, { id: link }, admin), { id: link, revoked: false }, 'повторно — уже отозвана');
  assert.equal(doctorBotLinksList(db, {}, admin).length, 0);
  assert.equal(doctorBotStats(db, {}, admin).connected, 0);
});

// ---------------------------------------------------------------------------
// FIX_318_V1 — ревью 3.18.0 (бот для врачей-источников)
// ---------------------------------------------------------------------------
import { doctorBotLinkConfirm, doctorBotLinkReject } from './doctor-bot.js';
import { botConfig } from '../doctor-bot/index.js';
import { SAME_BOT_MESSAGE, botIdOfToken } from '../doctor-bot/settings.js';
import { encryptToken, loadOrCreateKey } from '../telegram/crypto.js';
import { setDataDir } from '../control/config.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';

// Ключ шифрования токенов — во временной папке данных: data/ клиники тесты не трогают.
function withDataDir(fn) {
  return async () => {
    setDataDir(tmpDir('em-docbot-'));
    try { await fn(); } finally { setDataDir(null); }
  };
}
const neverFetch = { fetchImpl: async () => { throw new Error('в сеть ходить не должны'); } };

test('M1: токен пациентского бота (getMe().id = telegram_settings.bot_id) — отказ понятным текстом, токен не сохранён, бот не включён', withDataDir(async () => {
  const db = fresh();
  db.prepare("UPDATE telegram_settings SET bot_id = '42' WHERE id = 1").run();   // пациентский бот — @clinic_doctors_bot с id 42 из okMe
  await assert.rejects(() => doctorBotSettingsSave(db, { bot_token: TOKEN }, admin, okMe),
    (e) => e instanceof RpcError && e.status === 400 && e.message === SAME_BOT_MESSAGE);
  const s = doctorBotSettingsGet(db, {}, admin);
  assert.deepEqual([s.has_token, s.enabled], [false, false], 'токен пациентского бота не остаётся в настройках бота для врачей');
}));

test('M1: тот же бот узнаётся по токену ещё до Telegram (номер бота — начало токена), даже если у пациентского бота нет bot_id', withDataDir(async () => {
  const db = fresh();
  assert.equal(botIdOfToken(TOKEN), '1234567890');
  db.prepare('UPDATE telegram_settings SET bot_token_enc = ?, bot_id = \'\' WHERE id = 1').run(encryptToken('1234567890:TESTONLY-patient-bot-token', loadOrCreateKey()));
  await assert.rejects(() => doctorBotSettingsSave(db, { bot_token: TOKEN }, admin, neverFetch), (e) => e.status === 400 && e.message === SAME_BOT_MESSAGE);
  assert.equal(doctorBotSettingsGet(db, {}, admin).has_token, false);
}));

test('M1: пациентский бот стал тем же ботом позже — проверка связи отказывает и выключает бот для врачей; поллер его не запускает', withDataDir(async () => {
  const db = fresh();
  await doctorBotSettingsSave(db, { bot_token: TOKEN }, admin, okMe);
  assert.equal(doctorBotSettingsGet(db, {}, admin).enabled, true);
  assert.ok(botConfig(db), 'свой бот — поллер работает');
  db.prepare("UPDATE telegram_settings SET bot_id = '1234567890' WHERE id = 1").run();
  assert.equal(botConfig(db), null, 'тот же бот, что пациентский, — поллер не запускается (два поллера одного токена отнимают друг у друга сообщения)');
  db.prepare("UPDATE telegram_settings SET bot_id = '42' WHERE id = 1").run();
  const t = await doctorBotTestConnection(db, {}, admin, okMe);
  assert.equal(t.ok, false);
  assert.equal(t.error, SAME_BOT_MESSAGE);
  assert.equal(t.settings.enabled, false, 'бот для врачей выключен');
}));

test('M2: ожидающие подключения — в списке со статусом и хвостом номера; подтвердить и отклонить может только администратор; подтверждённое считается подключённым', () => {
  const db = fresh();
  const src = db.prepare('INSERT INTO referral_sources (name, first_name, phone, active) VALUES (?,?,?,?)');
  const A = Number(src.run('Набиев Ойбек', 'Ойбек', '+998 90 310 65 70', 1).lastInsertRowid);
  const B = Number(src.run('Абдурахманова Дилара', 'Дилара', '998912098887', 1).lastInsertRowid);
  const ins = db.prepare("INSERT INTO doctor_bot_links (referral_source_id, chat_id, phone, tg_name) VALUES (?, ?, ?, ?)");
  const la = Number(ins.run(A, '800', '998903106570', 'Ойбек').lastInsertRowid);
  const lb = Number(ins.run(B, '801', '998912098887', 'Дилара').lastInsertRowid);
  const list = doctorBotLinksList(db, {}, admin);
  assert.deepEqual(list.map((l) => [l.source_name, l.status, l.phone_tail]).sort(), [['Абдурахманова Дилара', 'pending', '8887'], ['Набиев Ойбек', 'pending', '6570']]);
  assert.ok(list.every((l) => l.linked_at), 'дата заявки');
  assert.deepEqual(doctorBotStats(db, {}, admin).connected, 0);
  assert.deepEqual(doctorBotStats(db, {}, admin).pending, 2);

  assert.throws(() => doctorBotLinkConfirm(db, { id: la }, registrar), (e) => e.status === 403);
  assert.throws(() => doctorBotLinkReject(db, { id: lb }, registrar), (e) => e.status === 403);
  assert.throws(() => doctorBotLinkConfirm(db, { id: 'x' }, admin), (e) => e.status === 400);
  assert.deepEqual(doctorBotLinkConfirm(db, { id: la }, admin), { id: la, confirmed: true });
  const row = db.prepare('SELECT status, confirmed_by, confirmed_at FROM doctor_bot_links WHERE id = ?').get(la);
  assert.equal(row.status, 'confirmed');
  assert.equal(row.confirmed_by, 1);
  assert.ok(row.confirmed_at);
  assert.throws(() => doctorBotLinkConfirm(db, { id: la }, admin), (e) => e.status === 409, 'уже подтверждено');

  assert.deepEqual(doctorBotLinkReject(db, { id: lb }, admin), { id: lb, rejected: true });
  const rej = db.prepare('SELECT status, revoked_at, revoked_by FROM doctor_bot_links WHERE id = ?').get(lb);
  assert.equal(rej.status, 'rejected');
  assert.ok(rej.revoked_at);
  assert.equal(rej.revoked_by, 1);
  assert.throws(() => doctorBotLinkConfirm(db, { id: lb }, admin), (e) => e.status === 409, 'отклонённое не подтверждается');

  const s = doctorBotStats(db, {}, admin);
  assert.deepEqual([s.connected, s.pending], [1, 0]);
  for (const n of ['doctor_bot_link_confirm', 'doctor_bot_link_reject']) assert.equal(typeof getRpc(n), 'function', n);
});

test('M2: подтвердить нельзя, если врача выключили или номер в справочнике уже другой', () => {
  const db = fresh();
  db.prepare('DROP TRIGGER doctor_bot_links_source_changed').run();   // проверка самого подтверждения, без отзыва триггером
  const A = Number(db.prepare("INSERT INTO referral_sources (name, first_name, phone, active) VALUES ('А', 'А', '+998903106570', 1)").run().lastInsertRowid);
  const l = Number(db.prepare("INSERT INTO doctor_bot_links (referral_source_id, chat_id, phone) VALUES (?, '800', '998903106570')").run(A).lastInsertRowid);
  db.prepare("UPDATE referral_sources SET phone = '+998911111111' WHERE id = ?").run(A);
  assert.throws(() => doctorBotLinkConfirm(db, { id: l }, admin), (e) => e.status === 409);
  db.prepare("UPDATE referral_sources SET phone = '+998903106570', active = 0 WHERE id = ?").run(A);
  assert.throws(() => doctorBotLinkConfirm(db, { id: l }, admin), (e) => e.status === 409);
  assert.equal(db.prepare('SELECT status FROM doctor_bot_links WHERE id = ?').get(l).status, 'pending');
});
