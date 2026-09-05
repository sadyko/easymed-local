// NO_TABS_APPBAR_V1 / NAV_ACTIVE_FILLED_V1 / MOTION_TOKENS_V1 / NO_GREETING_V1
// (2026-09-05, owner: «remove this shitty tabs. completely. and create patient
// button.» + docs/plans/2026-09-05-ui-redesign-and-calendar.md, задачи 1 и 3)
//
// THE SHELL, DRIVEN — not read.
//
// Almost every other test in this directory reads admin.js as TEXT, because
// admin.js is the entry script: it imports seventy view modules and calls
// boot() at module scope. That is exactly why the shell was the one part of
// this app nobody tested by USING it — and exactly where a memory leak can
// live unnoticed, since a leak is invisible in source and invisible on screen.
// So this file boots the real shell against a fake DOM and a fake transport,
// and then navigates it the way a person does.
//
// What is real here: admin.js's router, its pane cache, its sidebar renderer,
// permissions.js, i18n.js, and every view module the switch can reach. What is
// faked: the DOM, `fetch` (answers from a tiny in-memory world), and the
// clock-free bits of the browser (rAF, matchMedia).
//
// The five claims:
//   1. THE TAB STRIP IS GONE — element, painter, globals-that-painted-it, and
//      the CSS of both generations of it.
//   2. THE CACHE IS BOUNDED — walk four routes and at most VIEW_CACHE_MAX view
//      panes stay mounted; walk three and come back and none of them re-rendered
//      (the cache still does the job the tab strip was secretly doing).
//   3. THE CONTROLS SURVIVED — reload/bell/branch/lang/account are in the app
//      bar, wired, and the bar carries the section title the tabs used to.
//   4. THE ACTIVE MENU ITEM IS A FILLED BUTTON — in all three skins, with its
//      badge and lock still legible on the fill, and focus still visible.
//   5. NO GREETING SURVIVES ANYWHERE — and the two controls that were hiding
//      inside the greeting bands still exist and still work.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUB  = path.resolve(HERE, '..', '..', '..');            // …/public
const REPO = path.resolve(PUB, '..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

// ===========================================================================
// Fake DOM — same lineage as inpatient-route.test.mjs, plus the few extras the
// SHELL needs that a single view never did: parent links, id lookup anywhere
// in the tree (the shell's chrome elements are not children of <body>),
// querySelector for a handful of class selectors, and `display` on style.
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
    dispatchEvent(e) { for (const fn of this._l[e.type] || []) fn(e); return true; }
    click() { this.dispatchEvent({ type: 'click', currentTarget: this, target: this, preventDefault() {}, stopPropagation() {} }); }
    closest() { return null; }
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
    // <select> surface — registration.js reads sel.options[sel.selectedIndex]
    // to turn the chosen name back into a row id.
    get options() { return this.children.filter((c) => c.tagName === 'OPTION'); }
    get selectedIndex() {
        const o = this.options;
        const i = o.findIndex((x) => x.selected === true || x.attrs.selected !== undefined);
        return i < 0 ? (o.length ? 0 : -1) : i;
    }
}
class FakeText extends FakeNode { constructor(t) { super('#text'); this.nodeType = 3; this._text = String(t); } }

// `style` must stay a plain assignable bag (views do Object.assign(el.style,…))
// AND answer setProperty/removeProperty, which several screens use for CSS
// custom properties. Non-enumerable so Object.assign never copies them around.
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
// A deliberately small selector engine: '.cls', '#id', 'tag', and 'a.b' —
// everything the shell actually asks for.
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

// ---- The real shell markup, rebuilt from public/admin.html --------------
// Not hand-invented: the ids and classes below are asserted against the real
// file in the «app bar» test, so this harness cannot drift away from the page.
const BODY = mkEl('body');
const APP  = mkEl('div'); APP.className = 'app'; BODY.appendChild(APP);
function shellEl(tag, id, cls) { const e = mkEl(tag); if (id) e.setAttribute('id', id); if (cls) e.className = cls; return e; }
const SIDEBAR   = shellEl('nav', 'sidebar-body', 'sidebar-body');
const APPBAR    = shellEl('header', 'topbar', 'appbar');
const TITLE_EL  = shellEl('h1', 'section-title', 'appbar-title');
const CONTROLS  = shellEl('div', null, 'appbar-controls');
const RELOAD_EL = shellEl('button', 'topbar-reload', 'appbar-reload');
const BELL_EL   = shellEl('div', 'topbar-bell', 'topbar-bell');
const BRANCH_EL = shellEl('div', 'branch-picker', 'branch-picker');
const LANG_EL   = shellEl('div', 'topbar-lang', 'topbar-lang');
for (const code of ['uz', 'ru', 'en']) { const b = mkEl('button'); b.dataset.lang = code; b.setAttribute('data-lang', code); LANG_EL.appendChild(b); }
const USER_BTN  = shellEl('button', 'user-card-btn', 'user-card user-card--topbar');
const USER_POP  = shellEl('div', 'user-popover', 'user-popover'); USER_POP.hidden = true;
const VIEW_ROOT = shellEl('div', 'view-root');
// paintUserCard() writes into these three; without them boot() throws before
// it ever reaches the app shell — and a shell test that never booted is worse
// than no test at all.
const AVATAR_EL = shellEl('div', 'user-avatar', 'avatar');
const UNAME_EL  = shellEl('div', 'user-name', 'user-name');
const UROLE_EL  = shellEl('div', 'user-role', 'user-role');
USER_BTN.appendChild(AVATAR_EL); USER_BTN.appendChild(UNAME_EL); USER_BTN.appendChild(UROLE_EL);
CONTROLS.appendChild(RELOAD_EL); CONTROLS.appendChild(BELL_EL); CONTROLS.appendChild(BRANCH_EL);
CONTROLS.appendChild(LANG_EL); CONTROLS.appendChild(USER_BTN); CONTROLS.appendChild(USER_POP);
APPBAR.appendChild(TITLE_EL); APPBAR.appendChild(CONTROLS);
const MAIN = mkEl('main'); MAIN.className = 'main';
MAIN.appendChild(APPBAR); MAIN.appendChild(VIEW_ROOT);
const ASIDE = shellEl('aside', null, 'sidebar');
ASIDE.appendChild(shellEl('div', null, 'brand-sub'));
ASIDE.appendChild(SIDEBAR);
APP.appendChild(ASIDE);
APP.appendChild(MAIN);

const byId = (id) => descendants(BODY).find((n) => n.attrs.id === id) || null;
// Icon() renders through a <template>, so a button's textContent also carries
// the raw SVG markup. Read the label the way a person does: the text nodes
// that are NOT inside an <svg>.
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
    location: { hostname: 'localhost', hash: '', reload: () => { reloaded++; } },
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

// ---- Fake transport. Every screen this test opens is allowed to be EMPTY;
// what is under test is the shell around them, not their contents. ---------
const ME = { id: 'u-1', username: 'admin', full_name: 'Админ Тестов', role: 'admin', is_super_admin: true, is_active: true, company_id: 'c-1' };
globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const ok = (body) => ({ ok: true, status: 200, json: async () => body });
    if (u.startsWith('/api/auth/me')) return ok({ user: ME });
    if (u.startsWith('/api/rpc/')) return ok({ data: null });
    if (u.startsWith('/api/db')) {
        let op = 'select';
        try { op = JSON.parse(opts.body || '{}').op || 'select'; } catch (_) {}
        return ok({ data: op === 'select' ? [] : null, count: 0 });
    }
    return ok({});
};

const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));

// The shell and several screens start recurring timers (nav-count refresh,
// queue polling, sync tickers). In a browser the page eventually goes away; in
// a test runner they hold the event loop open forever. Record them and stop
// them in the last test — the alternative is --test-force-exit, which would
// also hide a real hang.
const appIntervals = new Set();
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (...a) => { const id = realSetInterval(...a); appIntervals.add(id); return id; };

// ===========================================================================
// Boot the real shell.
// ===========================================================================
await import('../../admin.js');
await settle(400);

const shell = () => globalThis.window.easymed;
const panes = () => descendants(VIEW_ROOT).filter((n) => String(n.className || '').split(/\s+/).includes('view-pane'));
const navItems = () => descendants(SIDEBAR).filter((n) => String(n.className || '').split(/\s+/).includes('nav-item'));
const navItemFor = (label) => navItems().find((n) => labelOf(n).includes(label));
async function go(view, payload) { shell().navigate(view, payload ?? null); await settle(60); }
async function perms_setFull() { (await import('../permissions.js')).setFullAccess('Admin'); }

test('оболочка поднялась и навигация живая', () => {
    assert.ok(shell(), 'window.easymed не появился — boot() не дошёл до startApp()');
    assert.equal(typeof shell().navigate, 'function');
});

// ===========================================================================
// 1. ВКЛАДОК БОЛЬШЕ НЕТ
// ===========================================================================
test('полосы вкладок нет ни в разметке, ни в коде, ни в стилях', () => {
    const html = read('public/admin.html');
    for (const dead of ['id="tab-strip"', 'ts-tabs-area', 'ts-controls']) {
        assert.ok(!html.includes(dead), 'в admin.html осталась вкладочная разметка: ' + dead);
    }

    const js = read('public/js/admin.js');
    // Не просто «элемент убрали» — убрали ВЕСЬ механизм: состояние, отрисовку,
    // закрытие, перетаскивание и вставку стилей полосы на старте.
    for (const dead of ['state.tabs', 'activeTabId', 'paintTabStrip', 'closeTab(', 'reorderTab', 'injectTabStyles', 'ts-tab', 'view-tab-root']) {
        assert.ok(!js.includes(dead), 'в admin.js остался обломок вкладок: ' + dead);
    }
    // И горячих клавиш вкладок тоже нет — Ctrl+W закрывал вкладку, закрывать
    // больше нечего, а перехваченный Ctrl+W хуже, чем неперехваченный.
    assert.ok(!/e\.key === 'w'/.test(js), 'Ctrl+W всё ещё перехватывается');

    for (const file of ['public/css/admin.css', 'public/css/admin-views.css']) {
        const css = read(file).replace(/\/\*[\s\S]*?\*\//g, '');   // текст решений — не правила
        for (const dead of ['.ts-tab', '.ts-tabs-area', '.tab-strip', '.tab-item', '.tab-close']) {
            assert.ok(!css.includes(dead), file + ': осталось правило ' + dead);
        }
    }

    // И в живом дереве.
    assert.equal(byId('tab-strip'), null);
    assert.equal(descendants(BODY).filter((n) => String(n.className).includes('view-tab-root')).length, 0);
});

// ===========================================================================
// 2. КЭШ ЭКРАНОВ — ОГРАНИЧЕН, НО РАБОТАЕТ
//
// Полоса вкладок была ещё и КЭШЕМ: каждый маршрут держал свой смонтированный
// DOM, поэтому прокрутка, фильтры и наполовину заполненные формы переживали
// уход на другой экран. Убрать полосу — не повод выбросить кэш; повод его
// ограничить, потому что закрывать вкладки больше нечем.
// ===========================================================================
test('кэш экранов ограничен: четыре маршрута — не больше трёх смонтированных', async () => {
    await go('patients'); await go('visits'); await go('queue'); await go('labs');
    assert.ok(panes().length <= 3, 'смонтировано панелей: ' + panes().length + ' — кэш не ограничен, это утечка');
    // И ровно три, а не одна: ограничение не должно выродиться в «кэша нет».
    assert.equal(panes().length, 3);
    // Видна ровно одна.
    assert.equal(panes().filter((p) => p.style.display !== 'none').length, 1);
});

test('возврат на недавний экран НЕ перерисовывает его — состояние переживает уход', async () => {
    await go('patients'); await go('visits'); await go('queue');
    const patientsPane = panes().find((p) => p.dataset.viewKey === 'patients');
    assert.ok(patientsPane, 'панель «Пациенты» выпала из кэша раньше времени');
    // Метка, которую переживёт только НЕ перерисованный узел.
    patientsPane._probe = 'состояние экрана';
    await go('patients');
    const again = panes().find((p) => p.dataset.viewKey === 'patients');
    assert.equal(again, patientsPane, 'панель пересобрали заново');
    assert.equal(again._probe, 'состояние экрана', 'экран перерисовали — прокрутка и фильтры потеряны');
    assert.notEqual(again.style.display, 'none', 'вернулись на экран, а он спрятан');
});

test('вытесненная панель размонтируется, а не прячется', async () => {
    await go('patients'); await go('visits'); await go('queue');
    const first = panes().find((p) => p.dataset.viewKey === 'patients');
    await go('labs');   // четвёртый — «Пациенты» самые старые
    assert.ok(!panes().includes(first), '«Пациенты» всё ещё в #view-root');
    assert.equal(first._parent, null, 'узел остался висеть в дереве — это и есть утечка');
    // И открывается снова как ни в чём не бывало.
    await go('patients');
    assert.ok(panes().some((p) => p.dataset.viewKey === 'patients'));
});

test('повторный клик по своему же разделу не дёргает страницу', async () => {
    // Кэш хранит прокрутку каждой панели и восстанавливает её при возврате.
    // Но «возврата» на экран, с которого никто не уходил, нет: снимок не
    // делался, значение устарело, и восстановить его — значит утащить
    // читающего человека наверх посреди списка.
    await go('patients');
    const jumps = [];
    const realScrollTo = globalThis.window.scrollTo;
    globalThis.window.scrollTo = (o) => { jumps.push(o && o.top); };
    globalThis.window.scrollY = 900;
    await go('patients');            // тот же раздел
    assert.deepEqual(jumps, [], 'страницу дёрнули при клике по уже открытому разделу');
    await go('visits');
    await go('patients');            // настоящий возврат — прокрутку помним
    assert.deepEqual(jumps, [900], 'при настоящем возврате прокрутка не восстановилась: ' + JSON.stringify(jumps));
    globalThis.window.scrollTo = realScrollTo;
    globalThis.window.scrollY = 0;
});

test('подмаршрут переживает перезагрузку', async () => {
    // Как в жизни: экран сообщает оболочке свой режим, оболочка пишет его в
    // адрес, а при следующем запуске адрес его возвращает.
    await go('labs');
    globalThis.window.easymedSetTabSub('labs', 'panels');
    shell().navigate('labs', { sub: 'panels' });
    await settle(60);
    assert.equal(globalThis.history.url, '#labs/panels', 'подмаршрут не попал в адрес — по перезагрузке он потеряется');

    // Перезагрузка: адрес и localStorage — это всё, что переживает её.
    assert.equal(globalThis.localStorage.getItem('easymed:route'), 'labs');
    const parse = (raw) => { const i = raw.indexOf('/'); return i < 0 ? { view: raw, sub: null } : { view: raw.slice(0, i), sub: raw.slice(i + 1) }; };
    assert.deepEqual(parse('labs/panels'), { view: 'labs', sub: 'panels' });
    // И оболочка ЧИТАЕТ его на старте — не просто пишет.
    const js = read('public/js/admin.js');
    assert.ok(/const hash = parseHash\(\);/.test(js) && /hash\.sub && isKnownView\(hash\.view\)/.test(js),
        'boot больше не смотрит на подмаршрут в адресе');
});

test('оба моста для экранов живы — и laboratory.js, и updates.js ими пользуются', async () => {
    assert.equal(typeof globalThis.window.easymedSetTabSub, 'function');
    assert.equal(typeof globalThis.window.easymedSetTabLabel, 'function');
    assert.ok(read('public/js/admin/views/laboratory.js').includes('window.easymedSetTabSub('),
        'laboratory.js больше не сообщает свой режим — подмаршрут перестанет работать');
    assert.ok(read('public/js/admin/views/updates.js').includes('window.easymedSetTabLabel('),
        'updates.js больше не сообщает свой заголовок');

    // easymedSetTabLabel теперь переименовывает ЗАГОЛОВОК РАЗДЕЛА.
    await go('patients');
    globalThis.window.easymedSetTabLabel('patients', 'Проверка заголовка');
    assert.equal(TITLE_EL.textContent, 'Проверка заголовка');
    await go('visits');
    // Чужой ключ не трогает активный заголовок.
    const before = TITLE_EL.textContent;
    globalThis.window.easymedSetTabLabel('patients', 'Не должно появиться');
    assert.equal(TITLE_EL.textContent, before);
    // Панель «Пациенты» кэшируется вместе с заголовком — вернём ей настоящий,
    // иначе следующий тест увидит наш зонд, а не имя раздела.
    globalThis.window.easymedSetTabLabel('patients', 'Patients');
});

// ===========================================================================
// 3. ОРГАНЫ УПРАВЛЕНИЯ ПЕРЕЕХАЛИ, А НЕ ПРОПАЛИ
// ===========================================================================
test('верхняя панель: заголовок раздела + пять органов управления', async () => {
    const html = read('public/admin.html');
    assert.ok(/id="topbar" class="appbar"/.test(html), 'в admin.html нет верхней панели');
    assert.ok(/id="section-title"/.test(html), 'нет заголовка раздела — экран потерял имя вместе с вкладкой');
    for (const id of ['topbar-reload', 'topbar-bell', 'branch-picker', 'topbar-lang', 'user-card-btn']) {
        assert.ok(html.includes('id="' + id + '"'), 'орган управления пропал из разметки: ' + id);
        assert.ok(byId(id), 'орган управления не найден в дереве: ' + id);
    }
    // Кнопка перезагрузки: раньше 38px инлайновых стилей с тремя сырыми
    // шестнадцатеричными цветами — теперь класс на токенах.
    assert.ok(!/#fbcf4a|#fde68a|#7c5a00/.test(html), 'сырые цвета кнопки перезагрузки остались в разметке');
    assert.ok(!/id="topbar-reload"[^>]*style=/.test(html), 'кнопка перезагрузки всё ещё со встроенными стилями');
    assert.ok(read('public/css/admin.css').includes('.appbar-reload'), 'класс кнопки перезагрузки не описан');

    // И они РАБОТАЮТ, а не просто присутствуют.
    const before = reloaded;
    RELOAD_EL.click();
    assert.equal(reloaded, before + 1, 'кнопка перезагрузки не перезагружает');

    USER_BTN.click();
    assert.equal(USER_POP.hidden, false, 'карточка пользователя не раскрывается');
    USER_BTN.click();
    assert.equal(USER_POP.hidden, true);

    const ru = LANG_EL.children.find((b) => b.dataset.lang === 'ru');
    assert.ok(String(ru.className).includes('on'), 'переключатель языка не отмечает текущий язык');
});

test('заголовок раздела называет экран и переводится', async () => {
    await go('patients');
    assert.equal(TITLE_EL.textContent, 'Пациенты', 'заголовок берётся из CRUMBS и переводится: ' + TITLE_EL.textContent);
    await go('labs');
    assert.equal(TITLE_EL.textContent, 'Лаборатория');

    // CRUMBS остаются несущими: isKnownView() читает их при загрузке.
    const js = read('public/js/admin.js');
    assert.ok(/const CRUMBS = \{/.test(js), 'CRUMBS удалили — маршруты перестанут узнаваться при загрузке');
    assert.ok(/isKnownView = \(v\) => !!v && \(CRUMBS\[v\]/.test(js), 'isKnownView больше не опирается на CRUMBS');
});

// ===========================================================================
// 4. АКТИВНЫЙ ПУНКТ МЕНЮ — ЗАЛИТАЯ КНОПКА
// ===========================================================================
test('кнопки «+ Новый пациент» в меню нет, а создать пациента по-прежнему можно', async () => {
    const js = read('public/js/admin.js');
    assert.ok(!js.includes('sidebar-cta'), 'класс призывной кнопки остался в меню');
    assert.ok(!js.includes("t('sidebar.newPatient'"), '«+ Новый пациент» всё ещё рисуется');
    assert.ok(!read('public/css/admin.css').replace(/\/\*[\s\S]*?\*\//g, '').includes('.sidebar-cta'),
        'правила .sidebar-cta остались в admin.css');
    assert.equal(descendants(SIDEBAR).find((n) => String(n.className).includes('sidebar-cta')), undefined);

    // ПУТЬ СОЗДАНИЯ ПАЦИЕНТА ЖИВ. Он не в меню — он в самом разделе.
    assert.ok(read('public/js/admin/views/patients.js').includes('Создать пациента'),
        'в «Пациентах» нет кнопки создания — продукт остался без способа завести пациента');
    // И сам маршрут никуда не делся: закладка и любой onNavigate его откроют.
    assert.ok(/case 'registration':\s*return void renderRegistration\(/.test(js), 'маршрут регистрации пропал');
    await go('registration');
    assert.equal(shell().state.view, 'registration');
});

test('«Публичный сайт» — обычный пункт меню на токенах, без инлайновых стилей', () => {
    const js = read('public/js/admin.js');
    assert.ok(!js.includes('color-mix(in srgb, var(--primary-600)'), 'инлайновый color-mix остался');
    const block = js.slice(js.indexOf('PUBLIC_SITE_V1 — the Symptex'), js.indexOf('let currentHeaderEl'));
    assert.ok(block.includes("class: 'nav-item'"), '«Публичный сайт» не стал обычным пунктом меню');
    assert.ok(!/style:/.test(block), 'у «Публичного сайта» остались встроенные стили');
});

test('активный пункт меню — залитая кнопка во всех трёх скинах', () => {
    const css = read('public/css/admin.css').replace(/\/\*[\s\S]*?\*\//g, '');
    const ruleFor = (sel) => {
        const i = css.indexOf(sel);
        assert.notEqual(i, -1, 'нет правила для ' + sel);
        return css.slice(i, css.indexOf('}', i));
    };
    // Основной скин.
    const base = ruleFor('.nav-item.active,');
    assert.ok(/background:\s*var\(--primary-600\)/.test(base), 'активный пункт не залит');
    assert.ok(/color:\s*#fff/.test(base), 'текст активного пункта не белый');
    assert.ok(/box-shadow:\s*var\(--shadow-xs\)/.test(base), 'нет тени — это плашка, а не кнопка');
    // Свёрнутая колонка.
    assert.ok(/background:\s*var\(--primary-600\)/.test(ruleFor('.sidebar-collapsed .nav-item.active,')),
        'на свёрнутой колонке заливки нет — скины разъехались');
    // Второй скин.
    assert.ok(/background:\s*var\(--primary-600\)/.test(ruleFor('.nav-list-top .nav-item.active,')),
        '.nav-list-top остался со старой светлой подсветкой — скины разъехались');
    // Ни один из трёх не должен возвращаться к старой светлой заливке.
    assert.ok(!/\.nav-item\.active \{\s*background: var\(--primary-50\)/.test(css));

    // Фокус с клавиатуры остаётся ВИДИМЫМ на залитом фоне: общий контур —
    // primary-600, то есть цвет самой заливки.
    const focus = ruleFor('.nav-item.active:focus-visible');
    assert.ok(/outline:\s*2px solid #fff/.test(focus), 'на залитом пункте контур фокуса сливается с фоном');
});

test('счётчик и замок остаются читаемыми на залитом пункте', () => {
    const views = read('public/css/admin-views.css').replace(/\/\*[\s\S]*?\*\//g, '');
    const badge = views.slice(views.indexOf('.sidebar-body .nav-item.active .nav-badge'));
    const rule = badge.slice(0, badge.indexOf('}'));
    assert.ok(/background:\s*#fff/.test(rule), 'счётчик остался primary-600 на primary-600 — 1:1, его не видно');
    assert.ok(/color:\s*var\(--primary-700/.test(rule));
    // NAV_BADGE_ALERT_V4 — тревожный счётчик остаётся красным и на выбранном
    // пункте, но красным ТЕКСТОМ на белой таблетке: crit-500 на бирюзовой
    // заливке давал 1.41:1 и пропадал. Числа считает
    // __tests__/contrast-badge-hatch.test.mjs, здесь — только форма правила.
    assert.ok(/\.sidebar-body \.nav-item\.active \.nav-badge\.alert \{ background: #fff; color: var\(--crit-700/.test(views));
    // Замок белеет вместе с текстом, и пункт перестаёт быть притушенным
    // (притушенный белый на бирюзовом — это уже не «серый», а нечитаемый).
    const main = read('public/css/admin.css');
    assert.ok(main.includes('.sidebar .nav-item.active .nav-lock-icon { color: #fff;'), 'замок не перекрашен');
    assert.ok(main.includes('.sidebar .nav-item.active.nav-locked { opacity: 1; }'), 'залитый пункт остался притушенным');
});

test('активный пункт действительно помечается при переходе', async () => {
    await go('patients');
    const item = navItemFor('Пациенты');
    assert.ok(item, 'в меню нет пункта «Пациенты»');
    assert.ok(String(item.className).split(/\s+/).includes('active'), 'пункт не отмечен активным');
    await go('labs');
    assert.ok(!String(navItemFor('Пациенты').className).split(/\s+/).includes('active'), 'активными остались два пункта');
});

// ===========================================================================
// 5. ЯЗЫК ДВИЖЕНИЯ
// ===========================================================================
test('движение описано токенами и полностью выключается по просьбе пользователя', () => {
    const css = read('public/css/admin.css');
    for (const tok of ['--dur-1: 80ms', '--dur-2: 140ms', '--dur-3: 220ms', '--ease-out:', '--ease-in-out:', '--ease-spring:']) {
        assert.ok(css.includes(tok), 'нет токена движения: ' + tok);
    }
    // Ни одной длительности «на глаз» в файле, который мы держим.
    const decls = css.match(/transition:[^;]+;/g) || [];
    assert.ok(decls.length > 0);
    for (const d of decls) {
        assert.ok(!/\d+m?s/.test(d.replace(/var\([^)]*\)/g, '')),
            'длительность мимо шкалы: ' + d.trim());
    }
    // Один глобальный выключатель — и он последний в файле, чтобы его никто
    // не перебил.
    const prm = css.match(/@media \(prefers-reduced-motion: reduce\)/g) || [];
    assert.equal(prm.length, 1, 'выключателей движения должно быть ровно один, найдено: ' + prm.length);
    const tail = css.slice(css.lastIndexOf('@media (prefers-reduced-motion: reduce)'));
    assert.ok(/\*, \*::before, \*::after/.test(tail), 'выключатель не глобальный — он снова про один компонент');
    assert.ok(/animation-duration: 0\.01ms !important/.test(tail));
    assert.ok(/transition-duration: 0\.01ms !important/.test(tail));
    assert.equal(css.trim().endsWith('}'), true);
    assert.ok(css.trim().slice(-400).includes('prefers-reduced-motion'), 'правило должно стоять последним в файле');
});

// ===========================================================================
// 6. ПРИВЕТСТВИЙ БОЛЬШЕ НЕТ — А ИХ ОРГАНЫ УПРАВЛЕНИЯ ОСТАЛИСЬ
// ===========================================================================
test('ни одной приветственной строки в исходниках', () => {
    const GREETINGS = ['Доброе утро', 'Добрый день', 'Добрый вечер',
        'Пациент — в центре всего', 'Каждый пациент — это история'];
    const files = [];
    (function walk(dir) {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'vendor') walk(p); }
            else if (/\.(js|css|html)$/.test(e.name)) files.push(p);
        }
    })(PUB);
    for (const f of files) {
        // Комментарии снимаем: решение «баннер убран, вот что в нём было»
        // ЦЕННО и должно остаться в коде. Ищем то, что попадёт на экран.
        const src = fs.readFileSync(f, 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/^\s*\/\/.*$/gm, '');
        for (const g of GREETINGS) {
            assert.ok(!src.includes(g), path.relative(REPO, f) + ' всё ещё здоровается: «' + g + '»');
        }
    }
    // И часов больше нет — приветственные баннеры держали два setInterval,
    // тикавших каждую секунду на каждом открытом экране.
    for (const f of ['public/js/admin/views/registrar-header.js', 'public/js/admin/views/consultation.js']) {
        assert.ok(!read(f).includes('setInterval'), f + ': часы приветствия всё ещё тикают');
    }
    // И мёртвых правил под них.
    for (const f of ['public/css/admin.css', 'public/css/admin-views.css']) {
        const css = read(f).replace(/\/\*[\s\S]*?\*\//g, '');
        for (const dead of ['.reg-greet', '.reg-now', '.reg-viewtabs', '.ws-greet']) {
            assert.ok(!css.includes(dead), f + ': осталось правило ' + dead);
        }
    }
});

test('три вкладки регистратуры пережили баннер — их наследует раздел «Пациенты»', async () => {
    const { registrarHeader } = await import('../views/registrar-header.js');
    const perms = await import('../permissions.js');
    perms.setFullAccess('Admin');
    let went = null;
    const strip = registrarHeader({ active: 'patients', onNavigate: (v) => { went = v; } });
    assert.equal(strip.className, 'reg-tabs');
    const btns = descendants(strip).filter((n) => n.tagName === 'BUTTON');
    assert.deepEqual(btns.map(labelOf), ['База пациентов', 'Календарь записи', 'Мой дашборд']);
    assert.ok(String(btns[0].className).includes('on'), 'активная вкладка не отмечена');
    assert.equal(btns[0].attrs['aria-current'], 'page');
    btns[1].click();
    assert.equal(went, 'appointments', 'вкладка «Календарь записи» больше никуда не ведёт');
    btns[0].click();
    assert.equal(went, 'appointments', 'нажатие на уже активную вкладку не должно ничего делать');
    // Оба нынешних вызывающих экрана продолжают её звать.
    assert.ok(read('public/js/admin/views/patients.js').includes('registrarHeader({ active: \'patients\''));
    assert.ok(read('public/js/admin/views/room-calendar.js').includes('registrarHeader({ active: \'appointments\''));
});

test('фильтр периода пережил баннер: рисуется в шапке раздела и ФИЛЬТРУЕТ', async () => {
    const src = read('public/js/admin/views/consultation.js');
    // Он в шапке карточки очереди, рядом с поиском и фильтром статуса.
    const head = src.slice(src.indexOf('function appointmentsView'), src.indexOf('// ---- Date-range filter'));
    assert.ok(head.includes('rangeFilter()'), 'фильтр периода не попал в шапку раздела');
    assert.ok(!head.includes('greetBanner()'), 'баннер всё ещё зовут');
    for (const label of ['Сегодня', 'Неделя', 'Месяц', 'Период']) {
        assert.ok(src.includes("label: '" + label + "'"), 'из фильтра пропал период «' + label + '»');
    }
    // И он по-прежнему УПРАВЛЯЕТ выборкой, а не просто рисуется: значения
    // кнопок — те самые, которые читает inDateRange().
    const filter = src.slice(src.indexOf('function inDateRange'));
    for (const id of ['all', 'today', 'week', 'month']) {
        assert.ok(filter.includes("state.dateRange === '" + id + "'"), 'период «' + id + '» ничего не фильтрует');
    }

    // Живьём: экран рисуется, четыре кнопки на месте, нажатие меняет выборку.
    const { renderConsultation } = await import('../views/consultation.js');
    const box = mkEl('div');
    BODY.appendChild(box);
    // DOCTOR_DASHBOARD_V1 (2026-09-05) — кабинет теперь ОТКРЫВАЕТСЯ дашбордом,
    // а рабочий список живёт по адресу '#consultation/work'. Фильтр периода
    // никуда не делся — он там же, в шапке очереди; чтобы его увидеть,
    // надо открыть ту вкладку — ровно это и делает payload.sub у оболочки.
    await renderConsultation(box, { onNavigate() {}, payload: { sub: 'work' } });
    await settle(60);
    const strip = descendants(box).find((n) => n.attrs.id === 'svc-range');
    assert.ok(strip, 'фильтр периода не отрисовался');
    const btns = strip.children.filter((b) => b.tagName === 'BUTTON');
    assert.deepEqual(btns.map(labelOf), ['Сегодня', 'Неделя', 'Месяц', 'Период']);
    const week = btns.find((b) => b.attrs['data-range'] === 'week');
    week.click();
    await settle(30);
    const after = descendants(box).find((n) => n.attrs.id === 'svc-range');
    const onNow = after.children.filter((b) => b.className === 'on').map((b) => b.attrs['data-range']);
    assert.deepEqual(onNow, ['week'], 'нажатие на «Неделя» не переключило период');
    box.remove();
});

// ===========================================================================
// 7. КАЖДЫЙ РАЗДЕЛ НАЗЫВАЕТ СЕБЯ НА ЯЗЫКЕ ПОЛЬЗОВАТЕЛЯ
//
// Перекрой поднял подпись вкладки в ЕДИНСТВЕННЫЙ <h1> экрана. Пропуск в
// словаре при этом НЕ выглядит поломкой: tr() отдаёт незнакомую строку как
// есть, поэтому русский интерфейс просто пишет заголовок по-английски, а
// t() для пропущенного русского ключа подставляет английский — и оба промаха
// читаются как работающая программа. Поэтому проверка идёт ЦИКЛОМ ПО САМИМ
// ТАБЛИЦАМ: добавили маршрут или пункт меню без перевода — тест падает, а не
// ждёт, пока кто-нибудь заметит английское слово в русском меню.
// ===========================================================================
const SHELL_SRC = read('public/js/admin.js');
const NAV_SRC = SHELL_SRC.slice(SHELL_SRC.indexOf('const NAV = ['), SHELL_SRC.indexOf('// Live nav badges'));
const NAV_IDS = [...NAV_SRC.matchAll(/\{\s*id:\s*'([^']+)',\s*label:\s*'([^']+)'/g)].map((m) => m[1]);
const NAV_SECTIONS = [...NAV_SRC.matchAll(/\{\s*section:\s*'([^']+)'/g)].map((m) => m[1]);
const CRUMBS_SRC = SHELL_SRC.slice(SHELL_SRC.indexOf('const CRUMBS = {'),
    SHELL_SRC.indexOf('// SETTINGS_SPLIT_V1 — the routes that stay open'));
const CRUMB_ROWS = [...CRUMBS_SRC.matchAll(/^\s*'?([\w:-]+)'?:\s*\[([^\]]+)\]/gm)]
    .map((m) => [m[1], m[2].split(',').map((x) => x.trim().replace(/^['"]|['"]$/g, ''))]);
const UI_LANGS = ['ru', 'uz', 'en'];

test('таблицы разделов вообще разобраны (сломанный разбор не должен пройти за чистый)', () => {
    assert.ok(NAV_IDS.length >= 15, 'из NAV разобрано пунктов: ' + NAV_IDS.length);
    assert.ok(NAV_SECTIONS.length >= 3, 'из NAV разобрано секций: ' + NAV_SECTIONS.length);
    assert.ok(CRUMB_ROWS.length >= 40, 'из CRUMBS разобрано маршрутов: ' + CRUMB_ROWS.length);
});

test('каждый лист CRUMBS переводится на все три языка — иначе <h1> будет на чужом', async () => {
    const { STRINGS } = await import('../i18n-strings.js');
    const bad = [];
    for (const [view, chain] of CRUMB_ROWS) {
        const leaf = chain[chain.length - 1];
        const e = STRINGS[leaf] || STRINGS[String(leaf).trim()];
        for (const lang of UI_LANGS) {
            if (!e || typeof e[lang] !== 'string' || e[lang].trim() === '') {
                bad.push('  ' + view + ' → ' + JSON.stringify(leaf) + ' — нет ' + lang);
            }
        }
    }
    assert.deepEqual(bad, [], 'заголовок раздела покажется на исходном языке:\n' + bad.join('\n'));
});

test('каждый пункт и каждая секция меню переводятся на все три языка', async () => {
    // hasKey(), а не t(): t() для пропущенного русского ключа молча отдаёт
    // английский, и пропуск выглядит как работающее меню.
    const { hasKey } = await import('../i18n.js');
    const bad = [];
    for (const lang of UI_LANGS) {
        for (const id of NAV_IDS) if (!hasKey('sidebar.nav.' + id, lang)) bad.push('  sidebar.nav.' + id + ' [' + lang + ']');
        for (const sec of NAV_SECTIONS) if (!hasKey('sidebar.sections.' + sec, lang)) bad.push('  sidebar.sections.' + sec + ' [' + lang + ']');
    }
    assert.deepEqual(bad, [], 'меню покажет эти строки на исходном языке:\n' + bad.join('\n'));
});

test('заголовок отчёта собирается переводом, а не склейкой', async () => {
    const { STRINGS } = await import('../i18n-strings.js');
    // 'Report · ' + label невозможно было перевести НИКАКИМ словарём: tr()
    // ищет строку целиком. Ключ — вся фраза с дыркой, подстановка — после.
    // Комментарии снимаем: запись «здесь склеивали, вот чем это было плохо»
    // обязана остаться в коде. Смотрим на то, что исполняется.
    const exec = SHELL_SRC.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join(' ');
    assert.ok(!/'Report · ' \+/.test(exec), 'заголовок отчёта снова склеивается в рантайме');
    assert.ok(/trf\('Report · \{name\}'/.test(SHELL_SRC), 'заголовок отчёта не собирается через trf');
    const e = STRINGS['Report · {name}'];
    assert.ok(e, 'ключа «Report · {name}» нет в словаре');
    for (const lang of UI_LANGS) {
        assert.ok(typeof e[lang] === 'string' && e[lang].includes('{name}'),
            'в переводе [' + lang + '] потеряна дырка {name} — значение проглотится');
    }
});

test('в заголовке экрана никогда не стоит сырой идентификатор маршрута', async () => {
    await go('visits');
    assert.equal(TITLE_EL.textContent, 'Визиты', 'журнал визитов остался с английским именем: ' + TITLE_EL.textContent);
    await go('mar-nurse');
    assert.equal(TITLE_EL.textContent, 'Задачи медсестры');
    await go('discharge');
    assert.equal(TITLE_EL.textContent, 'Выписки');
    // Маршрут, которого нет в CRUMBS: раньше сюда попадал сам идентификатор —
    // слово разработчика в единственном заголовке экрана.
    shell().navigate('no-such-route');
    await settle(60);
    assert.notEqual(TITLE_EL.textContent, 'no-such-route', 'в <h1> написан идентификатор маршрута');
    assert.ok(TITLE_EL.textContent.trim().length > 0, 'заголовок пуст');
    await go('patients');
});

// ===========================================================================
// 8. АДРЕС НАЗЫВАЕТ ТО, ЧТО НА ЭКРАНЕ
// ===========================================================================
test('вернулись в раздел — адрес показывает ОТКРЫТУЮ вкладку, а не вкладку по умолчанию', async () => {
    await go('patients');
    // Так о своей вкладке сообщает хост «Пациентов» (views/patients-hub.js).
    globalThis.window.easymedSetTabSub('patients', 'calendar');
    await go('labs');
    await go('patients');   // клик по пункту меню: у вызывающего payload пуст
    assert.equal(globalThis.history.url, '#patients/calendar',
        'на экране «Записи», а в адресе «#patients» — F5 откроет «Список», а ссылка уведёт коллегу не туда');
    assert.deepEqual(globalThis.history.state.payload, { sub: 'calendar' },
        'в историю записан чужой payload — кнопка «Назад» вернёт не ту вкладку');

    // И наоборот: если вкладку НАЗВАЛИ (глубокая ссылка, устаревший маршрут,
    // кнопка «Назад»), панель обязана на неё переключиться — иначе врал бы
    // уже экран, а не адрес.
    shell().navigate('patients', { sub: 'queue' });
    await settle(80);
    assert.equal(globalThis.history.url, '#patients/queue');
    assert.equal(shell().state.payload && shell().state.payload.sub, 'queue',
        'панель осталась на прежней вкладке, хотя открыли другую');

    globalThis.window.easymedSetTabSub('patients', null);
    await go('patients');
    assert.equal(globalThis.history.url, '#patients', 'сброс вкладки не очистил адрес');
});

// ===========================================================================
// 9. «ОЧЕРЕДЬ» ОДНА
// ===========================================================================
test('«Очередь» — вкладка «Пациентов», а не второй пункт меню; адрес #queue цел', async () => {
    await perms_setFull();
    await go('patients');
    assert.equal(navItemFor('Очередь'), undefined,
        'в меню остался второй вход в тот же экран — открытые оба держат два опроса базы каждые 10 секунд');

    // Маршрут не тронут: закладка и глубокая ссылка открывают доску.
    assert.ok(/case 'queue':\s*return void await renderQueue\(/.test(SHELL_SRC), 'маршрут #queue пропал из оболочки');
    await go('queue');
    assert.equal(shell().state.view, 'queue');
    assert.equal(globalThis.history.url, '#queue');

    // А роль, у которой есть доска и НЕТ картотеки, свой единственный вход в
    // меню сохраняет — ради неё отдельный ключ `queue` и существует.
    const perms = await import('../permissions.js');
    perms.setEffectiveFromRole({ name: 'Табло очереди', permissions: { sections: ['queue'], levels: { queue: 'viewer' } } });
    await go('queue');
    assert.ok(navItemFor('Очередь'), 'роль с одной только доской осталась без входа в неё');
    assert.equal(navItemFor('Пациенты'), undefined, 'роль подобрана неверно — картотека ей открыта');

    perms.setFullAccess('Admin');
    await go('patients');
    assert.equal(navItemFor('Очередь'), undefined, 'дубликат вернулся');
});

test('глушим таймеры экранов, чтобы прогон завершался', () => {
    for (const id of appIntervals) clearInterval(id);
    appIntervals.clear();
});
