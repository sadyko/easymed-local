// STOCK_REQUEST_V1 (R2) — МИНИМУМЫ ОТДЕЛА НА КАРТОЧКЕ ОТДЕЛА («Снабжение»).
//
// Решение владельца 4: минимум отделу ставит его заведующая; кладовщик и
// администратор — любому. Члены отдела видят минимумы, но не правят их.
// Что закреплено:
//   1. Вкладка «Снабжение» спрашивает stock_minimums_list именно этого отдела.
//   2. Заведующая видит «Добавить минимум» и «Изменить», и правка уходит на
//      держателя-ОТДЕЛ в единицах расхода.
//   3. Член отдела видит те же строки только для чтения и слова, кто их ставит.
//   4. Отказ сервера виден словами; «Запросить у склада» осталась на месте.

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
const HEAD = { id: 4, role: 'nurse', full_name: 'Заведующая Каримова', department_id: 11 };
const MEMBER = { id: 5, role: 'nurse', full_name: 'Медсестра Алиева', department_id: 11 };
globalThis.window = { location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, addEventListener() {}, open: () => null,
    easymed: { state: { user: { ...HEAD } } }, confirm: () => true };
globalThis.history = { replaceState() {} };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();

const walk = (e, out = []) => { if (!e || typeof e !== 'object') return out; out.push(e); for (const c of e.children || []) walk(c, out); return out; };
const textOf = (e) => walk(e).map((x) => x._text || '').join(' ');
const labelOf = (e) => walk(e).filter((x) => x.tagName !== 'SVG').map((x) => x._text || '').join(' ').replace(/\s+/g, ' ').trim();
const findAll = (root, tag) => walk(root).filter((e) => e.tagName === tag);
const findBtn = (root, label) => walk(root).find((e) => e.tagName === 'BUTTON' && labelOf(e).includes(label));
const settle = () => new Promise((r) => setTimeout(r, 30));
const lastModal = () => [...BODY.children].reverse().find((c) => String(c.className).split(/\s+/).includes('modal'));
const byLabel = (root, label) => walk(root).find((e) => e.attrs && e.attrs['aria-label'] === label);
const type = (inp, v) => { inp.value = String(v); inp.dispatchEvent({ type: 'input', target: inp, currentTarget: inp }); };
const toastText = () => { const t = BODY.children.find((c) => c.attrs && c.attrs.id === 'toast'); return t ? labelOf(t) : ''; };

// ─── «сервер» ───────────────────────────────────────────────────────────────
const rpcCalls = [];
let MINS = null;
let FAIL = null;
let FAIL_MSG = 'база недоступна';

const CARD = {
    department: { id: 11, name: 'Кардиология', kind: 'clinical', code: 'KRD', active: 1, created_at: '2026-09-01T08:00:00Z',
        head: { id: 4, full_name: 'Заведующая Каримова', role: 'nurse' } },
    places: [], members: [{ id: 4, full_name: 'Заведующая Каримова', role: 'nurse' }, { id: 5, full_name: 'Медсестра Алиева', role: 'nurse' }],
    holdings: [], issues: [], usage: [], requisitions: [], events: [],
    can_form: false, can_issue: false, can_request: true,
};

globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    let body = {}; try { body = JSON.parse(opts.body || '{}'); } catch { /* not ours */ }
    if (u.startsWith('/api/rpc/')) {
        const name = decodeURIComponent(u.slice('/api/rpc/'.length));
        rpcCalls.push({ name, args: body });
        if (FAIL === name) return { ok: false, status: 403, json: async () => ({ error: { message: FAIL_MSG } }), headers: { getSetCookie: () => [] } };
        const data = name === 'department_card' ? CARD
            : name === 'stock_minimums_list' ? MINS
            : name === 'stock_minimum_set' ? { minimum: {}, request: { req_id: 60, req_number: 'REQ-20260923-010', qty: 4 } }
            : null;
        return { ok: true, status: 200, json: async () => ({ data }), headers: { getSetCookie: () => [] } };
    }
    return { ok: true, status: 200, json: async () => ({ data: [] }), headers: { getSetCookie: () => [] } };
};

const { renderDepartments } = await import('../views/departments.js');

const DEPT_MIN = {
    holder_type: 'department', holder_id: 11, holder_name: 'Кардиология',
    product_id: 7, product_name: 'Перчатки', base_unit: 'уп', consumption_unit: 'шт', consumption_factor: 100,
    held_qty: 2, held_units: 200, min_qty: 5, min_units: 500, target_qty: 10, target_units: 1000,
    below_min: true, set_by: 4, set_by_name: 'Заведующая Каримова', updated_at: '2026-09-23T08:00:00Z', can_edit: true,
    open_qty: 8, open_request: { req_id: 61, req_number: 'REQ-20260923-009', status: 'submitted', qty: 8, auto: true },
};

async function openSupply({ user = HEAD, rows = [DEPT_MIN], canManageAll = false, fail = null } = {}) {
    rpcCalls.length = 0;
    BODY.children.length = 0;
    FAIL = fail;
    MINS = { scope: 'department', can_manage_all: canManageAll, rows };
    globalThis.window.easymed.state.user = { ...user };
    const root = mkEl('div');
    await renderDepartments(root, { payload: { sub: '11' } });
    await settle();
    findBtn(root, 'Снабжение').click();
    await settle();
    return root;
}
const section = (root) => walk(root).find((e) => String(e.className).includes('dept-minimums'));

test('«Снабжение» спрашивает минимумы именно этого отдела и оставляет «Запросить у склада»', async () => {
    const root = await openSupply();
    const call = rpcCalls.find((c) => c.name === 'stock_minimums_list');
    assert.ok(call, 'минимумы отдела не запрошены');
    assert.deepEqual(call.args, { scope: 'department', department_id: 11 });
    assert.ok(findBtn(root, 'Запросить у склада'), '«Запросить у склада» пропала');
    const sec = section(root);
    assert.ok(sec, 'на вкладке нет раздела «Минимумы»');
    const row = findAll(sec, 'TR').find((tr) => findAll(tr, 'TD').length);
    const cells = findAll(row, 'TD').map(labelOf);
    assert.deepEqual(cells.slice(0, 5), ['Перчатки', '200 шт', '500 шт ниже минимума', '1000 шт', 'заявка REQ-20260923-009 на 800 шт, авто']);
    assert.ok(walk(row).some((e) => String(e.className).includes('tag-warn')), '«ниже минимума» не выделено');
});

test('заведующая правит минимум отдела: держатель — отдел, единицы — расхода', async () => {
    const root = await openSupply();
    const sec = section(root);
    assert.ok(findBtn(sec, 'Добавить минимум'), 'заведующей негде добавить минимум');
    findBtn(sec, 'Изменить').click();
    const modal = lastModal();
    type(byLabel(modal, 'Минимум'), 600); type(byLabel(modal, 'Норма'), 1200);
    rpcCalls.length = 0;
    findBtn(modal, 'Сохранить').click();
    await settle();
    assert.deepEqual(rpcCalls.find((c) => c.name === 'stock_minimum_set').args,
        { holder_type: 'department', holder_id: 11, product_id: 7, min_qty: 600, target_qty: 1200, unit: 'consumption' });
    assert.match(toastText(), /Подана заявка REQ-20260923-010 на 400 шт/);
    assert.ok(rpcCalls.some((c) => c.name === 'stock_minimums_list'), 'после сохранения минимумы не перечитаны');
});

test('член отдела видит минимумы только для чтения', async () => {
    const root = await openSupply({ user: MEMBER, rows: [{ ...DEPT_MIN, can_edit: false }] });
    const sec = section(root);
    assert.match(textOf(sec), /Перчатки/);
    assert.equal(findBtn(sec, 'Изменить'), undefined, 'члену отдела дали править минимум отдела');
    assert.equal(findBtn(sec, 'Добавить минимум'), undefined);
    assert.match(textOf(sec), /Минимумы отдела ставит заведующая/);
});

test('кладовщик (can_manage_all) может добавить минимум любому отделу', async () => {
    const root = await openSupply({ user: { id: 3, role: 'inventory', full_name: 'Кладовщик', department_id: null }, rows: [], canManageAll: true });
    const sec = section(root);
    assert.ok(findBtn(sec, 'Добавить минимум'));
    assert.match(textOf(sec), /Минимумов пока нет/);
});

test('отказ сервера по минимумам виден словами', async () => {
    const root = await openSupply({ fail: 'stock_minimums_list', user: MEMBER });
    FAIL_MSG = 'база недоступна';
    assert.match(textOf(section(root)), /Не удалось загрузить минимумы/);
});
