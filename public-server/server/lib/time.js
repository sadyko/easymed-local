// PUBLIC_SERVER_V1 — время для партнёров: местное время клиники со смещением
// (документация API: «время — Ташкент, UTC+5»). Смещение — настройка
// PUBLIC_TZ_OFFSET_MIN (300); тесты ставят смещение своего процесса, потому что
// клиника в том же процессе считает дни и часы в нём. Внутри — мгновения UTC.
import { isoOf, localIso } from '../../../public/js/shared/api-booking.js';

export { isoOf, localIso };

const p2 = (n) => String(n).padStart(2, '0');

/** Мгновение из строки; неверное — null. */
export const msOf = (v) => { const t = Date.parse(String(v == null ? '' : v)); return Number.isFinite(t) ? t : null; };

/** Местные дата, 'ЧЧ:ММ' и минуты от полуночи мгновения ms. */
export function localParts(ms, offsetMin) {
  const d = new Date(ms + offsetMin * 60000);
  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes();
  return {
    date: `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`,
    hhmm: `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`,
    minutes,
    seconds: d.getUTCSeconds(),
  };
}

/** 'YYYY-MM-DD' + n дней. */
export function addDays(dayIso, n) {
  const [y, m, d] = String(dayIso).split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${p2(t.getUTCMonth() + 1)}-${p2(t.getUTCDate())}`;
}

/** 'ЧЧ:ММ' → минуты от полуночи; неверное — null. */
export function minutesOf(hhmm) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(hhmm || ''));
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  return h < 24 && mi < 60 ? h * 60 + mi : null;
}

/** Минуты от полуночи → 'ЧЧ:ММ'. */
export const hhmmOf = (minutes) => `${p2(Math.floor(minutes / 60))}:${p2(minutes % 60)}`;

/** Местные дата и 'ЧЧ:ММ' → мгновение UTC. */
export function localMsOf(dayIso, hhmm, offsetMin) {
  const [y, m, d] = String(dayIso).split('-').map(Number);
  return Date.UTC(y, m - 1, d) + minutesOf(hhmm) * 60000 - offsetMin * 60000;
}

/**
 * Время от партнёра: со смещением или Z — как есть; без смещения
 * ('2030-03-12T09:00') — местное время клиники (документация: «время —
 * Ташкент»), а не пояс машины сервера. Неверное — null.
 */
export function msOfPartner(v, offsetMin) {
  const s = String(v == null ? '' : v).trim();
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::(\d{2}))?$/.exec(s);
  if (m) {
    if (minutesOf(m[2]) == null || Number(m[3] || 0) > 59) return null;
    const t = localMsOf(m[1], m[2], offsetMin) + Number(m[3] || 0) * 1000;
    return localParts(t, offsetMin).date === m[1] ? t : null;
  }
  return /(Z|[+-]\d{2}:?\d{2})$/i.test(s) ? msOf(s) : null;
}

/** Мгновение-строка (UTC из базы) → местное со смещением; пусто — null. */
export function partnerTime(iso, offsetMin) {
  const ms = msOf(iso);
  return ms == null ? null : localIso(ms, offsetMin);
}
