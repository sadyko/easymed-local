// V3120_I18N — сообщения сервера на языке экрана.
//
// Статическая фраза сервера переводится словарём целиком. Собранная («На
// балансе пациента только 100 — списать 200 нельзя.») — только если сервер
// прислал её шаблон и значения: слой запросов запоминает их
// (shared/server-messages.js), а tr() переводит шаблон и подставляет значения.
// Сам error.message остаётся русским — экраны, сверяющие его регуляркой,
// работают как раньше.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.localStorage.setItem('admin.lang', 'ru');
globalThis.document = { documentElement: { lang: 'ru' } };
globalThis.CustomEvent = class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } };
globalThis.window = { dispatchEvent() {}, addEventListener() {} };
if (!globalThis.navigator) Object.defineProperty(globalThis, 'navigator', { value: { languages: ['ru'], language: 'ru' }, configurable: true });

const { tr, setLang } = await import('../i18n.js');
const { rememberServerMessage, _resetServerMessages } = await import('../../shared/server-messages.js');
const { makeDbClient } = await import('../../db-client.js');

const WALLET = {
  code: 'bad_request',
  message: 'На балансе пациента только 100 — списать 200 нельзя.',
  template: 'На балансе пациента только {have} — списать {amount} нельзя.',
  params: { have: 100, amount: 200 },
};

test('собранная фраза сервера с шаблоном переводится на языке экрана', () => {
  _resetServerMessages();
  rememberServerMessage(WALLET);
  setLang('uz');
  assert.equal(tr(WALLET.message), "Bemor balansida faqat 100 bor — 200 yechib bo'lmaydi.");
  setLang('en');
  assert.equal(tr(WALLET.message), "The patient's balance is only 100 — 200 cannot be charged.");
  setLang('ru');
  assert.equal(tr(WALLET.message), WALLET.message, 'на русском экране — ровно то, что прислал сервер');
});

test('без шаблона собранная фраза остаётся как есть (не ломается и не пустеет)', () => {
  _resetServerMessages();
  rememberServerMessage({ message: 'Что-то собранное 42.' });
  setLang('uz');
  assert.equal(tr('Что-то собранное 42.'), 'Что-то собранное 42.');
  setLang('ru');
});

test('статическая фраза сервера переводится словарём целиком', () => {
  setLang('uz');
  assert.equal(tr('Вашей роли это недоступно.'), "Bu sizning rolingizga ruxsat berilmagan.");
  setLang('ru');
  assert.equal(tr('not allowed'), 'Нет доступа.', 'машинное слово компилятора запросов на русском экране — по-русски');
});

// DISK_GUARD_V1 — числа в params приходят числами: десятичный знак ставит экран
// (ru и uz — запятая, en — точка). Русский экран показывает фразу сервера как
// есть: «0,0 ГБ» сервер уже написал сам, а из числа 0 вышло бы «0 ГБ».
const NO_SPACE = {
  code: 'no_space',
  message: 'Недостаточно места на диске: нужно 2,1 ГБ, свободно 0,0 ГБ. Копия не сделана.',
  template: 'Недостаточно места на диске: нужно {need} ГБ, свободно {free} ГБ. Копия не сделана.',
  params: { need: 2.1, free: 0 },
};

test('DISK_GUARD_V1: числа из params — с десятичным знаком языка экрана; русский экран — ровно фраза сервера', () => {
  _resetServerMessages();
  rememberServerMessage(NO_SPACE);
  setLang('en');
  assert.equal(tr(NO_SPACE.message), 'Not enough disk space: 2.1 GB needed, 0 GB free. The backup was not made.');
  setLang('uz');
  assert.equal(tr(NO_SPACE.message), 'Diskda joy yetarli emas: 2,1 GB kerak, 0 GB bo‘sh. Nusxa olinmadi.');
  setLang('ru');
  assert.equal(tr(NO_SPACE.message), NO_SPACE.message);
});

test('db-client запоминает шаблон отказа базы: нарушение уникальности — на языке экрана, код SQLite не спрятан', async () => {
  _resetServerMessages();
  const body = { error: {
    code: 'conflict',
    message: 'Такая запись уже есть: значение lab_panels.service_id должно быть уникальным.',
    template: 'Такая запись уже есть: значение {column} должно быть уникальным.',
    params: { column: 'lab_panels.service_id' },
    sqlite_code: 'SQLITE_CONSTRAINT_UNIQUE',
  } };
  const db = makeDbClient({ fetch: async () => ({ ok: false, status: 409, json: async () => body }), base: '/api/db' });
  const { error } = await db.from('lab_panels').update({ service_id: 1 }).eq('id', 2);
  assert.equal(error.message, body.error.message, 'сообщение ошибки — русское, как прислал сервер');
  assert.equal(error.sqlite_code, 'SQLITE_CONSTRAINT_UNIQUE');
  setLang('en');
  assert.equal(tr(error.message), 'This record already exists: the value of lab_panels.service_id must be unique.');
  setLang('ru');
});
