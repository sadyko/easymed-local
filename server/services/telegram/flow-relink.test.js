// TELEGRAM_RELINK_V1 — повторная отправка номера не должна ломать бота.
//
// Живой случай: пациент уже подключён, снова жмёт «Поделиться номером» — и бот
// молчит. Совсем. handleContact делал безусловный INSERT в telegram_links, а
// миграция 060 держит там частичный уникальный индекс
// (chat_id WHERE revoked_at IS NULL): активная связка у чата ровно одна.
// Второй контакт ронял вставку с UNIQUE constraint failed ДО первой отправки —
// поэтому пациент не получал ни ответа, ни подсказки.
//
// А молчание было полным ещё и потому, что у контакта нет поля text: в
// telegram_messages не появлялось даже входящей строки, и в «Чате с пациентами»
// эта попытка не оставляла следа. Ошибка уходила в лог сервера, offset уже был
// сдвинут — обновление просто исчезало.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { handleUpdate } from './flow.js';

const TOKEN = 'T';
const PHONE = '+998 33 322 22 88';
const OTHER = '+998 90 555 44 33';

function harness() {
  const sent = [];
  const deps = {
    fetchImpl: async (url, opts) => {
      const method = String(url).split('/').pop();
      let params = {};
      try { params = JSON.parse(opts.body); } catch { params = { multipart: true }; }
      sent.push({ method, params });
      return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) };
    },
  };
  return { sent, deps, texts: () => sent.filter((s) => s.method === 'sendMessage').map((s) => s.params.text) };
}

function seed() {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO patients (full_name, phone, mrn) VALUES (?,?,?)").run('Содиқ Абуд', PHONE, 'P-26-69932');
  return db;
}

const contact = (chatId, phone) => ({
  message: {
    chat: { id: chatId }, from: { id: chatId, first_name: 'Sodiq', username: 'sadykmd' },
    contact: { phone_number: phone, user_id: chatId, first_name: 'Sodiq' },
  },
});
const activeLinks = (db, chatId) =>
  db.prepare('SELECT * FROM telegram_links WHERE chat_id = ? AND revoked_at IS NULL').all(String(chatId));

test('повторная отправка того же номера НЕ роняет бота и снова отвечает', async () => {
  const db = seed();
  const h1 = harness();
  await handleUpdate(db, TOKEN, contact(393046012, PHONE), h1.deps);
  assert.ok(h1.sent.length > 0, 'первый раз бот отвечает');

  const h2 = harness();
  await handleUpdate(db, TOKEN, contact(393046012, PHONE), h2.deps);
  assert.ok(h2.sent.length > 0, 'и второй раз тоже — иначе пациент видит молчание');
  db.close();
});

test('активная связка у чата остаётся ровно одна', async () => {
  const db = seed();
  for (let i = 0; i < 3; i++) {
    const h = harness();
    await handleUpdate(db, TOKEN, contact(393046012, PHONE), h.deps);
  }
  assert.equal(activeLinks(db, 393046012).length, 1, 'связки не плодятся');
  db.close();
});

test('повторная отправка обновляет отметку последнего визита и ник', async () => {
  const db = seed();
  await handleUpdate(db, TOKEN, contact(393046012, PHONE), harness().deps);
  db.prepare("UPDATE telegram_links SET last_seen_at = '2020-01-01T00:00:00Z', tg_username = 'old' WHERE chat_id = '393046012'").run();

  await handleUpdate(db, TOKEN, contact(393046012, PHONE), harness().deps);
  const l = activeLinks(db, 393046012)[0];
  assert.notEqual(l.last_seen_at, '2020-01-01T00:00:00Z', 'отметка обновилась');
  assert.equal(l.tg_username, 'sadykmd', 'ник перезаписан свежим');
  db.close();
});

test('другой номер в том же чате: старая связка отзывается, новая работает', async () => {
  const db = seed();
  await handleUpdate(db, TOKEN, contact(393046012, PHONE), harness().deps);

  const h = harness();
  await handleUpdate(db, TOKEN, contact(393046012, OTHER), h.deps);
  assert.ok(h.sent.length > 0, 'бот ответил на смену номера');

  const active = activeLinks(db, 393046012);
  assert.equal(active.length, 1, 'активная по-прежнему одна');
  assert.equal(active[0].phone, '998905554433', 'и это НОВЫЙ номер');

  const revoked = db.prepare("SELECT * FROM telegram_links WHERE chat_id = ? AND revoked_at IS NOT NULL").all('393046012');
  assert.equal(revoked.length, 1, 'прежняя связка отозвана, а не удалена — история сохраняется');
  assert.equal(revoked[0].phone, '998333222288');
  db.close();
});

test('чужой контакт по-прежнему отвергается и связку не создаёт', async () => {
  const db = seed();
  const h = harness();
  await handleUpdate(db, TOKEN, {
    message: {
      chat: { id: 393046012 }, from: { id: 393046012, first_name: 'Sodiq' },
      contact: { phone_number: PHONE, user_id: 999999, first_name: 'Сосед' },   // чужой user_id
    },
  }, h.deps);
  assert.equal(activeLinks(db, 393046012).length, 0, 'связка не создана');
  assert.ok(h.texts().join(' ').length > 0, 'но пациенту объяснили, почему');
  db.close();
});
