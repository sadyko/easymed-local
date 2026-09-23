// MY_STOCK_V1 — «МОИ ЗАПАСЫ»: ЧТО ЭКРАН ОБЯЗАН ПОКАЗАТЬ И ЧЕГО НЕ ДЕЛАЕТ.
//
// Что закреплено здесь и почему именно это:
//   1. ТРИ ВОПРОСА — ТРИ ЗАПРОСА К СЕРВЕРУ, И ОБЛАСТЬ СЧИТАЕТ СЕРВЕР. Экран не
//      просит общий список, чтобы выбрать из него своё: остатки спрашиваются с
//      `mine`, движения — с сужением `only`. Проверяется по аргументам
//      НАСТОЯЩИХ вызовов RPC, а не по тому, что нарисовано.
//   2. КТО ВЫДАЛ И ПОЧЕМУ. Ради этих двух колонок экран и написан: до него
//      вопрос «кто мне это выдал» решался звонком на склад.
//   3. РАСХОД НАЗЫВАЕТ ПАЦИЕНТА. Строка «минус 2» без имени не отчёт, а загадка.
//   4. ЗНАК — НЕ ЧУЖОЙ. В журнале склада выдача записана отрицательной (склада
//      стало меньше); человеку выдали ПЯТЬ упаковок, и «−5» на своём экране
//      читается как ошибка.
//   5. ПУСТОТА ГОВОРИТ СЛОВАМИ, каждая своими: «вам ничего не выдавали» и «на
//      руках ничего не числится» — разные новости.
//   6. ОБРЕЗАННЫЙ СПИСОК ГОВОРИТ, ЧТО ОН ОБРЕЗАН.
//   7. ОТКАЗ СЕРВЕРА ВИДЕН. Молчание здесь читается как «мне ничего не
//      выдавали» — то есть как спор со складом, которого не было.
//   8. «МОЙ ОТДЕЛ» — ТОЛЬКО ТОМУ, У КОГО ОТДЕЛ ЕСТЬ.
//   9. STOCK_REQUEST_V1 (R2): «Запросить» — себе или своему отделу, точные
//      аргументы stock_request_create; минимум и норма у каждой строки «на
//      руках», «ниже минимума» — цветом предупреждения, открытая заявка с
//      пометкой «авто»; правка и снятие минимума — stock_minimum_set/clear
//      в единицах расхода; «Мои заявки»; отказы сервера видны.

import { test } from 'node:test';
import assert from 'node:assert';

// ─── минимальный DOM (тот же стенд, что у stock-log.test.mjs) ───────────────
class FakeNode {
    constructor(tag) {
        this.tagName = String(tag).toUpperCase();
        this.style = {}; this.children = []; this.attrs = {};
        this.className = ''; this._text = ''; this._l = {}; this.dataset = {};
        this.value = '';
    }
    appendChild(c) { this.children.push(c); return c; }
    removeChild(c) { const i = this.children.indexOf(c); if (i > -1) this.children.splice(i, 1); return c; }
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
    remove() {}
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
// Вошедшая — медсестра Кардиологии (отдел 11): у неё есть и подотчёт, и отдел.
const NURSE = { id: 4, role: 'nurse', full_name: 'Медсестра Алиева', department_id: 11 };
globalThis.window = { location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, addEventListener() {}, open: () => null,
    easymed: { state: { user: { ...NURSE } } }, confirm: () => true };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();

const walk = (e, out = []) => { if (!e || typeof e !== 'object') return out; out.push(e); for (const c of e.children || []) walk(c, out); return out; };
const textOf = (e) => walk(e).map((x) => x._text || '').join(' ');
/** Подпись так, как её читает человек: значок — не текст (он рисуется разметкой SVG). */
const labelOf = (e) => walk(e).filter((x) => x.tagName !== 'SVG').map((x) => x._text || '').join(' ').replace(/\s+/g, ' ').trim();
const findAll = (root, tag) => walk(root).filter((e) => e.tagName === tag);
const findBtn = (root, label) => walk(root).find((e) => e.tagName === 'BUTTON' && textOf(e).includes(label));
const settle = () => new Promise((r) => setTimeout(r, 30));
/** Строки одной таблицы экрана (0 — «на руках», 1 — «мои заявки», 2 — «выдали мне», 3 — «списал я»). */
const T = { held: 0, req: 1, issued: 2, spent: 3 };
const tableRows = (root, i) => findAll(findAll(root, 'TABLE')[i], 'TR').filter((tr) => findAll(tr, 'TD').length);
const cells = (tr) => findAll(tr, 'TD').map(labelOf);   // значок — не текст

// ─── «сервер» ───────────────────────────────────────────────────────────────
const rpcCalls = [];
let HELD = null;      // ответ holdings_list
let ISSUED = null;    // ответ stock_movements_list kind=issue
let SPENT = null;     // ответ stock_movements_list kind=dispense
let FAIL = null;      // имя RPC, который «сломался» (или true — все)
let FAIL_MSG = 'база недоступна';
let MINS = null;      // ответ stock_minimums_list
let MYREQ = null;     // ответ stock_requests_mine
let SET_RES = null;   // ответ stock_minimum_set
let PRODUCTS = [];    // ответ /api/db products

const ANSWERS = {
    holdings_list: () => HELD,
    stock_minimums_list: () => MINS,
    stock_requests_mine: () => MYREQ,
    stock_minimum_set: () => SET_RES,
    stock_minimum_clear: () => ({ ok: true, removed: 1 }),
    stock_request_create: (b) => ({ req_id: 77, req_number: 'REQ-20260923-007', status: 'submitted', holder_type: b.for === 'me' ? 'staff' : 'department', holder_id: b.for === 'me' ? 4 : 11 }),
};

globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    let body = {}; try { body = JSON.parse(opts.body || '{}'); } catch { /* not ours */ }
    if (u.startsWith('/api/rpc/')) {
        const name = decodeURIComponent(u.slice('/api/rpc/'.length));
        rpcCalls.push({ name, args: body });
        const broken = FAIL === true || FAIL === name || (FAIL && FAIL === name + ':' + body.kind);
        if (broken) return { ok: false, status: 400, json: async () => ({ error: { message: FAIL_MSG } }), headers: { getSetCookie: () => [] } };
        const data = ANSWERS[name] ? ANSWERS[name](body) : (body.kind === 'issue' ? ISSUED : SPENT);
        return { ok: true, status: 200, json: async () => ({ data }), headers: { getSetCookie: () => [] } };
    }
    if (body && body.table === 'products') return { ok: true, status: 200, json: async () => ({ data: PRODUCTS }), headers: { getSetCookie: () => [] } };
    return { ok: true, status: 200, json: async () => ({ data: [] }), headers: { getSetCookie: () => [] } };
};

const { renderMyStock, myStockQueries, gotQty } = await import('../views/my-stock.js');

// Строки в том виде, в каком их отдают rpc/holdings.js и rpc/stock-log.js.
const HOLDING = {
    holder_type: 'staff', holder_id: 4, holder_name: 'Медсестра Алиева',
    product_id: 7, product_name: 'Перчатки', base_unit: 'уп', consumption_unit: 'шт',
    consumption_factor: 100, sale_price: 500, qty_base: 3, qty_units: 300,
};
const SIMPLE_HOLDING = { ...HOLDING, product_id: 8, product_name: 'Бинт', base_unit: 'шт', consumption_unit: 'шт', consumption_factor: 1, qty_base: 5, qty_units: 5 };
const TO_ME = {
    id: 2, created_at: '2026-09-21T09:00:00Z', kind: 'dispense', view_kind: 'issue',
    reference_type: 'issue', reference_id: null,
    product_id: 7, product_name: 'Перчатки', unit: 'уп', qty: -5, unit_cost: 20000, note: 'на неделю',
    actor_id: 2, actor_name: 'Кладовщик Каримов',
    holder_type: 'staff', holder_id: 4, holder_name: 'Медсестра Алиева',
    batch_no: '', expiry_date: '', patient_name: '',
};
const BY_ME = {
    id: 5, created_at: '2026-09-21T10:00:00Z', kind: 'dispense', view_kind: 'dispense',
    reference_type: 'visit', reference_id: 900,
    product_id: 7, product_name: 'Перчатки', unit: 'уп', qty: -0.02, unit_cost: 20000, note: 'перевязка',
    actor_id: 4, actor_name: 'Медсестра Алиева',
    holder_type: 'staff', holder_id: 4, holder_name: 'Медсестра Алиева',
    batch_no: '', expiry_date: '', patient_name: 'Сидоров Сидор',
};

const journal = (movements, extra = {}) => ({
    scope: 'own', departments: [], limit: 50, offset: 0, truncated: false,
    count: movements.length, movements, ...extra,
});

async function open({ held = [], issued = [], spent = [], fail = null, user = NURSE, mins = [], myreq = [], failMsg = 'база недоступна' } = {}) {
    rpcCalls.length = 0;
    BODY.children.length = 0;
    FAIL = fail; FAIL_MSG = failMsg;
    HELD = { holdings: held };
    MINS = { scope: 'mine', can_manage_all: false, rows: mins };
    MYREQ = { rows: myreq };
    ISSUED = Array.isArray(issued) ? journal(issued) : issued;
    SPENT = Array.isArray(spent) ? journal(spent) : spent;
    globalThis.window.easymed.state.user = { ...user };
    const root = mkEl('div');
    await renderMyStock(root, { onNavigate: (v) => navigated.push(v) });
    await settle();
    return root;
}
const navigated = [];

// ───────────────────────────────────────────────────────────────────────────

test('вопросы экрана — запросы к серверу, и «своё» просит сам запрос, а не отбор в браузере', async () => {
    await open({ held: [HOLDING], issued: [TO_ME], spent: [BY_ME] });
    const NAMES = ['holdings_list', 'stock_minimums_list', 'stock_requests_mine', 'stock_movements_list', 'stock_movements_list'];
    assert.deepEqual(rpcCalls.map((c) => c.name), NAMES,
        'экран обязан спрашивать готовые ответы, а не собирать их запросом к таблицам');
    assert.deepEqual(rpcCalls[0].args, { mine: true },
        'остатки просятся БЕЗ имени держателя: имя берёт сервер из сессии');
    assert.deepEqual(rpcCalls[1].args, { scope: 'mine' }, 'минимумы — свои, область считает сервер');
    assert.deepEqual(rpcCalls[2].args, {});
    assert.deepEqual(rpcCalls[3].args, { kind: 'issue', only: 'to_me', limit: 50 });
    assert.deepEqual(rpcCalls[4].args, { kind: 'dispense', only: 'by_me', limit: 50 });
    // Тот же набор вопросов, названный отдельно, — чтобы он не разошёлся с кодом.
    assert.deepEqual(myStockQueries({ issued: 50, spent: 50 }).map(([n]) => n), NAMES);
});

test('блоки в порядке решения: что у меня есть, что я запросил, что мне выдали, что я списал', async () => {
    const root = await open({ held: [HOLDING], issued: [TO_ME], spent: [BY_ME] });
    const heads = findAll(root, 'H3').map(labelOf);
    assert.deepEqual(heads, ['Что у меня на руках', 'Мои заявки', 'Что мне выдали', 'Что я списал на пациентов']);
    const ths = findAll(root, 'TABLE').map((t) => findAll(t, 'TH').map((th) => textOf(th).trim()));
    assert.deepEqual(ths, [
        ['Товар', 'Осталось', 'Минимум', 'Норма', 'Заявка', ''],
        ['Номер', 'Что', 'Для кого', 'Статус', 'Когда'],
        ['Когда', 'Товар', 'Сколько', 'Кто выдал', 'Основание'],
        ['Когда', 'Товар', 'Сколько', 'Пациент', 'Основание'],
    ]);
});

test('на руках: остаток в своих единицах, а рядом — в складских, иначе спорят «у меня 300, а у вас 3»', async () => {
    const root = await open({ held: [HOLDING, SIMPLE_HOLDING] });
    const rows = tableRows(root, T.held);
    assert.equal(rows.length, 2);
    assert.deepEqual(cells(rows[0]).slice(0, 2), ['Перчатки', '300 шт 3 уп']);
    assert.deepEqual(cells(rows[1]).slice(0, 2), ['Бинт', '5 шт'], 'когда единица одна, вторую строку писать незачем');
    assert.deepEqual(cells(rows[1]).slice(2), ['—', '—', '—', 'Задать минимум'], 'без минимума — прочерки и кнопка его задать');
});

test('«Что мне выдали» называет ВЫДАВШЕГО и причину — ради этих двух колонок экран и написан', async () => {
    const root = await open({ issued: [TO_ME] });
    const row = tableRows(root, T.issued)[0];
    const c = cells(row);
    assert.equal(c[3], 'Кладовщик Каримов', 'кто выдал — имя, а не прочерк');
    assert.equal(c[4], 'на неделю', 'причина выдачи потерялась');
    // Выдача без причины показывает прочерк, а не пустоту.
    const bare = await open({ issued: [{ ...TO_ME, note: '' }] });
    assert.equal(cells(tableRows(bare, T.issued)[0])[4], '—');
});

test('количество показано глазами получателя: выдали ПЯТЬ упаковок, а не «минус пять»', async () => {
    const root = await open({ issued: [TO_ME], spent: [BY_ME] });
    assert.equal(cells(tableRows(root, T.issued)[0])[2], '5 уп');
    assert.equal(gotQty({ qty: -5, unit: 'уп' }), '5 уп');
    assert.equal(/-|−/.test(textOf(findAll(root, 'TABLE')[T.issued])), false,
        'на своём экране минус склада читается как ошибка');
});

test('строка расхода называет ПАЦИЕНТА — иначе это не отчёт, а загадка', async () => {
    const root = await open({ spent: [BY_ME] });
    const c = cells(tableRows(root, T.spent)[0]);
    assert.equal(c[3], 'Сидоров Сидор');
    assert.equal(c[4], 'перевязка');
});

test('пустота говорит словами, и каждая — своими', async () => {
    const root = await open({});
    const t = textOf(root);
    assert.match(t, /На руках у вас ничего не числится/);
    assert.match(t, /Вам ничего не выдавали/);
    assert.match(t, /Вы ещё ничего не списывали на пациентов/);
});

test('обрезанный список говорит, что он обрезан, и просит следующую порцию', async () => {
    const root = await open({ issued: journal([TO_ME, TO_ME], { truncated: true, count: 2 }) });
    assert.match(textOf(root).replace(/\s+/g, ' '), /Показаны последние 2 — список длиннее/);
    const more = findBtn(root, 'Показать ещё');
    assert.ok(more, 'кнопки «Показать ещё» нет — список обрезан, а идти дальше некуда');
    rpcCalls.length = 0;
    more.click();
    await settle();
    const again = rpcCalls.find((c) => c.args && c.args.kind === 'issue');
    assert.equal(again.args.limit, 100, 'кнопка должна просить следующую порцию именно этого списка');
    assert.equal(rpcCalls.find((c) => c.args && c.args.kind === 'dispense').args.limit, 50,
        'соседний список расширять никто не просил');
});

test('отказ сервера ВИДЕН: молчание здесь читается как «мне ничего не выдавали»', async () => {
    const root = await open({ held: [HOLDING], spent: [BY_ME], fail: 'stock_movements_list:issue' });
    assert.match(textOf(root), /Не удалось загрузить выдачи/);
    // Остальные блоки при этом живы — отказ одного вопроса не гасит экран.
    assert.match(textOf(root), /Перчатки/);
    assert.equal(/Вам ничего не выдавали/.test(textOf(root)), false,
        'отказ сервера нарисован как «ничего не выдавали» — это и есть молчаливая ложь');

    const all = await open({ fail: true });
    assert.match(textOf(all), /Не удалось загрузить ваши остатки/);
    assert.match(textOf(all), /Не удалось загрузить списания/);
});

test('«Мой отдел» — только тому, у кого отдел есть, и ведёт на карточку отдела', async () => {
    const root = await open({});
    const btn = findBtn(root, 'Мой отдел');
    assert.ok(btn, 'у медсестры отделения нет пути на карточку своего отдела');
    navigated.length = 0;
    btn.click();
    assert.deepEqual(navigated, ['my-department']);

    const loner = await open({ user: { id: 9, role: 'doctor', full_name: 'Врач Без Отдела', department_id: null } });
    assert.equal(findBtn(loner, 'Мой отдел'), undefined,
        'кнопка «Мой отдел» у человека без отдела ведёт в чужой справочник');
});

// ─── STOCK_REQUEST_V1 (R2): заявка, минимумы, «Мои заявки» ───────────────────

// Строка stock_minimums_list в том виде, в каком её отдаёт rpc/stock-requests.js.
const MIN_GLOVES = {
    holder_type: 'staff', holder_id: 4, holder_name: 'Медсестра Алиева',
    product_id: 7, product_name: 'Перчатки', base_unit: 'уп', consumption_unit: 'шт', consumption_factor: 100,
    held_qty: 3, held_units: 300, min_qty: 5, min_units: 500, target_qty: 10, target_units: 1000,
    below_min: true, set_by: 4, set_by_name: 'Медсестра Алиева', updated_at: '2026-09-23T08:00:00Z', can_edit: true,
    open_qty: 7, open_request: { req_id: 50, req_number: 'REQ-20260923-004', status: 'submitted', qty: 7, auto: true },
};
// Минимум на товар, которого на руках нет вовсе.
const MIN_SYRINGE = {
    ...MIN_GLOVES, product_id: 9, product_name: 'Шприц', base_unit: 'шт', consumption_unit: 'шт', consumption_factor: 1,
    held_qty: 0, held_units: 0, min_qty: 10, min_units: 10, target_qty: 20, target_units: 20,
    below_min: true, open_qty: 0, open_request: null,
};
const PRODUCT_LIST = [
    { id: 7, name: 'Перчатки', code: 'GL', base_unit: 'уп', consumption_unit: 'шт', consumption_factor: 100, on_hand: 40 },
    { id: 9, name: 'Шприц', code: 'SY', base_unit: 'шт', consumption_unit: 'шт', consumption_factor: 1, on_hand: 300 },
];

const lastModal = () => [...BODY.children].reverse().find((c) => String(c.className).split(/\s+/).includes('modal'));
const byLabel = (root, label) => walk(root).find((e) => e.attrs && e.attrs['aria-label'] === label);
const toastText = () => { const t = BODY.children.find((c) => c.attrs && c.attrs.id === 'toast'); return t ? textOf(t).replace(/\s+/g, ' ').trim() : ''; };
const type = (inp, v) => { inp.value = String(v); inp.dispatchEvent({ type: 'input', target: inp, currentTarget: inp }); };
async function pickProduct(modal, q, name) {
    const search = walk(modal).find((e) => e.tagName === 'INPUT' && e.attrs.type === 'text' && e.attrs.placeholder && /товар/i.test(e.attrs.placeholder));
    assert.ok(search, 'в диалоге нет поиска товара');
    type(search, q);
    const item = walk(modal).find((e) => e.tagName === 'BUTTON' && String(e.className).includes('sim-drop-item') && textOf(e).includes(name));
    assert.ok(item, `поиск не нашёл «${name}»`);
    item.click();
}

test('минимум и норма у строки «на руках»: ниже минимума — цветом предупреждения, открытая заявка — с пометкой «авто»', async () => {
    const root = await open({ held: [HOLDING], mins: [MIN_GLOVES, MIN_SYRINGE] });
    const rows = tableRows(root, T.held);
    assert.equal(rows.length, 2, 'товар с минимумом, но без остатка, тоже строка — иначе минимум некуда показать');
    assert.deepEqual(cells(rows[0]), ['Перчатки', '300 шт 3 уп', '500 шт ниже минимума', '1000 шт', 'заявка REQ-20260923-004 на 700 шт, авто', 'Изменить'],
        'всё — в единицах расхода: медсестра считает штуки, а не упаковки');
    const tag = walk(rows[0]).find((e) => String(e.className).includes('tag-warn'));
    assert.ok(tag && textOf(tag).includes('ниже минимума'), '«ниже минимума» не выделено цветом предупреждения');
    assert.deepEqual(cells(rows[1]).slice(0, 5), ['Шприц', '0 шт', '10 шт ниже минимума', '20 шт', '—']);
    // Не ниже минимума — без пометки.
    const ok = await open({ held: [HOLDING], mins: [{ ...MIN_GLOVES, below_min: false, open_request: null }] });
    assert.equal(walk(ok).some((e) => String(e.className).includes('tag-warn')), false);
    assert.equal(cells(tableRows(ok, T.held)[0])[2], '500 шт');
});

test('правка минимума: stock_minimum_set в единицах расхода, поданная заявка — в сообщении', async () => {
    const root = await open({ held: [HOLDING], mins: [MIN_GLOVES] });
    findBtn(tableRows(root, T.held)[0], 'Изменить').click();
    const modal = lastModal();
    assert.ok(modal, 'диалог минимума не открылся');
    const min = byLabel(modal, 'Минимум'); const target = byLabel(modal, 'Норма');
    assert.equal(min.value, '500', 'минимум подставлен в штуках');
    assert.equal(target.value, '1000');
    type(min, 600); type(target, 1200);
    SET_RES = { minimum: {}, request: { req_id: 51, req_number: 'REQ-20260923-005', qty: 9 } };
    rpcCalls.length = 0;
    findBtn(modal, 'Сохранить').click();
    await settle();
    const call = rpcCalls.find((c) => c.name === 'stock_minimum_set');
    assert.deepEqual(call.args, { holder_type: 'staff', holder_id: 4, product_id: 7, min_qty: 600, target_qty: 1200, unit: 'consumption' });
    assert.match(toastText(), /Подана заявка REQ-20260923-005 на 900 шт/, 'автозаявка при установке не названа');
    assert.ok(rpcCalls.some((c) => c.name === 'holdings_list'), 'после сохранения экран не перечитан');
});

test('снять минимум — stock_minimum_clear', async () => {
    const root = await open({ held: [HOLDING], mins: [MIN_GLOVES] });
    findBtn(tableRows(root, T.held)[0], 'Изменить').click();
    rpcCalls.length = 0;
    findBtn(lastModal(), 'Снять минимум').click();
    await settle();
    assert.deepEqual(rpcCalls.find((c) => c.name === 'stock_minimum_clear').args, { holder_type: 'staff', holder_id: 4, product_id: 7 });
    assert.match(toastText(), /Минимум снят/);
});

test('отказ сервера при установке минимума виден его словами, диалог остаётся открытым', async () => {
    const root = await open({ held: [HOLDING], mins: [MIN_GLOVES] });
    findBtn(tableRows(root, T.held)[0], 'Изменить').click();
    const modal = lastModal();
    FAIL = 'stock_minimum_set'; FAIL_MSG = 'Минимум можно ставить себе.';
    findBtn(modal, 'Сохранить').click();
    await settle();
    assert.match(toastText(), /Минимум можно ставить себе/);
    assert.match(textOf(modal), /Минимум можно ставить себе/, 'в самом диалоге отказа не видно');
    assert.equal(lastModal(), modal, 'диалог закрылся, будто всё сохранено');
    // Норма меньше минимума ловится до сервера.
    FAIL = null; rpcCalls.length = 0;
    type(byLabel(modal, 'Минимум'), 50); type(byLabel(modal, 'Норма'), 10);
    findBtn(modal, 'Сохранить').click();
    await settle();
    assert.equal(rpcCalls.some((c) => c.name === 'stock_minimum_set'), false);
    assert.match(toastText(), /Норма не может быть меньше минимума/);
});

test('минимумы не загрузились — сказано словами, остатки на месте', async () => {
    const root = await open({ held: [HOLDING], fail: 'stock_minimums_list' });
    assert.match(textOf(root), /Не удалось загрузить минимумы/);
    assert.match(textOf(root), /Перчатки/);
});

test('«Добавить минимум» — на товар, которого на руках ещё нет (тот же поиск товара)', async () => {
    PRODUCTS = PRODUCT_LIST;
    const root = await open({ held: [HOLDING] });
    findBtn(root, 'Добавить минимум').click();
    await settle();
    const modal = lastModal();
    await pickProduct(modal, 'Шпр', 'Шприц');
    type(byLabel(modal, 'Минимум'), 10); type(byLabel(modal, 'Норма'), 20);
    SET_RES = { minimum: {}, request: null };
    rpcCalls.length = 0;
    findBtn(modal, 'Сохранить').click();
    await settle();
    assert.deepEqual(rpcCalls.find((c) => c.name === 'stock_minimum_set').args,
        { holder_type: 'staff', holder_id: 4, product_id: 9, min_qty: 10, target_qty: 20, unit: 'consumption' });
    assert.match(toastText(), /Минимум сохранён/);
});

test('«Запросить» себе: точные аргументы stock_request_create и номер заявки в сообщении', async () => {
    PRODUCTS = PRODUCT_LIST;
    const root = await open({ held: [HOLDING] });
    findBtn(root, 'Запросить').click();
    await settle();
    const modal = lastModal();
    const forSel = byLabel(modal, 'Для кого');
    assert.ok(forSel, 'у медсестры отдела нет выбора «для кого»');
    assert.deepEqual(findAll(forSel, 'OPTION').map((o) => o.attrs.value), ['me', 'department']);
    await pickProduct(modal, 'Перч', 'Перчатки');
    type(byLabel(modal, 'Количество'), 30);
    assert.match(textOf(modal), /шт/, 'единица строки не показана');
    type(byLabel(modal, 'Примечание'), 'на смену');
    rpcCalls.length = 0;
    findBtn(modal, 'Подать заявку').click();
    await settle();
    assert.deepEqual(rpcCalls.find((c) => c.name === 'stock_request_create').args,
        { for: 'me', notes: 'на смену', lines: [{ product_id: 7, qty: 30, unit: 'consumption' }] });
    assert.match(toastText(), /REQ-20260923-007/);
    assert.ok(rpcCalls.some((c) => c.name === 'stock_requests_mine'), '«Мои заявки» не перечитаны после подачи');
});

test('«Запросить» для отдела: свой отдел; без отдела такого выбора нет', async () => {
    PRODUCTS = PRODUCT_LIST;
    const root = await open({ held: [HOLDING] });
    findBtn(root, 'Запросить').click();
    await settle();
    const modal = lastModal();
    const forSel = byLabel(modal, 'Для кого');
    forSel.value = 'department';
    forSel.dispatchEvent({ type: 'change', target: forSel });
    await pickProduct(modal, 'Шпр', 'Шприц');
    type(byLabel(modal, 'Количество'), 5);
    rpcCalls.length = 0;
    findBtn(modal, 'Подать заявку').click();
    await settle();
    assert.deepEqual(rpcCalls.find((c) => c.name === 'stock_request_create').args,
        { for: 'department', department_id: 11, lines: [{ product_id: 9, qty: 5, unit: 'consumption' }] });

    const loner = await open({ user: { id: 9, role: 'doctor', full_name: 'Врач Без Отдела', department_id: null } });
    findBtn(loner, 'Запросить').click();
    await settle();
    const m2 = lastModal();
    assert.equal(byLabel(m2, 'Для кого'), undefined, 'человеку без отдела предложено просить для отдела');
    assert.equal(/Для отдела/.test(textOf(m2)), false);
});

test('ошибка подачи заявки видна, диалог не закрывается', async () => {
    PRODUCTS = PRODUCT_LIST;
    const root = await open({ held: [HOLDING] });
    findBtn(root, 'Запросить').click();
    await settle();
    const modal = lastModal();
    await pickProduct(modal, 'Перч', 'Перчатки');
    type(byLabel(modal, 'Количество'), 3);
    FAIL = 'stock_request_create'; FAIL_MSG = 'Подавать заявки на склад вашей роли нельзя.';
    findBtn(modal, 'Подать заявку').click();
    await settle();
    assert.match(toastText(), /вашей роли нельзя/);
    assert.equal(lastModal(), modal);
});

test('«Мои заявки»: номер, что, для кого, статус и «авто»; пусто и отказ — словами', async () => {
    const myreq = [
        { req_id: 50, req_number: 'REQ-20260923-004', status: 'submitted', auto: true, created_at: '2026-09-23T08:00:00Z', notes: '',
            holder_type: 'staff', holder_id: 4, holder_name: 'Медсестра Алиева',
            lines: [{ product_id: 7, product_name: 'Перчатки', qty: 7, units: 700, unit: 'шт' }] },
        { req_id: 49, req_number: 'REQ-20260923-003', status: 'approved', auto: false, created_at: '2026-09-23T07:00:00Z', notes: '',
            holder_type: 'department', holder_id: 11, holder_name: 'Кардиология',
            lines: [{ product_id: 9, product_name: 'Шприц', qty: 5, units: 5, unit: 'шт' }, { product_id: 7, product_name: 'Перчатки', qty: 1, units: 100, unit: 'шт' }] },
    ];
    const root = await open({ myreq });
    const rows = tableRows(root, T.req);
    assert.equal(rows.length, 2);
    const a = cells(rows[0]); const b = cells(rows[1]);
    assert.equal(a[0], 'REQ-20260923-004 авто');
    assert.equal(a[1], 'Перчатки — 700 шт');
    assert.equal(a[2], 'Себе');
    assert.equal(a[3], 'Подана');
    assert.equal(b[0], 'REQ-20260923-003');
    assert.equal(b[1], 'Шприц — 5 шт; Перчатки — 100 шт');
    assert.equal(b[2], 'Кардиология');
    assert.equal(b[3], 'Согласована');

    const empty = await open({});
    assert.match(textOf(empty), /Открытых заявок нет/);
    const broken = await open({ fail: 'stock_requests_mine' });
    assert.match(textOf(broken), /Не удалось загрузить ваши заявки/);
});
