// CRM_SALES_CHARTS_V1 (2026-11-22) — графики «Отчёта по заявкам».
//
// Владелец, глядя на отчёт с таблицей отдела продаж: «can you make it more
// detailed with chart, I could make decision based on this report». Графики
// отвечают на вопросы, по которым руководитель продаж принимает решение:
//   * растёт или падает поток — заявки и «пришли» по дням (линии);
//   * сколько денег приносит CRM — по дням оплаты (столбики);
//   * где теряются заявки — воронка от заявки до визита;
//   * кто приносит деньги и кто превращает заявку в визит — менеджеры;
//   * какой источник окупается — заявки и «пришли» по источникам.
//
// Без библиотек и сети (CLAUDE.md: «No network dependencies»): SVG руками.
// Правила вида — из общего правила графиков продукта:
//   * цвет — по роли ряда: категориальные слоты 1 (синий) и 2 (оранжевый),
//     проверены на различимость для дальтоников (скрипт проверки палитры,
//     все проверки пройдены на белом поле карточки); зелёный «хорошо» и красный
//     «плохо» — цвета состояний, рядам их не дают;
//   * ось одна: деньги и количества — РАЗНЫЕ графики, не две шкалы на одном;
//   * линии 2px, столбики со скруглённым верхом 4px и зазором 2px; сетка и оси
//     приглушены; текст — цветом текста, а не цветом ряда;
//   * у двух рядов — легенда; при наведении — перекрестие и подсказка со
//     значениями (у столбиков — подсказка на столбике), цель наведения шире
//     самой отметки.

import { h } from '../ui.js';
import { tr } from '../i18n.js';

export const SERIES = Object.freeze({ one: '#2a78d6', two: '#eb6834' });

const NS = 'http://www.w3.org/2000/svg';
const W = 640;
const PAD = { l: 44, r: 12, t: 10, b: 26 };

function el(tag, attrs = {}, ...kids) {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, String(v));
    for (const c of kids) if (c) n.appendChild(c);
    return n;
}
function text(s, attrs) { const t = el('text', attrs); t.textContent = s; return t; }

/** «1 250 000» — пробел между тысячами, как в остальном отчёте. */
export function groupNum(n) {
    return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}
/** «1,2 млн», «350 тыс.» — короткая подпись оси для денег. */
export function shortMoney(n) {
    const v = Math.abs(Number(n) || 0);
    if (v >= 1e9) return String(Math.round(v / 1e8) / 10).replace('.', ',') + ' ' + tr('млрд');
    if (v >= 1e6) return String(Math.round(v / 1e5) / 10).replace('.', ',') + ' ' + tr('млн');
    if (v >= 1e3) return String(Math.round(v / 1e3)) + ' ' + tr('тыс.');
    return String(Math.round(v));
}

/**
 * Верх шкалы для 4 делений: шаг — «круглый» (1, 2, 5 × 10ⁿ), верх = 4 шага не
 * меньше максимума. Так подписи оси — 10, 20, 30, 40, а не 13, 25, 38.
 */
export function niceMax(max) {
    const m = Math.max(1, Number(max) || 0);
    const raw = m / 4;
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    for (const k of [1, 2, 5, 10]) if (k * p * 4 >= m && k * p >= 1) return k * p * 4;
    return 40 * p;
}

/** Подпись шага по ключу ряда: '2026-11-22' → «22.11», '2026-11' → «11.2026». */
export function stepLabel(key) {
    const s = String(key || '');
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s.slice(8, 10) + '.' + s.slice(5, 7);
    if (/^\d{4}-\d{2}$/.test(s)) return s.slice(5, 7) + '.' + s.slice(0, 4);
    return s;
}

function frame(height, max, fmtAxis) {
    const svg = el('svg', { viewBox: `0 0 ${W} ${height}`, class: 'crc-svg', role: 'img', preserveAspectRatio: 'none' });
    const plotH = height - PAD.t - PAD.b;
    for (let i = 0; i <= 4; i++) {
        const y = PAD.t + plotH - (plotH * i) / 4;
        svg.appendChild(el('line', { x1: PAD.l, x2: W - PAD.r, y1: y, y2: y, class: i ? 'crc-gridline' : 'crc-axis' }));
        svg.appendChild(text(fmtAxis((max * i) / 4), { x: PAD.l - 6, y: y + 4, class: 'crc-tick', 'text-anchor': 'end' }));
    }
    return { svg, plotH };
}

function xLabels(svg, keys, xOf, height) {
    const every = Math.max(1, Math.ceil(keys.length / 8));   // не больше ~8 подписей, иначе слипаются
    const last = keys.length - 1;
    keys.forEach((k, i) => {
        // Последний шаг подписывается, только если не прилипает к предыдущей подписи.
        if (i % every && !(i === last && last % every >= every / 2)) return;
        svg.appendChild(text(stepLabel(k), { x: xOf(i), y: height - 8, class: 'crc-tick', 'text-anchor': 'middle' }));
    });
}

function tooltipHost() {
    const tip = h('div', { class: 'crc-tip', hidden: true });
    const show = (x, html) => {
        tip.innerHTML = '';
        for (const line of html) tip.appendChild(line);
        tip.hidden = false;
        tip.style.left = Math.round(x * 100) + '%';
    };
    return { tip, show, hide: () => { tip.hidden = true; } };
}
function tipLine(label, value, color) {
    return h('div', { class: 'crc-tip-row' },
        color ? h('span', { class: 'crc-key', style: { background: color } }) : null,
        h('span', { class: 'crc-tip-label' }, label), h('b', null, value));
}

/**
 * Линии по шагам. series: [{ name, color, values }], keys — подписи шагов.
 * Две линии — легенда сверху; наведение — перекрестие и значения обеих.
 */
export function lineChart({ keys, series, height = 200, fmt = groupNum }) {
    const max = niceMax(Math.max(0, ...series.flatMap((s) => s.values)));
    const { svg, plotH } = frame(height, max, (v) => groupNum(v));
    const n = keys.length;
    const xOf = (i) => (n <= 1 ? (PAD.l + W - PAD.r) / 2 : PAD.l + ((W - PAD.l - PAD.r) * i) / (n - 1));
    const yOf = (v) => PAD.t + plotH - (plotH * (Number(v) || 0)) / max;
    for (const s of series) {
        const d = s.values.map((v, i) => (i ? 'L' : 'M') + xOf(i).toFixed(1) + ' ' + yOf(v).toFixed(1)).join('');
        svg.appendChild(el('path', { d, fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'data-series': s.name }));
        if (n <= 31) {   // точки только там, где их можно различить
            s.values.forEach((v, i) => svg.appendChild(el('circle', { cx: xOf(i), cy: yOf(v), r: 3, fill: s.color, class: 'crc-dot' })));
        }
    }
    xLabels(svg, keys, xOf, height);
    const cross = el('line', { y1: PAD.t, y2: PAD.t + plotH, class: 'crc-cross', visibility: 'hidden' });
    svg.appendChild(cross);
    const t = tooltipHost();
    const step = n <= 1 ? W : (W - PAD.l - PAD.r) / (n - 1);
    keys.forEach((k, i) => {
        const hit = el('rect', { x: xOf(i) - step / 2, y: 0, width: step, height, class: 'crc-hit', 'data-step': k });
        hit.addEventListener('mouseenter', () => {
            cross.setAttribute('x1', xOf(i)); cross.setAttribute('x2', xOf(i)); cross.setAttribute('visibility', 'visible');
            t.show(xOf(i) / W, [h('div', { class: 'crc-tip-head' }, stepLabel(k)), ...series.map((s) => tipLine(s.name, fmt(s.values[i]), s.color))]);
        });
        hit.addEventListener('mouseleave', () => { cross.setAttribute('visibility', 'hidden'); t.hide(); });
        svg.appendChild(hit);
    });
    return h('div', { class: 'crc-chart' },
        series.length > 1 ? h('div', { class: 'crc-legend' }, ...series.map((s) =>
            h('span', { class: 'crc-legend-item' }, h('span', { class: 'crc-key', style: { background: s.color } }), s.name))) : null,
        h('div', { class: 'crc-plot' }, svg, t.tip));
}

/** Столбики по шагам — один ряд (деньги). Наведение — подсказка на столбике. */
export function barChart({ keys, values, name, color = SERIES.one, height = 180, fmt = groupNum }) {
    const max = niceMax(Math.max(0, ...values));
    const { svg, plotH } = frame(height, max, shortMoney);
    const n = Math.max(1, keys.length);
    const slot = (W - PAD.l - PAD.r) / n;
    const bw = Math.max(2, Math.min(36, slot - 2));   // зазор 2px между соседями
    const t = tooltipHost();
    keys.forEach((k, i) => {
        const v = Number(values[i]) || 0;
        const x = PAD.l + slot * i + (slot - bw) / 2;
        const bh = (plotH * v) / max;
        const y = PAD.t + plotH - bh;
        if (bh > 0) {
            const r = Math.min(4, bw / 2, bh);   // скругление только сверху, низ стоит на оси
            svg.appendChild(el('path', {
                d: `M${x} ${PAD.t + plotH}V${y + r}Q${x} ${y} ${x + r} ${y}H${x + bw - r}Q${x + bw} ${y} ${x + bw} ${y + r}V${PAD.t + plotH}Z`,
                fill: color, class: 'crc-bar',
            }));
        }
        const hit = el('rect', { x: PAD.l + slot * i, y: 0, width: slot, height, class: 'crc-hit', 'data-step': k });
        hit.addEventListener('mouseenter', () => t.show((x + bw / 2) / W, [h('div', { class: 'crc-tip-head' }, stepLabel(k)), tipLine(name, fmt(v), null)]));
        hit.addEventListener('mouseleave', () => t.hide());
        svg.appendChild(hit);
    });
    xLabels(svg, keys, (i) => PAD.l + slot * i + slot / 2, height);
    return h('div', { class: 'crc-chart' }, h('div', { class: 'crc-plot' }, svg, t.tip));
}

/**
 * Горизонтальные полосы для сравнения строк (менеджеры, источники, воронка).
 * rows: [{ label, value, part?, valueText, note? }]. Полоса — value от общего
 * максимума; part (если есть) — закрашенная доля внутри неё вторым цветом
 * (например, «пришли» внутри «заявок»).
 */
export function barList({ rows, color = SERIES.one, partColor = SERIES.two, legend = null }) {
    const max = Math.max(1, ...rows.map((r) => Number(r.value) || 0));
    return h('div', { class: 'crc-list' },
        legend ? h('div', { class: 'crc-legend' }, ...legend.map(([name, c]) =>
            h('span', { class: 'crc-legend-item' }, h('span', { class: 'crc-key', style: { background: c } }), name))) : null,
        ...rows.map((r) => {
            const w = ((Number(r.value) || 0) / max) * 100;
            const pw = r.part != null && r.value ? ((Number(r.part) || 0) / (Number(r.value) || 1)) * 100 : null;
            return h('div', { class: 'crc-list-row', title: r.title || null },
                h('div', { class: 'crc-list-label' }, r.label),
                h('div', { class: 'crc-list-track' },
                    h('div', { class: 'crc-list-bar', style: { width: w.toFixed(1) + '%', background: pw != null ? color + '55' : color } },
                        pw != null ? h('div', { class: 'crc-list-part', style: { width: pw.toFixed(1) + '%', background: partColor } }) : null)),
                h('div', { class: 'crc-list-value' }, r.valueText, r.note ? h('span', { class: 'crc-list-note' }, r.note) : null));
        }));
}
