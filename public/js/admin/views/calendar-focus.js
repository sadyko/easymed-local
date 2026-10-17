// CRM_LINK_ALL_V1 (редакция 2, 2026-10-16) — «ОТКРЫТЬ В КАЛЕНДАРЕ» ИЗ ДРУГОГО ОКНА.
//
// Карточка CRM («Записи пациента») открывает календарь записи на дне записи.
// Календарь (room-calendar.js) всегда открывается на сегодня; окно, которое
// зовёт его, кладёт сюда день (и визит) перед переходом, календарь забирает их
// один раз при первой отрисовке. Минута — срок: устаревшая просьба (вкладку
// закрыли, переход не случился) не уводит следующее открытие календаря в чужой
// день. Хранение — sessionStorage этой вкладки; нет его — просто «сегодня».
const KEY = 'em.calendar.focus';
const TTL_MS = 60 * 1000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function store() {
    try { return typeof sessionStorage === 'undefined' ? null : sessionStorage; }
    catch (e) { return null; }
}

/** Просьба открыть календарь на дне `day` ('YYYY-MM-DD'), по желанию — у визита `visitId`. */
export function setCalendarFocus({ day, visitId = null } = {}, now = Date.now()) {
    if (!DAY_RE.test(String(day || ''))) return false;
    const s = store();
    if (!s) return false;
    try {
        s.setItem(KEY, JSON.stringify({ day: String(day), visitId: Number(visitId) || null, at: now }));
        return true;
    } catch (e) { return false; }
}

/** Забрать просьбу (один раз): { day, visitId } или null. */
export function takeCalendarFocus(now = Date.now()) {
    const s = store();
    if (!s) return null;
    let raw = null;
    try { raw = s.getItem(KEY); s.removeItem(KEY); } catch (e) { return null; }
    if (!raw) return null;
    try {
        const o = JSON.parse(raw);
        if (!o || !DAY_RE.test(String(o.day || '')) || !(now - Number(o.at) < TTL_MS) || Number(o.at) > now + TTL_MS) return null;
        return { day: o.day, visitId: Number(o.visitId) || null };
    } catch (e) { return null; }
}
