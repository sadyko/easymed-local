// ONE_NAME_PER_SCREEN_V1 (2026-09-05, владелец: «каждый экран пишет своё
// название два раза»)
//
// ЧТО СЛОМАЛОСЬ. f1ba56e убрал полосу вкладок и отдал имя экрана верхней
// панели (<h1 id="section-title">). Но имя экрана до этого рисовали и САМИ
// экраны — своим `.page-head > h1.page-title` (ui.js PageHead и полсотни
// руками собранных копий той же разметки). Ни один из ~50 экранов об этом не
// узнал, и продукт целиком стал называть себя дважды: «CRM · Murojaatlar» в
// панели и «CRM · Murojaatlar» строкой ниже, «Statsionar bo'lim» над
// «Statsionar».
//
// ПРАВИЛО, КОТОРОЕ ЭТОТ ФАЙЛ СТЕРЕЖЁТ:
//   1. ИМЯ ЭКРАНА — ОДНО, И ОНО В ВЕРХНЕЙ ПАНЕЛИ. Внутри экрана заголовка
//      раздела нет НИ НА ОДНОМ маршруте.
//   2. ИМЯ ЕСТЬ ВСЕГДА. Пустая верхняя панель хуже дубля.
//   3. РАЗДЕЛ ЗОВЁТСЯ ТАК, КАК ЕГО ЗОВЁТ МЕНЮ. Щёлкнул «Стационар» — попал на
//      «Стационар», а не на «Стационарное отделение».
//   4. СНЯТ ЗАГОЛОВОК, А НЕ ШАПКА. Подзаголовок и кнопки действий стоят там
//      же, где стояли.
//   5. ДУБЛЬ НЕ ВОЗВРАЩАЕТСЯ ПОСЛЕ ПЕРЕРИСОВКИ. Экраны перерисовывают себя
//      сами и приносят шапку заново.
//   6. НОВЫЙ ЭКРАН НЕ МОЖЕТ ВЕРНУТЬ ДУБЛЬ. Обход идёт по НАСТОЯЩИМ таблицам
//      NAV/CRUMBS оболочки и по НАСТОЯЩИМ исходникам экранов, а не по копии
//      списка: копия разошлась бы с ними ровно в тот день, когда добавят
//      новый раздел, — то есть когда тест и нужен.
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
// Живые наблюдатели за DOM — объявлены ДО FakeNode: appendChild зовёт
// _notifyMutation с первой же строки, которая строит разметку оболочки.
const _observers = new Set();

class FakeNode {
    constructor(tag) {
        this.tagName = String(tag).toUpperCase();
        this.style = makeStyle(); this.children = []; this.attrs = {};
        this.className = ''; this._text = ''; this._l = {};
        this.dataset = {}; this.value = ''; this.hidden = false;
        this._parent = null;
    }
    appendChild(c) { if (c && typeof c === 'object') c._parent = this; this.children.push(c); _notifyMutation(this); return c; }
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
// НАСТОЯЩИЙ MutationObserver, а не заглушка. Дубль заголовка возвращается не
// на первой отрисовке, а на ПЕРЕРИСОВКЕ («Обновить», фильтр, приход данных),
// и ловит его в оболочке именно наблюдатель. С заглушкой этот файл утверждал
// бы то, чего не проверяет.
function _within(node, root) { for (let n = node; n; n = n._parent) if (n === root) return true; return false; }
function _notifyMutation(target) {
    for (const o of _observers) if (o.root && _within(target, o.root)) o.schedule();
}
globalThis.MutationObserver = class {
    constructor(cb) { this.cb = cb; this.root = null; this.queued = false; }
    observe(root) { this.root = root; _observers.add(this); }
    disconnect() { this.root = null; _observers.delete(this); }
    schedule() {
        if (this.queued) return;
        this.queued = true;
        queueMicrotask(() => { this.queued = false; try { this.cb([], this); } catch (e) { /* как в браузере — сбой наблюдателя не роняет страницу */ } });
    }
};
globalThis.requestAnimationFrame = (fn) => fn();
globalThis.cancelAnimationFrame = () => {};

// ---- Fake transport. Every screen this test opens is allowed to be EMPTY;
// what is under test is the shell around them, not their contents. ---------
const OBJECT_RPCS = new Set(['documents_feed']);
const ME = { id: 'u-1', username: 'admin', full_name: 'Админ Тестов', role: 'admin', is_super_admin: true, is_active: true, company_id: 'c-1' };
globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const ok = (body) => ({ ok: true, status: 200, json: async () => body });
    if (u.startsWith('/api/auth/me')) return ok({ user: ME });
    if (u.startsWith('/api/rpc/')) {
        // Несколько RPC по контракту возвращают ОБЪЕКТ, и экран читает его
        // поля сразу же (лента документов: res.rows / res.total / res.has_more).
        // `null` для них — не пустой мир, а сломанный сервер: экран падает в
        // догрузке БЕЗ await, и её отказ повисает, обрывая обход маршрутов не
        // своей ошибкой.
        const name = u.slice('/api/rpc/'.length).split('?')[0];
        return ok({ data: OBJECT_RPCS.has(name) ? {} : null });
    }
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

// ===========================================================================
// Все маршруты, которые вообще есть у оболочки, — из её же таблиц.
// ===========================================================================
const NAV_TABLE    = () => shell().NAV;
const CRUMBS_TABLE = () => shell().CRUMBS;
const routeIds = () => {
    const ids = new Set();
    for (const item of NAV_TABLE()) if (item && item.id) ids.add(item.id);
    for (const k of Object.keys(CRUMBS_TABLE())) ids.add(k);
    // Маршруты, которым нужен payload, ходят отдельным тестом ниже: без
    // пациента карта пациента — не экран.
    ids.delete('patient-card');
    ids.delete('service-workspace');
    return [...ids];
};
const hasClass = (n, c) => String((n && n.className) || '').split(/\s+/).includes(c);
const activePane = () => panes().find((p) => p.style.display !== 'none');
const titlesIn = (el) => descendants(el).filter((n) => n.tagName === 'H1' && String(n.className || '').split(/\s+/).includes('page-title'));

test('маршрут с payload назван ПАЦИЕНТОМ, и тоже один раз', async () => {
    await perms_setFull();
    await go('patient-card', { id: 1, label: 'Иванов Иван' });
    assert.equal(TITLE_EL.textContent, 'Иванов Иван', 'карта пациента обязана называться именем пациента');
    const pane = activePane();
    assert.deepEqual(titlesIn(pane).map((n) => n.textContent), [], 'карта пациента назвала себя дважды');
});

test('раздел зовётся так же, как пункт меню, — во всех трёх языках', async () => {
    // ТОТ ЖЕ экземпляр словаря, что у оболочки. admin.js импортирует
    // './admin/i18n.js?v=pathway1' — со строкой запроса это ОТДЕЛЬНЫЙ модуль
    // ESM, со своим текущим языком: переключив язык в копии без '?v=', тест
    // сравнивал бы узбекское меню с русской панелью и «находил» бы
    // расхождение, которого нет.
    const i18n = await import('../i18n.js?v=pathway1');
    const sectionTitleFor = shell().sectionTitleFor;
    const was = i18n.getLang();
    const bad = [];
    for (const lang of ['ru', 'uz', 'en']) {
        i18n.setLang(lang);
        await settle(40);   // переключение языка перерисовывает панели
        for (const item of NAV_TABLE()) {
            if (!item || !item.id) continue;
            // «Кабинет врача» подписывается именем приёма, а не раздела
            // (payload), и своё исключение в sectionTitleFor заслужил отдельно.
            if (item.id === 'consultation') continue;
            const menu = i18n.tr(i18n.t('sidebar.nav.' + item.id));
            const bar  = i18n.tr(sectionTitleFor(item.id, null));
            if (menu !== bar) bad.push('[' + lang + '] ' + item.id + ': меню «' + menu + '» != панель «' + bar + '»');
        }
    }
    i18n.setLang(was);
    await settle(40);
    assert.deepEqual(bad, [], 'человек щёлкает одно имя, а попадает на другое:\n  ' + bad.join('\n  '));
});

test('снят ЗАГОЛОВОК, а не шапка: подзаголовок и кнопки экрана остались на месте', async () => {
    await perms_setFull();
    await go('admissions');
    const pane = activePane();
    const text = descendants(pane).map((n) => n._text || '').join(' ');
    assert.equal(TITLE_EL.textContent, 'Стационар', 'верхняя панель обязана называть раздел так же, как меню');
    assert.deepEqual(titlesIn(pane).map((n) => n.textContent), [], '«Стационар» напечатан второй раз внутри экрана');
    assert.ok(text.includes('Заявки на госпитализацию, размещение на койках'), 'вместе с заголовком исчез подзаголовок');
    const btns = descendants(pane).filter((n) => n.tagName === 'BUTTON').map((n) => labelOf(n));
    assert.ok(btns.some((b) => b.includes('Заявка на госпитализацию')), 'кнопка действия уехала вместе с заголовком');
    assert.ok(btns.some((b) => b.includes('Обновить')), 'кнопка «Обновить» уехала вместе с заголовком');

    // И ОСТАЛИСЬ ТАМ, ГДЕ ИХ ЖДУТ — справа. `.page-head` разложен как
    // `justify-content: space-between`; убери оболочка опустевшую левую
    // коробку от заголовка, и единственным ребёнком остались бы кнопки, а
    // space-between прижал бы их ВЛЕВО, через весь экран.
    const head = descendants(pane).find((n) => hasClass(n, 'page-head'));
    assert.ok(head, 'шапку экрана снесли целиком вместе с подзаголовком и кнопками');
    const headKids = (head.children || []).filter((c) => c && c.nodeType !== 3);
    assert.ok(headKids.length >= 2,
        'в шапке остался один ребёнок: кнопки уедут влево — снимали заголовок, а сломали органы управления');
    assert.ok(descendants(head).some((n) => n.tagName === 'BUTTON' && labelOf(n).includes('Обновить')),
        'кнопки выпали из шапки');
});

test('дубль не возвращается, когда экран перерисовывает себя сам', async () => {
    await perms_setFull();
    await go('admissions');
    const pane = activePane();
    // Так экран перерисовывается в жизни: человек нажимает «Обновить».
    const refresh = descendants(pane).filter((n) => n.tagName === 'BUTTON').find((n) => labelOf(n).includes('Обновить'));
    assert.ok(refresh, 'на экране нет кнопки «Обновить» — перерисовку нечем вызвать');
    refresh.click();
    await settle(120);
    assert.deepEqual(titlesIn(activePane()).map((n) => n.textContent), [],
        'после перерисовки экран снова написал своё имя: наблюдатель за #view-root не работает');
    assert.equal(TITLE_EL.textContent, 'Стационар');
});

// РАЗБОР ШАПКИ ПООТДЕЛЬНОСТИ. Экраны продукта почти все носят подзаголовок,
// поэтому левая коробка у них не пустеет — и на них не видно, правильно ли
// оболочка обходится с шапкой, где кроме заголовка ничего нет. Эти два случая
// и решают, съедут ли кнопки: собираем их руками и прогоняем через ту же
// самую функцию оболочки, что работает на живых экранах.
const mkEl2 = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
};
const wrap = (cls, ...kids) => { const d = mkEl2('div', cls); for (const k of kids) d.appendChild(k); return d; };
const elemKids = (el) => (el.children || []).filter((c) => c && c.nodeType !== 3);

test('шапка «заголовок + кнопки»: заголовок снят, кнопки НЕ съехали влево', () => {
    const actions = wrap('page-head-actions', mkEl2('button', 'btn', 'Добавить'));
    const head = wrap('page-head', wrap(null, mkEl2('h1', 'page-title', 'Услуги')), actions);
    const root = wrap(null, head);

    shell().dedupeHeadings({ key: '__probe__', view: '__probe__', root });

    assert.equal(titlesIn(root).length, 0, 'заголовок не снят');
    assert.equal(elemKids(root).length, 1, 'шапку с кнопками снесли целиком');
    assert.equal(elemKids(head).length, 2,
        'опустевшую коробку от заголовка убрали: у .page-head раскладка space-between, и кнопки уедут влево');
    assert.ok(elemKids(head).includes(actions), 'кнопки выпали из шапки');
});

test('шапка «один заголовок»: уходит целиком, пустой полосы не остаётся', () => {
    const head = wrap('page-head', wrap(null, mkEl2('h1', 'page-title', 'Филиалы')));
    const root = wrap(null, head, mkEl2('div', 'card', 'содержимое'));

    shell().dedupeHeadings({ key: '__probe2__', view: '__probe2__', root });

    assert.equal(titlesIn(root).length, 0, 'заголовок не снят');
    assert.equal(elemKids(root).length, 1, 'от шапки осталась пустая полоса с отступом в 18 пикселей');
    assert.equal(elemKids(root)[0].className, 'card');
});

test('оболочка смотрит за #view-root, а не только за первой отрисовкой', () => {
    const js = read('public/js/admin.js');
    assert.ok(/new MutationObserver\(/.test(js) && /observe\(viewRoot, \{ childList: true, subtree: true \}\)/.test(js),
        'один проход после первой отрисовки ловит только первый дубль');
    assert.ok(/finally \{\s*dedupeSectionHeading\(pane\);/.test(js),
        'дубль обязан сниматься и у экрана, упавшего на полпути');
});

// ===========================================================================
// НОВЫЙ ЭКРАН НЕ МОЖЕТ ВЕРНУТЬ ДУБЛЬ.
//
// Оболочка снимает ровно `h1.page-title`. Значит правило живо ровно до тех
// пор, пока все экраны пишут заголовок раздела именно так — и через общий
// PageHead, и в руками собранных шапках. Обход идёт по ИСХОДНИКАМ всех
// экранов: напиши завтра кто-нибудь `h2` с другим классом — оболочка его не
// увидит, а этот тест увидит.
// ===========================================================================
const VIEWS_DIR = path.join(REPO, 'public/js/admin/views');
const viewFiles = () => fs.readdirSync(VIEWS_DIR).filter((f) => f.endsWith('.js') && !f.includes('.test.'));

test('общий PageHead по-прежнему рисует ровно h1.page-title', () => {
    const ui = read('public/js/admin/ui.js');
    assert.ok(/h\('h1', \{ class: 'page-title' \}, tr\(title\)\)/.test(ui),
        'PageHead сменил разметку заголовка — оболочка перестанет его находить, и дубль вернётся на 36 экранов сразу');
});

test('ОБХОД ИСХОДНИКОВ: каждая шапка экрана пишет заголовок как h1.page-title', () => {
    const bad = [];
    for (const f of viewFiles()) {
        const src = fs.readFileSync(path.join(VIEWS_DIR, f), 'utf8');
        const code = src.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
        if (!/page-head/.test(code)) continue;
        for (const m of code.matchAll(/h\('(h[1-6])',\s*\{[^}]*class:\s*'([^']*)'/g)) {
            const tag = m[1];
            const classes = m[2].split(/\s+/);
            if (classes.includes('page-title') && tag !== 'h1') bad.push(f + ': page-title на <' + tag + '>');
            if (tag === 'h1' && !classes.includes('page-title')) bad.push(f + ': <h1 class="' + m[2] + '"> — оболочка его не снимет');
        }
        if (/innerHTML\s*=\s*[`'"][^`'"]*<h1/.test(code)) bad.push(f + ': <h1> собран строкой мимо h()');
    }
    assert.deepEqual(bad, [], 'эти шапки оболочка не снимет — их экраны назовут себя дважды:\n  ' + bad.join('\n  '));
});

test('ОБХОД ВСЕХ МАРШРУТОВ: ни один экран не называет себя дважды, и у каждого есть имя', async () => {
    await perms_setFull();
    const doubled = [];
    const nameless = [];
    const hollow = [];
    for (const view of routeIds()) {
        // Экран, упавший на пустом ответе фальшивого транспорта, — не тема
        // этого файла: заголовок с него всё равно обязан быть снят (оболочка
        // снимает его в `finally`), и мы его тут же и проверяем.
        try { await go(view); } catch (e) { await settle(40); }
        const pane = activePane();
        if (!pane) continue;
        // Шапка, где кроме снятого заголовка ничего не было, обязана уйти
        // целиком: пустая полоса с отступом в 18 пикселей — тоже след.
        for (const head of descendants(pane).filter((n) => hasClass(n, 'page-head'))) {
            const alive = String(head.textContent || '').trim()
                || descendants(head).some((n) => ['BUTTON', 'INPUT', 'SELECT', 'A'].includes(n.tagName));
            if (!alive) hollow.push(view);
        }
        const dup = titlesIn(pane);
        if (dup.length) doubled.push(view + ' -> «' + TITLE_EL.textContent + '» + «' + dup.map((d) => d.textContent).join('», «') + '»');
        if (!String(TITLE_EL.textContent || '').trim()) nameless.push(view);
    }
    assert.deepEqual(doubled, [], 'эти экраны пишут своё название дважды:\n  ' + doubled.join('\n  '));
    assert.deepEqual(nameless, [], 'эти экраны остались вообще без имени:\n  ' + nameless.join('\n  '));
    assert.deepEqual(hollow, [], 'на этих экранах осталась пустая полоса от снятого заголовка:\n  ' + hollow.join('\n  '));
});

test('глушим таймеры экранов, чтобы прогон завершался', () => {
    for (const id of appIntervals) clearInterval(id);
    appIntervals.clear();
});
