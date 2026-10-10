// CLINIC_API_STEP7_V1 — КЛЮЧИ И СЕКРЕТЫ ПОДКЛЮЧЕНИЙ API: выпуск, шифрование, отпечаток.
//
// Решение владельца 5: ключ можно открыть и скопировать снова — поэтому он
// хранится не только отпечатком, а ЗАШИФРОВАННЫМ (AES-256-GCM, те же
// encryptToken / decryptToken, что у токена Telegram-бота). Рядом — SHA-256
// ключа: по нему публичный сервер (шаг 8) узнаёт ключ, ничего не расшифровывая.
//
// КЛЮЧ ШИФРОВАНИЯ (KEK) — файл <data>/.api-secrets-key и копия .bak, рядом с
// базой, но НЕ в ней:
//   • копия базы (резервная копия, файл на флешке) ключей не раскрывает: в ней
//     шифротекст и отпечатки (backup.js копирует базу и storage/, а не файлы
//     каталога данных);
//   • восстановление копии на ЭТОМ компьютере — всё открывается;
//   • база на ДРУГОМ компьютере без файла — ключи РАБОТАЮТ (отпечаток в
//     базе), но показать их нельзя; экран говорит это прямо и предлагает
//     выпустить новый. Клинику переносят копированием всей папки данных — тогда
//     файл едет вместе с базой.
// Шифротекст помечен отпечатком KEK: «v1.<12 hex>.<base64>». Чужой KEK
// узнаётся по отпечатку — человек читает «файл остался на прежнем компьютере»,
// а не «повреждено». От того, у кого есть доступ к самому компьютеру, это не
// защищает (честно — как в telegram/crypto.js).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDataDir } from '../control/config.js';
import { encryptToken, decryptToken } from '../telegram/crypto.js';
import { KEY_PREFIX, SECRET_PREFIX, KEY_ALPHABET, KEY_BODY_LEN } from '../../../public/js/shared/api-connections.js';

export const KEK_FILE = '.api-secrets-key';
export const SEAL_VERSION = 'v1';

export class SecretBoxError extends Error {
  constructor(msg, status = 409) { super(msg); this.status = status; }
}
export const SECRET_MESSAGES = Object.freeze({
  kekMissing: 'Ключ или секрет нельзя показать на этом компьютере: файл шифрования остался на прежнем компьютере. Выпустите новый и передайте его подключению.',
  kekBroken:  'Файл шифрования ключей API повреждён: новые подключения не создаются, сохранённые ключи не открываются. Обратитесь в поддержку Easy-Med.',
  sealBroken: 'Сохранённый ключ или секрет повреждён. Выпустите новый и передайте его подключению.',
});

// Функция, а не константа: тесты задают свой каталог данных (setDataDir) или
// путь переменной окружения, и рабочий data/ не трогается.
export function defaultKekPath() {
  return process.env.EASYMED_API_KEK_PATH || path.join(getDataDir(), KEK_FILE);
}

/** Buffer — ключ; null — файла нет; false — файл есть, но это не ключ. */
function readKekFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8').trim(); } catch (e) { if (e && e.code === 'ENOENT') return null; throw e; }
  return /^[0-9a-f]{64}$/i.test(text) ? Buffer.from(text, 'hex') : false;
}

// tmp → fsync → rename (как lisproxy-settings.js): после сбоя питания файл
// либо прежний, либо новый, но не пустой.
function writeDurable(file, content) {
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  const fd = fs.openSync(tmp, 'w', 0o600);
  try { fs.writeSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}

/**
 * KEK клиники. Нет ни файла, ни копии — null (или новый, если create).
 * Испорчен основной — копия. Испорчены оба — ОТКАЗ: перегенерировать молча
 * нельзя, это обнулило бы все сохранённые ключи (правило telegram/crypto.js).
 */
export function loadKek({ kekPath = defaultKekPath(), create = false } = {}) {
  const main = readKekFile(kekPath);
  if (main) return main;
  const bak = readKekFile(kekPath + '.bak');
  if (bak) return bak;
  if (main === false || bak === false) throw new SecretBoxError(SECRET_MESSAGES.kekBroken);
  if (!create) return null;
  const key = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(kekPath), { recursive: true });
  writeDurable(kekPath, key.toString('hex'));
  writeDurable(kekPath + '.bak', key.toString('hex'));
  return key;
}

export const kekId = (kek) => crypto.createHash('sha256').update(kek).digest('hex').slice(0, 12);

export function seal(plain, kek) {
  return SEAL_VERSION + '.' + kekId(kek) + '.' + encryptToken(plain, kek);
}
export function unseal(sealed, kek) {
  const [v, id, body] = String(sealed || '').split('.');
  if (v !== SEAL_VERSION || !id || !body) throw new SecretBoxError(SECRET_MESSAGES.sealBroken);
  if (!kek || id !== kekId(kek)) throw new SecretBoxError(SECRET_MESSAGES.kekMissing);
  try { return decryptToken(body, kek); } catch { throw new SecretBoxError(SECRET_MESSAGES.sealBroken); }
}

export const keyHash = (key) => crypto.createHash('sha256').update(String(key), 'utf8').digest('hex');

function randomBody() {
  let s = '';
  for (let i = 0; i < KEY_BODY_LEN; i++) s += KEY_ALPHABET[crypto.randomInt(KEY_ALPHABET.length)];
  return s;
}
export const newApiKey = () => KEY_PREFIX + randomBody();
export const newWebhookSecret = () => SECRET_PREFIX + randomBody();
export const tailOf = (s) => String(s).slice(-4);
