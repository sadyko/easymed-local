// TELEGRAM_BOT_V1 — сценарий бота.
//
// Основной груз этих тестов — подмена контакта. Пациент опознаётся по номеру
// телефона, значит вся приватность держится на одной проверке: номер прислал
// САМ владелец, а не переслал чужую карточку. Остальное — про то, что кнопка,
// пришедшая снаружи, не может достать чужой документ.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { handleUpdate, activeLink } from './flow.js';

const TOKEN = 'x';
const PHONE_A = '+998 90 111 22 33';
const PHONE_B = '+998 91 444 55 66';

// Ловушка вместо сети: собираем всё, что бот попытался отправить.
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
  const db = openDb(':memory:');
  migrate(db);
  const pat = db.prepare("INSERT INTO patients (full_name, phone, mrn) VALUES (?,?,?)");
  const a = pat.run('Алиев Алишер', PHONE_A, 'P-1').lastInsertRowid;
  const b = pat.run('Алиева Нигора', PHONE_A, 'P-2').lastInsertRowid;   // тот же номер — семья
  const c = pat.run('Каримов Пулат', PHONE_B, 'P-3').lastInsertRowid;
  return { db, a, b, c };
}

const contactMsg = (chatId, fromId, contactUserId, phone) => ({
  message: {
    chat: { id: chatId }, from: { id: fromId, first_name: 'Алишер' },
    contact: { phone_number: phone, user_id: contactUserId, first_name: 'Алишер' },
  },
});

test('переслать ЧУЖУЮ карточку контакта нельзя', async () => {
  const { db } = seed();
  const { deps, texts } = harness();

  // Классическая атака: у отправителя id 500, а он шлёт сохранённый контакт
  // владельца номера (id 999). Без проверки он получил бы чужую медкарту.
  await handleUpdate(db, TOKEN, contactMsg(500, 500, 999, PHONE_A), deps);

  assert.equal(activeLink(db, 500), undefined, 'связка НЕ должна появиться');
  assert.match(texts().join('\n'), /O‘Z raqamingizni|СВОЙ номер/);
  db.close();
});

test('контакт без user_id (введённый руками) тоже отвергается', async () => {
  const { db } = seed();
  const { deps } = harness();
  await handleUpdate(db, TOKEN, contactMsg(501, 501, undefined, PHONE_A), deps);
  assert.equal(activeLink(db, 501), undefined);
  db.close();
});

test('свой подтверждённый номер связывает чат и показывает семью', async () => {
  const { db } = seed();
  const { sent, deps } = harness();

  await handleUpdate(db, TOKEN, contactMsg(600, 600, 600, PHONE_A), deps);

  const link = activeLink(db, 600);
  assert.ok(link, 'связка создана');
  assert.equal(link.phone, '998901112233', 'номер сохраняется цифрами');

  // На номере двое — бот обязан спросить, чьи документы показать.
  const kb = sent.at(-1).params.reply_markup.inline_keyboard;
  assert.equal(kb.length, 2, 'оба пациента с этого номера');
  assert.match(sent.at(-1).params.text, /несколько человек/);
  db.close();
});

test('чужой пациент недоступен, даже если подделать кнопку', async () => {
  const { db, c } = seed();
  const { deps, texts } = harness();
  await handleUpdate(db, TOKEN, contactMsg(700, 700, 700, PHONE_A), deps);

  // Пациент c записан на ДРУГОЙ номер. callback_data приходит снаружи, и
  // ничто не мешает пациенту подставить чужой id — проверка идёт по телефону
  // связки, а не по тому, что прислала кнопка.
  await handleUpdate(db, TOKEN, {
    callback_query: { id: '1', data: 'p:' + c, message: { chat: { id: 700 } } },
  }, deps);

  assert.match(texts().at(-1), /никого не нашли/);
  db.close();
});

test('без связки любое сообщение приводит к просьбе подтвердить номер', async () => {
  const { db } = seed();
  const { sent, deps } = harness();
  await handleUpdate(db, TOKEN, { message: { chat: { id: 800 }, from: { id: 800 }, text: '/start' } }, deps);
  assert.match(sent.at(-1).params.text, /telefon raqamingizni|номер телефона/i);
  assert.ok(sent.at(-1).params.reply_markup.keyboard[0][0].request_contact, 'кнопка запроса контакта');
  db.close();
});

test('отозванная администратором связка перестаёт работать', async () => {
  const { db } = seed();
  const { deps, texts } = harness();
  await handleUpdate(db, TOKEN, contactMsg(900, 900, 900, PHONE_A), deps);
  assert.ok(activeLink(db, 900));

  db.prepare("UPDATE telegram_links SET revoked_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE chat_id='900'").run();
  assert.equal(activeLink(db, 900), undefined);

  await handleUpdate(db, TOKEN, { message: { chat: { id: 900 }, from: { id: 900 }, text: 'привет' } }, deps);
  assert.match(texts().at(-1), /telefon raqamingizni|номер телефона/i, 'снова просят подтвердить номер');
  db.close();
});

test('после отзыва пациент может связаться заново', async () => {
  const { db } = seed();
  const { deps } = harness();
  await handleUpdate(db, TOKEN, contactMsg(950, 950, 950, PHONE_A), deps);
  db.prepare("UPDATE telegram_links SET revoked_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE chat_id='950'").run();
  await handleUpdate(db, TOKEN, contactMsg(950, 950, 950, PHONE_A), deps);
  assert.ok(activeLink(db, 950), 'частичный уникальный индекс не должен мешать переподключению');
  db.close();
});

test('один пациент на номере — сразу список документов, без лишнего выбора', async () => {
  const { db } = seed();
  const { sent, deps } = harness();
  await handleUpdate(db, TOKEN, contactMsg(1000, 1000, 1000, PHONE_B), deps);
  // У Каримова документов нет — но и вопроса «чьи показать» быть не должно.
  assert.doesNotMatch(sent.at(-1).params.text, /несколько человек/);
  db.close();
});
