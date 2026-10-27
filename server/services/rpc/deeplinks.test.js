// TG_DEEPLINK_V1 — RPC экрана «Ссылки для рекламы в Telegram».
//
// Правила — те же, что у rpc/telegram.js: раздел выдаётся окном «Telegram-бот»
// (settings.telegram), роль без настройки — только администратор (с учётом
// надстроечных ролей); ошибки проверки — 400/409/404, а не 500; все три
// имени стоят в реестре RPC.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { telegramDeeplinksList, telegramDeeplinkSave, telegramDeeplinkDelete, RpcError } from './deeplinks.js';
import { getRpc } from './index.js';

const fresh = () => {
  const db = openDb(':memory:');
  migrate(db);
  const ins = db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?,?,?,?)');
  ins.run(1, 'adm', 'x', 'admin');
  ins.run(2, 'docadm', 'x', 'doctor');
  ins.run(3, 'reg', 'x', 'registrar');
  return db;
};
const admin = { id: 1, role: 'admin' };
const doctorAdmin = { id: 2, role: 'doctor', extra_roles: ['admin'] };
const registrar = { id: 3, role: 'registrar' };
const PRICE = { key: 'price', name: 'Цена пакетов', lead_kind: 'callback', answer_ru: 'Роды — от 19 999 000 сум' };

test('реестр: три имени RPC', () => {
  for (const n of ['telegram_deeplinks_list', 'telegram_deeplink_save', 'telegram_deeplink_delete']) assert.equal(typeof getRpc(n), 'function', n);
});

test('список: имя бота и ссылки со счётчиками; без бота — bot_username пустой', () => {
  const db = fresh();
  const out = telegramDeeplinksList(db, {}, admin);
  assert.equal(out.bot_username, '');
  assert.deepEqual(out.links, []);
  assert.equal(out.lead_kinds.callback, 'Обратный звонок');
  db.prepare("UPDATE telegram_settings SET bot_username = 'clinic_bot', enabled = 1 WHERE id = 1").run();
  telegramDeeplinkSave(db, PRICE, admin);
  const again = telegramDeeplinksList(db, {}, admin);
  assert.equal(again.bot_username, 'clinic_bot');
  assert.equal(again.bot_enabled, true);
  assert.deepEqual(again.links.map((l) => [l.key, l.hits, l.leads, l.active]), [['price', 0, 0, true]]);
  db.close();
});

test('права: ненастроенная роль — только администратор (и врач-администратор); просмотр и изменение раздельно', () => {
  const db = fresh();
  assert.throws(() => telegramDeeplinksList(db, {}, registrar), (e) => e instanceof RpcError && e.status === 403);
  assert.throws(() => telegramDeeplinkSave(db, PRICE, registrar), (e) => e.status === 403);
  assert.ok(telegramDeeplinkSave(db, PRICE, doctorAdmin).id);
  // Роли выдан «Просмотр» окна «Telegram-бот»: список да, правка нет.
  db.prepare("INSERT INTO role_permissions (role, permissions) VALUES ('registrar', ?) ON CONFLICT(role) DO UPDATE SET permissions = excluded.permissions")
    .run(JSON.stringify({ sections: ['settings'], levels: { settings: 'viewer' }, grants: { 'settings.telegram': 'view' } }));
  assert.equal(telegramDeeplinksList(db, {}, registrar).links.length, 1);
  assert.throws(() => telegramDeeplinkSave(db, { ...PRICE, key: 'tour' }, registrar), (e) => e.status === 403);
  assert.throws(() => telegramDeeplinkDelete(db, { id: 1 }, registrar), (e) => e.status === 403);
  db.close();
});

test('ошибки проверки — 400/409/404 текстом, не 500', () => {
  const db = fresh();
  const saved = telegramDeeplinkSave(db, PRICE, admin);
  assert.throws(() => telegramDeeplinkSave(db, { ...PRICE, key: 'Цена' }, admin), (e) => e instanceof RpcError && e.status === 400 && /латиница/.test(e.message));
  assert.throws(() => telegramDeeplinkSave(db, { ...PRICE, key: 'PRICE' }, admin), (e) => e.status === 409);
  assert.throws(() => telegramDeeplinkSave(db, { ...PRICE, id: 999, key: 'x' }, admin), (e) => e.status === 404);
  assert.throws(() => telegramDeeplinkDelete(db, {}, admin), (e) => e.status === 400);
  assert.throws(() => telegramDeeplinkDelete(db, { id: 999 }, admin), (e) => e.status === 404);
  assert.deepEqual(telegramDeeplinkDelete(db, { id: saved.id }, admin), { ok: true });
  assert.deepEqual(telegramDeeplinksList(db, {}, admin).links, []);
  db.close();
});
