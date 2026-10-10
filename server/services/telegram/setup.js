// TELEGRAM_BOT_SETUP_V1 — бот настраивается ИЗ СИСТЕМЫ, а не руками в @BotFather.
//
// У бота есть «витрина», которая живёт на стороне Telegram: список команд в
// меню, описание на пустом экране до первого сообщения, короткое описание в
// профиле и кнопка «Меню» у поля ввода. Настроить всё это можно только
// вызовами API — и раньше это означало бы инструкцию администратору: открой
// @BotFather, набери /setcommands, вставь такой-то текст. Половина клиник
// этого не сделает никогда, и пациент увидит пустого безымянного бота.
//
// Поэтому setup вызывается сам, сразу после того как токен принят: один ввод
// токена — и бот полностью готов.
//
// Ошибки здесь НЕ роняют сохранение токена. Витрина — это оформление; если
// Telegram моргнул на setMyDescription, бот всё равно работает и выдаёт
// документы, а администратору незачем видеть красную ошибку про описание.

import { setMyCommands, setMyDescription, setMyShortDescription, setChatMenuButton } from './api.js';

// Команды на трёх «языках»: узбекский, русский и дефолт. Telegram показывает
// пациенту тот набор, что совпал с языком его интерфейса, а дефолт достаётся
// всем остальным. Дефолт делаем двуязычным — у клиники обе аудитории.
const COMMANDS = {
  '': [
    { command: 'documents', description: 'Hujjatlarim · Мои документы' },
    { command: 'start',     description: 'Boshlash · Начать' },
    { command: 'help',      description: 'Yordam · Помощь' },
  ],
  uz: [
    { command: 'documents', description: 'Hujjatlarim' },
    { command: 'start',     description: 'Boshlash' },
    { command: 'help',      description: 'Yordam' },
  ],
  ru: [
    { command: 'documents', description: 'Мои документы' },
    { command: 'start',     description: 'Начать' },
    { command: 'help',      description: 'Помощь' },
  ],
};

// CLINIC_PROFILE_V1 — названия для бота: RU — то, что печатается (clinic_name);
// UZ — узбекское из «Компании» (name_uz, мигр. 240), иначе то же RU. SELECT * —
// база до мигр. 240 колонки name_uz не знает, и бот не должен терять название
// из-за этого. Его же читает приветствие (flow.js).
export function clinicNames(db) {
  try {
    const r = db.prepare('SELECT * FROM doc_settings WHERE id = 1').get() || {};
    const ru = r.clinic_name || '';
    return { ru, uz: r.name_uz || ru };
  } catch { return { ru: '', uz: '' }; }
}

// Описание видно на пустом экране до первого сообщения — это первое, что
// читает пациент, и единственное место, где можно объяснить, что бот вообще
// не человек и что он умеет.
// CLINIC_PROFILE_V1 — узбекская часть называет клинику по-узбекски, русская —
// по-русски; короткое описание — русским названием, как было.
function descriptions({ ru, uz } = {}) {
  const nameRu = ru || 'klinika';
  const nameUz = uz || ru || 'klinika';
  return {
    long: [
      'Bu — «' + nameUz + '» klinikasining rasmiy boti.',
      'Tahlil natijalari, shifokor xulosalari va hisob-fakturalarni shu yerdan olasiz.',
      'Boshlash uchun telefon raqamingizni yuboring.',
      '',
      'Это официальный бот клиники «' + nameRu + '».',
      'Результаты анализов, заключения врачей и счета — здесь.',
      'Чтобы начать, отправьте свой номер телефона.',
    ].join('\n'),
    short: 'Hujjatlaringiz · Ваши документы — ' + nameRu,
  };
}

// CLINIC_PROFILE_V1 — отпечаток НАЗВАНИЙ клиники, с которыми описание бота
// последний раз принято (telegram_state, мигр. 060). По нему цикл бота
// узнаёт, что клинику переименовали в «Компании», и не шлёт то же описание
// на каждом проходе.
//   • ключа нет — первый проход после обновления: отпечаток запоминается БЕЗ
//     отправки (ревью M5) — у бота может стоять описание из @BotFather, и
//     затирать его сгенерированным при обновлении никто не просил;
//   • пустая строка — «описание надо дослать» (setupBot не смог его поставить).
const DESCRIBED_KEY = 'bot_description';
// CLINIC_PROFILE_V1 (ревью M5) — пауза после сбоя: { fails, next } (мс).
// 5 мин, 10, 20, … — не больше 6 часов; удача снимает паузу.
const RETRY_KEY = 'bot_description_retry';
const RETRY_BASE_MS = 5 * 60 * 1000;
const RETRY_CAP_MS = 6 * 60 * 60 * 1000;
const namesPrint = ({ ru, uz }) => JSON.stringify([ru || '', uz || '']);
function readState(db, key) {
  try { const r = db.prepare('SELECT value FROM telegram_state WHERE key = ?').get(key); return r ? r.value : null; }
  catch { return null; }
}
function writeState(db, key, v) {
  db.prepare(`INSERT INTO telegram_state (key, value, updated_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(key, v);
}
function clearRetry(db) {
  try { db.prepare('DELETE FROM telegram_state WHERE key = ?').run(RETRY_KEY); } catch { /* нет таблицы — нечего снимать */ }
}
function readRetry(db) {
  try { const v = JSON.parse(readState(db, RETRY_KEY) || 'null'); return v && Number.isFinite(v.next) ? v : null; }
  catch { return null; }
}

// CLINIC_PROFILE_V1 — описание бота следует за названием клиники. Цикл бота
// зовёт это на каждом проходе рассылки (index.js): название то же — ни одного
// запроса; другое — два запроса и новый отпечаток. Сбой — исключение наружу,
// отпечаток прежний, а следующая попытка — не раньше паузы (ревью M5).
export async function syncBotDescription(db, token, deps = {}) {
  const now = typeof deps.now === 'function' ? deps.now() : Date.now();
  const names = clinicNames(db);
  const fp = namesPrint(names);
  const stored = readState(db, DESCRIBED_KEY);
  if (stored === null) { writeState(db, DESCRIBED_KEY, fp); return { changed: false, adopted: true }; }
  if (stored === fp) return { changed: false };
  const retry = readRetry(db);
  if (retry && now < retry.next) return { changed: false, waiting: true };
  const d = descriptions(names);
  try {
    await setMyDescription(token, d.long.slice(0, 512), '', deps);
    await setMyShortDescription(token, d.short.slice(0, 120), '', deps);
  } catch (e) {
    const fails = (retry ? Number(retry.fails) || 0 : 0) + 1;
    const wait = Math.min(RETRY_BASE_MS * 2 ** Math.min(fails - 1, 20), RETRY_CAP_MS);
    try { writeState(db, RETRY_KEY, JSON.stringify({ fails, next: now + wait })); } catch { /* пауза не записалась — повтор раньше, не хуже */ }
    throw e;
  }
  writeState(db, DESCRIBED_KEY, fp);
  clearRetry(db);
  return { changed: true };
}

// Возвращает список того, что удалось и что нет, — раздел настроек показывает
// это администратору строкой, не превращая в ошибку.
export async function setupBot(db, token, deps = {}) {
  const names = clinicNames(db);   // CLINIC_PROFILE_V1
  const { long, short } = descriptions(names);
  const done = [];
  const failed = [];

  const step = async (name, fn) => {
    try { await fn(); done.push(name); }
    catch (e) { failed.push(name + ': ' + ((e && e.message) || e)); }
  };

  for (const [lang, list] of Object.entries(COMMANDS)) {
    await step('commands' + (lang ? ':' + lang : ''), () => setMyCommands(token, list, lang, deps));
  }
  // Описания Telegram принимает только до 512 / 120 символов соответственно;
  // режем здесь, а не полагаемся на то, что название клиники короткое.
  await step('description', () => setMyDescription(token, long.slice(0, 512), '', deps));
  await step('short_description', () => setMyShortDescription(token, short.slice(0, 120), '', deps));
  // CLINIC_PROFILE_V1 — оба описания приняты: запомнить отпечаток названий,
  // чтобы цикл бота (syncBotDescription) не слал то же самое ещё раз. Не
  // приняты — пустой отпечаток: цикл не примет молча, а дошлёт (ревью M5).
  try {
    if (done.includes('description') && done.includes('short_description')) { writeState(db, DESCRIBED_KEY, namesPrint(names)); clearRetry(db); }
    else writeState(db, DESCRIBED_KEY, '');
  } catch { /* отпечаток не записался — цикл разберётся сам */ }
  await step('menu_button', () => setChatMenuButton(token, deps));

  return { ok: !failed.length, done, failed };
}
