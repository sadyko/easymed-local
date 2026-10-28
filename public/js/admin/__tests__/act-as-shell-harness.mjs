// ADMIN_ACT_AS_V1 (2026-10-28) — СТЕНД НАСТОЯЩЕЙ ОБОЛОЧКИ ДЛЯ ВХОДА ОТ ИМЕНИ.
//
// Та же линия, что __tests__/app-shell.test.mjs: настоящий admin.js на
// поддельном DOM с разметкой public/admin.html и поддельным сервером. Здесь —
// одна функция bootShell(), чтобы три сценария (вход от имени, обычный вход,
// /me после авто-конца) поднимали оболочку одинаково: admin.js поднимается
// один раз на процесс, поэтому каждый сценарий — свой файл проверки.
//
// Как в браузере: fetch страницы — это window.fetch. Поэтому глобальный fetch
// здесь зовёт window.fetch в момент вызова, и обёртка admin.js над
// window.fetch (installActAsEndedGuard) видит все запросы — db, rpc, прямые.
class FakeNode {
    constructor(tag) {
        this.tagName = String(tag).toUpperCase();
        this.style = makeStyle(); this.children = []; this.attrs = {};
        this.className = ''; this._text = ''; this._l = {};
        this.dataset = {}; this.value = ''; this.hidden = false;
        this._parent = null;
    }
    appendChild(c) { if (c && typeof c === 'object') { if (c._parent) c._parent.removeChild(c); c._parent = this; } this.children.push(c); return c; }
    append(...cs) { for (const c of cs) this.appendChild(typeof c === 'string' ? new FakeText(c) : c); }
    insertBefore(c, ref) {
        if (c && typeof c === 'object') { if (c._parent) c._parent.removeChild(c); c._parent = this; }
        const i = ref ? this.children.indexOf(ref) : -1;
        if (i < 0) this.children.push(c); else this.children.splice(i, 0, c);
        return c;
    }
    removeChild(c) { const i = this.children.indexOf(c); if (i > -1) { this.children.splice(i, 1); c._parent = null; } return c; }
    get firstChild() { return this.children[0] || null; }
    replaceChildren() { this.children.length = 0; }
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = String(v); }
    getAttribute(k) { return this.attrs[k] ?? null; }
    hasAttribute(k) { return k in this.attrs; }
    removeAttribute(k) { delete this.attrs[k]; }
    addEventListener(t, fn) { (this._l[t] || (this._l[t] = [])).push(fn); }
    removeEventListener() {}
    dispatchEvent(e) {
        for (const fn of this._l[e.type] || []) fn(e);
        const prop = this['on' + e.type];
        if (typeof prop === 'function') prop.call(this, e);
        return true;
    }
    click() { this.dispatchEvent({ type: 'click', currentTarget: this, target: this, preventDefault() {}, stopPropagation() {} }); }
    closest() { return null; }
    contains(n) { for (let x = n; x; x = x._parent) if (x === this) return true; return false; }
    querySelector(sel) { return descendants(this).find((n) => matches(n, sel)) || null; }
    querySelectorAll(sel) { return descendants(this).filter((n) => matches(n, sel)); }
    remove() { if (this._parent) this._parent.removeChild(this); }
    focus() {} blur() {} scrollIntoView() {}
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
    set textContent(v) { this._text = String(v); this.children.length = 0; }
    get classList() {
        const s = this;
        const list = () => String(s.className || '').split(/\s+/).filter(Boolean);
        return {
            contains: (c) => list().includes(c),
            add: (c) => { if (!list().includes(c)) s.className = list().concat(c).join(' '); },
            remove: (c) => { s.className = list().filter((x) => x !== c).join(' '); },
            toggle: (c, on) => { const has = list().includes(c); const want = on === undefined ? !has : !!on; s.className = (want ? list().concat(has ? [] : [c]) : list().filter((x) => x !== c)).join(' '); },
        };
    }
    get isConnected() { return true; }
    get options() { return this.children.filter((c) => c.tagName === 'OPTION'); }
    get selectedIndex() { return this.options.length ? 0 : -1; }
}
class FakeText extends FakeNode { constructor(t) { super('#text'); this.nodeType = 3; this._text = String(t); } }
function makeStyle() {
    const st = {};
    Object.defineProperties(st, {
        setProperty: { value(k, v) { st[k] = v; }, enumerable: false },
        removeProperty: { value(k) { delete st[k]; }, enumerable: false },
        getPropertyValue: { value(k) { return st[k] ?? ''; }, enumerable: false },
    });
    return st;
}
export function descendants(root, out = []) {
    for (const c of root.children || []) { out.push(c); descendants(c, out); }
    return out;
}
function matches(node, sel) {
    if (!node || !sel) return false;
    for (const part of String(sel).trim().split(/\s+/).slice(-1)) {
        const cls = part.match(/\.[A-Za-z0-9_-]+/g) || [];
        const id = (part.match(/#([A-Za-z0-9_-]+)/) || [])[1];
        const tag = (part.match(/^[A-Za-z][A-Za-z0-9]*/) || [])[0];
        const have = String(node.className || '').split(/\s+/);
        if (tag && node.tagName !== tag.toUpperCase()) return false;
        if (id && node.attrs.id !== id) return false;
        for (const c of cls) if (!have.includes(c.slice(1))) return false;
        return true;
    }
    return false;
}
function mkEl(tag) {
    const el = new FakeNode(tag);
    if (el.tagName === 'TEMPLATE') {
        el.content = { firstChild: null };
        Object.defineProperty(el, 'innerHTML', { set(v) { const s = new FakeNode('svg'); el.content.firstChild = s; }, get() { return ''; } });
    }
    return el;
}

/** Текст элемента так, как его читает человек: без разметки значков. */
export function labelOf(el) {
    let out = '';
    (function walk(n) {
        if (!n || n.tagName === 'SVG') return;
        out += n._text || '';
        for (const c of n.children || []) walk(c);
    })(el);
    return out.trim();
}

export const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));

/**
 * Поднять настоящий admin.js. meBody — ответ /api/auth/me. Возвращает стенд:
 * BODY, APP, USER_POP, CALLS (все запросы), ALERTS, reloads(), server(fn) —
 * подменить ответы rpc/db, byId.
 */
export async function bootShell({ meBody }) {
    globalThis.Node = FakeNode;
    const BODY = mkEl('body');
    const APP = mkEl('div'); APP.className = 'app'; BODY.appendChild(APP);
    const shellEl = (tag, id, cls) => { const e = mkEl(tag); if (id) e.setAttribute('id', id); if (cls) e.className = cls; return e; };
    const SIDEBAR = shellEl('nav', 'sidebar-body', 'sidebar-body');
    const APPBAR = shellEl('header', 'topbar', 'appbar');
    const BACK_EL = shellEl('button', 'section-back', 'appbar-back'); BACK_EL.hidden = true;
    const TITLE_EL = shellEl('h1', 'section-title', 'appbar-title');
    const CONTROLS = shellEl('div', null, 'appbar-controls');
    const LANG_EL = shellEl('div', 'topbar-lang', 'topbar-lang');
    for (const code of ['uz', 'ru', 'en']) { const b = mkEl('button'); b.dataset.lang = code; b.setAttribute('data-lang', code); LANG_EL.appendChild(b); }
    const USER_BTN = shellEl('button', 'user-card-btn', 'user-card user-card--topbar');
    const USER_POP = shellEl('div', 'user-popover', 'user-popover'); USER_POP.hidden = true;
    const VIEW_ROOT = shellEl('div', 'view-root');
    USER_BTN.appendChild(shellEl('div', 'user-avatar', 'avatar'));
    USER_BTN.appendChild(shellEl('div', 'user-name', 'user-name'));
    USER_BTN.appendChild(shellEl('div', 'user-role', 'user-role'));
    for (const el of [shellEl('button', 'topbar-reload', 'appbar-reload'), shellEl('div', 'topbar-bell', 'topbar-bell'), shellEl('div', 'branch-picker', 'branch-picker'), LANG_EL, USER_BTN, USER_POP]) CONTROLS.appendChild(el);
    APPBAR.appendChild(BACK_EL); APPBAR.appendChild(TITLE_EL); APPBAR.appendChild(CONTROLS);
    const MAIN = mkEl('main'); MAIN.className = 'main';
    MAIN.appendChild(APPBAR); MAIN.appendChild(VIEW_ROOT);
    const ASIDE = shellEl('aside', null, 'sidebar');
    ASIDE.appendChild(shellEl('div', null, 'brand-sub'));
    ASIDE.appendChild(SIDEBAR);
    APP.appendChild(ASIDE); APP.appendChild(MAIN);
    const byId = (id) => descendants(BODY).find((n) => n.attrs.id === id) || null;

    globalThis.document = {
        createElement: mkEl, createElementNS: (_n, t) => mkEl(t), createTextNode: (t) => new FakeText(t),
        head: mkEl('head'), body: BODY, documentElement: mkEl('html'), title: 'Easy-Med',
        addEventListener() {}, removeEventListener() {},
        getElementById: byId,
        querySelector: (sel) => (matches(APP, sel) ? APP : descendants(BODY).find((n) => matches(n, sel)) || null),
        querySelectorAll: (sel) => descendants(BODY).filter((n) => matches(n, sel)),
        get activeElement() { return null; },
    };
    const lsStore = new Map([['admin.lang', 'ru']]);
    globalThis.localStorage = {
        getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null),
        setItem: (k, v) => { lsStore.set(k, String(v)); },
        removeItem: (k) => { lsStore.delete(k); }, clear: () => lsStore.clear(),
    };
    let reloaded = 0;
    const ALERTS = [];
    const CALLS = [];
    let server = () => null;
    const reply = (status, body) => {
        const make = () => ({ ok: status >= 200 && status < 300, status, json: async () => JSON.parse(JSON.stringify(body)), clone: () => make() });
        return make();
    };
    // Ревью-2 (вкладки) — заголовки запроса (номер вкладки X-Em-Act-As) и /me,
    // который может ответить по-разному на первый и следующие вызовы (meBody — функция номера вызова).
    const headersOf = (hs) => {
        const out = {};
        if (!hs) return out;
        if (typeof hs.forEach === 'function' && !Array.isArray(hs)) hs.forEach((v, k) => { out[String(k).toLowerCase()] = String(v); });
        else for (const [k, v] of (Array.isArray(hs) ? hs : Object.entries(hs))) out[String(k).toLowerCase()] = String(v);
        return out;
    };
    let meCalls = 0;
    const transport = async (url, opts = {}) => {
        const u = String(url);
        let body = null;
        try { body = opts.body && typeof opts.body === 'string' ? JSON.parse(opts.body) : null; } catch (_) { body = null; }
        CALLS.push({ url: u, method: opts.method || 'GET', body, headers: headersOf(opts.headers) });
        const custom = server({ url: u, method: opts.method || 'GET', body });
        if (custom) return reply(custom.status, custom.body);
        if (u.startsWith('/api/auth/me')) return reply(200, typeof meBody === 'function' ? meBody(meCalls++) : meBody);
        if (u.startsWith('/api/auth/act-as')) return reply(200, { ok: true });
        if (u.startsWith('/api/rpc/')) return reply(200, { data: null });
        if (u.startsWith('/api/db')) return reply(200, { data: body && body.op && body.op !== 'select' ? null : [], count: 0 });
        return reply(200, {});
    };
    globalThis.window = {
        location: { hostname: 'localhost', hash: '', reload: () => { reloaded++; } },
        localStorage: globalThis.localStorage,
        addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
        matchMedia: () => ({ matches: false, addEventListener() {} }),
        scrollTo() {}, scrollY: 0,
        document: globalThis.document,
        alert: (m) => { ALERTS.push(String(m)); },
        confirm: () => true,
        fetch: transport,
    };
    // Как в браузере: fetch страницы — window.fetch (в браузере это один объект).
    globalThis.fetch = (...a) => globalThis.window.fetch(...a);
    globalThis.location = globalThis.window.location;
    globalThis.history = { state: null, pushState(st, _t, url) { this.state = st; this.url = url; }, replaceState(st, _t, url) { this.state = st; this.url = url; } };
    Object.defineProperty(globalThis, 'navigator', { value: { language: 'ru' }, configurable: true, writable: true });
    globalThis.MutationObserver = class { observe() {} disconnect() {} };
    globalThis.requestAnimationFrame = (fn) => fn();
    globalThis.cancelAnimationFrame = () => {};
    globalThis.CustomEvent = class { constructor(type, o) { this.type = type; this.detail = o && o.detail; } };

    // Таймеры оболочки держали бы процесс вечно — запоминаем и гасим в конце.
    const intervals = new Set();
    const realSetInterval = globalThis.setInterval;
    globalThis.setInterval = (...a) => { const id = realSetInterval(...a); intervals.add(id); return id; };

    await import('../../admin.js');
    await settle(400);
    return {
        BODY, APP, USER_POP, byId, CALLS, ALERTS,
        reloads: () => reloaded,
        server: (fn) => { server = fn || (() => null); },
        stopTimers: () => { for (const id of intervals) clearInterval(id); intervals.clear(); },
    };
}
