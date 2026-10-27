// NAV_VISIBILITY_V1 (2026-10-26) — видимость разделов бокового меню для всей
// клиники: чистая логика, общая для сервера (rpc/nav-visibility.js проверяет и
// нормализует список) и оболочки (admin.js прячет пункты и экраны).
//
// Владелец: «in here [Настройки → Основное] build visibility setting of
// functions from here, only setting block can not be unvisible». Скрытый
// раздел исчезает из меню у ВСЕХ сотрудников клиники, какие бы права у них ни
// были; права ролей он не меняет и не заменяет — это «чего у нас в клинике
// нет», а не «кому что можно». «Настройки» скрыть нельзя: иначе негде было бы
// это вернуть.

export const NEVER_HIDDEN = Object.freeze(['settings']);
const ID_RE = /^[a-z][a-z0-9-]{0,40}$/;

/** Годный идентификатор пункта меню: как id в NAV (admin.js). */
export function isNavIdLike(v) {
    return typeof v === 'string' && ID_RE.test(v);
}

/** Список скрытых: только годные id, без «Настроек», без повторов, по алфавиту. */
export function normalizeHidden(list) {
    const out = new Set();
    for (const v of Array.isArray(list) ? list : []) {
        if (!isNavIdLike(v) || NEVER_HIDDEN.includes(v)) continue;
        out.add(v);
    }
    return [...out].sort();
}

/**
 * Скрыт ли экран: сам пункт меню или пункт, частью которого экран является
 * (parentOf — PARENT_OF оболочки: карта пациента → «Пациенты»). Подэкраны
 * «Настроек» не прячутся вместе с родителем, потому что родитель не прячется.
 */
export function isHiddenView(view, hidden, parentOf = () => null) {
    if (!view) return false;
    const v = String(view);
    if (NEVER_HIDDEN.includes(v)) return false;
    const set = hidden instanceof Set ? hidden : new Set(normalizeHidden(hidden));
    if (set.has(v)) return true;
    const parent = parentOf(v);
    return !!(parent && !NEVER_HIDDEN.includes(parent) && set.has(parent));
}

/**
 * Группы меню из NAV (admin.js): [{ section, items:[{ id, label, foldsInto }] }].
 * Пункты до первого заголовка — группа без имени (section: null).
 */
export function navGroups(nav) {
    const groups = [];
    let cur = null;
    for (const item of Array.isArray(nav) ? nav : []) {
        if (item && item.section) { cur = { section: item.section, items: [] }; groups.push(cur); continue; }
        if (!item || !item.id) continue;
        if (!cur) { cur = { section: null, items: [] }; groups.push(cur); }
        cur.items.push({ id: item.id, label: item.label || item.id, foldsInto: item.foldsInto || null });
    }
    return groups.filter((g) => g.items.length);
}

/** Пункт можно скрыть? «Настройки» — нет. */
export function canHide(id) {
    return isNavIdLike(id) && !NEVER_HIDDEN.includes(id);
}

/** Новый список скрытых после переключения одного пункта. */
export function withHidden(hidden, id, hide) {
    const set = new Set(normalizeHidden(hidden));
    if (hide && canHide(id)) set.add(id); else set.delete(id);
    return [...set].sort();
}
