// REFERRALS_CRM_V1 (2026-10-26) — общие кусочки вкладок «Реферирования»:
// запрос RPC, плитки чисел, строка периода, окно «Подробнее», печать.
// Вкладки (referrals-*.js) собирают из них свои таблицы и ничего из этого не
// повторяют.
import { supabase } from '../../supabase.js';
import { h, Icon, clear, toast } from '../ui.js';
import { tr, trf } from '../i18n.js';
import { reportPrintHtml } from './report-print.js?v=jrn4';   // та же печатная страница, что у отчётов
import { fmtSum } from '../referrals-logic.js';

export async function rpc(name, args = {}) {
    const { data, error } = await supabase.rpc(name, args);
    if (error) {
        const e = new Error(error.message || 'Не удалось выполнить запрос.');
        e.code = error.code;
        throw e;
    }
    return data;
}

/** Плитка числа: значение крупно, подпись мелко; accent — ok / warn / crit. */
export function kpi(value, label, { accent = '' } = {}) {
    return h('div', { class: 'ref-kpi' + (accent ? ' is-' + accent : ''), 'data-kpi': label },
        h('div', { class: 'ref-kpi-value' }, value),
        h('div', { class: 'ref-kpi-label muted' }, label));
}
export function kpiRow(...tiles) {
    return h('div', { class: 'ref-kpis' }, ...tiles.filter(Boolean));
}

/** «14 705 000 сум». */
export function sumText(v) {
    return trf('{sum} сум', { sum: fmtSum(v) });
}

/**
 * Строка фильтров: поиск слева, справа «Период» с двумя датами. onChange
 * получает { q, from, to } при каждом изменении; даты — при change, поиск —
 * при input (поля поиска h() сам замедляет, SEARCH_DEBOUNCE_V1).
 */
export function filterBar({ q = '', from, to, placeholder, onChange, before = null }) {
    const search = h('input', { type: 'search', class: 'ref-search', value: q, placeholder, 'aria-label': placeholder });
    const fromEl = h('input', { type: 'date', class: 'ref-date', value: from || '', 'aria-label': 'Период с' });
    const toEl = h('input', { type: 'date', class: 'ref-date', value: to || '', 'aria-label': 'Период по' });
    const emit = () => onChange({ q: search.value, from: fromEl.value, to: toEl.value });
    search.addEventListener('input', emit);
    fromEl.addEventListener('change', emit);
    toEl.addEventListener('change', emit);
    return h('div', { class: 'ref-filters' },
        before,
        h('div', { class: 'ref-filters-search' }, Icon('Search', { size: 14 }), search),
        h('div', { class: 'ref-period' },
            h('span', { class: 'muted' }, 'Период'), fromEl, h('span', { class: 'muted' }, '—'), toEl));
}

export function loadingEl() { return h('div', { class: 'muted', style: { padding: '24px' } }, 'Загрузка…'); }
export function errorEl(msg) { return h('div', { class: 'empty', style: { padding: '24px' } }, trf('Не удалось загрузить: {msg}', { msg })); }

/** Двухстрочная ячейка: имя и подпись мелким серым. */
export function nameCell(name, sub) {
    return h('div', null,
        h('div', { style: { fontWeight: '600' } }, name),
        sub ? h('div', { class: 'muted', style: { fontSize: '12.5px' } }, sub) : null);
}

export function actionButtons({ onDetails, onPrint }) {
    return h('div', { class: 'ref-actions' },
        h('button', { class: 'btn btn-sm ref-btn-more', type: 'button', onclick: onDetails }, 'Подробнее'),
        h('button', { class: 'btn btn-sm btn-outline', type: 'button', onclick: onPrint }, Icon('Print', { size: 13 }), ' ', 'Печать'));
}

/** Печатная страница в новом окне — как у отчётов. */
export function openPrint(sheet) {
    const html = reportPrintHtml(sheet.res, sheet.meta, { tr, trf });
    const w = typeof window !== 'undefined' && window.open ? window.open('', '_blank') : null;
    if (!w) { toast(tr('Разрешите всплывающие окна для печати.'), 'fail'); return false; }
    w.document.open();
    w.document.write(html);
    w.document.close();
    return true;
}

/**
 * Окно «Подробнее»: заголовок, подзаголовок, тело; в подвале «Печать» (если
 * дан onPrint) и «Закрыть». Возвращает { body, close }, тело заполняет
 * вызывающий после загрузки.
 */
export function detailModal({ title, subtitle = '', onPrint = null }) {
    const overlay = h('div', { class: 'modal', 'data-ref-detail': '' });
    const close = () => overlay.remove();
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));
    const body = h('div', { class: 'modal-body', style: { overflowY: 'auto' } }, loadingEl());
    overlay.appendChild(h('div', { class: 'modal-card', style: { width: '900px', maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100vh - 60px)', display: 'flex', flexDirection: 'column' } },
        h('header', { class: 'modal-head' },
            h('div', null,
                h('h2', null, title),
                subtitle ? h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '2px' } }, subtitle) : null),
            h('button', { class: 'modal-close', type: 'button', 'aria-label': 'Закрыть', onclick: close }, '×')),
        body,
        h('footer', { class: 'modal-foot' },
            h('span', { class: 'grow' }),
            onPrint ? h('button', { class: 'btn btn-outline', type: 'button', onclick: onPrint }, Icon('Print', { size: 13 }), ' ', 'Печать') : null,
            h('button', { class: 'btn', type: 'button', onclick: close }, 'Закрыть'))));
    document.body.appendChild(overlay);
    return { body, close, overlay };
}

/** Таблица из колонок [{label, value(row), num?}] и строк. */
export function simpleTable(columns, rows, { emptyText = 'Пока пусто.' } = {}) {
    if (!rows.length) return h('div', { class: 'empty', style: { padding: '24px' } }, emptyText);
    return h('table', { class: 'tbl' },
        h('thead', null, h('tr', null, ...columns.map((c) => h('th', { class: c.num ? 'num' : null }, c.label)))),
        h('tbody', null, ...rows.map((r) => h('tr', null, ...columns.map((c) => h('td', { class: c.num ? 'cell-mono num' : null }, c.value(r)))))));
}

export function clearInto(el, child) { clear(el); el.appendChild(child); return el; }
