// DASHBOARD_TREND_V1 (2026-09-11) — сводка с графиками и стационаром.
//
// Владелец: «create an appealing dashboard with graphs. add stationary
// patients too into an account». Что здесь утверждается:
//   1. СТАЦИОНАР НА СВОДКЕ. Плитки «В стационаре», «Занято коек» и
//      «Начислено стационару» показывают ТО, что прислал сервер;
//   2. ДЕНЬГИ ПО ДНЯМ — площадь из ДВУХ рядов (амбулатория + стационар) с
//      градиентной заливкой; легенда называет оба;
//   3. ПЕРИОД ОДИН НА ВСЁ: переключение «30 дней» перечитывает ряды с
//      days=30 и запоминается;
//   4. ОТДЕЛЕНИЯ ПОД КОЛЬЦОМ — строка на отделение, занято/всего;
//   5. ТРЕВОГА О СКЛАДЕ — полоса только когда остаток низкий;
//   6. КЕГЛЬ ГРАФИКА — единственный, 12.5 px (TYPE_SCALE_V1);
//   7. ГРАФИКИ ОТКАЗАЛИ — плитки всё равно на месте.
import { test } from 'node:test';
import assert from 'node:assert';

// ─── минимальный DOM ────────────────────────────────────────────────────────
class FakeNode {
    constructor(tag) {
        this.tagName = String(tag).toUpperCase();
        this.style = {}; this.children = []; this.attrs = {};
        this.className = ''; this._text = ''; this._l = {}; this.dataset = {};
        this.value = ''; this.hidden = false;
    }
    appendChild(c) { this.children.push(c); return c; }
    removeChild(c) { const i = this.children.indexOf(c); if (i > -1) this.children.splice(i, 1); return c; }
    get firstChild() { return this.children.length ? this.children[0] : null; }
    replaceChildren() { this.children.length = 0; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); }
    removeAttribute(k) { delete this.attrs[k]; }
    addEventListener(t, fn) { (this._l[t] || (this._l[t] = [])).push(fn); }
    removeEventListener() {}
    dispatch(t, e) { for (const fn of this._l[t] || []) fn(e || {}); }
    click() { this.dispatch('click', { currentTarget: this, preventDefault() {}, stopPropagation() {} }); }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    remove() {}
    focus() {} blur() {}
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
    set textContent(v) { this._text = String(v); this.children.length = 0; }
    get classList() { const s = this; return { contains: (c) => String(s.className).split(/\s+/).includes(c), add() {}, remove() {}, toggle() {} }; }
    get isConnected() { return true; }
}
class FakeText extends FakeNode { constructor(t) { super('#text'); this.nodeType = 3; this._text = String(t); } }
function mkEl(tag) {
    const el = new FakeNode(tag);
    if (el.tagName === 'TEMPLATE') {
        el.content = { firstChild: null };
        Object.defineProperty(el, 'innerHTML', {
            set(v) { const s = new FakeNode('svg'); s._text = String(v); el.content.firstChild = s; },
            get() { return ''; },
        });
    }
    return el;
}
globalThis.Node = FakeNode;
const BODY = mkEl('body');
globalThis.document = {
    createElement: mkEl, createElementNS: (_n, t) => mkEl(t), createTextNode: (t) => new FakeText(t),
    head: mkEl('head'), body: BODY, documentElement: mkEl('html'),
    addEventListener() {}, removeEventListener() {},
    getElementById(id) { return BODY.children.find((c) => c.attrs && c.attrs.id === id) || null; },
};
const STORE = {};
globalThis.window = {
    location: { hostname: 'localhost' },
    localStorage: { getItem: (k) => (k in STORE ? STORE[k] : null), setItem(k, v) { STORE[k] = String(v); } },
    addEventListener() {},
};
// I18N_LOCALE_PIN_V1 — экран рисуется по-русски независимо от локали машины.
globalThis.localStorage = { getItem: (k) => (k === 'admin.lang' ? 'ru' : null), setItem() {}, removeItem() {}, clear() {} };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();

const walk = (e, out = []) => { if (!e || typeof e !== 'object') return out; out.push(e); for (const c of e.children || []) walk(c, out); return out; };
const textOf = (e) => walk(e).map((x) => x._text || '').join(' ');
const byClass = (root, c) => walk(root).filter((e) => String(e.className || '').split(/\s+/).includes(c));
const findBtn = (root, label) => walk(root).find((e) => e.tagName === 'BUTTON' && textOf(e).includes(label));
const svgs = (root) => walk(root).filter((e) => e.tagName === 'SVG' && /<svg class="dc"/.test(e._text || ''));
const overlays = (root) => walk(root).filter((e) => e.tagName === 'SVG' && /<svg class="dc dc-over"/.test(e._text || ''));
const settle = () => new Promise((r) => setTimeout(r, 30));

// ─── данные, которые отдаёт «сервер» ────────────────────────────────────────
const SUMMARY = {
    patients_today: 12, visits_today: 9, collected_today: 1450000,
    outstanding_count: 3, outstanding_amount: 420000, low_stock_count: 0, lab_pending_count: 4,
    buildings: [{ label: 'Main', patients_today: 12 }], building_count: 1,
};
function day(offset) {
    const d = new Date(Date.UTC(2026, 8, 11) - offset * 86400000);
    return d.toISOString().slice(0, 10);
}
function trendFor(days) {
    const series = [];
    for (let i = days - 1; i >= 0; i--) {
        series.push({ date: day(i), clinic: 100000 * (days - i), inpatient: 50000 * (i % 3), total: 0, visits: 5 + (i % 4), admissions: i % 2, discharges: 0 });
    }
    for (const r of series) r.total = r.clinic + r.inpatient;
    return {
        days, from: series[0].date, to: series[series.length - 1].date, series,
        totals: { clinic: 1, inpatient: 1, total: 1234567, visits: 1, admissions: 1, discharges: 0 },
        inpatient: {
            in_bed: 7, beds_total: 12, beds_busy: 7, occupancy: 58,
            admitted_today: 2, discharged_today: 1, accrued_unbilled: 860000,
            wards: [{ id: 1, name: 'Терапия', beds: 8, busy: 5 }, { id: 2, name: 'Хирургия', beds: 4, busy: 2 }],
        },
    };
}
let summary = SUMMARY;
let overview = null;   // DASHBOARD_OVERVIEW_V1 — задаёт сам тест вкладки
let trendFail = false;
const rpcCalls = [];
globalThis.fetch = async (url, opts) => {
    const u = String(url);
    const body = opts && opts.body ? JSON.parse(opts.body) : {};
    if (u.startsWith('/api/rpc/')) {
        const name = decodeURIComponent(u.slice('/api/rpc/'.length));
        rpcCalls.push({ name, args: body });
        if (name === 'dashboard_summary') return { ok: true, json: async () => ({ data: summary }) };
        if (name === 'dashboard_overview') return { ok: true, json: async () => ({ data: overview }) };
        if (name === 'dashboard_trend') {
            if (trendFail) return { ok: false, status: 500, json: async () => ({ error: { message: 'boom' } }) };
            return { ok: true, json: async () => ({ data: trendFor(Number(body.days) || 14) }) };
        }
    }
    return { ok: true, json: async () => ({ data: null }) };
};

const { renderDashboard } = await import('../views/dashboard.js');
const { niceMax, monotonePath, shortDay } = await import('../views/dash-charts.js');

async function screen() {
    rpcCalls.length = 0;
    BODY.children.length = 0;
    delete STORE['dash.days'];   // каждый тест открывает сводку с периодом по умолчанию
    const root = mkEl('div');
    const nav = [];
    await renderDashboard(root, { onNavigate: (v) => nav.push(v) });
    await settle();
    return { root, nav };
}

// ─── 1. Стационар на сводке ─────────────────────────────────────────────────
test('верх шкалы — «красивое» число не ниже максимума', () => {
    assert.strictEqual(niceMax(0), 1);
    assert.strictEqual(niceMax(7), 10);
    assert.strictEqual(niceMax(1400000), 2000000);
    assert.strictEqual(niceMax(2300000), 2500000);
    assert.strictEqual(niceMax(50000), 50000);
});

test('монотонная кривая проходит через точки и не «перелетает» нули', () => {
    const d = monotonePath([{ x: 0, y: 100 }, { x: 50, y: 100 }, { x: 100, y: 20 }]);
    assert.ok(d.startsWith('M 0 100'), d);
    assert.ok(d.endsWith('100 20'), d);
    // Между двумя равными точками кривая — прямая: контрольные точки на той же высоте.
    assert.ok(/C 16\.7 100 33\.3 100 50 100/.test(d), d);
});

// ─── V3120_FIX — плитки и деньги по праву роли ─────────────────────────────
//
// Осмотр 2026-09-27: плитка «Долг» у медсестры вела в «Нет доступа», а деньги
// сводки отдавались каждой роли. Теперь закрытый раздел — плитка без перехода,
// а без права на выручку сервер денег не присылает и экран говорит почему.
// DASHBOARD_OVERVIEW_V1 — ответ dashboard_overview для тестов вкладки обзора.
function overviewData() {
    return {
        period: { days: 14, from: '2026-10-17', to: '2026-10-30', prev_from: '2026-10-03', prev_to: '2026-10-16' },
        money_visible: true,
        patients: { new: 40, new_prev: 20, visits: 120, visits_prev: 100, unique: 90, first: 80, repeat: 40, cancelled: 3,
            ages: { child: 10, young: 50, middle: 20, senior: 10, unknown: 0 }, referrals: [{ name: 'Д-р Каримов', n: 7 }] },
        directions: [{ name: 'Консультации', inpatient: false, n: 60, done: 50, sum: 6000000 },
            { name: null, inpatient: true, n: 5, done: 5, sum: 3000000 }],
        doctors: [{ id: 1, name: 'Врач Один', specialty: '', patients: 30, n: 45, done: 40, sum: 4500000 }],
        services: [{ id: 1, name: 'Консультация', n: 60, sum: 6000000 }],
        finance: { collected: 9000000, collected_prev: 7500000, refunds: 0, invoices: 100, avg_check: 90000, discounts: 0,
            methods: [{ method: 'cash', sum: 6000000 }, { method: 'card', sum: 3000000 }],
            debt_aging: { d7: { n: 1, sum: 100000 }, d30: { n: 0, sum: 0 }, older: { n: 2, sum: 500000 } },
            shifts_closed: 10, shifts_off: 0, shortage: 0, surplus: 0, shifts_open: 0 },
        crm: { leads: 50, leads_prev: 40, won: 10, won_prev: 8, lost: 5, open: 35, conversion: 20, conversion_prev: 20,
            stages: [{ key: 'came', label: 'Пришёл', kind: 'won', color: 'ok', n: 10 }],
            sources: [{ key: 'call', label: 'Звонок', n: 50, won: 10 }], operators: [{ id: 1, name: 'Оператор', n: 50, won: 10 }],
            open_now: 35, unassigned_now: 0, tasks_overdue: 2, meta_leads: 0 },
        calls: { incoming: 200, outgoing: 100, answered: 180, missed: 20, incoming_prev: 150, missed_prev: 10,
            answer_rate: 90, answer_rate_prev: 93, avg_wait_sec: 12, talk_min: 600, not_called_back: 4 },
        series: [{ date: '2026-10-30', leads: 3, calls_in: 15, missed: 2 }],
        telegram: { subscribers: 300, blocked: 2, new_subscribers: 12, new_subscribers_prev: 10, messages_in: 40, replies: 30,
            chats: 20, unread: 0, unread_chats: 0, docs_sent: 25, docs_failed: 0, broadcasts: 1, broadcast_sent: 290,
            broadcast_failed: 0, deeplink_leads: 3 },
        lab: { ordered: 80, verified: 70, avg_tat_hours: 5.5, results: 300, abnormal: 30, abnormal_pct: 10 },
        inpatient: { admissions: 6, admissions_prev: 4, discharges: 5, avg_los_days: 4.2 },
    };
}
test('DASHBOARD_OVERVIEW_V1: сводка — это обзор клиники: читает обзор за период', async () => {
    overview = overviewData();
    try {
        const { root, nav } = await screen();
        await settle();
        const calls = rpcCalls.filter((c) => c.name === 'dashboard_overview');
        assert.strictEqual(calls.length, 1);
        assert.strictEqual(calls[0].args.days, 1, 'сводка открывается на «Сегодня»');
        const text = textOf(root);
        for (const title of ['Финансы', 'Направления', 'Врачи', 'Популярные услуги', 'CRM — заявки', 'Телефония', 'Telegram-бот', 'Пациенты', 'Лаборатория и стационар']) {
            assert.ok(text.includes(title), 'нет карточки «' + title + '»');
        }
        assert.ok(text.includes('+20% к прошлому периоду'), 'выручка без сравнения с прошлым периодом');
        // Требует внимания: 4 номера без ответа, 2 просроченные задачи, долг старше 30 дней.
        const attn = byClass(root, 'dho-attn-i');
        assert.strictEqual(attn.length, 3, textOf(byClass(root, 'dho-attn')[0]));
        attn[0].click();
        assert.strictEqual(nav[nav.length - 1], 'crm', 'пропущенные звонки ведут не в CRM');
    } finally { overview = null; }
});

test('DASHBOARD_OVERVIEW_V1: раздел без доступа (null) не рисуется, пустое внимание — «всё спокойно»', async () => {
    const o = overviewData();
    o.finance = null; o.crm = null; o.calls = null; o.telegram = null; o.money_visible = false;
    overview = o;
    try {
        const { root } = await screen();
        await settle();
        const text = textOf(root);
        for (const title of ['Финансы', 'CRM — заявки', 'Телефония', 'Telegram-бот']) {
            assert.ok(!text.includes(title), 'карточка «' + title + '» нарисована без доступа');
        }
        assert.ok(text.includes('Всё спокойно — срочного нет'));
    } finally { overview = null; }
});

// DASHBOARD_CEO_V1 — отделы для руководителя (dash-overview-depts.js).
test('DASHBOARD_CEO_V1: маркетинг, колл-центр, амбулатория, стационар, процедуры, склад, направители — карточками; срочное — во «внимании»', async () => {
    const o = overviewData();
    o.marketing = {
        meta: { leads: 12, leads_prev: 8, errors: 1, merged: 2, won: 4, patients: 4, campaigns: [{ name: 'Осень', n: 10, won: 4, patients: 4, revenue: 900000 }] },
        sources: [{ key: 'instagram', label: 'Instagram', n: 15, won: 5, patients: 5, revenue: 1200000 }],
        chat: { messages_in: 30, comments_in: 50, people: 60, answered: 40, requests: 55, missed: 2, median_ms: 1500000, leads: 3,
            waiting_now: { messages: 1, comments: 4 }, channels: [{ key: 'messenger', incoming: 10, leads: 1 }, { key: 'instagram', incoming: 20, leads: 2 }] },
        sms: { broadcasts: 1, sent: 100, failed: 0 },
    };
    o.callcenter = { operators: [{ name: '', ext: '103', incoming: 40, answered: 30, outgoing: 20, talk_min: 90, avg_wait_sec: 11 }],
        missed_hours: Array.from({ length: 24 }, (_, hour) => ({ hour, missed: hour === 9 ? 5 : 0, incoming: hour === 9 ? 12 : 0 })),
        leads_from_calls: 25, won_from_calls: 6 };
    o.outpatient = { departments: [{ name: 'Терапия', visits: 30, patients: 25, no_show: 2, cancelled: 1 }],
        weekdays: Array.from({ length: 7 }, (_, wd) => ({ wd, visits: wd })), services_per_visit: 1.8, revenue_per_visit: 250000, no_show: 2, cancelled: 1, no_show_rate: 6.3 };
    o.inpatient_ext = { in_bed_now: 5, beds_total: 20, beds_busy: 5, occupancy: 25, wards: [{ name: '201', beds: 4, busy: 3 }, { name: '202', beds: 2, busy: 0 }],
        emergency: 1, planned: 5, day_stay: 0, outcomes: { home: 4 }, bed_days: 30, revenue: 5000000, bed_revenue: 3000000,
        discharge_debt: 200000, discharge_debt_n: 1, departments: [] };
    o.procedures = { outpatient: 20, outpatient_done: 0, inpatient: 3, inpatient_done: 3, revenue: 800000, top: [{ name: 'Массаж', n: 12, sum: 600000 }] };
    o.stock = { low_count: 2, zero_count: 1, low: [{ name: 'Перчатки', unit: 'пар', on_hand: 0, reorder_level: 20 }], received_orders: 1, received_sum: 400000, open_orders: 2, used_sum: 150000 };
    o.referrers = { visits: 9, admissions: 1, new_sources_by_reps: 2, top: [{ name: 'Доктор Каримов', rep: 'Бобур', visits: 5, patients: 5, sum: 700000 }], reps: [{ name: 'Бобур', visits: 5, sources: 3 }] };
    overview = o;
    try {
        const { root } = await screen();
        await settle();
        const text = textOf(root);
        for (const title of ['Маркетинг и реклама', 'Колл-центр', 'Амбулатория', 'Стационар', 'Процедуры', 'Склад', 'Направители', 'Занято коек']) {
            assert.ok(text.includes(title), 'нет «' + title + '»');
        }
        for (const s of ['Осень', 'Внутренний 103', 'Терапия', 'Перчатки', 'Доктор Каримов', '25 мин']) assert.ok(text.includes(s), s);
        // Внимание: прежние три + переписка ждёт, 2 без ответа за сутки, 4 комментария, 1 ошибка Meta, 1 закончилось, 1 выписан с долгом.
        assert.strictEqual(byClass(root, 'dho-attn-i').length, 9, textOf(byClass(root, 'dho-attn')[0]));
    } finally { overview = null; }
});

// DASHBOARD_ONE_VIEW_V1 — владелец: «put today to date place and no need today
// page, just obzor kliniki should show todays date».
test('DASHBOARD_ONE_VIEW_V1: вкладок нет; «Сегодня» — первый период и по умолчанию; период перечитывает и запоминается', async () => {
    overview = overviewData();
    try {
        const { root } = await screen();
        assert.ok(!findBtn(root, 'Обзор клиники'), 'вкладка «Обзор клиники» осталась');
        const periods = walk(root).filter((e) => e.attrs && e.attrs['data-dash-days']);
        assert.deepStrictEqual(periods.map((e) => e.attrs['data-dash-days']), ['1', '7', '14', '30', '90']);
        assert.ok(textOf(periods[0]).includes('Сегодня'));
        assert.ok(String(periods[0].className).includes('on'), '«Сегодня» не выбран по умолчанию');
        rpcCalls.length = 0;
        findBtn(root, '30 дней').click();
        await settle();
        const calls = rpcCalls.filter((c) => c.name === 'dashboard_overview');
        assert.strictEqual(calls.length, 1);
        assert.strictEqual(calls[0].args.days, 30);
        assert.strictEqual(STORE['dash.days'], '30', 'период не запомнился');
        assert.ok(!rpcCalls.some((c) => c.name === 'dashboard_trend'), 'ряды вкладки «Сегодня» больше не читаются');
    } finally { overview = null; }
});
