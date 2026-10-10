// BRANCH_PROFILE_V1 — ЧАСЫ РАБОТЫ ЗДАНИЯ: сетка экрана «Филиалы» ⇄ колонки
// branches.working_hours / is_24_7, ровно в том виде, в каком их читает движок
// записи (server/services/rpc/slot-engine.js clinicWindow):
//   • is_24_7 = 1 — границы нет («Круглосуточно»);
//   • '{}' или пусто — границы нет («Не ограничивать», как у всех зданий до шага 4);
//   • заполненный распорядок — день без отметки ЗАКРЫТ для каждого врача этого
//     здания, часы дня сужают его окно (rpc/calendar.js resourceWindow).
// Экран пишет все семь дней {on, from, to}: какой день закрыт — видно в самой
// строке, а не по отсутствию ключа. Обеда у здания нет — движок его не читает.
//
// Чистый модуль: его читают экран, /api/db (storedHoursProblem) и RPC
// branch_hours_impact. Сообщения — ключи словаря.

export const WEEK = Object.freeze(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
export const HOURS_MODES = Object.freeze(['none', 'week', 'allday']);
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY_KEYS = 'from,on,to';

export const HOURS_MESSAGES = Object.freeze({
  noDay:  'Отметьте хотя бы один рабочий день или выберите «Не ограничивать».',
  order:  '{day}: время окончания должно быть позже начала.',
  stored: 'Часы работы здания записаны неверно: нужны все семь дней недели, у каждого — отметка и время «с» и «до», и хотя бы один рабочий день.',
});

const defaultDay = (k) => ({ on: k !== 'sat' && k !== 'sun', from: '09:00', to: '18:00' });
/** Пн–Пт 09:00–18:00, суббота и воскресенье — выходные: с этого начинается сетка. */
export function blankDays() { return Object.fromEntries(WEEK.map((k) => [k, defaultDay(k)])); }

// Как dayIsOn в slot-engine.js: enabled сильнее on; без флага — день включён.
function dayOn(e) {
  if (!e || typeof e !== 'object') return false;
  if ('enabled' in e) return !!e.enabled;
  if ('on' in e) return !!e.on;
  return true;
}
// Как parseHhmm в slot-engine.js (час из одной или двух цифр, пробелы по краям),
// но в виде, который понимает поле времени: '9:00' → '09:00'; мусор → null.
function engineHhmm(v) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v == null ? '' : v).trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return m[1].padStart(2, '0') + ':' + m[2];
}
function parseObject(raw) {
  if (raw && typeof raw === 'object') return Array.isArray(raw) ? null : raw;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try { const p = JSON.parse(raw); return p && typeof p === 'object' && !Array.isArray(p) ? p : null; } catch { return null; }
}

/** Колонки строки → { mode, days } для сетки. */
export function readBranchHours(workingHours, is24) {
  const days = blankDays();
  if (is24 === true || Number(is24) === 1) return { mode: 'allday', days };
  const o = parseObject(workingHours);
  if (!o || !WEEK.some((k) => k in o)) return { mode: 'none', days };
  for (const k of WEEK) {
    const e = o[k];
    const on = dayOn(e);
    // Как clinicWindow: у включённого дня без «с» — полночь, без «до» — конец
    // суток (сетка покажет 23:59: поле времени не умеет 24:00).
    const f = e && typeof e === 'object' ? engineHhmm(e.from) : null;
    const t = e && typeof e === 'object' ? engineHhmm(e.to) : null;
    const from = f || (on ? '00:00' : days[k].from);
    const to = t || (on ? '23:59' : days[k].to);
    days[k] = { on, from, to };
  }
  return { mode: 'week', days };
}

/** { mode, days } → колонки для записи. */
export function writeBranchHours({ mode, days } = {}) {
  if (mode === 'allday') return { working_hours: '{}', is_24_7: 1 };
  if (mode !== 'week') return { working_hours: '{}', is_24_7: 0 };
  const out = {};
  for (const k of WEEK) {
    const d = (days && days[k]) || defaultDay(k);
    const on = !!d.on;
    let from = String(d.from || '');
    let to = String(d.to || '');
    // BRANCH_PROFILE_V1 (ревью шага 4, #5) — у ВЫХОДНОГО дня время не проверяет
    // ни экран, ни движок, а поля его выключены: стёртое («») или испорченное
    // время владелец не видит и не поправит. Пишется время по умолчанию — иначе
    // сервер (storedHoursProblem) отказал бы сохранению без названного дня.
    if (!on) {
      if (!HHMM.test(from)) from = defaultDay(k).from;
      if (!HHMM.test(to)) to = defaultDay(k).to;
    }
    out[k] = { on, from, to };
  }
  return { working_hours: JSON.stringify(out), is_24_7: 0 };
}

/** Ошибка сетки: null или { template, day } (day — ключ дня; подпись переводит экран). */
export function hoursProblem({ mode, days } = {}) {
  if (mode !== 'week') return null;
  let anyOn = false;
  for (const k of WEEK) {
    const d = days && days[k];
    if (!d || !d.on) continue;
    anyOn = true;
    if (!HHMM.test(d.from) || !HHMM.test(d.to) || d.to <= d.from) return { template: HOURS_MESSAGES.order, day: k };
  }
  return anyOn ? null : { template: HOURS_MESSAGES.noDay, day: null };
}

/** Сервер: значение branches.working_hours перед записью. '' — годится. */
export function storedHoursProblem(raw) {
  if (raw === '' || raw === '{}') return '';
  if (typeof raw !== 'string') return HOURS_MESSAGES.stored;
  const o = parseObject(raw);
  if (!o || Object.keys(o).length !== WEEK.length || !WEEK.every((k) => k in o)) return HOURS_MESSAGES.stored;
  let anyOn = false;
  for (const k of WEEK) {
    const e = o[k];
    // Ровно on / from / to: лишний «enabled» движок прочёл бы раньше «on».
    if (!e || typeof e !== 'object' || Array.isArray(e) || Object.keys(e).sort().join(',') !== DAY_KEYS) return HOURS_MESSAGES.stored;
    if (typeof e.on !== 'boolean' || !HHMM.test(e.from) || !HHMM.test(e.to)) return HOURS_MESSAGES.stored;
    if (e.on) { anyOn = true; if (e.to <= e.from) return HOURS_MESSAGES.stored; }
  }
  return anyOn ? '' : HOURS_MESSAGES.stored;
}

/** Для списка: подряд идущие дни с одинаковыми часами — одной группой. */
export function hoursGroups({ mode, days } = {}) {
  if (mode !== 'week') return [];
  const groups = [];
  for (const k of WEEK) {
    const d = days && days[k];
    const hours = d && d.on ? d.from + '–' + d.to : '';
    const last = groups[groups.length - 1];
    if (last && last.hours === hours) last.to = k; else groups.push({ from: k, to: k, hours });
  }
  return groups.filter((g) => g.hours);
}
