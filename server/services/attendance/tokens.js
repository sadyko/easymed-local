// STAFF_ATTENDANCE_V1 — коды QR у входа: подпись, проверка, картинка.
//
// Код на экране меняется каждые rotate_secs (мигр. 305; было rotate_seconds). Окно — номер интервала:
// floor(серверное время / rotate_secs). Подпись — HMAC-SHA256 секретом
// точки над «a.<точка>.<окно>», первые 16 символов base64url (96 бит):
// подобрать её перебором через бота нельзя (сканы ограничены по частоте, а
// каждая неудача пишется в attendance_flags).
//
// QR несёт ссылку https://t.me/<бот>?start=a_<точка>_<окно>_<подпись>.
// Параметр start Telegram ограничивает 64 символами [A-Za-z0-9_-] — наш
// укладывается в ~35.
//
// Принимается текущее и несколько ПРЕДЫДУЩИХ окон — не меньше ~8 секунд
// (acceptedPastWindows): человек мог навести камеру за секунду до смены кода,
// а Telegram открыть бота через пару секунд. Окно из
// будущего — отказ: часы экрана тут ни при чём, окно считает сервер.
//
// ОГРАНИЧЕНИЕ, о котором честно (ТЗ просит его описать): код, отправленный
// фотографией коллеге, работает у коллеги, пока не выйдут принимаемые окна
// (до 12 с при 3-секундном окне, до 40 с при 20-секундном). Это сужено до минимума, но не исключено:
// без проверки местоположения телефона сервер не может знать, где стоит
// человек. Поэтому каждый скан пишется с точкой и временем, и HR видит, если
// двое отметились одним и тем же кодом (отчёт «подозрительное»).
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// Вендоренная библиотека (MIT, public/js/vendor/qrcode-generator-LICENSE.md):
// QR рисуется на сервере — экран получает готовый SVG, а секрет точки остаётся здесь.
const qrcode = require('../../../public/js/vendor/qrcode-generator-1.4.4.cjs');

const MAC_LEN = 16;
const START_RE = /^a_(\d{1,9})_(\d{1,12})_([A-Za-z0-9_-]{16})$/;

export function newSecret(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

export function currentWindow(rotateSeconds, nowMs = Date.now()) {
  return Math.floor(nowMs / (rotateSeconds * 1000));
}

/** Сколько секунд осталось текущему окну — экрану, чтобы обновиться вовремя. */
export function secondsLeft(rotateSeconds, nowMs = Date.now()) {
  const span = rotateSeconds * 1000;
  return Math.max(1, Math.ceil((span - (nowMs % span)) / 1000));
}

export function sign(secret, locationId, window) {
  return crypto.createHmac('sha256', secret).update(`a.${locationId}.${window}`).digest('base64url').slice(0, MAC_LEN);
}

export function startParam(location, window) {
  return `a_${location.id}_${window}_${sign(location.token_secret, location.id, window)}`;
}

/** Разбор параметра /start: { locationId, window, mac } или null — это не код входа. */
export function parseStart(param) {
  const m = START_RE.exec(String(param || ''));
  if (!m) return null;
  return { locationId: Number(m[1]), window: Number(m[2]), mac: m[3] };
}

// STAFF_ATTENDANCE_FAST_QR_V1 (мигр. 305) — интервал точки живёт в rotate_secs
// (3–120 с); старая колонка rotate_seconds (10–120) больше ничего не значит.
export function rotateOf(location) {
  const n = Number(location && (location.rotate_secs ?? location.rotate_seconds));
  return Number.isInteger(n) && n >= 3 ? n : 20;
}

// Сколько секунд код должен приниматься после того, как сменился на экране:
// навести камеру, открыть Telegram, дождаться сообщения в боте — 2–6 секунд.
export const MIN_ACCEPT_SECONDS = 8;

/**
 * Сколько ПРОШЛЫХ окон принимать, кроме текущего. 20-секундному окну хватает
 * одного прошлого (как было: код живёт 20–40 с); трёхсекундному нужно три
 * (код живёт 9–12 с). Иначе быстрый код отвергал бы честных сотрудников, чей
 * Telegram открылся через 4 секунды.
 */
export function acceptedPastWindows(rotateSeconds) {
  return Math.max(1, Math.ceil(MIN_ACCEPT_SECONDS / rotateSeconds));
}

/**
 * Проверка кода точки. Возвращает null — код годен, или причину отказа:
 * 'bad_token' (подпись не сходится) | 'expired_token' (окно старше
 * принимаемых — acceptedPastWindows — или из будущего). Подпись сравнивается
 * за постоянное время.
 */
export function verify(location, parsed, nowMs = Date.now()) {
  const expected = Buffer.from(sign(location.token_secret, location.id, parsed.window));
  const given = Buffer.from(parsed.mac);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return 'bad_token';
  const rotate = rotateOf(location);
  const cur = currentWindow(rotate, nowMs);
  if (parsed.window > cur || parsed.window < cur - acceptedPastWindows(rotate)) return 'expired_token';
  return null;
}

export function deepLink(botUsername, location, window) {
  return `https://t.me/${botUsername}?start=${startParam(location, window)}`;
}

/** SVG с QR-кодом текста (уровень коррекции M — читается с экрана с бликами). */
export function qrSvg(text, { cell = 8, margin = 4 } = {}) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const size = (n + margin * 2) * cell;
  let d = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) d += `M${(c + margin) * cell} ${(r + margin) * cell}h${cell}v${cell}h-${cell}z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="100%" height="100%" shape-rendering="crispEdges">`
    + `<rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
