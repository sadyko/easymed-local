// CASE_DX_LIST_V1 — ДИАГНОЗЫ ДОКУМЕНТА: ИЗ СПРАВОЧНИКА ИЛИ СВОИМИ СЛОВАМИ.
//
// Владелец (2026-09-08): «add 2 buttons here in the diagnosis section: 1 main —
// add diagnosis from the icd code (main, soputs, fonoviy, etc), and one ghost
// button with adding writed diagnosis in the field».
//
// Диагноз у истории болезни редко один: основной, сопутствующий, фоновый,
// осложнение — и каждый со своей ролью. Поэтому здесь СПИСОК, а не строка:
// строка заставляла врача писать «K35.8, соп. I10, фон. E11» руками, и уже на
// втором документе запись расходилась с записью.
//
// ГДЕ ЭТО ХРАНИТСЯ. В той же колонке `admission_reviews.diagnosis` — одной
// строкой вида «K35.8 — Острый аппендицит (осн.); I10 — Гипертензия (соп.)».
// Своей таблицы диагнозов у госпитализации нет, и заводить её ради двух кнопок
// значило бы менять базу под вёрстку. Строка читается человеком как есть — её
// показывают обзор, журнал и печать, — а этот модуль разбирает её обратно в
// список, когда документ открывают снова.
import { supabase } from '../../supabase.js';
import { h, Icon, clear, toast } from '../ui.js';
import { tr, trf } from '../i18n.js';
import { icdSuggest, fireInput } from './case-doc-a4.js';
import { inpatientModal } from './inpatient-modal.js';

/** Роли диагноза: короткая пометка в строке и полное имя в окне выбора. */
export const DX_TYPES = Object.freeze([
    { key: 'main',         short: 'осн.', label: 'Основной' },
    { key: 'concomitant',  short: 'соп.', label: 'Сопутствующий' },
    { key: 'background',   short: 'фон.', label: 'Фоновый' },
    { key: 'complication', short: 'осл.', label: 'Осложнение' },
]);
const SHORTS = DX_TYPES.map((t) => t.short);
const byShort = (s) => DX_TYPES.find((t) => t.short === s) || DX_TYPES[0];
const byKey = (k) => DX_TYPES.find((t) => t.key === k) || DX_TYPES[0];

/**
 * Разобрать хранимую строку в список.
 *
 * Строка, написанная до этого правила (просто «Острый аппендицит»), читается
 * как ОДИН основной диагноз: старые документы обязаны открываться.
 */
export function parseDx(text) {
    const raw = String(text == null ? '' : text).trim();
    if (!raw) return [];
    return raw.split(';').map((part) => {
        const s = part.trim();
        if (!s) return null;
        const m = s.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
        if (m && SHORTS.includes(m[2].trim())) return { text: m[1].trim(), type: byShort(m[2].trim()).key };
        return { text: s, type: 'main' };
    }).filter((x) => x && x.text);
}

/** Собрать список обратно в строку — то, что уйдёт в колонку. */
export function formatDx(list) {
    return (list || [])
        .filter((d) => d && String(d.text || '').trim())
        .map((d) => String(d.text).trim() + ' (' + byKey(d.type).short + ')')
        .join('; ');
}

// ---------------------------------------------------------------------------
// Окно выбора из МКБ-10
// ---------------------------------------------------------------------------
const ICD_KINDS = ['category', 'sub'];

// ICD_PICKER_PAGES_V1 (2026-09-08) — СПРАВОЧНИК ПОКАЗЫВАЕТСЯ, А НЕ УГАДЫВАЕТСЯ.
//
// Владелец: «in the list show actual list with paginations without scroll
// adapted to the tablet».
//
// Окно открывалось пустым и просило ввести две буквы. Это разумно для того, кто
// код помнит, и бесполезно для того, кто его ищет: врач видел пустоту там, где
// лежат тридцать тысяч строк справочника. Теперь список открыт сразу с первой
// страницы, поиск его СУЖАЕТ, а не наполняет.
//
// СТРАНИЦЫ, А НЕ ПРОКРУТКА. На планшете список внутри окна прокручивается
// пальцем вместе с самим окном, и попасть в нужную строку тем труднее, чем
// длиннее список. Восемь строк на страницу помещаются целиком, а «дальше» —
// кнопка размером с палец.
//
// Сколько всего страниц, не спрашиваем: это второй запрос по тридцати тысячам
// строк на каждое нажатие. Берём на одну строку больше, чем показываем, — и
// этого ровно достаточно, чтобы знать, есть ли следующая.
const ICD_PAGE = 8;

export function openIcdPicker({ onPick } = {}) {
    let type = 'main';
    let page = 0;
    let hasNext = false;
    let token = 0;

    const search = h('input', { type: 'text', class: 'dxp-search', placeholder: tr('Код или название по МКБ-10') });
    const results = h('div', { class: 'dxp-list' });
    const note = h('div', { class: 'dxp-note' });

    const typeRow = h('div', { class: 'dxp-types', role: 'group', 'aria-label': tr('Роль диагноза') },
        ...DX_TYPES.map((t) => {
            const b = h('button', {
                class: 'dxp-type' + (t.key === type ? ' on' : ''), type: 'button',
                'aria-pressed': t.key === type ? 'true' : 'false',
                onclick: () => {
                    type = t.key;
                    for (const el of typeRow.children || []) {
                        const on = el === b;
                        el.className = 'dxp-type' + (on ? ' on' : '');
                        el.setAttribute('aria-pressed', on ? 'true' : 'false');
                    }
                },
            }, tr(t.label));
            return b;
        }));

    const prevBtn = h('button', { class: 'btn btn-outline dxp-page-btn', type: 'button',
        'aria-label': tr('Предыдущая страница'), onclick: () => { if (page > 0) { page -= 1; run(); } } },
        Icon('ChevronLeft', { size: 15 }));
    const nextBtn = h('button', { class: 'btn btn-outline dxp-page-btn', type: 'button',
        'aria-label': tr('Следующая страница'), onclick: () => { if (hasNext) { page += 1; run(); } } },
        Icon('ChevronRight', { size: 15 }));
    const pageLabel = h('span', { class: 'dxp-page-n' });
    const pager = h('div', { class: 'dxp-pager' }, prevBtn, pageLabel, nextBtn);

    const paintPager = () => {
        pageLabel.textContent = trf('Страница {n}', { n: page + 1 });
        prevBtn.disabled = page === 0;
        nextBtn.disabled = !hasNext;
    };

    async function run() {
        const q = String(search.value || '').trim();
        const my = ++token;
        note.textContent = tr('Ищем…');
        let rows = [];
        let failed = false;
        try {
            let qb = supabase.from('icd10').select('code,name').in('kind', ICD_KINDS).eq('active', 1);
            if (q) {
                // Код ищется с начала строки, название — по вхождению: «J18»
                // должен находить J18.9, а «пневмония» — все пневмонии.
                qb = qb.or('code.ilike.' + q.replace(/\s+/g, '') + '%,name.ilike.%' + q + '%');
            }
            const from = page * ICD_PAGE;
            const { data, error } = await qb.order('code').range(from, from + ICD_PAGE);
            if (error) failed = true;
            rows = (!error && Array.isArray(data)) ? data : [];
        } catch (e) { failed = true; rows = []; }
        if (my !== token) return;

        hasNext = rows.length > ICD_PAGE;
        const shown = rows.slice(0, ICD_PAGE);
        clear(results);
        for (const r of shown) {
            results.appendChild(h('button', {
                class: 'dxp-row', type: 'button',
                onclick: () => {
                    if (onPick) onPick({ text: r.code + ' — ' + r.name, type });
                    toast(trf('Добавлен диагноз: {code}', { code: r.code }), 'ok');
                },
            },
                h('span', { class: 'dxp-code' }, r.code),
                h('span', { class: 'dxp-name' }, r.name),
                Icon('Plus', { size: 15 })));
        }
        // Пустые места добиваются, чтобы окно не прыгало между страницами:
        // прыгающее окно на планшете уводит палец мимо строки.
        for (let i = shown.length; i < ICD_PAGE; i += 1) results.appendChild(h('div', { class: 'dxp-row dxp-row-empty' }));

        note.textContent = failed
            ? tr('Справочник не загрузился — можно записать диагноз своими словами.')
            : (shown.length
                ? tr('Выберите строку — диагноз добавится с выбранной ролью.')
                : tr('Ничего не найдено — можно записать диагноз своими словами.'));
        paintPager();
    }

    // Поиск начинает список заново: остаться на седьмой странице прежней
    // выдачи значило бы показать пустоту и заставить листать назад.
    search.addEventListener('input', () => { page = 0; run(); });

    const m = inpatientModal(tr('Диагноз по МКБ-10'), 'Stethoscope', [
        h('div', { class: 'dxp' }, typeRow, search, results, h('div', { class: 'dxp-foot' }, note, pager)),
    ], tr('Готово'), async () => true, { width: 720 });
    run();
    setTimeout(() => search.focus && search.focus(), 0);
    return m;
}

// ---------------------------------------------------------------------------
// Карточка диагнозов
// ---------------------------------------------------------------------------
/**
 * @param {{carrier: HTMLInputElement, required?: boolean}} opts
 *   carrier — поле редактора, в котором лежит хранимая строка. Карточка пишет
 *   в него и слушает его: черновик приезжает с сервера позже, чем рисуется
 *   карточка, и без этого список остался бы пустым при заполненном документе.
 * @returns {Node}
 */
export function dxEditor({ carrier, required = false } = {}) {
    const box = h('div', { class: 'dx-ed' });
    const chips = h('div', { class: 'dx-chips' });
    // A4_REAL_V1 — поле выглядит тем, что оно есть: строкой поиска по
    // справочнику. Голая рамка без подписи и значка читалась как заготовка
    // вёрстки — владелец возвращался к ней трижды.
    const typeIn = h('input', { type: 'text', class: 'dx-type-in',
        placeholder: tr('Код МКБ-10 или свой диагноз'), 'aria-label': tr('Диагноз') });
    const field = h('div', { class: 'dx-field' },
        h('span', { class: 'dx-field-ic' }, Icon('Search', { size: 14 })),
        typeIn,
        icdSuggest(typeIn, supabase));

    const read = () => parseDx(carrier ? carrier.value : '');
    const write = (list) => {
        if (carrier) { carrier.value = formatDx(list); fireInput(carrier); }
        paint();
    };
    const add = (item) => {
        const list = read();
        const text = String(item.text || '').trim();
        if (!text) { toast(tr('Напишите диагноз или выберите код.'), 'fail'); return; }
        if (list.some((d) => d.text.toLowerCase() === text.toLowerCase())) { toast(tr('Такой диагноз уже добавлен.'), 'info'); return; }
        list.push({ text, type: item.type || (list.length ? 'concomitant' : 'main') });
        write(list);
        typeIn.value = '';
    };
    const removeAt = (i) => { const list = read(); list.splice(i, 1); write(list); };

    function paint() {
        clear(chips);
        const list = read();
        if (!list.length) {
            chips.appendChild(h('div', { class: 'dx-empty' + (required ? ' dx-need' : '') },
                required ? tr('Для первичного осмотра диагноз обязателен.') : tr('Диагноз ещё не добавлен.')));
            return;
        }
        list.forEach((d, i) => chips.appendChild(h('span', { class: 'dx-chip dx-' + d.type },
            h('span', { class: 'dx-chip-t' }, d.text),
            h('span', { class: 'dx-chip-k' }, tr(byKey(d.type).short)),
            h('button', {
                class: 'dx-chip-x', type: 'button', 'aria-label': trf('Убрать диагноз: {name}', { name: d.text }),
                title: tr('Убрать'), onclick: () => removeAt(i),
            }, '×'))));
    }

    box.appendChild(chips);
    box.appendChild(field);
    box.appendChild(h('div', { class: 'dx-acts' },
        // Главное действие — справочник: код МКБ-10 нужен отчётности, и врач
        // должен встречать его первым.
        h('button', { class: 'btn btn-primary btn-sm', type: 'button',
            onclick: () => openIcdPicker({ onPick: add }) },
            Icon('Plus', { size: 13 }), ' ', tr('Из МКБ-10')),
        // Своими словами — призрачной: так пишут то, чему кода нет.
        h('button', { class: 'btn btn-ghost btn-sm dx-own', type: 'button',
            onclick: () => add({ text: typeIn.value, type: read().length ? 'concomitant' : 'main' }) },
            Icon('Edit', { size: 13 }), ' ', tr('Добавить свой'))));

    typeIn.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { if (e.preventDefault) e.preventDefault(); add({ text: typeIn.value, type: read().length ? 'concomitant' : 'main' }); }
    });
    // НАПИСАННОЕ, НО НЕ ДОБАВЛЕННОЕ — ТОЖЕ ДИАГНОЗ. Врач печатает в поле и жмёт
    // «Опубликовать», не нажав «Добавить свой»; молча потерять текст значило бы
    // опубликовать осмотр без диагноза. Редактор зовёт это перед отправкой.
    if (carrier) {
        carrier.dxCommit = () => {
            if (String(typeIn.value || '').trim()) add({ text: typeIn.value, type: read().length ? 'concomitant' : 'main' });
        };
    }
    if (carrier && carrier.addEventListener) carrier.addEventListener('input', paint);
    paint();
    return box;
}
