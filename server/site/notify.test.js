// WEBSITE_V1 (задача W3-5) — уведомление в Telegram о новой заявке с сайта.
//
// Тестируется сам notify.js напрямую: настройки бота/чата собираются вручную
// на in-memory базе, отправка подменяется через _setSender (см. комментарий
// в notify.js — почему не deps.fetchImpl, как у api.js/push.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { invalidateContentCache } from './content.js';
import { notifyNewRequest, _setSender } from './notify.js';
import { encryptToken, loadOrCreateKey } from '../services/telegram/crypto.js';

const ENC_TOKEN = encryptToken('5125777202:AAFeAwoH0y0S_cWGETLD1S_8qcXRxq7elf8', loadOrCreateKey());

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  invalidateContentCache();
  return db;
}

function setNotifySettings(db, chatId) {
  db.prepare('UPDATE website_settings SET settings = ? WHERE id = 1')
    .run(JSON.stringify({ notify: { telegram_chat_id: chatId } }));
  invalidateContentCache();
}

test.afterEach(() => _setSender(null)); // не дать стабу одного теста утечь в следующий

test('настроено (чат + включённый бот): один вызов, правильный chat_id, текст содержит имя и тип', async () => {
  const db = seed();
  db.prepare("UPDATE telegram_settings SET enabled = 1, bot_token_enc = ? WHERE id = 1").run(ENC_TOKEN);
  setNotifySettings(db, '-1001234567890');
  const calls = [];
  _setSender(async (token, chatId, text) => { calls.push({ token, chatId, text }); });

  await notifyNewRequest(db, { id: 42, type: 'appointment', full_name: 'Каримова Дилноза', phone: '+998901112233', preferred_date: '2026-09-10' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].chatId, '-1001234567890');
  assert.match(calls[0].text, /№42/);
  assert.match(calls[0].text, /Запись на приём/);
  assert.match(calls[0].text, /Каримова Дилноза/);
  assert.match(calls[0].text, /\+998901112233/);
  assert.match(calls[0].text, /Дата: 2026-09-10/);
  db.close();
});

test('без preferred_date строка "Дата:" не добавляется', async () => {
  const db = seed();
  db.prepare("UPDATE telegram_settings SET enabled = 1, bot_token_enc = ? WHERE id = 1").run(ENC_TOKEN);
  setNotifySettings(db, '123456');
  const calls = [];
  _setSender(async (token, chatId, text) => { calls.push(text); });

  await notifyNewRequest(db, { id: 1, type: 'callback', full_name: 'Тест', phone: '+998900000000' });

  assert.equal(calls.length, 1);
  assert.ok(!calls[0].includes('Дата:'));
  assert.match(calls[0], /Обратный звонок/);
  db.close();
});

test('contact получает свою метку типа', async () => {
  const db = seed();
  db.prepare("UPDATE telegram_settings SET enabled = 1, bot_token_enc = ? WHERE id = 1").run(ENC_TOKEN);
  setNotifySettings(db, '123456');
  const calls = [];
  _setSender(async (token, chatId, text) => { calls.push(text); });

  await notifyNewRequest(db, { id: 2, type: 'contact', full_name: 'Тест', phone: '+998900000000' });

  assert.match(calls[0], /Обратная связь/);
  db.close();
});

// Fix round 1 (code review): sendMessage() шлёт с parse_mode='HTML' по
// умолчанию — имя и телефон с формы сайта обязаны быть экранированы, иначе
// «&»/«<»/«>» в имени либо ломают разбор сущностей Telegram (сообщение молча
// не уйдёт), либо случайно попавший «<b>» отрисуется как разметка.
test('имя/телефон с HTML-значимыми символами уходят экранированными (& < >), текст не ломается', async () => {
  const db = seed();
  db.prepare("UPDATE telegram_settings SET enabled = 1, bot_token_enc = ? WHERE id = 1").run(ENC_TOKEN);
  setNotifySettings(db, '-1001234567890');
  const calls = [];
  _setSender(async (token, chatId, text) => { calls.push(text); });

  await notifyNewRequest(db, { id: 7, type: 'appointment', full_name: 'Fatima & Sons <Ltd>', phone: '+998<90>000&0000' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0], '🌐 Новая заявка с сайта №7\nТип: Запись на приём\nИмя: Fatima &amp; Sons &lt;Ltd&gt;\nТелефон: +998&lt;90&gt;000&amp;0000');
  assert.ok(!calls[0].includes('<Ltd>'), 'сырой тег в тексте не должен остаться неэкранированным');
  db.close();
});

test('chat_id не настроен (пусто) — отправки нет', async () => {
  const db = seed();
  db.prepare("UPDATE telegram_settings SET enabled = 1, bot_token_enc = ? WHERE id = 1").run(ENC_TOKEN);
  setNotifySettings(db, '');
  const calls = [];
  _setSender(async () => { calls.push(1); });

  await notifyNewRequest(db, { id: 3, type: 'appointment', full_name: 'Тест', phone: '+998900000000' });

  assert.equal(calls.length, 0);
  db.close();
});

test('chat_id не числовой — отправки нет', async () => {
  const db = seed();
  db.prepare("UPDATE telegram_settings SET enabled = 1, bot_token_enc = ? WHERE id = 1").run(ENC_TOKEN);
  setNotifySettings(db, 'DROP TABLE');
  const calls = [];
  _setSender(async () => { calls.push(1); });

  await notifyNewRequest(db, { id: 4, type: 'appointment', full_name: 'Тест', phone: '+998900000000' });

  assert.equal(calls.length, 0);
  db.close();
});

test('бот выключен — отправки нет, даже если чат настроен', async () => {
  const db = seed();
  db.prepare("UPDATE telegram_settings SET enabled = 0, bot_token_enc = ? WHERE id = 1").run(ENC_TOKEN);
  setNotifySettings(db, '-1001234567890');
  const calls = [];
  _setSender(async () => { calls.push(1); });

  await notifyNewRequest(db, { id: 5, type: 'appointment', full_name: 'Тест', phone: '+998900000000' });

  assert.equal(calls.length, 0);
  db.close();
});

test('падение отправителя не выбрасывается наружу — оно проглатывается', async () => {
  const db = seed();
  db.prepare("UPDATE telegram_settings SET enabled = 1, bot_token_enc = ? WHERE id = 1").run(ENC_TOKEN);
  setNotifySettings(db, '-1001234567890');
  _setSender(async () => { throw new Error('Telegram недоступен'); });

  await assert.doesNotReject(notifyNewRequest(db, { id: 6, type: 'appointment', full_name: 'Тест', phone: '+998900000000' }));
  db.close();
});
