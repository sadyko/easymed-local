// TG_DEEPLINK_V1 — ссылки для рекламы: разбор ключа и языка, сохранение и
// проверка, и сам бот от `/start <ключ>` до карточки в CRM — через handleUpdate,
// как в flow.test.js: человек без привязанного номера открывает бота по ссылке
// из рекламы, получает ответ на своём языке с файлом и кнопками, а кнопка
// «Оставить заявку» заводит карточку (сразу, если номер известен, иначе после
// «Поделиться номером»). Переходы и заявки считаются по ссылке.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { handleUpdate, activeLink } from './flow.js';
import { normalizeKey, parseStart, langOf, saveDeeplink, listDeeplinks, deleteDeeplink, answerFor, inlineKeyboardFor, DeeplinkError, LEAD_KINDS } from './deeplinks.js';

const TOKEN = 'x';
const ROOT = path.dirname(path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))));

function harness() {
  const sent = [];
  const deps = {
    fetchImpl: async (url, opts) => {
      const method = String(url).split('/').pop();
      let params = {};
      try { params = JSON.parse(opts.body); } catch { params = { multipart: true }; }
      sent.push({ method, params });
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) };
    },
  };
  return { sent, deps, texts: () => sent.filter((s) => s.method === 'sendMessage').map((s) => s.params.text) };
}
function seed() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (1,'boss','x','Админ','admin')").run();
  db.prepare("INSERT INTO patients (full_name, phone, mrn) VALUES ('Алиев Алишер', '+998 90 111 22 33', 'P-1')").run();
  return db;
}
const start = (chatId, param, lang = 'ru', fromId = chatId) => ({ message: { message_id: 7, chat: { id: chatId }, from: { id: fromId, first_name: 'Азиз', last_name: 'Каримов', username: 'aziz', language_code: lang }, text: param ? '/start ' + param : '/start' } });
const cb = (chatId, data) => ({ callback_query: { id: 'q1', data, message: { chat: { id: chatId } }, from: { id: chatId, first_name: 'Азиз', language_code: 'ru' } } });
const contactMsg = (chatId, phone, name = 'Азиз') => ({ message: { chat: { id: chatId }, from: { id: chatId, first_name: name, username: 'aziz', language_code: 'ru' }, contact: { phone_number: phone, user_id: chatId, first_name: name } } });
const PRICE = { key: 'Price', name: 'Цена пакетов', lead_kind: 'callback', answer_ru: 'Роды в La Tiva — от 19 999 000 сум', answer_uz: 'La Tiva tug‘ruq — 19 999 000 so‘mdan', answer_en: '' };

test('normalizeKey / parseStart / langOf', () => {
  assert.equal(normalizeKey(' Price '), 'price');
  assert.equal(normalizeKey('tour_2026-a'), 'tour_2026-a');
  assert.equal(normalizeKey('цена'), '');
  assert.equal(normalizeKey('a'.repeat(33)), '');
  assert.equal(normalizeKey('bad key'), '');
  assert.deepEqual(parseStart('/start price'), { isStart: true, param: 'price' });
  assert.deepEqual(parseStart('/start@clinic_bot Price'), { isStart: true, param: 'Price' });
  assert.deepEqual(parseStart('/start'), { isStart: true, param: '' });
  assert.deepEqual(parseStart('hello'), { isStart: false, param: '' });
  assert.equal(langOf('uz'), 'uz'); assert.equal(langOf('en-US'), 'en'); assert.equal(langOf('ru'), 'ru'); assert.equal(langOf(undefined), 'ru'); assert.equal(langOf('kk'), 'ru');
});

test('saveDeeplink: ключ приводится, проверяется и уникален; тип из словаря; кнопки проверяются; список со счётчиками; удаление', () => {
  const db = seed();
  const saved = saveDeeplink(db, PRICE, 1);
  assert.equal(saved.key, 'price', 'ключ строчными');
  assert.equal(saved.lead_kind_label, LEAD_KINDS.callback);
  assert.deepEqual(saved.buttons, []);
  assert.equal(saved.active, true);
  assert.throws(() => saveDeeplink(db, { ...PRICE, key: 'PRICE' }, 1), (e) => e instanceof DeeplinkError && e.status === 409, 'тот же ключ в другом регистре');
  assert.throws(() => saveDeeplink(db, { ...PRICE, key: 'цена' }, 1), (e) => e.status === 400);
  assert.throws(() => saveDeeplink(db, { ...PRICE, key: 'x', name: '' }, 1), (e) => e.status === 400, 'название обязательно');
  assert.throws(() => saveDeeplink(db, { ...PRICE, key: 'x', answer_ru: '' }, 1), (e) => e.status === 400, 'русский ответ обязателен');
  assert.throws(() => saveDeeplink(db, { ...PRICE, key: 'x', lead_kind: 'weird' }, 1), (e) => e.status === 400);
  assert.throws(() => saveDeeplink(db, { ...PRICE, key: 'x', buttons: [{ label: 'Сайт', action: 'url', target: 'ftp://x' }] }, 1), (e) => e.status === 400, 'адрес только http(s)');
  assert.throws(() => saveDeeplink(db, { ...PRICE, key: 'x', buttons: [{ label: 'Экскурсия', action: 'answer', target: 'nope' }] }, 1), (e) => e.status === 400, 'кнопка на несуществующий ответ');
  assert.throws(() => saveDeeplink(db, { ...PRICE, key: 'x', file_path: '../../easymed.db' }, 1), (e) => e.status === 400, 'файл только из корзины бота');
  const tour = saveDeeplink(db, { key: 'tour', name: 'Экскурсия', lead_kind: 'appointment', answer_ru: 'Приходите на экскурсию',
    buttons: [{ label: 'Цены', action: 'answer', target: 'PRICE' }, { label: 'Сайт', action: 'url', target: 'https://clinic.uz' }, { label: 'Записаться', action: 'lead' }],
    file_path: 'deeplinks/1/tour.png' }, 1);
  assert.deepEqual(tour.buttons, [{ label: 'Цены', action: 'answer', target: 'price' }, { label: 'Сайт', action: 'url', target: 'https://clinic.uz' }, { label: 'Записаться', action: 'lead', target: '' }]);
  assert.equal(tour.file_kind, 'photo');
  assert.equal(tour.file_name, 'tour.png');
  // Правка по id: ключ можно сменить, счётчики идут за id.
  const edited = saveDeeplink(db, { id: tour.id, key: 'tour2', name: 'Экскурсия', lead_kind: 'appointment', answer_ru: 'Приходите', active: false }, 1);
  assert.equal(edited.key, 'tour2');
  assert.equal(edited.active, false);
  const list = listDeeplinks(db);
  assert.deepEqual(list.map((l) => [l.key, l.hits, l.leads]), [['price', 0, 0], ['tour2', 0, 0]]);
  deleteDeeplink(db, tour.id);
  assert.deepEqual(listDeeplinks(db).map((l) => l.key), ['price']);
  assert.throws(() => deleteDeeplink(db, 999), (e) => e.status === 404);
  db.close();
});

test('answerFor — язык пользователя с откатом на русский; клавиатура — по умолчанию одна кнопка «Оставить заявку»', () => {
  const link = { key: 'price', answer_ru: 'ru', answer_uz: 'uz', answer_en: '', buttons: [] };
  assert.equal(answerFor(link, 'uz'), 'uz');
  assert.equal(answerFor(link, 'en'), 'ru', 'английского нет — русский');
  assert.equal(answerFor(link, 'ru'), 'ru');
  const kb = inlineKeyboardFor(link);
  assert.equal(kb.length, 1);
  assert.equal(kb[0][0].callback_data, 'dl:l:price');
  assert.match(kb[0][0].text, /Оставить заявку/);
  const kb2 = inlineKeyboardFor({ ...link, buttons: [{ label: 'Цены', action: 'answer', target: 'price' }, { label: 'Сайт', action: 'url', target: 'https://clinic.uz' }, { label: 'Записаться', action: 'lead' }] });
  assert.deepEqual(kb2, [[{ text: 'Цены', callback_data: 'dl:a:price' }], [{ text: 'Сайт', url: 'https://clinic.uz' }], [{ text: 'Записаться', callback_data: 'dl:l:price' }]]);
});

test('бот: /start <ключ> от непривязанного человека — переход записан, ответ на его языке с кнопкой; выключенная или чужая ссылка — обычное приветствие без перехода', async () => {
  const db = seed();
  saveDeeplink(db, PRICE, 1);
  const { sent, deps, texts } = harness();
  await handleUpdate(db, TOKEN, start(500, 'PRICE', 'uz'), deps);
  assert.equal(texts().at(-1), PRICE.answer_uz, 'узбекский ответ узбекоязычному');
  assert.equal(sent.at(-1).params.reply_markup.inline_keyboard[0][0].callback_data, 'dl:l:price');
  await handleUpdate(db, TOKEN, start(501, 'price', 'en'), deps);
  assert.equal(texts().at(-1), PRICE.answer_ru, 'английского нет — русский');
  const hits = db.prepare('SELECT chat_id, lang FROM telegram_deeplink_hits ORDER BY id').all();
  assert.deepEqual(hits.map((h) => [h.chat_id, h.lang]), [['500', 'uz'], ['501', 'en']]);
  assert.equal(listDeeplinks(db)[0].hits, 2);
  assert.equal(listDeeplinks(db)[0].unique_hits, 2);
  // Чужой ключ — приветствие с кнопкой контакта; переходов не прибавилось.
  await handleUpdate(db, TOKEN, start(502, 'nope', 'ru'), deps);
  assert.ok(sent.at(-1).params.reply_markup.keyboard, 'обычное приветствие с клавиатурой контакта');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM telegram_deeplink_hits').get().n, 2);
  // Выключенная ссылка — как чужая.
  db.prepare("UPDATE telegram_deeplinks SET active = 0 WHERE key = 'price'").run();
  await handleUpdate(db, TOKEN, start(503, 'price', 'ru'), deps);
  assert.ok(sent.at(-1).params.reply_markup.keyboard);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM telegram_deeplink_hits').get().n, 2);
  db.close();
});

test('бот: файл к ответу — картинка уходит фото, PDF — документом, ПЕРЕД текстом с кнопками (кнопки под последним сообщением); пропавший файл не ломает ответ', async () => {
  const db = seed();
  const dir = path.join(ROOT, 'data', 'storage', 'telegram-media', 'deeplinks', 'test-' + process.pid);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'ward.jpg'), 'jpegbytes');
  fs.writeFileSync(path.join(dir, 'price.pdf'), '%PDF-1.4');
  const rel = (f) => `deeplinks/test-${process.pid}/${f}`;
  try {
    saveDeeplink(db, { ...PRICE, key: 'ward', file_path: rel('ward.jpg') }, 1);
    saveDeeplink(db, { ...PRICE, key: 'pdf', file_path: rel('price.pdf') }, 1);
    saveDeeplink(db, { ...PRICE, key: 'gone', file_path: rel('missing.pdf') }, 1);
    const { sent, deps } = harness();
    await handleUpdate(db, TOKEN, start(600, 'ward'), deps);
    assert.deepEqual(sent.slice(-2).map((s) => s.method), ['sendPhoto', 'sendMessage']);
    assert.ok(sent.at(-1).params.reply_markup.inline_keyboard, 'кнопки — под текстом, последним сообщением');
    await handleUpdate(db, TOKEN, start(601, 'pdf'), deps);
    assert.deepEqual(sent.slice(-2).map((s) => s.method), ['sendDocument', 'sendMessage']);
    const before = sent.length;
    await handleUpdate(db, TOKEN, start(602, 'gone'), deps);
    assert.deepEqual(sent.slice(before).map((s) => s.method), ['sendMessage'], 'файла нет на диске — ответ ушёл без него');
    assert.equal(sent.at(-1).params.text, PRICE.answer_ru);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    db.close();
  }
});

test('бот: кнопка «показать другой ответ» — ответ другой ссылки без нового перехода; кнопка-адрес — url', async () => {
  const db = seed();
  saveDeeplink(db, PRICE, 1);
  saveDeeplink(db, { key: 'tour', name: 'Экскурсия', lead_kind: 'appointment', answer_ru: 'Приходите на экскурсию', buttons: [{ label: 'Цены', action: 'answer', target: 'price' }, { label: 'Сайт', action: 'url', target: 'https://clinic.uz' }] }, 1);
  const { sent, deps, texts } = harness();
  await handleUpdate(db, TOKEN, start(700, 'tour'), deps);
  assert.deepEqual(sent.at(-1).params.reply_markup.inline_keyboard[1][0], { text: 'Сайт', url: 'https://clinic.uz' });
  await handleUpdate(db, TOKEN, cb(700, 'dl:a:price'), deps);
  assert.equal(texts().at(-1), PRICE.answer_ru);
  assert.deepEqual(listDeeplinks(db).map((l) => [l.key, l.hits]), [['price', 0], ['tour', 1]], 'навигация внутри воронки переходом не считается');
  db.close();
});

test('бот: «Оставить заявку» без номера — просит номер, после контакта заводит карточку CRM с источником Telegram и комментарием о ссылке; спасибо вместо «никого не нашли»', async () => {
  const db = seed();
  saveDeeplink(db, PRICE, 1);
  const { sent, deps, texts } = harness();
  await handleUpdate(db, TOKEN, start(800, 'price'), deps);
  await handleUpdate(db, TOKEN, cb(800, 'dl:l:price'), deps);
  assert.ok(sent.at(-1).params.reply_markup.keyboard[0][0].request_contact, 'просим номер кнопкой «Поделиться номером»');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM crm_requests').get().n, 0, 'карточки ещё нет');
  await handleUpdate(db, TOKEN, contactMsg(800, '+998 90 777 66 55'), deps);
  const cards = db.prepare('SELECT full_name, phone, source, sources, note, status FROM crm_requests').all();
  assert.equal(cards.length, 1);
  assert.equal(cards[0].full_name, 'Азиз');
  assert.equal(cards[0].phone, '+998907776655');
  assert.equal(cards[0].source, 'telegram');
  assert.deepEqual(JSON.parse(cards[0].sources), ['telegram']);
  assert.match(cards[0].note, /Цена пакетов/);
  assert.match(cards[0].note, /price/);
  assert.match(cards[0].note, /Обратный звонок/);
  assert.match(texts().at(-1), /Rahmat|Спасибо/, 'благодарность, а не «никого не нашли»');
  assert.ok(!texts().join('\n').includes('никого не нашли'));
  assert.ok(activeLink(db, 800), 'номер привязан к чату — переписка дальше работает');
  const leads = db.prepare('SELECT deeplink_id, crm_request_id, chat_id FROM telegram_deeplink_leads').all();
  assert.equal(leads.length, 1);
  assert.equal(leads[0].chat_id, '800');
  assert.equal(listDeeplinks(db)[0].leads, 1);
  db.close();
});

test('бот: «Оставить заявку» у привязанного номера — карточка сразу; повтор в окне CRM — та же карточка, но заявка посчитана', async () => {
  const db = seed();
  saveDeeplink(db, PRICE, 1);
  const { deps, texts } = harness();
  await handleUpdate(db, TOKEN, contactMsg(900, '+998 90 111 22 33'), deps);   // привязка как у пациента
  await handleUpdate(db, TOKEN, start(900, 'price'), deps);
  await handleUpdate(db, TOKEN, cb(900, 'dl:l:price'), deps);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM crm_requests').get().n, 1);
  assert.match(texts().at(-1), /Rahmat|Спасибо/);
  await handleUpdate(db, TOKEN, cb(900, 'dl:l:price'), deps);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM crm_requests').get().n, 1, 'вторая карточка не плодится');
  assert.equal(listDeeplinks(db)[0].leads, 2, 'а заявок по ссылке — две');
  const card = db.prepare('SELECT note FROM crm_requests').get();
  assert.equal(card.note.split('Заявка из Telegram').length - 1, 2, 'вторая заявка дописана в комментарий');
  db.close();
});
