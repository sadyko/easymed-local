// Dashboard — DASHBOARD_TREND_V1 (2026-09-11) — сводка клиники с графиками.
//
// Владелец: «create an appealing dashboard with graphs. add stationary
// patients too into an account. use for design reference bklit.com …
// area-chart and other components that fit».
//
// ЧТО БЫЛО. Шесть плиток «сегодня» по-английски посреди русского продукта, без
// единого «вчера» и без единого слова о стационаре: люди в койках и деньги,
// которые они уже заработали клинике, на сводке не существовали.
//
// ЧТО СТАЛО. Три слоя, сверху вниз — как их читают:
//   1. ПЛИТКИ — восемь чисел на сегодня, стационар среди них равный:
//      «В стационаре», «Занято коек», «Начислено стационару»;
//   2. ДЕНЬГИ ПО ДНЯМ — площадь за период, стопкой: амбулатория снизу,
//      стационар сверху, итог — верхняя кривая. Рядом — кольцо занятости коек
//      и отделения;
//   3. ДВИЖЕНИЕ ЛЮДЕЙ — визиты и поступления столбиками по дням.
// Период (7 / 14 / 30 дней) один на все графики и помнится между заходами.
//
// DASH_ONE_SCREEN_V1 (2026-09-11) — владелец: «make fit everything in to one
// viewport so user won't scroll». Сводка — это ВЗГЛЯД, а не чтение: её
// открывают, чтобы за секунду увидеть, как идёт день, и прокрутка эту секунду
// съедает. Поэтому экран берёт ровно ту высоту, что осталась под шапкой
// (меряется по месту при открытии и при изменении окна), плитки ужаты до
// одного взгляда, а графики растягиваются на то, что осталось: на большом
// мониторе они выше, на ноутбуке — ниже, но всё видно сразу.
//
// БЫСТРЫЕ ДЕЙСТВИЯ — в шапке каждой карточки, а не отдельным блоком: рядом с
// деньгами — касса и отчёты, рядом с койками — стационар, рядом с движением
// людей — очередь и пациенты. Действие стоит там, где на него смотрят.
//
// Числа считает СЕРВЕР (rpc/dashboard.js): здесь только раскладка. Каждый из
// двух запросов отказывает отдельно: сводка без графиков лучше, чем ничего.
import { supabase } from '../../supabase.js';
import { h, Icon, clear, toast, PageHead } from '../ui.js';
import { tr, trf } from '../i18n.js';   // I18N_COVERAGE_V1 — перевод СНАЧАЛА, подстановка ПОТОМ
// MOTION_REVEAL_V1 — тот же помощник появления, что у списка пациентов и
// доски очереди (public/js/admin/motion.js): один словарь движения на всё.
import { revealOn } from '../motion.js?v=mo1';
import { areaChart, barChart, ringGauge, legend } from './dash-charts.js';

const PERIODS = [7, 14, 30];
const PERIOD_KEY = 'dash.days';
/** Ниже этого сводка перестаёт ужиматься и начинает прокручиваться. */
const MIN_FIT_H = 540;

/** Цвета рядов — те же, что у слов «Амбулаторно» и «Стационар» в списках. */
const CLINIC_COLOR = 'var(--primary-600)';
const WARD_COLOR = 'var(--purple-500)';

const refs = { container: null, onNavigate: null, wrap: null, body: null, periodWrap: null };
const state = { days: readPeriod(), summary: null, trend: null };

function readPeriod() {
    try {
        const v = Number(window.localStorage && window.localStorage.getItem(PERIOD_KEY));
        return PERIODS.includes(v) ? v : 14;
    } catch (e) { return 14; }
}
function savePeriod(days) {
    try { window.localStorage && window.localStorage.setItem(PERIOD_KEY, String(days)); } catch (e) { /* без памяти — просто не запомним */ }
}

export async function renderDashboard(container, { onNavigate } = {}) {
    refs.container = container;
    refs.onNavigate = onNavigate;
    // Период перечитывается при каждом открытии: его могли сменить в другой
    // вкладке, и экран обязан открыться на том, что человек выбрал последним.
    state.days = readPeriod();
    mount();
    await fetchAndPaint();
}

const go = (view) => () => refs.onNavigate && refs.onNavigate(view);

// -----------------------------------------------------------------------------
// MOUNT — шапка с периодом; fetchAndPaint() перерисовывает только тело.
// -----------------------------------------------------------------------------
function mount() {
    clear(refs.container);
    refs.periodWrap = h('div', { class: 'segmented', role: 'group', 'aria-label': tr('Период') });
    refs.body = h('div', { class: 'dash-body' });
    refs.wrap = h('div', { class: 'fade-in dash-fit' },
        PageHead({
            title: 'Сводка',
            subtitle: todaySubtitle(),
            right: [
                refs.periodWrap,
                h('button', { class: 'btn btn-sm', type: 'button', onclick: () => fetchAndPaint() },
                    Icon('Refresh', { size: 13 }), ' ', tr('Обновить')),
            ],
        }),
        refs.body,
    );
    refs.container.appendChild(refs.wrap);
    paintPeriod();
    fitToViewport();
}

// DASH_ONE_SCREEN_V1 — высота экрана меряется ПО МЕСТУ, а не считается из
// токенов оболочки: что бы ни стояло над сводкой (верхняя строка, зазор,
// поле области), она берёт ровно остаток окна. На маленьком окне ниже
// MIN_FIT_H ужиматься дальше некуда — тогда честнее прокрутка, чем нечитаемые
// графики.
let fitBound = false;
function fitToViewport() {
    const wrap = refs.wrap;
    if (!wrap || typeof window === 'undefined' || !wrap.getBoundingClientRect || !window.innerHeight) return;
    const top = wrap.getBoundingClientRect().top || 0;
    const avail = Math.round(window.innerHeight - top - 24);
    wrap.style.height = Math.max(MIN_FIT_H, avail) + 'px';
    if (!fitBound && typeof window.addEventListener === 'function') {
        fitBound = true;
        window.addEventListener('resize', () => { if (refs.wrap && refs.wrap.isConnected !== false) fitToViewport(); });
    }
}

function paintPeriod() {
    clear(refs.periodWrap);
    for (const d of PERIODS) {
        refs.periodWrap.appendChild(h('button', {
            type: 'button',
            class: state.days === d ? 'on' : null,
            'aria-pressed': state.days === d ? 'true' : 'false',
            onclick: () => {
                if (state.days === d) return;
                state.days = d;
                savePeriod(d);
                paintPeriod();
                fetchAndPaint();
            },
        }, trf('{n} дней', { n: d })));
    }
}

function todaySubtitle() {
    try {
        return new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date());
    } catch (_) {
        return new Date().toDateString();
    }
}

// -----------------------------------------------------------------------------
// FETCH + REPAINT
// -----------------------------------------------------------------------------
let lastFetchToken = 0;

async function fetchAndPaint() {
    const token = ++lastFetchToken;
    setLoading();
    try {
        const [sum, trend] = await Promise.all([
            supabase.rpc('dashboard_summary', {}),
            supabase.rpc('dashboard_trend', { days: state.days }),
        ]);
        if (token !== lastFetchToken) return;   // a newer fetch already landed
        if (sum.error) {
            toast(trf('Не удалось загрузить сводку: {msg}', { msg: sum.error.message || sum.error }), 'fail');
            paintError();
            return;
        }
        // Графики — отдельный запрос и отдельный отказ: плитки живут без них.
        if (trend.error) toast(trf('Графики не загрузились: {msg}', { msg: trend.error.message || trend.error }), 'fail');
        state.summary = sum.data || {};
        state.trend = trend.error ? null : (trend.data || null);
        paint();
    } catch (e) {
        if (token !== lastFetchToken) return;
        toast(trf('Не удалось загрузить сводку: {msg}', { msg: (e && e.message) || e }), 'fail');
        paintError();
    }
}

function setLoading() {
    if (!refs.body) return;
    clear(refs.body);
    refs.body.appendChild(h('div', { class: 'card', style: { textAlign: 'center', padding: '24px', color: 'var(--ink-500)', fontSize: '12.5px' } }, tr('Загрузка…')));
}

function paintError() {
    if (!refs.body) return;
    clear(refs.body);
    refs.body.appendChild(h('div', { class: 'card', style: { padding: '22px' } },
        h('div', { class: 'empty' }, tr('Сводка не загрузилась.'))));
}

// -----------------------------------------------------------------------------
// ЧИСЛА
// -----------------------------------------------------------------------------
// Thousands-separated price display, no currency symbol (e.g. 50000 -> "50 000").
function fmtPrice(n) {
    const v = Math.round(Number(n) || 0);
    const sign = v < 0 ? '-' : '';
    return sign + String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}
/** Подпись оси: 350 000 → «350 тыс.», 1 200 000 → «1,2 млн». */
function fmtCompact(n) {
    const v = Number(n) || 0;
    const a = Math.abs(v);
    const trim = (x) => String(Math.round(x * 10) / 10).replace('.', ',');
    if (a >= 1e6) return trf('{n} млн', { n: trim(v / 1e6) });
    if (a >= 1e3) return trf('{n} тыс.', { n: trim(v / 1e3) });
    return String(Math.round(v));
}
const num = (v) => String(Number(v) || 0);

// Accent tint per KPI category — fg on the icon glyph, bg behind it (reuses
// the same -700/-50 token pairing as .dash-alert-* / .tag-*).
const KPI_ACCENT = {
    primary: { fg: 'var(--primary-600)', bg: 'var(--primary-50)' },
    ok:      { fg: 'var(--ok-700)',      bg: 'var(--ok-50)' },
    warn:    { fg: 'var(--warn-700)',    bg: 'var(--warn-50)' },
    crit:    { fg: 'var(--crit-700)',    bg: 'var(--crit-50)' },
    info:    { fg: 'var(--info-700)',    bg: 'var(--info-50)' },
    ward:    { fg: 'var(--purple-700)',  bg: 'var(--purple-50)' },
};

// BUILDING_REPORTS_V1 — вторая строка плитки: из чего сложено число.
//
// Клиника из нескольких ЗДАНИЙ (отдельных установок, соединённых branch-sync'ом)
// видела на плитках ОДНО число на два дома и читала его как число своего дома.
// Разрез приходит вместе со сводкой (dashboard_summary.buildings) и печатается
// под значением; клиника в одном здании его не видит вовсе — строка «Main
// Branch: 100%» не сообщает ничего.
function splitLine(d, key, fmt) {
    const list = (d && d.buildings) || [];
    if (list.length < 2) return null;
    return list.map(b => b.label + ': ' + fmt(b[key])).join(' · ');
}

// -----------------------------------------------------------------------------
// РАСКЛАДКА
// -----------------------------------------------------------------------------
function paint() {
    if (!refs.body) return;
    clear(refs.body);
    const d = state.summary || {};
    const t = state.trend;
    const ip = (t && t.inpatient) || {};
    const last = t && t.series && t.series.length ? t.series[t.series.length - 1] : null;

    // 1. Плитки — восемь, стационар среди них.
    const grid = h('div', { class: 'dash-kpi-row' });
    grid.appendChild(kpi({ icon: 'Patients', accent: 'primary', label: 'Пациентов сегодня',
        value: num(d.patients_today), split: splitLine(d, 'patients_today', num),
        onClick: go('patients') }));
    grid.appendChild(kpi({ icon: 'Calendar', accent: 'info', label: 'Визитов сегодня',
        value: num(d.visits_today), split: splitLine(d, 'visits_today', num),
        onClick: go('queue') }));
    grid.appendChild(kpi({ icon: 'Bed', accent: 'ward', label: 'В стационаре',
        value: num(ip.in_bed),
        meta: t ? trf('поступило {a} · выписано {b}', { a: num(ip.admitted_today), b: num(ip.discharged_today) }) : null,
        onClick: go('admissions') }));
    grid.appendChild(kpi({ icon: 'Building', accent: 'ward', label: 'Занято коек',
        value: t ? num(ip.occupancy) + '%' : '—',
        meta: t ? trf('{busy} из {total}', { busy: num(ip.beds_busy), total: num(ip.beds_total) }) : null,
        onClick: go('beds') }));
    grid.appendChild(kpi({ icon: 'Coins', accent: 'ok', label: 'Принято сегодня',
        value: fmtPrice(d.collected_today),
        meta: last ? trf('амбулаторно {a} · стационар {b}', { a: fmtPrice(last.clinic), b: fmtPrice(last.inpatient) }) : null,
        split: splitLine(d, 'collected_today', fmtPrice),
        onClick: go('cashier-shifts') }));
    grid.appendChild(kpi({ icon: 'Receipt', accent: 'crit', label: 'Долг',
        value: fmtPrice(d.outstanding_amount),
        meta: trf('счетов: {n}', { n: num(d.outstanding_count) }),
        split: splitLine(d, 'outstanding_amount', fmtPrice),
        onClick: go('cashier-head') }));
    grid.appendChild(kpi({ icon: 'Wallet', accent: 'ward', label: 'Начислено стационару',
        value: t ? fmtPrice(ip.accrued_unbilled) : '—',
        meta: tr('ещё не выставлено в счёт'),
        onClick: go('admissions') }));
    grid.appendChild(kpi({ icon: 'Flask', accent: 'info', label: 'Анализы в работе',
        value: num(d.lab_pending_count),
        split: splitLine(d, 'lab_pending_count', num),
        onClick: go('labs') }));

    const top = h('div', { class: 'dash-top' }, grid);
    // Низкий остаток — тревога, а не число: плитка «0» не сообщает ничего, а
    // ненулевая полоса — сообщает всё.
    const low = Number(d.low_stock_count) || 0;
    if (low > 0) {
        top.appendChild(h('div', { class: 'dash-alert', role: 'status' },
            Icon('Warning', { size: 16 }),
            h('span', null, trf('Низкий остаток: {n}', { n: low })),
            h('button', { class: 'btn btn-sm', type: 'button', onclick: go('inventory') },
                tr('Открыть склад'))));
    }
    refs.body.appendChild(top);

    // 2. Деньги по дням + койки.
    refs.body.appendChild(h('div', { class: 'dash-grid' }, moneyCard(t), bedsCard(t)));
    // 3. Движение людей.
    refs.body.appendChild(flowCard(t));

    // Плитки приподнимаются при входе в экран — наблюдатель один.
    revealOn(grid, '[data-reveal]');
    fitToViewport();
}

function kpi({ icon, accent, label, value, meta, split, valueWarn, onClick }) {
    const a = KPI_ACCENT[accent] || KPI_ACCENT.primary;
    return h('div', {
        class: 'dash-kpi',
        'data-reveal': '',
        role: onClick ? 'button' : null,
        tabindex: onClick ? '0' : null,
        onclick: onClick || undefined,
    },
        // DASH_ONE_SCREEN_V1 — плитка в один взгляд: значок и подпись одной
        // строкой, число под ними, одна строка пояснения. Две строки таких
        // плиток занимают то, что раньше занимала одна.
        h('div', { class: 'dash-kpi-top' },
            h('div', { class: 'dash-kpi-icon', style: { color: a.fg, background: a.bg } }, Icon(icon, { size: 15 })),
            h('div', { class: 'dash-kpi-label' }, label),
            onClick ? h('span', { class: 'dash-kpi-go' }, Icon('ArrowRight', { size: 14 })) : null,
        ),
        h('div', {
            class: 'dash-kpi-value num',
            style: valueWarn ? { color: 'var(--warn-700)' } : null,
        }, value),
        meta ? h('div', { class: 'dash-kpi-meta', title: meta }, meta) : null,
        split ? h('div', { class: 'dash-kpi-meta', title: split }, split) : null,
    );
}

const MONEY_KEYS = () => [
    { key: 'clinic', label: tr('Амбулаторно'), color: CLINIC_COLOR },
    { key: 'inpatient', label: tr('Стационар'), color: WARD_COLOR },
];
const FLOW_KEYS = () => [
    { key: 'visits', label: tr('Визиты'), color: CLINIC_COLOR },
    { key: 'admissions', label: tr('Госпитализации'), color: WARD_COLOR },
];

/** Быстрое действие в шапке карточки: значок + слово, ведёт в раздел. */
function action(label, icon, view) {
    return h('button', { class: 'btn btn-ghost btn-sm dash-act', type: 'button', onclick: go(view) },
        Icon(icon, { size: 13 }), ' ', tr(label));
}

function card(title, icon, right, actions, body) {
    return h('div', { class: 'card dash-card', 'data-reveal': '' },
        h('div', { class: 'card-header' },
            h('h3', null, Icon(icon, { size: 16 }), ' ', tr(title)),
            h('div', { class: 'dash-card-right' },
                ...(right || []).filter(Boolean),
                actions && actions.length ? h('div', { class: 'dash-card-acts' }, ...actions) : null)),
        h('div', { class: 'dash-card-body' }, body));
}

/** Деньги по дням: площадь стопкой, итог за период в шапке. */
function moneyCard(t) {
    const keys = MONEY_KEYS();
    const total = t && t.totals ? t.totals.total : null;
    return card('Деньги по дням', 'Coins', [
        legend(keys),
        total != null ? h('span', { class: 'dash-card-total', title: tr('Всего за период') }, fmtPrice(total)) : null,
    ], [action('Касса', 'Coins', 'cashier-shifts'), action('Отчёты', 'Chart', 'reports-hub')],
    areaChart({ series: (t && t.series) || [], keys, fmt: fmtPrice, fmtY: fmtCompact }));
}

/** Койки: кольцо занятости и отделения. */
function bedsCard(t) {
    const ip = (t && t.inpatient) || null;
    const body = h('div', { class: 'dash-beds-body' });
    if (!ip || !ip.beds_total) {
        body.appendChild(h('div', { class: 'dash-chart-empty' }, tr('Коек нет')));
    } else {
        body.appendChild(h('div', { class: 'dash-beds' },
            ringGauge({ value: ip.beds_busy, max: ip.beds_total, color: WARD_COLOR, label: tr('занято') }),
            h('div', null,
                h('div', { class: 'dash-beds-n' }, trf('{busy} из {total}', { busy: num(ip.beds_busy), total: num(ip.beds_total) })),
                h('div', { class: 'dash-beds-s' }, trf('свободно {n}', { n: num(ip.beds_total - ip.beds_busy) })),
                h('div', { class: 'dash-beds-s' }, trf('в койках {n}', { n: num(ip.in_bed) })))));
        const wards = h('div', { class: 'dash-wards' });
        for (const w of ip.wards || []) {
            const pct = w.beds ? Math.round((w.busy / w.beds) * 100) : 0;
            wards.appendChild(h('div', { class: 'dash-ward' },
                h('span', { class: 'dash-ward-name' }, w.name || ''),
                h('span', { class: 'dash-ward-bar', title: pct + '%' }, h('i', { style: { width: pct + '%' } })),
                h('span', { class: 'dash-ward-n' }, num(w.busy) + ' / ' + num(w.beds))));
        }
        body.appendChild(wards);
    }
    return card('Койки', 'Bed', [
        ip && ip.beds_total ? h('span', { class: 'dash-card-total' }, num(ip.occupancy) + '%') : null,
    ], [action('Стационар', 'Bed', 'admissions'), action('Койки', 'Building', 'beds')], body);
}

/** Визиты и госпитализации по дням. */
function flowCard(t) {
    const keys = FLOW_KEYS();
    return card('Визиты и госпитализации', 'Activity', [legend(keys)],
        [action('Очередь', 'Clock', 'queue'), action('Пациенты', 'Patients', 'patients')],
        barChart({ series: (t && t.series) || [], keys, fmt: num }));
}
