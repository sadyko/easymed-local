// EXPIRY_BALANCE_V1 — «СРОКИ ГОДНОСТИ»: ЧТО ЭКРАН ОБЯЗАН ПОКАЗАТЬ И ЧЕГО НЕ
// ДЕЛАЕТ, И ЧТО ГОВОРИТ ДИАЛОГ ВЫДАЧИ О ПРОСРОЧЕННОЙ ПАРТИИ.
//
// Что закреплено здесь, по важности:
//   1. ЭКРАН НЕ СЧИТАЕТ САМ. Расклад остатка по партиям приходит готовым
//      (stock_expiry_lots); отбор по товару и поиск ДОЕЗЖАЮТ ДО СЕРВЕРА, а не
//      применяются в браузере поверх обрезанной выборки. Проверяется по
//      аргументам НАСТОЯЩИХ вызовов RPC.
//   2. СТРОКА-ПРИЗНАНИЕ ЕСТЬ НА ЭКРАНЕ. Остаток по партиям — расчёт, а не
//      измерение: количество по партиям нигде не хранится, расход партию не
//      пишет. Убери эту строку — и числа станут выглядеть измеренными, то есть
//      однажды поспорят с полкой и окажутся неправыми.
//   3. БЛИЖАЙШИЙ СРОК ПЕРВЫМ, И У КАЖДОЙ СТРОКИ НАЗВАНО СОСТОЯНИЕ.
//   4. ПУСТОТА ОБЪЯСНЯЕТ, ГДЕ ВВОДИТСЯ СРОК. «Ничего нет» на этом экране почти
//      всегда значит «срок не заполняли при приходе», и человеку нужно знать
//      не факт, а место.
//   5. ДИАЛОГ ВЫДАЧИ ПОКАЗЫВАЕТ ПРЕДУПРЕЖДЕНИЕ И ВСЁ РАВНО ЗАКРЫВАЕТСЯ:
//      владелец сказал предупреждать, а не запрещать.

import { test } from 'node:test';
import assert from 'node:assert';

// ─── минимальный DOM (тот же стенд, что у stock-log.test.mjs) ───────────────
class FakeNode {
    constructor(tag) {
        this.tagName = String(tag).toUpperCase();
        this.style = {}; this.children = []; this.attrs = {};
        this.className = ''; this._text = ''; this._l = {}; this.dataset = {};
        this.value = ''; this.hidden = false; this._parent = null;
    }
    appendChild(c) { if (c && typeof c === 'object') c._parent = this; this.children.push(c); return c; }
    removeChild(c) { const i = this.children.indexOf(c); if (i > -1) this.children.splice(i, 1); if (c) c._parent = null; return c; }
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
const cells = (tr) => findAll(tr, 'TD').map((td) => textOf(td).replace(/\s+/g, ' ').trim());

// ─── «сервер» ───────────────────────────────────────────────────────────────
const rpcCalls = [];
let ANSWER = null;
let ISSUE_ANSWER = null;
let FAIL = null;
const PRODUCTS = [{ id: 7, name: 'Перчатки', code: 'GLV', base_unit: 'уп', consumption_unit: 'шт', consumption_factor: 100, on_hand: 30 }];

globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    let body = {}; try { body = JSON.parse(opts.body || '{}'); } catch { /* not ours */ }
    if (u.startsWith('/api/rpc/')) {
        const name = decodeURIComponent(u.slice('/api/rpc/'.length));
        rpcCalls.push({ name, args: body });
        if (FAIL) return { ok: false, status: 400, json: async () => ({ error: { message: FAIL } }), headers: { getSetCookie: () => [] } };
        const data = name === 'issue_stock_lines' ? ISSUE_ANSWER : ANSWER;
        return { ok: true, status: 200, json: async () => ({ data }), headers: { getSetCookie: () => [] } };
    }
    if (u.startsWith('/api/db')) {
        const data = body.table === 'products' ? PRODUCTS : [];
        return { ok: true, status: 200, json: async () => ({ data, count: data.length }), headers: { getSetCookie: () => [] } };
    }
    return { ok: true, status: 200, json: async () => ({ data: [] }), headers: { getSetCookie: () => [] } };
};

const { renderExpiryTab, expiryQuery, daysCell } = await import('../views/inventory-expiry.js');
const { openStockIssueModal } = await import('../views/stock-issue-modal.js');
const { stockWarningText } = await import('../views/stock-warnings.js');

// Партии в том виде, в каком их отдаёт rpc/expiry.js.
const EXPIRED = {
    product_id: 7, product_name: 'Перчатки', product_code: 'GLV', unit: 'уп',
    batch_no: 'A-1', expiry_date: '2026-09-18', no_expiry: false,
    received_qty: 10, remaining: 10, days_left: -5, state: 'expired',
    supplier_id: 9, supplier_name: 'Медснаб',
};
const SOON = { ...EXPIRED, batch_no: 'B-2', expiry_date: '2026-10-03', remaining: 8, days_left: 10, state: 'soon', supplier_id: null, supplier_name: '' };
const OK = { ...EXPIRED, batch_no: 'C-3', expiry_date: '2027-10-27', remaining: 10, days_left: 400, state: 'ok' };
const NO_DATE = {
    product_id: 8, product_name: 'Бинт', product_code: 'BND', unit: 'шт',
    batch_no: '', expiry_date: '', no_expiry: true,
    received_qty: 30, remaining: 12, days_left: null, state: 'none',
    supplier_id: null, supplier_name: '',
};
const answer = (lots, extra = {}) => ({
    scope: 'all', today: '2026-09-23', soon_days: 30, truncated: false,
    count: lots.length, dated_total: lots.filter((l) => !l.no_expiry).length,
    products: [{ id: 8, name: 'Бинт' }, { id: 7, name: 'Перчатки' }],
    lots, ...extra,
});

async function open({ lots = [], res = null, fail = null } = {}) {
    rpcCalls.length = 0;
    FAIL = fail;
    ANSWER = res || answer(lots);
    const root = mkEl('div');
    await renderExpiryTab(root);
    await settle();
    return root;
}

// ───────────────────────────────────────────────────────────────────────────

test('экран просит ГОТОВЫЙ расклад у сервера, а не собирает его запросом к таблицам', async () => {
    await open({ lots: [EXPIRED, SOON] });
    assert.deepEqual(rpcCalls.map((c) => c.name), ['stock_expiry_lots'],
        'остаток по партиям обязан считать сервер: свой расчёт в браузере разойдётся с предупреждением при выдаче');
    assert.deepEqual(rpcCalls[0].args, {}, 'экран открывается без уцелевшего с прошлого раза отбора');
    assert.deepEqual(expiryQuery(), {});
});

// I2 / SEARCH_DEBOUNCE_V1 — КАЖДЫЙ СИМВОЛ НЕ ПЕРЕСЧИТЫВАЕТ КЛИНИКУ.
//
// better-sqlite3 синхронна: расклад партий блокирует сервер целиком, и поиск
// «на каждый символ» означал бы, что клиника замирает на всё время набора.
// Задержка здесь НЕ СВОЯ — она одна на все поисковые поля программы и живёт в
// ui.js (h() оборачивает 'input' у полей с подсказкой «Поиск…», 500 мс);
// закрепляется она тут потому, что держится на ПОДСКАЗКЕ поля: переименуй её
// кто-нибудь — и поле молча выпадет из общего правила.
test('поиск ждёт паузы в наборе: три символа подряд — ОДИН запрос, а не три', async () => {
    const root = await open({ lots: [EXPIRED] });
    const q = walk(root).find((e) => e.tagName === 'INPUT' && /Поиск/.test(e.attrs.placeholder || ''));
    assert.ok(q, 'поля поиска на экране нет — тест смотрит не туда');

    rpcCalls.length = 0;
    for (const typed of ['п', 'пе', 'пер']) { q.value = typed; q.dispatchEvent({ type: 'input' }); }
    await settle();
    assert.equal(rpcCalls.length, 0, 'запрос ушёл, не дождавшись паузы: набор из трёх символов — три блокировки базы');

    await settle(700);
    assert.equal(rpcCalls.length, 1, 'на три символа ушло запросов: ' + rpcCalls.length);
    assert.equal(rpcCalls[0].args.q, 'пер', 'ушёл не последний набранный текст');
});

test('партии — ближайший срок первым, и у каждой строки названо состояние', async () => {
    const root = await open({ lots: [EXPIRED, SOON, OK, NO_DATE] });
    const r = rows(root);
    assert.equal(r.length, 4);
    assert.deepEqual(r.map((x) => cells(x)[1]), ['A-1', 'B-2', 'C-3', '—'],
        'порядок строк не тот, что прислал сервер: ближайший срок обязан быть первым');
    assert.deepEqual(r.map((x) => cells(x)[5]), ['Просрочено', 'Истекает', 'В порядке', 'Срок не указан']);
    // Остаток — в складских единицах, с единицей; поставщик — если он известен.
    assert.equal(cells(r[0])[3], '10 уп');
    assert.equal(cells(r[0])[6], 'Медснаб');
    assert.equal(cells(r[1])[6], '—');
    // Просрочка названа днями, а не отрицательным числом.
    assert.equal(cells(r[0])[4], 'просрочено на 5 дн.');
    assert.equal(cells(r[1])[4], '10 дн.');
    assert.equal(daysCell(NO_DATE), '—');
});

test('строка-признание: экран называет остаток по партиям РАСЧЁТОМ, а не фактом', async () => {
    const root = await open({ lots: [EXPIRED] });
    assert.match(flat(root),
        /Остаток по партиям — расчёт, а не факт: программа не запоминает, из какой партии товар взяли, и считает, что первым расходуется ближайший срок\./,
        'признание пропало — числа стали выглядеть измеренными, хотя измерить их нечем');
});

test('порог «истекает» назван словами, а не спрятан в цвет', async () => {
    const root = await open({ lots: [SOON] });
    assert.match(flat(root), /«Истекает» — до конца срока осталось 30 дней или меньше\./);
});

test('пустота объясняет, ГДЕ вводится срок, а не сообщает, что его нет', async () => {
    const root = await open({ res: answer([]) });
    assert.match(flat(root), /Сроки годности ещё не заполняли: срок и номер партии указываются при приёме товара на склад, в приходе\./);
    // Остатки без срока есть, а партий со сроком нет — то же объяснение, но
    // строки при этом показаны: прятать остаток нельзя.
    const withUndated = await open({ lots: [NO_DATE] });
    assert.match(flat(withUndated), /Сроки годности ещё не заполняли/);
    assert.equal(rows(withUndated).length, 1);
});

test('отбор по товару и поиск ДОЕЗЖАЮТ до сервера', async () => {
    const root = await open({ lots: [EXPIRED, NO_DATE] });
    const sel = findAll(root, 'SELECT')[0];
    assert.ok(sel, 'фильтра по товару нет');
    assert.deepEqual(findAll(sel, 'OPTION').map((o) => textOf(o).trim()), ['Все товары', 'Бинт', 'Перчатки']);
    rpcCalls.length = 0;
    sel.value = '7';
    sel.dispatchEvent({ type: 'change' });
    await settle();
    assert.deepEqual(rpcCalls.map((c) => c.args), [{ product_id: 7 }],
        'отбор применился в браузере поверх присланного — тогда «все партии товара» это ложь');

    const q = findAll(root, 'INPUT').find((i) => (i.attrs.placeholder || '').startsWith('Поиск'));
    assert.ok(q, 'поиска нет');
    rpcCalls.length = 0;
    q.value = 'перч';
    q.dispatchEvent({ type: 'input' });
    await settle(700);   // поле поиска в программе с задержкой (SEARCH_DEBOUNCE_V1)
    assert.equal(rpcCalls.length, 1);
    assert.equal(rpcCalls[0].args.q, 'перч');
});

test('отказ сервера ВИДЕН: молчание тут читается как «просрочки нет»', async () => {
    const root = await open({ lots: [EXPIRED], fail: 'база недоступна' });
    assert.match(flat(root), /Не удалось загрузить сроки годности\./);
});

// ───────────────────────────────────────────────────────────────────────────
// Диалог выдачи: предупреждение приходит, выдача проходит
// ───────────────────────────────────────────────────────────────────────────

const WARNING = {
    product_id: 7, product_name: 'Перчатки', batch_no: 'A-1', expiry_date: '2026-09-18',
    days_left: -5, remaining: 10, unit: 'уп',
    message: 'Просроченная партия: Перчатки — партия A-1, срок 2026-09-18. Операция проведена; использовать эту партию нельзя.',
};

/** Пройти диалог выдачи до конца: товар, количество, «Проверить», «Подтвердить». */
async function issueThrough(answerBody) {
    ISSUE_ANSWER = answerBody;
    FAIL = null;
    rpcCalls.length = 0;
    BODY.children.length = 0;
    let done = null;
    openStockIssueModal({ holder: { type: 'department', id: 11, name: 'Кардиология' }, onDone: (r) => { done = r; } });
    await settle(60);
    const overlay = BODY.children[BODY.children.length - 1];

    const search = findAll(overlay, 'INPUT').find((i) => (i.attrs.placeholder || '').includes('Название или код'));
    search.value = 'Перч';
    search.dispatchEvent({ type: 'input' });
    await settle(20);
    const pick = walk(overlay).find((e) => e.tagName === 'BUTTON' && e.className === 'sim-drop-item');
    pick.click();
    const qty = findAll(overlay, 'INPUT').find((i) => i.attrs.type === 'number');
    qty.value = '5';
    qty.dispatchEvent({ type: 'input' });

    findBtn(overlay, 'Проверить').click();
    await settle(20);
    findBtn(overlay, 'Подтвердить выдачу').click();
    await settle(60);
    return { overlay, done };
}

test('диалог выдачи ПОКАЗЫВАЕТ предупреждение о просроченной партии — и всё равно закрывается', async () => {
    const { overlay, done } = await issueThrough({ issued: [{ product_id: 7, name: 'Перчатки', base_qty: 5, on_hand: 25 }], warnings: [WARNING] });
    const call = rpcCalls.find((c) => c.name === 'issue_stock_lines');
    assert.ok(call, 'выдача не ушла на сервер');
    assert.ok(done, 'диалог не сообщил об успехе — предупреждение съело выдачу');
    assert.equal(BODY.children.includes(overlay), false,
        'окно осталось открытым: предупреждение превратилось в отказ, а владелец сказал предупреждать');
    const toastEl = BODY.children.find((c) => c.attrs && c.attrs.id === 'toast');
    assert.ok(toastEl, 'плашки с сообщением нет вовсе');
    assert.match(toastEl._text, /Просроченная партия: Перчатки — партия A-1, срок 2026-09-18/,
        'после выдачи на виду осталось «Выдано со склада», а не предупреждение о просрочке');
});

test('выдача без просрочки ничего лишнего не говорит', async () => {
    const { overlay, done } = await issueThrough({ issued: [{ product_id: 7, name: 'Перчатки', base_qty: 5, on_hand: 25 }], warnings: [] });
    assert.ok(done);
    assert.equal(BODY.children.includes(overlay), false);
    const toastEl = BODY.children.find((c) => c.attrs && c.attrs.id === 'toast');
    assert.equal(toastEl._text, 'Выдано со склада');
    assert.equal(stockWarningText({ warnings: [] }), '');
    assert.equal(stockWarningText(null), '');
});
