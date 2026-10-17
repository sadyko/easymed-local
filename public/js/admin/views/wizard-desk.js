// ═══════════════════════════════════════════════════════════════════════════
// CRM_LINK_ALL_V1 (2026-10-16) — R3, РЕШЕНИЕ ВЛАДЕЛЬЦА D2: «СЕЙЧАС» У СТОЙКИ
// ═══════════════════════════════════════════════════════════════════════════
//
// Регистрация мастером визита на СЕГОДНЯ «сейчас» — это приход к стойке, как
// быстрая регистрация: карточка CRM сразу в «Пришёл». «Сейчас» — день визита
// сегодня И (у дня нет слота — живая очередь, услуги без времени — ИЛИ слот
// начинается не позже чем через DESK_NOW_MINUTES минут). Слот позже сегодня —
// запись: карточка «Записан», пока пациент не придёт.
//
// Одно правило на двух сторонах: экран (visit-wizard.js) решает, слать ли
// desk: true, сервер (server/services/rpc/visits.js ensure_visit) — верить ли
// ему у записи на время. Чистая функция: без DOM, без базы.
export const DESK_NOW_MINUTES = 30;

/**
 * @param {{dayIso: string, todayIso: string, headStartMs?: number|null, nowMs: number}} p
 *   dayIso — местный день визита 'YYYY-MM-DD'; todayIso — сегодняшний местный
 *   день; headStartMs — начало слота дня (null — слота нет); nowMs — сейчас.
 * @returns {boolean}
 */
export function isDeskNow({ dayIso, todayIso, headStartMs = null, nowMs } = {}) {
  if (!dayIso || !todayIso || String(dayIso).slice(0, 10) !== String(todayIso).slice(0, 10)) return false;
  if (headStartMs == null) return true;
  const start = Number(headStartMs);
  const now = Number(nowMs);
  if (!Number.isFinite(start) || !Number.isFinite(now)) return false;
  return start <= now + DESK_NOW_MINUTES * 60000;
}
