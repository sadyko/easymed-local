// DISK_GUARD_V1 (docs/specs/2026-10-29-3181-cabinet-print-disk-design.md, раздел 3,
// п. 2 и п. 3) — колокол и полоса администратора: «Резервная копия не сделана»,
// «Нет места для обновления», «Мало места на диске». Решения — system-logic.js
// diskNotices (disk-guard-logic.test.mjs); здесь — проводка notifications.js:
// кто спрашивает, что спрашивает, куда ведёт кнопка, язык чисел.
// Фальшивый DOM — как в lan-address-notification.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';

class F {
    constructor(t) {
        this.tagName = String(t).toUpperCase();
        this.style = {}; this.children = []; this.attrs = {};
        this.className = ''; this._text = ''; this._l = {}; this.dataset = {}; this.value = '';
    }
    appendChild(c) { this.children.push(c); if (c) c._parent = this; return c; }
    removeChild(c) { const i = this.children.indexOf(c); if (i > -1) this.children.splice(i, 1); if (c) c._parent = null; return c; }
    insertBefore(node) { this.children.unshift(node); if (node) node._parent = this; return node; }
    get firstChild() { return this.children[0] || null; }
    replaceChildren() { this.children.length = 0; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); }
    removeAttribute(k) { delete this.attrs[k]; }
    addEventListener(t, fn) { (this._l[t] || (this._l[t] = [])).push(fn); }
    removeEventListener() {}
    dispatchEvent(e) { for (const fn of this._l[e.type] || []) fn(e); return true; }
    click() { this.dispatchEvent({ type: 'click', currentTarget: this, target: this, preventDefault() {}, stopPropagation() {} }); }
    focus() {} blur() {} scrollTo() {} scrollIntoView() {}
    remove() { const p = this._parent; if (p) p.removeChild(this); }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
    set textContent(v) { this._text = String(v); this.children.length = 0; }
    get classList() { const s = this; return { contains: (c) => String(s.className).split(/\s+/).includes(c), add() {}, remove() {}, toggle() {} }; }
    get isConnected() { return true; }
}
class TX extends F { constructor(t) { super('#text'); this.nodeType = 3; this._text = String(t); } }
function mk(t) {
    const el = new F(t);
    if (el.tagName === 'TEMPLATE') {
        el.content = { firstChild: null };
        Object.defineProperty(el, 'innerHTML', { set(v) { const s = new F('svg'); s._text = String(v); el.content.firstChild = s; }, get() { return ''; } });
    } else {
        Object.defineProperty(el, 'innerHTML', { set(v) { el.children.length = 0; el._text = String(v); }, get() { return ''; } });
    }
    return el;
}
globalThis.Node = F;
const BODY = mk('body');
const BELL = mk('div'); BELL.setAttribute('id', 'topbar-bell'); BODY.appendChild(BELL);
function byId(id) {
    const stack = [...BODY.children];
    while (stack.length) {
        const n = stack.shift();
        if (n && n.attrs && n.attrs.id === id) return n;
        if (n && n.children) stack.push(...n.children);
    }
    return null;
}
globalThis.document = {
    createElement: mk, createElementNS: (_n, t) => mk(t), createTextNode: (t) => new TX(t),
    head: mk('head'), body: BODY, documentElement: mk('html'),
    addEventListener() {}, removeEventListener() {},
    getElementById: byId,
    querySelector() { return null; }, querySelectorAll() { return []; },
};
const store = new Map([['admin.lang', 'ru']]);
const fakeStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); }, removeItem: (k) => { store.delete(k); }, clear: () => store.clear() };
globalThis.localStorage = fakeStorage;
let navigated = [];
globalThis.window = {
    location: { hostname: 'localhost', hash: '' }, localStorage: fakeStorage,
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    easymed: { state: { user: null }, navigate: (v) => navigated.push(v) },
};
globalThis.location = globalThis.window.location;
globalThis.requestAnimationFrame = (fn) => fn();

const GB = 1024 ** 3;
const COMPANY = { id: 'c-1', name: 'Клиника', phone: '+998900000000', address: 'Ташкент' };
let DISK, CALLS;
globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    let body = {}; try { body = JSON.parse(opts.body || '{}'); } catch { /* не наш */ }
    const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }), headers: { getSetCookie: () => [] } });
    if (u.startsWith('/api/rpc/')) {
        const name = decodeURIComponent(u.slice('/api/rpc/'.length));
        CALLS.push([name, body]);
        if (name === 'disk_usage') return ok(DISK);
        if (name === 'inpatient_capabilities') return ok({ roles: [], can: {} });
        return ok({});
    }
    if (u.startsWith('/api/db')) return ok(body.table === 'companies' ? [COMPANY] : []);
    return ok([]);
};

const notif = await import('../notifications.js');
const { setLang } = await import('../i18n.js');
const walk = (e, out = []) => { if (!e || typeof e !== 'object') return out; out.push(e); for (const c of e.children || []) walk(c, out); return out; };
const textOf = (e) => walk(e).map((x) => x._text || '').filter((t) => !String(t).startsWith('<svg')).join(' ');
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const CLINIC = { id: 'c-1' };
const ADMIN = { id: 1, role: 'admin', extra_roles: [] };
const REGISTRAR = { id: 7, role: 'registrar', extra_roles: [] };

function reset(user) {
    DISK = {}; CALLS = []; navigated = [];
    BELL.children.length = 0;
    for (const c of [...BODY.children]) if (c !== BELL) BODY.removeChild(c);
    store.clear(); store.set('admin.lang', 'ru');
    globalThis.window.easymed.state.user = user;
    notif.stopNotificationsPolling();
}
async function render() { await notif.renderNotifications(CLINIC, { poll: false }); await settle(); }
const banners = () => { const w = byId('em-notif-banners'); return w ? walk(w).filter((e) => String(e.className).startsWith('em-nbn')) : []; };
function bellItems() {
    const btn = walk(BELL).find((e) => e.className === 'em-bell');
    if (btn) btn.click();
    const dd = byId('em-notif-dropdown');
    const items = dd ? walk(dd).filter((e) => String(e.className).startsWith('nd-item')).map(textOf) : [];
    if (dd) dd.remove();
    return items;
}
const COPY_REFUSED = { low: true, free_bytes: GB, total_bytes: 100 * GB,
    copy_refused: { at: '2026-10-29T03:05:00.000Z', kind: 'daily', need_bytes: 2 * GB, free_bytes: GB } };

test('администратор: копия не сделана — красная полоса и строка колокола с числами; кнопка ведёт на «Данные клиники»', async () => {
    reset(ADMIN);
    DISK = COPY_REFUSED;
    await render();
    assert.deepEqual(CALLS.filter((c) => c[0] === 'disk_usage'), [['disk_usage', { quick: true }]], 'колокол — без обхода папок');
    const b = banners();
    assert.equal(b.length, 1);
    assert.equal(String(b[0].className), 'em-nbn danger');
    assert.match(textOf(b[0]), /Недостаточно места на диске: нужно 2,0 ГБ, свободно 1,0 ГБ\. Копия не сделана\./);
    walk(b[0]).find((e) => e.className === 'nbn-cta').click();
    assert.deepEqual(navigated, ['clinic-data']);
    const items = bellItems();
    assert.equal(items.length, 1, '«мало места» при отказе не повторяется отдельной строкой');
    assert.match(items[0], /Резервная копия не сделана/);
});

test('обновление не поставилось из-за места, чисел нет — общая фраза; ручные копии сверх предела — только в колоколе', async () => {
    reset(ADMIN);
    DISK = { low: false, free_bytes: 300 * GB, total_bytes: 1000 * GB,
        update_refused: { version: '3.18.1', need_bytes: null, free_bytes: null },
        kept_over_cap: { bytes: 400 * GB, cap_bytes: 300 * GB } };
    await render();
    const b = banners();
    assert.equal(b.length, 1, 'полоса — только об обновлении');
    assert.match(textOf(b[0]), /Обновление 3\.18\.1 не установлено — на диске не хватило места\./);
    const items = bellItems();
    assert.equal(items.length, 2);
    assert.ok(items.some((t) => /Копии занимают много места/.test(t)));
});

test('английский экран — точка в гигабайтах, без кириллицы', async () => {
    reset(ADMIN);
    DISK = COPY_REFUSED;
    setLang('en');
    try {
        await render();
        const t = textOf(banners()[0]);
        assert.match(t, /Not enough disk space: 2\.0 GB needed, 1\.0 GB free\. The backup was not made\./);
        assert.equal(/[А-Яа-яЁё]/.test(t), false, t);
    } finally {
        setLang('ru');
    }
});

test('не администратор: место даже не спрашивается', async () => {
    reset(REGISTRAR);
    DISK = COPY_REFUSED;
    await render();
    assert.equal(CALLS.filter((c) => c[0] === 'disk_usage').length, 0);
    assert.equal(banners().length, 0);
});

test('места хватает или сервер ответил пусто — тишина', async () => {
    reset(ADMIN);
    DISK = { low: false, free_bytes: 300 * GB, total_bytes: 1000 * GB };
    await render();
    assert.equal(banners().length, 0);
    reset(ADMIN);
    DISK = null;
    await render();
    assert.equal(banners().length, 0);
});
