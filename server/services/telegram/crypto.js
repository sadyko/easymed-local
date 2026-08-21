// TELEGRAM_BOT_V1 — шифрование токена бота на диске.
//
// Зачем вообще: предыдущая версия этой функции в клинике хранила СЕМЬ живых
// токенов и пароль Postgres открытым текстом в
// D:\server\telegram_Bot\bin\Debug\netcoreapp3.1\TelegramBot.dll.config,
// доступном на чтение кому угодно. Токен Telegram — это полный контроль над
// ботом: кто им владеет, тот читает переписку пациентов и пишет от имени
// клиники.
//
// Честно о границах защиты: ключ лежит в data/.telegram-key рядом с базой.
// Это защищает от скопированного easymed.db (бэкап на флешке, файл, унесённый
// «посмотреть дома») и НЕ защищает от того, у кого есть доступ к самой машине.
// Настоящее решение — DPAPI/аппаратное хранилище; здесь оно того не стоит,
// но и разница с открытым текстом в конфиге — это разница между «утекло с
// копией базы» и «не утекло».

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDataDir } from '../control/config.js';   // SUPERVISED_INSTALL_V1

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;    // рекомендованный размер nonce для GCM
const TAG_LEN = 16;

// server/services/telegram/crypto.js -> корень проекта
const ROOT = path.dirname(path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))));

// Функция, а не константа: тесты подменяют путь через переменную окружения,
// чтобы не писать ключ в рабочий data/ и не шифровать тестовые токены тем же
// ключом, что и боевой.
export function defaultKeyPath() {
  // SUPERVISED_INSTALL_V1 — from the one configured data directory, never
  // ROOT/data. Under a service install the application folder is versioned and
  // an update replaces it; a key written there would be destroyed on every
  // update and every clinic would silently lose its Telegram bot.
  return process.env.EASYMED_TELEGRAM_KEY_PATH || path.join(getDataDir(), '.telegram-key');
}

// Ключ создаётся при первом сохранении токена и дальше живёт вечно: перезапись
// ключа превратила бы сохранённый токен в мусор. Файл открывается с 0600 —
// на Windows это почти ничего не значит, на посаженном рядом WSL/Linux значит.
export function loadOrCreateKey(keyPath = defaultKeyPath()) {
  try {
    const hex = fs.readFileSync(keyPath, 'utf8').trim();
    const key = Buffer.from(hex, 'hex');
    if (key.length === 32) return key;
    // Файл есть, но не ключ. Молча перегенерировать нельзя: это тихо обнулило
    // бы уже сохранённый токен, и бот «просто перестал работать» без причины.
    throw new Error('data/.telegram-key повреждён: ожидался 32-байтный ключ в hex.');
  } catch (e) {
    if (e && e.code !== 'ENOENT') throw e;
  }
  const key = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  fs.writeFileSync(keyPath, key.toString('hex'), { mode: 0o600 });
  return key;
}

// iv | tag | ciphertext, в base64 одной строкой — так это кладётся в один
// TEXT-столбец и переживает любой бэкап базы как обычный текст.
export function encryptToken(plain, key) {
  if (typeof plain !== 'string' || plain === '') throw new Error('Пустой токен не шифруется.');
  const iv = crypto.randomBytes(IV_LEN);
  const c = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}

// GCM аутентифицирует шифротекст: правка байта в базе даёт исключение, а не
// тихо испорченный токен, который потом ловился бы как «Telegram отвечает 401».
export function decryptToken(packed, key) {
  const buf = Buffer.from(String(packed || ''), 'base64');
  if (buf.length <= IV_LEN + TAG_LEN) throw new Error('Сохранённый токен повреждён.');
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const d = crypto.createDecipheriv(ALGO, key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(buf.subarray(IV_LEN + TAG_LEN)), d.final()]).toString('utf8');
}

// Токен BotFather выглядит как 123456789:AA... — числовой id бота, двоеточие,
// секрет. Проверяем форму до сохранения, чтобы «проверка связи» не была
// единственным способом узнать про опечатку.
const TOKEN_RE = /^\d{6,12}:[A-Za-z0-9_-]{30,}$/;
export function looksLikeBotToken(t) {
  return TOKEN_RE.test(String(t || '').trim());
}

// Хвост токена для UI. Показать нужно ровно столько, чтобы администратор узнал
// «тот самый токен» и не больше: сам токен в браузер не уходит никогда.
export function tokenHint(t) {
  const s = String(t || '').trim();
  return s.length < 4 ? '' : s.slice(-4);
}
