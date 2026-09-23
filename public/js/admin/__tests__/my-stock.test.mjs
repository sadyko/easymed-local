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
/** Строки одной таблицы экрана (0 — «на руках», 1 — «выдали мне», 2 — «списал я»). */
const tableRows = (root, i) => findAll(findAll(root, 'TABLE')[i], 'TR').filter((tr) => findAll(tr, 'TD').length);
const cells = (tr) => findAll(tr, 'TD').map((td) => textOf(td).replace(/\s+/g, ' ').trim());

// ─── «сервер» ───────────────────────────────────────────────────────────────
const rpcCalls = [];
let HELD = null;      // ответ holdings_list
let ISSUED = null;    // ответ stock_movements_list kind=issue
let SPENT = null;     // ответ stock_movements_list kind=dispense
let FAIL = null;      // имя RPC, который «сломался» (или true — все)

globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    let body = {}; try { body = JSON.parse(opts.body || '{}'); } catch { /* not ours */ }
    if (u.startsWith('/api/rpc/')) {
        const name = decodeURIComponent(u.slice('/api/rpc/'.length));
        rpcCalls.push({ name, args: body });
        const broken = FAIL === true || FAIL === name || (FAIL && FAIL === name + ':' + body.kind);
        if (broken) return { ok: false, status: 400, json: async () => ({ error: { message: 'база недоступна' } }), headers: { getSetCookie: () => [] } };
        const data = name === 'holdings_list' ? HELD : (body.kind === 'issue' ? ISSUED : SPENT);
        return { ok: true, status: 200, json: async () => ({ data }), headers: { getSetCookie: () => [] } };
    }
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

async function open({ held = [], issued = [], spent = [], fail = null, user = NURSE } = {}) {
    rpcCalls.length = 0;
    FAIL = fail;
    HELD = { holdings: held };
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

test('три вопроса — три запроса к серверу, и «своё» просит сам запрос, а не отбор в браузере', async () => {
    await open({ held: [HOLDING], issued: [TO_ME], spent: [BY_ME] });
    assert.deepEqual(rpcCalls.map((c) => c.name), ['holdings_list', 'stock_movements_list', 'stock_movements_list'],
        'экран обязан спрашивать готовые ответы, а не собирать их запросом к таблицам');
    assert.deepEqual(rpcCalls[0].args, { mine: true },
        'остатки просятся БЕЗ имени держателя: имя берёт сервер из сессии');
    assert.deepEqual(rpcCalls[1].args, { kind: 'issue', only: 'to_me', limit: 50 });
    assert.deepEqual(rpcCalls[2].args, { kind: 'dispense', only: 'by_me', limit: 50 });
    // Тот же набор вопросов, названный отдельно, — чтобы он не разошёлся с кодом.
    assert.deepEqual(myStockQueries({ issued: 50, spent: 50 }).map(([n]) => n),
        ['holdings_list', 'stock_movements_list', 'stock_movements_list']);
});

test('три блока в порядке решения: что у меня есть, что мне выдали, что я списал', async () => {
    const root = await open({ held: [HOLDING], issued: [TO_ME], spent: [BY_ME] });
    const heads = findAll(root, 'H3').map(labelOf);
    assert.deepEqual(heads, ['Что у меня на руках', 'Что мне выдали', 'Что я списал на пациентов']);
    const ths = findAll(root, 'TABLE').map((t) => findAll(t, 'TH').map((th) => textOf(th).trim()));
    assert.deepEqual(ths, [
        ['Товар', 'Осталось'],
        ['Когда', 'Товар', 'Сколько', 'Кто выдал', 'Основание'],
        ['Когда', 'Товар', 'Сколько', 'Пациент', 'Основание'],
    ]);
});

test('на руках: остаток в своих единицах, а рядом — в складских, иначе спорят «у меня 300, а у вас 3»', async () => {
    const root = await open({ held: [HOLDING, SIMPLE_HOLDING] });
    const rows = tableRows(root, 0);
    assert.equal(rows.length, 2);
    assert.deepEqual(cells(rows[0]), ['Перчатки', '300 шт 3 уп']);
    assert.deepEqual(cells(rows[1]), ['Бинт', '5 шт'], 'когда единица одна, вторую строку писать незачем');
});

test('«Что мне выдали» называет ВЫДАВШЕГО и причину — ради этих двух колонок экран и написан', async () => {
    const root = await open({ issued: [TO_ME] });
    const row = tableRows(root, 1)[0];
    const c = cells(row);
    assert.equal(c[3], 'Кладовщик Каримов', 'кто выдал — имя, а не прочерк');
    assert.equal(c[4], 'на неделю', 'причина выдачи потерялась');
    // Выдача без причины показывает прочерк, а не пустоту.
    const bare = await open({ issued: [{ ...TO_ME, note: '' }] });
    assert.equal(cells(tableRows(bare, 1)[0])[4], '—');
});

test('количество показано глазами получателя: выдали ПЯТЬ упаковок, а не «минус пять»', async () => {
    const root = await open({ issued: [TO_ME], spent: [BY_ME] });
    assert.equal(cells(tableRows(root, 1)[0])[2], '5 уп');
    assert.equal(gotQty({ qty: -5, unit: 'уп' }), '5 уп');
    assert.equal(/-|−/.test(textOf(findAll(root, 'TABLE')[1])), false,
        'на своём экране минус склада читается как ошибка');
});

test('строка расхода называет ПАЦИЕНТА — иначе это не отчёт, а загадка', async () => {
    const root = await open({ spent: [BY_ME] });
    const c = cells(tableRows(root, 2)[0]);
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
