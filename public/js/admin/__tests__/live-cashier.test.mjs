// LIVE_REFRESH_V1 (3.22.0, владелец 2026-11-08) — «КАССА ОБНОВЛЯЕТСЯ САМА».
// Настоящий cashier-desk.js в фальшивом DOM; сервер — заглушка fetch; поток изменений —
// настоящий клиент live.js на поддельном EventSource и поддельных часах.
//   • счёт выставлен (invoices) — касса перечиталась, новый счёт на экране;
//   • результат анализа (lab_results) — касса не тронута;
//   • открыто окно — касса ждёт и перечитывается, как только окно закрыли;
//   • перечитывание тихое: прежний список стоит на экране, пока идёт запрос; фильтр и
//     строка поиска на месте; фокус в поле поиска не прыгает.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeClock, FakeES } from './live-fakes.mjs';

let focusCalls = 0;
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
    contains(n) { if (n === this) return true; for (const c of this.children) if (c === n || (c.contains && c.contains(n))) return true; return false; }
    setSelectionRange() {}
    focus() { focusCalls++; }
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

globalThis.Node = FakeNode;
const TOASTS = [];
const TOAST_EL = mkEl('div');
Object.defineProperty(TOAST_EL, 'textContent', { get() { return ''; }, set(v) { TOASTS.push(String(v)); }, configurable: true });
let modalOpen = false;
globalThis.document = {
    hidden: false, activeElement: null,
    createElement: mkEl, createElementNS: (_n, t) => mkEl(t), createTextNode: (t) => new FakeText(t),
    head: mkEl('head'), body: mkEl('body'), documentElement: mkEl('html'),
    addEventListener() {}, removeEventListener() {},
    getElementById(id) { return id === 'toast' ? TOAST_EL : null; },
    querySelector(sel) { return modalOpen && /\.modal/.test(sel) ? mkEl('div') : null; },
    querySelectorAll() { return []; },
};
globalThis.window = { location: { hostname: 'localhost' }, localStorage: { getItem: () => null, setItem() {} }, easymed: { state: { user: { id: 9, full_name: 'Кассир', role: 'cashier' } } }, addEventListener() {} };
const store = new Map([['admin.lang', 'ru']]);
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem(k, v) { store.set(k, String(v)); }, removeItem(k) { store.delete(k); }, clear() {} };
globalThis.MutationObserver = class { observe() {} disconnect() {} };

// ---- сервер-заглушка ----
const calls = [];
let invoices = [];
let onInvoices = null;   // подглядеть экран в момент запроса
const inv = (id, status = 'unpaid') => ({
    id, invoice_number: 'INV-' + id, status, total_amount: 100000, paid_amount: status === 'paid' ? 100000 : 0,
    subtotal: 100000, discount_amount: 0, patient_name: 'Счёт-Пациент-' + id, mrn: 'M' + id, first_item: 'Услуга',
    items_count: 1, created_at: new Date().toISOString(), methods: '',
});
const SUMMARY = {
    shift: { id: 1, opened_at: new Date().toISOString(), opening_float: 0 },
    totals: { count: 0, total: 0, card: 0, acquiring: 0, cash: 0 }, cash_in: 0, cash_out: 0, expected_drawer: 0, cashier_name: 'Кассир',
};
globalThis.fetch = async (url, opts = {}) => {
    let body = {};
    try { body = JSON.parse(opts.body || '{}'); } catch { /* не json */ }
    const name = decodeURIComponent(String(url).split('/api/rpc/')[1] || ('db:' + body.table));
    calls.push(name);
    let data = [];
    if (name === 'cash_shift_summary') data = SUMMARY;
    else if (name === 'cashier_invoices') {
        if (onInvoices) onInvoices();
        data = { rows: invoices.slice(), counts: null };
    } else if (name === 'cashier_unbilled' || name === 'cashier_refunds') data = { rows: [], totals: null };
    else if (name === 'list_deposits' || name === 'list_card_sales') data = { rows: [] };
    else if (name === 'cashier_invoice_search') data = { rows: [], has_more: false };
    return { ok: true, status: 200, json: async () => ({ data }), headers: { getSetCookie: () => [] } };
};

// ---- поток изменений: настоящий клиент на подделках ----
const clock = fakeClock();
const live = await import('../live.js');
const client = live.createLiveClient({
    EventSource: FakeES, fetch: async () => ({ ok: true, status: 200, json: async () => ({ v: 1, tables: [], rpc: [] }) }),
    document: globalThis.document, window: globalThis.window,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, now: clock.now, random: () => 0.5,
});
live.__setLiveClientForTests(client);

const desk = await import('../views/cashier-desk.js');
const walk = (e, out = []) => { if (!e || typeof e !== 'object') return out; out.push(e); for (const c of e.children || []) walk(c, out); return out; };
const textOf = (e) => walk(e).map((x) => x._text || '').join(' ');
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const count = (n) => calls.filter((c) => c === n).length;

let version = 1;
const emit = (tables) => FakeES.live()[0].emit('change', { v: ++version, tables, rpc: [] });
async function settle(ms) { await clock.advance(ms); await tick(40); }

const container = mkEl('div');
invoices = [inv(1)];
await desk.renderCashier(container);
const es = FakeES.live()[0];
es.open();
es.emit('hello', { v: version });

test('касса подписана на поток: один EventSource на вкладку', () => {
    assert.equal(FakeES.live().length, 1);
    assert.equal(client.status().subscribers, 1);
    assert.match(textOf(container), /Счёт-Пациент-1/);
});

test('выставлен счёт — касса перечиталась сама, новый счёт на экране; список не пустел во время запроса', async () => {
    const before = count('cashier_invoices');
    invoices = [inv(2), inv(1)];
    let shownDuringFetch = null;
    onInvoices = () => { shownDuringFetch = textOf(container); };
    emit(['invoices', 'invoice_items']);
    await settle(live.DEBOUNCE_MS + 10);
    onInvoices = null;
    assert.equal(count('cashier_invoices'), before + 1, 'один тихий перечит');
    assert.match(shownDuringFetch || '', /Счёт-Пациент-1/, 'пока шёл запрос, прежний список стоял на экране');
    assert.match(textOf(container), /Счёт-Пациент-2/, 'новый счёт появился без «Обновить»');
    assert.equal(TOASTS.length, 0, 'без уведомлений');
});

test('изменение не для кассы (результат анализа) — касса не перечитывается', async () => {
    const before = count('cashier_invoices');
    emit(['lab_results']);
    await settle(live.DEBOUNCE_MS + live.RECHECK_MS);
    assert.equal(count('cashier_invoices'), before);
});

test('открыто окно (оплата) — касса ждёт; окно закрыли — перечиталась в ближайшую проверку', async () => {
    const before = count('cashier_invoices');
    modalOpen = true;
    invoices = [inv(3), inv(2), inv(1)];
    emit(['payments']);
    await settle(live.DEBOUNCE_MS + live.RECHECK_MS * 3);
    assert.equal(count('cashier_invoices'), before, 'под открытым окном не перечитывается');
    assert.doesNotMatch(textOf(container), /Счёт-Пациент-3/);
    modalOpen = false;
    await settle(live.RECHECK_MS + 10);
    assert.equal(count('cashier_invoices'), before + 1, 'окно закрыто — перечиталась');
    assert.match(textOf(container), /Счёт-Пациент-3/);
});

test('фильтр и строка поиска на месте; фокус в поле поиска не прыгает', async () => {
    const st = desk.__test_cardState;
    st.filter = 'all';
    st.search = 'Счёт';
    const before = count('cashier_invoices');
    focusCalls = 0;
    invoices = [inv(4, 'paid'), inv(3)];
    emit(['payments']);
    await settle(live.DEBOUNCE_MS + 10);
    assert.equal(count('cashier_invoices'), before + 1);
    assert.equal(st.filter, 'all', 'фильтр не сброшен');
    assert.equal(st.search, 'Счёт', 'поиск не сброшен');
    assert.equal(focusCalls, 0, 'тихое перечитывание фокус не забирает');
    assert.match(textOf(container), /Счёт-Пациент-4/);
});

test('новое открытие кассы — прежняя подписка снята, новая одна', async () => {
    await desk.renderCashier(container);
    assert.equal(client.status().subscribers, 1);
});
