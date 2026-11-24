// LOCAL_SPEED_V1 (2026-11-24) — КТО ЗАНЯЛ СЕРВЕР.
//
// На фото консоли клиники строки [slow] заканчивались в пределах 1–5 мс друг от
// друга (1308/1309 мс, 267–271 мс): единственный поток Node стоял, и все ждали в
// очереди. По [slow] не видно, кто его занял, а кто просто ждал; к тому же
// /api/db писался как «POST /», а /api/rpc/x — как «POST /x» (express к finish уже
// срезал путь монтирования).
//
// Здесь — имена для журнала. Только код: имя RPC, имя таблицы из реестра,
// операция из пяти известных. Ни тела запроса, ни строки запроса, ни пути файла
// (в имени файла бывает фамилия пациента).

import { tableEntry } from '../db/schema-registry.js';

const DB_OPS = new Set(['select', 'insert', 'update', 'delete', 'upsert']);
const API_RPC = /^\/api\/rpc\/([^/]*)/i;
const API_DB = /^\/api\/db(?:\/|$)/i;
const API_STORAGE = /^\/api\/storage\/([^/]*)/i;

// Сегмент пути — как код: раскодированный, только буквы/цифры/_-. и не длиннее 80.
function codeName(seg) {
  let s = String(seg == null ? '' : seg);
  try { s = decodeURIComponent(s); } catch { /* как есть */ }
  return s.replace(/[^\w.-]/g, '').slice(0, 80) || '?';
}

/** «rpc <имя>» — имя RPC как код. */
export function rpcLabel(name) {
  return 'rpc ' + codeName(name);
}

/**
 * «db <таблица> <операция>» из тела /api/db: таблица — только если она есть в
 * реестре (иначе «?»: в поле table может прийти что угодно), операция — только
 * одна из пяти известных (нет её — без операции).
 */
export function dbLabel(body) {
  const b = body && typeof body === 'object' ? body : {};
  const t = typeof b.table === 'string' ? b.table : (typeof b.from === 'string' ? b.from : '');
  const table = t && tableEntry(t) ? t : '?';
  return 'db ' + table + (typeof b.op === 'string' && DB_OPS.has(b.op) ? ' ' + b.op : '');
}

/** Путь запроса без строки запроса — по полному адресу (express не успел его срезать). */
export function requestPath(req) {
  const url = String((req && (req.originalUrl || req.url)) || '');
  const q = url.indexOf('?');
  return q < 0 ? url : url.slice(0, q);
}

/** Имя запроса для строки [slow]: rpc <имя> / db <таблица> <операция> / путь. */
export function requestLabel(req) {
  const p = requestPath(req);
  const rpc = API_RPC.exec(p);
  if (rpc) return rpcLabel(rpc[1]);
  if (API_DB.test(p)) return dbLabel(req.body);
  const storage = API_STORAGE.exec(p);
  if (storage) return '/api/storage/' + codeName(storage[1]);
  return p;
}

// --- [busy] -------------------------------------------------------------------
// Маршрут /api/db и диспетчер RPC меряют СИНХРОННУЮ часть обработчика (до того,
// как он вернул значение или промис): better-sqlite3 синхронен, и пока она идёт,
// сервер не отвечает никому. Дольше EASYMED_BUSY_MS (по умолчанию 150 мс; 0 —
// выключено) — строка «[busy] 4800ms rpc <имя>» / «[busy] 4800ms db <таблица> <операция>».
// Это тот, кто заморозил сервер; строки [slow] вокруг — те, кто ждал.

const DEFAULT_BUSY_MS = 150;

/** Порог [busy] в мс; 0 — выключено (0, отрицательное, не число). */
export function busyLimitMs(env = process.env) {
  const v = env && env.EASYMED_BUSY_MS;
  const n = v == null || v === '' ? DEFAULT_BUSY_MS : Number(v);
  return n > 0 ? n : 0;
}

// Самый долгий отмеренный обработчик с прошлого тика детектора остановок —
// кандидат в «after:» строки [stall]. Один на процесс, как и детектор.
let windowTop = null;

/**
 * Секундомер синхронной части: time(label, fn) вызывает fn, возвращает её
 * значение (исключение — уходит дальше) и пишет [busy], если вышло дольше порога.
 * Порог читается один раз — при создании (маршруты создаются в createApp).
 */
export function busyTimer({ env = process.env, log = (line) => console.warn(line) } = {}) {
  const limit = busyLimitMs(env);
  return function timeBusy(label, fn) {
    const started = process.hrtime.bigint();
    try {
      return fn();
    } finally {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      if (!windowTop || ms > windowTop.ms) windowTop = { label, ms };
      if (limit > 0 && ms > limit) {
        try { log('[busy] ' + ms.toFixed(0) + 'ms ' + label); } catch { /* журнал — не повод сломать ответ */ }
      }
    }
  };
}

// --- [stall] ------------------------------------------------------------------
// Таймер раз в 200 мс сверяет, сколько прошло на самом деле. Опоздал больше чем
// на секунду — цикл событий стоял: «[stall] 4700ms» и, если с прошлого тика
// отработал отмеренный обработчик, «after: <самый долгий из них>». Если
// синхронная часть виновника коротка, а остановка длинная — держало то, что он
// делал после (например, отправка огромного ответа).
//
// Детектор один на процесс (createApp создаётся в тестах сотни раз — интервал не
// множится), и unref(): он никогда не держит процесс живым.

let stallTimer = null;

export function isStallWatchRunning() { return stallTimer !== null; }

/**
 * Можно ли включать детектор. Под node --test (NODE_TEST_CONTEXT) — только по
 * EASYMED_STALL_WATCH=1: синхронный migrate() каждого теста стоит около секунды,
 * и прогон засыпало бы строками [stall] (так же поступает lan/mdns.js).
 */
export function stallWatchAllowed(env = process.env) {
  return !(env && env.NODE_TEST_CONTEXT) || String(env.EASYMED_STALL_WATCH || '') === '1';
}

export function startStallWatch({ log = (line) => console.warn(line), everyMs = 200, stallMs = 1000 } = {}) {
  if (stallTimer) return;
  let last = process.hrtime.bigint();
  windowTop = null;
  stallTimer = setInterval(() => {
    const now = process.hrtime.bigint();
    const late = Number(now - last) / 1e6 - everyMs;
    last = now;
    const top = windowTop;
    windowTop = null;
    if (late > stallMs) {
      try { log('[stall] ' + late.toFixed(0) + 'ms' + (top ? ' after: ' + top.label : '')); } catch { /* см. выше */ }
    }
  }, everyMs);
  if (typeof stallTimer.unref === 'function') stallTimer.unref();
}

export function stopStallWatch() {
  if (stallTimer) clearInterval(stallTimer);
  stallTimer = null;
}
