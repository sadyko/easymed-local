// PROCUREMENT_FILTERS_V1 (2026-09-25) — ФИЛЬТР КАТЕГОРИЙ ЗАКУПОК, КОТОРЫЙ
// КАЖДЫЙ ОТМЕЧАЕТ САМ.
//
// Владелец: «in the procurement we need to add filters for category so users
// can filter their procurement based off their responsibilities», а на вопрос,
// не назначать ли категории людям: «no just show filters so user ticks his own
// and manage statistics». Отсюда три правила этого модуля:
//
//   1. ЭТО НЕ НАЗНАЧЕНИЕ И НЕ ОГРАНИЧЕНИЕ. Никто не решает за человека, что ему
//      видно: он сам отмечает категории, «Все» снимает отметки. Сервер ничего
//      не запрещает — он только отбирает то, что попросили.
//   2. ВЫБОР ЗАПОМИНАЕТСЯ ЗА ЧЕЛОВЕКОМ, А НЕ ЗА КОМПЬЮТЕРОМ. Память — в
//      localStorage, то есть в браузере, а компьютеры в клинике общие: за одним
//      ПК сидят кладовщик и провизор. Поэтому ключ несёт id вошедшего
//      (window.easymed.state.user.id), и отметки одного не встречают другого.
//      Нет вошедшего — нечего и запоминать. Любой доступ к хранилищу — в
//      try/catch: закрытое хранилище значит «без памяти», а не «экран упал».
//   3. ОДИН ВЫБОР НА ВСЕ ЭКРАНЫ ЗАКУПОК. «Склад», «Товары» и «Сроки годности»
//      читают один и тот же ключ: человек отмечает свои категории один раз, а
//      не на каждой вкладке заново.
//
// Итоги и счётчики на экранах считаются ПО ОТОБРАННЫМ строкам — это забота
// экранов (inventory-sklad.js, inventory-products.js, inventory-expiry.js);
// здесь — только выбор, его память и правило «подходит ли товар».
import { h, Icon } from '../ui.js';
import { CATEGORY_LABEL } from './inventory-shared.js';

export const CATEGORY_KEYS = Object.keys(CATEGORY_LABEL);

const KEY_PREFIX = 'easymed.procurement.categories.v1.u';

/** Кто вошёл — или null. */
function currentUserId() {
    try {
        const u = (typeof window !== 'undefined' && window.easymed && window.easymed.state && window.easymed.state.user) || null;
        const id = u ? u.id : null;
        return id === null || id === undefined || id === '' ? null : String(id);
    } catch (e) { return null; }
}

/** Ключ памяти ДЛЯ ЭТОГО человека; без вошедшего — null (запоминать не за кем). */
export function categoryStorageKey(userId = currentUserId()) {
    return userId === null || userId === undefined || userId === '' ? null : KEY_PREFIX + String(userId);
}

function storage() {
    try { return (typeof window !== 'undefined' && window.localStorage) || null; } catch (e) { return null; }
}

/** Только настоящие категории, без повторов, в порядке каталога. */
export function cleanCategories(list) {
    const set = new Set(Array.isArray(list) ? list : []);
    return CATEGORY_KEYS.filter((k) => set.has(k));
}

/** Отметки вошедшего; нет вошедшего, нет памяти или она испорчена — «все» ([]). */
export function loadCategories() {
    const key = categoryStorageKey();
    const ls = storage();
    if (!key || !ls) return [];
    try {
        const raw = ls.getItem(key);
        return raw ? cleanCategories(JSON.parse(raw)) : [];
    } catch (e) { return []; }
}

/** Запомнить отметки за вошедшим. «Все» — ключ убирается. */
export function saveCategories(list) {
    const key = categoryStorageKey();
    const ls = storage();
    if (!key || !ls) return;
    const clean = cleanCategories(list);
    try {
        if (clean.length) ls.setItem(key, JSON.stringify(clean));
        else if (typeof ls.removeItem === 'function') ls.removeItem(key);
    } catch (e) { /* без памяти — просто не запомним */ }
}

/** Подходит ли товар под отметки. Пусто — подходит всё. */
export function matchesCategories(product, selected) {
    if (!selected || !selected.length) return true;
    return selected.includes(product && product.procurement_category);
}

const pillBase = {
    height: '30px', padding: '0 12px', borderRadius: '999px', cursor: 'pointer',
    fontFamily: 'inherit', fontSize: '12.5px', fontWeight: 600,
    display: 'inline-flex', alignItems: 'center', gap: '4px',
};
function paintPill(btn, on) {
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    Object.assign(btn.style, {
        border: '1px solid ' + (on ? 'var(--primary-600)' : 'var(--ink-200)'),
        background: on ? 'var(--primary-50)' : 'var(--white, #fff)',
        color: on ? 'var(--primary-700)' : 'var(--ink-700)',
    });
    if (btn._check) btn._check.style.display = on ? '' : 'none';
}

/**
 * Строка отметок: «Все» + восемь категорий. Отметка — кнопка-переключатель
 * (aria-pressed), несколько сразу; «Все» снимает все отметки. Выбор сразу
 * запоминается за вошедшим и отдаётся экрану через onChange(список).
 *
 * Кнопки не пересоздаются при нажатии — меняется только их вид: фокус
 * остаётся на той, которую нажали.
 */
export function categoryFilter({ selected = [], onChange } = {}) {
    let current = cleanCategories(selected);
    const allBtn = h('button', { type: 'button', class: 'cat-pill', style: pillBase }, 'Все');
    const btns = CATEGORY_KEYS.map((key) => {
        const check = Icon('Check', { size: 12 });
        const b = h('button', { type: 'button', class: 'cat-pill', 'data-category': key, style: pillBase },
            check, CATEGORY_LABEL[key]);
        b._check = check;
        b._key = key;
        return b;
    });
    function repaint() {
        paintPill(allBtn, !current.length);
        for (const b of btns) paintPill(b, current.includes(b._key));
    }
    function set(next) {
        current = cleanCategories(next);
        saveCategories(current);
        repaint();
        if (typeof onChange === 'function') onChange(current.slice());
    }
    allBtn.addEventListener('click', () => { if (current.length) set([]); });
    for (const b of btns) {
        b.addEventListener('click', () => set(current.includes(b._key)
            ? current.filter((k) => k !== b._key)
            : [...current, b._key]));
    }
    repaint();
    return h('div', {
        class: 'cat-filter', role: 'group', 'aria-label': 'Категории',
        style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px' },
    },
        h('span', { class: 'muted', style: { fontSize: '12.5px', fontWeight: 600, marginRight: '4px' } }, 'Категории'),
        allBtn, ...btns);
}
