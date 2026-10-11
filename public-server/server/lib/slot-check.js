// PUBLIC_SERVER_V1 — СВОБОДНОЕ ВРЕМЯ ПО ПОСЛЕДНЕМУ ПРИСЛАННОМУ.
//
// Клиника шлёт по врачу дни: окно, начала по 15 минут и строку свободы
// ('1' — свободно) — services/api/snapshot.js buildSlots, тот же движок, что
// календарь. Приём длиной N минут требует ceil(N/15) окон подряд: начала идут
// одно за другим без разрыва и все свободны (документация: «consultation=initial
// — останутся только начала, после которых свободно столько окон, сколько
// длится приём»). Сегодняшнее прошедшее — не свободно.
//
// Сервер — первая линия (409 slot_taken); правду говорит клиника при приёме.
// День за пределами присланного (клиника давно не на связи, а срок записи
// сдвинулся) — 'unknown': запись принимается, решит клиника (решение 19).
import { addDays, localParts, minutesOf, hhmmOf, msOf } from './time.js';

export const SLOT_MIN = 15;
export const DEFAULT_MINUTES = 15;

export const windowsNeeded = (minutes) => Math.max(1, Math.ceil((Number(minutes) > 0 ? Number(minutes) : DEFAULT_MINUTES) / SLOT_MIN));

/** Начало i дня свободно для n окон подряд; nowMin — минуты «сейчас» (только для сегодняшнего дня), иначе null. */
function fits(day, i, n, nowMin) {
  const first = minutesOf(day.starts[i]);
  if (first == null || (nowMin != null && first < nowMin)) return false;
  for (let k = 0; k < n; k += 1) {
    if (day.starts[i + k] !== hhmmOf(first + k * SLOT_MIN) || String(day.free || '')[i + k] !== '1') return false;
  }
  return true;
}

/**
 * Окна дня для партнёра. n — сколько окон подряд нужно (null — каждое окно
 * со своей свободой). С n — только подходящие начала.
 */
export function dayWindows(day, n, { now, offsetMin }) {
  const today = localParts(now, offsetMin);
  const nowMin = day.date === today.date ? today.minutes : (day.date < today.date ? Infinity : null);
  const starts = Array.isArray(day.starts) ? day.starts : [];
  if (n == null) return starts.map((s, i) => ({ start: s, free: fits(day, i, 1, nowMin) }));
  return starts.map((s, i) => ({ start: s, free: fits(day, i, n, nowMin) })).filter((w) => w.free);
}

/**
 * Свободно ли начало startMs у врача на n окон по присланному времени.
 * @returns {'free'|'taken'|'unknown'}
 */
export function slotState(slots, doctor, startMs, n, { now, offsetMin }) {
  const d = slots && slots.doctors ? slots.doctors[String(doctor.id)] : null;
  const at = localParts(startMs, offsetMin);
  const generated = msOf(slots && slots.generated_at);
  const horizon = Number(doctor.booking_days) > 0 ? Number(doctor.booking_days) : 14;
  if (!d || generated == null) return 'unknown';
  const covered = addDays(localParts(generated, offsetMin).date, horizon - 1);
  if (at.date > covered) return 'unknown';
  const day = (Array.isArray(d.days) ? d.days : []).find((x) => x.date === at.date);
  if (!day) return 'taken';
  const i = (day.starts || []).indexOf(at.hhmm);
  if (i < 0) return 'taken';
  const today = localParts(now, offsetMin);
  return fits(day, i, n, day.date === today.date ? today.minutes : null) ? 'free' : 'taken';
}
