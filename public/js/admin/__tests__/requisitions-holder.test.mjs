// STOCK_REQUEST_V1 (R2) — «ЗАЯВКИ» У КЛАДОВЩИКА: ДЛЯ КОГО И «АВТО».
//
// После R1 заявка бывает не только отдела: сотрудник просит себе, а минимум
// подаёт заявку сам («авто»). Кладовщику, который одобряет и этим выдаёт,
// нужно видеть, КОМУ уйдёт товар, и отличать заявку человека от автозаявки.
// Что закреплено:
//   1. Колонка «Для кого»: имя сотрудника для личной заявки, отдел — для
//      заявки отдела, отдел — и для старой заявки без держателя.
//   2. Пометка «авто» у автозаявки — в списке и в карточке заявки.
//   3. Одобрение осталось одной кнопкой: approve_requisition_and_issue.

import { test } from 'node:test';
import assert from 'node:assert';

// ─── минимальный DOM (тот же стенд, что у my-stock.test.mjs) ────────────────
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
globalThis.localStorage = { getItem: (k) => (k === 'admin.lang' ? 'ru' : null), setItem() {}, removeItem() {}, clear() {} };
globalThis.window = { location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, addEventListener() {}, open: () => null,
    easymed: { state: { user: { id: 3, role: 'inventory', full_name: 'Кладовщик' } } }, confirm: () => true, prompt: () => null };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();

const walk = (e, out = []) => { if (!e || typeof e !== 'object') return out; out.push(e); for (const c of e.children || []) walk(c, out); return out; };
const labelOf = (e) => walk(e).filter((x) => x.tagName !== 'SVG').map((x) => x._text || '').join(' ').replace(/\s+/g, ' ').trim();
const findAll = (root, tag) => walk(root).filter((e) => e.tagName === tag);
const findBtn = (root, label) => walk(root).find((e) => e.tagName === 'BUTTON' && labelOf(e).includes(label));
const settle = () => new Promise((r) => setTimeout(r, 30));
const lastModal = () => [...BODY.children].reverse().find((c) => String(c.className).split(/\s+/).includes('modal'));

// ─── «сервер» ───────────────────────────────────────────────────────────────
const rpcCalls = [];
const dbCalls = [];
const REQS = [
    { id: 3, req_number: 'REQ-20260923-003', status: 'submitted', created_at: '2026-09-23T09:00:00Z', holder_type: 'staff', holder_id: 5, auto: 1, departments: null },
    { id: 2, req_number: 'REQ-20260923-002', status: 'submitted', created_at: '2026-09-23T08:00:00Z', holder_type: 'department', holder_id: 9, auto: 0, departments: { id: 9, name: 'Терапия' } },
    { id: 1, req_number: 'REQ-20260901-001', status: 'issued', created_at: '2026-09-01T08:00:00Z', holder_type: null, holder_id: null, auto: 0, departments: { id: 10, name: 'Хирургия' } },
];
const TABLES = {
    purchase_requisitions: () => REQS,
    purchase_requisition_items: (d) => (d.filters.some((f) => f.col === 'req_id' && f.op === 'eq')
        ? [{ id: 1, qty: 0.16, note: null, products: { name: 'Перчатки', base_unit: 'уп' } }]
        : [{ req_id: 3 }, { req_id: 2 }, { req_id: 2 }, { req_id: 1 }]),
    users: () => [{ id: 5, full_name: 'Медсестра Ирина' }],
};

globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    let body = {}; try { body = JSON.parse(opts.body || '{}'); } catch { /* not ours */ }
    if (u.startsWith('/api/rpc/')) {
        const name = decodeURIComponent(u.slice('/api/rpc/'.length));
        rpcCalls.push({ name, args: body });
        return { ok: true, status: 200, json: async () => ({ data: { ok: true } }), headers: { getSetCookie: () => [] } };
    }
    dbCalls.push(body);
    const f = TABLES[body.table];
    return { ok: true, status: 200, json: async () => ({ data: f ? f(body) : [] }), headers: { getSetCookie: () => [] } };
};

const { renderRequisitionsTab } = await import('../views/inventory-docs.js');

async function openList() {
    rpcCalls.length = 0; dbCalls.length = 0; BODY.children.length = 0;
    const root = mkEl('div');
    renderRequisitionsTab(root);
    await settle();
    return root;
}
const bodyRows = (root) => findAll(root, 'TR').filter((tr) => findAll(tr, 'TD').length);

test('список заявок: «Для кого» — сотрудник или отдел, и пометка «авто»', async () => {
    const root = await openList();
    assert.deepEqual(findAll(root, 'TH').map(labelOf), ['№ заявки', 'Для кого', 'Статус', 'Позиции', 'Дата']);
    const rows = bodyRows(root).map((tr) => findAll(tr, 'TD').map(labelOf));
    assert.equal(rows.length, 3);
    assert.equal(rows[0][0], 'REQ-20260923-003 авто', 'автозаявка не помечена');
    assert.equal(rows[0][1], 'Медсестра Ирина', 'личная заявка не называет сотрудника');
    assert.equal(rows[1][0], 'REQ-20260923-002');
    assert.equal(rows[1][1], 'Терапия');
    assert.equal(rows[2][1], 'Хирургия', 'старая заявка без держателя — по отделу, как было');
    assert.equal(rows[1][3], '2');
    // Держатель и «авто» просятся у сервера, имя сотрудника — одним запросом.
    const q = dbCalls.find((d) => d.table === 'purchase_requisitions');
    assert.match(String(q.columns), /holder_type/);
    assert.match(String(q.columns), /auto/);
    const users = dbCalls.find((d) => d.table === 'users');
    assert.ok(users, 'имена сотрудников не запрошены');
    assert.deepEqual(users.filters.find((f) => f.col === 'id').val, [5]);
});

test('карточка заявки называет, для кого она и что она «авто»; одобрение — одна кнопка', async () => {
    const root = await openList();
    bodyRows(root)[0].click();
    await settle();
    const modal = lastModal();
    const text = labelOf(modal);
    assert.match(text, /Медсестра Ирина/);
    assert.match(text, /авто/);
    const approve = findAll(modal, 'BUTTON').filter((b) => /Approve|Одобрить/.test(labelOf(b)));
    assert.equal(approve.length, 1, 'одобрение должно остаться одной кнопкой');
    approve[0].click();
    await settle();
    assert.deepEqual(rpcCalls.map((c) => [c.name, c.args]), [['approve_requisition_and_issue', { req_id: 3 }]]);
});
