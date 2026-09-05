// UI_SELECT_V1 (2026-09-05) — ВЫПАДАЮЩИЙ СПИСОК ПРОГРАММЫ, А НЕ ВЫПАДАЮЩИЙ
// СПИСОК ОПЕРАЦИОННОЙ СИСТЕМЫ.
//
// Владелец: «please fix the dialogue windows and dropdowns and calendar
// pickers design. its the default dropdowns. not a system design dropdowns».
//
// Список <select> в открытом виде рисует Windows, а не страница: ни шрифт, ни
// цвет выделения (ярко-синий), ни скругления, ни отступы правилами CSS не
// достаются — это окно другого процесса. Поэтому единственный способ дать ему
// вид продукта — рисовать список самим.
//
// РОДНОЕ ПОЛЕ НЕ ВЫБРАСЫВАЕТСЯ. Оно прячется и остаётся ИСТОЧНИКОМ ПРАВДЫ:
// сто пятьдесят мест в программе читают `sel.value`, слушают `change` и
// дописывают <option> после загрузки — ни одно из них менять не нужно, и это
// же страховка: сломайся обёртка, значение всё равно лежит в настоящем поле.
// (Тот же приём, что у phone-input.js и searchable-select.js.)
//
// ЧТО ЗДЕСЬ ОСОЗНАННО СДЕЛАНО ИНАЧЕ, ЧЕМ У РОДНОГО ПОЛЯ:
//   • Поиск появляется только когда вариантов больше восьми. У списка из трёх
//     строк поле поиска — лишний шаг и лишний вид «сложного» интерфейса.
//   • Список рисуется в <body> с position: fixed. Внутри диалога он иначе
//     обрезается по краю окна (overflow), и половина вариантов оказывается за
//     границей — ровно то, чего у родного поля не бывает и чего пользователь
//     не простит.
//   • Варианты перечитываются при КАЖДОМ открытии: половина списков в
//     программе дозагружается запросом, и копия, снятая один раз при
//     создании, показывала бы пустоту.

import { h, Icon } from './ui.js';
import { tr } from './i18n.js';
import { filterByLabel } from '../shared/text-match.js?v=tm1';

const SEARCH_FROM = 8;   // вариантов, начиная с которых показываем поиск

/**
 * Слежение за ПРИСВОЕНИЕМ `el.value = …`.
 *
 * Половина форм ставит значение прямо, без события: `sel.value = row.doctor_id`
 * при предзаполнении, `input.value = today` у фильтра. События при этом не
 * возникает (так устроен DOM), и подпись поля осталась бы от прошлого
 * значения — то есть на экране было бы написано одно, а в форму ушло бы
 * другое. Наблюдатель за атрибутами этого не ловит: свойство и атрибут у
 * полей ввода — разные вещи.
 *
 * Перехват ставится НА ЭКЗЕМПЛЯР, поверх штатного описателя прототипа:
 * поведение самого поля не меняется, добавляется только уведомление.
 */
export function watchValue(el, onSet) {
    const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
    if (!desc || !desc.set || !desc.get) return false;
    Object.defineProperty(el, 'value', {
        configurable: true, enumerable: true,
        get() { return desc.get.call(this); },
        set(v) { desc.set.call(this, v); try { onSet(); } catch (e) { /* подпись — не повод ломать форму */ } },
    });
    return true;
}

/** Все открытые списки: второй открывается — первый закрывается. */
let openInstance = null;

function readOptions(sel) {
    return [...sel.options].map((o) => ({
        value: o.value,
        label: (o.textContent || '').trim(),
        disabled: !!o.disabled,
        // Пустой вариант — это ПОДСКАЗКА («— не выбрано —»), а не выбор.
        // В списке он показывается отдельной строкой сброса, а не наравне
        // с настоящими значениями.
        blank: o.value === '',
    }));
}

function labelFor(sel, opts) {
    const cur = opts.find((o) => o.value === sel.value);
    return cur && !cur.blank ? cur.label : '';
}

/**
 * Превращает готовый <select> в список программы.
 * Возвращает обёртку, которая уже стоит на месте поля (или null, если поле
 * трогать не надо: multiple, size, помечено data-no-enhance или уже обёрнуто).
 */
export function enhanceSelect(sel) {
    if (!sel || sel.tagName !== 'SELECT') return null;
    if (sel.multiple || (sel.size && sel.size > 1)) return null;
    if (sel.dataset.uiSelect === 'on' || sel.dataset.noEnhance != null) return null;
    if (sel.closest && sel.closest('[data-no-enhance]')) return null;
    sel.dataset.uiSelect = 'on';

    const valueEl = h('span', { class: 'uisel-val' });
    const field = h('button', {
        type: 'button', class: 'uisel-field',
        'aria-haspopup': 'listbox', 'aria-expanded': 'false',
    }, valueEl, h('span', { class: 'uisel-caret' }, Icon('ChevronDown', { size: 14 })));

    const wrap = h('div', { class: 'uisel' }, field);
    // Поле встаёт НА МЕСТО select'а, а select уезжает внутрь: разметка вокруг
    // (сетки форм, соседи по строке) продолжает видеть один элемент там же.
    if (sel.parentNode) sel.parentNode.insertBefore(wrap, sel);
    wrap.appendChild(sel);
    sel.classList.add('uisel-native');

    const placeholder = () => {
        const blank = readOptions(sel).find((o) => o.blank);
        return (blank && blank.label) || tr('Не выбрано');
    };

    function paintField() {
        const opts = readOptions(sel);
        const label = labelFor(sel, opts);
        valueEl.textContent = label || placeholder();
        valueEl.classList.toggle('is-empty', !label);
        field.disabled = !!sel.disabled;
        wrap.classList.toggle('is-disabled', !!sel.disabled);
        const title = sel.getAttribute('title');
        if (title) field.setAttribute('title', title);
    }

    // Список строится заново на каждое открытие — см. шапку файла.
    let list = null, searchInput = null, rows = [], active = -1, reposition = null;

    function close() {
        if (!list) return;
        list.remove(); list = null; searchInput = null; rows = []; active = -1;
        field.setAttribute('aria-expanded', 'false');
        if (reposition) {
            window.removeEventListener('scroll', reposition, true);
            window.removeEventListener('resize', reposition);
            reposition = null;
        }
        document.removeEventListener('mousedown', onOutside, true);
        document.removeEventListener('keydown', onKey, true);
        if (openInstance === close) openInstance = null;
    }

    function onOutside(e) {
        if (list && !list.contains(e.target) && !wrap.contains(e.target)) close();
    }

    function pick(o) {
        if (!o || o.disabled) return;
        if (sel.value === o.value) { close(); field.focus(); return; }
        sel.value = o.value;
        // И input, и change: часть форм слушает одно, часть — другое, а родной
        // <select> при выборе мышью посылает оба.
        sel.dispatchEvent(new Event('input', { bubbles: true }));
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        paintField();
        close();
        field.focus();
    }

    function paintRows(query) {
        const body = list.querySelector('.uisel-rows');
        body.replaceChildren();
        const all = readOptions(sel);
        const real = all.filter((o) => !o.blank);
        rows = query ? filterByLabel(real, query) : real;

        // Сброс выбора — отдельной строкой сверху и только когда есть что
        // сбрасывать: строка «— не выбрано —» в пустом списке ничего не делает.
        const blank = all.find((o) => o.blank);
        if (blank && !query && sel.value !== '') {
            body.appendChild(h('div', {
                class: 'uisel-row is-clear', role: 'option',
                onmousedown: (e) => { e.preventDefault(); pick(blank); },
            }, blank.label || tr('Не выбрано')));
        }
        if (!rows.length) {
            body.appendChild(h('div', { class: 'uisel-empty' },
                tr(query ? 'Ничего не найдено' : 'Список пуст')));
            return;
        }
        rows.forEach((o, i) => {
            const on = o.value === sel.value;
            body.appendChild(h('div', {
                class: 'uisel-row' + (on ? ' is-on' : '') + (i === active ? ' is-active' : '')
                    + (o.disabled ? ' is-off' : ''),
                role: 'option', 'aria-selected': on ? 'true' : 'false',
                onmouseenter: () => { active = i; markActive(); },
                // mousedown, а не click: поле теряет фокус раньше клика.
                onmousedown: (e) => { e.preventDefault(); pick(o); },
            }, h('span', { class: 'uisel-row-t' }, o.label),
               on ? h('span', { class: 'uisel-row-c' }, Icon('Check', { size: 13 })) : null));
        });
    }

    function markActive() {
        const body = list && list.querySelector('.uisel-rows');
        if (!body) return;
        // Строка сброса в счёт не идёт: стрелки ходят по настоящим вариантам,
        // и её подсветка сбивала бы нумерацию rows[active].
        const items = [...body.querySelectorAll('.uisel-row:not(.is-clear)')];
        items.forEach((el, i) => el.classList.toggle('is-active', i === active));
        const el = items[active];
        if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
    }

    function place() {
        if (!list) return;
        const r = field.getBoundingClientRect();
        const vh = window.innerHeight || 800;
        const below = vh - r.bottom - 8;
        const above = r.top - 8;
        // Список открывается вверх, когда снизу места меньше: иначе он упирается
        // в край экрана и прокручивается по три строки за раз.
        const up = below < 200 && above > below;
        list.style.left = Math.max(8, Math.min(r.left, (window.innerWidth || 1200) - r.width - 8)) + 'px';
        list.style.minWidth = r.width + 'px';
        list.style.maxHeight = Math.max(140, (up ? above : below)) + 'px';
        if (up) { list.style.top = 'auto'; list.style.bottom = (vh - r.top + 4) + 'px'; }
        else { list.style.bottom = 'auto'; list.style.top = (r.bottom + 4) + 'px'; }
    }

    function onKey(e) {
        if (!list) return;
        if (e.key === 'Escape') { e.preventDefault(); close(); field.focus(); return; }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            if (!rows.length) return;
            active = Math.max(0, Math.min(rows.length - 1, active + (e.key === 'ArrowDown' ? 1 : -1)));
            markActive();
            return;
        }
        if (e.key === 'Enter') { e.preventDefault(); pick(rows[active]); return; }
        if (e.key === 'Tab') close();
    }

    function open() {
        if (list || sel.disabled) return;
        if (openInstance) openInstance();
        const all = readOptions(sel).filter((o) => !o.blank);
        list = h('div', { class: 'uisel-pop', role: 'listbox' });
        if (all.length >= SEARCH_FROM) {
            // Поле создаётся НЕ через h(): h() узнаёт поисковое поле по
            // подсказке «Поиск…» и вешает на ввод задержку (SEARCH_DEBOUNCE_V1).
            // Задержка нужна там, где каждый символ уходит запросом; здесь
            // отбор идёт по уже загруженным вариантам, и четверть секунды
            // ожидания на каждую букву — это залипающий на ощупь список.
            searchInput = document.createElement('input');
            searchInput.type = 'text';
            searchInput.className = 'uisel-search';
            searchInput.autocomplete = 'off';
            searchInput.setAttribute('placeholder', tr('Поиск…'));
            searchInput.addEventListener('input', () => { active = -1; paintRows(searchInput.value.trim()); });
            searchInput.addEventListener('keydown', onKey);
            list.appendChild(h('div', { class: 'uisel-searchbox' },
                Icon('Search', { size: 13 }), searchInput));
        }
        list.appendChild(h('div', { class: 'uisel-rows' }));
        document.body.appendChild(list);
        active = Math.max(0, all.findIndex((o) => o.value === sel.value));
        paintRows('');
        place();
        markActive();
        field.setAttribute('aria-expanded', 'true');
        reposition = () => place();
        window.addEventListener('scroll', reposition, true);
        window.addEventListener('resize', reposition);
        document.addEventListener('mousedown', onOutside, true);
        document.addEventListener('keydown', onKey, true);
        openInstance = close;
        if (searchInput) searchInput.focus();
    }

    field.addEventListener('click', () => { if (list) close(); else open(); });
    field.addEventListener('keydown', (e) => {
        if (list) return;
        if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
    // Значение и состав списка меняют снаружи: форму предзаполняют, варианты
    // дозагружают запросом. Без наблюдателя поле показывало бы старую подпись.
    sel.addEventListener('change', paintField);
    watchValue(sel, paintField);
    if (typeof MutationObserver === 'function') {
        new MutationObserver(paintField).observe(sel, {
            childList: true, subtree: true, attributes: true,
            attributeFilter: ['disabled', 'title'],
        });
    }

    paintField();
    return wrap;
}

/** Обновляет ВСЕ поля внутри узла. Возвращает число обёрнутых. */
export function enhanceSelectsIn(root) {
    if (!root || !root.querySelectorAll) return 0;
    let n = 0;
    for (const sel of root.querySelectorAll('select')) if (enhanceSelect(sel)) n++;
    return n;
}
