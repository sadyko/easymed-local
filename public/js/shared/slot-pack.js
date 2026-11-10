// ═══════════════════════════════════════════════════════════════════════════
// SLOT_PACK_V1 (3.23.0, решение владельца 2026-11-10) — ЗАПИСИ ВСТАЮТ ВПЛОТНУЮ
// ═══════════════════════════════════════════════════════════════════════════
//
// Владелец: «слоты должны идти от настоящей длительности услуги, а не от шага
// 30 минут, и записи должны вставать одна за другой, без пустых промежутков».
//
// До этого файла свободные начала были СЕТКОЙ: от начала рабочего дня шагом
// 30 (мастер визита, карточка CRM, калькулятор), 15 (полоса расписания), 20
// («Повторный визит») — и начало, задевающее чужую запись, просто выпадало.
// Минута, в которую кончается запись, не предлагалась никогда: после приёма
// 10:10–10:40 следующим шло 11:00, и между ними оставалась дыра в 20 минут.
//
// ПРАВИЛО ОДНО: свободные промежутки = рабочие отрезки минус слитая занятость.
// В каждом промежутке первое начало — его начало (конец предыдущей записи,
// начало приёма, конец обеда), дальше — шагом ДЛИТЕЛЬНОСТИ УСЛУГИ, пока услуга
// помещается. Сегодня первое начало — «сейчас», округлённое ВВЕРХ до 5 минут
// (не «10:07»).
//
//   врач 09:00–18:00, записи 09:00–09:30 и 10:10–10:40:
//     услуга 30 мин → 09:30, 10:40, 11:10, 11:40, …
//     услуга 15 мин → 09:30, 09:45, 10:40, 10:55, …
//
// Чистый модуль — без базы, DOM и часового пояса: минуты от полуночи. Его
// берут и сервер (server/services/rpc/slot-engine.js реэкспортирует, считает
// calendar_slots), и экраны записи — когда к ответу сервера надо добавить
// время, занятое ещё не сохранёнными строками той же сметы (их в базе нет,
// сервер о них знать не может). Одна реализация на обе стороны: экран и
// сервер обязаны предлагать одно и то же.
//
// Партнёрский API и онлайн-запись (PUBLIC_SLOT_MIN = 15) остаются на сетке —
// это опубликованный договор; их считает slotStarts в slot-engine.js.

/** Длительность услуги по умолчанию (как slot-engine.js DEFAULT_DURATION_MIN). */
const DEFAULT_DURATION_MIN = 15;

/** «Сейчас» округляется вверх до стольких минут. */
export const PACK_ROUND_MIN = 5;

/** Пересекаются ли полуинтервалы [aFrom,aTo) и [bFrom,bTo). Стык (14:00–14:30 и 14:30–15:00) — НЕ пересечение. */
export function overlaps(aFrom, aTo, bFrom, bTo) {
  return aFrom < bTo && bFrom < aTo;
}

/** Окно минус обеды → список отрезков, в которых ресурс действительно принимает. */
export function windowSegments(win) {
  if (!win) return [];
  const breaks = [...(win.breaks || [])].sort((a, b) => a.from - b.from);
  const out = [];
  let cursor = win.from;
  for (const b of breaks) {
    const from = Math.max(b.from, win.from);
    const to = Math.min(b.to, win.to);
    if (to <= cursor) continue;
    if (from > cursor) out.push({ from: cursor, to: Math.min(from, win.to) });
    cursor = Math.max(cursor, to);
  }
  if (cursor < win.to) out.push({ from: cursor, to: win.to });
  return out.filter((s) => s.to > s.from);
}

/**
 * Занятое → отсортированные слитые полуинтервалы. Две записи внахлёст
 * (экстренная поверх занятого) или стык — один блок: промежуток между ними
 * пуст, и начинать в нём нечего.
 */
export function mergeBusy(busy) {
  const list = (busy || [])
    .map((b) => ({ from: Number(b && b.from), to: Number(b && b.to) }))
    .filter((b) => Number.isFinite(b.from) && Number.isFinite(b.to) && b.to > b.from)
    .sort((a, b) => a.from - b.from || a.to - b.to);
  const out = [];
  for (const b of list) {
    const last = out[out.length - 1];
    if (last && b.from <= last.to) last.to = Math.max(last.to, b.to);
    else out.push({ ...b });
  }
  return out;
}

/** Свободные промежутки: рабочие отрезки минус слитая занятость. */
export function freeGaps(segments, busy) {
  const merged = mergeBusy(busy);
  const out = [];
  for (const seg of segments || []) {
    let cur = seg.from;
    for (const b of merged) {
      if (b.to <= cur || b.from >= seg.to) continue;
      if (b.from > cur) out.push({ from: cur, to: Math.min(b.from, seg.to) });
      cur = Math.max(cur, b.to);
      if (cur >= seg.to) break;
    }
    if (cur < seg.to) out.push({ from: cur, to: seg.to });
  }
  return out;
}

/** Минуты, округлённые ВВЕРХ до шага (по умолчанию 5): 607 → 610, 605 → 605. */
export function roundUpMinutes(min, step = PACK_ROUND_MIN) {
  const s = Math.max(1, Math.round(Number(step) || PACK_ROUND_MIN));
  return Math.ceil(Number(min) / s) * s;
}

/**
 * Первое начало СЕГОДНЯ: местные часы и минуты мгновения, ВВЕРХ до 5 минут.
 * Начатая минута считается прошедшей: 10:05:30 → 10:10, ровно 10:05 → 10:05.
 * @param {Date|number} now
 */
export function packMinStart(now) {
  const d = new Date(now);
  const exact = d.getSeconds() === 0 && d.getMilliseconds() === 0;
  return roundUpMinutes(d.getHours() * 60 + d.getMinutes() + (exact ? 0 : 1));
}

const durationOf = (v) => Math.max(1, Math.round(Number(v) || DEFAULT_DURATION_MIN));

/**
 * SLOT_PACK_V1 — свободные начала вплотную.
 *
 * @param {object} o
 * @param {{from:number,to:number}[]} o.segments  рабочие отрезки (windowSegments)
 * @param {{from:number,to:number}[]} [o.busy]    занятое, минуты дня (в любом порядке, внахлёст можно)
 * @param {number} o.durationMin                  длительность услуги — она же шаг
 * @param {number|null} [o.minStartMin]           не раньше (сегодня — packMinStart)
 * @returns {number[]} минуты от полуночи, по возрастанию
 */
export function packedStarts({ segments, busy = [], durationMin, minStartMin = null }) {
  const dur = durationOf(durationMin);
  const out = [];
  for (const g of freeGaps(segments, busy)) {
    let t = g.from;
    if (minStartMin != null && t < minStartMin) t = minStartMin;
    for (; t + dur <= g.to; t += dur) out.push(t);
  }
  return out;
}

/**
 * SLOT_PACK_V1 — помещается ли приём с начала startMin: целиком внутри рабочего
 * отрезка и ни с чем занятым не пересекается (стык можно). Это проверка
 * ВЫБРАННОГО времени, а не «есть ли оно в списке»: соседняя запись сдвигает
 * упакованные начала, и время, бывшее в списке минуту назад, может в нём уже
 * не стоять, оставаясь свободным.
 */
export function startFits({ segments, busy = [], durationMin, startMin, minStartMin = null }) {
  const dur = durationOf(durationMin);
  const s = Number(startMin);
  if (!Number.isFinite(s)) return false;
  if (minStartMin != null && s < minStartMin) return false;
  return freeGaps(segments, busy).some((g) => s >= g.from && s + dur <= g.to);
}

// ─── ответ calendar_slots на стороне экрана ─────────────────────────────────

/** 'ЧЧ:ММ' → минуты; мусор → null. */
function hhmm(v) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v == null ? '' : v).trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/**
 * Занятость → минуты дня. SLOT_PACK_V1 (ревью L6) — сервер шлёт и минуты ЭТОГО дня
 * (from_min / to_min, зажатые сутками): приём, начавшийся вчера в 23:40, занимает
 * сегодня 00:00–00:10. Без них — ЧЧ:ММ; конец раньше начала — до конца суток.
 */
export function busyMinutes(list) {
  const out = [];
  for (const b of list || []) {
    if (b && Number.isFinite(b.from_min) && Number.isFinite(b.to_min)) {
      if (b.to_min > b.from_min) out.push({ from: b.from_min, to: b.to_min });
      continue;
    }
    const from = typeof (b && b.from) === 'number' ? b.from : hhmm(b && b.from);
    let to = typeof (b && b.to) === 'number' ? b.to : hhmm(b && b.to);
    if (from == null || to == null) continue;
    if (to <= from) to = 24 * 60;   // formatHhmm сервера заворачивает конец за полночь
    out.push({ from, to });
  }
  return out;
}

/**
 * Рамка дня из ответа calendar_slots: отрезки приёма, занятое и первое
 * допустимое начало — в минутах. null — в ответе нет окна (врач не работает
 * или ответ старого вида без window).
 */
export function dayFrame(day) {
  const w = day && day.window;
  if (!w) return null;
  const from = hhmm(w.from), to = hhmm(w.to);
  if (from == null || to == null || to <= from) return null;
  const breaks = busyMinutes(w.breaks || []);
  return {
    segments: windowSegments({ from, to, breaks }),
    busy: busyMinutes(day.busy || []),
    minStartMin: day.min_start ? hhmm(day.min_start) : null,
  };
}

/**
 * SLOT_PACK_EXTRA_BUSY_V1 — свободные начала дня с учётом ЕЩЁ НЕ СОХРАНЁННЫХ
 * строк той же сметы (окно «Даты приёма», мастер визита, калькулятор): их
 * время — тоже занятое, и вторая новая услуга к тому же врачу встаёт сразу за
 * первой, а не через дыру.
 *
 * Без чужих строк — ровно список сервера. Ответ без окна (старый вид,
 * заглушка теста) — список сервера минус пересечения: упаковать заново не из
 * чего.
 *
 * @param {object} day             ответ calendar_slots
 * @param {number} durationMin     длительность строки
 * @param {{from:number|string,to:number|string}[]} [extraBusy]
 * @returns {number[]} минуты от полуночи
 */
export function packedDayStarts(day, durationMin, extraBusy = []) {
  const server = ((day && day.slots) || []).map((s) => hhmm(s && s.start)).filter((m) => m != null);
  const extra = busyMinutes(extraBusy);
  if (!extra.length) return server;
  const dur = durationOf(durationMin);
  const frame = day && day.packed !== false ? dayFrame(day) : null;
  if (!frame) return server.filter((m) => !extra.some((b) => overlaps(m, m + dur, b.from, b.to)));
  return packedStarts({ segments: frame.segments, busy: frame.busy.concat(extra), durationMin: dur, minStartMin: frame.minStartMin });
}

/** SLOT_PACK_V1 — помещается ли начало startMin в день ответа (плюс несохранённые строки). */
export function dayStartFits(day, durationMin, startMin, extraBusy = []) {
  const frame = dayFrame(day);
  if (!frame) return packedDayStarts(day, durationMin, extraBusy).includes(Number(startMin));
  return startFits({ segments: frame.segments, busy: frame.busy.concat(busyMinutes(extraBusy)), durationMin, startMin });
}
