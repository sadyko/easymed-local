// DASHBOARD_TREND_V1 (2026-09-11) — ГРАФИКИ СВОДКИ: площадь, столбики, кольцо.
//
// Владелец: «create an appealing dashboard with graphs … use for design
// reference https://bklit.com/docs/components/area-chart».
//
// Чистый SVG без библиотек: приложение живёт в клинике без интернета, и
// каждая внешняя зависимость — это то, что однажды не загрузится. Из образца
// взято то, что делает график читаемым, а не украшением:
//   • заливка площади — градиент от цвета линии к прозрачному, линия сверху;
//   • горизонтальная сетка с подписями значений, ось X с датами;
//   • перекрестие и подсказка под курсором — по ближайшей точке, а не по
//     пикселю, чтобы попадать пальцем и на планшете;
//   • появление — «раскрытие» слева направо (clip-path), под общим выключателем
//     движения (prefers-reduced-motion в admin.css схлопывает его до нуля).
//
// ДВА СЛОЯ, А НЕ ОДИН (DASH_HOVER_STILL_V1, 2026-09-11 — владелец: «on hover
// the graph restarting every time»). Первая версия перерисовывала весь SVG на
// каждое движение мыши, и вместе с ним заново запускалось раскрытие: график
// «вздрагивал» под курсором. Теперь ОСНОВА (сетка, оси, площади, столбики)
// рисуется один раз на размер и раскрывается один раз, а под курсором
// перерисовывается только ПРОЗРАЧНЫЙ СЛОЙ сверху — перекрестие, точки,
// полоса над столбиком. Основа под ним не шевелится.
//
// РАЗМЕР — ОТ КОНТЕЙНЕРА. Высота не задаётся числом: карточка отдаёт графику
// то место, что осталось после шапки, и сводка целиком помещается в экран
// без прокрутки (DASH_ONE_SCREEN_V1). Без измеримого контейнера (тесты,
// скрытая вкладка) берутся размеры по умолчанию — график всё равно рисуется.
//
// ЦВЕТ. Ряды графика — это не тяжесть и не личность: бирюза (--primary) для
// амбулатории, фиолетовый (--purple) для стационара — тем же словом, каким
// стационар помечен в списках («Стационар» — tag-violet). Семантические пары
// (--ok/--warn/--crit) на графике не появляются: они значат «хорошо/плохо».
//
// КЕГЛЬ. Единственный размер текста на графике — 12.5 px, ступень шкалы.
import { h, html, clear } from '../ui.js';
import { tr } from '../i18n.js';

/** Единственный кегль графика — ступень шкалы (TYPE_SCALE_V1). */
const FONT = 12.5;
const DEFAULT_W = 640;
const DEFAULT_H = 220;
const MIN_H = 120;
const PAD = { top: 14, right: 12, bottom: 26, left: 52 };

let uid = 0;
const f1 = (n) => (Math.round(n * 10) / 10).toString();
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Верх шкалы — «красивое» число не ниже максимума: 1 / 2 / 2.5 / 5 × 10ⁿ. */
export function niceMax(v) {
    if (!(v > 0)) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    const m = v / p;
    const step = m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10;
    return step * p;
}

/**
 * Монотонная кубическая кривая (Fritsch–Carlson) — как curveMonotoneX в
 * образце: гладкая, но не «перелетает» точки, поэтому нулевой день остаётся
 * нулём, а не уходит под ось.
 */
export function monotonePath(pts) {
    const n = pts.length;
    if (!n) return '';
    if (n === 1) return `M ${f1(pts[0].x)} ${f1(pts[0].y)}`;
    const dx = [], m = [];
    for (let i = 0; i < n - 1; i++) {
        dx[i] = pts[i + 1].x - pts[i].x;
        m[i] = dx[i] ? (pts[i + 1].y - pts[i].y) / dx[i] : 0;
    }
    const t = [m[0]];
    for (let i = 1; i < n - 1; i++) t[i] = (m[i - 1] * m[i] <= 0) ? 0 : (m[i - 1] + m[i]) / 2;
    t[n - 1] = m[n - 2];
    for (let i = 0; i < n - 1; i++) {
        if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
        const a = t[i] / m[i], b = t[i + 1] / m[i], s = a * a + b * b;
        if (s > 9) { const tau = 3 / Math.sqrt(s); t[i] = tau * a * m[i]; t[i + 1] = tau * b * m[i]; }
    }
    let d = `M ${f1(pts[0].x)} ${f1(pts[0].y)}`;
    for (let i = 0; i < n - 1; i++) {
        const hh = dx[i] / 3;
        d += ` C ${f1(pts[i].x + hh)} ${f1(pts[i].y + t[i] * hh)} ${f1(pts[i + 1].x - hh)} ${f1(pts[i + 1].y - t[i + 1] * hh)} ${f1(pts[i + 1].x)} ${f1(pts[i + 1].y)}`;
    }
    return d;
}

/** «05.09» — дата на оси. Локально-нейтрально, без слов. */
export function shortDay(iso) {
    const s = String(iso || '');
    return s.length >= 10 ? s.slice(8, 10) + '.' + s.slice(5, 7) : s;
}

/** Сколько подписей оси X влезает: не чаще одной на 64 px. */
function labelEvery(n, plotW) {
    return Math.max(1, Math.ceil(n / Math.max(1, Math.floor(plotW / 64))));
}

/** Сетка и подписи значений по оси Y. */
function yGrid({ plotW, plotH, max, fmtY }) {
    const ticks = 4;
    let s = '';
    for (let i = 0; i <= ticks; i++) {
        const v = (max * i) / ticks;
        const y = PAD.top + plotH - (v / max) * plotH;
        s += `<line class="dc-grid" x1="${PAD.left}" x2="${PAD.left + plotW}" y1="${f1(y)}" y2="${f1(y)}"/>`;
        s += `<text class="dc-ax" x="${PAD.left - 8}" y="${f1(y + 4)}" text-anchor="end" font-size="${FONT}">${esc(fmtY(v))}</text>`;
    }
    return s;
}

/** Подписи дат по оси X: xAt(i) — центр точки или группы столбиков. */
function xLabels({ H, plotW, series, x, xAt }) {
    const n = series.length;
    const every = labelEvery(n, plotW);
    let s = '';
    for (let i = 0; i < n; i++) {
        if (i % every !== 0 && i !== n - 1) continue;
        s += `<text class="dc-ax" x="${f1(xAt(i))}" y="${H - 8}" text-anchor="middle" font-size="${FONT}">${esc(shortDay(series[i][x]))}</text>`;
    }
    return s;
}

const svgOpen = (cls, W, H, label) =>
    `<svg class="${cls}" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(label)}">`;

/**
 * Рамка графика: контейнер, размер, наведение, подсказка.
 *
 *   drawBase(W, H, animate)  — основа; рисуется на размер, раскрывается ОДИН раз;
 *   drawOverlay(W, H, i)     — слой под курсором; перерисовывается на каждое
 *                              движение, основу не трогает;
 *   tipFor(i)                — строки подсказки для точки i;
 *   xAt(W, i)                — где по горизонтали стоит точка i (для подсказки).
 */
function chartFrame({ count, height, drawBase, drawOverlay, tipFor, xAt, label }) {
    const wrap = h('div', { class: 'dash-chart' + (height ? '' : ' dash-chart-fill'), style: height ? { height: height + 'px' } : null });
    const tip = h('div', { class: 'dash-chart-tip', hidden: true });
    let hover = null;
    let W = DEFAULT_W, H = height || DEFAULT_H;
    let baseEl = null, overEl = null;
    let revealed = false;

    function measure() {
        const rect = wrap.getBoundingClientRect ? wrap.getBoundingClientRect() : null;
        const w = wrap.clientWidth || (rect && rect.width);
        const hh = height || wrap.clientHeight || (rect && rect.height);
        const nextW = Math.max(240, Math.round(w || DEFAULT_W));
        const nextH = Math.max(MIN_H, Math.round(hh || DEFAULT_H));
        const changed = nextW !== W || nextH !== H;
        W = nextW; H = nextH;
        return changed;
    }
    function paintBase() {
        const next = html(drawBase(W, H, !revealed));
        revealed = true;
        if (baseEl) wrap.removeChild(baseEl);
        wrap.appendChild(next);
        baseEl = next;
    }
    function paintOverlay() {
        if (overEl) { wrap.removeChild(overEl); overEl = null; }
        if (hover == null) { tip.hidden = true; return; }
        overEl = html(drawOverlay(W, H, hover));
        wrap.appendChild(overEl);
        clear(tip);
        const lines = tipFor(hover);
        for (let i = 0; i < lines.length; i++) {
            const l = lines[i];
            tip.appendChild(h('div', { class: i === 0 ? 'dash-chart-tip-h' : 'dash-chart-tip-l' },
                l.color ? h('i', { class: 'dash-chart-tip-dot', style: { background: l.color } }) : null,
                h('span', null, l.label), l.value != null ? h('b', null, l.value) : null));
        }
        const px = xAt(W, hover);
        // Подсказка держится внутри графика: у правого края переезжает влево.
        tip.style.left = Math.round(px) + 'px';
        tip.className = 'dash-chart-tip' + (px > W * 0.68 ? ' flip' : '');
        tip.hidden = false;
    }
    function indexAt(clientX) {
        const rect = wrap.getBoundingClientRect ? wrap.getBoundingClientRect() : { left: 0 };
        const plotW = W - PAD.left - PAD.right;
        const rel = (clientX - rect.left - PAD.left) / Math.max(1, plotW);
        return Math.max(0, Math.min(count - 1, Math.round(rel * (count - 1))));
    }
    wrap.addEventListener('mousemove', (e) => { const i = indexAt(e.clientX); if (i !== hover) { hover = i; paintOverlay(); } });
    wrap.addEventListener('mouseleave', () => { if (hover != null) { hover = null; paintOverlay(); } });
    wrap.addEventListener('touchstart', (e) => { const t = e.touches && e.touches[0]; if (t) { hover = indexAt(t.clientX); paintOverlay(); } }, { passive: true });

    wrap.appendChild(tip);
    // Размер известен только после вставки в документ: первый кадр рисуется
    // на размере по умолчанию, второй — по месту. Раскрытие идёт один раз —
    // на первом кадре; перерисовка по месту его не перезапускает.
    measure(); paintBase();
    const refit = () => { if (measure()) { paintBase(); paintOverlay(); } };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(refit);
    if (typeof ResizeObserver === 'function') {
        try { new ResizeObserver(refit).observe(wrap); } catch (e) { /* без наблюдателя — первый кадр */ }
    }
    wrap.setAttribute('aria-label', label || '');
    return wrap;
}

/**
 * ГРАФИК ПЛОЩАДИ — ряды по дням, сложенные стопкой (нижний + верхний = итог).
 *
 * @param series  [{ date, ...keys }]
 * @param keys    [{ key, label, color }] — снизу вверх
 * @param fmt     число → подпись в подсказке
 * @param fmtY    число → подпись оси (короче)
 * @param height  фиксированная высота; без неё график занимает контейнер
 */
export function areaChart({ series = [], x = 'date', keys = [], fmt = String, fmtY = fmt, height = null } = {}) {
    if (!series.length || !keys.length) return h('div', { class: 'dash-chart-empty' }, tr('Нет данных'));
    const id = 'dc' + (++uid);
    const n = series.length;
    const stackedMax = Math.max(...series.map((r) => keys.reduce((s, k) => s + (Number(r[k.key]) || 0), 0)));
    const max = niceMax(stackedMax);
    const label = keys.map((k) => k.label).join(', ');
    const geom = (W, H) => {
        const plotW = W - PAD.left - PAD.right, plotH = H - PAD.top - PAD.bottom;
        return {
            plotW, plotH,
            xAt: (i) => n === 1 ? PAD.left + plotW / 2 : PAD.left + (i / (n - 1)) * plotW,
            yAt: (v) => PAD.top + plotH - (v / max) * plotH,
        };
    };
    // Верхняя кривая каждого ряда в стопке — одна на все слои.
    const tops = [];
    let base = series.map(() => 0);
    for (const k of keys) {
        const top = series.map((r, i) => base[i] + (Number(r[k.key]) || 0));
        tops.push(top);
        base = top;
    }

    function drawBase(W, H, animate) {
        const g = geom(W, H);
        let defs = '', layers = '';
        keys.forEach((k, ki) => {
            const upper = tops[ki].map((v, i) => ({ x: g.xAt(i), y: g.yAt(v) }));
            const lowerVals = ki === 0 ? series.map(() => 0) : tops[ki - 1];
            const lower = lowerVals.map((v, i) => ({ x: g.xAt(i), y: g.yAt(v) })).reverse();
            const line = monotonePath(upper);
            const back = monotonePath(lower).replace(/^M/, 'L');
            const gid = `${id}-g${ki}`;
            defs += `<linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stop-color="${k.color}" stop-opacity="0.32"/>
                <stop offset="1" stop-color="${k.color}" stop-opacity="0.02"/></linearGradient>`;
            layers += `<path class="dc-area" d="${line} ${back} Z" fill="url(#${gid})"/>`;
            layers += `<path class="dc-line" d="${line}" fill="none" stroke="${k.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
        });
        return `${svgOpen('dc', W, H, label)}
            <defs>${defs}<clipPath id="${id}-clip"><rect class="${animate ? 'dc-reveal' : ''}" x="0" y="0" width="${W}" height="${H}"/></clipPath></defs>
            ${yGrid({ plotW: g.plotW, plotH: g.plotH, max, fmtY })}
            ${xLabels({ H, plotW: g.plotW, series, x, xAt: g.xAt })}
            <g clip-path="url(#${id}-clip)">${layers}</g>
        </svg>`;
    }
    function drawOverlay(W, H, i) {
        const g = geom(W, H);
        const cx = g.xAt(i);
        let s = `<line class="dc-cross" x1="${f1(cx)}" x2="${f1(cx)}" y1="${PAD.top}" y2="${PAD.top + g.plotH}"/>`;
        keys.forEach((k, ki) => {
            s += `<circle class="dc-dot" cx="${f1(cx)}" cy="${f1(g.yAt(tops[ki][i]))}" r="4.5" fill="${k.color}"/>`;
        });
        return `${svgOpen('dc dc-over', W, H, '')}${s}</svg>`;
    }
    function tipFor(i) {
        const r = series[i];
        const lines = [{ label: shortDay(r[x]) }];
        let total = 0;
        for (const k of keys) { const v = Number(r[k.key]) || 0; total += v; lines.push({ label: k.label, value: fmt(v), color: k.color }); }
        if (keys.length > 1) lines.push({ label: tr('Всего'), value: fmt(total) });
        return lines;
    }
    return chartFrame({ count: n, height, drawBase, drawOverlay, tipFor, xAt: (W, i) => geom(W, DEFAULT_H).xAt(i), label });
}

/**
 * СТОЛБИКИ — по группе столбиков на день, по столбику на ряд. Под курсором —
 * полоса над группой (слой сверху), сами столбики не перерисовываются.
 */
export function barChart({ series = [], x = 'date', keys = [], fmt = String, height = null } = {}) {
    if (!series.length || !keys.length) return h('div', { class: 'dash-chart-empty' }, tr('Нет данных'));
    const n = series.length;
    const max = niceMax(Math.max(...series.map((r) => Math.max(...keys.map((k) => Number(r[k.key]) || 0)))));
    const label = keys.map((k) => k.label).join(', ');
    const geom = (W, H) => {
        const plotW = W - PAD.left - PAD.right, plotH = H - PAD.top - PAD.bottom;
        const slot = plotW / n;
        const gap = Math.min(10, slot * 0.25);
        return { plotW, plotH, slot, gap, bw: Math.max(2, (slot - gap) / keys.length), xAt: (i) => PAD.left + i * slot + slot / 2 };
    };

    function drawBase(W, H, animate) {
        const g = geom(W, H);
        let bars = '';
        series.forEach((r, i) => {
            const x0 = PAD.left + i * g.slot + g.gap / 2;
            keys.forEach((k, ki) => {
                const v = Number(r[k.key]) || 0;
                const bh = (v / max) * g.plotH;
                bars += `<rect class="dc-bar" x="${f1(x0 + ki * g.bw)}" y="${f1(PAD.top + g.plotH - bh)}" width="${f1(Math.max(0, g.bw - 1))}" height="${f1(bh)}" rx="2" fill="${k.color}"/>`;
            });
        });
        return `${svgOpen('dc', W, H, label)}
            ${yGrid({ plotW: g.plotW, plotH: g.plotH, max, fmtY: (v) => fmt(Math.round(v)) })}
            ${xLabels({ H, plotW: g.plotW, series, x, xAt: g.xAt })}
            <g class="dc-bars${animate ? ' dc-rise' : ''}">${bars}</g>
        </svg>`;
    }
    function drawOverlay(W, H, i) {
        const g = geom(W, H);
        return `${svgOpen('dc dc-over', W, H, '')}<rect class="dc-band" x="${f1(PAD.left + i * g.slot)}" y="${PAD.top}" width="${f1(g.slot)}" height="${f1(g.plotH)}" rx="4"/></svg>`;
    }
    function tipFor(i) {
        const r = series[i];
        return [{ label: shortDay(r[x]) }, ...keys.map((k) => ({ label: k.label, value: fmt(Number(r[k.key]) || 0), color: k.color }))];
    }
    return chartFrame({ count: n, height, drawBase, drawOverlay, tipFor, xAt: (W, i) => geom(W, DEFAULT_H).xAt(i), label });
}

/**
 * КОЛЬЦО — доля, одним числом в центре. Занятость коек: 7 из 12 → 58 %.
 */
export function ringGauge({ value = 0, max = 100, size = 112, stroke = 10, color = 'var(--primary-600)', label = '' } = {}) {
    const r = (size - stroke) / 2;
    const c = 2 * Math.PI * r;
    const share = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
    const off = c - share * c;
    const pct = Math.round(share * 100);
    const wrap = h('div', { class: 'dash-ring', style: { width: size + 'px', height: size + 'px' } });
    wrap.appendChild(html(`<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="${esc(label)} ${pct}%">
        <circle cx="${size / 2}" cy="${size / 2}" r="${r}" stroke="var(--ink-100)" stroke-width="${stroke}" fill="none"/>
        <circle class="dash-ring-arc" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke="${color}" stroke-width="${stroke}" fill="none"
            stroke-dasharray="${f1(c)}" stroke-dashoffset="${f1(off)}" stroke-linecap="round" transform="rotate(-90 ${size / 2} ${size / 2})"/>
    </svg>`));
    wrap.appendChild(h('div', { class: 'dash-ring-v' }, h('b', null, pct + '%'), label ? h('span', null, label) : null));
    return wrap;
}

/** Легенда: точка цвета + подпись, по ряду. */
export function legend(keys) {
    return h('div', { class: 'dash-legend' },
        ...keys.map((k) => h('span', { class: 'dash-legend-i' }, h('i', { style: { background: k.color } }), k.label)));
}
