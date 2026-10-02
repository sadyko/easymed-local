// CABINET_FIX_V1_R5 (ревью 5, A) — ЗАПИСИ КАБИНЕТА ВРАЧА: ПРАВИЛО ОДНО ДЛЯ
// СЕРВЕРА И ЭКРАНА.
//
// Записи кабинета (visit_services.notes) — JSON с меткой __service_workspace_v1
// и историей версий (черновики, направления, подписанные версии). Браузер пишет
// их целиком. Окно со старой копией писало поверх более новой записи:
// черновики — «кто последний, тот и прав», подписанная версия терялась (вторая
// вкладка, другой компьютер, подпись, дошедшая после срока). Теперь каждая
// запись записей кабинета несёт ОСНОВУ — отпечаток сохранённых notes, с которых
// её сделали (поле __notes_base рядом с notes). Сервер сравнивает основу с тем,
// что лежит у строки («сравнить и заменить»):
//   • у строки лежит JSON кабинета — запись обязана быть JSON кабинета (метка 1,
//     массив history), с совпавшей основой и со всеми подписанными версиями
//     (сверка по savedAt); иначе отказ;
//   • у строки не JSON кабинета (пусто, текст других экранов) — запись без
//     основы проходит как прежде; с основой — основа должна совпасть (две
//     «первые» записи из двух окон: вторая видит первую).
// Чистые функции без DOM: их импортируют и сервер (routes/db.js,
// rpc/procedures.js), и кабинет (service-workspace.js), и проверки.
export const NOTES_TAG = '__service_workspace_v1';
export const NOTES_BASE_KEY = '__notes_base';

// cyrb53 — быстрый 53-битный отпечаток строки (одинаковый в Node и браузере).
function cyrb53(str, seed = 0) {
    let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < str.length; i++) {
        const ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}
/** Основа записи — отпечаток сохранённых notes ровно как строки (пусто/NULL — 'empty'). */
export function notesBaseOf(raw) {
    if (raw == null || raw === '') return 'empty';
    const s = String(raw);
    return 'h' + cyrb53(s).toString(36) + '.' + s.length.toString(36);
}
function parse(raw) {
    if (typeof raw !== 'string' || !raw) return null;
    try { const p = JSON.parse(raw); return p && typeof p === 'object' && !Array.isArray(p) ? p : null; } catch { return null; }
}
/** Сохранённые notes — записи кабинета (метка есть; историю проверяет signedVersionsDropped). */
export function storedIsCabinet(raw) {
    const p = parse(raw);
    return !!(p && p[NOTES_TAG]);
}
/** Новые notes — правильные записи кабинета: метка 1 и массив history. */
function validCabinet(raw) {
    const p = parse(raw);
    return p && p[NOTES_TAG] === 1 && Array.isArray(p.history) ? p : null;
}
const signedOf = (p) => (p && Array.isArray(p.history) ? p.history : []).filter((e) => e && e.kind === 'signed').map((e) => String(e.savedAt));
/** true — новая запись notes потеряла подписанную версию, сохранённую у строки (сверка по savedAt). */
export function signedVersionsDropped(storedRaw, nextRaw) {
    const prev = parse(storedRaw);
    if (!prev || !prev[NOTES_TAG]) return false;
    const next = validCabinet(nextRaw);
    if (!next) return signedOf(prev).length > 0;
    const kept = new Set(signedOf(next));
    return signedOf(prev).some((s) => !kept.has(s));
}

export const NOTES_CONFLICT_MESSAGE = 'Документ изменился в другом окне или раньше этого сохранения — обновите его и сохраните ещё раз.';
export const NOTES_NOT_CABINET_MESSAGE = 'В строке — документ кабинета врача; эта правка стёрла бы его.';
/**
 * Отказ записи notes по правилу «сравнить и заменить» — null или
 * { reason: 'stale' | 'not_cabinet' | 'signed_dropped', message }.
 */
export function notesWriteRefusal(storedRaw, nextValue, base) {
    if (!storedIsCabinet(storedRaw)) {
        if (base != null && base !== notesBaseOf(storedRaw)) return { reason: 'stale', message: NOTES_CONFLICT_MESSAGE };
        return null;
    }
    if (base == null || base !== notesBaseOf(storedRaw)) return { reason: 'stale', message: NOTES_CONFLICT_MESSAGE };
    if (!validCabinet(typeof nextValue === 'string' ? nextValue : null)) return { reason: 'not_cabinet', message: NOTES_NOT_CABINET_MESSAGE };
    if (signedVersionsDropped(storedRaw, nextValue)) return { reason: 'signed_dropped', message: NOTES_CONFLICT_MESSAGE };
    return null;
}

// CABINET_FIX_V1_R5 (ревью 5, B) — ЗАМЕТКА МЕДСЕСТРЫ («Выполнено» процедуры). У
// строки с записями кабинета она ложится в тот же JSON под своим ключом
// (nurseNote) — документ врача не трогается; у прочих строк — как прежде,
// текстом. Пустая заметка снимает ключ.
export function mergeNurseNote(storedRaw, note) {
    const text = typeof note === 'string' ? note.trim() : '';
    const p = parse(storedRaw);
    if (p && p[NOTES_TAG]) {
        if (text) p.nurseNote = text; else delete p.nurseNote;
        return JSON.stringify(p);
    }
    return text || null;
}
/** Заметка медсестры из notes строки: из JSON кабинета — его nurseNote, иначе текст как есть. */
export function nurseNoteOf(raw) {
    const p = parse(raw);
    if (p && p[NOTES_TAG]) return typeof p.nurseNote === 'string' ? p.nurseNote : '';
    return raw == null ? '' : String(raw);
}
