// UI_DATEFIELD_V1 (2026-09-05) — КАЛЕНДАРЬ ПРОГРАММЫ, А НЕ КАЛЕНДАРЬ БРАУЗЕРА.
//
// Владелец: «please fix the dialogue windows and dropdowns and calendar
// pickers design».
//
// Календарь <input type="date"> рисует браузер, и он же выбирает язык месяцев
// по настройке системы: на узбекском интерфейсе клиники он открывался
// по-русски, а иногда и вовсе «1994 M11». Ни вид, ни язык этого окна правилами
// страницы не задаются.
//
// РОДНОЕ ПОЛЕ НЕ ВЫБРАСЫВАЕТСЯ — оно прячется и остаётся источником правды:
// пятьдесят с лишним мест читают `input.value` в виде «ГГГГ-ММ-ДД» и слушают
// `change`. Меняется только то, что видит человек: подпись словами на его
// языке («2 мая 2019», «2-may, 2019») и своя сетка месяца.
//
// Арифметика календаря — в чистом ../shared/month-grid.js: високосный год,
// начало недели и переход через месяц проверяются числами, а не глазами.

import { h, Icon, fmtDate } from './ui.js';
import { tr } from './i18n.js';
import { monthName } from './i18n.js';
import { monthGrid, parseIso, shiftMonth, todayIso, withinRange } from '../shared/month-grid.js?v=mg1';
import { watchValue, insideEditable } from './ui-select.js?v=uisel1';

const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

let openInstance = null;

export function enhanceDateField(input) {
    if (!input || input.tagName !== 'INPUT') return null;
    if ((input.getAttribute('type') || '').toLowerCase() !== 'date') return null;
    if (input.dataset.uiDate === 'on' || input.dataset.noEnhance != null) return null;
    if (input.closest && input.closest('[data-no-enhance]')) return null;
    if (insideEditable(input)) return null;   // бланк приёма правится как текст
    input.dataset.uiDate = 'on';

    const valueEl = h('span', { class: 'uidate-val' });
    const field = h('button', {
        type: 'button', class: 'uidate-field', 'aria-haspopup': 'dialog', 'aria-expanded': 'false',
    }, h('span', { class: 'uidate-ic' }, Icon('Calendar', { size: 14 })), valueEl);
    // Крестик появляется только когда есть что сбрасывать и поле не обязательное:
    // у обязательного поля «очистить» — это предложение сделать форму неверной.
    const clearBtn = h('button', {
        type: 'button', class: 'uidate-clear', title: 'Очистить',
        onclick: (e) => { e.stopPropagation(); commit(''); },
    }, Icon('X', { size: 12 }));

    const wrap = h('div', { class: 'uidate' }, field, clearBtn);
    if (input.parentNode) input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    input.classList.add('uidate-native');

    function paintField() {
        const iso = input.value;
        valueEl.textContent = iso ? fmtDate(iso) : (input.getAttribute('placeholder') || tr('Выберите дату'));
        valueEl.classList.toggle('is-empty', !iso);
        field.disabled = !!input.disabled;
        wrap.classList.toggle('is-disabled', !!input.disabled);
        clearBtn.style.display = (iso && !input.required && !input.disabled) ? '' : 'none';
    }

    function commit(iso) {
        input.value = iso;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        paintField();
    }

    let pop = null, view = null, reposition = null;

    function close() {
        if (!pop) return;
        pop.remove(); pop = null; view = null;
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
        if (pop && !pop.contains(e.target) && !wrap.contains(e.target)) close();
    }
    function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); close(); field.focus(); }
    }

    function limits() {
        return { min: input.getAttribute('min') || '', max: input.getAttribute('max') || '' };
    }

    function paintPop() {
        pop.replaceChildren();
        const { min, max } = limits();
        const cur = input.value;
        const today = todayIso();

        const head = h('div', { class: 'uidate-head' },
            h('button', {
                type: 'button', class: 'uidate-nav', title: 'Предыдущий месяц',
                onclick: () => { view = shiftMonth(view, -1); paintPop(); },
            }, Icon('ChevronLeft', { size: 14 })),
            h('div', { class: 'uidate-title' },
                h('b', null, monthName(view.month, { standalone: true })), ' ', String(view.year)),
            h('button', {
                type: 'button', class: 'uidate-nav', title: 'Следующий месяц',
                onclick: () => { view = shiftMonth(view, 1); paintPop(); },
            }, Icon('ChevronRight', { size: 14 })),
        );

        const grid = h('div', { class: 'uidate-grid' });
        for (const w of WEEKDAYS) grid.appendChild(h('div', { class: 'uidate-wd' }, tr(w)));
        for (const week of monthGrid(view.year, view.month)) {
            for (const c of week) {
                const off = !withinRange(c.iso, { min, max });
                grid.appendChild(h('button', {
                    type: 'button',
                    class: 'uidate-day'
                        + (c.inMonth ? '' : ' is-out')
                        + (c.iso === cur ? ' is-on' : '')
                        + (c.iso === today ? ' is-today' : '')
                        + (off ? ' is-off' : ''),
                    disabled: off || null,
                    onclick: () => { commit(c.iso); close(); field.focus(); },
                }, String(c.day)));
            }
        }

        const foot = h('div', { class: 'uidate-foot' },
            h('button', {
                type: 'button', class: 'btn btn-outline btn-sm',
                disabled: !withinRange(today, { min, max }) || null,
                onclick: () => { commit(today); close(); field.focus(); },
            }, tr('Сегодня')),
            h('span', { class: 'grow' }),
            input.required ? null : h('button', {
                type: 'button', class: 'btn btn-ghost btn-sm',
                onclick: () => { commit(''); close(); field.focus(); },
            }, tr('Очистить')),
        );

        pop.append(head, grid, foot);
    }

    function place() {
        if (!pop) return;
        const r = field.getBoundingClientRect();
        const vh = window.innerHeight || 800;
        const vw = window.innerWidth || 1200;
        const h0 = pop.offsetHeight || 320;
        const up = (vh - r.bottom - 8) < h0 && r.top > h0;
        pop.style.left = Math.max(8, Math.min(r.left, vw - pop.offsetWidth - 8)) + 'px';
        if (up) { pop.style.top = 'auto'; pop.style.bottom = (vh - r.top + 4) + 'px'; }
        else { pop.style.bottom = 'auto'; pop.style.top = (r.bottom + 4) + 'px'; }
    }

    function open() {
        if (pop || input.disabled) return;
        if (openInstance) openInstance();
        const parsed = parseIso(input.value) || parseIso(todayIso());
        view = { year: parsed.year, month: parsed.month };
        pop = h('div', { class: 'uidate-pop', role: 'dialog', 'aria-label': tr('Выберите дату') });
        document.body.appendChild(pop);
        paintPop();
        place();
        field.setAttribute('aria-expanded', 'true');
        reposition = () => place();
        window.addEventListener('scroll', reposition, true);
        window.addEventListener('resize', reposition);
        document.addEventListener('mousedown', onOutside, true);
        document.addEventListener('keydown', onKey, true);
        openInstance = close;
    }

    field.addEventListener('click', () => { if (pop) close(); else open(); });
    field.addEventListener('keydown', (e) => {
        if (pop) return;
        if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
    // Дату ставят снаружи (предзаполнение формы, «сегодня» кнопкой соседнего
    // фильтра) — подпись обязана следовать за значением.
    input.addEventListener('change', paintField);
    watchValue(input, paintField);
    if (typeof MutationObserver === 'function') {
        new MutationObserver(paintField).observe(input, {
            attributes: true, attributeFilter: ['value', 'min', 'max', 'disabled', 'required', 'placeholder'],
        });
    }

    paintField();
    return wrap;
}

export function enhanceDateFieldsIn(root) {
    if (!root || !root.querySelectorAll) return 0;
    let n = 0;
    for (const el of root.querySelectorAll('input[type="date"]')) if (enhanceDateField(el)) n++;
    return n;
}
