// PROCUREMENT_FILTERS_V1 (2026-09-25) — ФИЛЬТР КАТЕГОРИЙ ЗАКУПОК НА «СКЛАДЕ» И
// «ТОВАРАХ» И ЕГО ПАМЯТЬ ЗА ЧЕЛОВЕКОМ.
//
// Владелец: «no just show filters so user ticks his own and manage statistics».
// Что закреплено здесь:
//   1. Восемь категорий каталога и «Все»; несколько отметок сразу.
//   2. Отметки запоминаются ЗА ЧЕЛОВЕКОМ: компьютеры в клинике общие, и выбор
//      кладовщика не должен встречать провизора за тем же ПК.
//   3. Итоги на экране («Позиций / на сумму / пора заказать», «Товаров: N»)
//      считаются по ОТОБРАННЫМ строкам — статистика следует за отметками.
//   4. У «Товаров» появился поиск (его не было вовсе).
// «Сроки годности» (отбор на сервере) — в expiry.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert';

// ─── минимальный DOM (тот же стенд, что у expiry.test.mjs) ──────────────────
class FakeNode {
    constructor(tag) {
        this.tagName = String(tag).toUpperCase();
        this.style = {}; this.children = []; this.attrs = {};
        this.className = ''; this._text = ''; this._l = {}; this.dataset = {};
        this.value = ''; this.hidden = false; this._parent = null;
        // SEARCH_ALIVE_V1 — у стенда появились каретка и фокус: без них он не
        // отличает живое поле ввода от заново созданного пустого.
        this.selectionStart = 0; this.selectionEnd = 0;
    }
    appendChild(c) { if (c && typeof c === 'object') c._parent = this; this.children.push(c); return c; }
    removeChild(c) { const i = this.children.indexOf(c); if (i > -1) this.children.splice(i, 1); if (c) c._parent = null; blurDetached(c); return c; }
    get firstChild() { return this.children.length ? this.children[0] : null; }
    replaceChildren() { this.children.length = 0; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); }
    addEventListener(t, fn) { (this._l[t] || (this._l[t] = [])).push(fn); }
    removeEventListener() {}
    dispatchEvent(e) { for (const fn of this._l[e.type] || []) fn(e); return true; }
    click() { this.dispatchEvent({ type: 'click', currentTarget: this, preventDefault() {}, stopPropagation() {} }); }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    remove() { if (this._parent) this._parent.removeChild(this); }
    focus() { globalThis.document.activeElement = this; }
    blur() { if (globalThis.document.activeElement === this) globalThis.document.activeElement = null; }
    setSelectionRange(s, e) { this.selectionStart = s; this.selectionEnd = e; }
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
    set textContent(v) { this._text = String(v); this.children.length = 0; }
    get classList() { const s = this; return { contains: (c) => String(s.className).split(/\s+/).includes(c), add() {}, remove() {}, toggle() {} }; }
    get isConnected() { return true; }
}
// SEARCH_ALIVE_V1 — узел, ВЫНУТЫЙ ИЗ ДЕРЕВА, ТЕРЯЕТ ФОКУС: так делает браузер,
// и ровно в этом состоит вред перерисовки строки фильтров. Не было бы этого —
// стенд считал бы, что фокус пережил пересоздание поля, и проверка ничего бы
// не ловила.
function blurDetached(node) {
    const doc = globalThis.document;
    if (!doc || !doc.activeElement || !node || typeof node !== 'object') return;
    const holds = (e) => e === doc.activeElement || ((e && e.children) || []).some(holds);
    if (holds(node)) doc.activeElement = null;
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
    activeElement: null,   // SEARCH_ALIVE_V1
    getElementById(id) { return BODY.children.find((c) => c.attrs && c.attrs.id === id) || null; },
};
// I18N_LOCALE_PIN_V1 — экран рисуется по-русски независимо от локали машины.
globalThis.localStorage = { getItem: (k) => (k === 'admin.lang' ? 'ru' : null), setItem() {}, removeItem() {}, clear() {} };
globalThis.window = { location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, addEventListener() {}, open: () => null,
    easymed: { state: { user: { id: 2, role: 'inventory', full_name: 'Кладовщик Каримов' } } }, confirm: () => true,
    crypto: { randomUUID: () => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' } };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();

const walk = (e, out = []) => { if (!e || typeof e !== 'object') return out; out.push(e); for (const c of e.children || []) walk(c, out); return out; };
const textOf = (e) => walk(e).map((x) => x._text || '').join(' ');
const flat = (e) => textOf(e).replace(/\s+/g, ' ').trim();
const findAll = (root, tag) => walk(root).filter((e) => e.tagName === tag);
const findBtn = (root, label) => walk(root).find((e) => e.tagName === 'BUTTON' && textOf(e).includes(label));
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const rows = (root) => findAll(findAll(root, 'TABLE')[0], 'TR').filter((tr) => findAll(tr, 'TD').length);
// SEARCH_ALIVE_V1 — поле поиска ищем КАЖДЫЙ РАЗ ЗАНОВО, по экрану: в этом и
// смысл проверки — тот ли это узел, в который человек печатал.
const searchInput = (root) => walk(root).find((e) => e.tagName === 'INPUT' && /Поиск/.test(e.attrs.placeholder || ''));
const cells = (tr) => findAll(tr, 'TD').map((td) => textOf(td).replace(/\s+/g, ' ').trim());

// ─── «сервер» ───────────────────────────────────────────────────────────────
// Склад: четыре товара трёх категорий. Цифры подобраны так, чтобы итог по
// отобранному отличался от итога по всему складу в каждом числе.
const PRODUCTS = [
    { id: 1, name: 'Анальгин', code: 'ANL', active: 1, procurement_category: 'medicines', base_unit: 'шт', on_hand: 10, avg_cost: 100, reorder_level: 20, supplier_id: null },
    { id: 2, name: 'Перчатки', code: 'GLV', active: 1, procurement_category: 'consumables', base_unit: 'уп', on_hand: 5, avg_cost: 1000, reorder_level: 0, supplier_id: null },
    { id: 3, name: 'Шприц', code: 'SYR', active: 1, procurement_category: 'consumables', base_unit: 'шт', on_hand: 2, avg_cost: 50, reorder_level: 10, supplier_id: null },
    { id: 4, name: 'Пломба', code: 'DNT', active: 1, procurement_category: 'dental', base_unit: 'шт', on_hand: 3, avg_cost: 700, reorder_level: 0, supplier_id: null },
];
globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    let body = {}; try { body = JSON.parse(opts.body || '{}'); } catch { /* not ours */ }
    if (u.startsWith('/api/db')) {
        const data = body.table === 'products' ? PRODUCTS.map((p) => ({ ...p })) : [];
        return { ok: true, status: 200, json: async () => ({ data, count: data.length }), headers: { getSetCookie: () => [] } };
    }
    return { ok: true, status: 200, json: async () => ({ data: [] }), headers: { getSetCookie: () => [] } };
};

// Хранилище браузера — одно на все тесты, как у настоящего общего ПК.
const STORE = new Map();
globalThis.window.localStorage.getItem = (k) => (k === 'admin.lang' ? 'ru' : (STORE.has(k) ? STORE.get(k) : null));
globalThis.window.localStorage.setItem = (k, v) => { STORE.set(k, String(v)); };
globalThis.window.localStorage.removeItem = (k) => { STORE.delete(k); };
const asUser = (id) => { globalThis.window.easymed.state.user = { id, role: 'inventory', full_name: 'Сотрудник ' + id }; };

const cf = await import('../views/category-filter.js');
const { renderSkladTab, skladSummary } = await import('../views/inventory-sklad.js');
const { renderProductsTab, filterProducts } = await import('../views/inventory-products.js');
const { CATEGORY_LABEL } = await import('../views/inventory-shared.js');

const catPill = (root, key) => walk(root).find((e) => e.tagName === 'BUTTON' && e.attrs['data-category'] === key);
const allPill = (root) => walk(root).find((e) => e.tagName === 'BUTTON' && e.className === 'cat-pill' && !e.attrs['data-category']);
const bodyRows = (root) => findAll(findAll(root, 'TBODY')[0], 'TR');
const firstCells = (root) => bodyRows(root).map((tr) => textOf(findAll(tr, 'TD')[0]).replace(/\s+/g, ' ').trim());

async function openSklad(userId = 11) {
    asUser(userId);
    const root = mkEl('div');
    await renderSkladTab(root);
    await settle();
    return root;
}
async function openProducts(userId = 11) {
    asUser(userId);
    const root = mkEl('div');
    renderProductsTab(root);
    await settle();
    return root;
}

// ───────────────────────────────────────────────────────────────────────────
// Фильтр категорий и его память
// ───────────────────────────────────────────────────────────────────────────

test('фильтр: «Все» и восемь категорий каталога, подписи — те же, что у товара', () => {
    STORE.clear(); asUser(11);
    const el = cf.categoryFilter({ selected: [] });
    const pills = walk(el).filter((e) => e.tagName === 'BUTTON');
    assert.equal(pills.length, 9);
    assert.equal(flat(pills[0]), 'Все');
    assert.deepEqual(pills.slice(1).map((b) => b.attrs['data-category']),
        ['medicines', 'consumables', 'equipment', 'lab_supplies', 'dental', 'radiology', 'office_it', 'facility']);
    const words = (b) => walk(b).filter((x) => x.tagName === '#TEXT').map((x) => x._text).join('').trim();   // без разметки значка
    assert.deepEqual(pills.slice(1).map(words), Object.values(CATEGORY_LABEL));
    assert.equal(pills[0].attrs['aria-pressed'], 'true', 'без отметок выбрано «Все»');
});

test('память: за человеком, а не за браузером — двое за одним ПК не видят отметок друг друга', () => {
    STORE.clear();
    asUser(21);
    cf.saveCategories(['dental', 'medicines', 'нет такой']);
    assert.deepEqual(cf.loadCategories(), ['medicines', 'dental'], 'мусор и порядок не вычищены');
    assert.equal(cf.categoryStorageKey(), 'easymed.procurement.categories.v1.u21');
    asUser(22);
    assert.deepEqual(cf.loadCategories(), [], 'отметки одного человека встретили другого');
    cf.saveCategories(['facility']);
    asUser(21);
    assert.deepEqual(cf.loadCategories(), ['medicines', 'dental'], 'чужой выбор затёр свой');
    // «Все» — ключ убирается.
    cf.saveCategories([]);
    assert.equal(STORE.has('easymed.procurement.categories.v1.u21'), false);
    // Никто не вошёл — запоминать не за кем.
    globalThis.window.easymed.state.user = null;
    cf.saveCategories(['medicines']);
    assert.deepEqual(cf.loadCategories(), []);
    assert.equal(cf.categoryStorageKey(), null);
});

test('память: закрытое или испорченное хранилище — «без памяти», а не упавший экран', () => {
    STORE.clear(); asUser(23);
    STORE.set('easymed.procurement.categories.v1.u23', '{не json');
    assert.deepEqual(cf.loadCategories(), []);
    const ls = globalThis.window.localStorage;
    const { getItem, setItem } = ls;
    ls.getItem = () => { throw new Error('SecurityError'); };
    ls.setItem = () => { throw new Error('QuotaExceeded'); };
    try {
        assert.deepEqual(cf.loadCategories(), []);
        assert.doesNotThrow(() => cf.saveCategories(['medicines']));
    } finally { ls.getItem = getItem; ls.setItem = setItem; }
});

// ───────────────────────────────────────────────────────────────────────────
// «Склад»
// ───────────────────────────────────────────────────────────────────────────

test('«Склад»: колонка «Категория», отметка отбирает строки', async () => {
    STORE.clear();
    const root = await openSklad();
    const ths = findAll(findAll(root, 'THEAD')[0], 'TR')[0];
    assert.deepEqual(findAll(ths, 'TH').slice(0, 3).map((th) => flat(th)), ['Товар', 'Категория', 'Единица']);
    assert.equal(bodyRows(root).length, 4);
    assert.equal(textOf(findAll(bodyRows(root)[0], 'TD')[1]).trim(), 'Медикаменты');
    catPill(root, 'consumables').click();
    assert.deepEqual(firstCells(root), ['Перчатки', 'Шприц']);
    catPill(root, 'dental').click();
    assert.deepEqual(firstCells(root), ['Перчатки', 'Шприц', 'Пломба']);
    allPill(root).click();
    assert.equal(bodyRows(root).length, 4);
});

test('«Склад»: итоги — позиций, сумма и «пора заказать» — считаются по ОТОБРАННЫМ строкам', async () => {
    STORE.clear();
    const root = await openSklad();
    const summary = () => flat(walk(root).find((e) => String(e.className).includes('sklad-summary')));
    // Весь склад: 10×100 + 5×1000 + 2×50 + 3×700 = 8 200; мало у анальгина и шприца.
    assert.equal(summary(), 'Позиций: 4 · на сумму 8 200 · пора заказать: 2');
    catPill(root, 'consumables').click();
    assert.equal(summary(), 'Позиций: 2 · на сумму 5 100 · пора заказать: 1');
    catPill(root, 'consumables').click();
    catPill(root, 'dental').click();
    assert.equal(summary(), 'Позиций: 1 · на сумму 2 100 · пора заказать: 0');
    // Итог следует и за остальными фильтрами — это тот же filtered().
    assert.deepEqual(skladSummary([]), { count: 0, value: 0, reorder: 0 });
});

test('«Склад»: отметки запоминаются за человеком и встречают его при следующем открытии', async () => {
    STORE.clear();
    const a = await openSklad(31);
    catPill(a, 'medicines').click();
    const again = await openSklad(31);
    assert.deepEqual(firstCells(again), ['Анальгин'], 'выбор не пережил повторное открытие');
    assert.equal(catPill(again, 'medicines').attrs['aria-pressed'], 'true');
    const other = await openSklad(32);
    assert.equal(bodyRows(other).length, 4, 'отметки одного встретили другого за тем же ПК');
});

// ───────────────────────────────────────────────────────────────────────────
// «Товары»
// ───────────────────────────────────────────────────────────────────────────

test('«Товары»: поиск по названию и коду, «Товаров: N» — по отобранному', async () => {
    STORE.clear();
    const root = await openProducts();
    const total = () => flat(findAll(root, 'SPAN').find((s) => /^Товаров:/.test(flat(s))));
    assert.equal(bodyRows(root).length, 4);
    assert.equal(total(), 'Товаров: 4');
    const q = walk(root).find((e) => e.tagName === 'INPUT' && /Поиск/.test(e.attrs.placeholder || ''));
    assert.ok(q, 'поиска на «Товарах» нет');
    q.value = 'перч';
    q.dispatchEvent({ type: 'input' });
    await settle(700);   // поиск в программе с задержкой (SEARCH_DEBOUNCE_V1)
    assert.equal(bodyRows(root).length, 1);
    assert.match(textOf(bodyRows(root)[0]), /Перчатки/);
    assert.equal(total(), 'Товаров: 1');
    q.value = 'syr';   // по коду, без учёта регистра
    q.dispatchEvent({ type: 'input' });
    await settle(700);
    assert.match(textOf(bodyRows(root)[0]), /Шприц/);
    q.value = 'нет такого';
    q.dispatchEvent({ type: 'input' });
    await settle(700);
    assert.equal(total(), 'Товаров: 0');
    assert.match(textOf(root), /Ничего не найдено\./, 'пустой отбор назван словами «пока нет товаров»');
});

test('«Товары»: отметка категории отбирает строки и итог; с поиском — пересечение', async () => {
    STORE.clear();
    const root = await openProducts();
    const total = () => flat(findAll(root, 'SPAN').find((s) => /^Товаров:/.test(flat(s))));
    catPill(root, 'consumables').click();
    assert.equal(bodyRows(root).length, 2);
    assert.equal(total(), 'Товаров: 2');
    assert.deepEqual(filterProducts(PRODUCTS, { q: 'шпр', cats: ['consumables'] }).map((p) => p.id), [3]);
    assert.deepEqual(filterProducts(PRODUCTS, { q: 'шпр', cats: ['medicines'] }), []);
    assert.equal(filterProducts(PRODUCTS, {}).length, 4);
});
