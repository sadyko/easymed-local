// REP_BOT_V1 — RPC бота для медпредставителей: только администратор; три бота
// клиники не могут быть одним ботом; подтверждение — только живому представителю.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import {
  repBotSettingsGet, repBotSettingsSave, repBotStats, repBotLinksList, repBotAdditionsList,
  repBotLinkConfirm, repBotLinkReject, repBotLinkRevoke, RpcError,
} from './rep-bot.js';
import { SAME_AS_DOCTOR_MESSAGE } from '../rep-bot/settings.js';
import { doctorBotSettingsSave } from './doctor-bot.js';
import { SAME_AS_REP_BOT_MESSAGE } from '../doctor-bot/settings.js';
import { getRpc } from './index.js';

const TOKEN = '1234567890:AAEabcdefghijklmnopqrstuvwxyz0123456';
const OTHER = '9876543210:AAEabcdefghijklmnopqrstuvwxyz0123456';
function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  const ins = db.prepare('INSERT INTO users (id, username, password_hash, role, full_name, phone, custom_role_code) VALUES (?,?,?,?,?,?,?)');
  ins.run(1, 'adm', 'x', 'admin', 'Админ', '', null);
  ins.run(2, 'reg', 'x', 'registrar', 'Регистратор', '', null);
  ins.run(3, 'rep', 'x', 'callcenter', 'Юсупов Акмал', '+998903106570', 'medrep');
  return db;
}
const admin = { id: 1, role: 'admin' };
const registrar = { id: 2, role: 'registrar' };
const me = (id, username) => ({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, result: { id, username } }) }) });
const pendingLink = (db) => Number(db.prepare("INSERT INTO rep_bot_links (user_id, chat_id, phone) VALUES (3, '700', '998903106570')").run().lastInsertRowid);

test('только администратор; все RPC зарегистрированы', async () => {
  const db = fresh();
  for (const fn of [repBotSettingsGet, repBotStats, repBotLinksList, repBotAdditionsList]) {
    assert.throws(() => fn(db, {}, registrar), (e) => e instanceof RpcError && e.status === 403);
    fn(db, {}, admin);
  }
  await assert.rejects(() => repBotSettingsSave(db, { enabled: true }, registrar), (e) => e.status === 403);
  for (const n of ['rep_bot_settings_get', 'rep_bot_settings_save', 'rep_bot_token_clear', 'rep_bot_test_connection', 'rep_bot_stats',
    'rep_bot_links_list', 'rep_bot_additions_list', 'rep_bot_link_confirm', 'rep_bot_link_reject', 'rep_bot_link_revoke']) {
    assert.equal(typeof getRpc(n), 'function', n);
  }
});

test('токен сохраняется, проверяется и включает бота; наружу — только хвост', async () => {
  const db = fresh();
  const out = await repBotSettingsSave(db, { bot_token: TOKEN }, admin, me(1234567890, 'clinic_reps_bot'));
  assert.equal(out.enabled, true);
  assert.equal(out.auto_enabled, true);
  assert.equal(out.bot_username, 'clinic_reps_bot');
  assert.ok(!JSON.stringify(out).includes(TOKEN));
  assert.ok(!db.prepare('SELECT bot_token_enc FROM rep_bot_settings').get().bot_token_enc.includes(TOKEN), 'в базе — шифртекст');
});

test('бот представителей и бот врачей — разные боты, в обе стороны', async () => {
  const db = fresh();
  await doctorBotSettingsSave(db, { bot_token: TOKEN }, admin, me(1234567890, 'doctors_bot'));
  await assert.rejects(() => repBotSettingsSave(db, { bot_token: TOKEN }, admin),
    (e) => e.status === 400 && e.message === SAME_AS_DOCTOR_MESSAGE, 'узнаётся по токену ещё до Telegram');

  const db2 = fresh();
  await repBotSettingsSave(db2, { bot_token: OTHER }, admin, me(9876543210, 'reps_bot'));
  await assert.rejects(() => doctorBotSettingsSave(db2, { bot_token: OTHER }, admin),
    (e) => e.status === 400 && e.message === SAME_AS_REP_BOT_MESSAGE);
});

test('подтверждение: только ждущее и только живому представителю; отклонение и отключение', () => {
  const db = fresh();
  const id = pendingLink(db);
  assert.equal(repBotStats(db, {}, admin).pending, 1);
  assert.deepEqual(repBotLinkConfirm(db, { id }, admin), { id, confirmed: true });
  assert.throws(() => repBotLinkConfirm(db, { id }, admin), (e) => e.status === 409, 'второй раз — нет');
  assert.equal(repBotStats(db, {}, admin).connected, 1);
  assert.equal(repBotLinkRevoke(db, { id }, admin).revoked, true);
  assert.equal(repBotLinksList(db, {}, admin).length, 0);

  const id2 = pendingLink(db);
  db.prepare("UPDATE users SET custom_role_code = NULL WHERE id = 3").run();   // триггер отзывает…
  assert.throws(() => repBotLinkConfirm(db, { id: id2 }, admin), (e) => e.status === 409);

  db.prepare("UPDATE users SET custom_role_code = 'medrep' WHERE id = 3").run();
  const id3 = pendingLink(db);
  db.exec('DROP TRIGGER rep_bot_links_user_changed');
  db.prepare("UPDATE users SET phone = '+998911111111' WHERE id = 3").run();   // …а без триггера ловит сама проверка
  assert.throws(() => repBotLinkConfirm(db, { id: id3 }, admin), (e) => e.status === 409);

  db.prepare("UPDATE users SET phone = '+998903106570' WHERE id = 3").run();
  const id4 = pendingLink(db);
  assert.deepEqual(repBotLinkReject(db, { id: id4 }, admin), { id: id4, rejected: true });
  assert.equal(db.prepare('SELECT status FROM rep_bot_links WHERE id = ?').get(id4).status, 'rejected');
});
