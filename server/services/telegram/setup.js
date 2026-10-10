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

// CLINIC_PROFILE_V1 — отпечаток описания, которое Telegram уже принял
// (telegram_state, мигр. 060). По нему цикл бота узнаёт, что клинику
// переименовали в «Компании», и не шлёт то же описание на каждом проходе.
const DESCRIBED_KEY = 'bot_description';
const fingerprint = (d) => d.long.slice(0, 512) + '\n--\n' + d.short.slice(0, 120);
function readDescribed(db) {
  try { const r = db.prepare('SELECT value FROM telegram_state WHERE key = ?').get(DESCRIBED_KEY); return r ? r.value : ''; }
  catch { return ''; }
}
function writeDescribed(db, v) {
  db.prepare(`INSERT INTO telegram_state (key, value, updated_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(DESCRIBED_KEY, v);
}

// CLINIC_PROFILE_V1 — описание бота следует за названием клиники. Цикл бота
// зовёт это на каждом проходе рассылки (index.js): то же описание — ни одного
// запроса; другое — два запроса и новый отпечаток. Сбой — исключение наружу,
// отпечаток прежний, следующий проход повторит.
export async function syncBotDescription(db, token, deps = {}) {
  const d = descriptions(clinicNames(db));
  const fp = fingerprint(d);
  if (readDescribed(db) === fp) return { changed: false };
  await setMyDescription(token, d.long.slice(0, 512), '', deps);
  await setMyShortDescription(token, d.short.slice(0, 120), '', deps);
  writeDescribed(db, fp);
  return { changed: true };
}

// Возвращает список того, что удалось и что нет, — раздел настроек показывает
// это администратору строкой, не превращая в ошибку.
export async function setupBot(db, token, deps = {}) {
  const d = descriptions(clinicNames(db));   // CLINIC_PROFILE_V1
  const { long, short } = d;
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
  // CLINIC_PROFILE_V1 — оба описания приняты: запомнить отпечаток, чтобы цикл
  // бота (syncBotDescription) не слал то же самое ещё раз.
  if (done.includes('description') && done.includes('short_description')) {
    try { writeDescribed(db, fingerprint(d)); } catch { /* отпечаток не записался — цикл повторит */ }
  }
  await step('menu_button', () => setChatMenuButton(token, deps));

  return { ok: !failed.length, done, failed };
}
