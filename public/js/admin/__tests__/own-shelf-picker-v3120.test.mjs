// V3120_FIX — окно выдачи («Выдать препарат» в кабинете врача, «Добавить
// товары» в процедурах, окно визита, «Добавить расход» в истории болезни)
// показывало ТОЛЬКО складской остаток и красило «0» тревогой, хотя сервер
// спишет со своей полки (подотчёт → кабинет → отдел) и склад не тронет. Теперь
// окно, которому назвали место выдачи, спрашивает у сервера свои полки
// (holdings_list reachable) и показывает «Своё: N · склад: M».
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

class FakeNode {
    constructor(tag) {
        this.tagName = String(tag).toUpperCase();
        this.style = {}; this.children = []; this.attrs = {};
        this.className = ''; this._text = ''; this._l = {}; this.dataset = {};
        this.value = '';
    }
    appendChild(c) { this.children.push(c); return c; }
    append(...cs) { for (const c of cs) this.children.push(typeof c === 'string' ? new FakeText(c) : c); }
    removeChild(c) { const i = this.children.indexOf(c); if (i > -1) this.children.splice(i, 1); return c; }
    get firstChild() { return this.children.length ? this.children[0] : null; }
    replaceChildren() { this.children.length = 0; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); }
    removeAttribute(k) { delete this.attrs[k]; }
    addEventListener(t, fn) { (this._l[t] || (this._l[t] = [])).push(fn); }
    removeEventListener() {}
    dispatchEvent(e) { for (const fn of this._l[e.type] || []) fn(e); return true; }
    click() { this.dispatchEvent({ type: 'click', currentTarget: this, preventDefault() {}, stopPropagation() {} }); }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    remove() {}
    focus() {} blur() {} select() {}
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
globalThis.localStorage = { getItem: (k) => (k === 'admin.lang' ? 'ru' : null), setItem() {}, removeItem() {}, clear() {} };
globalThis.window = { location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, addEventListener() {}, removeEventListener() {},
    CLINIC: { id: 1 }, easymed: { state: { user: { id: 11, role: 'nurse' } } }, confirm: () => true };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();

const walk = (e, out = []) => { if (!e || typeof e !== 'object') return out; out.push(e); for (const c of e.children || []) walk(c, out); return out; };
const textOf = (e) => walk(e).map((x) => x._text || '').join(' ');
const settle = () => new Promise((r) => setTimeout(r, 30));

let rpcCalls = [];
const PRODUCTS = [
    { id: 40, name: 'Бинт', unit: 'шт', sale_price: 2000, on_hand: 0, active: 1, is_drug: 0 },
    { id: 41, name: 'Шприц', unit: 'шт', sale_price: 1500, on_hand: 7, active: 1, is_drug: 0 },
];
const MINE = { holdings: [
    { holder_type: 'staff', holder_id: 11, product_id: 40, qty_base: 2 },
    { holder_type: 'room', holder_id: 21, product_id: 40, qty_base: 3 },
] };
globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    let body = {}; try { body = JSON.parse(opts.body || '{}'); } catch { /* not ours */ }
    const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }), headers: { getSetCookie: () => [] } });
    if (u.startsWith('/api/rpc/')) {
        rpcCalls.push({ name: decodeURIComponent(u.slice('/api/rpc/'.length)), args: body });
        return ok(MINE);
    }
    if (u === '/api/db' && body.table === 'products') return ok(PRODUCTS);
    return ok([]);
};

const { openItemPickerModal, loadOwnShelves } = await import('../views/item-picker-modal.js');

test('loadOwnShelves: свои полки суммируются по товару, спрашиваются «только свои» для места выдачи', async () => {
    rpcCalls = [];
    const own = await loadOwnShelves({ visit_id: 301 });
    assert.equal(own.get(40), 5);
    assert.deepEqual(rpcCalls, [{ name: 'holdings_list', args: { reachable: true, visit_id: 301 } }]);
    rpcCalls = [];
    await loadOwnShelves({ admission_id: 13 });
    assert.deepEqual(rpcCalls[0].args, { reachable: true, admission_id: 13 });
});

test('окно выдачи с местом: «Своё: 5 · склад: 0» вместо красного «Остаток: 0»', async () => {
    BODY.children.length = 0;
    openItemPickerModal({ place: { visit_id: 301 }, onConfirm: async () => {} });
    await settle();
    const txt = textOf(BODY);
    assert.ok(txt.includes('Своё: 5 · склад: 0'), 'остаток своих полок виден: ' + txt);
    assert.ok(txt.includes('Остаток: 7'), 'товар без своей полки — складской остаток, как прежде');
    const bint = walk(BODY).find((e) => (e._text || '').includes('Своё: 5'));
    assert.notEqual(bint.style.color, 'var(--crit-700)', 'товар на руках — не тревога');
});

test('окно без места — как прежде, только склад; свои полки не спрашиваются', async () => {
    BODY.children.length = 0; rpcCalls = [];
    openItemPickerModal({ onConfirm: async () => {} });
    await settle();
    assert.equal(rpcCalls.length, 0);
    assert.ok(textOf(BODY).includes('Остаток: 0'));
});

test('все четыре двери, что зовут окно выдачи, называют место', () => {
    const src = (f) => fs.readFileSync(new URL(`../views/${f}`, import.meta.url), 'utf8');
    assert.match(src('service-workspace.js'), /place:\s*\{ visit_id: ctx\.visitId \}/);
    assert.match(src('visit-modal.js'), /place:\s*\{ visit_id: state\.visit\.id \}/);
    assert.match(src('procedures.js'), /place: \{ visit_id: r\.visit_id \}/);
    assert.match(src('case-workspace.js'), /place: \{ admission_id: state\.admissionId \}/);
    assert.match(src('ward-beds.js'), /loadOwnShelves\(\{ admission_id: adm\.id \}\)/);
});
