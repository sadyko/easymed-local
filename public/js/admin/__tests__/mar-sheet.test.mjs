// MAR_SHEET_V1 — лист назначений: экран врача.
//
// Что здесь проверяется и почему именно это:
//   1. ОТМЕТКА ИДЁТ ЗА ДАТОЙ, А НЕ ЗА ЧАСОМ. Это главная ошибка референса: там
//      ключ отметки схлопнут по часу, и вчерашняя галочка в 10:00 стоит и
//      сегодня. Тест разворачивает курс на два дня и требует, чтобы отметка
//      осталась в своём дне.
//   2. ВВЕДЁННАЯ ДОЗА НАЗЫВАЕТ ВРЕМЯ И ЧЕЛОВЕКА. «✓» без времени и без имени —
//      это не запись, а украшение: через полгода по такому листу не ответить,
//      кто ввёл.
//   3. ОТКАЗ ВЫГЛЯДИТ ИНАЧЕ, ЧЕМ ВВЕДЕНИЕ. Отказ, пропуск и «придержано» — не
//      пустая клетка и не галочка: у них свой знак, своя подпись и своя
//      причина в подсказке.
//   4. ОТМЕНЁННОЕ НАЗНАЧЕНИЕ НЕ ИСЧЕЗАЕТ. По умолчанию его не видно, за
//      переключателем «Показать отменённые · N» оно зачёркнуто и названо
//      причиной, автором и временем.
//   5. ЛИСТ ПЕЧАТАЕТСЯ КАК ДОКУМЕНТ: дата, сетка и ДВЕ подписи внизу.
//   6. СПРАВОЧНИКИ НЕ РАЗЪЕХАЛИСЬ С СЕРВЕРОМ. Пути введения, частоты и допуски
//      опоздания повторены в браузере сознательно (серверный модуль не
//      отдаётся в браузер) — и сверяются с оригиналом здесь.
//   7. РАЗДЕЛ ОТКРЫВАЕТСЯ ТЕМ, КОМУ ОН НУЖЕН, и не открывается кассе.

import { test } from 'node:test';
import assert from 'node:assert';

// ─── минимальный DOM (тот же стенд, что у admissions-window.test.mjs) ───────
class FakeNode {
    constructor(tag) {
        this.tagName = String(tag).toUpperCase();
        this.style = {}; this.children = []; this.attrs = {};
        this.className = ''; this._text = ''; this._l = {}; this.dataset = {};
        this.value = '';
    }
    appendChild(c) { this.children.push(c); return c; }
    removeChild(c) { const i = this.children.indexOf(c); if (i > -1) this.children.splice(i, 1); return c; }
    get firstChild() { return this.children.length ? this.children[0] : null; }
    replaceChildren() { this.children.length = 0; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); }
    addEventListener(t, fn) { (this._l[t] || (this._l[t] = [])).push(fn); }
    removeEventListener() {}
    dispatchEvent(e) { for (const fn of this._l[e.type] || []) fn(e); return true; }
    click() { this.dispatchEvent({ type: 'click', currentTarget: this, preventDefault() {}, stopPropagation() {} }); }
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
// I18N_LOCALE_PIN_V1 — экран рисуется по-русски независимо от локали машины.
globalThis.localStorage = { getItem: (k) => (k === 'admin.lang' ? 'ru' : null), setItem() {}, removeItem() {}, clear() {} };
globalThis.window = { location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, addEventListener() {}, open: () => null };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();

const walk = (e, out = []) => { if (!e || typeof e !== 'object') return out; out.push(e); for (const c of e.children || []) walk(c, out); return out; };
const textOf = (e) => walk(e).map((x) => x._text || '').join(' ');
const findBtn = (root, label) => walk(root).find((e) => e.tagName === 'BUTTON' && textOf(e).includes(label));
const lastToast = () => {
    const t = BODY.children.filter((c) => c.attrs && c.attrs.id === 'toast').pop();
    return t ? t.textContent : '';
};
const settle = () => new Promise((r) => setTimeout(r, 30));

const sheet = await import('../views/mar-sheet.js');
const perms = await import('../permissions.js');
const schedule = await import('../../../../server/services/domain/mar-schedule.js');

const {
    ROUTES, FREQ_OPTIONS, KIND_OPTIONS, MAR_GRACE_MIN, MAR_MISSED_MIN,
    todayLocal, shiftDate, dueMsOf, marDueState, cellFor, markAt, isPlanned,
    gridHours, splitOrders, groupByKind, hhmm, orderSubtitle, cellGlyph,
    cellStateLabel, cellTitle, marSheetPrintHtml, renderMarSheet, canOpenMarSheet,
} = sheet;

// ─── данные «сервера» ───────────────────────────────────────────────────────

const TODAY = todayLocal();
const TOMORROW = shiftDate(TODAY, 1);
const isoLocal = (h, m) => { const d = new Date(); d.setHours(h, m, 0, 0); return d.toISOString(); };
const GIVEN_AT = isoLocal(10, 5);
const REFUSED_AT = isoLocal(10, 40);
const PRN_AT = isoLocal(13, 20);

const due = (date, slot) => ({ date, slot, due_at: `${date} ${String(slot).padStart(2, '0')}:00`, due_ms: dueMsOf(date, slot) });

// Курс на два дня: 2 раза в день. Отметка стоит ТОЛЬКО в сегодняшних десяти.
const CEF = {
    id: 1, admission_id: 13, kind: 'med', name: 'Цефтриаксон', dose: '1 г', route: 'в/в',
    freq_code: '2x', prn: 0, status: 'active', source: 'clinic',
    starts_on: TODAY, days: 5, ends_on: null, slot_hours: [10, 22],
    due: [due(TODAY, 10), due(TODAY, 22), due(TOMORROW, 10), due(TOMORROW, 22)],
    marks: [{ id: 501, order_id: 1, due_date: TODAY, due_slot: 10, status: 'given', given_at: GIVEN_AT, given_by: 7, reason: '', voided_at: null }],
    voided_marks: [], prn_marks: [],
};
const DRESSING = {
    id: 2, admission_id: 13, kind: 'proc', name: 'Перевязка', dose: '', route: null,
    freq_code: '1x', prn: 0, status: 'active', source: 'clinic',
    starts_on: TODAY, days: 3, ends_on: null, slot_hours: [10],
    due: [due(TODAY, 10)],
    marks: [{ id: 502, order_id: 2, due_date: TODAY, due_slot: 10, status: 'refused', given_at: REFUSED_AT, given_by: 7, reason: 'пациент отказался', voided_at: null }],
    voided_marks: [], prn_marks: [],
};
const KETOROL = {
    id: 3, admission_id: 13, kind: 'med', name: 'Кеторол', dose: '1 мл', route: 'в/м',
    freq_code: 'prn', prn: 1, status: 'active', source: 'clinic',
    starts_on: TODAY, days: null, ends_on: null, slot_hours: [],
    due: [], marks: [], voided_marks: [],
    prn_marks: [{ id: 503, order_id: 3, due_date: TODAY, due_slot: null, status: 'given', given_at: PRN_AT, given_by: 8, reason: '', voided_at: null }],
};
const CANCELLED = {
    id: 4, admission_id: 13, kind: 'med', name: 'Анальгин', dose: '500 мг', route: 'внутрь',
    freq_code: '1x', prn: 0, status: 'cancelled', source: 'clinic',
    starts_on: TODAY, days: 5, ends_on: null, slot_hours: [10],
    cancel_reason: 'аллергическая реакция', cancel_by: 9, cancel_at: TODAY + 'T06:00:00Z',
    due: [], marks: [], voided_marks: [], prn_marks: [],
};

const ADMISSION = {
    id: 13, admission_no: 'ADM-00013', status: 'active', patient_id: 103,
    ward_id: 1, bed_id: 5,
    patients: { mrn: 'M-103', full_name: 'Сидоров Сидор' },
    wards: { name: 'Терапия' }, beds: { code: 'T-1' },
    attending: { full_name: 'Юсупов Азиз' },
};

const USERS = [
    { id: 7, full_name: 'Иванова Мария' },
    { id: 8, full_name: 'Каримова Дилноза' },
    { id: 9, full_name: 'Юсупов Азиз' },
];

let orders = [CEF, DRESSING, KETOROL, CANCELLED];
// MED_ADMIN_CHARGE_V1 (Задача 6) — отметка «дала», за которой не пошёл склад.
let stockIssues = { count: 0, items: [] };
let rpcCalls = [];
let createAnswer = () => ({ ok: true, data: { order: { id: 99 } } });

globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    let body = {}; try { body = JSON.parse(opts.body || '{}'); } catch { /* not ours */ }
    const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }), headers: { getSetCookie: () => [] } });
    const fail = (message) => ({ ok: false, status: 400, json: async () => ({ error: { message } }), headers: { getSetCookie: () => [] } });

    if (u.startsWith('/api/rpc/')) {
        const name = decodeURIComponent(u.slice('/api/rpc/'.length));
        rpcCalls.push({ name, args: body });
        if (name === 'treatment_orders_list') {
            return ok({
                admission_id: body.admission_id, from: body.from, to: body.to,
                include_cancelled: !!body.include_cancelled, orders, stock_issues: stockIssues,
            });
        }
        if (name === 'treatment_order_create') {
            const a = createAnswer();
            return a.ok ? ok(a.data) : fail(a.message);
        }
        if (name === 'treatment_order_cancel') return ok({ order: { id: body.order_id, status: 'cancelled' }, already: false });
        return ok({});
    }
    if (u === '/api/db') {
        if (body.table === 'admissions') return ok(body.single ? ADMISSION : [ADMISSION]);
        if (body.table === 'users') return ok(USERS);
        if (body.table === 'wards') return ok([{ id: 1, name: 'Терапия' }]);
        return ok([]);
    }
    return ok([]);
};

async function renderScreen(payload = { sub: '13' }) {
    BODY.children.length = 0;
    rpcCalls = [];
    const container = mkEl('div');
    await renderMarSheet(container, { payload, onNavigate: () => {} });
    await settle();
    return container;
}

// ─── 1. Справочники не разъехались с сервером ───────────────────────────────

test('пути введения, частоты и допуски опоздания совпадают с server/domain/mar-schedule.js', () => {
    assert.deepEqual(ROUTES, [...schedule.ROUTES],
        'десять путей введения живут в CHECK миграции 093; расхождение = отказ сервера на сохранении');
    assert.deepEqual(FREQ_OPTIONS.map(([code]) => code), [...schedule.FREQ_CODES],
        'коды частот должны быть теми же, иначе форма пошлёт неизвестную частоту');
    for (const [code, label] of FREQ_OPTIONS) {
        assert.equal(label, schedule.FREQUENCIES[code].label, 'подпись частоты ' + code);
    }
    assert.equal(MAR_GRACE_MIN, schedule.GRACE_MIN, '15 минут допуска — одно число на сервер и экран');
    assert.equal(MAR_MISSED_MIN, schedule.MISSED_MIN, 'час до «просрочено» — тоже одно');
    assert.deepEqual(KIND_OPTIONS.map(([k]) => k), ['med', 'infusion', 'proc', 'care']);
});

// ─── 2. Отметка идёт за ДАТОЙ ───────────────────────────────────────────────

test('курс развёрнут на два дня, и отметка остаётся в своём дне', () => {
    assert.ok(isPlanned(CEF, TODAY, 10) && isPlanned(CEF, TOMORROW, 10), 'курс идёт оба дня');
    assert.equal(isPlanned(CEF, TODAY, 11), false, 'час не из расписания клеткой не становится');

    const now = dueMsOf(TODAY, 12);
    assert.equal(cellFor(CEF, TODAY, 10, now).state, 'given', 'сегодняшняя доза отмечена');
    assert.equal(cellFor(CEF, TOMORROW, 10, now).state, 'pending',
        'ЗАВТРАШНЯЯ доза той же схемы НЕ отмечена — ключ отметки это (назначение, дата, слот)');
    assert.equal(markAt(CEF, TOMORROW, 10), null);
    assert.equal(markAt(CEF, TODAY, 10).id, 501);

    // Часы дня — объединение плановых точек, и завтрашние в сегодняшнюю сетку
    // не попадают.
    assert.deepEqual(gridHours([CEF, DRESSING], TODAY), [10, 22]);
});

test('три степени опоздания считаются от слота, а не от часа открытия листа', () => {
    const dueMs = dueMsOf(TODAY, 10);
    assert.equal(marDueState(dueMs, dueMs + 5 * 60000), 'pending', 'пять минут — ещё ожидает');
    assert.equal(marDueState(dueMs, dueMs + 30 * 60000), 'delayed', 'полчаса — задержано');
    assert.equal(marDueState(dueMs, dueMs + 90 * 60000), 'overdue', 'полтора часа — просрочено');
    // Пропуск, ЗАПИСАННЫЙ медсестрой, и просрочка — разные вещи и разные знаки.
    assert.notEqual(cellGlyph('missed'), cellGlyph('overdue'));
    assert.notEqual(cellStateLabel('missed'), cellStateLabel('overdue'));
});

// ─── 3. Введено ≠ отказ ─────────────────────────────────────────────────────

test('введённая доза называет время и человека, отказ — причину, и знаки у них разные', () => {
    const now = dueMsOf(TODAY, 23);
    const given = cellFor(CEF, TODAY, 10, now);
    const refused = cellFor(DRESSING, TODAY, 10, now);

    assert.equal(given.state, 'given');
    assert.equal(refused.state, 'refused');
    assert.notEqual(cellGlyph('given'), cellGlyph('refused'), 'галочка и отказ не могут выглядеть одинаково');

    const people = new Map(USERS.map((u) => [u.id, u.full_name]));
    const gt = cellTitle(given, people);
    assert.ok(gt.includes('10:05'), 'в подсказке фактическое время введения: ' + gt);
    assert.ok(gt.includes('Иванова Мария'), 'и кто ввёл: ' + gt);

    const rt = cellTitle(refused, people);
    assert.ok(rt.includes('Отказ пациента'), rt);
    assert.ok(rt.includes('пациент отказался'), 'причина отказа видна: ' + rt);

    assert.equal(hhmm(GIVEN_AT), '10:05', 'время показывается по местным часам отделения');
});

test('назначения раскладываются по родам, «по требованию» и отменённые — отдельно', () => {
    const { scheduled, prn, cancelled } = splitOrders(orders);
    assert.deepEqual(scheduled.map((o) => o.id), [1, 2]);
    assert.deepEqual(prn.map((o) => o.id), [3]);
    assert.deepEqual(cancelled.map((o) => o.id), [4]);
    assert.deepEqual(groupByKind(scheduled).map((g) => g.kind), ['med', 'proc'], 'порядок групп — порядок чтения врача');
    assert.ok(orderSubtitle(CEF).includes('1 г') && orderSubtitle(CEF).includes('в/в') && orderSubtitle(CEF).includes('2 р/д'));
});

// ─── 4. Экран ───────────────────────────────────────────────────────────────

test('экран спрашивает лист у сервера на сегодня и рисует сетку с введённой дозой', async () => {
    const root = await renderScreen();
    const calls = rpcCalls.filter((c) => c.name === 'treatment_orders_list');
    assert.equal(calls.length, 1, 'один запрос листа на открытие');
    assert.equal(calls[0].args.admission_id, 13);
    assert.equal(calls[0].args.from, TODAY);
    assert.equal(calls[0].args.to, TODAY);
    assert.equal(calls[0].args.include_cancelled, true,
        'отменённые приезжают всегда — иначе переключатель не знал бы своего числа');

    const txt = textOf(root);
    assert.ok(txt.includes('Сидоров Сидор'), 'пациент — якорь и на листе врача');
    assert.ok(txt.includes('Цефтриаксон') && txt.includes('Перевязка'));
    assert.ok(txt.includes('Лекарство') && txt.includes('Процедура'), 'сетка сгруппирована по роду назначения');
    assert.ok(txt.includes('10:05'), 'клетка введённой дозы показывает фактическое время');
    assert.ok(txt.includes('ИМ'), 'и инициалы того, кто ввёл (Иванова Мария)');

    // Подсказка клетки называет человека полным именем.
    const cells = walk(root).filter((e) => e.tagName === 'TD' && (e.attrs.title || '').includes('10:05'));
    assert.ok(cells.length, 'клетка с временем введения не найдена');
    assert.ok(cells[0].attrs.title.includes('Иванова Мария'), cells[0].attrs.title);
});

test('отменённое назначение спрятано за переключателем, а показанное — зачёркнуто с причиной', async () => {
    const root = await renderScreen();
    assert.ok(!textOf(root).includes('Анальгин'), 'по умолчанию отменённых на листе не видно');

    const toggle = findBtn(root, 'Показать отменённые');
    assert.ok(toggle, 'переключателя отменённых нет');
    assert.ok(textOf(toggle).includes('1'), 'переключатель называет их число: ' + textOf(toggle));

    toggle.click();
    await settle();
    const txt = textOf(root);
    assert.ok(txt.includes('Анальгин'), 'после нажатия отменённое назначение видно');
    assert.ok(txt.includes('аллергическая реакция'), 'вместе с причиной отмены');
    assert.ok(txt.includes('Юсупов Азиз'), 'и автором отмены');

    const struck = walk(root).find((e) => e.style && e.style.textDecoration === 'line-through' && textOf(e).includes('Анальгин'));
    assert.ok(struck, 'отменённое назначение обязано быть зачёркнуто, а не просто помечено');
});

test('«по требованию» стоит отдельным блоком со своей историей событий', async () => {
    const root = await renderScreen();
    const card = walk(root).find((e) => e.className === 'card' && textOf(e).includes('По требованию'));
    assert.ok(card, 'блока «По требованию» нет');
    assert.ok(textOf(card).includes('Кеторол'));
    assert.ok(textOf(card).includes('13:20'), 'событие PRN названо временем: ' + textOf(card));
    // И в сетке по часам его нет: часов у него не существует.
    const grid = walk(root).find((e) => e.className === 'card' && textOf(e).includes('Назначения по часам'));
    assert.ok(!textOf(grid).includes('Кеторол'));
});

test('несписанная со склада доза видна на листе, а не только при инвентаризации', async () => {
    stockIssues = {
        count: 1,
        items: [{ id: 501, order_id: 1, due_date: TODAY, due_slot: 10, stock_status: 'short',
                  stock_note: 'не списано: на складе нет остатка', name: 'Цефтриаксон', dose: '1 г', stock_item_id: 55 }],
    };
    const root = await renderScreen();
    stockIssues = { count: 0, items: [] };
    const txt = textOf(root);
    assert.ok(txt.includes('Не списано со склада: 1'),
        'молча это нашлось бы через месяц, когда уже не вспомнить, что вводили');
    assert.ok(txt.includes('нет остатка'), 'и с объяснением, что именно случилось');
});

test('без несписанного предупреждения на листе нет', async () => {
    const root = await renderScreen();
    assert.ok(!textOf(root).includes('Не списано со склада'));
});

test('день листается, и лист перезапрашивается на выбранную дату', async () => {
    const root = await renderScreen();
    rpcCalls = [];
    const bar = walk(root).find((e) => e.className === 'card' && textOf(e).includes('Сегодня'));
    const back = walk(bar).filter((e) => e.tagName === 'BUTTON')[0];
    back.click();
    await settle();
    const call = rpcCalls.filter((c) => c.name === 'treatment_orders_list').pop();
    assert.equal(call.args.from, shiftDate(TODAY, -1), 'стрелка назад листает на день назад');
    assert.equal(call.args.to, shiftDate(TODAY, -1));
});

test('подпись листа на экране — та же, что печатается внизу бумаги', async () => {
    const root = await renderScreen();
    const txt = textOf(root);
    assert.ok(txt.includes('Лист назначений на ' + TODAY), txt.slice(0, 200));
    assert.ok(txt.includes('Лечащий врач') && txt.includes('Ст. медсестра'),
        'лист заверяют двое — обе строки обязаны быть на экране, как и на бумаге');
});

// ─── 5. Печать ──────────────────────────────────────────────────────────────

test('печатный лист — документ: дата, часы, назначения и две подписи', () => {
    const html = marSheetPrintHtml({
        date: TODAY, orders, people: new Map(USERS.map((u) => [u.id, u.full_name])),
        now_ms: dueMsOf(TODAY, 23), patient_name: 'Сидоров Сидор', ward_name: 'Терапия', bed_code: 'T-1',
    });
    assert.ok(html.includes('Лист назначений на ' + TODAY), 'заголовок с датой');
    assert.ok(html.includes('Сидоров Сидор'), 'чей это лист');
    assert.ok(html.includes('Цефтриаксон') && html.includes('Перевязка'));
    assert.ok(html.includes('10:05'), 'время введения печатается');
    assert.ok(html.includes('Кеторол'), 'блок «по требованию» на бумаге тоже есть');
    assert.ok(html.includes('Анальгин') && html.includes('аллергическая реакция'),
        'отменённое назначение печатается вместе с причиной — лист это история болезни');
    assert.ok(html.includes('Лечащий врач') && html.includes('Ст. медсестра'), 'две подписи внизу');
    assert.match(html, /window\.print\(\)/, 'лист печатает сам себя');
    assert.ok(!/<link[^>]+href=/i.test(html), 'ни одной внешней ссылки: печатают офлайн');
});

test('печатный лист безопасен к разметке в названии назначения', () => {
    const html = marSheetPrintHtml({
        date: TODAY,
        orders: [{ ...CEF, name: 'Ким <script>alert("x")</script>', marks: [], due: [due(TODAY, 10)] }],
        people: new Map(), now_ms: dueMsOf(TODAY, 9),
    });
    assert.ok(!html.includes('<script>alert'), 'название экранировано');
    assert.ok(html.includes('&lt;script&gt;'));
});

// ─── 6. Форма назначения и отмена ───────────────────────────────────────────

test('назначение без названия на сервер не уходит, а «до отмены» шлёт days = null', async () => {
    const root = await renderScreen();
    findBtn(root, 'Назначение').click();
    await settle();
    const overlay = BODY.children[BODY.children.length - 1];
    assert.ok(textOf(overlay).includes('Новое назначение'), 'форма назначения не открылась');
    for (const label of ['Род назначения', 'Название', 'Доза', 'Путь введения', 'Частота', 'Начало курса', 'Чей препарат']) {
        assert.ok(textOf(overlay).includes(label), 'в форме нет поля «' + label + '»');
    }

    rpcCalls = [];
    findBtn(overlay, 'Назначить').click();
    await settle();
    assert.match(lastToast(), /название/i);
    assert.equal(rpcCalls.filter((c) => c.name === 'treatment_order_create').length, 0,
        'без названия запрос отправлять нечего');

    const inputs = walk(overlay).filter((e) => e.tagName === 'INPUT');
    const selects = walk(overlay).filter((e) => e.tagName === 'SELECT');
    inputs.find((e) => (e.attrs.placeholder || '').includes('Название')).value = 'Цефтриаксон';
    // На этом стенде <select> не имеет выбранного по умолчанию значения (его
    // выбирает настоящий браузер), поэтому род и частота задаются явно.
    selects[0].value = 'med';           // род назначения
    selects[2].value = '2x';            // частота
    // Путь введения обязателен для лекарства — сервер откажет, и окно тоже.
    findBtn(overlay, 'Назначить').click();
    await settle();
    assert.match(lastToast(), /путь введения/i);
    assert.equal(rpcCalls.filter((c) => c.name === 'treatment_order_create').length, 0);

    selects[1].value = 'в/в';           // путь введения
    const openEnded = inputs.find((e) => e.attrs.type === 'checkbox');
    openEnded.checked = true;
    findBtn(overlay, 'Назначить').click();
    await settle();
    const call = rpcCalls.find((c) => c.name === 'treatment_order_create');
    assert.ok(call, 'назначение не ушло на сервер');
    assert.equal(call.args.admission_id, 13);
    assert.equal(call.args.name, 'Цефтриаксон');
    assert.equal(call.args.route, 'в/в');
    assert.equal(call.args.kind, 'med');
    assert.equal(call.args.freq_code, '2x');
    assert.equal(call.args.days, null, '«до отмены» — это отсутствие срока, а не число дней');
    assert.equal(call.args.starts_on, TODAY);
});

test('отмена назначения без причины не уходит на сервер', async () => {
    const root = await renderScreen();
    const grid = walk(root).find((e) => e.className === 'card' && textOf(e).includes('Назначения по часам'));
    const rows = walk(grid).filter((e) => e.tagName === 'TR' && textOf(e).includes('Цефтриаксон'));
    findBtn(rows[0], 'Отменить').click();
    await settle();

    const overlay = BODY.children[BODY.children.length - 1];
    assert.ok(textOf(overlay).includes('Причина отмены'), 'окно отмены обязано спрашивать причину');
    assert.ok(textOf(overlay).includes('Назначение не удаляется'), 'и обещать, что строка не исчезнет');

    rpcCalls = [];
    findBtn(overlay, 'Отменить назначение').click();
    await settle();
    assert.match(lastToast(), /причину/i);
    assert.equal(rpcCalls.filter((c) => c.name === 'treatment_order_cancel').length, 0);

    walk(overlay).filter((e) => e.tagName === 'INPUT')[0].value = 'аллергическая реакция';
    findBtn(overlay, 'Отменить назначение').click();
    await settle();
    const call = rpcCalls.find((c) => c.name === 'treatment_order_cancel');
    assert.ok(call, 'отмена не ушла на сервер');
    assert.equal(call.args.order_id, 1);
    assert.equal(call.args.reason, 'аллергическая реакция');
});

// ─── 7. Права ───────────────────────────────────────────────────────────────

test('лист назначений открывают отделение и лечащий врач, но не касса', () => {
    const nurse = { name: 'Медсестра', permissions: { sections: ['patients', 'labs', 'procedures', 'beds'], levels: { beds: 'editor' } } };
    const doctor = { name: 'Врач', permissions: { sections: ['patients', 'consultation', 'labs'], levels: { consultation: 'editor' } } };
    const cashier = { name: 'Кассир', permissions: { sections: ['cashier', 'patients', 'queue'], levels: { cashier: 'admin' } } };

    perms.setEffectiveFromRole(nurse);
    assert.strictEqual(canOpenMarSheet(), true, 'медсестра читает лист: она по нему и работает');
    assert.strictEqual(perms.isRouteAllowed('mar-sheet'), true);

    perms.setEffectiveFromRole(doctor);
    assert.strictEqual(canOpenMarSheet(), true,
        'ЛЕЧАЩИЙ ВРАЧ обязан открыть лист: раздела коек ему не выдают, а назначает именно он');
    assert.strictEqual(perms.isRouteAllowed('mar-sheet'), true);

    perms.setEffectiveFromRole(cashier);
    assert.strictEqual(canOpenMarSheet(), false, 'лист назначений — история болезни, а не счёт');
    assert.strictEqual(perms.isRouteAllowed('mar-sheet'), false);

    perms.setFullAccess('Admin');
    assert.strictEqual(canOpenMarSheet(), true);
});
