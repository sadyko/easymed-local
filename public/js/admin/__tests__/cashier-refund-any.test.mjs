// REFUND_ANY_V1 (2026-10-29) — ВОЗВРАТ ЛЮБОЙ УСЛУГИ: КАССА.
//
// Сервер возврат сделанной работы не запрещает — до него было не дойти.
// Здесь экран:
//   • поиск кассы спрашивает сервер по всем дням (cashier_invoice_search) и
//     рисует найденное блоком «Счета за все дни»; «Платежи» открывает полное
//     окно счёта (с «Вернуть услугу»);
//   • строки «Истории операций» открывают то же окно;
//   • окно «Платежи» открывается и не из кассы (окно визита):
//     openInvoiceRefundById(…, { onDone }) — после возврата перечитывается
//     вызвавший экран, а не касса.
// Заглушка документа — та же, что у cashier-unbilled.test.mjs.

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
    focus() {}
    remove() { document.body.children = document.body.children.filter((c) => c !== this); }
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
const TOASTS = [];
globalThis.Node = FakeNode;
const TOAST_EL = mkEl('div');
Object.defineProperty(TOAST_EL, 'textContent', { get() { return ''; }, set(v) { TOASTS.push(String(v)); }, configurable: true });
globalThis.document = {
    createElement: mkEl, createElementNS: (_n, t) => mkEl(t), createTextNode: (t) => new FakeText(t),
    head: mkEl('head'), body: mkEl('body'), documentElement: mkEl('html'),
    addEventListener() {}, removeEventListener() {}, getElementById(id) { return id === 'toast' ? TOAST_EL : null; },
    querySelectorAll(sel) { return sel === '.modal' ? document.body.children.filter((c) => c.className === 'modal') : []; },
};
globalThis.window = { location: { hostname: 'localhost' }, localStorage: { getItem: () => null, setItem() {} }, open: () => null, easymed: { state: { user: { id: 9, full_name: 'Кассир', role: 'cashier' } } } };
const store = new Map([['admin.lang', 'ru']]);
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem(k, v) { store.set(k, String(v)); }, removeItem(k) { store.delete(k); }, clear() {} };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.confirm = () => true;
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
        const name = decodeURIComponent(rpc);
        calls.push([name, body]);
        const a = rpcAnswers[name];
        if (a && a.__error) return { ok: false, status: 500, json: async () => ({ error: { message: a.__error } }), headers: { getSetCookie: () => [] } };
        data = typeof a === 'function' ? a(body) : (a !== undefined ? a : []);
    } else {
        calls.push(['db:' + body.table, body]);
        const rows = (tables[body.table] || []).filter((r) => (body.filters || []).every((f) => matches(r, f)));
        data = body.single ? (rows[0] || null) : rows;
    }
    return { ok: true, status: 200, json: async () => ({ data }), headers: { getSetCookie: () => [] } };
};

const desk = await import('../views/cashier-desk.js');
const perms = await import('../permissions.js');

const walk = (e, out = []) => { if (!e || typeof e !== 'object') return out; out.push(e); for (const c of e.children || []) walk(c, out); return out; };
const textOf = (e) => walk(e).map((x) => x._text || '').join(' ');
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const modals = () => document.body.children.filter((c) => c.className === 'modal');
const lastModal = () => modals()[modals().length - 1];
const buttons = (root) => walk(root).filter((e) => e.tagName === 'BUTTON');
const buttonByText = (root, t) => buttons(root).find((b) => textOf(b).trim() === t);
const byAttr = (root, k, v) => walk(root).find((e) => e.attrs && e.attrs[k] === v);
const allByAttr = (root, k) => walk(root).filter((e) => e.attrs && e.attrs[k] !== undefined);
const closeAll = () => { document.body.children = document.body.children.filter((c) => c.className !== 'modal'); };
const rpcCalls = (name) => calls.filter(([n]) => n === name);

function asCashier() {
    perms.setEffectiveFromRole({ name: 'cashier', permissions: { sections: ['cashier', 'patients'], levels: { cashier: 'admin', patients: 'editor' }, grants: {} } });
    window.easymed.state.user = { id: 9, full_name: 'Кассир', role: 'cashier' };
}

const TODAY_ROW = { id: 30, invoice_number: 'INV-A-26-00030', status: 'paid', subtotal: 100000, discount_amount: 0, total_amount: 100000, paid_amount: 100000,
    created_at: new Date().toISOString(), patient_name: 'Рахимов Жасур', mrn: 'A-26-00015', phone: '+998901112233', patient_id: 3, items_count: 1, first_item: 'Приём терапевта', methods: 'cash' };
const OLD_ROW = { ...TODAY_ROW, id: 7, invoice_number: 'INV-A-26-00007', created_at: '2026-10-19T06:00:00Z', first_item: 'Анализ крови' };
const OLDER_ROW = { ...TODAY_ROW, id: 5, invoice_number: 'INV-A-26-00005', status: 'void', paid_amount: 0, created_at: '2026-10-02T06:00:00Z' };
const PAYMENTS = [{ id: 71, invoice_id: 7, amount: 100000, method: 'cash', paid_at: '2026-10-19T06:05:00Z', notes: '' }];
const ITEMS = [{ id: 701, invoice_id: 7, description: 'Анализ крови', quantity: 1, unit_price: 100000, total: 100000, discount_amount: 0 }];

test('поиск кассы спрашивает сервер по всем дням и рисует «Счета за все дни» (без счетов, что уже в списке)', async () => {
    asCashier();
    closeAll();
    const st = desk.__test_cardState;
    st.filter = 'paid';
    st.rows = [TODAY_ROW];
    st.counts = null;
    st.search = 'рахимов';
    st.found = { result: null, pendingQ: null };
    calls.length = 0;
    rpcAnswers = { cashier_invoice_search: (b) => (b.q === 'рахимов' ? { q: 'рахимов', rows: [TODAY_ROW, OLD_ROW, OLDER_ROW], offset: 0, has_more: true } : { rows: [] }) };
    let repaints = 0;
    desk.__test_paintSearch(mkEl('div'), () => { repaints++; });
    const busy = mkEl('div');
    desk.__test_paintTable(busy, mkEl('div'));
    assert.match(textOf(busy), /Счета за все дни/);
    assert.match(textOf(busy), /Ищем…/, 'пока сервер отвечает — «Ищем…»');
    await tick(60);
    assert.deepEqual(rpcCalls('cashier_invoice_search').map(([, b]) => b), [{ q: 'рахимов' }], 'строка поиска не ушла на сервер');
    assert.equal(repaints, 1, 'ответ поиска не перерисовал экран');
    const el = mkEl('div');
    desk.__test_paintTable(el, mkEl('div'));
    const shown = allByAttr(el, 'data-found-row').map((x) => x.attrs['data-found-row']);
    assert.deepEqual(shown, ['7', '5'], 'сегодняшний счёт уже в списке — второй раз его нет');
    const old = byAttr(el, 'data-found-row', '7');
    for (const piece of ['INV-A-26-00007', 'Рахимов Жасур', 'A-26-00015', '100 000 из 100 000 сум']) {
        assert.ok(textOf(old).includes(piece), 'в найденной строке нет «' + piece + '»: ' + textOf(old));
    }
    assert.ok(byAttr(el, 'data-found-more', '1'), '«Показать ещё» — у сервера есть ещё страница');
    // Тот же поиск второй раз не спрашивается.
    desk.__test_paintSearch(mkEl('div'), () => {});
    await tick(20);
    assert.equal(rpcCalls('cashier_invoice_search').length, 1);
    // «Показать ещё» — следующая страница с offset.
    rpcAnswers.cashier_invoice_search = (b) => (b.offset === 3 ? { q: 'рахимов', rows: [{ ...OLD_ROW, id: 4, invoice_number: 'INV-A-26-00004' }], offset: 3, has_more: false } : { rows: [] });
    byAttr(el, 'data-found-more', '1').click();
    await tick(60);
    assert.deepEqual(rpcCalls('cashier_invoice_search').at(-1)[1], { q: 'рахимов', offset: 3 });
    const el2 = mkEl('div');
    desk.__test_paintTable(el2, mkEl('div'));
    assert.deepEqual(allByAttr(el2, 'data-found-row').map((x) => x.attrs['data-found-row']), ['7', '5', '4']);
    assert.equal(byAttr(el2, 'data-found-more', '1'), undefined);
    // Одна буква — сервер не спрашивается, блока нет.
    st.search = 'р';
    st.found = { result: null, pendingQ: null };
    const before = rpcCalls('cashier_invoice_search').length;
    desk.__test_paintSearch(mkEl('div'), () => {});
    const el3 = mkEl('div');
    desk.__test_paintTable(el3, mkEl('div'));
    assert.equal(rpcCalls('cashier_invoice_search').length, before);
    assert.doesNotMatch(textOf(el3), /Счета за все дни/);
    st.search = '';
    st.filter = 'unpaid';
});

test('«Платежи» у найденного счёта — полное окно: платежи и «Вернуть услугу»', async () => {
    asCashier();
    closeAll();
    const st = desk.__test_cardState;
    st.filter = 'paid';
    st.rows = [];
    st.search = 'рахимов';
    st.found = { result: { q: 'рахимов', rows: [OLD_ROW], has_more: false, error: null }, pendingQ: null };
    tables = { payments: PAYMENTS, invoice_items: ITEMS };
    rpcAnswers = {};
    const el = mkEl('div');
    desk.__test_paintTable(el, mkEl('div'));
    byAttr(el, 'data-found-pay', '7').click();
    await tick(60);
    const m = lastModal();
    assert.ok(m, 'окно «Платежи» не открылось');
    assert.match(textOf(m), /Платежи · INV-A-26-00007 · Рахимов Жасур/);
    assert.ok(buttonByText(m, 'Вернуть услугу'), 'в окне нет «Вернуть услугу»');
    assert.ok(buttonByText(m, 'Возврат'), 'в окне нет возврата по платежу');
    st.search = '';
    st.filter = 'unpaid';
    closeAll();
});

test('строка «Истории операций» открывает окно «Платежи» своего счёта (по номеру — с сервера)', async () => {
    asCashier();
    closeAll();
    const st = desk.__test_cardState;
    st.rows = [];
    tables = { payments: PAYMENTS, invoice_items: ITEMS, invoices: [{ id: 7, invoice_number: 'INV-A-26-00007', patients: { full_name: 'Рахимов Жасур' } }], cash_movements: [] };
    calls.length = 0;
    rpcAnswers = { cashier_invoice_search: (b) => (b.invoice_id === 7 ? { q: null, rows: [OLD_ROW], offset: 0, has_more: false } : { rows: [] }) };
    await desk.__test_historyModal(mkEl('div'));
    const hist = lastModal();
    assert.match(textOf(hist), /История операций/);
    const open = byAttr(hist, 'data-history-open', '7');
    assert.ok(open, 'у строки платежа нет «Платежи»');
    open.click();
    await tick(60);
    assert.deepEqual(rpcCalls('cashier_invoice_search').map(([, b]) => b), [{ invoice_id: 7 }]);
    assert.match(textOf(lastModal()), /Платежи · INV-A-26-00007/);
    assert.ok(buttonByText(lastModal(), 'Вернуть услугу'));
    // Счёт не найден в кассе этого здания — словами, окна нет.
    closeAll();
    TOASTS.length = 0;
    await desk.openInvoiceRefundById(999, { onDone: () => {} });
    assert.equal(modals().length, 0);
    assert.ok(TOASTS.includes('Счёт не найден в кассе этого здания.'), TOASTS.join(' | '));
});

test('новые строки экрана — в словаре на трёх языках, uz/en без кириллицы', async () => {
    const { STRINGS } = await import('../i18n-strings.js');
    for (const key of ['Счета за все дни', 'За другие дни счетов по этому поиску нет.', 'Платежи', '{paid} из {total} сум', 'Счёт не найден в кассе этого здания.']) {
        const e = STRINGS[key];
        assert.ok(e, 'нет ключа словаря: ' + key);
        assert.equal(e.ru, key);
        for (const lang of ['uz', 'en']) {
            assert.ok(e[lang], key + ': нет перевода ' + lang);
            assert.doesNotMatch(e[lang], /[Ѐ-ӿ]/, key + ': кириллица в ' + lang);
        }
    }
});
