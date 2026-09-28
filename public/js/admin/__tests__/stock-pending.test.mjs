// OWN_SHELF_ONLY_V1 (ревью F6) — ЭКРАН «НЕ СПИСАНО СО СКЛАДА».
//
// Что закреплено:
//   1. Очередь — из ответа сервера (stock_pending_list): пациент, препарат,
//      сколько, кто ввёл, когда, палата и койка; у каждой строки «Списать».
//   2. «Списать» спрашивает, ОТКУДА: склад или полка, где товар лежит; где не
//      хватает — выбрать нельзя; по умолчанию — первое место, где хватает.
//   3. «Списать» зовёт stock_pending_settle ровно с { id, source }, после —
//      экран перечитывает очередь и обновляет счёт (onChanged).
//   4. Нигде не хватает — кнопка неактивна и слова, что делать.
//   5. Отказ сервера виден словами, окно не закрывается молча.
import { test } from 'node:test';
import assert from 'node:assert';

class FakeNode {
    constructor(tag) {
        this.tagName = String(tag).toUpperCase();
        this.style = {}; this.children = []; this.attrs = {};
        this.className = ''; this._text = ''; this._l = {}; this.dataset = {};
        this.value = ''; this.parent = null;
    }
    appendChild(c) { this.children.push(c); c.parent = this; return c; }
    removeChild(c) { const i = this.children.indexOf(c); if (i > -1) this.children.splice(i, 1); return c; }
    get firstChild() { return this.children.length ? this.children[0] : null; }
    replaceChildren() { this.children.length = 0; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    removeAttribute(k) { delete this.attrs[k]; }
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); }
    addEventListener(t, fn) { (this._l[t] || (this._l[t] = [])).push(fn); }
    removeEventListener() {}
    dispatchEvent(e) { for (const fn of this._l[e.type] || []) fn(e); return true; }
    click() { this.dispatchEvent({ type: 'click', currentTarget: this, preventDefault() {}, stopPropagation() {} }); }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    remove() { if (this.parent) this.parent.removeChild(this); }
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
    easymed: { state: { user: { id: 2, role: 'inventory', full_name: 'Кладовщик' } } }, confirm: () => true };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();

const walk = (e, out = []) => { if (!e || typeof e !== 'object') return out; out.push(e); for (const c of e.children || []) walk(c, out); return out; };
const labelOf = (e) => walk(e).filter((x) => x.tagName !== 'SVG').map((x) => x._text || '').join(' ').replace(/\s+/g, ' ').trim();
const byAttr = (root, attr, val) => walk(root).filter((e) => e.attrs && Object.prototype.hasOwnProperty.call(e.attrs, attr) && (val === undefined || e.attrs[attr] === val));
const settle = () => new Promise((r) => setTimeout(r, 30));

const rpcCalls = [];
let LIST = null;
let FAIL = null;
const ANSWERS = {
    stock_pending_list: () => LIST,
    stock_pending_count: () => ({ pending: (LIST && LIST.rows.length) || 0 }),
    stock_pending_settle: (b) => { LIST = { ...LIST, rows: LIST.rows.filter((r) => r.id !== b.id) }; return { id: b.id, status: 'settled' }; },
};
globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    let body = {}; try { body = JSON.parse(opts.body || '{}'); } catch { /* not ours */ }
    if (u.startsWith('/api/rpc/')) {
        const name = decodeURIComponent(u.slice('/api/rpc/'.length));
        rpcCalls.push({ name, args: body });
        if (FAIL === name) return { ok: false, status: 400, json: async () => ({ error: { message: 'Не хватает, чтобы списать: Кеторол — нужно 2 амп, есть 1 амп.' } }), headers: { getSetCookie: () => [] } };
        return { ok: true, status: 200, json: async () => ({ data: ANSWERS[name] ? ANSWERS[name](body) : null }), headers: { getSetCookie: () => [] } };
    }
    return { ok: true, status: 200, json: async () => ({ data: [] }), headers: { getSetCookie: () => [] } };
};

const { renderPendingTab, placeLine, sourceLabel } = await import('../views/inventory-pending.js');

const ROW = {
    id: 7, status: 'pending', kind: 'dose', line_id: 40, administration_id: 9, admission_id: 3,
    product_id: 1, product_name: 'Кеторол', qty: 2, unit: 'амп', base_qty: 0.2,
    patient_name: 'Иванов Иван', mrn: 'EM-1', ward_name: 'Палата 3', bed_code: '3-1', department_name: 'Терапия',
    given_by_name: 'Медсестра Ирина', given_at: '2026-09-28T09:15:00Z',
    sources: [
        { type: 'warehouse', id: null, name: '', qty: 10, qty_shown: 100, enough: true },
        { type: 'staff', id: 12, name: 'Старшая Ольга', qty: 0.1, qty_shown: 1, enough: false },
        { type: 'department', id: 30, name: 'Терапия', qty: 0.5, qty_shown: 5, enough: true },
    ],
};

async function open(rows, { fail = null } = {}) {
    rpcCalls.length = 0; BODY.children.length = 0;
    LIST = { status: 'pending', count: rows.length, rows };
    FAIL = fail;
    const root = mkEl('div');
    const changed = [];
    await renderPendingTab(root, { onChanged: () => changed.push(1) });
    await settle();
    return { root, changed };
}

test('очередь — из ответа сервера: пациент, препарат, сколько, кто ввёл, когда, палата и койка; «Списать» у каждой строки', async () => {
    const { root } = await open([ROW, { ...ROW, id: 8, kind: 'extra', product_name: 'Шприц 5 мл', qty: 2, unit: 'шт', ward_name: '', bed_code: '' }]);
    assert.deepEqual(rpcCalls.map((c) => [c.name, c.args]), [['stock_pending_list', {}]]);
    const rows = byAttr(root, 'data-pending-row');
    assert.equal(rows.length, 2);
    const cells = walk(rows[0]).filter((e) => e.tagName === 'TD').map(labelOf);
    assert.equal(cells[0], 'Иванов Иван EM-1');
    assert.equal(cells[1], 'Кеторол');
    assert.equal(cells[2], '2 амп');
    assert.equal(cells[3], 'Медсестра Ирина');
    assert.ok(cells[4] && !/null|undefined|NaN/.test(cells[4]), cells[4]);
    assert.equal(cells[5], 'Палата 3 · койка 3-1');
    assert.equal(cells[6], 'Списать');
    assert.match(labelOf(rows[1]), /Шприц 5 мл сверх дозы/);
    assert.match(labelOf(rows[1]), /—/, 'без палаты — прочерк, а не пустота');
});

test('пустая очередь — словами', async () => {
    const { root } = await open([]);
    assert.equal(byAttr(root, 'data-pending-empty').length, 1);
    assert.match(labelOf(root), /Всё списано — ждущих доз нет\./);
});

test('«Списать»: откуда — склад или полка; где не хватает — выбрать нельзя; по умолчанию — первое, где хватает; после — очередь перечитана и счёт обновлён', async () => {
    const { root, changed } = await open([ROW]);
    byAttr(root, 'data-pending-settle', '7')[0].click();
    const modal = byAttr(BODY, 'data-pending-modal', '7')[0];
    assert.ok(modal);
    const opts = walk(modal).filter((e) => e.tagName === 'OPTION');
    assert.deepEqual(opts.map(labelOf), ['Склад — есть 100 амп', 'Старшая Ольга — есть 1 амп, не хватает', 'Терапия — есть 5 амп']);
    assert.equal(opts[1].hasAttribute('disabled'), true);
    const sel = byAttr(modal, 'data-pending-source')[0];
    assert.equal(sel.value, '0', 'по умолчанию — склад: там хватает');
    sel.value = '2';
    rpcCalls.length = 0;
    byAttr(modal, 'data-pending-go')[0].click();
    await settle();
    assert.deepEqual(rpcCalls[0], { name: 'stock_pending_settle', args: { id: 7, source: { type: 'department', id: 30 } } });
    assert.equal(rpcCalls[1].name, 'stock_pending_list', 'очередь перечитана');
    assert.equal(changed.length, 1, 'счёт на чипе и в меню обновлён');
    assert.equal(byAttr(root, 'data-pending-empty').length, 1);
    assert.ok(!BODY.children.includes(modal), 'окно закрыто');
});

test('со склада — source { type: warehouse } без id', async () => {
    const { root } = await open([ROW]);
    byAttr(root, 'data-pending-settle', '7')[0].click();
    const modal = byAttr(BODY, 'data-pending-modal', '7').pop();
    rpcCalls.length = 0;
    byAttr(modal, 'data-pending-go')[0].click();
    await settle();
    assert.deepEqual(rpcCalls[0].args, { id: 7, source: { type: 'warehouse' } });
});

test('нигде не хватает — кнопка неактивна и слова, что делать', async () => {
    const { root } = await open([{ ...ROW, sources: ROW.sources.map((s) => ({ ...s, enough: false })) }]);
    byAttr(root, 'data-pending-settle', '7')[0].click();
    const modal = byAttr(BODY, 'data-pending-modal', '7').pop();
    assert.equal(byAttr(modal, 'data-pending-go')[0].hasAttribute('disabled'), true);
    assert.match(labelOf(byAttr(modal, 'data-pending-nowhere')[0]), /Нигде не хватает/);
});

test('отказ сервера — словами, окно остаётся, кнопку можно нажать снова', async () => {
    const { root } = await open([ROW], { fail: 'stock_pending_settle' });
    byAttr(root, 'data-pending-settle', '7')[0].click();
    const modal = byAttr(BODY, 'data-pending-modal', '7').pop();
    const go = byAttr(modal, 'data-pending-go')[0];
    go.click();
    await settle();
    assert.equal(go.hasAttribute('disabled'), false);
    assert.ok(BODY.children.includes(modal));
    const toast = walk(BODY).find((e) => e.attrs && e.attrs.id === 'toast');
    assert.ok(toast && /Не хватает, чтобы списать/.test(labelOf(toast)));
});

test('placeLine и sourceLabel — без null и NaN', () => {
    assert.equal(placeLine({ ward_name: 'Палата 3', bed_code: '3-1' }), 'Палата 3 · койка 3-1');
    assert.equal(placeLine({ ward_name: '', bed_code: '3-1' }), 'койка 3-1');
    assert.equal(placeLine({}), '—');
    assert.equal(sourceLabel({ type: 'warehouse', qty_shown: 0, enough: false }, 'амп'), 'Склад — есть 0 амп, не хватает');
});

test('«Закупки»: чип «Не списано со склада» со счётом — складу и администратору; медсестре его нет, и счёт у сервера не спрашивается', async () => {
    const { renderInventory } = await import('../views/inventory.js');
    LIST = { status: 'pending', count: 2, rows: [ROW, { ...ROW, id: 8 }] };
    FAIL = null;
    rpcCalls.length = 0;
    const root = mkEl('div');
    await renderInventory(root, {});
    await settle();
    const chip = walk(root).find((e) => e.tagName === 'BUTTON' && labelOf(e).startsWith('Не списано со склада'));
    assert.ok(chip, 'чипа нет');
    assert.equal(byAttr(chip, 'data-pending-count', '2').length, 1, 'счёт на чипе: ' + labelOf(chip));
    assert.ok(rpcCalls.some((c) => c.name === 'stock_pending_count'));

    const keep = globalThis.window.easymed.state.user;
    globalThis.window.easymed.state.user = { id: 11, role: 'nurse', full_name: 'Медсестра' };
    try {
        rpcCalls.length = 0;
        const r2 = mkEl('div');
        await renderInventory(r2, {});
        await settle();
        assert.equal(walk(r2).filter((e) => e.tagName === 'BUTTON' && labelOf(e).startsWith('Не списано со склада')).length, 0);
        assert.ok(!rpcCalls.some((c) => c.name === 'stock_pending_count'), 'медсестре сервер ответил бы 403');
    } finally { globalThis.window.easymed.state.user = keep; }
});
