// OWN_SHELF_ONLY_V1 (ревью F5) — ЭКРАН ПЕРЕКЛЮЧАТЕЛЯ «ТОЛЬКО СО СВОИХ ПОЛОК».
//
// Что закреплено:
//   1. Положение, кто и когда менял, готовность и журнал — ИЗ ОТВЕТА СЕРВЕРА
//      (own_shelf_settings); экран ничего не считает сам.
//   2. Готовность — словами, со счётом и именами (длинный список — «и ещё N»).
//   3. Кнопка — только тому, кому сервер разрешил (can_change); остальным —
//      «Переключает только администратор.»
//   4. Включение при недостающем РАЗРЕШЕНО, но окно подтверждения перечисляет
//      недостающее; «Всё равно включить» зовёт own_shelf_set ровно с
//      { own_shelf_only: true }, и экран перечитывает настройку.
//   5. Отказ сервера виден словами, а не молчанием.
import { test } from 'node:test';
import assert from 'node:assert';

// ─── минимальный DOM (тот же стенд, что у my-stock.test.mjs) ────────────────
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
    easymed: { state: { user: { id: 1, role: 'admin', full_name: 'Админ' } } }, confirm: () => true };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();

const walk = (e, out = []) => { if (!e || typeof e !== 'object') return out; out.push(e); for (const c of e.children || []) walk(c, out); return out; };
const labelOf = (e) => walk(e).filter((x) => x.tagName !== 'SVG').map((x) => x._text || '').join(' ').replace(/\s+/g, ' ').trim();
const byAttr = (root, attr, val) => walk(root).filter((e) => e.attrs && Object.prototype.hasOwnProperty.call(e.attrs, attr) && (val === undefined || e.attrs[attr] === val));
const settle = () => new Promise((r) => setTimeout(r, 30));

// ─── «сервер» ───────────────────────────────────────────────────────────────
const rpcCalls = [];
let SETTINGS = null;
let FAIL = null;   // имя RPC, который отвечает отказом
const ANSWERS = {
    own_shelf_settings: () => SETTINGS,
    own_shelf_set: (b) => { SETTINGS = { ...SETTINGS, own_shelf_only: b.own_shelf_only }; return { own_shelf_only: b.own_shelf_only, changed: true, missing: 3 }; },
};
globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    let body = {}; try { body = JSON.parse(opts.body || '{}'); } catch { /* not ours */ }
    if (u.startsWith('/api/rpc/')) {
        const name = decodeURIComponent(u.slice('/api/rpc/'.length));
        rpcCalls.push({ name, args: body });
        if (FAIL === name) return { ok: false, status: 403, json: async () => ({ error: { message: 'Переключатель «Только со своих полок» меняет только администратор.' } }), headers: { getSetCookie: () => [] } };
        return { ok: true, status: 200, json: async () => ({ data: ANSWERS[name] ? ANSWERS[name](body) : null }), headers: { getSetCookie: () => [] } };
    }
    return { ok: true, status: 200, json: async () => ({ data: [] }), headers: { getSetCookie: () => [] } };
};

const { renderOwnShelfTab, namesLine, READINESS_LABELS } = await import('../views/inventory-own-shelf.js');

const MANY = Array.from({ length: 15 }, (_, i) => `Медсестра ${i + 1}`);
const READINESS = {
    clinical_staff: 20, staff_with_stock: 5,
    items: [
        { key: 'staff_without_place', names: ['Медсестра Без Места'], count: 1 },
        { key: 'wards_without_department', names: [], count: 0 },
        { key: 'rooms_without_department', names: ['УЗИ'], count: 1 },
        { key: 'departments_empty', names: [], count: 0 },
        { key: 'staff_with_nothing', names: MANY, count: 15 },
    ],
    missing: 17,
};
const settingsOff = (over = {}) => ({
    own_shelf_only: false, changed_at: null, changed_by_name: null, can_change: true,
    readiness: READINESS, log: [], ...over,
});

async function open(settings, { fail = null } = {}) {
    rpcCalls.length = 0; BODY.children.length = 0;
    SETTINGS = settings; FAIL = fail;
    const root = mkEl('div');
    await renderOwnShelfTab(root);
    await settle();
    return root;
}

test('положение, готовность и журнал — из ответа сервера; готовность — словами, со счётом и именами', async () => {
    const root = await open(settingsOff({
        changed_at: '2026-09-28T10:00:00Z', changed_by_name: 'Админ',
        log: [{ own_shelf_only: false, changed_at: '2026-09-28T10:00:00Z', changed_by_name: 'Админ', missing: 0 },
              { own_shelf_only: true, changed_at: '2026-09-27T10:00:00Z', changed_by_name: 'Админ', missing: 17 }],
    }));
    assert.deepEqual(rpcCalls.map((c) => c.name), ['own_shelf_settings']);
    const sw = byAttr(root, 'data-own-shelf-switch')[0];
    assert.equal(sw.attrs['data-own-shelf-switch'], 'off');
    assert.match(labelOf(sw), /Только со своих полок Выключено/);
    assert.match(labelOf(sw), /добирает склад, как раньше/);
    assert.match(labelOf(sw), /Остаток склада врачу и медсестре не показывается при любом положении переключателя\./);
    assert.match(labelOf(byAttr(root, 'data-own-shelf-changed')[0]), /^Изменил: Админ, /);
    assert.equal(labelOf(byAttr(root, 'data-readiness-summary')[0]), 'Врачей и медсестёр: 20; что-то есть на своих полках у 5.');
    const items = byAttr(root, 'data-readiness-item');
    assert.deepEqual(items.map((i) => i.attrs['data-readiness-item']), ['staff_without_place', 'rooms_without_department', 'staff_with_nothing'],
        'пустые пункты не показываются');
    assert.match(labelOf(items[0]), /Врачи и медсёстры без кабинета и отдела 1 Медсестра Без Места/);
    assert.match(labelOf(items[2]), /Медсестра 12 и ещё 3$/, 'длинный список — «и ещё N»');
    const log = byAttr(root, 'data-own-shelf-log');
    assert.equal(log.length, 2);
    assert.match(labelOf(log[1]), /Админ включил недоставало: 17/);
});

test('кнопка — только тому, кому сервер разрешил; складу — «Переключает только администратор.»', async () => {
    const admin = await open(settingsOff());
    assert.equal(byAttr(admin, 'data-own-shelf-toggle', 'on').length, 1);
    const inv = await open(settingsOff({ can_change: false }));
    assert.equal(byAttr(inv, 'data-own-shelf-toggle').length, 0);
    assert.match(labelOf(inv), /Переключает только администратор\./);
    const on = await open(settingsOff({ own_shelf_only: true }));
    assert.equal(byAttr(on, 'data-own-shelf-toggle', 'off').length, 1, 'включено — кнопка «Выключить»');
    assert.match(labelOf(byAttr(on, 'data-own-shelf-switch', 'on')[0]), /Включено/);
});

test('включение при недостающем: окно перечисляет недостающее, «Всё равно включить» — own_shelf_set { true }, экран перечитывает', async () => {
    const root = await open(settingsOff());
    byAttr(root, 'data-own-shelf-toggle', 'on')[0].click();
    const modal = byAttr(BODY, 'data-own-shelf-confirm', 'on')[0];
    assert.ok(modal, 'окно подтверждения открылось');
    const missing = byAttr(modal, 'data-confirm-missing');
    assert.deepEqual(missing.map((m) => m.attrs['data-confirm-missing']), ['staff_without_place', 'rooms_without_department', 'staff_with_nothing']);
    assert.match(labelOf(missing[2]), /^Врачи и медсёстры, у которых на своих полках пусто: 15 /);
    const go = byAttr(modal, 'data-own-shelf-confirm-go')[0];
    assert.equal(labelOf(go), 'Всё равно включить');
    rpcCalls.length = 0;
    go.click();
    await settle();
    assert.deepEqual(rpcCalls.map((c) => [c.name, c.args]), [['own_shelf_set', { own_shelf_only: true }], ['own_shelf_settings', {}]]);
    assert.equal(byAttr(root, 'data-own-shelf-switch', 'on').length, 1, 'экран перечитал — включено');
});

test('всё готово: включение без списка, кнопка — «Включить»; выключение — своё окно', async () => {
    const ready = { clinical_staff: 3, staff_with_stock: 3, items: Object.keys(READINESS_LABELS).map((key) => ({ key, names: [], count: 0 })), missing: 0 };
    const root = await open(settingsOff({ readiness: ready }));
    assert.equal(byAttr(root, 'data-readiness-ready').length, 1);
    byAttr(root, 'data-own-shelf-toggle', 'on')[0].click();
    const modal = byAttr(BODY, 'data-own-shelf-confirm', 'on').pop();
    assert.equal(byAttr(modal, 'data-confirm-missing').length, 0);
    assert.equal(labelOf(byAttr(modal, 'data-own-shelf-confirm-go')[0]), 'Включить');

    BODY.children.length = 0;
    const on = await open(settingsOff({ own_shelf_only: true, readiness: ready }));
    byAttr(on, 'data-own-shelf-toggle', 'off')[0].click();
    const off = byAttr(BODY, 'data-own-shelf-confirm', 'off')[0];
    assert.match(labelOf(off), /склад снова будет добирать/);
    rpcCalls.length = 0;
    byAttr(off, 'data-own-shelf-confirm-go')[0].click();
    await settle();
    assert.deepEqual(rpcCalls[0], { name: 'own_shelf_set', args: { own_shelf_only: false } });
});

test('отказ сервера виден словами: окно остаётся, кнопка снова нажимается', async () => {
    const root = await open(settingsOff());
    byAttr(root, 'data-own-shelf-toggle', 'on')[0].click();
    const modal = byAttr(BODY, 'data-own-shelf-confirm', 'on').pop();
    FAIL = 'own_shelf_set';
    const go = byAttr(modal, 'data-own-shelf-confirm-go')[0];
    go.click();
    await settle();
    assert.equal(go.hasAttribute('disabled'), false, 'после отказа кнопку можно нажать снова');
    assert.ok(BODY.children.includes(modal), 'окно не закрылось молча');
    const toast = walk(BODY).find((e) => e.attrs && e.attrs.id === 'toast');
    assert.ok(toast && /меняет только администратор/.test(labelOf(toast)), 'слова сервера на плашке');
});

test('настройку не загрузить — слова, а не пустой экран', async () => {
    const root = await open(null, { fail: 'own_shelf_settings' });
    assert.match(labelOf(byAttr(root, 'data-own-shelf-error')[0]), /меняет только администратор/);
});

test('namesLine: до двенадцати — все, дальше — «и ещё N»', () => {
    assert.equal(namesLine(['А', 'Б']), 'А, Б');
    assert.equal(namesLine(MANY), MANY.slice(0, 12).join(', ') + ' и ещё 3');
    assert.equal(namesLine(null), '');
});
