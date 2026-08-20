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

// Описание видно на пустом экране до первого сообщения — это первое, что
// читает пациент, и единственное место, где можно объяснить, что бот вообще
// не человек и что он умеет.
function descriptions(clinic) {
  const name = clinic || 'klinika';
  return {
    long: [
      'Bu — «' + name + '» klinikasining rasmiy boti.',
      'Tahlil natijalari, shifokor xulosalari va hisob-fakturalarni shu yerdan olasiz.',
      'Boshlash uchun telefon raqamingizni yuboring.',
      '',
      'Это официальный бот клиники «' + name + '».',
      'Результаты анализов, заключения врачей и счета — здесь.',
      'Чтобы начать, отправьте свой номер телефона.',
    ].join('\n'),
    short: 'Hujjatlaringiz · Ваши документы — ' + name,
  };
}

function clinicName(db) {
  try {
    const row = db.prepare('SELECT clinic_name FROM doc_settings WHERE id = 1').get();
    return (row && row.clinic_name) || '';
  } catch { return ''; }
}

// Возвращает список того, что удалось и что нет, — раздел настроек показывает
// это администратору строкой, не превращая в ошибку.
export async function setupBot(db, token, deps = {}) {
  const clinic = clinicName(db);
  const { long, short } = descriptions(clinic);
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
  await step('menu_button', () => setChatMenuButton(token, deps));

  return { ok: !failed.length, done, failed };
}
