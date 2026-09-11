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
let trendFail = false;
const rpcCalls = [];
globalThis.fetch = async (url, opts) => {
    const u = String(url);
    const body = opts && opts.body ? JSON.parse(opts.body) : {};
    if (u.startsWith('/api/rpc/')) {
        const name = decodeURIComponent(u.slice('/api/rpc/'.length));
        rpcCalls.push({ name, args: body });
        if (name === 'dashboard_summary') return { ok: true, json: async () => ({ data: summary }) };
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
test('плитки называют стационар: кто лежит, занятость коек, начислено', async () => {
    const { root } = await screen();
    const tiles = byClass(root, 'dash-kpi');
    assert.strictEqual(tiles.length, 8, 'плиток: ' + tiles.length);
    const tile = (label) => tiles.find((t) => textOf(t).includes(label));
    const inBed = tile('В стационаре');
    assert.ok(inBed, 'нет плитки «В стационаре»');
    assert.ok(textOf(inBed).includes('7'), 'число лежащих не с сервера: ' + textOf(inBed));
    assert.ok(textOf(inBed).includes('поступило 2') && textOf(inBed).includes('выписано 1'), textOf(inBed));
    const beds = tile('Занято коек');
    assert.ok(beds && textOf(beds).includes('58%') && textOf(beds).includes('7 из 12'), textOf(beds));
    const accrued = tile('Начислено стационару');
    assert.ok(accrued && textOf(accrued).includes('860 000'), textOf(accrued));
    // Прежние плитки никуда не делись.
    assert.ok(tile('Пациентов сегодня') && tile('Визитов сегодня') && tile('Принято сегодня') && tile('Долг') && tile('Анализы в работе'));
    // И ни одного английского слова — сводка говорит на языке продукта.
    assert.ok(!/Patients today|Visits today|Collected today|Outstanding/.test(textOf(root)), 'сводка снова по-английски');
});

test('плитка стационара ведёт в стационар, плитка коек — к койкам', async () => {
    const { root, nav } = await screen();
    byClass(root, 'dash-kpi').find((t) => textOf(t).includes('В стационаре')).click();
    byClass(root, 'dash-kpi').find((t) => textOf(t).includes('Занято коек')).click();
    assert.deepStrictEqual(nav, ['admissions', 'beds']);
});

// ─── 2. Деньги по дням — площадь из двух рядов ──────────────────────────────
test('деньги по дням — площадь из двух рядов с градиентом, легенда называет оба', async () => {
    const { root } = await screen();
    const card = byClass(root, 'card').find((c) => textOf(c).includes('Деньги по дням'));
    assert.ok(card, 'нет карточки «Деньги по дням»');
    const svg = svgs(card)[0];
    assert.ok(svg, 'в карточке нет графика');
    const grads = (svg._text.match(/<linearGradient/g) || []).length;
    assert.strictEqual(grads, 2, 'градиентов: ' + grads + ' — ожидалось по одному на ряд');
    assert.strictEqual((svg._text.match(/class="dc-line"/g) || []).length, 2, 'линий не две');
    assert.ok(/<clipPath/.test(svg._text), 'нет маски раскрытия');
    const legend = byClass(card, 'dash-legend')[0];
    assert.ok(legend && textOf(legend).includes('Амбулаторно') && textOf(legend).includes('Стационар'), textOf(legend));
    // Итог за период — в шапке карточки.
    assert.ok(textOf(card).includes('1 234 567'), 'итога за период нет: ' + textOf(card));
});

test('подсказка под курсором называет день, оба ряда и итог', async () => {
    const { root } = await screen();
    const card = byClass(root, 'card').find((c) => textOf(c).includes('Деньги по дням'));
    const chart = byClass(card, 'dash-chart')[0];
    chart.getBoundingClientRect = () => ({ left: 0, width: 640 });
    chart.dispatch('mousemove', { clientX: 700 });   // за правым краем — прижимается к последнему дню
    const tip = byClass(chart, 'dash-chart-tip')[0];
    assert.ok(tip && !tip.hidden, 'подсказка не показалась');
    const t = textOf(tip);
    assert.ok(t.includes(shortDay(day(0))), 'подсказка не называет день: ' + t);
    assert.ok(t.includes('Амбулаторно') && t.includes('Стационар') && t.includes('Всего'), t);
    assert.ok(/<circle class="dc-dot"/.test(svgs(chart)[0]._text), 'точки на кривых не подсвечены');
    chart.dispatch('mouseleave', {});
    assert.ok(tip.hidden, 'подсказка не спряталась');
});

// ─── 3. Период один на всё ──────────────────────────────────────────────────
test('период по умолчанию — 14 дней; «30 дней» перечитывает ряды и запоминается', async () => {
    const { root } = await screen();
    const trend = rpcCalls.filter((c) => c.name === 'dashboard_trend');
    assert.strictEqual(trend.length, 1);
    assert.strictEqual(trend[0].args.days, 14);
    findBtn(root, '30 дней').click();
    await settle();
    const after = rpcCalls.filter((c) => c.name === 'dashboard_trend');
    assert.strictEqual(after[after.length - 1].args.days, 30, 'ряды не перечитаны на 30 дней');
    assert.strictEqual(STORE['dash.days'], '30', 'период не запомнился');
    const on = byClass(root, 'segmented')[0].children.find((b) => b.className === 'on');
    assert.ok(on && textOf(on).includes('30'), 'подсвечен не тот период');
});

// ─── 4. Отделения под кольцом ───────────────────────────────────────────────
test('карточка коек: кольцо занятости и строка на отделение', async () => {
    const { root } = await screen();
    const card = byClass(root, 'card').find((c) => textOf(c).includes('Койки'));
    assert.ok(card, 'нет карточки «Койки»');
    assert.ok(byClass(card, 'dash-ring').length === 1, 'кольца нет');
    assert.ok(textOf(card).includes('58%'), textOf(card));
    const wards = byClass(card, 'dash-ward');
    assert.strictEqual(wards.length, 2);
    assert.ok(textOf(wards[0]).includes('Терапия') && textOf(wards[0]).includes('5 / 8'), textOf(wards[0]));
    assert.ok(textOf(wards[1]).includes('Хирургия') && textOf(wards[1]).includes('2 / 4'), textOf(wards[1]));
});

test('визиты и госпитализации — столбики, по группе на день', async () => {
    const { root } = await screen();
    const card = byClass(root, 'card').find((c) => textOf(c).includes('Визиты и госпитализации'));
    assert.ok(card, 'нет карточки движения людей');
    const svg = svgs(card)[0];
    const bars = (svg._text.match(/<rect class="dc-bar/g) || []).length;
    assert.strictEqual(bars, 14 * 2, 'столбиков: ' + bars);
});

// ─── 5. Тревога о складе ────────────────────────────────────────────────────
test('низкий остаток — полоса, и только когда он есть', async () => {
    let { root } = await screen();
    assert.strictEqual(byClass(root, 'dash-alert').length, 0, 'полоса тревоги при нулевом остатке');
    summary = { ...SUMMARY, low_stock_count: 3 };
    try {
        ({ root } = await screen());
        const alert = byClass(root, 'dash-alert')[0];
        assert.ok(alert && textOf(alert).includes('3'), 'полосы тревоги нет');
        assert.ok(findBtn(alert, 'Открыть склад'), 'нет пути на склад');
    } finally { summary = SUMMARY; }
});

// ─── 6. Кегль графика ───────────────────────────────────────────────────────
test('единственный кегль графиков — 12.5 px', async () => {
    const { root } = await screen();
    const all = svgs(root);
    assert.ok(all.length >= 2, 'графиков меньше двух');
    for (const s of all) {
        for (const m of s._text.matchAll(/font-size="([\d.]+)"/g)) {
            assert.strictEqual(m[1], '12.5', 'кегль ' + m[1] + ' на графике — не ступень шкалы');
        }
    }
});

// ─── 7. Графики отказали — плитки на месте ──────────────────────────────────
test('ряды не загрузились — плитки сводки всё равно на экране', async () => {
    trendFail = true;
    try {
        const { root } = await screen();
        assert.strictEqual(byClass(root, 'dash-kpi').length, 8);
        assert.ok(textOf(root).includes('Пациентов сегодня'));
        assert.ok(textOf(root).includes('Нет данных'), 'пустой график не говорит словами');
    } finally { trendFail = false; }
});

// ─── чистая математика графика ──────────────────────────────────────────────
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
