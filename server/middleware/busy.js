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
  const open = openEntryLabel(p);   // LOCAL_SPEED_V1 (ревью)
  if (open) return open;
  return p;
}

// LOCAL_SPEED_V1 (ревью) — ВХОДЫ БЕЗ СЕССИИ: в пути не должно печататься ничего,
// кроме известного адреса. /api/telephony/pbx/<секрет> — секрет вебхука станции
// прямо в пути (services/telephony/ring-webhook.js, маршрут «/:token»): в строке
// [slow] он печатался целиком, а консоль клиники фотографируют и шлют в поддержку.
// Теперь — «/api/telephony/pbx/:token». У остальных входов без сессии секрет не в
// пути (Binotel — тело и адрес отправителя, LIS Proxy — ключ в строке запроса,
// справочник филиалу — подпись в заголовках), но дописать к их адресу можно что
// угодно, поэтому печатается только сам вход и его известные маршруты.
const OPEN_ENTRIES = [
  { mount: '/api/telephony/pbx', tail: () => '/:token' },
  { mount: '/api/telephony/binotel', tail: () => '' },
  { mount: '/api/lisproxy', tail: () => '' },
  { mount: '/api/branch-sync', tail: (seg) => (seg === 'catalogue' ? '/catalogue' : '') },
];

function openEntryLabel(p) {
  const lower = p.toLowerCase();
  for (const e of OPEN_ENTRIES) {
    if (lower !== e.mount && !lower.startsWith(e.mount + '/')) continue;
    const seg = lower.slice(e.mount.length + 1).split('/')[0];
    return e.mount + (seg ? e.tail(seg) : '');
  }
  return null;
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
// отработал отмеренный обработчик, «after: <самый долгий из них> (<его мс>ms)».
//
// LOCAL_SPEED_V1 (ревью) — НЕ НАЗЫВАТЬ НЕВИНОВНОГО. Раньше в «after:» попадал
// любой отмеренный обработчик, даже отработавший за 0 мс, — и строка указывала на
// запрос, который ни при чём. Теперь рядом с именем — его отмеренное время, а
// обработчик быстрее порога [busy] (EASYMED_BUSY_MS; [busy] выключен — обычные
// 150 мс) не называется вовсе: строка остаётся «[stall] 4700ms» — остановку
// устроил кто-то неотмеренный. Время в скобках меньше остановки — виновник занял
// поток лишь на эту часть, остальное — то, что шло после (например, отправка
// огромного ответа).
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

export function startStallWatch({ log = (line) => console.warn(line), everyMs = 200, stallMs = 1000, env = process.env } = {}) {
  if (stallTimer) return;
  const nameFromMs = busyLimitMs(env) || DEFAULT_BUSY_MS;   // LOCAL_SPEED_V1 (ревью) — быстрее этого в «after:» не попадает
  let last = process.hrtime.bigint();
  windowTop = null;
  stallTimer = setInterval(() => {
    const now = process.hrtime.bigint();
    const late = Number(now - last) / 1e6 - everyMs;
    last = now;
    const top = windowTop;
    windowTop = null;
    if (late > stallMs) {
      // LOCAL_SPEED_V1 (ревью) — имя только с отмеренным временем и только не быстрее порога [busy].
      const after = top && top.ms >= nameFromMs ? ' after: ' + top.label + ' (' + top.ms.toFixed(0) + 'ms)' : '';
      try { log('[stall] ' + late.toFixed(0) + 'ms' + after); } catch { /* см. выше */ }
    }
  }, everyMs);
  if (typeof stallTimer.unref === 'function') stallTimer.unref();
}

export function stopStallWatch() {
  if (stallTimer) clearInterval(stallTimer);
  stallTimer = null;
}
