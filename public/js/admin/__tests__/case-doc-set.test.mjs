// CASE_DOC_SET_V2 — экран «Состав истории болезни».
//
// Владелец (2026-09-08): «this list is hardcoded and the system asks for
// filling them, we need to make not hardcoded, and able to add a title
// document ... but we shoud give basic templates list + option».
//
// Проверяется то, ради чего экран и сделан: базовый список виден, «+» заводит
// свой документ, порядок меняется, документ убирается из набора и возвращается,
// а выписной эпикриз убрать нечем.
import test from 'node:test';
import assert from 'node:assert/strict';

class FakeNode {
    constructor(tag) {
        this.tagName = String(tag).toUpperCase();
        this.style = {}; this.children = []; this.attrs = {};
        this.className = ''; this._text = ''; this._l = {}; this.dataset = {};
        this.value = ''; this._html = ''; this.disabled = false; this.checked = false;
    }
    appendChild(c) { this.children.push(c); if (c && typeof c === 'object') c._parent = this; return c; }
    removeChild(c) { const i = this.children.indexOf(c); if (i > -1) this.children.splice(i, 1); return c; }
    get firstChild() { return this.children.length ? this.children[0] : null; }
    replaceChildren() { this.children.length = 0; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); }
    addEventListener(t, fn) { (this._l[t] || (this._l[t] = [])).push(fn); }
    removeEventListener() {}
    dispatchEvent(e) { for (const fn of this._l[e.type] || []) fn(Object.assign({ currentTarget: this, target: this, preventDefault() {}, stopPropagation() {} }, e)); return true; }
    click() { this.dispatchEvent({ type: 'click' }); }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    closest() { return null; }
    remove() { if (this._parent) this._parent.removeChild(this); }
    focus() {} blur() {}
    get innerHTML() { return this._html; }
    set innerHTML(v) { this._html = String(v); }
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
    execCommand() { return false; },
};
globalThis.window = { location: { hostname: 'localhost' }, localStorage: { getItem: () => null, setItem() {} }, addEventListener() {}, CLINIC: {} };
globalThis.localStorage = { getItem: (k) => (k === 'admin.lang' ? 'ru' : null), setItem() {}, removeItem() {}, clear() {} };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();

const walk = (e, out = []) => { if (!e || typeof e !== 'object') return out; out.push(e); for (const c of e.children || []) walk(c, out); return out; };
const textOf = (e) => walk(e).map((x) => x._text || '').join(' ');
const settle = () => new Promise((r) => setTimeout(r, 30));

// ─── «сервер» ───────────────────────────────────────────────────────────────
let TYPES = [];
const RESET = () => {
    TYPES = [
        { kind: 'intake', title: '', due_rule: 'clock', due_hours: 2, block: '', sort_order: 10, builtin: true, active: true, locked: false, used: 0 },
        { kind: 'primary', title: '', due_rule: 'clock', due_hours: 24, block: '', sort_order: 20, builtin: true, active: true, locked: false, used: 3 },
        { kind: 'discharge', title: '', due_rule: 'at_discharge', due_hours: null, block: '', sort_order: 30, builtin: true, active: true, locked: true, used: 0 },
    ];
};
let calls = [];
globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    let body = {}; try { body = JSON.parse(opts.body || '{}'); } catch { /* not ours */ }
    const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }), headers: { getSetCookie: () => [] } });
    if (u.startsWith('/api/rpc/')) {
        const name = u.slice('/api/rpc/'.length);
        calls.push({ name, args: body });
        if (name === 'case_doc_types_list') return ok({ types: TYPES, due_rules: ['clock', 'period', 'surgical', 'at_discharge', 'none'] });
        if (name === 'case_doc_type_save') {
            if (!body.kind) {
                TYPES = TYPES.concat([{ kind: 'own_9', title: body.title, due_rule: body.due_rule, due_hours: body.due_hours,
                    block: body.block || '', sort_order: 40, builtin: false, active: true, locked: false, used: 0 }]);
            }
            return ok({ type: TYPES[TYPES.length - 1] });
        }
        if (name === 'case_doc_type_set_active') {
            TYPES = TYPES.map((t) => (t.kind === body.kind ? Object.assign({}, t, { active: !!body.active }) : t));
            return ok({ type: TYPES.find((t) => t.kind === body.kind) });
        }
        if (name === 'case_doc_types_reorder') {
            const order = body.kinds;
            TYPES = order.map((k) => TYPES.find((t) => t.kind === k)).filter(Boolean);
            return ok({ types: TYPES });
        }
        return ok(null);
    }
    return ok(null);
};

const mod = await import('../views/case-doc-set.js');
const btns = (root) => walk(root).filter((e) => e.tagName === 'BUTTON');
const named = (root, label) => btns(root).filter((b) => (b.getAttribute('aria-label') || textOf(b) || '').includes(label));

// ===========================================================================
test('CASE_DOC_SET_V2: базовый список виден сразу, встроенные помечены, срок сказан словами', async () => {
    RESET(); calls = [];
    const panel = mod.caseDocSetPanel();
    await settle();
    const t = textOf(panel);
    assert.ok(t.includes('Состав истории болезни'), 'у панели нет имени');
    assert.ok(t.includes('Осмотр приёмного врача'), 'встроенный документ не назван словарём: ' + t.slice(0, 200));
    assert.ok(t.includes('встроенный'), 'встроенные не помечены');
    assert.ok(t.includes('2 ч от поступления'), 'срок не сказан словами');
    assert.ok(t.includes('При выписке'), 'правило «при выписке» не сказано словами');
    assert.ok(t.includes('записей: 3'), 'не сказано, сколько записей уже написано этим родом');
    assert.ok(calls.some((c) => c.name === 'case_doc_types_list'), 'состав не запрошен у сервера');
});

test('CASE_DOC_SET_V2: «+» заводит свой документ — имя, правило срока и часы уходят на сервер', async () => {
    RESET(); calls = [];
    const panel = mod.caseDocSetPanel();
    await settle();
    const add = named(panel, 'Добавить документ')[0];
    assert.ok(add && String(add.className).includes('btn-primary'), '«добавить» — главное действие панели');
    add.click();
    await settle();

    const modal = BODY.children.filter((c) => String(c.className || '').includes('modal')).pop();
    assert.ok(modal, 'окно нового документа не открылось');
    const title = walk(modal).find((e) => e.tagName === 'INPUT' && e.attrs.type === 'text');
    const rule = walk(modal).find((e) => e.tagName === 'SELECT');
    const hours = walk(modal).find((e) => e.tagName === 'INPUT' && e.attrs.type === 'number');
    assert.ok(title && rule && hours, 'в окне нет имени, правила или часов');
    title.value = 'Лист анестезиолога';
    rule.value = 'surgical';
    rule.dispatchEvent({ type: 'change' });
    hours.value = '12';
    const save = btns(modal).find((b) => textOf(b).includes('Добавить'));
    save.click();
    await settle();

    const sent = calls.filter((c) => c.name === 'case_doc_type_save').pop();
    assert.ok(sent, 'документ не ушёл на сервер');
    assert.equal(sent.args.title, 'Лист анестезиолога');
    assert.equal(sent.args.due_rule, 'surgical');
    assert.equal(sent.args.due_hours, 12);
    assert.ok(!sent.args.kind, 'у нового документа рода быть не может — его выдаёт сервер');
    assert.ok(textOf(panel).includes('Лист анестезиолога'), 'новый документ не появился в списке');
});

test('CASE_DOC_SET_V2: документ убирается из набора и возвращается; выписной эпикриз заперт', async () => {
    RESET(); calls = [];
    const panel = mod.caseDocSetPanel();
    await settle();

    named(panel, 'Убрать из набора: Первичный осмотр и план лечения')[0].click();
    await settle();
    const off = calls.filter((c) => c.name === 'case_doc_type_set_active').pop();
    assert.equal(off.args.active, false);
    assert.ok(textOf(panel).includes('Убрано из набора: 1'), 'не сказано, что документ убран, и что записи остались');

    named(panel, 'Вернуть в набор: Первичный осмотр и план лечения')[0].click();
    await settle();
    assert.equal(calls.filter((c) => c.name === 'case_doc_type_set_active').pop().args.active, true);

    // Выписной эпикриз убрать нечем: у него замок вместо кнопки.
    assert.equal(named(panel, 'Убрать из набора: Выписной эпикриз').length, 0,
        'у выписного эпикриза появилась кнопка «убрать» — гейт выписки сломается молча');
    assert.ok(walk(panel).some((e) => String(e.className || '').includes('cds-lock')), 'замка у запертого документа нет');
});

test('CASE_DOC_SET_V2: порядок меняется стрелками и уходит на сервер целиком', async () => {
    RESET(); calls = [];
    const panel = mod.caseDocSetPanel();
    await settle();
    named(panel, 'Ниже: Осмотр приёмного врача')[0].click();
    await settle();
    const sent = calls.filter((c) => c.name === 'case_doc_types_reorder').pop();
    assert.ok(sent, 'порядок не ушёл на сервер');
    assert.deepEqual(sent.args.kinds, ['primary', 'intake', 'discharge'], 'порядок ушёл не целиком или не тот');

    // У первой строки «выше» неактивна, у последней — «ниже».
    const up = named(panel, 'Выше: Первичный осмотр и план лечения')[0];
    assert.ok(up.hasAttribute('disabled'), 'первую строку некуда поднимать');
});
