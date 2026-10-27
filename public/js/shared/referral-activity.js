// REFERRALS_CRM_V1 (2026-10-26) — активность врача-источника: одно правило для
// сервера (rpc/referrals.js считает статус) и экрана (вкладка «Активность
// врачей» рисует его). Лежит в shared/, как referral-reward.js, и по той же
// причине: два места, считающие «затихает» по-разному, — это спор с владельцем
// о том, какой экран врёт.
//
// Снимок владельца показывает четыре плитки: Активные · Затихают · Пассивные ·
// Ни разу не направляли. Окна фиксированные и не зависят от выбранного на
// экране периода (7 / 30 / 90 дней меняет только две колонки счёта):
//   active  — был визит за последние 30 дней;
//   fading  — за 30 дней не было, за 31–90 — был;
//   passive — за 90 дней не было, но когда-то были;
//   never   — визитов не было вовсе.
// «Визит» — визит со статусом не cancelled / no_show, источник которого
// (COALESCE(visit, patient)) — этот врач.

export const ACTIVITY_WINDOWS = Object.freeze([7, 30, 90]);
export const ACTIVITY_STATUSES = Object.freeze(['active', 'fading', 'passive', 'never']);

export function activityStatus({ last30 = 0, last90 = 0, total = 0 } = {}) {
    if (!(Number(total) > 0)) return 'never';
    if (Number(last30) > 0) return 'active';
    if (Number(last90) > 0) return 'fading';
    return 'passive';
}

/** Выбранное окно: число из ACTIVITY_WINDOWS, иначе 30. */
export function normalizeWindow(days) {
    const n = Number(days);
    return ACTIVITY_WINDOWS.includes(n) ? n : 30;
}

/** Динамика «за N дней» против «прошлых N дней»: знак и величина. */
export function dynamics(cur, prev) {
    const delta = (Number(cur) || 0) - (Number(prev) || 0);
    return { delta, kind: delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat' };
}

/** Разница в днях между двумя датами ГГГГ-ММ-ДД (b − a), без часовых поясов. */
export function daysBetween(a, b) {
    const pa = parseYmd(a), pb = parseYmd(b);
    if (!pa || !pb) return NaN;
    return Math.round((Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d)) / 86400000);
}

function parseYmd(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
    return m ? { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) } : null;
}

/**
 * Счётчики одного врача по дням его визитов (ГГГГ-ММ-ДД, локальные) на дату
 * `today`: всего, последний день, за окно N, за прошлое окно N, за 30 и за 90.
 * Дни после `today` (запись на будущее) не считаются: это ещё не направление.
 */
export function activityCounters(days, today, windowDays) {
    const N = normalizeWindow(windowDays);
    let total = 0, last = null, cur = 0, prev = 0, last30 = 0, last90 = 0;
    for (const day of days || []) {
        const ago = daysBetween(day, today);   // 0 = сегодня
        if (!Number.isFinite(ago) || ago < 0) continue;
        total += 1;
        if (last === null || day > last) last = day;
        if (ago < N) cur += 1;
        else if (ago < 2 * N) prev += 1;
        if (ago < 30) last30 += 1;
        if (ago < 90) last90 += 1;
    }
    return { total, last, cur, prev, last30, last90, status: activityStatus({ last30, last90, total }) };
}
