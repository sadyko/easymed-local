// CLINIC_API_FIX_V1 — название клиники под меню (.brand-sub) — сразу после
// входа и сразу после сохранения «Компании», без перезагрузки страницы.
//
// Что было. .brand-sub заполнял только boot(), сразу после initClinicContext().
// Но /api/rpc стоит за входом: до входа get_clinic_by_slug отвечает 401, и
// строка остаётся пустой. Вход через форму страницу не перезагружает
// (submit → onAuthed), onAuthed() достаёт клинику (ensureClinicContext), а
// строку под меню никто не перерисовывал — до F5. И после сохранения
// «Компании» с новым названием ни .brand-sub, ни window.CLINIC (его читает и
// печать: applyCompanyBranding) не менялись.
//
// Проверяется ВЖИВУЮ: настоящая оболочка admin.js поднимается на поддельном
// DOM и поддельном сервере (стенд — из app-shell.test.mjs), человек входит
// через форму, потом открывает «Компанию» и сохраняет новое название.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ===========================================================================
// Поддельный DOM — тот же, что в app-shell.test.mjs.
// ===========================================================================
class FakeNode {
    constructor(tag) {
        this.tagName = String(tag).toUpperCase();
        this.style = makeStyle(); this.children = []; this.attrs = {};
        this.className = ''; this._text = ''; this._l = {};
        this.dataset = {}; this.value = ''; this.hidden = false;
        this._parent = null;
    }
    appendChild(c) { if (c && typeof c === 'object') c._parent = this; this.children.push(c); return c; }
    append(...cs) { for (const c of cs) this.appendChild(typeof c === 'string' ? new FakeText(c) : c); }
    insertBefore(c, ref) {
        if (c && typeof c === 'object') c._parent = this;
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
    querySelector(sel) { return descendants(this).find((n) => matches(n, sel)) || null; }
    querySelectorAll(sel) { return descendants(this).filter((n) => matches(n, sel)); }
    remove() { if (this._parent) this._parent.removeChild(this); }
    focus() {} blur() {} scrollIntoView() {} select() {}
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
    get selectedIndex() {
        const o = this.options;
        const i = o.findIndex((x) => x.selected === true || x.attrs.selected !== undefined);
        return i < 0 ? (o.length ? 0 : -1) : i;
    }
}
class FakeText extends FakeNode { constructor(t) { super('#text'); this.nodeType = 3; this._text = String(t); } }
function makeStyle() {
    const st = {};
    Object.defineProperties(st, {
        setProperty:    { value(k, v) { st[k] = v; }, enumerable: false },
        removeProperty: { value(k) { delete st[k]; }, enumerable: false },
        getPropertyValue: { value(k) { return st[k] ?? ''; }, enumerable: false },
    });
    return st;
}
function descendants(root, out = []) {
    for (const c of root.children || []) { out.push(c); descendants(c, out); }
    return out;
}
function matches(node, sel) {
    if (!node || !sel) return false;
    for (const part of String(sel).trim().split(/\s+/).slice(-1)) {
        const cls = part.match(/\.[A-Za-z0-9_-]+/g) || [];
        const id  = (part.match(/#([A-Za-z0-9_-]+)/) || [])[1];
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
        Object.defineProperty(el, 'innerHTML', {
            set(v) { const s = new FakeNode('svg'); s._text = String(v); el.content.firstChild = s; },
            get() { return ''; },
        });
    }
    return el;
}
globalThis.Node = FakeNode;

// ---- Разметка оболочки — как в public/admin.html (и в app-shell.test.mjs) ----
const BODY = mkEl('body');
const APP  = mkEl('div'); APP.className = 'app'; BODY.appendChild(APP);
function shellEl(tag, id, cls) { const e = mkEl(tag); if (id) e.setAttribute('id', id); if (cls) e.className = cls; return e; }
const SIDEBAR   = shellEl('nav', 'sidebar-body', 'sidebar-body');
const APPBAR    = shellEl('header', 'topbar', 'appbar');
const BACK_EL   = shellEl('button', 'section-back', 'appbar-back'); BACK_EL.hidden = true;
const TITLE_EL  = shellEl('h1', 'section-title', 'appbar-title');
const CONTROLS  = shellEl('div', null, 'appbar-controls');
const LANG_EL   = shellEl('div', 'topbar-lang', 'topbar-lang');
for (const code of ['uz', 'ru', 'en']) { const b = mkEl('button'); b.dataset.lang = code; b.setAttribute('data-lang', code); LANG_EL.appendChild(b); }
const USER_BTN  = shellEl('button', 'user-card-btn', 'user-card user-card--topbar');
const USER_POP  = shellEl('div', 'user-popover', 'user-popover'); USER_POP.hidden = true;
const VIEW_ROOT = shellEl('div', 'view-root');
USER_BTN.appendChild(shellEl('div', 'user-avatar', 'avatar'));
USER_BTN.appendChild(shellEl('div', 'user-name', 'user-name'));
USER_BTN.appendChild(shellEl('div', 'user-role', 'user-role'));
for (const el of [shellEl('button', 'topbar-reload', 'appbar-reload'), shellEl('div', 'topbar-bell', 'topbar-bell'),
    shellEl('div', 'branch-picker', 'branch-picker'), LANG_EL, USER_BTN, USER_POP]) CONTROLS.appendChild(el);
APPBAR.appendChild(BACK_EL); APPBAR.appendChild(TITLE_EL); APPBAR.appendChild(CONTROLS);
const MAIN = mkEl('main'); MAIN.className = 'main';
MAIN.appendChild(APPBAR); MAIN.appendChild(VIEW_ROOT);
const ASIDE = shellEl('aside', null, 'sidebar');
const BRAND_SUB = shellEl('div', null, 'brand-sub');   // <div class="brand-sub"></div> — пустая, как в admin.html
ASIDE.appendChild(BRAND_SUB);
ASIDE.appendChild(SIDEBAR);
APP.appendChild(ASIDE);
APP.appendChild(MAIN);

const byId = (id) => descendants(BODY).find((n) => n.attrs.id === id) || null;
function labelOf(el) {
    let out = '';
    (function walk(n) {
        if (!n || n.tagName === 'SVG') return;
        out += n._text || '';
        for (const c of n.children || []) walk(c);
    })(el);
    return out.trim();
}

let reloaded = 0;
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
    removeItem: (k) => { lsStore.delete(k); },
    clear: () => lsStore.clear(),
};
globalThis.window = {
    location: { hostname: '192.168.1.20', hash: '', reload: () => { reloaded++; } },
    localStorage: globalThis.localStorage,
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    scrollTo() {}, scrollY: 0,
    document: globalThis.document,
};
globalThis.location = globalThis.window.location;
globalThis.history = { state: null, pushState(st, _t, url) { this.state = st; this.url = url; }, replaceState(st, _t, url) { this.state = st; this.url = url; } };
Object.defineProperty(globalThis, 'navigator', { value: { language: 'ru' }, configurable: true });
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();
globalThis.cancelAnimationFrame = () => {};

// ---- Поддельный сервер: /api/rpc и /api/auth/me — только после входа, как
// в server/app.js (requireAuth). get_clinic_by_slug — как rpc/clinic.js:
// запись клиники собирается из doc_settings. ---------------------------------
const ME = { id: 'u-1', username: 'admin', full_name: 'Админ Тестов', role: 'admin', is_super_admin: true, is_active: true, company_id: 'c-1' };
let session = false;
const docRow = {
    id: 1, clinic_name: 'Клиника «Шифо»', address: 'Ташкент', phone: '+998 71 200 12 00',
    email: 'info@shifo.uz', license: 'LIC-1', logo_data_url: null, accent_color: '#167873',
};
const clinicRow = () => ({ id: 1, slug: 'local', name: docRow.clinic_name || 'Easy-Med Local', active: true, logo_url: docRow.logo_data_url || null });
let clinicReads = 0;

globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const ok = (body) => ({ ok: true, status: 200, json: async () => body });
    const denied = { ok: false, status: 401, json: async () => ({ error: { message: 'Login required.' } }) };
    if (u.startsWith('/api/auth/login')) { session = true; return ok({ user: ME }); }
    if (u.startsWith('/api/auth/me')) return session ? ok({ user: ME }) : denied;
    if (u.startsWith('/api/rpc/')) {
        if (!session) return denied;
        if (u.startsWith('/api/rpc/get_clinic_by_slug')) { clinicReads++; return ok({ data: clinicRow() }); }
        return ok({ data: null });
    }
    if (u.startsWith('/api/db')) {
        if (!session) return denied;
        let desc = {};
        try { desc = JSON.parse(opts.body || '{}'); } catch (_) {}
        const op = desc.op || 'select';
        if (desc.table === 'doc_settings') {
            if (op === 'update') Object.assign(docRow, desc.values || {});
            return ok({ data: { ...docRow } });
        }
        return ok({ data: op === 'select' ? [] : null, count: 0 });
    }
    return ok({});
};

const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const appIntervals = new Set();
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (...a) => { const id = realSetInterval(...a); appIntervals.add(id); return id; };

// ===========================================================================
// Поднимаем настоящую оболочку: сессии нет — boot() показывает форму входа.
// ===========================================================================
await import('../../admin.js');
await settle(300);

test('до входа клинику не узнать — строка под меню пуста, открыта форма входа', () => {
    assert.ok(byId('login-overlay'), 'форма входа не показана');
    assert.equal(BRAND_SUB.textContent, '', 'до входа /api/rpc отвечает 401 — имени взяться неоткуда');
});

test('вход через форму: название клиники под меню — сразу, без перезагрузки', async () => {
    const overlay = byId('login-overlay');
    const form = descendants(overlay).find((n) => n.tagName === 'FORM');
    const [userInp, passInp] = descendants(form).filter((n) => n.tagName === 'INPUT');
    userInp.value = 'admin';
    passInp.value = 'secret';
    form.dispatchEvent({ type: 'submit', target: form, preventDefault() {}, stopPropagation() {} });
    await settle(300);

    assert.ok(globalThis.window.easymed, 'вход не дошёл до оболочки');
    assert.equal(reloaded, 0, 'страница не должна перезагружаться');
    assert.equal(globalThis.window.CLINIC && globalThis.window.CLINIC.name, 'Клиника «Шифо»');
    assert.equal(BRAND_SUB.textContent, 'Клиника «Шифо»', 'после входа под меню пусто до F5');
});

// Кнопка «Сохранить» экрана «Компания» — по подписи, как её видит человек.
const findSaveBtn = () => descendants(VIEW_ROOT).find((n) => n.tagName === 'BUTTON' && labelOf(n) === 'Сохранить') || null;
const hasIcon = (btn) => descendants(btn).some((n) => n.tagName === 'SVG');

test('сохранили «Компанию» с новым названием — под меню и в window.CLINIC новое', async () => {
    globalThis.window.easymed.navigate('documents-settings');
    await settle(200);

    const inputs = descendants(VIEW_ROOT).filter((n) => n.tagName === 'INPUT');
    const nameInp = inputs.find((n) => n.value === 'Клиника «Шифо»');
    assert.ok(nameInp, 'на экране «Компания» нет поля названия с текущим значением');
    nameInp.value = 'Шифо Плюс';
    nameInp.dispatchEvent({ type: 'input', target: nameInp, currentTarget: nameInp });

    const readsBefore = clinicReads;
    const saveBtn = findSaveBtn();
    assert.ok(saveBtn, 'нет кнопки «Сохранить»');
    assert.ok(hasIcon(saveBtn), 'у кнопки «Сохранить» нет значка');
    saveBtn.click();
    await settle(200);

    assert.equal(docRow.clinic_name, 'Шифо Плюс', 'название не ушло на сервер');
    assert.ok(clinicReads > readsBefore, 'после сохранения клиника не перечитана');
    assert.equal(globalThis.window.CLINIC.name, 'Шифо Плюс', 'window.CLINIC остался со старым названием — печать возьмёт его');
    assert.equal(BRAND_SUB.textContent, 'Шифо Плюс', 'под меню старое название до F5');
});

// CLINIC_API_FIX_V1 — после сохранения кнопка возвращается такой, какой была:
// значок и подпись «Сохранить». Раньше подпись возвращалась через textContent,
// и значок пропадал до перезагрузки экрана.
test('после сохранения «Компании» кнопка «Сохранить» — со значком, как была', () => {
    const saveBtn = findSaveBtn();
    assert.ok(saveBtn, 'после сохранения кнопки с подписью «Сохранить» нет — подпись испорчена');
    assert.ok(hasIcon(saveBtn), 'после сохранения у кнопки пропал значок');
    assert.ok(!saveBtn.hasAttribute('disabled') && !saveBtn.disabled, 'кнопка осталась заблокированной');
});

test('стёрли название в «Компании» — под меню запасное «Easy-Med Local», а не старое', async () => {
    const nameInp = descendants(VIEW_ROOT).filter((n) => n.tagName === 'INPUT').find((n) => n.value === 'Шифо Плюс');
    assert.ok(nameInp);
    nameInp.value = '';
    nameInp.dispatchEvent({ type: 'input', target: nameInp, currentTarget: nameInp });
    findSaveBtn().click();
    await settle(200);

    assert.equal(globalThis.window.CLINIC.name, 'Easy-Med Local');
    assert.equal(BRAND_SUB.textContent, 'Easy-Med Local');
});

test('глушим таймеры экранов, чтобы прогон завершался', () => {
    for (const id of appIntervals) clearInterval(id);
    appIntervals.clear();
});
