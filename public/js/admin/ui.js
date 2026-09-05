// Easy-Med — shared UI atoms (vanilla port of components.jsx).
// `h(tag, props, ...children)` is the tiny hyperscript at the heart of every view.

import { iconHtml } from './icons.js';
import { getLang, tr } from './i18n.js';
// MONTH_WORDS_V1 — сам формат даты общий с печатными бланками (модуль чистый).
import { dateWords } from '../shared/date-words.js';

// ---------------------------------------------------------------------------
// h() — hyperscript. props.style accepts an object, on* keys are listeners,
// `class` and `className` both work, child arrays auto-flatten, raw HTML via
// the special key { html: '<svg…>' }.
// ---------------------------------------------------------------------------
// SEARCH_DEBOUNCE_V1 — все поисковые поля запускают поиск только после паузы
// в наборе (500 мс), а не на каждый символ. Центрально: h() оборачивает
// обработчики 'input' у input[type=search] и полей с плейсхолдером «поиск»,
// включая слушатели, навешанные позже через addEventListener.
const SEARCH_DEBOUNCE_MS = 500;
function isSearchInput(el) {
    if (el.tagName !== 'INPUT') return false;
    if (el.type === 'search') return true;
    const ph = el.getAttribute('placeholder') || '';
    return /поиск|search|qidir/i.test(ph);
}
function debouncedInput(fn) {
    let t = null;
    return function (e) { clearTimeout(t); t = setTimeout(() => fn.call(this, e), SEARCH_DEBOUNCE_MS); };
}

export function h(tag, props = null, ...children) {
    const el = document.createElement(tag);
    const pendingHandlers = [];   // SEARCH_DEBOUNCE_V1 — навешиваются после атрибутов
    if (props) {
        for (const [k, v] of Object.entries(props)) {
            if (v == null || v === false) continue;
            if (k === 'class' || k === 'className') el.className = v;
            else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
            else if (k === 'dataset' && typeof v === 'object') Object.assign(el.dataset, v);
            else if (k.startsWith('on') && typeof v === 'function') pendingHandlers.push([k.slice(2).toLowerCase(), v]);
            else if (k === 'html') el.innerHTML = v;
            else if (k === 'ref' && typeof v === 'function') v(el);
            else if (k === 'checked' || k === 'disabled' || k === 'selected') { if (v) el.setAttribute(k, ''); }
            else if ((k === 'placeholder' || k === 'title' || k === 'aria-label' || k === 'alt') && typeof v === 'string') el.setAttribute(k, tr(v));
            else el.setAttribute(k, v === true ? '' : String(v));
        }
    }
    // SEARCH_DEBOUNCE_V1 — для поисковых полей оборачиваем 'input' в дебаунс;
    // распространяется и на будущие addEventListener этого элемента.
    if (isSearchInput(el)) {
        const origAdd = el.addEventListener.bind(el);
        el.addEventListener = (type, fn, opts) =>
            origAdd(type, type === 'input' && typeof fn === 'function' ? debouncedInput(fn) : fn, opts);
    }
    for (const [type, fn] of pendingHandlers) el.addEventListener(type, fn);
    for (const c of children.flat(Infinity)) {
        if (c == null || c === false) continue;
        if (c instanceof Node) el.appendChild(c);
        else el.appendChild(document.createTextNode(tr(String(c))));
    }
    // A11Y_CENTRAL - icon-only close buttons ('x') carry no accessible name; give them one.
    if (tag === 'button' && !el.hasAttribute('aria-label') &&
        (el.classList.contains('modal-close') || el.textContent.trim() === '\u00d7')) {
        el.setAttribute('aria-label', tr('Close'));
    }
    return el;
}

// Convenience: parse an HTML string into a single element (used for icons).
export function html(str) {
    const tpl = document.createElement('template');
    tpl.innerHTML = str.trim();
    return tpl.content.firstChild;
}

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

// ---------------------------------------------------------------------------
// Icon — convenience wrapper. Returns an element.
// ---------------------------------------------------------------------------
export function Icon(name, opts = {}) { return html(iconHtml(name, opts)); }

// ---------------------------------------------------------------------------
// Avatar
// ---------------------------------------------------------------------------
export function Avatar({ initials = '?', color = 'av-1', size = '' } = {}) {
    return h('div', { class: `avatar ${size} ${color}` }, initials);
}

// ---------------------------------------------------------------------------
// Tag
// ---------------------------------------------------------------------------
export function Tag(text, { kind = '', dot = false } = {}) {
    const cls = 'tag' + (kind ? ' tag-' + kind : '');
    return h('span', { class: cls }, dot ? h('span', { class: 'tag-dot' }) : null, text);
}

const STATUS_MAP = {
    completed:     { kind: 'ok',   text: 'Completed' },
    'in-progress': { kind: 'info', text: 'In progress' },
    in_progress:   { kind: 'info', text: 'In progress' },
    waiting:       { kind: 'warn', text: 'Waiting' },
    arrived:       { kind: 'warn', text: 'Waiting' },
    scheduled:     { kind: '',     text: 'Scheduled' },
    cancelled:     { kind: 'crit', text: 'Cancelled' },
    no_show:       { kind: 'crit', text: 'No show' },
    active:        { kind: 'ok',   text: 'Active' },
    inpatient:     { kind: 'info', text: 'Inpatient' },
    critical:      { kind: 'crit', text: 'Critical' },
    discharged:    { kind: '',     text: 'Discharged' },
    normal:        { kind: 'ok',   text: 'Normal' },
    high:          { kind: 'warn', text: 'High' },
    low:           { kind: 'info', text: 'Low' },
    pending:       { kind: 'warn', text: 'Pending' },
    added:            { kind: '',     text: 'Added' },
    queued:           { kind: 'info', text: 'Queued' },
    awaiting_payment: { kind: 'warn', text: 'Awaiting payment' },
    billed:        { kind: 'info', text: 'Billed' },
    paid:          { kind: 'ok',   text: 'Paid' },
    open:          { kind: 'warn', text: 'Open' },
    confirmed:     { kind: 'purple', text: 'Confirmed' },
    unpaid:        { kind: 'warn', text: 'Unpaid' },
    partial:       { kind: 'warn', text: 'Partial' },
    debt:          { kind: 'crit', text: 'Debt' },
    void:          { kind: 'crit', text: 'Cancelled' },
    refunded:      { kind: 'crit', text: 'Refunded' },
    draft:         { kind: '',     text: 'Draft' },
};

// Status label only (no element) — handy for inline text.
export function statusLabel(status) {
    return (STATUS_MAP[status]?.text) || (status ? status.charAt(0).toUpperCase() + status.slice(1).replace(/_/g, ' ') : '—');
}
export function StatusTag(status) {
    const m = STATUS_MAP[status] || { kind: '', text: status || '—' };
    return Tag(m.text, { kind: m.kind, dot: true });
}

// ---------------------------------------------------------------------------
// Sparkline — tiny SVG line chart
// ---------------------------------------------------------------------------
export function Spark(data, { color = 'var(--primary-600)', w = 120, h: hgt = 36, fill = true } = {}) {
    if (!data || data.length === 0) return h('div');
    const max = Math.max(...data);
    const min = Math.min(...data);
    const range = max - min || 1;
    const step = w / (data.length - 1);
    const pts = data.map((v, i) => [i * step, hgt - ((v - min) / range) * (hgt - 4) - 2]);
    const path = pts.map((p, i) => (i === 0 ? `M ${p[0]} ${p[1]}` : `L ${p[0]} ${p[1]}`)).join(' ');
    const area = path + ` L ${w} ${hgt} L 0 ${hgt} Z`;
    const last = pts[pts.length - 1];
    return html(`<svg width="${w}" height="${hgt}" viewBox="0 0 ${w} ${hgt}" style="display:block">
        ${fill ? `<path d="${area}" fill="${color}" opacity="0.10"/>` : ''}
        <path d="${path}" fill="none" stroke="${color}" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>
        <circle cx="${last[0]}" cy="${last[1]}" r="2.5" fill="${color}"/>
    </svg>`);
}

// ---------------------------------------------------------------------------
// Bars — tiny vertical bar chart
// ---------------------------------------------------------------------------
export function Bars(data, { w = 240, h: hgt = 80, color = 'var(--primary-500)', gap = 4 } = {}) {
    const max = Math.max(...data) || 1;
    const bw = (w - gap * (data.length - 1)) / data.length;
    const rects = data.map((v, i) => {
        const bh = (v / max) * (hgt - 4);
        const opacity = i === data.length - 1 ? 1 : 0.55;
        return `<rect x="${i * (bw + gap)}" y="${hgt - bh}" width="${bw}" height="${bh}" rx="2" fill="${color}" opacity="${opacity}"/>`;
    }).join('');
    return html(`<svg width="${w}" height="${hgt}" viewBox="0 0 ${w} ${hgt}" style="display:block">${rects}</svg>`);
}

// ---------------------------------------------------------------------------
// Ring — circular progress
// ---------------------------------------------------------------------------
export function Ring({ value, max = 100, size = 64, stroke = 7, color = 'var(--primary-600)', track = 'var(--ink-100)', label } = {}) {
    const r = (size - stroke) / 2;
    const c = 2 * Math.PI * r;
    const off = c - (value / max) * c;
    const wrap = h('div', { style: { position: 'relative', width: size + 'px', height: size + 'px' } });
    wrap.appendChild(html(`<svg width="${size}" height="${size}">
        <circle cx="${size/2}" cy="${size/2}" r="${r}" stroke="${track}" stroke-width="${stroke}" fill="none"/>
        <circle cx="${size/2}" cy="${size/2}" r="${r}" stroke="${color}" stroke-width="${stroke}" fill="none"
            stroke-dasharray="${c}" stroke-dashoffset="${off}" stroke-linecap="round"
            transform="rotate(-90 ${size/2} ${size/2})"/>
    </svg>`));
    wrap.appendChild(h('div', {
        style: { position: 'absolute', inset: 0, display: 'grid', placeItems: 'center',
                 fontWeight: 700, color: 'var(--ink-900)', fontSize: size > 48 ? '14px' : '11px' }
    }, label ?? Math.round((value / max) * 100) + '%'));
    return wrap;
}

// ---------------------------------------------------------------------------
// Delta — up/down/flat indicator
// ---------------------------------------------------------------------------
export function Delta(value, suffix = '%') {
    const sign = value > 0 ? 'up' : value < 0 ? 'down' : 'flat';
    const arrow = value > 0 ? '↑' : value < 0 ? '↓' : '—';
    return h('span', { class: `delta ${sign}` }, `${arrow} ${Math.abs(value)}${suffix}`);
}

// ---------------------------------------------------------------------------
// PageHead
// ---------------------------------------------------------------------------
export function PageHead({ title, subtitle, right } = {}) {
    return h('div', { class: 'page-head' },
        h('div', null,
            h('h1', { class: 'page-title' }, tr(title)),
            subtitle && h('p', { class: 'page-subtitle' }, tr(subtitle)),
        ),
        right && h('div', { class: 'row', style: { gap: '8px' } }, ...(Array.isArray(right) ? right : [right])),
    );
}

// ---------------------------------------------------------------------------
// field / checkField — shared `.field`-wrapped labeled inputs (design system).
// `control` is an already-built input/select/textarea node.
// ---------------------------------------------------------------------------
export function field(label, control, opts = {}) {
    return h('div', { class: 'field' },
        h('label', null, label, opts.required ? h('span', { class: 'req' }, ' *') : null),
        control);
}
// A checkbox row. `checkbox` is an already-built <input type=checkbox> node.
export function checkField(label, checkbox) {
    return h('div', { class: 'field checkbox' }, checkbox, h('label', null, label));
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------
export function toast(msg, kind = 'info') {
    let el = document.getElementById('toast');
    if (!el) {
        el = h('div', { id: 'toast', class: 'toast' });
        el.setAttribute('role', 'status');
        el.setAttribute('aria-live', 'polite');
        el.setAttribute('aria-atomic', 'true');
        document.body.appendChild(el);
    }
    // TOAST_I18N_V1 (2026-08-31) — translate here, centrally, exactly like
    // h() does for its text children. The audit found 520 call sites passing
    // bare Russian to toast(); routing every one through tr() by hand is the
    // per-site mistake this codebase keeps re-making. An already-translated
    // or assembled message passes through unchanged (tr() returns unknown
    // strings as-is), so double translation is as safe here as in h() —
    // guarded by the updates-i18n "translating twice" test.
    el.textContent = tr(msg);
    el.dataset.kind = kind;
    el.classList.remove('hidden');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.add('hidden'), 2400);
}

// ---------------------------------------------------------------------------
// Initials helper (used everywhere)
// ---------------------------------------------------------------------------
export function initials(name) {
    return (name || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() || '').join('') || '?';
}

// Deterministic avatar colour from a string (so the same patient gets the same av-N every render).
export function avColor(seed) {
    const s = String(seed || '');
    let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return 'av-' + ((h % 8) + 1);
}


// ---------------------------------------------------------------------------
// DATE_FMT_V1 — one shared, locale-aware date/time formatter for the whole admin.
// Renders human dates ("5 июня 2026") instead of raw ISO. fmtDate -> date;
// fmtDateTime -> date + HH:MM.
// NEVER feed these to <input type=date> values or query cutoffs — those need ISO.
//
// MONTH_WORDS_V1 (2026-09-05) — БЕЗ Intl.
//
// Раньше месяц брался у Intl по языку интерфейса. На машине, в сборке которой
// нет данных для uz, Intl отвечает за КОРНЕВУЮ локаль, и дата рождения на
// узбекском экране печаталась как «1994 M11 15» — ровно то, что владелец
// прислал на снимке. Наличие данных ICU — свойство конкретного компьютера, а не
// продукта, поэтому единственный способ получить ОДИН И ТОТ ЖЕ ответ во всех
// клиниках — не спрашивать их вовсе.
//
// Сам формат (месяцы из словаря, порядок слов по CLDR) живёт в
// shared/date-words.js: тот модуль ЧИСТЫЙ, и потому один и тот же код пишет
// дату и на экране, и в печатном бланке, который собирает сервер для
// Telegram-бота. Здесь остаётся ровно то, чего он не знает: язык интерфейса и
// прочерк вместо пустоты.
// ---------------------------------------------------------------------------
export function fmtDate(value, { withTime = false } = {}) {
    return dateWords(value, { lang: getLang(), withTime }) || '—';
}
export function fmtDateTime(value) { return fmtDate(value, { withTime: true }); }
