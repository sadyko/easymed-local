// SHELL_REGIONS_V1 (2026-09-05, владелец: «can we make top section and the
// left panel separate? with constant design across all the modules»)
//
// ДВЕ ОБЛАСТИ — И ЭТО ПРОВЕРЯЕМОЕ УТВЕРЖДЕНИЕ, А НЕ КАРТИНКА.
//
// Жалоба была про верхний левый угол: знак клиники и имя раздела стояли в
// одной горизонтальной полосе, которая на середине меняла цвет, — а колонка
// меню при этом не имела наверху никакого края. Разметка-то была правильной
// (верхняя строка лежит в <main>, а не в <aside>), но на экране это ничем не
// подтверждалось. Файл сторожит ЧЕТЫРЕ вещи, каждую своим способом:
//
//   1. СТРУКТУРА. Настоящий admin.html разбирается в дерево, и утверждения
//      формулируются об отношениях узлов: верхняя строка ВНУТРИ области
//      содержимого, НЕ внутри колонки, первая в ней, экран сразу за ней.
//      Скриншот такого сказать не может, а перестановка узлов — сломать.
//   2. ГЕОМЕТРИЯ. Между областями зазор грунта, у области содержимого свой
//      край и свой верхний левый угол; фон при этом ТОТ ЖЕ — области
//      разделены геометрией, а не краской (иначе поехали бы все посчитанные
//      контрасты карточек внутри).
//   3. КТО ВЫИГРЫВАЕТ КАСКАД. admin-views.css подключён ПОСЛЕ admin.css и
//      держит собственный `.appbar` (белый фон, линейка снизу, жёсткая
//      высота) — остаток верхнего меню другой оболочки. При равной
//      специфичности выигрывал он, и на экране верхняя строка была БЕЛОЙ
//      ПОЛОСОЙ вопреки admin.css. Здесь каскад считается по-настоящему:
//      правила обоих файлов сопоставляются с настоящей цепочкой предков
//      верхней строки, с настоящей специфичностью и порядком подключения.
//      Проверка не перечисляет свойства руками: ЛЮБОЕ свойство, которое
//      чужой лист скажет про верхнюю строку, обязано быть перебито
//      оболочкой — иначе завтра в admin-views.css допишут ещё строку и она
//      снова молча выиграет.
//   4. ОДИНАКОВО ВО ВСЕХ РАЗДЕЛАХ. Оболочка поднимается по-настоящему, и
//      обход идёт по НАСТОЯЩЕЙ таблице NAV: на каждом маршруте это ТОТ ЖЕ
//      САМЫЙ узел верхней строки, на том же месте, со всеми органами
//      управления и ровно одним именем раздела — и ни одной второй полосы
//      хрома внутри экрана.
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

// Разметка-двойник в этом файле обязана совпадать с настоящей: три атрибута
// областей и класс экрана появились вместе с SHELL_REGIONS_V1, и тест
// «двойник не разошёлся с admin.html» ниже сверяет их с файлом.
ASIDE.setAttribute('data-region', 'rail');
MAIN.setAttribute('data-region', 'content');
APPBAR.setAttribute('data-region-part', 'head');
VIEW_ROOT.className = 'view-root';

// ===========================================================================
// ЧАСТЬ 1. РАЗМЕТКА — разбор настоящего admin.html в дерево.
// ===========================================================================
const HTML      = read('public/admin.html');
const CSS_MAIN  = read('public/css/admin.css');
const CSS_VIEWS = read('public/css/admin-views.css');

const VOID_TAGS = new Set(['meta', 'link', 'br', 'hr', 'img', 'input', 'path', 'circle', 'rect',
    'line', 'polyline', 'polygon', 'use', 'source', 'area', 'col', 'embed', 'track', 'wbr']);

/** Крошечный разбор HTML: комментарии выброшены, остаются только элементы. */
function parseHtml(html) {
    const root = { tag: '#root', attrs: {}, children: [], parent: null };
    let cur = root;
    const re = /<!--[\s\S]*?-->|<(\/?)([A-Za-z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>])*?)(\/?)>/g;
    let m;
    while ((m = re.exec(html))) {
        if (m[0].startsWith('<!--')) continue;
        const [, close, rawTag, rawAttrs, selfClose] = m;
        const tag = rawTag.toLowerCase();
        if (close) {
            let n = cur;
            while (n && n.tag !== tag) n = n.parent;
            if (n && n.parent) cur = n.parent;
            continue;
        }
        const attrs = {};
        for (const a of String(rawAttrs).matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) attrs[a[1]] = a[2];
        const node = { tag, attrs, children: [], parent: cur };
        cur.children.push(node);
        if (!selfClose && !VOID_TAGS.has(tag)) cur = node;
    }
    return root;
}
const DOC   = parseHtml(HTML);
const clsOf = (n) => String((n && n.attrs && n.attrs.class) || '').split(/\s+/).filter(Boolean);
const tree  = (n, out = []) => { for (const c of n.children) { out.push(c); tree(c, out); } return out; };
const NODES = tree(DOC);
const nodesWithClass = (c) => NODES.filter((n) => clsOf(n).includes(c));
const nodesWithId    = (id) => NODES.filter((n) => n.attrs.id === id);
const under = (ancestor, n) => { for (let p = n.parent; p; p = p.parent) if (p === ancestor) return true; return false; };
const nameOf = (n) => n.tag + (n.attrs.id ? '#' + n.attrs.id : '') + clsOf(n).map((c) => '.' + c).join('');

const APP_NODE = (() => {
    const a = nodesWithClass('app');
    assert.equal(a.length, 1, 'в admin.html не одна оболочка .app, а ' + a.length);
    return a[0];
})();
const BAR_NODE = (() => {
    const b = nodesWithClass('appbar');
    assert.equal(b.length, 1, 'полос хрома в разметке ' + b.length + ' — верхняя строка обязана быть ОДНА на весь продукт');
    return b[0];
})();

test('оболочка — это ДВЕ области: колонка и содержимое, и они названы вслух', () => {
    const kids = APP_NODE.children;
    assert.equal(kids.length, 2,
        'у оболочки не две области, а ' + kids.length + ': ' + kids.map(nameOf).join(', '));
    const [rail, content] = kids;

    assert.equal(rail.tag, 'aside', 'левая область перестала быть <aside>');
    assert.ok(clsOf(rail).includes('sidebar'), 'левая область потеряла класс .sidebar');
    assert.equal(rail.attrs['data-region'], 'rail',
        'у левой колонки пропал data-region="rail" — области снова безымянные, и утверждать о них нечего');

    assert.equal(content.tag, 'main', 'область содержимого перестала быть <main>');
    assert.ok(clsOf(content).includes('main'), 'область содержимого потеряла класс .main');
    assert.equal(content.attrs['data-region'], 'content',
        'у области содержимого пропал data-region="content"');
});

test('верхняя строка принадлежит области СОДЕРЖИМОГО, а не колонке', () => {
    const [rail, content] = APP_NODE.children;
    assert.equal(BAR_NODE.attrs.id, 'topbar', 'верхняя строка потеряла id="topbar" — её органы управления монтируются по id');
    assert.equal(BAR_NODE.parent, content,
        'верхняя строка висит в ' + nameOf(BAR_NODE.parent) + ', а обязана лежать в области содержимого');
    assert.ok(!under(rail, BAR_NODE),
        'верхняя строка внутри колонки меню — это ровно та одна полоса, на которую жаловался владелец');
    assert.equal(content.children[0], BAR_NODE,
        'верхняя строка не первая в области содержимого: перед ней ' + nameOf(content.children[0]));

    const vr = nodesWithId('view-root');
    assert.equal(vr.length, 1, 'экранов-корней в разметке ' + vr.length);
    assert.equal(vr[0].parent, content, 'экран рисуется вне области содержимого');
    assert.equal(content.children[1], vr[0], 'между верхней строкой и экраном вклинилось ' + nameOf(content.children[1]));
    assert.equal(content.children.length, 2,
        'в области содержимого появился третий этаж хрома: ' + content.children.map(nameOf).join(', '));

    // Знак клиники остаётся наверху КОЛОНКИ — он её шапка, а не общая.
    const brand = nodesWithClass('sidebar-brand');
    assert.equal(brand.length, 1, 'шапок колонки в разметке ' + brand.length);
    assert.ok(under(rail, brand[0]) && !under(content, brand[0]),
        'знак клиники уехал из колонки в область содержимого — обе области снова слиплись бы наверху');
    // И порядок внутри неё прежний (BRAND_PLATE_V1): имя клиники, потом поставщик.
    const bi = tree(brand[0]);
    const iClinic = bi.findIndex((n) => clsOf(n).includes('brand-sub'));
    const iVendor = bi.findIndex((n) => clsOf(n).includes('brand-name'));
    assert.ok(iClinic > -1 && iVendor > -1 && iClinic < iVendor,
        'порядок строк в шапке колонки перевёрнут обратно: имя клиники обязано идти первым');
});

test('в верхней строке имя раздела слева и все пять органов управления справа', () => {
    const inBar = tree(BAR_NODE);
    const title = inBar.find((n) => n.attrs.id === 'section-title');
    assert.ok(title, 'из верхней строки пропало имя раздела');
    assert.equal(title.tag, 'h1', 'имя раздела перестало быть <h1>');
    assert.equal(BAR_NODE.children[0], title, 'глаз ищет имя раздела первым — оно обязано стоять первым в строке');

    const controls = BAR_NODE.children[1];
    assert.ok(controls && clsOf(controls).includes('appbar-controls'), 'органы управления выпали из верхней строки');
    for (const id of ['topbar-reload', 'topbar-bell', 'branch-picker', 'topbar-lang', 'user-card-btn'])
        assert.ok(tree(controls).some((n) => n.attrs.id === id), 'орган управления ' + id + ' уехал из верхней строки');
});

test('двойник оболочки в этом файле не разошёлся с admin.html', () => {
    const [rail, content] = APP_NODE.children;
    assert.equal(ASIDE.getAttribute('data-region'), rail.attrs['data-region']);
    assert.equal(MAIN.getAttribute('data-region'), content.attrs['data-region']);
    assert.equal(String(MAIN.className), clsOf(content).join(' '));
    assert.equal(String(APPBAR.className), clsOf(BAR_NODE).join(' '));
    assert.equal(MAIN.children[0], APPBAR, 'в двойнике верхняя строка не первая — обход маршрутов проверял бы не то');
    assert.equal(MAIN.children[1], VIEW_ROOT);
});

// ===========================================================================
// ЧАСТЬ 2. КАСКАД — считаем его так, как считает браузер.
// ===========================================================================
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** Плоский список правил; вложенные в @media помечены, а не выброшены. */
function parseRules(css, media = null, out = []) {
    let i = 0;
    while (i < css.length) {
        const open = css.indexOf('{', i);
        if (open < 0) break;
        const prelude = css.slice(i, open).trim();
        let depth = 1, j = open + 1;
        while (j < css.length && depth) { const ch = css[j]; if (ch === '{') depth++; else if (ch === '}') depth--; j++; }
        const body = css.slice(open + 1, j - 1);
        if (prelude.startsWith('@')) {
            if (/^@(media|supports|layer)/.test(prelude)) parseRules(body, prelude, out);
        } else if (prelude) {
            out.push({ sel: prelude, body, media });
        }
        i = j;
    }
    return out;
}

/** Объявления правила. Сокращения раскрыты — иначе `border: 0` не перебьёт
 *  чужой `border-bottom`, хотя в браузере перебивает. */
function decls(body) {
    const out = {};
    for (const part of body.split(';')) {
        const i = part.indexOf(':');
        if (i < 0) continue;
        const k = part.slice(0, i).trim().toLowerCase();
        const v = part.slice(i + 1).trim();
        if (!k || !v) continue;
        out[k] = v;
        if (k === 'border') for (const s of ['top', 'right', 'bottom', 'left']) out['border-' + s] = v;
        if (k === 'background') out['background-color'] = v;
        if (k === 'background-color') out.background = v;
    }
    return out;
}

const SHEETS = [['css/admin.css', CSS_MAIN], ['css/admin-views.css', CSS_VIEWS]];
const ALL_RULES = [];
for (const [file, css] of SHEETS)
    for (const r of parseRules(strip(css))) ALL_RULES.push({ ...r, file, order: ALL_RULES.length, d: decls(r.body) });

/** Цепочка предков элемента — из НАСТОЯЩЕЙ разметки, а не придуманная. */
function chainOf(node) {
    const out = [];
    for (let n = node; n && n.tag !== '#root'; n = n.parent)
        out.unshift({ tag: n.tag, id: n.attrs.id || null, cls: clsOf(n), attrs: n.attrs });
    return out;
}
const BAR_CHAIN = chainOf(BAR_NODE);

function compoundMatches(part, el) {
    if (!el) return false;
    const tag = (part.match(/^[A-Za-z][\w-]*/) || [])[0];
    if (tag && tag.toLowerCase() !== el.tag) return false;
    for (const c of part.match(/\.[A-Za-z0-9_-]+/g) || []) if (!el.cls.includes(c.slice(1))) return false;
    const id = (part.match(/#([A-Za-z0-9_-]+)/) || [])[1];
    if (id && el.id !== id) return false;
    for (const a of part.match(/\[[^\]]+\]/g) || []) {
        const m = a.match(/^\[([\w-]+)(?:(=)"?([^"\]]*)"?)?\]$/);
        if (!m) return false;
        const v = el.attrs[m[1]];
        if (v === undefined) return false;
        if (m[2] === '=' && v !== m[3]) return false;
    }
    return true;
}
function selectorMatches(sel, chain) {
    if (/[:,]/.test(sel)) return false;   // псевдоклассы каскад в покое не решают
    const toks = sel.replace(/\s*>\s*/g, ' > ').trim().split(/\s+/);
    let i = chain.length - 1;
    const last = toks.pop();
    if (!last || last === '>' || !compoundMatches(last, chain[i])) return false;
    i--;
    let child = false;
    for (let k = toks.length - 1; k >= 0; k--) {
        const tk = toks[k];
        if (tk === '>') { child = true; continue; }
        if (tk === '+' || tk === '~') return false;
        if (child) {
            if (i < 0 || !compoundMatches(tk, chain[i])) return false;
            i--; child = false;
        } else {
            let ok = false;
            while (i >= 0) { const c = chain[i--]; if (compoundMatches(tk, c)) { ok = true; break; } }
            if (!ok) return false;
        }
    }
    return true;
}
function specificity(sel) {
    const ids = (sel.match(/#[A-Za-z0-9_-]+/g) || []).length;
    const cls = (sel.match(/\.[A-Za-z0-9_-]+/g) || []).length + (sel.match(/\[[^\]]+\]/g) || []).length;
    const els = (sel.match(/(^|[\s>])[A-Za-z][\w-]*/g) || []).length;
    return ids * 10000 + cls * 100 + els;
}
/** Кто в итоге напишет свойство на элементе: специфичность, при равенстве — порядок. */
function winner(prop, chain = BAR_CHAIN) {
    let best = null;
    for (const r of ALL_RULES) {
        if (r.media) continue;
        if (!(prop in r.d)) continue;
        for (const sel of r.sel.split(',')) {
            const s = sel.trim();
            if (!s || !selectorMatches(s, chain)) continue;
            const sp = specificity(s);
            if (!best || sp > best.sp || (sp === best.sp && r.order >= best.order))
                best = { sp, order: r.order, file: r.file, sel: s, value: r.d[prop] };
        }
    }
    return best;
}

// --- токены и контраст (тот же счёт, что в contrast-badge-hatch) -----------
const TOKENS = (() => {
    const map = {};
    const root = CSS_MAIN.slice(CSS_MAIN.indexOf(':root'), CSS_MAIN.indexOf('\n}', CSS_MAIN.indexOf(':root')));
    for (const m of root.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) map[m[1]] = m[2].trim();
    return map;
})();
function hex(value) {
    const v = String(value).trim();
    const m = v.match(/^var\((--[a-z0-9-]+)\)$/);
    if (m) { assert.ok(TOKENS[m[1]], 'токен ' + m[1] + ' не найден в :root'); return hex(TOKENS[m[1]]); }
    const h = v.match(/^#([0-9a-fA-F]{3,8})$/);
    assert.ok(h, 'не цвет: ' + v);
    let s = h[1];
    if (s.length === 3) s = s.split('').map((c) => c + c).join('');
    return '#' + s.slice(0, 6).toLowerCase();
}
function luminance(h) {
    const c = [0, 2, 4].map((i) => parseInt(h.slice(1 + i, 3 + i), 16) / 255)
        .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function ratio(a, b) {
    const x = luminance(hex(a)), y = luminance(hex(b));
    return Math.floor(((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)) * 100) / 100;
}
function lengthToken(name) {
    const m = String(TOKENS[name] || '').match(/^(-?[0-9.]+)px$/);
    assert.ok(m, 'токен ' + name + ' пропал из :root или перестал быть длиной');
    return parseFloat(m[1]);
}
function px(value) {
    const v = String(value).trim();
    const t = v.match(/^var\((--[a-z0-9-]+)\)$/);
    if (t) return lengthToken(t[1]);
    if (v === '0') return 0;
    const m = v.match(/^(-?[0-9.]+)px$/);
    assert.ok(m, 'не длина: ' + v);
    return parseFloat(m[1]);
}
/** Объявления всех правил с ТОЧНО таким селектором, слитые по порядку файла. */
function ruleOf(selector, file = 'css/admin.css') {
    const out = {};
    let found = 0;
    for (const r of ALL_RULES) {
        if (r.file !== file || r.sel !== selector || r.media) continue;   // @media — отдельный разговор; здесь спрашивают правило В ПОКОЕ
        found++;
        Object.assign(out, r.d);
    }
    assert.ok(found, 'правило «' + selector + '» пропало из ' + file);
    return out;
}

const GROUND = 'var(--page-ground)';

test('между колонкой и содержимым — настоящий зазор грунта', () => {
    const app = ruleOf('.app');
    assert.ok(app['column-gap'], 'у оболочки пропал зазор между областями — они снова упираются друг в друга');
    const gap = px(app['column-gap']);
    assert.ok(gap >= 8, 'зазор между областями ' + gap + 'px — на глаз это стык, а не граница');
    assert.match(String(app['grid-template-columns']), /var\(--sidebar-w\)/,
        'ширину колонки задаёт больше не --sidebar-w — свёрнутая рейка перестанет работать');
});

test('у области содержимого свой край и свой верхний левый угол — тот, на который жаловались', () => {
    const main = ruleOf('.main');
    const gap = px(ruleOf('.app')['column-gap']);

    const m = String(main.margin || '').split(/\s+/);
    assert.equal(m.length, 4, 'поля области содержимого заданы не четырьмя числами: ' + main.margin);
    assert.equal(px(m[3]), 0, 'у области содержимого появилось левое поле — зазор от колонки удвоится');
    for (const [i, side] of [[0, 'сверху'], [1, 'справа'], [2, 'снизу']])
        assert.equal(px(m[i]), gap, 'зазор ' + side + ' (' + m[i] + ') разошёлся с зазором между областями');

    const edge = String(main.border || '').match(/var\(--[a-z0-9-]+\)|#[0-9a-fA-F]{3,8}/);
    assert.ok(edge, 'у области содержимого пропал край: ' + main.border);
    const onGround = ratio(edge[0], GROUND);
    assert.ok(onGround >= 1.2, 'край области на грунте ' + onGround + ':1 — границы не видно');
    const windowLine = ratio('var(--window-line)', GROUND);
    assert.ok(onGround <= windowLine,
        'край ОБЛАСТИ (' + onGround + ':1) громче рамки рабочего окна (' + windowLine + ':1) — получилось окно в окне');

    assert.ok(px(main['border-radius']) >= 8,
        'у верхнего левого угла области нет скругления — угол снова читается случайным стыком');

    // Разделены геометрией, а не краской: фон ТОТ ЖЕ, что у страницы.
    assert.equal(hex(main.background), hex(GROUND),
        'область содержимого получила собственную подложку — все посчитанные контрасты карточек внутри поехали');
    assert.equal(hex(ruleOf('body.admin').background), hex(GROUND));
});

test('колонка осталась бесшовной — её отдельной делает содержимое, а не подложка', () => {
    const side = ruleOf('.sidebar');
    assert.ok(!side.background || /^(transparent|none)$/.test(side.background),
        'у колонки снова своя подложка (' + side.background + ') — вернулась панель со швом');
    for (const k of Object.keys(side))
        assert.ok(!/^border(-right)?$/.test(k) || /^(0|none)/.test(side[k]), 'у колонки снова граница: ' + k + ': ' + side[k]);
    assert.ok(!side['box-shadow'] || /^none/.test(side['box-shadow']), 'у колонки снова тень');
});

test('область содержимого не стала контейнером прокрутки — иначе липкая строка перестанет липнуть', () => {
    const main = ruleOf('.main');
    for (const k of ['overflow', 'overflow-y', 'overflow-x', 'transform', 'filter', 'perspective', 'contain'])
        assert.ok(!(k in main),
            'у области содержимого появился ' + k + ': липкая верхняя строка отвяжется от окна, а модальные окна (position: fixed) начнут считать координаты от неё');
});

test('верхнюю строку не может перекрасить второй лист стилей', () => {
    const bg = winner('background');
    assert.ok(bg, 'у верхней строки не осталось фона — сквозь неё поедут карточки');
    assert.equal(bg.file, 'css/admin.css',
        'фон верхней строки пишет ' + bg.file + ' («' + bg.sel + '» → ' + bg.value + ') — оболочка проиграла каскад');
    assert.notEqual(hex(bg.value), '#ffffff', 'верхняя строка снова белая полоса — «сплошной лист» вернулся');
    assert.equal(hex(bg.value), hex(GROUND), 'верхняя строка лежит не на грунте страницы, а на своей подложке');

    const bottom = winner('border-bottom');
    assert.ok(!bottom || /^(0|none)/.test(bottom.value),
        'под верхней строкой снова линейка (' + (bottom && bottom.file) + ': ' + (bottom && bottom.value) + ') — это шов');

    const h = winner('height');
    assert.ok(!h || h.value === 'auto',
        'верхней строке навязали жёсткую высоту ' + (h && h.value) + ' из ' + (h && h.file));
    assert.equal(winner('min-height').value, 'var(--topbar-h)', 'высота верхней строки перестала быть общей');
});

test('ЛЮБОЕ слово чужого листа о верхней строке перебито оболочкой', () => {
    // Не список свойств руками: завтра в admin-views.css допишут строку, и
    // она снова молча выиграет каскад — как выиграла белая полоса.
    const foreign = new Map();
    for (const r of ALL_RULES) {
        if (r.file === 'css/admin.css' || r.media) continue;
        for (const sel of r.sel.split(',')) {
            const s = sel.trim();
            if (!s || !selectorMatches(s, BAR_CHAIN)) continue;
            for (const prop of Object.keys(r.d)) if (!prop.startsWith('--') && !foreign.has(prop)) foreign.set(prop, r.file + ' «' + s + '»');
        }
    }
    const lost = [];
    for (const [prop, who] of foreign) {
        const w = winner(prop);
        if (!w || w.file !== 'css/admin.css') lost.push(prop + ' ← ' + who + (w ? ' (выиграл ' + w.file + ')' : ''));
    }
    assert.deepEqual(lost, [], 'верхнюю строку переписывает чужой лист стилей:\n  ' + lost.join('\n  '));
});

test('липкость держит: строка непрозрачна и лежит над содержимым', () => {
    assert.equal(winner('position').value, 'sticky', 'верхняя строка перестала быть липкой — карточки поедут сквозь имя раздела');
    assert.equal(px(winner('top').value), 0, 'липкая строка прилипает не к верху окна — над ней будет видна уезжающая полоска содержимого');
    assert.ok(parseInt(winner('z-index').value, 10) >= 30, 'карточки перекроют верхнюю строку');
    const bg = winner('background').value;
    assert.ok(!/transparent|none|rgba/.test(bg), 'фон верхней строки не сплошной (' + bg + ') — сквозь неё будет видно содержимое');
    // И у самой прокрутки нет второго контейнера: страницу крутит окно.
    for (const sel of ['.app', 'body.admin'])
        for (const k of ['overflow', 'overflow-y'])
            assert.ok(!(k in ruleOf(sel)), 'у ' + sel + ' появился ' + k + ' — липкая строка отвяжется от окна');
});

test('имя раздела и знак клиники стоят на одной высоте — через границу, а не в одной полосе', () => {
    const gap = px(ruleOf('.app')['column-gap']);
    const edge = px(String(ruleOf('.main').border).split(/\s+/)[0]);
    const barCenter = gap + edge + lengthToken('--topbar-h') / 2;

    const brand = ruleOf('.sidebar-brand');
    const padTop = px(brand.padding.split(/\s+/)[0]);
    // Высота двух строк шапки: имя клиники + отступ + имя поставщика.
    const sub = ruleOf('.brand-sub'), name = ruleOf('.brand-name');
    const textH = px(sub['font-size']) * parseFloat(sub['line-height'])
        + px(name['margin-top'])
        + px(name['font-size']) * parseFloat(name['line-height']);
    const markH = px(ruleOf('.brand-mark').height);
    const brandCenter = padTop + Math.max(textH, markH) / 2;

    assert.ok(Math.abs(brandCenter - barCenter) <= 2,
        'знак клиники на ' + brandCenter.toFixed(1) + 'px, имя раздела на ' + barCenter.toFixed(1) + 'px: '
        + 'через видимую границу выравнивание читается как порядок, а промах в несколько пикселей — как небрежность');
});

test('свёрнутая рейка ничего не ломает: граница читается той же', () => {
    assert.equal(px(ruleOf('.sidebar-collapsed')['--sidebar-w']), 68, 'рейка перестала быть 68px');
    // Ни одно правило свёрнутого состояния не трогает геометрию границы —
    // значит на рейке она РОВНО та же, и доказывать это отдельно не нужно.
    const bad = [];
    for (const r of ALL_RULES) {
        if (!/\.sidebar-collapsed/.test(r.sel)) continue;
        const touches = ['column-gap', 'margin', 'border', 'border-radius', 'background', 'position']
            .filter((p) => p in r.d);
        if (/(^|\s|>)(\.main|\.app|#topbar)/.test(r.sel.replace(/\.sidebar-collapsed/g, '')) && touches.length)
            bad.push(r.sel + ' → ' + touches.join(', '));
    }
    assert.deepEqual(bad, [], 'свёрнутое состояние переопределяет границу областей:\n  ' + bad.join('\n  '));
    // Знак остаётся единственным, что видно в шапке рейки, и он не спрятан.
    for (const r of ALL_RULES) {
        if (!/\.sidebar-collapsed/.test(r.sel) || !/\.brand-mark/.test(r.sel)) continue;
        if (/:not\(\.brand-mark\)/.test(r.sel)) continue;
        assert.ok(!/none/.test(String(r.d.display || '')), 'правило рейки прячет знак клиники: ' + r.sel);
    }
});

test('ни один экран не рисует собственную полосу хрома', () => {
    const files = [];
    (function collect(dir) {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) { if (e.name !== '__tests__') collect(full); continue; }
            if (e.name.endsWith('.js')) files.push(full);
        }
    })(path.join(PUB, 'js'));
    const bad = [];
    for (const f of files) {
        if (f.endsWith(path.join('js', 'admin.js'))) continue;   // сама оболочка
        const src = fs.readFileSync(f, 'utf8');
        const code = src.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
        const rel = path.relative(REPO, f);
        if (/class:\s*['"][^'"]*\bappbar\b|className\s*=\s*['"][^'"]*\bappbar\b/.test(code)) bad.push(rel + ': рисует свою .appbar');
        if (/getElementById\(\s*['"]topbar['"]\s*\)|querySelector\(\s*['"]#topbar['"]/.test(code)) bad.push(rel + ': лезет в верхнюю строку оболочки');
    }
    assert.deepEqual(bad, [], 'верхняя строка перестала быть одна на весь продукт:\n  ' + bad.join('\n  '));
});

// ===========================================================================
// ЧАСТЬ 3. ОБХОД ВСЕХ МАРШРУТОВ — одна и та же строка на каждом экране.
// ===========================================================================
const hasCls2 = (n, c) => String((n && n.className) || '').split(/\s+/).includes(c);
// Маршруты берутся из НАСТОЯЩИХ таблиц оболочки: NAV — то, что человек
// видит в меню, CRUMBS — подстраницы, отчёты и всё, куда меню приводит
// вторым щелчком. Своя копия списка разошлась бы с ними ровно в тот день,
// когда добавят новый раздел, — то есть когда обход и нужен.
const routeIds = () => {
    const ids = new Set();
    for (const item of shell().NAV) if (item && item.id) ids.add(item.id);
    for (const k of Object.keys(shell().CRUMBS)) ids.add(k);
    // Маршрутам с payload нужен пациент/приём — без него это не экран.
    ids.delete('patient-card');
    ids.delete('service-workspace');
    return [...ids];
};

test('ОБХОД NAV: на каждом маршруте это ОДНА И ТА ЖЕ верхняя строка', async () => {
    await perms_setFull();
    const routes = routeIds();
    assert.ok(routes.length >= 40, 'маршрутов в обходе всего ' + routes.length + ' — обход ничего не докажет');
    for (const item of shell().NAV) if (item && item.id) assert.ok(routes.includes(item.id), 'пункт меню ' + item.id + ' выпал из обхода');

    const moved = [], nameless = [], lostControls = [], doubled = [], extraBars = [];
    for (const view of routes) {
        try { await go(view); } catch (e) { await settle(40); }

        // ТА ЖЕ строка, В ТОЙ ЖЕ области, НА ТОМ ЖЕ месте.
        if (APPBAR._parent !== MAIN || MAIN.children[0] !== APPBAR) moved.push(view);
        if (!String(TITLE_EL.textContent || '').trim()) nameless.push(view);
        const ids = descendants(APPBAR).map((n) => n.attrs.id).filter(Boolean);
        for (const id of ['section-title', 'topbar-reload', 'topbar-bell', 'branch-picker', 'topbar-lang', 'user-card-btn'])
            if (!ids.includes(id)) lostControls.push(view + ' → ' + id);

        // И ни одной ВТОРОЙ полосы хрома внутри экрана.
        const inView = descendants(VIEW_ROOT);
        if (inView.some((n) => hasCls2(n, 'appbar'))) extraBars.push(view);
        const dup = inView.filter((n) => n.tagName === 'H1' && hasCls2(n, 'page-title'));
        if (dup.length) doubled.push(view + ' → «' + dup.map((d) => d.textContent).join('», «') + '»');
    }
    assert.deepEqual(moved, [], 'на этих маршрутах верхняя строка уехала из области содержимого:\n  ' + moved.join('\n  '));
    assert.deepEqual(nameless, [], 'эти экраны остались без имени в верхней строке:\n  ' + nameless.join('\n  '));
    assert.deepEqual(lostControls, [], 'на этих маршрутах верхняя строка лишилась органов управления:\n  ' + lostControls.join('\n  '));
    assert.deepEqual(extraBars, [], 'эти экраны нарисовали ВТОРУЮ полосу хрома под верхней строкой:\n  ' + extraBars.join('\n  '));
    assert.deepEqual(doubled, [], 'эти экраны написали своё имя второй раз:\n  ' + doubled.join('\n  '));

    // Полоса хрома на всю страницу по-прежнему одна.
    assert.equal(document.querySelectorAll('.appbar').length, 1, 'полос хрома на странице стало больше одной');
});

test('глушим таймеры экранов, чтобы прогон завершался', () => {
    for (const id of appIntervals) clearInterval(id);
    appIntervals.clear();
});
