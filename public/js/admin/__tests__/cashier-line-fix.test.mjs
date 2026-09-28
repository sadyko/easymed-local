// CASHIER_HEAD_V1 (2026-09-28) — касса: «Исправить услуги» по праву
// «Исправляет услуги в счёте» и «Старший кассир» с отчётом и закрытием
// чужой смены.
//
// Владелец: «It should be switchable in the roles so cashier either only
// accepts [payments] or accepts and makes small fixes.» Выключено — кассир
// видит ровно то, что видел (только оплата); включено — у счёта кнопка
// «Исправить услуги», в окне у неначатой строки «Заменить услугу», «Сменить
// врача», «Убрать» и внизу «+ Добавить услугу». Деньги считает сервер —
// экран только зовёт двери cashier_line_* и показывает ответ.
//
// Заглушка документа — та же, что у cashier-v3120.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert';

class FakeNode {
    constructor(tag) {
        this.tagName = String(tag).toUpperCase();
        this.style = {}; this.children = []; this.attrs = {};
        this.className = ''; this._text = ''; this._l = {}; this.dataset = {}; this.value = '';
    }
    appendChild(c) { this.children.push(c); return c; }
    removeChild(c) { const i = this.children.indexOf(c); if (i > -1) this.children.splice(i, 1); return c; }
    get firstChild() { return this.children.length ? this.children[0] : null; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); }
    addEventListener(t, fn) { (this._l[t] || (this._l[t] = [])).push(fn); }
    removeEventListener() {}
    fire(t) { for (const fn of this._l[t] || []) fn.call(this, { currentTarget: this, target: this, preventDefault() {}, stopPropagation() {} }); }
    click() { this.fire('click'); }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    setSelectionRange() {}
    remove() {}
    get textContent() { return this._text; }
    set textContent(v) { this._text = String(v); this.children.length = 0; }
    get classList() {
        const s = this;
        return { contains: (c) => String(s.className).split(/\s+/).includes(c), add() {}, remove() {}, toggle() {} };
    }
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

const calls = [];
let rpcAnswers = {};
let tables = {};
const printed = [];
let promptAnswer = null;
let promptSeen = null;
globalThis.Node = FakeNode;
globalThis.document = {
    createElement: mkEl, createElementNS: (_n, t) => mkEl(t), createTextNode: (t) => new FakeText(t),
    head: mkEl('head'), body: mkEl('body'), documentElement: mkEl('html'),
    addEventListener() {}, removeEventListener() {}, getElementById() { return null; }, querySelectorAll() { return []; },
};
const openWin = () => {
    const w = { _html: '', document: { open() {}, write(h) { w._html += h; }, close() { printed.push(w._html); } }, focus() {}, print() {}, close() {} };
    return w;
};
globalThis.window = { location: { hostname: 'localhost' }, localStorage: { getItem: () => null, setItem() {} }, open: openWin, easymed: { state: { user: { id: 1, full_name: 'Кассирова Д.' } } } };
const store = new Map([['admin.lang', 'ru']]);
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem(k, v) { store.set(k, String(v)); }, removeItem(k) { store.delete(k); }, clear() {} };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.confirm = () => true;
globalThis.prompt = (msg, def) => { promptSeen = { msg, def }; return promptAnswer; };
const matches = (r, f) => {
    const v = r[f.col];
    if (f.op === 'eq') return String(v) === String(f.val);
    if (f.op === 'in') return (Array.isArray(f.val) ? f.val : []).map(String).includes(String(v));
    if (f.op === 'is') return v == null;
    return true;
};
globalThis.fetch = async (url, opts = {}) => {
    let body = {};
    try { body = JSON.parse(opts.body || '{}'); } catch { /* не json */ }
    const u = String(url);
    const rpc = u.split('/api/rpc/')[1];
    let data;
    if (rpc) {
        calls.push([decodeURIComponent(rpc), body]);
        const a = rpcAnswers[decodeURIComponent(rpc)];
        data = typeof a === 'function' ? a(body) : (a !== undefined ? a : []);
    } else {
        calls.push(['db:' + body.table, body]);
        const rows = (tables[body.table] || []).filter((r) => (body.filters || []).every((f) => matches(r, f)));
        data = body.single ? (rows[0] || null) : rows;
    }
    return { ok: true, status: 200, json: async () => ({ data }), headers: { getSetCookie: () => [] } };
};

const desk = await import('../views/cashier-desk.js');
const fix = await import('../views/cashier-line-fix.js');
const perms = await import('../permissions.js');

const walk = (e, out = []) => { if (!e || typeof e !== 'object') return out; out.push(e); for (const c of e.children || []) walk(c, out); return out; };
const textOf = (e) => walk(e).map((x) => x._text || '').join(' ');
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const modals = () => document.body.children.filter((c) => c.className === 'modal');
const lastModal = () => modals()[modals().length - 1];
const buttons = (root) => walk(root).filter((e) => e.tagName === 'BUTTON');
const buttonByText = (root, t) => buttons(root).find((b) => textOf(b).trim() === t);
const fixButton = (row) => buttons(row).find((b) => b.getAttribute('title') === 'Исправить услуги');
const closeAll = () => { document.body.children = document.body.children.filter((c) => c.className !== 'modal'); };

// Кассир: касса выдана, «Исправляет услуги в счёте» — как настроено в тесте.
function asCashier(grants = null) {
    const permissions = { sections: ['cashier', 'patients'], levels: { cashier: 'admin', patients: 'editor' } };
    if (grants) permissions.grants = grants;
    perms.setEffectiveFromRole({ name: 'cashier', permissions });
    window.easymed.state.user = { id: 9, full_name: 'Кассир', role: 'cashier' };
}

const INV = {
    id: 5, invoice_number: 'INV-A-26-00005', visit_id: 40, patient_id: 3, patient_name: 'Рахимов Жасур', mrn: '0024815',
    status: 'unpaid', subtotal: 230000, discount_amount: 0, total_amount: 230000, paid_amount: 0, first_item: 'Приём терапевта', items_count: 2,
    created_at: '2026-09-28T05:00:00Z',
};
const ITEMS = [
    { id: 71, invoice_id: 5, description: 'Приём терапевта', total: 150000, discount_amount: 0 },
    { id: 72, invoice_id: 5, description: 'УЗИ', total: 80000, discount_amount: 0 },
];
const LINES = [
    { id: 101, invoice_item_id: 71, service_id: 1, status: 'added', total: 150000, clinic_item_id: null, doctor_id: { id: 20, full_name: 'Врач Первый' } },
    { id: 102, invoice_item_id: 72, service_id: 2, status: 'in_progress', total: 80000, clinic_item_id: null, doctor_id: null },
];
function world(inv = INV) {
    tables = { invoices: [inv], invoice_items: ITEMS, visit_services: LINES,
        services: [{ id: 1, name: 'Приём терапевта', price: 100000, requires_doctor: 0, active: 1 }, { id: 3, name: 'ЭКГ', price: 35000, requires_doctor: 0, active: 1 }] };
    calls.length = 0;
    rpcAnswers = {
        cashier_line_performers: { performers: [{ id: 20, full_name: 'Врач Первый', unit_price: 150000 }, { id: 21, full_name: 'Врач Второй', specialty: 'Терапевт', unit_price: 120000 }], requires_doctor: false, catalog_price: 100000 },
        cashier_line_set_doctor: { changed: true },
        cashier_line_change_service: { changed: true },
        cashier_line_remove: { removed: true },
        cashier_line_add: { invoice: { id: 5, invoice_number: 'INV-A-26-00005' }, invoice_created: false },
    };
}
const rpcCalls = (name) => calls.filter(([n]) => n === name);

test('право выключено: у счёта нет «Исправить услуги» — кассир только принимает оплату', () => {
    asCashier();                                        // ключ не настраивали
    assert.equal(fixButton(desk.__test_invoiceRow(INV, mkEl('div'))), undefined);
    asCashier({ 'cashier.lines': 'none' });             // явное «Нет»
    assert.equal(fixButton(desk.__test_invoiceRow(INV, mkEl('div'))), undefined);
    asCashier({ cashier: 'none', 'cashier.lines': 'edit' });   // закрытый раздел закрывает строку
    assert.equal(perms.canFixCashierLines(), false);
    // Оплата при этом на месте.
    asCashier();
    assert.ok(buttons(desk.__test_invoiceRow(INV, mkEl('div'))).some((b) => textOf(b).includes('Оплатить')));
});

test('право включено: кнопка есть у счёта визита; у депозита, карты, плательщика и отменённого — нет', () => {
    asCashier({ 'cashier.lines': 'edit' });
    assert.ok(fixButton(desk.__test_invoiceRow(INV, mkEl('div'))));
    assert.ok(fixButton(desk.__test_invoiceRow({ ...INV, status: 'paid', paid_amount: 230000 }, mkEl('div'))), 'к оплаченному — добавить новым счётом');
    for (const other of [{ visit_id: null }, { invoice_number: 'DEP-26-001' }, { invoice_number: 'CARD-26-001' }, { payer_id: 4 }, { status: 'void' }]) {
        assert.equal(fixButton(desk.__test_invoiceRow({ ...INV, ...other }, mkEl('div'))), undefined, JSON.stringify(other));
    }
});

test('окно: у неначатой строки — «Заменить услугу», «Сменить врача», «Убрать»; у начатой — ничего; внизу «+ Добавить услугу»', async () => {
    asCashier({ 'cashier.lines': 'edit' });
    world();
    closeAll();
    fixButton(desk.__test_invoiceRow(INV, mkEl('div'))).click();
    await tick(60);
    const m = lastModal();
    assert.match(textOf(m), /Исправить услуги · INV-A-26-00005/);
    const rowOf = (id) => walk(m).find((e) => e.attrs && e.attrs['data-line'] === String(id));
    const first = rowOf(101);
    assert.ok(buttonByText(first, 'Заменить услугу') && buttonByText(first, 'Сменить врача') && buttonByText(first, 'Убрать'));
    assert.match(textOf(first), /Врач Первый/);
    const started = rowOf(102);
    assert.equal(buttons(started).length, 0, 'у начатой работы кнопок нет');
    assert.match(textOf(started), /Работа уже начата/);
    assert.ok(buttonByText(m, '+ Добавить услугу'));
    assert.match(textOf(m), /К оплате по счёту: 230 000 сум/);
});

test('«Сменить врача» — список исполнителей с ценами, выбор уходит на сервер', async () => {
    asCashier({ 'cashier.lines': 'edit' });
    world();
    closeAll();
    let changed = 0;
    await fix.openLineFix(INV, { onChanged: () => { changed++; } });
    const m = lastModal();
    buttonByText(walk(m).find((e) => e.attrs && e.attrs['data-line'] === '101'), 'Сменить врача').click();
    await tick(60);
    const picker = lastModal();
    assert.match(textOf(picker), /Врач Второй/);
    assert.match(textOf(picker), /120 000/);
    assert.deepEqual(rpcCalls('cashier_line_performers')[0][1], { visit_service_id: 101 });
    walk(picker).find((e) => e.attrs && e.attrs['data-performer'] === '21').click();
    await tick(60);
    assert.deepEqual(rpcCalls('cashier_line_set_doctor')[0][1], { visit_service_id: 101, doctor_id: 21 });
    assert.equal(changed, 1, 'касса перерисована');
});

test('«Заменить услугу» и «Убрать» зовут свои двери', async () => {
    asCashier({ 'cashier.lines': 'edit' });
    world();
    closeAll();
    await fix.openLineFix(INV);
    const line = () => walk(lastModal()).find((e) => e.attrs && e.attrs['data-line'] === '101');
    buttonByText(line(), 'Заменить услугу').click();
    await tick(60);
    const picker = lastModal();
    walk(picker).find((e) => e.attrs && e.attrs['data-service-id'] === '3').click();
    await tick(60);
    assert.deepEqual(rpcCalls('cashier_line_change_service')[0][1], { visit_service_id: 101, new_service_id: 3 });
    buttonByText(walk(modals()[0]).find((e) => e.attrs && e.attrs['data-line'] === '101'), 'Убрать').click();
    await tick(60);
    assert.deepEqual(rpcCalls('cashier_line_remove')[0][1], { visit_service_id: 101 });
});

test('«+ Добавить услугу»: услуга, врач (или «Без врача»), в этот счёт', async () => {
    asCashier({ 'cashier.lines': 'edit' });
    world();
    closeAll();
    await fix.openLineFix(INV);
    buttonByText(lastModal(), '+ Добавить услугу').click();
    await tick(60);
    walk(lastModal()).find((e) => e.attrs && e.attrs['data-service-id'] === '3').click();
    await tick(60);
    const who = lastModal();
    assert.ok(walk(who).find((e) => e.attrs && e.attrs['data-performer'] === 'none'), 'услуге врач не нужен — есть «Без врача»');
    assert.deepEqual(rpcCalls('cashier_line_performers')[0][1], { service_id: 3, visit_id: 40 });
    walk(who).find((e) => e.attrs && e.attrs['data-performer'] === 'none').click();
    await tick(60);
    assert.deepEqual(rpcCalls('cashier_line_add')[0][1], { invoice_id: 5, service_id: 3, doctor_id: null });
});

test('оплаченный счёт: строки не правятся, добавление объяснено — отдельным счётом', async () => {
    asCashier({ 'cashier.lines': 'edit' });
    const paid = { ...INV, status: 'paid', paid_amount: 230000 };
    world(paid);
    closeAll();
    await fix.openLineFix(paid);
    const m = lastModal();
    assert.equal(buttonByText(m, 'Заменить услугу'), undefined);
    assert.equal(buttonByText(m, 'Убрать'), undefined);
    assert.match(textOf(m), /Новая услуга будет выставлена отдельным счётом/);
    assert.ok(buttonByText(m, '+ Добавить услугу'));
});

test('отказ сервера показывается его словами', async () => {
    asCashier({ 'cashier.lines': 'edit' });
    world();
    closeAll();
    globalThis.__origFetch = globalThis.__origFetch || globalThis.fetch;
    const base = globalThis.__origFetch;
    globalThis.fetch = async (url, opts) => {
        if (String(url).includes('/api/rpc/cashier_line_remove')) {
            return { ok: false, status: 409, json: async () => ({ error: { message: 'Начисления врачам за этот месяц закрыты — услуги визита этого месяца уже не меняют.' } }), headers: { getSetCookie: () => [] } };
        }
        return base(url, opts);
    };
    try {
        await fix.openLineFix(INV);
        buttonByText(walk(lastModal()).find((e) => e.attrs && e.attrs['data-line'] === '101'), 'Убрать').click();
        await tick(60);
        const toasts = document.body.children.filter((c) => c.dataset && c.dataset.kind === 'fail');
        assert.ok(toasts.length, 'отказ не показан');
        assert.match(toasts[toasts.length - 1]._text, /месяц закрыты/);
    } finally { globalThis.fetch = base; }
});

test('«Старший кассир»: у открытой смены — «Отчёт» и «Закрыть смену» при «Изменении» раздела', async () => {
    tables = {
        cash_shifts: [
            { id: 3, cashier_id: 10, users: { full_name: 'Кассир 2' }, status: 'open', opened_at: '2026-09-28T04:00:00Z', closed_at: null, opening_float: 0, expected_amount: null, counted_amount: null, over_short: null },
        ],
        payments: [],
    };
    perms.setEffectiveFromRoles([
        { name: 'cashier', permissions: { sections: ['cashier'], levels: { cashier: 'admin' } } },
        { name: 'head_cashier', permissions: { sections: ['cashier', 'cashier-head'], levels: { cashier: 'editor', 'cashier-head': 'editor' } } },
    ]);
    const c = mkEl('div');
    await desk.renderCashierHead(c);
    await tick(60);
    assert.ok(buttons(c).some((b) => textOf(b).trim() === 'Отчёт'));
    const close = buttons(c).find((b) => textOf(b).trim() === 'Закрыть смену');
    assert.ok(close, 'старший кассир закрывает чужую открытую смену');
    rpcAnswers = { shift_report: { shift: { id: 3, cashier_id: 10, status: 'open', opened_at: '2026-09-28T04:00:00Z' }, expected_drawer: 5000, totals: {} } };
    calls.length = 0;
    closeAll();
    close.click();
    await tick(60);
    assert.deepEqual(calls.find(([n]) => n === 'shift_report')[1], { shift_id: 3 });
    assert.match(textOf(lastModal()), /Закрыть смену/);

    // Только «Просмотр» раздела — отчёт есть, закрытия нет.
    perms.setEffectiveFromRoles([
        { name: 'cashier', permissions: { sections: ['cashier'], levels: { cashier: 'admin' } } },
        { name: 'head_cashier', permissions: { sections: ['cashier-head'], levels: { 'cashier-head': 'viewer' } } },
    ]);
    const v = mkEl('div');
    await desk.renderCashierHead(v);
    await tick(60);
    assert.ok(buttons(v).some((b) => textOf(b).trim() === 'Отчёт'));
    assert.equal(buttons(v).find((b) => textOf(b).trim() === 'Закрыть смену'), undefined);
});

test('кассир со старым «просмотром» кассы (до 3.2): оплата на месте, исправления — только по cashier.lines', () => {
    const old = { sections: ['cashier', 'patients'], levels: { cashier: 'viewer', patients: 'editor' }, grants: { cashier: 'view' } };
    perms.setEffectiveFromRole({ name: 'cashier', permissions: old });
    window.easymed.state.user = { id: 9, full_name: 'Кассир', role: 'cashier' };
    let row = desk.__test_invoiceRow(INV, mkEl('div'));
    assert.ok(buttons(row).some((b) => textOf(b).includes('Оплатить')), 'кассир со старым уровнем принимает оплату');
    assert.equal(fixButton(row), undefined);
    perms.setEffectiveFromRole({ name: 'cashier', permissions: { ...old, grants: { ...old.grants, 'cashier.lines': 'edit' } } });
    row = desk.__test_invoiceRow(INV, mkEl('div'));
    assert.ok(buttons(row).some((b) => textOf(b).includes('Оплатить')));
    assert.ok(fixButton(row), '«просмотр» кассы от старого экрана не закрывает право исправлений');
});
