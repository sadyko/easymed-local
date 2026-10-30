// REFUND_ANY_V1 (2026-10-29) — ВОЗВРАТ ЛЮБОЙ УСЛУГИ: КАССА.
//
// Сервер возврат сделанной работы не запрещает — до него было не дойти.
// Здесь экран:
//   • поиск кассы спрашивает сервер по всем дням (cashier_invoice_search) и
//     рисует найденное блоком «Счета за все дни»; «Платежи» открывает полное
//     окно счёта (с «Вернуть услугу»);
//   • строки «Истории операций» открывают то же окно;
//   • окно «Платежи» открывается и не из кассы (окно визита):
//     openInvoiceRefundById(…, { onDone }) — после возврата перечитывается
//     вызвавший экран, а не касса.
// Заглушка документа — та же, что у cashier-unbilled.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert';

class FakeNode {
    constructor(tag) {
        this.tagName = String(tag).toUpperCase();
        this.style = {}; this.children = []; this.attrs = {};
        this.className = ''; this._text = ''; this._l = {}; this.dataset = {}; this.value = '';
    }
    appendChild(c) { this.children.push(c); return c; }
    removeChild(c) { const i = this.children.indexOf(c); if (i > -1) this.children.splice(i, 1); return c; }
    get firstChild() { return this.children.length ? this.children[0] : null; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); }
    addEventListener(t, fn) { (this._l[t] || (this._l[t] = [])).push(fn); }
    removeEventListener() {}
    fire(t) { for (const fn of this._l[t] || []) fn.call(this, { currentTarget: this, target: this, preventDefault() {}, stopPropagation() {} }); }
    click() { this.fire('click'); }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    setSelectionRange() {}
    focus() {}
    remove() { document.body.children = document.body.children.filter((c) => c !== this); }
    get textContent() { return this._text; }
    set textContent(v) { this._text = String(v); this.children.length = 0; }
    get classList() {
        const s = this;
        return { contains: (c) => String(s.className).split(/\s+/).includes(c), add() {}, remove() {}, toggle() {} };
    }
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

const calls = [];
let rpcAnswers = {};
let tables = {};
const TOASTS = [];
globalThis.Node = FakeNode;
const TOAST_EL = mkEl('div');
Object.defineProperty(TOAST_EL, 'textContent', { get() { return ''; }, set(v) { TOASTS.push(String(v)); }, configurable: true });
globalThis.document = {
    createElement: mkEl, createElementNS: (_n, t) => mkEl(t), createTextNode: (t) => new FakeText(t),
    head: mkEl('head'), body: mkEl('body'), documentElement: mkEl('html'),
    addEventListener() {}, removeEventListener() {}, getElementById(id) { return id === 'toast' ? TOAST_EL : null; },
    querySelectorAll(sel) { return sel === '.modal' ? document.body.children.filter((c) => c.className === 'modal') : []; },
};
globalThis.window = { location: { hostname: 'localhost' }, localStorage: { getItem: () => null, setItem() {} }, open: () => null, easymed: { state: { user: { id: 9, full_name: 'Кассир', role: 'cashier' } } } };
const store = new Map([['admin.lang', 'ru']]);
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem(k, v) { store.set(k, String(v)); }, removeItem(k) { store.delete(k); }, clear() {} };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.confirm = () => true;
const matches = (r, f) => {
    const v = r[f.col];
    if (f.op === 'eq') return String(v) === String(f.val);
    if (f.op === 'in') return (Array.isArray(f.val) ? f.val : []).map(String).includes(String(v));
    if (f.op === 'is') return v == null;
    return true;
};
globalThis.fetch = async (url, opts = {}) => {
    let body = {};
    try { body = JSON.parse(opts.body || '{}'); } catch { /* не json */ }
    const u = String(url);
    const rpc = u.split('/api/rpc/')[1];
    let data;
    if (rpc) {
        const name = decodeURIComponent(rpc);
        calls.push([name, body]);
        const a = rpcAnswers[name];
        if (a && a.__error) return { ok: false, status: 500, json: async () => ({ error: { message: a.__error } }), headers: { getSetCookie: () => [] } };
        data = typeof a === 'function' ? await a(body) : (a !== undefined ? a : []);   // ответ-обещание — сервер «думает», пока тест не ответит
    } else {
        calls.push(['db:' + body.table, body]);
        const rows = (tables[body.table] || []).filter((r) => (body.filters || []).every((f) => matches(r, f)));
        data = body.single ? (rows[0] || null) : rows;
    }
    return { ok: true, status: 200, json: async () => ({ data }), headers: { getSetCookie: () => [] } };
};

const desk = await import('../views/cashier-desk.js');
const perms = await import('../permissions.js');

const walk = (e, out = []) => { if (!e || typeof e !== 'object') return out; out.push(e); for (const c of e.children || []) walk(c, out); return out; };
const textOf = (e) => walk(e).map((x) => x._text || '').join(' ');
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const modals = () => document.body.children.filter((c) => c.className === 'modal');
const lastModal = () => modals()[modals().length - 1];
const buttons = (root) => walk(root).filter((e) => e.tagName === 'BUTTON');
const buttonByText = (root, t) => buttons(root).find((b) => textOf(b).trim() === t);
const byAttr = (root, k, v) => walk(root).find((e) => e.attrs && e.attrs[k] === v);
const allByAttr = (root, k) => walk(root).filter((e) => e.attrs && e.attrs[k] !== undefined);
const closeAll = () => { document.body.children = document.body.children.filter((c) => c.className !== 'modal'); };
const rpcCalls = (name) => calls.filter(([n]) => n === name);

function asCashier() {
    perms.setEffectiveFromRole({ name: 'cashier', permissions: { sections: ['cashier', 'patients'], levels: { cashier: 'admin', patients: 'editor' }, grants: {} } });
    window.easymed.state.user = { id: 9, full_name: 'Кассир', role: 'cashier' };
}

const TODAY_ROW = { id: 30, invoice_number: 'INV-A-26-00030', status: 'paid', subtotal: 100000, discount_amount: 0, total_amount: 100000, paid_amount: 100000,
    created_at: new Date().toISOString(), patient_name: 'Рахимов Жасур', mrn: 'A-26-00015', phone: '+998901112233', patient_id: 3, items_count: 1, first_item: 'Приём терапевта', methods: 'cash' };
const OLD_ROW = { ...TODAY_ROW, id: 7, invoice_number: 'INV-A-26-00007', created_at: '2026-10-19T06:00:00Z', first_item: 'Анализ крови' };
const OLDER_ROW = { ...TODAY_ROW, id: 5, invoice_number: 'INV-A-26-00005', status: 'void', paid_amount: 0, created_at: '2026-10-02T06:00:00Z' };
const PAYMENTS = [{ id: 71, invoice_id: 7, amount: 100000, method: 'cash', paid_at: '2026-10-19T06:05:00Z', notes: '' }];
const ITEMS = [{ id: 701, invoice_id: 7, description: 'Анализ крови', quantity: 1, unit_price: 100000, total: 100000, discount_amount: 0 }];

test('поиск кассы спрашивает сервер по всем дням и рисует «Счета за все дни» (без счетов, что уже в списке)', async () => {
    asCashier();
    closeAll();
    const st = desk.__test_cardState;
    st.filter = 'paid';
    st.rows = [TODAY_ROW];
    st.counts = null;
    st.search = 'рахимов';
    st.found = { result: null, pendingQ: null };
    calls.length = 0;
    rpcAnswers = { cashier_invoice_search: (b) => (b.q === 'рахимов' ? { q: 'рахимов', rows: [TODAY_ROW, OLD_ROW, OLDER_ROW], offset: 0, has_more: true } : { rows: [] }) };
    let repaints = 0;
    desk.__test_paintSearch(mkEl('div'), () => { repaints++; });
    const busy = mkEl('div');
    desk.__test_paintTable(busy, mkEl('div'));
    assert.match(textOf(busy), /Счета за все дни/);
    assert.match(textOf(busy), /Ищем…/, 'пока сервер отвечает — «Ищем…»');
    await tick(60);
    assert.deepEqual(rpcCalls('cashier_invoice_search').map(([, b]) => b), [{ q: 'рахимов' }], 'строка поиска не ушла на сервер');
    assert.equal(repaints, 1, 'ответ поиска не перерисовал экран');
    const el = mkEl('div');
    desk.__test_paintTable(el, mkEl('div'));
    const shown = allByAttr(el, 'data-found-row').map((x) => x.attrs['data-found-row']);
    assert.deepEqual(shown, ['7', '5'], 'сегодняшний счёт уже в списке — второй раз его нет');
    const old = byAttr(el, 'data-found-row', '7');
    for (const piece of ['INV-A-26-00007', 'Рахимов Жасур', 'A-26-00015', '100 000 из 100 000 сум']) {
        assert.ok(textOf(old).includes(piece), 'в найденной строке нет «' + piece + '»: ' + textOf(old));
    }
    assert.ok(byAttr(el, 'data-found-more', '1'), '«Показать ещё» — у сервера есть ещё страница');
    // Тот же поиск второй раз не спрашивается.
    desk.__test_paintSearch(mkEl('div'), () => {});
    await tick(20);
    assert.equal(rpcCalls('cashier_invoice_search').length, 1);
    // «Показать ещё» — следующая страница с offset.
    rpcAnswers.cashier_invoice_search = (b) => (b.offset === 3 ? { q: 'рахимов', rows: [{ ...OLD_ROW, id: 4, invoice_number: 'INV-A-26-00004' }], offset: 3, has_more: false } : { rows: [] });
    byAttr(el, 'data-found-more', '1').click();
    await tick(60);
    assert.deepEqual(rpcCalls('cashier_invoice_search').at(-1)[1], { q: 'рахимов', offset: 3 });
    const el2 = mkEl('div');
    desk.__test_paintTable(el2, mkEl('div'));
    assert.deepEqual(allByAttr(el2, 'data-found-row').map((x) => x.attrs['data-found-row']), ['7', '5', '4']);
    assert.equal(byAttr(el2, 'data-found-more', '1'), undefined);
    // Одна буква — сервер не спрашивается, блока нет.
    st.search = 'р';
    st.found = { result: null, pendingQ: null };
    const before = rpcCalls('cashier_invoice_search').length;
    desk.__test_paintSearch(mkEl('div'), () => {});
    const el3 = mkEl('div');
    desk.__test_paintTable(el3, mkEl('div'));
    assert.equal(rpcCalls('cashier_invoice_search').length, before);
    assert.doesNotMatch(textOf(el3), /Счета за все дни/);
    st.search = '';
    st.filter = 'unpaid';
});

test('«Платежи» у найденного счёта — полное окно: платежи и «Вернуть услугу»', async () => {
    asCashier();
    closeAll();
    const st = desk.__test_cardState;
    st.filter = 'paid';
    st.rows = [];
    st.search = 'рахимов';
    st.found = { result: { q: 'рахимов', rows: [OLD_ROW], has_more: false, error: null }, pendingQ: null };
    tables = { payments: PAYMENTS, invoice_items: ITEMS };
    rpcAnswers = {};
    const el = mkEl('div');
    desk.__test_paintTable(el, mkEl('div'));
    byAttr(el, 'data-found-pay', '7').click();
    await tick(60);
    const m = lastModal();
    assert.ok(m, 'окно «Платежи» не открылось');
    assert.match(textOf(m), /Платежи · INV-A-26-00007 · Рахимов Жасур/);
    assert.ok(buttonByText(m, 'Вернуть услугу'), 'в окне нет «Вернуть услугу»');
    assert.ok(buttonByText(m, 'Возврат'), 'в окне нет возврата по платежу');
    st.search = '';
    st.filter = 'unpaid';
    closeAll();
});

test('строка «Истории операций» открывает окно «Платежи» своего счёта (по номеру — с сервера)', async () => {
    asCashier();
    closeAll();
    const st = desk.__test_cardState;
    st.rows = [];
    // Платёж 72 — по счёту, которого касса не знает (удалён, другое здание):
    // «Платежи» у него нет — открывать нечего (ревью M-1).
    const LOST = { id: 72, invoice_id: 8, amount: 5000, method: 'cash', paid_at: '2026-10-18T06:05:00Z', notes: '' };
    tables = { payments: [...PAYMENTS, LOST], invoice_items: ITEMS, invoices: [{ id: 7, invoice_number: 'INV-A-26-00007', patients: { full_name: 'Рахимов Жасур' } }], cash_movements: [] };
    calls.length = 0;
    rpcAnswers = { cashier_invoice_search: (b) => (b.invoice_id === 7 ? { q: null, rows: [OLD_ROW], offset: 0, has_more: false } : { rows: [] }) };
    await desk.__test_historyModal(mkEl('div'));
    const hist = lastModal();
    assert.match(textOf(hist), /История операций/);
    assert.match(textOf(hist), /счёт удалён из списка/, 'строка платежа без счёта нарисована');
    assert.equal(byAttr(hist, 'data-history-open', '8'), undefined, 'у платежа по неизвестному счёту — «Платежи»');
    const open = byAttr(hist, 'data-history-open', '7');
    assert.ok(open, 'у строки платежа нет «Платежи»');
    open.click();
    await tick(60);
    assert.deepEqual(rpcCalls('cashier_invoice_search').map(([, b]) => b), [{ invoice_id: 7 }]);
    assert.match(textOf(lastModal()), /Платежи · INV-A-26-00007/);
    assert.ok(buttonByText(lastModal(), 'Вернуть услугу'));
    // Счёт не найден в кассе этого здания — словами, окна нет.
    closeAll();
    TOASTS.length = 0;
    await desk.openInvoiceRefundById(999, { onDone: () => {} });
    assert.equal(modals().length, 0);
    assert.ok(TOASTS.includes('Счёт не найден в кассе этого здания.'), TOASTS.join(' | '));
});

// ---------------------------------------------------------------------------
// Ревью кода B1.
// ---------------------------------------------------------------------------
const REASON_TEXT = {
    branch: 'Это счёт другого здания — его деньги возвращает касса того здания.',
    payer: 'Счёт выставлен плательщику — касса по нему денег не принимает и не возвращает.',
    money_doc: 'Это счёт депозита или продажи карты — его возвращают во вкладке «Депозиты» или «Карты» кассы.',
    free: 'Счёт на 0 сум, оплат по нему не было — возвращать нечего.',
    missing: 'Счёт не найден в кассе этого здания.',
};

test('ревью M-1: по номеру сервер говорит, почему счёта нет, — экран называет причину своими словами', async () => {
    asCashier();
    closeAll();
    for (const [reason, text] of Object.entries(REASON_TEXT)) {
        rpcAnswers = { cashier_invoice_search: { q: null, rows: [], offset: 0, has_more: false, reason } };
        TOASTS.length = 0;
        await desk.openInvoiceRefundById(5, { onDone: () => {} });
        assert.equal(modals().length, 0, reason + ': окна быть не должно');
        assert.ok(TOASTS.includes(text), reason + ': ' + TOASTS.join(' | '));
    }
});

test('ревью M-5/M-6: «Показать ещё» без повторов; «за все дни» не повторяет счёт сегодняшнего списка при любом чипе', async () => {
    asCashier();
    closeAll();
    const st = desk.__test_cardState;
    st.filter = 'unpaid';   // TODAY_ROW оплачен: чип его прячет, но касса его загрузила
    st.rows = [TODAY_ROW];
    st.counts = null;
    st.search = 'рахимов';
    st.found = { result: { q: 'рахимов', rows: [TODAY_ROW, OLD_ROW], has_more: true, error: null }, pendingQ: null };
    calls.length = 0;
    rpcAnswers = { cashier_invoice_search: (b) => ({ q: 'рахимов', rows: [OLD_ROW, OLDER_ROW], offset: b.offset, has_more: false }) };
    let repaints = 0;
    const el = mkEl('div');
    desk.__test_paintTable(el, mkEl('div'), () => { repaints++; });
    assert.deepEqual(allByAttr(el, 'data-found-row').map((x) => x.attrs['data-found-row']), ['7'], 'сегодняшний счёт из загруженного списка — не «другой день»');
    byAttr(el, 'data-found-more', '1').click();
    await tick(60);
    assert.equal(repaints, 1);
    assert.deepEqual(st.found.result.rows.map((r) => r.id), [30, 7, 5], 'вторая страница повторила уже показанный счёт');
    const el2 = mkEl('div');
    desk.__test_paintTable(el2, mkEl('div'));
    assert.deepEqual(allByAttr(el2, 'data-found-row').map((x) => x.attrs['data-found-row']), ['7', '5']);
    st.search = '';
    st.found = { result: null, pendingQ: null };
});

test('ревью I-3: ответ поиска не пересобирает поле — набранное во время запроса остаётся; старый ответ отбрасывается', async () => {
    asCashier();
    closeAll();
    const st = desk.__test_cardState;
    st.filter = 'paid';
    st.search = '';
    const pending = new Map();   // q → ответить
    calls.length = 0;
    rpcAnswers = {
        cashier_invoices: { rows: [TODAY_ROW], counts: null },
        cashier_invoice_search: (b) => new Promise((resolve) => { pending.set(b.q, resolve); }),
    };
    const card = await desk.__test_paymentsCard(mkEl('div'), {});
    const inputOf = (c) => walk(c).find((e) => e.tagName === 'INPUT');
    const searched = () => rpcCalls('cashier_invoice_search').map(([, b]) => b.q);
    const answer = (q, rows) => { pending.get(q)({ q, rows, offset: 0, has_more: false }); pending.delete(q); };
    const typeIn = (inp, text) => { inp.value = text; inp.fire('input'); };
    // Поле поиска ждёт паузу в наборе: 500 мс общего дебаунса h()
    // (SEARCH_DEBOUNCE_V1, ui.js) и 200 мс своего.
    const PAUSE = 760;

    typeIn(inputOf(card), 'рах');
    await tick(PAUSE);
    assert.deepEqual(searched(), ['рах']);
    const inp = inputOf(card);
    typeIn(inp, 'рахим');   // человек печатает дальше, пока сервер думает
    answer('рах', [OLD_ROW]);
    await tick(20);
    assert.equal(inputOf(card), inp, 'ответ поиска пересобрал поле ввода');
    assert.equal(inputOf(card).value, 'рахим', 'набранное во время запроса пропало');
    assert.ok(byAttr(card, 'data-found-row', '7'), 'ответ нарисован');
    await tick(PAUSE);
    assert.equal(st.search, 'рахим');
    assert.deepEqual(searched(), ['рах', 'рахим'], 'последний поиск — по новому тексту');

    // Старый ответ отбрасывается: на «рахим» сервер отвечает после «рахимова».
    typeIn(inputOf(card), 'рахимова');
    await tick(PAUSE);
    assert.deepEqual(searched(), ['рах', 'рахим', 'рахимова']);
    answer('рахимова', [OLDER_ROW]);
    await tick(20);
    answer('рахим', [OLD_ROW]);
    await tick(20);
    assert.equal(st.found.result.q, 'рахимова');
    assert.deepEqual(allByAttr(card, 'data-found-row').map((x) => x.attrs['data-found-row']), ['5'], 'нарисован устаревший ответ');

    // Щелчок по чипу посреди набора: поле то же, набранное не стёрто.
    const before = inputOf(card);
    typeIn(before, 'рахимов');
    buttons(card).find((b) => /ВСЕ СЧЕТА/.test(textOf(b))).click();
    assert.equal(inputOf(card), before, 'щелчок по чипу пересобрал поле');
    assert.equal(inputOf(card).value, 'рахимов', 'щелчок по чипу стёр набранное');
    await tick(PAUSE);
    assert.equal(st.search, 'рахимов', 'набранное до щелчка дошло до поиска');
    answer('рахимов', []);
    await tick(20);

    // Касса перерисована целиком (после оплаты, «Обновить»), а в прежнем поле
    // ещё ждал отложенный набор: он не ложится поверх нового поля (один таймер
    // на экран, поле прежнего экрана не слушается).
    typeIn(inputOf(card), 'рахимо');
    const card2 = await desk.__test_paymentsCard(mkEl('div'), {});
    typeIn(inputOf(card2), 'каримова');
    await tick(PAUSE);
    assert.equal(st.search, 'каримова');
    assert.ok(!searched().includes('рахимо'), 'отложенный набор прежнего поля перезаписал поиск: ' + searched().join(', '));
    for (const q of [...pending.keys()]) answer(q, []);
    await tick(20);
    st.search = '';
    st.filter = 'unpaid';
    st.found = { result: null, pendingQ: null };
});

test('ревью I-4: возврат из «Платежи», открытого поверх окна визита, закрывает только свои окна', async () => {
    asCashier();
    closeAll();
    const visitWin = mkEl('div');
    visitWin.className = 'modal';
    document.body.appendChild(visitWin);
    tables = { payments: PAYMENTS, invoice_items: ITEMS };
    let done = 0;
    calls.length = 0;
    rpcAnswers = {
        cashier_invoice_search: (b) => (b.invoice_id === 7 ? { q: null, rows: [OLD_ROW], offset: 0, has_more: false } : { rows: [] }),
        refund_invoice_line: { refunded: 100000 },
        refund_payment: { to_balance: false },
    };
    // Вернуть услугу.
    await desk.openInvoiceRefundById(7, { onDone: () => { done++; } });
    let pay = lastModal();
    assert.match(textOf(pay), /Платежи · INV-A-26-00007/);
    buttonByText(pay, 'Вернуть услугу').click();
    const lineWin = lastModal();
    assert.notEqual(lineWin, pay);
    buttonByText(lineWin, 'Вернуть услугу').click();
    await tick(60);
    assert.equal(rpcCalls('refund_invoice_line').length, 1);
    assert.deepEqual(modals(), [visitWin], 'окно визита закрылось вместе с окнами возврата');
    assert.equal(done, 1, 'после возврата перечитывается вызвавший экран');
    // Возврат оплаты — то же.
    await desk.openInvoiceRefundById(7, { onDone: () => { done++; } });
    pay = lastModal();
    buttonByText(pay, 'Возврат').click();
    walk(lastModal()).find((e) => e.tagName === 'INPUT').value = '100 000';   // сумма возврата (заглушка не переносит атрибут value в поле)
    buttonByText(lastModal(), 'Оформить возврат').click();
    await tick(60);
    assert.equal(rpcCalls('refund_payment').length, 1);
    assert.deepEqual(modals(), [visitWin], 'окно визита закрылось после возврата оплаты');
    assert.equal(done, 2);
    // Касса (без keep) — как прежде: возврат закрывает все окна.
    rpcAnswers = { refund_payment: { to_balance: false }, cash_shift_summary: null };
    desk.__test_openRefundConfirm(PAYMENTS[0], { id: 7, invoice_number: 'INV-A-26-00007' }, mkEl('div'));
    walk(lastModal()).find((e) => e.tagName === 'INPUT').value = '100 000';
    buttonByText(lastModal(), 'Оформить возврат').click();
    await tick(60);
    assert.equal(modals().length, 0, 'из кассы возврат закрывает все окна, как раньше');
    closeAll();
});

test('новые строки экрана — в словаре на трёх языках, uz/en без кириллицы', async () => {
    const { STRINGS } = await import('../i18n-strings.js');
    for (const key of ['Счета за все дни', 'За другие дни счетов по этому поиску нет.', 'Платежи', '{paid} из {total} сум', 'Счёт не найден в кассе этого здания.', ...Object.values(REASON_TEXT)]) {
        const e = STRINGS[key];
        assert.ok(e, 'нет ключа словаря: ' + key);
        assert.equal(e.ru, key);
        for (const lang of ['uz', 'en']) {
            assert.ok(e[lang], key + ': нет перевода ' + lang);
            assert.doesNotMatch(e[lang], /[Ѐ-ӿ]/, key + ': кириллица в ' + lang);
        }
    }
});

// ─── B2: счёт стационара — строки видны и возвращаются по одной ───────────────
const ADM_ROW = { ...OLD_ROW, id: 8, invoice_number: 'INV-A-26-00008', admission_id: 4, admission_status: 'active', visit_id: null, first_item: 'Перевязка' };
const ADM_ITEMS = [
    { id: 801, invoice_id: 8, description: 'Перевязка', quantity: 1, unit_price: 50000, total: 50000, discount_amount: 0 },
    { id: 802, invoice_id: 8, description: 'Капельница', quantity: 1, unit_price: 120000, total: 120000, discount_amount: 0 },
];

test('счёт стационара: в окне «Платежи» — его строки; «Вернуть услугу» говорит, что строка выйдет из счёта выписки', async () => {
    asCashier();
    closeAll();
    // Поправка 7 плана — «Платежи» открыты поверх окна визита: возврат строки
    // стационара закрывает только свои окна (closeRefundModals + afterMoney).
    const visitWin = mkEl('div');
    visitWin.className = 'modal';
    document.body.appendChild(visitWin);
    let done = 0;
    tables = { payments: [{ id: 81, invoice_id: 8, amount: 170000, method: 'cash', paid_at: '2026-10-28T06:05:00Z', notes: '' }], invoice_items: ADM_ITEMS };
    calls.length = 0;
    rpcAnswers = { cashier_invoice_search: { rows: [ADM_ROW], has_more: false }, refund_invoice_line: { refunded: 50000, invoice: { id: 8 }, admission_line_released: true } };
    await desk.openInvoiceRefundById(8, { onDone: () => { done++; } });
    const m = lastModal();
    assert.match(textOf(m), /Услуги счёта/, 'строки стационара в окне скрыты');
    assert.ok(textOf(m).includes('Перевязка') && textOf(m).includes('Капельница'));
    buttons(m).filter((b) => textOf(b).trim() === 'Вернуть услугу')[0].click();
    const dlg = lastModal();
    assert.match(textOf(dlg), /Строка стационара освободится: в счёт выписки она не попадёт, врачу не оплачивается\./);
    assert.ok(!textOf(dlg).includes('Оставить услугу в визите'), 'у строки стационара «оставить в визите» нет — она и так остаётся в госпитализации');
    buttonByText(dlg, 'Вернуть услугу').click();
    await tick(60);
    assert.equal(rpcCalls('refund_invoice_line')[0][1].invoice_item_id, 801);
    assert.deepEqual(modals(), [visitWin], 'окно визита закрылось вместе с окнами возврата');
    assert.equal(done, 1, 'после возврата перечитывается вызвавший экран');
    closeAll();
});
