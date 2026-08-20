// TELEGRAM_CHAT_V1 — переписка с пациентами и права на неё.
//
// Ключевое различие, которое здесь закрепляется: ЧИТАТЬ переписку и ПИСАТЬ в
// неё от имени клиники — разные права. Роль с уровнем «Просмотр» видит, что
// написал пациент, но ответить не может.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { listChats, chatMessages, markRead, unreadTotal } from './chat.js';
import { logMessage, handleUpdate } from './flow.js';
import { telegramChatsList, telegramChatMessages, telegramChatSend,
         telegramFolderSave, telegramFolderSetChat } from '../rpc/telegram.js';
import { sectionLevel, canEditSection } from '../roles.js';
import { encryptToken, loadOrCreateKey } from './crypto.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Токен в настройках должен быть НАСТОЯЩИМ шифротекстом: иначе проверки
// падают на расшифровке и тест перестаёт проверять то, ради чего написан.
process.env.EASYMED_TELEGRAM_KEY_PATH =
  path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'em-tg-chat-')), '.telegram-key');
const ENC_TOKEN = encryptToken('1000000001:TESTONLYtestonlyTESTONLYtestonly123', loadOrCreateKey());

const viewerUser = { id: 5, role: 'lab' };
const editorUser = { id: 6, role: 'callcenter', full_name: 'Оператор Оксана' };
const adminUser  = { id: 1, role: 'admin', full_name: 'Админ' };

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, full_name, role) VALUES (?,?,?,?,?)');
  u.run(1, 'boss', 'x', 'Админ', 'admin');
  u.run(5, 'lab1', 'x', 'Лаборант', 'lab');
  u.run(6, 'op', 'x', 'Оператор Оксана', 'callcenter');

  db.prepare("INSERT INTO patients (full_name, phone, mrn) VALUES ('Алиев А.','+998 90 111 22 33','P-1')").run();
  db.prepare("INSERT INTO telegram_links (chat_id, phone, tg_name, tg_username, tg_user_id) VALUES ('100','998901112233','Алишер','alisher','555')").run();
  db.prepare('UPDATE telegram_settings SET enabled=1, bot_token_enc=? WHERE id=1').run(ENC_TOKEN);
  return db;
}

const fakeSend = () => ({
  fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 9 } }) }),
});

test('миграция выдаёт раздел администратору и call-центру, но не лаборанту', () => {
  const db = seed();
  assert.equal(sectionLevel(db, adminUser, 'telegram-chat'), 'admin');
  assert.equal(sectionLevel(db, editorUser, 'telegram-chat'), 'editor');
  assert.equal(sectionLevel(db, viewerUser, 'telegram-chat'), null, 'лаборанту раздел не выдан');
  db.close();
});

test('уровень «Просмотр» читает переписку, но отвечать не может', async () => {
  const db = seed();
  // Выдаём лаборанту раздел только на чтение — так это сделает администратор
  // в «Настройки → Роли».
  db.prepare(`UPDATE role_permissions SET permissions =
      json_set(json_insert(permissions,'$.sections[#]','telegram-chat'),'$.levels.telegram-chat','viewer')
      WHERE role='lab'`).run();

  assert.equal(sectionLevel(db, viewerUser, 'telegram-chat'), 'viewer');
  assert.equal(canEditSection(db, viewerUser, 'telegram-chat'), false);

  logMessage(db, '100', 'in', 'Когда будут анализы?');
  assert.equal(telegramChatsList(db, {}, viewerUser).chats.length, 1, 'читать может');

  await assert.rejects(
    () => telegramChatSend(db, { chat_id: '100', text: 'Завтра' }, viewerUser, fakeSend()),
    (e) => e.status === 403 && /только чтение/.test(e.message));
  db.close();
});

test('роль без раздела не видит переписку вовсе', async () => {
  const db = seed();
  assert.throws(() => telegramChatsList(db, {}, viewerUser), (e) => e.status === 403);
  assert.throws(() => telegramChatMessages(db, { chat_id: '100' }, viewerUser), (e) => e.status === 403);
  await assert.rejects(() => telegramChatSend(db, { chat_id: '100', text: 'привет' }, viewerUser, fakeSend()),
    (e) => e.status === 403);
  db.close();
});

test('call-центр отвечает пациенту, и ответ подписан сотрудником', async () => {
  const db = seed();
  logMessage(db, '100', 'in', 'Здравствуйте');

  await telegramChatSend(db, { chat_id: '100', text: 'Результат готов' }, editorUser, fakeSend());

  const msgs = chatMessages(db, '100').messages;
  const out = msgs.find((m) => m.direction === 'out');
  assert.match(out.text, /Результат готов/);
  // Пациент должен понимать, что отвечает живой человек, а не автомат.
  assert.match(out.text, /Оператор Оксана/);
  assert.equal(out.sent_by, 6);
  assert.equal(out.author, 'Оператор Оксана');
  db.close();
});

test('входящее сообщение пациента сохраняется целиком', async () => {
  const db = seed();
  const deps = { fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, result: {} }) }) };

  await handleUpdate(db, 'tok', {
    message: { chat: { id: 100 }, from: { id: 555 }, message_id: 7, text: 'Когда будет готов анализ?' },
  }, deps);

  const msgs = chatMessages(db, '100').messages;
  const incoming = msgs.find((m) => m.direction === 'in');
  assert.ok(incoming, 'вопрос пациента не должен пропадать');
  assert.equal(incoming.text, 'Когда будет готов анализ?');
  // И ответ бота лёг туда же — сотрудник видит весь разговор, а не половину.
  assert.ok(msgs.some((m) => m.direction === 'out' && m.kind === 'system'));
  db.close();
});

test('непрочитанные считаются и гаснут при открытии чата', () => {
  const db = seed();
  logMessage(db, '100', 'in', 'раз');
  logMessage(db, '100', 'in', 'два');
  logMessage(db, '100', 'out', 'ответ');

  assert.equal(unreadTotal(db), 2, 'исходящие непрочитанными не считаются');
  assert.equal(listChats(db)[0].unread, 2);

  telegramChatMessages(db, { chat_id: '100' }, adminUser);   // открыли чат
  assert.equal(unreadTotal(db), 0);
  db.close();
});

test('список чатов показывает Telegram-ID, карты пациента и последнее сообщение', () => {
  const db = seed();
  logMessage(db, '100', 'in', 'Последний вопрос');

  const c = listChats(db)[0];
  assert.equal(c.tg_user_id, '555');
  assert.equal(c.tg_name, 'Алишер');
  assert.equal(c.tg_username, 'alisher');
  assert.deepEqual(c.patients.map((p) => p.name), ['Алиев А.']);
  assert.equal(c.last_text, 'Последний вопрос');
  assert.equal(c.last_direction, 'in');
  db.close();
});

test('в отвязанный чат написать нельзя', async () => {
  const db = seed();
  db.prepare("UPDATE telegram_links SET revoked_at='2026-08-01T00:00:00Z' WHERE chat_id='100'").run();
  await assert.rejects(
    () => telegramChatSend(db, { chat_id: '100', text: 'привет' }, adminUser, fakeSend()), /отвязан/);
  db.close();
});

test('заблокировавшему бота не пишем — сообщение всё равно не дойдёт', async () => {
  const db = seed();
  db.prepare("UPDATE telegram_links SET blocked_at='2026-08-01T00:00:00Z' WHERE chat_id='100'").run();
  await assert.rejects(
    () => telegramChatSend(db, { chat_id: '100', text: 'привет' }, adminUser, fakeSend()), /заблокировал/);
  db.close();
});

test('пустой ответ не отправляется', async () => {
  const db = seed();
  await assert.rejects(() => telegramChatSend(db, { chat_id: '100', text: '   ' }, adminUser, fakeSend()), /Пустое/);
  db.close();
});

test('выключенный бот не даёт отвечать', async () => {
  const db = seed();
  db.prepare('UPDATE telegram_settings SET enabled=0 WHERE id=1').run();
  await assert.rejects(
    () => telegramChatSend(db, { chat_id: '100', text: 'привет' }, adminUser, fakeSend()), /выключен/);
  db.close();
});

// ---------------------------------------------------------------------------
// TELEGRAM_CHAT_FOLDERS_V1 — папки чатов
// ---------------------------------------------------------------------------

test('папку заводит тот, кто ведёт переписку; читатель — нет', () => {
  const db = seed();
  db.prepare(`UPDATE role_permissions SET permissions =
      json_set(json_insert(permissions,'$.sections[#]','telegram-chat'),'$.levels.telegram-chat','viewer')
      WHERE role='lab'`).run();

  // Папки общие для клиники: перекладывать чужие чаты — это изменение общего
  // рабочего пространства, а не личная заметка.
  assert.throws(() => telegramFolderSave(db, { name: 'Долги' }, viewerUser), (e) => e.status === 403);
  const res = telegramFolderSave(db, { name: 'Долги' }, editorUser);
  assert.deepEqual(res.folders.map((f) => f.name), ['Долги']);
  db.close();
});

test('чат лежит в нескольких папках сразу и виден в каждой', () => {
  const db = seed();
  const a = telegramFolderSave(db, { name: 'Долги' }, adminUser).folders[0];
  const b = telegramFolderSave(db, { name: 'VIP' }, adminUser).folders.find((f) => f.name === 'VIP');

  telegramFolderSetChat(db, { folder_id: a.id, chat_id: '100', member: true }, adminUser);
  const after = telegramFolderSetChat(db, { folder_id: b.id, chat_id: '100', member: true }, adminUser);

  const chat = after.chats.find((c) => c.chat_id === '100');
  assert.deepEqual(chat.folders.sort(), [a.id, b.id].sort());
  assert.equal(after.folders.find((f) => f.id === a.id).count, 1);
  db.close();
});

test('чат убирается из папки, не пропадая из списка', () => {
  const db = seed();
  const f = telegramFolderSave(db, { name: 'Долги' }, adminUser).folders[0];
  telegramFolderSetChat(db, { folder_id: f.id, chat_id: '100', member: true }, adminUser);

  const after = telegramFolderSetChat(db, { folder_id: f.id, chat_id: '100', member: false }, adminUser);
  assert.deepEqual(after.chats.find((c) => c.chat_id === '100').folders, []);
  assert.equal(after.chats.length, 1, 'сам чат никуда не делся — папка это ярлык');
  db.close();
});

test('удаление папки не трогает чаты', () => {
  const db = seed();
  const f = telegramFolderSave(db, { name: 'Долги' }, adminUser).folders[0];
  telegramFolderSetChat(db, { folder_id: f.id, chat_id: '100', member: true }, adminUser);

  const after = telegramFolderSave(db, { delete_id: f.id }, adminUser);
  assert.deepEqual(after.folders, []);
  assert.equal(telegramChatsList(db, {}, adminUser).chats.length, 1, 'пациент остался на месте');
  db.close();
});

test('две папки с одинаковым названием не заводятся', () => {
  const db = seed();
  telegramFolderSave(db, { name: 'Долги' }, adminUser);
  assert.throws(() => telegramFolderSave(db, { name: 'Долги' }, adminUser), /уже есть/);
  assert.throws(() => telegramFolderSave(db, { name: '   ' }, adminUser), /пустым/);
  db.close();
});

test('список чатов отдаёт папки вместе с чатами — одним запросом', () => {
  const db = seed();
  const f = telegramFolderSave(db, { name: 'Долги' }, adminUser).folders[0];
  telegramFolderSetChat(db, { folder_id: f.id, chat_id: '100', member: true }, adminUser);

  const res = telegramChatsList(db, {}, adminUser);
  assert.deepEqual(res.folders.map((x) => x.name), ['Долги']);
  assert.deepEqual(res.chats[0].folders, [f.id]);
  db.close();
});

test('в несуществующую папку чат не положить', () => {
  const db = seed();
  assert.throws(() => telegramFolderSetChat(db, { folder_id: 999, chat_id: '100', member: true }, adminUser),
    /не найдена/);
  db.close();
});
