// ACCOMMODATION_AS_SERVICE_V1 — карточка обязана обновлять ВЕСЬ экран.
//
// «Внести в счёт» создаёт СТРОКУ в «Услугах»: меняется соседний список и итог
// по счёту, а не только эта карточка. Раньше кнопка перерисовывала себя одну,
// и до F5 карточка говорила «в счёте 250 000», а список услуг был пуст — это
// читается как потерянные деньги.

import { test } from 'node:test';
import assert from 'node:assert';

class FakeNode {
    constructor(tag) {
        this.tagName = String(tag).toUpperCase();
        this.style = {}; this.children = []; this.attrs = {};
        this.className = ''; this._text = ''; this._l = {}; this.dataset = {};
    }
    appendChild(c) { this.children.push(c); return c; }
    removeChild(c) { const i = this.children.indexOf(c); if (i > -1) this.children.splice(i, 1); return c; }
    get firstChild() { return this.children.length ? this.children[0] : null; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); }
    addEventListener(t, fn) { (this._l[t] || (this._l[t] = [])).push(fn); }
    removeEventListener() {}
    click() { for (const fn of this._l.click || []) fn({ currentTarget: this, preventDefault() {}, stopPropagation() {} }); }
    querySelector() { return null; }
    remove() {}
    get textContent() { return this._text; }
    set textContent(v) { this._text = String(v); this.children.length = 0; }
    get classList() { const s = this; return { contains: (c) => String(s.className).split(/\s+/).includes(c), add() {}, remove() {}, toggle() {} }; }
    get isConnected() { return true; }
}
class FakeText extends FakeNode { constructor(t) { super('#text'); this.nodeType = 3; this._text = String(t); } }
function mkEl(tag) {
    const el = new FakeNode(tag);
    if (el.tagName === 'TEMPLATE') {
        el.content = { firstChild: null };
        Object.defineProperty(el, 'innerHTML', { set(v) { const s = new FakeNode('svg'); s._text = String(v); el.content.firstChild = s; }, get() { return ''; } });
    }
    return el;
}
globalThis.Node = FakeNode;
globalThis.document = {
    createElement: mkEl, createElementNS: (_n, t) => mkEl(t), createTextNode: (t) => new FakeText(t),
    head: mkEl('head'), body: mkEl('body'), documentElement: mkEl('html'),
    addEventListener() {}, removeEventListener() {}, getElementById() { return null; },
};
globalThis.window = { location: { hostname: 'localhost' }, localStorage: { getItem: () => null, setItem() {} } };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.confirm = () => true;

let billed = null;
globalThis.fetch = async (url, opts = {}) => {
    const name = String(url).split('/api/rpc/')[1] || '';
    let body = {}; try { body = JSON.parse(opts.body || '{}'); } catch { /* not ours */ }
    if (name === 'bill_accommodation') { billed = body; return ok({ line: { total: 250000 } }); }
    if (name === 'unbill_accommodation') return ok({ removed: true });
    if (name === 'accommodation_state') {
        return ok({ current: { net: 250000, units: 1, rate: 250000 }, billed: billed ? { total: 250000, invoiced: false } : null, stale: false });
    }
    return ok(null);
    function ok(data) { return { ok: true, json: async () => ({ data }), headers: { getSetCookie: () => [] } }; }
};

const wb = await import('../views/ward-beds.js');

const ADM = { id: 7, admitted_at: '2026-08-18T14:31:00Z', accommodation_discount_percent: 0 };
const EST = { rate: 250000, units: 1, net: 250000, gross: 250000, unitLabel: 'day', mode: 'daily' };
const walk = (e, out = []) => { if (!e || typeof e !== 'object') return out; out.push(e); for (const c of e.children || []) walk(c, out); return out; };
const textOf = (e) => walk(e).map((x) => x._text || '').join(' ');
const findBtn = (root, label) => walk(root).find((e) => e.tagName === 'BUTTON' && textOf(e).includes(label));

test('«Внести в счёт» перезагружает консоль, а не только карточку', async () => {
    billed = null;
    let reloads = 0;
    const box = wb.__test_accommodationBox(ADM, EST, async () => { reloads++; });
    await new Promise((r) => setTimeout(r, 20));

    const btn = findBtn(box, 'Внести в счёт');
    assert.ok(btn, 'кнопка должна быть, пока проживание не внесено');
    btn.click();
    await new Promise((r) => setTimeout(r, 40));

    assert.deepStrictEqual(billed, { admission_id: 7 }, 'проживание внесено');
    assert.ok(reloads >= 1, 'консоль обязана перечитать строки — иначе услуга появится только после F5');
});

test('«Убрать» тоже перезагружает консоль', async () => {
    billed = { admission_id: 7 };   // уже внесено
    let reloads = 0;
    const box = wb.__test_accommodationBox(ADM, EST, async () => { reloads++; });
    await new Promise((r) => setTimeout(r, 20));

    const btn = findBtn(box, 'Убрать');
    assert.ok(btn, 'кнопка «Убрать» должна быть у внесённого проживания');
    btn.click();
    await new Promise((r) => setTimeout(r, 40));
    assert.ok(reloads >= 1, 'список услуг должен обновиться');
});

// Карточка не должна падать, если её позвали без колбэка (другой экран).
test('без onChanged карточка всё равно работает', async () => {
    billed = null;
    const box = wb.__test_accommodationBox(ADM, EST);
    await new Promise((r) => setTimeout(r, 20));
    const btn = findBtn(box, 'Внести в счёт');
    btn.click();
    await new Promise((r) => setTimeout(r, 40));
    assert.deepStrictEqual(billed, { admission_id: 7 });
});
