// MAR_SCHEDULE_V1 — расписание листа назначений: из «3 раза в день, 5 дней»
// в пятнадцать плановых точек с датой и часом.
//
// ЧИСТЫЙ МОДУЛЬ: сюда не приходит база и отсюда не уходит ни одного запроса.
// Причина та же, по которой существует domain/day.js и domain/money.js — это
// ПРАВИЛО, а не запрос, и спрашивать его будут из трёх мест: RPC (что показать
// медсестре сейчас), экран врача (сетка «назначение × часы», Задача 5) и
// списание (за какую дозу начислять, Задача 6). Разъедься эти три копии — и
// клиника увидит на экране одно, а в счёте другое.
//
// ─── ЧАСЫ — МЕСТНЫЕ, НАСТЕННЫЕ ──────────────────────────────────────────────
//
// Слот 6 значит «шесть утра по часам в коридоре отделения», а не 06:00 UTC.
// Все ОТМЕТКИ времени в базе хранятся в UTC (strftime('...Z','now')), поэтому
// там, где эти два мира встречаются (отмена курса, «сейчас просрочено»), даты
// сравниваются по абсолютному времени: слот разворачивается в местную дату-час
// (`Date.parse('2026-09-04T06:00:00')` — без 'Z', то есть в поясе машины,
// ровно как date('now','localtime') в domain/day.js), а метка из базы — как
// UTC. Обе превращаются в миллисекунды, и сравниваются уже они.

// ─── Таблица частот ─────────────────────────────────────────────────────────
//
// Шесть частот из плана плюс «по требованию». Часы выбраны так, как их пишут в
// отделении: 1 р/д — утро после обхода; 2 р/д — утро и ночь; 3 р/д и 4 р/д —
// от шести утра; «каждые 6 ч» — круглосуточно, и полночь здесь 0, а не 24
// (24-й час — это уже следующая дата, и слот 24 в ключе (дата, слот) означал
// бы дозу, поставленную на вчерашний день).
//
// `single: true` — курс из одной точки: «однократно» дают один раз в первый
// день, сколько бы дней ни стояло в назначении.
export const FREQUENCIES = Object.freeze({
  '1x':   Object.freeze({ code: '1x',   label: '1 р/д',        slots: Object.freeze([10]) }),
  '2x':   Object.freeze({ code: '2x',   label: '2 р/д',        slots: Object.freeze([10, 22]) }),
  '3x':   Object.freeze({ code: '3x',   label: '3 р/д',        slots: Object.freeze([6, 14, 22]) }),
  '4x':   Object.freeze({ code: '4x',   label: '4 р/д',        slots: Object.freeze([6, 10, 14, 18]) }),
  'q6h':  Object.freeze({ code: 'q6h',  label: 'каждые 6 ч',   slots: Object.freeze([0, 6, 12, 18]) }),
  'once': Object.freeze({ code: 'once', label: 'однократно',   slots: Object.freeze([10]), single: true }),
  'prn':  Object.freeze({ code: 'prn',  label: 'по требованию', slots: Object.freeze([]), prn: true }),
});

export const FREQ_CODES = Object.freeze(Object.keys(FREQUENCIES));

// Пути введения — один список на сервер, экран и CHECK миграции 093.
export const ROUTES = Object.freeze([
  'в/в', 'в/в кап.', 'в/в (инфузомат)', 'в/м', 'п/к',
  'внутрь', 'сублингв.', 'ингаляция', 'местно', 'ректально',
]);

/** Часы частоты (новая копия массива — снимок для сохранения в orders.slots). */
export function freqSlots(code) {
  const f = FREQUENCIES[code];
  if (!f) return null;
  return [...f.slots];
}

/** «По требованию»: плановых точек нет, отметка идёт без слота. */
export function isPrnFreq(code) {
  return !!(FREQUENCIES[code] && FREQUENCIES[code].prn);
}

// ─── Календарь ──────────────────────────────────────────────────────────────
//
// Арифметика дней делается в UTC НАМЕРЕННО, хотя даты местные: 'YYYY-MM-DD'
// здесь — просто ярлык дня, и прибавление суток к нему не должно зависеть от
// перевода часов. Иначе в день перехода на летнее время курс на 5 дней вышел бы
// на 4 или на 6.
const DAY_MS = 86400000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isDate(s) {
  return typeof s === 'string' && DATE_RE.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));
}

function dayMs(date) { return Date.parse(date + 'T00:00:00Z'); }

function fromDayMs(ms) { return new Date(ms).toISOString().slice(0, 10); }

/** 'YYYY-MM-DD' + n суток. */
export function addDays(date, n) {
  return fromDayMs(dayMs(date) + Math.trunc(n) * DAY_MS);
}

/** Разница в сутках, b - a. */
export function daysBetween(a, b) {
  return Math.round((dayMs(b) - dayMs(a)) / DAY_MS);
}

/**
 * Последний день курса или null для «до отмены».
 *
 * days = 1 — это ОДИН день, сам starts_on: пятидневный курс кончается на
 * четвёртые сутки после начала, а не на пятые. «Однократно» кончается в день
 * начала, сколько бы дней ни передали.
 */
export function courseEnd(startsOn, days, freqCode) {
  if (!isDate(startsOn)) return null;
  if (FREQUENCIES[freqCode] && FREQUENCIES[freqCode].single) return startsOn;
  const n = Number(days);
  if (!Number.isFinite(n) || n <= 0) return null;
  return addDays(startsOn, Math.trunc(n) - 1);
}

/**
 * Абсолютное время плановой точки в миллисекундах — по МЕСТНЫМ часам.
 * Без 'Z' в строке: JS читает такую дату в поясе машины, тем же поясом, каким
 * SQLite считает date('now','localtime').
 */
export function dueAtMs(date, slot) {
  const h = String(Math.trunc(Number(slot) || 0)).padStart(2, '0');
  return Date.parse(`${date}T${h}:00:00`);
}

/** Та же точка строкой — для экрана и для сортировки: '2026-09-04 06:00'. */
export function dueAtLabel(date, slot) {
  return `${date} ${String(Math.trunc(Number(slot) || 0)).padStart(2, '0')}:00`;
}

function toMs(t) {
  if (t instanceof Date) return t.getTime();
  if (typeof t === 'number') return t;
  if (typeof t === 'string' && t) {
    const ms = Date.parse(t);
    if (!Number.isNaN(ms)) return ms;
  }
  return NaN;
}

function orderSlots(order) {
  // Снимок из назначения — ГЛАВНЕЕ таблицы частот (см. комментарий к колонке
  // slots в миграции 093): курс идёт по тем часам, по каким его назначили,
  // даже если частоту с тех пор переопределили.
  const raw = order && order.slots;
  let list = null;
  if (Array.isArray(raw)) list = raw;
  else if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) list = parsed;
    } catch { list = null; }
  }
  if (!list) list = freqSlots(order && order.freq_code) || [];
  return [...new Set(list.map((h) => Math.trunc(Number(h))).filter((h) => Number.isInteger(h) && h >= 0 && h <= 23))]
    .sort((a, b) => a - b);
}

/**
 * Развернуть курс в плановые точки, попадающие в [fromDate, toDate].
 *
 * Учитывает: starts_on, days / ends_on, «однократно», «по требованию» и
 * ОТМЕНУ. Отменённый курс перестаёт рождать точки С МОМЕНТА cancel_at —
 * не с даты отмены и не с начала курса: доза 06:00, которую медсестра успела
 * дать до того, как врач в 09:00 отменил назначение, остаётся плановой точкой
 * этого дня (иначе уже поставленная отметка повисла бы вне расписания и
 * исчезла бы из листа). Всё, что должно было случиться позже отмены, не
 * планируется вовсе.
 *
 * @param {{freq_code?:string, slots?:string|number[], starts_on:string,
 *          days?:number|null, ends_on?:string|null, status?:string,
 *          cancel_at?:string|null}} order
 * @param {string} fromDate 'YYYY-MM-DD'
 * @param {string} toDate   'YYYY-MM-DD'
 * @returns {{date:string, slot:number, due_at:string, due_ms:number}[]}
 */
export function expandCourse(order, fromDate, toDate) {
  if (!order || !isDate(order.starts_on) || !isDate(fromDate) || !isDate(toDate)) return [];
  if (order.prn === 1 || order.prn === true || isPrnFreq(order.freq_code)) return [];

  const slots = orderSlots(order);
  if (!slots.length) return [];

  // Конец курса: явный ends_on, иначе счёт по дням, иначе «до отмены» —
  // ограничен только запрошенным окном.
  const derived = courseEnd(order.starts_on, order.days, order.freq_code);
  const hardEnd = isDate(order.ends_on)
    ? (derived && derived < order.ends_on ? derived : order.ends_on)
    : derived;

  const start = order.starts_on > fromDate ? order.starts_on : fromDate;
  const end = hardEnd && hardEnd < toDate ? hardEnd : toDate;
  if (start > end) return [];

  const cancelMs = order.status === 'cancelled' ? toMs(order.cancel_at) : NaN;

  const out = [];
  for (let d = start; d <= end; d = addDays(d, 1)) {
    for (const slot of slots) {
      const ms = dueAtMs(d, slot);
      if (!Number.isNaN(cancelMs) && ms >= cancelMs) continue;
      out.push({ date: d, slot, due_at: dueAtLabel(d, slot), due_ms: ms });
    }
  }
  return out;
}

// ─── Три степени опоздания ──────────────────────────────────────────────────
//
// Из плана дословно: «Опоздание ≠ пропуск: три степени (ожидает / задержано /
// просрочено), 15 минут допуска». Экран медсестры строится на этом различии:
// «задержано» — иди и сделай, «просрочено» — иди и объясни.
//
// Граница «просрочено» — час после слота, и это НАСТРОЙКА, а не закон природы:
// параметр missedMin. Час выбран потому, что при самой частой схеме («каждые
// 6 ч») он оставляет запас до следующей дозы, и доза не может оказаться
// «просроченной» и «наступающей» одновременно.
export const GRACE_MIN = 15;
export const MISSED_MIN = 60;

/**
 * @param {{date:string, slot:number}|{due_ms:number}|string|number|Date} due
 * @param {Date|number|string} now
 * @returns {'pending'|'delayed'|'missed'}
 */
export function dueState(due, now, opts = {}) {
  const graceMin = Number.isFinite(opts.graceMin) ? opts.graceMin : GRACE_MIN;
  const missedMin = Number.isFinite(opts.missedMin) ? opts.missedMin : MISSED_MIN;

  let dueMs;
  if (due && typeof due === 'object' && !(due instanceof Date)) {
    dueMs = Number.isFinite(due.due_ms) ? due.due_ms : dueAtMs(due.date, due.slot);
  } else {
    dueMs = toMs(due);
  }
  const nowMs = toMs(now);
  if (Number.isNaN(dueMs) || Number.isNaN(nowMs)) return 'pending';

  const lateMin = (nowMs - dueMs) / 60000;
  if (lateMin < graceMin) return 'pending';
  if (lateMin < missedMin) return 'delayed';
  return 'missed';
}
