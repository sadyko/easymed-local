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

// FIX_318_V1 (L1) — повтор нажатия той же ссылки тем же чатом в течение суток —
// та же заявка: ни второй строки статистики рекламы, ни второго абзаца в
// комментарии. Через сутки — новая заявка (в окне CRM — в ту же карточку).
test('бот: «Оставить заявку» у привязанного номера — карточка сразу; повтор в течение суток — та же заявка; через сутки — новая заявка в ту же карточку', async () => {
  const db = seed();
  saveDeeplink(db, PRICE, 1);
  const { deps, texts } = harness();
  await handleUpdate(db, TOKEN, contactMsg(900, '+998 90 111 22 33'), deps);   // привязка как у пациента
  await handleUpdate(db, TOKEN, start(900, 'price'), deps);
  await handleUpdate(db, TOKEN, cb(900, 'dl:l:price'), deps);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM crm_requests').get().n, 1);
  assert.match(texts().at(-1), /Rahmat|Спасибо/);
  await handleUpdate(db, TOKEN, cb(900, 'dl:l:price'), deps);
  assert.match(texts().at(-1), /Rahmat|Спасибо/, 'человеку — то же спасибо');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM crm_requests').get().n, 1, 'вторая карточка не плодится');
  assert.equal(listDeeplinks(db)[0].leads, 1, 'повторное нажатие в течение суток — та же заявка');
  let card = db.prepare('SELECT note FROM crm_requests').get();
  assert.equal(card.note.split('Заявка из Telegram').length - 1, 1, 'комментарий не повторяется');
  db.prepare("UPDATE telegram_deeplink_leads SET created_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-25 hours')").run();
  await handleUpdate(db, TOKEN, cb(900, 'dl:l:price'), deps);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM crm_requests').get().n, 1, 'в окне CRM — та же карточка');
  assert.equal(listDeeplinks(db)[0].leads, 2, 'через сутки — новая заявка по ссылке');
  card = db.prepare('SELECT note FROM crm_requests').get();
  assert.equal(card.note.split('Заявка из Telegram').length - 1, 2);
  db.close();
});

// ---------------------------------------------------------------------------
// FIX_318_V1 — ревью 3.18.0 (TG_DEEPLINK_V1)
// ---------------------------------------------------------------------------
import { createDeeplinkLead, findActiveByKey, setPendingLead, takePendingLead, PENDING_LEAD_MINUTES, LEAD_DEDUP_HOURS } from './deeplinks.js';
import { setDataDir } from '../control/config.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';

test('L1 (повтор R6): пять нажатий «Оставить заявку» — одна заявка, одна строка статистики, комментарий один раз', () => {
  const db = seed();
  const link = saveDeeplink(db, { key: 'promo', name: 'Promo', answer_ru: 'hi' }, 1);
  const first = createDeeplinkLead(db, findActiveByKey(db, 'promo'), { chatId: '1', phone: '998901112299', name: 'N', lang: 'ru' });
  for (let i = 0; i < 4; i++) {
    const again = createDeeplinkLead(db, findActiveByKey(db, 'promo'), { chatId: '1', phone: '998901112299', name: 'N', lang: 'ru' });
    assert.equal(again.crm_request_id, first.crm_request_id);
    assert.equal(again.duplicate, true);
  }
  assert.equal(LEAD_DEDUP_HOURS, 24);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM crm_requests').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM telegram_deeplink_leads WHERE deeplink_id = ?').get(link.id).n, 1);
  assert.equal(db.prepare('SELECT note FROM crm_requests').get().note.split('Заявка из Telegram').length - 1, 1);
  // Другой чат той же ссылки — своя заявка (статистика рекламы честная).
  createDeeplinkLead(db, findActiveByKey(db, 'promo'), { chatId: '2', phone: '998901112288', name: 'M', lang: 'ru' });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM telegram_deeplink_leads').get().n, 2);
  db.close();
});

test('L1: ожидание номера для заявки истекает через 30 минут — номер, присланный позже, — обычное подключение пациента со списком документов, не заявка', async () => {
  const db = seed();
  saveDeeplink(db, PRICE, 1);
  assert.equal(PENDING_LEAD_MINUTES, 30);
  setPendingLead(db, '42', 7);
  assert.equal(takePendingLead(db, '42'), 7, 'в пределах 30 минут — заявка ждёт');
  assert.equal(takePendingLead(db, '42'), 0, 'ожидание забирается один раз');
  const { deps, texts } = harness();
  await handleUpdate(db, TOKEN, start(950, 'price'), deps);
  await handleUpdate(db, TOKEN, cb(950, 'dl:l:price'), deps);
  db.prepare("UPDATE telegram_state SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-31 minutes') WHERE key LIKE 'dl:lead:%'").run();
  await handleUpdate(db, TOKEN, contactMsg(950, '+998 90 111 22 33'), deps);   // номер пациента «Алиев Алишер»
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM crm_requests').get().n, 0, 'просроченное ожидание — не заявка из рекламы');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM telegram_deeplink_leads').get().n, 0);
  assert.ok(!texts().some((t) => /Rahmat|Спасибо! Заявка/.test(t)), 'не «спасибо за заявку»');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM telegram_state WHERE key LIKE 'dl:lead:%'").get().n, 0, 'ожидание убрано');
  db.close();
});

test('L2: файл к ответу — только из папки deeplinks/ хранилища бота; файл переписки сотрудников (chat/…) не сохраняется и не отправляется', async () => {
  const db = seed();
  for (const bad of ['chat/12/passport.pdf', 'broadcast/banner.jpg', 'x.pdf', 'deeplinks', 'deeplinks/../chat/1/a.pdf']) {
    assert.throws(() => saveDeeplink(db, { ...PRICE, key: 'k' + Math.random().toString(36).slice(2, 6), file_path: bad }, 1),
      (e) => e instanceof DeeplinkError && e.status === 400, bad);
  }
  const ok = saveDeeplink(db, { ...PRICE, key: 'okfile', file_path: 'deeplinks/1/price.pdf' }, 1);
  assert.equal(ok.file_path, 'deeplinks/1/price.pdf');
  // Строка, записанная до исправления, с путём в чужую папку — бот файл не шлёт.
  // Хранилище — во временной папке данных (data/ клиники тест не трогает).
  const dataDir = tmpDir('em-dl-l2-');
  const media = path.join(dataDir, 'storage', 'telegram-media');
  fs.mkdirSync(path.join(media, 'chat', '12'), { recursive: true });
  fs.mkdirSync(path.join(media, 'deeplinks', '1'), { recursive: true });
  fs.writeFileSync(path.join(media, 'chat', '12', 'secret.pdf'), '%PDF-1.4');
  fs.writeFileSync(path.join(media, 'deeplinks', '1', 'price.pdf'), '%PDF-1.4');
  setDataDir(dataDir);
  try {
    const { sent, deps } = harness();
    await handleUpdate(db, TOKEN, start(960, 'okfile'), deps);
    assert.deepEqual(sent.map((s) => s.method), ['sendDocument', 'sendMessage'], 'файл из deeplinks/ уходит');
    db.prepare("UPDATE telegram_deeplinks SET file_path = 'chat/12/secret.pdf', file_kind = 'document' WHERE key = 'okfile'").run();
    sent.length = 0;
    await handleUpdate(db, TOKEN, start(961, 'okfile'), deps);
    assert.deepEqual(sent.map((s) => s.method), ['sendMessage'], 'файл переписки не уходит — только текст ответа');
  } finally {
    setDataDir(null);
    db.close();
  }
});

test('L3: новая карточка заявки из ссылки — пациент по номеру правилом звонка', () => {
  const db = seed();
  saveDeeplink(db, PRICE, 1);
  const pid = db.prepare("SELECT id FROM patients WHERE full_name = 'Алиев Алишер'").get().id;
  const r = createDeeplinkLead(db, findActiveByKey(db, 'price'), { chatId: '70', phone: '998901112233', name: 'Алишер', lang: 'ru' });
  assert.equal(db.prepare('SELECT patient_id FROM crm_requests WHERE id = ?').get(r.crm_request_id).patient_id, pid);
  const s = createDeeplinkLead(db, findActiveByKey(db, 'price'), { chatId: '71', phone: '998977770000', name: 'Новый', lang: 'ru' });
  assert.equal(db.prepare('SELECT patient_id FROM crm_requests WHERE id = ?').get(s.crm_request_id).patient_id, null);
  db.close();
});
