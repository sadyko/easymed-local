// CALENDAR_BOOKING_V1 — ЧТО СВОБОДНО. Один движок на всю клинику.
//
// ─── ПОЧЕМУ ОН ОДИН И ПОЧЕМУ НА СЕРВЕРЕ ─────────────────────────────────────
//
// До этого файла «свободно ли время» считалось В БРАУЗЕРЕ и в ТРЁХ местах
// сразу, каждое со своей арифметикой:
//
//   views/visit-wizard.js      dayWindow/slotsForDay/loadBusy — по этим слотам
//                              клиника РЕАЛЬНО записывает пациентов;
//   views/service-picker-modal.js  catWorkRange/freeStarts и второй, отдельный
//                              workingRangeFor для полосы расписания;
//   views/room-calendar.js     workRange — затенение нерабочих часов.
//
// Три реализации одного правила — это три разных ответа на один вопрос, и они
// уже расходились НЕ в мелочах:
//
//   • ФОРМА ГРАФИКА. Карточка сотрудника (employee-editor.js) пишет день как
//     {enabled, from, to, lunchEnabled, lunchFrom, lunchTo}; экран «Сотрудники»
//     (employees.js) — как {on, from, to}. Обе формы лежат в одной колонке
//     users.working_hours. Мастер визита смотрит ТОЛЬКО на `on`, поэтому у
//     врача, заведённого карточкой, он не видел графика вовсе и предлагал
//     09:00–18:00 всем подряд. Календарь смотрит ТОЛЬКО на `enabled`, поэтому
//     выключенный день из «Сотрудников» рисовал рабочим. Здесь понимаются обе
//     формы, и это единственное место, где их надо помнить.
//   • ОБЕД. Его вводят в карточке сотрудника, и его не вычитал никто.
//   • ОКНО ПО УМОЛЧАНИЮ. Мастер — 09:00–18:00, календарь — 08:00–20:00. То есть
//     календарь показывал свободным время, на которое мастер записать не давал.
//
// Движок живёт на СЕРВЕРЕ, потому что здесь же стоит запрет двойной записи
// (rpc/calendar.js): проверка, которую можно обойти, выключив JavaScript, —
// не запрет. Экран спрашивает свободные слоты вызовом `calendar_slots`, а
// записывает вызовом `calendar_book`, и оба ответа считает ЭТОТ файл.
//
// ─── ЕДИНИЦЫ ───────────────────────────────────────────────────────────────
//
// Всё здесь — МИНУТЫ ОТ ПОЛУНОЧИ и НОМЕР ДНЯ НЕДЕЛИ (0 = воскресенье, как у
// Date.getDay()). Ни одной даты и ни одного часового пояса: перевод «ISO визита
// → минуты дня» делает вызывающий (rpc/calendar.js), потому что это единственное
// место, где часовой пояс вообще существует — сервер стоит В ТОЙ ЖЕ КЛИНИКЕ,
// что и регистратура, поэтому местное время процесса и есть местное время
// клиники. Держать пояс подальше от арифметики — это то, что делает движок
// проверяемым: тест про «14:00 занято» не зависит от того, где запущен.
//
// Пересечение интервалов при этом считается в АБСОЛЮТНЫХ миллисекундах
// (overlapsMs ниже) — там пояс не нужен вовсе, и это не должно теряться.

/** Ключи дней недели в users.working_hours / branches.working_hours (0 = вс). */
export const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** Окно по умолчанию, когда график не задан. То же, по которому сегодня реально записывает мастер визита. */
export const DEFAULT_FROM_MIN = 9 * 60;    // 09:00
export const DEFAULT_TO_MIN = 18 * 60;     // 18:00

/** Длительность услуги по умолчанию — решение владельца (2026-09-05): 15 минут. */
export const DEFAULT_DURATION_MIN = 15;

/** Статусы визита, которые ЗАНИМАЮТ время. Отменённый и не пришедший — не занимают. */
export const BUSY_STATUSES = ['scheduled', 'confirmed', 'arrived'];

/** '09:30' → 570. Мусор → null (а не 0: 0 — это полночь, настоящее значение). */
export function parseHhmm(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value == null ? '' : value).trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** 570 → '09:30'. */
export function formatHhmm(minutes) {
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  return String(Math.floor(m / 60) % 24).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
}

/**
 * Колонка working_hours → объект или null. Колонка объявлена TEXT (и у users, и
 * у rooms), но приезжает то строкой JSON, то уже разобранным объектом (клиент
 * шлёт объект, /api/db отдаёт строку). Обе формы — здесь.
 */
export function parseWorkingHours(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return Array.isArray(raw) ? null : raw;
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;
  try {
    const parsed = JSON.parse(s);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Включён ли день. ДВЕ ФОРМЫ, и это не терпимость к бардаку, а факт: обе лежат
 * в одной колонке живых клиник (см. шапку). `enabled` — карточка сотрудника,
 * `on` — экран «Сотрудники». Ни одного флага (только from/to) — день включён:
 * запись, у которой указаны часы, ничего другого означать не может.
 */
function dayIsOn(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if ('enabled' in entry) return !!entry.enabled;
  if ('on' in entry) return !!entry.on;
  return true;
}

/**
 * Рабочее окно ресурса (врача или кабинета) на день недели.
 *
 * @param {string|object|null} hoursRaw  колонка working_hours
 * @param {number} weekday               0 = воскресенье (Date#getDay)
 * @returns {{from:number,to:number,breaks:{from:number,to:number}[]}|null}
 *          null = ресурс в этот день не принимает
 */
export function dayWindow(hoursRaw, weekday) {
  const hours = parseWorkingHours(hoursRaw);
  // График не задан вовсе — работаем по умолчанию. Существующие врачи и
  // кабинеты не должны переставать записываться от того, что колонку добавили.
  if (!hours) return { from: DEFAULT_FROM_MIN, to: DEFAULT_TO_MIN, breaks: [] };

  const entry = hours[WEEKDAY_KEYS[((weekday % 7) + 7) % 7]];
  if (!entry || typeof entry !== 'object') return null;   // дня нет в графике = выходной
  if (!dayIsOn(entry)) return null;

  const from = parseHhmm(entry.from);
  const to = parseHhmm(entry.to);
  const win = {
    from: from == null ? DEFAULT_FROM_MIN : from,
    to: to == null ? DEFAULT_TO_MIN : to,
    breaks: [],
  };
  if (win.to <= win.from) return null;   // «с 18:00 до 09:00» — не окно, а опечатка

  // ОБЕД. Его вводят в карточке сотрудника, и до этого файла его не вычитал
  // никто: врач с обедом 13:00–14:00 получал записи на обед.
  if (entry.lunchEnabled) {
    const lf = parseHhmm(entry.lunchFrom);
    const lt = parseHhmm(entry.lunchTo);
    if (lf != null && lt != null && lt > lf) win.breaks.push({ from: lf, to: lt });
  }
  return win;
}

/**
 * Окно клиники (здания) на день. branches.is_24_7 или пустые часы = без границы
 * (undefined), закрытый день = null. Форма ответа повторяет
 * public/js/admin/clinic-hours.js — экран и сервер обязаны понимать одно и то же.
 */
export function clinicWindow(branch, weekday) {
  if (!branch) return undefined;
  if (branch.is_24_7) return undefined;
  const hours = parseWorkingHours(branch.working_hours);
  if (!hours) return undefined;
  // ПУСТОЙ ОБЪЕКТ — ЭТО «ЧАСЫ НЕ ЗАДАНЫ», А НЕ «ЗАКРЫТО ВСЕГДА», и разница
  // здесь не теоретическая: `branches.working_hours` объявлена
  // `TEXT NOT NULL DEFAULT '{}'` (миграция 002) — в отличие от users и rooms,
  // где умолчание пустая строка. То есть '{}' стоит у КАЖДОГО здания, которому
  // распорядок ни разу не открывали, и читать его как «клиника закрыта семь
  // дней в неделю» значило бы гасить расписание целого корпуса за то, что его
  // никто не настраивал. Клинику, работающую по особым дням, заводят явно —
  // экран пишет все семь ключей.
  //
  // Найдено, когда приписка врача к зданию поехала между филиалами
  // (CROSS_BRANCH_CALENDAR_V1): до этого у приехавших врачей branch_id был
  // пуст, сужать было нечем, и ловушка не срабатывала. Она и раньше стояла —
  // для местных врачей с заполненным филиалом.
  if (!WEEKDAY_KEYS.some((k) => k in hours)) return undefined;
  const entry = hours[WEEKDAY_KEYS[((weekday % 7) + 7) % 7]];
  if (!entry || typeof entry !== 'object') return null;
  if (!dayIsOn(entry)) return null;
  const from = parseHhmm(entry.from);
  const to = parseHhmm(entry.to);
  const f = from == null ? 0 : from;
  const t = to == null ? 24 * 60 : to;
  return t > f ? { from: f, to: t } : null;
}

/**
 * Сузить окно ресурса часами клиники. undefined = границы нет, null = клиника
 * закрыта (и тогда ресурс не работает, чей бы график ни говорил обратное).
 */
export function clampWindow(win, bound) {
  if (!win) return null;
  if (bound === undefined) return win;
  if (bound === null) return null;
  const from = Math.max(win.from, bound.from);
  const to = Math.min(win.to, bound.to);
  if (to <= from) return null;
  return { from, to, breaks: (win.breaks || []).filter((b) => b.to > from && b.from < to) };
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

/** Пересекаются ли полуинтервалы [aFrom,aTo) и [bFrom,bTo). Стык (14:00–14:30 и 14:30–15:00) — НЕ пересечение. */
export function overlaps(aFrom, aTo, bFrom, bTo) {
  return aFrom < bTo && bFrom < aTo;
}

/** То же в абсолютных миллисекундах — здесь часовой пояс не участвует вовсе. */
export function overlapsMs(aStartMs, aDurMin, bStartMs, bDurMin) {
  return overlaps(aStartMs, aStartMs + aDurMin * 60000, bStartMs, bStartMs + bDurMin * 60000);
}

/**
 * Свободные начала приёма внутри рабочего дня.
 *
 * @param {object}   o
 * @param {{from:number,to:number}[]} o.segments  отрезки приёма (windowSegments)
 * @param {{from:number,to:number}[]} o.busy      занятое, в минутах дня
 * @param {number}   o.durationMin                длительность услуги
 * @param {number}   o.stepMin                    шаг сетки (по умолчанию = длительности)
 * @param {number}   [o.minStartMin]              не предлагать раньше (сегодня — «сейчас»)
 * @returns {number[]} минуты от полуночи
 */
export function slotStarts({ segments, busy = [], durationMin, stepMin, minStartMin = null }) {
  const dur = Math.max(1, Math.round(Number(durationMin) || DEFAULT_DURATION_MIN));
  const step = Math.max(1, Math.round(Number(stepMin) || dur));
  const out = [];
  for (const seg of segments || []) {
    // Шаг отсчитывается ОТ НАЧАЛА ОТРЕЗКА, а не от полуночи: приём с 08:40 при
    // шаге 15 должен давать 08:40, 08:55, …, а не 08:45 (первый кратный часу).
    for (let t = seg.from; t + dur <= seg.to; t += step) {
      if (minStartMin != null && t < minStartMin) continue;
      if ((busy || []).some((b) => overlaps(t, t + dur, b.from, b.to))) continue;
      out.push(t);
    }
  }
  return out;
}

/**
 * Длительность записи в минутах. Владелец: «длительность — из услуги, по
 * умолчанию 15 мин, лабораторные — свои». Услуга без своей длительности (0 или
 * NULL в справочнике) — это не «ноль минут», а «не заполнено».
 */
export function serviceDurationMinutes(service, fallback = DEFAULT_DURATION_MIN) {
  const n = Math.round(Number(service && service.duration_minutes));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
