// LAN_ADDRESS_V1 — баннер и колокол администратора «Адрес сервера изменился».
//
// Владелец: когда роутер выдал серверу новый адрес, администратор должен увидеть
// ясное предупреждение «было → стало» и дорогу к инструкции; скрыть его можно до
// СЛЕДУЮЩЕЙ смены. Скрытие хранит сервер (lan_address_dismiss — файл этого ПК),
// поэтому и колокол, и баннер гаснут у всех администраторов сразу.
// Фальшивый DOM — как в inpatient-notifications.test.mjs.
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
const winListeners = {};
let navigated = [];
globalThis.window = {
    location: { hostname: 'localhost', hash: '' }, localStorage: fakeStorage,
    addEventListener(t, fn) { (winListeners[t] || (winListeners[t] = [])).push(fn); },
    removeEventListener() {}, dispatchEvent(e) { for (const fn of winListeners[e.type] || []) fn(e); return true; },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    easymed: { state: { user: null }, navigate: (v) => navigated.push(v) },
};
globalThis.location = globalThis.window.location;
globalThis.CustomEvent = class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } };
globalThis.requestAnimationFrame = (fn) => fn();

const COMPANY = { id: 'c-1', name: 'Клиника', phone: '+998900000000', address: 'Ташкент' };
const CHANGE = { from: ['192.168.1.147'], to: ['192.168.1.156'], at: '2026-10-16T08:00:00.000Z' };
let LAN, CALLS, LAN_FAIL;
globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    let body = {}; try { body = JSON.parse(opts.body || '{}'); } catch { /* не наш */ }
    const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }), headers: { getSetCookie: () => [] } });
    if (u.startsWith('/api/rpc/')) {
        const name = decodeURIComponent(u.slice('/api/rpc/'.length));
        CALLS.push([name, body]);
        if (name === 'lan_address_status') {
            if (LAN_FAIL) return { ok: false, status: 500, json: async () => ({ error: { message: 'Ошибка сервера. Повторите позже.' } }), headers: { getSetCookie: () => [] } };
            return ok({ change: LAN, addresses: [], can_manage: true });
        }
        if (name === 'lan_address_dismiss') { if (LAN && LAN.at === body.at) LAN = null; return ok({ change: LAN }); }
        if (name === 'inpatient_capabilities') return ok({ roles: [], can: {} });
        return ok({});
    }
    if (u.startsWith('/api/db')) return ok(body.table === 'companies' ? [COMPANY] : []);
    return ok([]);
};

const notif = await import('../notifications.js');
const walk = (e, out = []) => { if (!e || typeof e !== 'object') return out; out.push(e); for (const c of e.children || []) walk(c, out); return out; };
const textOf = (e) => walk(e).map((x) => x._text || '').filter((t) => !String(t).startsWith('<svg')).join(' ');
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const CLINIC = { id: 'c-1' };
const ADMIN = { id: 1, role: 'admin', extra_roles: [] };
const DOCTOR_ADMIN = { id: 3, role: 'doctor', extra_roles: ['admin'] };
const REGISTRAR = { id: 7, role: 'registrar', extra_roles: [] };

function reset(user) {
    LAN = { ...CHANGE }; CALLS = []; LAN_FAIL = false; navigated = [];
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

test('администратор: баннер «было → стало» поперёк экрана и строка в колоколе; кнопка ведёт на «Адрес в сети»', async () => {
    reset(ADMIN);
    await render();
    const b = banners();
    assert.equal(b.length, 1);
    const t = textOf(b[0]);
    assert.match(t, /Адрес сервера изменился: было 192\.168\.1\.147, стало 192\.168\.1\.156\./);
    assert.match(t, /Другие компьютеры и анализаторы могут не находить сервер\. Закрепите адрес в роутере\./);
    assert.equal(String(b[0].className), 'em-nbn warn');
    const cta = walk(b[0]).find((e) => e.className === 'nbn-cta');
    assert.equal(textOf(cta).trim(), 'Как это сделать');
    cta.click();
    assert.deepEqual(navigated, ['lan-address']);
    assert.equal(bellItems().filter((x) => x.includes('Адрес сервера изменился')).length, 1);
});

test('крестик скрывает до следующей смены — на сервере, с at этой смены; колокол тоже гаснет', async () => {
    reset(ADMIN);
    await render();
    walk(banners()[0]).find((e) => e.className === 'nbn-x').click();
    await settle(60);
    assert.deepEqual(CALLS.filter((c) => c[0] === 'lan_address_dismiss'), [['lan_address_dismiss', { at: CHANGE.at }]]);
    assert.equal(banners().length, 0);
    assert.equal(bellItems().filter((x) => x.includes('Адрес сервера')).length, 0, 'перерисовка после скрытия: и в колоколе нет');
    // Следующая смена — снова видно, хотя прошлую скрыли.
    LAN = { from: ['192.168.1.156'], to: ['192.168.1.145'], at: '2026-10-17T08:00:00.000Z' };
    await render();
    assert.match(textOf(banners()[0]), /было 192\.168\.1\.156, стало 192\.168\.1\.145/);
});

test('экран «Адрес в сети» скрыл смену — баннер перерисовывается сразу, без ожидания минуты', async () => {
    reset(ADMIN);
    await render();
    assert.equal(banners().length, 1);
    LAN = null;   // скрыли на экране (сервер уже ответил)
    globalThis.window.dispatchEvent(new CustomEvent('em:lan-address'));
    await settle(60);
    assert.equal(banners().length, 0);
});

test('администратор с основной ролью врача — тоже видит', async () => {
    reset(DOCTOR_ADMIN);
    await render();
    assert.equal(banners().length, 1);
});

test('не администратор: статус адреса даже не спрашивается, предупреждения нет', async () => {
    reset(REGISTRAR);
    await render();
    assert.equal(CALLS.filter((c) => c[0] === 'lan_address_status').length, 0);
    assert.equal(banners().length, 0);
});

test('смены нет или сервер не ответил — тихо: ни баннера, ни ошибки', async () => {
    reset(ADMIN);
    LAN = null;
    await render();
    assert.equal(banners().length, 0);
    reset(ADMIN);
    LAN_FAIL = true;
    await render();
    assert.equal(banners().length, 0);
});

test('узбекский и английский — без кириллицы', async () => {
    for (const lang of ['uz', 'en']) {
        reset(ADMIN);
        const { setLang } = await import('../i18n.js');
        setLang(lang);
        await render();
        assert.equal(banners().length, 1, lang + ": баннер есть");
        const t = textOf(banners()[0]);
        assert.equal(/[А-Яа-яЁё]/.test(t), false, lang + ': ' + t);
        setLang('ru');
    }
});
