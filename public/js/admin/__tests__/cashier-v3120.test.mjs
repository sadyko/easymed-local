// V3120_FIX — касса после инспекции 3.12.0.
//
//   • чек после раздельной частичной оплаты: строка на каждый способ,
//     «Оплачено», «Остаток» (было «Наличные 378 001» — вся сумма счёта);
//   • перепечатка чека из строки кассы — копия с датой оплаты;
//   • «История» не открывалась: fmtDate не был импортирован;
//   • «Старший кассир» был английским, смена, закрытая автоматически без
//     пересчёта, выглядела «сошедшейся»;
//   • частичный возврат депозита: «Частично возвращён · вернуть ещё N», окно
//     предлагает возвращаемую сумму;
//   • денежные окна отправляют idempotency_key — один на открытое окно;
//   • квитанция о продаже карты и о приёме депозита;
//   • заготовки «Документов»: без контактов поставщика и английского подвала.
//
// Вид без DOM не поднимается — та же заглушка документа, что у
// card-sale-desk.test.mjs, плюс window.open, который ловит напечатанный HTML.

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
    remove() {}
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
const printed = [];
let promptAnswer = null;
let promptSeen = null;
globalThis.Node = FakeNode;
globalThis.document = {
    createElement: mkEl, createElementNS: (_n, t) => mkEl(t), createTextNode: (t) => new FakeText(t),
    head: mkEl('head'), body: mkEl('body'), documentElement: mkEl('html'),
    addEventListener() {}, removeEventListener() {}, getElementById() { return null; }, querySelectorAll() { return []; },
};
const openWin = () => {
    const w = { _html: '', document: { open() {}, write(h) { w._html += h; }, close() { printed.push(w._html); } }, focus() {}, print() {}, close() {} };
    return w;
};
globalThis.window = { location: { hostname: 'localhost' }, localStorage: { getItem: () => null, setItem() {} }, open: openWin, easymed: { state: { user: { id: 1, full_name: 'Кассирова Д.' } } } };
const store = new Map([['admin.lang', 'ru']]);
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem(k, v) { store.set(k, String(v)); }, removeItem(k) { store.delete(k); }, clear() {} };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.confirm = () => true;
globalThis.prompt = (msg, def) => { promptSeen = { msg, def }; return promptAnswer; };
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
        calls.push([decodeURIComponent(rpc), body]);
        const a = rpcAnswers[decodeURIComponent(rpc)];
        data = typeof a === 'function' ? a(body) : (a !== undefined ? a : []);
        // RELEASE_SELECT_V1 (ревью) — отказ сервера со статусом и кодом (409 invoice_changed).
        if (data && data.__refuse) return { ok: false, status: data.__refuse.status || 400, json: async () => ({ error: data.__refuse }), headers: { getSetCookie: () => [] } };
    } else {
        calls.push(['db:' + body.table, body]);
        const rows = (tables[body.table] || []).filter((r) => (body.filters || []).every((f) => matches(r, f)));
        data = body.single ? (rows[0] || null) : rows;
    }
    return { ok: true, status: 200, json: async () => ({ data }), headers: { getSetCookie: () => [] } };
};

const desk = await import('../views/cashier-desk.js');
const ds = await import('../views/doc-settings.js?v=noqr1');

const walk = (e, out = []) => { if (!e || typeof e !== 'object') return out; out.push(e); for (const c of e.children || []) walk(c, out); return out; };
const textOf = (e) => walk(e).map((x) => x._text || '').join(' ');
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const lastOverlay = () => document.body.children[document.body.children.length - 1];
const buttonByText = (root, t) => walk(root).filter((e) => e.tagName === 'BUTTON').find((b) => textOf(b).trim() === t);
const htmlText = (h) => String(h).replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

const INV = {
    id: 1, invoice_number: 'INV-A-26-00001', patient_name: 'Рахимов Жасур', mrn: '0024815', date_of_birth: '1989-09-28',
    subtotal: 415500, discount_amount: 37500, total_amount: 378000, paid_amount: 0, status: 'unpaid', created_at: '2026-09-26T00:10:00Z',
};
const ITEMS = [{ id: 11, invoice_id: 1, description: 'Консультация', quantity: 1, unit_price: 415500, total: 415500, discount_amount: 0 }];

test('чек после раздельной частичной оплаты: каждый способ своей строкой, «Оплачено», «Остаток»', async () => {
    tables = { invoice_items: ITEMS, visit_services: [] };
    printed.length = 0;
    await desk.__test_printFiscalCheck(INV, [{ method: 'cash', amount: 100000 }, { method: 'card', amount: 50000 }]);
    assert.equal(printed.length, 1);
    const t = htmlText(printed[0]);
    assert.match(t, /Наличные 100 000/);
    assert.match(t, /Карта 50 000/);
    assert.match(t, /Оплачено 150 000/);
    assert.match(t, /Остаток 228 000/);
    assert.doesNotMatch(t, /Наличные 378 000/);
    assert.match(t, /28\.09\.1989 · \d+ г\./, 'возраст — «г.», не перевод интерфейса');
});

test('второй платёж по долгу: ранее внесённое отдельно, остаток — с учётом всех платежей', async () => {
    tables = { invoice_items: ITEMS, visit_services: [] };
    printed.length = 0;
    await desk.__test_printFiscalCheck({ ...INV, paid_amount: 150000, status: 'debt' }, [{ method: 'transfer', amount: 28000 }]);
    const t = htmlText(printed[0]);
    assert.match(t, /Ранее оплачено 150 000/);
    assert.match(t, /Перевод 28 000/);
    assert.match(t, /Оплачено 178 000/);
    assert.match(t, /Остаток 200 000/);
});

test('кнопка «Печать чека» в строке кассы печатает КОПИЮ по всем платежам счёта', async () => {
    tables = {
        invoices: [{ ...INV, paid_amount: 150000, status: 'debt', patient_id: 3 }],
        invoice_items: ITEMS, visit_services: [],
        patients: [{ id: 3, full_name: 'Рахимов Жасур', mrn: '0024815', date_of_birth: '1989-09-28', gender: 'male' }],
        payments: [
            { id: 1, invoice_id: 1, amount: 100000, method: 'cash', paid_at: '2026-09-26T09:05:00Z' },
            { id: 2, invoice_id: 1, amount: 50000, method: 'card', paid_at: '2026-09-26T09:05:00Z' },
        ],
    };
    printed.length = 0;
    const row = desk.__test_invoiceRow({ ...INV, paid_amount: 150000, status: 'debt', methods: 'cash,card' }, mkEl('div'));
    const btn = walk(row).find((e) => e.tagName === 'BUTTON' && e.getAttribute('title') === 'Печать чека');
    assert.ok(btn, 'кнопка чека есть у счёта с оплатой');
    btn.click();
    await tick(60);
    assert.equal(printed.length, 1);
    const t = htmlText(printed[0]);
    assert.match(t, /Копия/);
    assert.match(t, /Дата оплаты 26\.09\.2026/);
    assert.match(t, /Наличные 100 000/);
    assert.match(t, /Карта 50 000/);
    assert.match(t, /Остаток 228 000/);
});

test('строка кассы: «+N ещё», а не «+N more»', () => {
    const row = desk.__test_invoiceRow({ ...INV, first_item: 'ОАК', items_count: 3 }, mkEl('div'));
    assert.match(textOf(row), /\+2 ещё/);
    assert.doesNotMatch(textOf(row), /more/);
});

test('A4-счёт из строки кассы: русский статус, дата один раз, «Оплачено» / «Остаток»', async () => {
    tables = { invoice_items: ITEMS, visit_services: [] };
    printed.length = 0;
    await desk.__test_printInvoiceSheet({ ...INV, paid_amount: 150000, status: 'debt', methods: 'cash,card' });
    const t = htmlText(printed[0]);
    assert.doesNotMatch(t, /PARTIAL|PAID|DEBT|Дата Дата/);
    assert.match(t, /Долг/);
    assert.match(t, /Оплачено:? 150 000/);
    assert.match(t, /Остаток к оплате:? 228 000/);
});

test('«История» открывается (fmtDate импортирован) и группирует по дням', async () => {
    tables = { payments: [{ id: 1, invoice_id: 1, amount: 100000, method: 'cash', paid_at: '2026-09-26T09:05:00Z' }], cash_movements: [] };
    desk.__test_cardState.rows = [INV];
    const before = document.body.children.length;
    await desk.__test_historyModal(mkEl('div'));
    assert.equal(document.body.children.length, before + 1, 'окно появилось');
    assert.match(textOf(lastOverlay()), /История операций/);
});

test('«Старший кассир» по-русски; смена, закрытая без пересчёта, — «не пересчитана»', async () => {
    tables = {
        cash_shifts: [
            { id: 2, cashier_id: 1, users: { full_name: 'Кассирова Д.' }, status: 'closed', opened_at: '2026-09-25T04:00:00Z', closed_at: '2026-09-25T19:00:00Z', opening_float: 0, expected_amount: 500000, counted_amount: null, over_short: 0 },
            { id: 1, cashier_id: 1, users: { full_name: 'Кассирова Д.' }, status: 'closed', opened_at: '2026-09-24T04:00:00Z', closed_at: '2026-09-24T19:00:00Z', opening_float: 0, expected_amount: 100000, counted_amount: 100000, over_short: 0 },
        ],
        payments: [],
    };
    const c = mkEl('div');
    await desk.renderCashierHead(c);
    await tick();
    const t = textOf(c);
    assert.doesNotMatch(t, /Cash shifts|Over\/Short|All cash shifts|Head cashier|Cashier|Closed|Status/);
    assert.match(t, /Кассовые смены/);
    assert.match(t, /Излишек \/ недостача/);
    const rows = walk(c).filter((e) => e.tagName === 'TR').slice(1);
    assert.match(textOf(rows[0]), /не пересчитана/);
    assert.doesNotMatch(textOf(rows[1]), /не пересчитана/);
});

test('депозит, возвращённый частично: «Частично возвращён · вернуть ещё N», окно предлагает остаток', async () => {
    desk.__test_cardState.deposits = [
        { id: 7, deposit_number: 'DEP-A-26-00007', patient_name: 'Рахимов', amount: 100000, refund_amount: 30000, refundable: 70000, status: 'received', method: 'cash' },
        { id: 8, deposit_number: 'DEP-A-26-00008', patient_name: 'Иванов', amount: 50000, refund_amount: 50000, refundable: 0, status: 'refunded', method: 'cash' },
    ];
    const el = mkEl('div');
    desk.__test_paintDeposits(el, mkEl('div'));
    const rows = walk(el).filter((e) => e.tagName === 'TR').slice(1);
    const sorted = rows.map(textOf);
    const partialRow = rows[sorted.findIndex((x) => /DEP-A-26-00007/.test(x))];
    const fullRow = rows[sorted.findIndex((x) => /DEP-A-26-00008/.test(x))];
    assert.match(textOf(partialRow), /Частично возвращён/);
    assert.match(textOf(partialRow), /вернуть ещё 70 000/);
    assert.ok(!buttonByText(fullRow, 'Возврат'), 'возвращённый целиком — без кнопки');
    const btn = buttonByText(partialRow, 'Возврат');
    assert.ok(btn, 'остаток можно вернуть');
    calls.length = 0;
    promptAnswer = '70000';
    rpcAnswers = { refund_deposit: { deposit: { id: 7 } }, cashier_invoices: { rows: [] }, cash_shift_summary: null };
    btn.click();
    await tick();
    assert.equal(promptSeen.def, '70000', 'по умолчанию — возвращаемый остаток, а не весь депозит');
    const r = calls.find((x) => x[0] === 'refund_deposit');
    assert.ok(r);
    assert.equal(r[1].amount, 70000);
    assert.equal(typeof r[1].idempotency_key, 'string');
});

test('«Внести наличные» отправляет ключ повтора, один и тот же при повторном нажатии', async () => {
    calls.length = 0;
    rpcAnswers = { cash_move: () => { throw new Error('сеть оборвалась'); } };
    desk.__test_moveModal(mkEl('div'), 'in');
    const ov = lastOverlay();
    const amount = walk(ov).find((e) => e.tagName === 'INPUT');
    amount.value = '40 000';
    const submit = buttonByText(ov, 'Внести');
    submit.click();
    await tick();
    submit.click();
    await tick();
    const moves = calls.filter((c) => c[0] === 'cash_move');
    assert.ok(moves.length >= 1);
    for (const m of moves) assert.match(m[1].idempotency_key, /^[A-Za-z0-9_-]{8,80}$/);
    if (moves.length > 1) assert.equal(moves[0][1].idempotency_key, moves[1][1].idempotency_key, 'повтор — тот же ключ');
    desk.__test_moveModal(mkEl('div'), 'in');
    const ov2 = lastOverlay();
    walk(ov2).find((e) => e.tagName === 'INPUT').value = '1 000';
    rpcAnswers = { cash_move: {} };
    buttonByText(ov2, 'Внести').click();
    await tick();
    const last = calls.filter((c) => c[0] === 'cash_move').pop();
    assert.notEqual(last[1].idempotency_key, moves[0][1].idempotency_key, 'новое окно — новый ключ');
});

test('«Оплатить» отправляет record_payment с ключом повтора', async () => {
    calls.length = 0;
    tables = { invoice_items: ITEMS, visit_services: [], payment_providers: [], patient_discounts: [] };
    rpcAnswers = { record_payment: { ok: true }, deposit_balance: { balance: 0, debt: 0 } };
    desk.__test_payModal(mkEl('div'), INV, 378000);
    await tick();
    const ov = lastOverlay();
    buttonByText(ov, 'Принять оплату').click();
    await tick(60);
    const pay = calls.find((c) => c[0] === 'record_payment');
    assert.ok(pay, 'оплата ушла');
    assert.match(pay[1].idempotency_key, /^[A-Za-z0-9_-]{8,80}$/);
});

// V3120_FINAL (I1) — ключ повтора живёт только до УДАЧНОЙ операции.
// RELEASE_SELECT_V1 (ревью) — «Оставить как долг» с частью денег больше не
// проводит часть отдельной оплатой: часть и долг — один вызов mark_invoice_debt
// (одна транзакция). Долг не оформился — не записано НИЧЕГО, и окно не считает
// часть принятой: «Принять оплату» уходит одной оплатой с ключом окна (если долг
// всё-таки прошёл и потерялся лишь ответ, сервер узнает ключ и откажет 409, а не
// проведёт деньги второй раз).
test('оплата: долг с частью денег не оформился — отдельной оплаты части не было; «Принять оплату» уходит одной оплатой с ключом окна', async () => {
    calls.length = 0;
    tables = { invoice_items: ITEMS, visit_services: [], payment_providers: [], patient_discounts: [] };
    rpcAnswers = {
        record_payment: { ok: true }, deposit_balance: { balance: 0, debt: 0 },
        mark_invoice_debt: () => { throw new Error('сеть оборвалась'); },
    };
    desk.__test_payModal(mkEl('div'), INV, 378000);
    await tick();
    const ov = lastOverlay();
    const amt = () => walk(ov).find((e) => e.tagName === 'INPUT' && e.getAttribute('placeholder') === 'Сумма');
    amt().value = '100 000';
    amt().fire('input');
    buttonByText(ov, 'Оставить как долг').click();
    await tick(60);
    assert.ok(!calls.some((c) => c[0] === 'record_payment'), 'часть денег не уходит отдельной оплатой');
    const debt = calls.find((c) => c[0] === 'mark_invoice_debt');
    assert.deepEqual(debt[1].tenders.map((t) => [t.method, t.amount]), [['cash', 100000]], 'часть едет с долгом');
    amt().value = '378 000';
    amt().fire('input');
    buttonByText(ov, 'Принять оплату').click();
    await tick(60);
    const pays = calls.filter((c) => c[0] === 'record_payment');
    assert.equal(pays.length, 1);
    assert.equal(pays[0][1].amount, 378000);
    assert.equal(pays[0][1].idempotency_key, debt[1].idempotency_key, 'ничего не прошло — ключ окна тот же');
});

test('оплата: неудачная попытка повторяется с ТЕМ ЖЕ ключом', async () => {
    calls.length = 0;
    tables = { invoice_items: ITEMS, visit_services: [], payment_providers: [], patient_discounts: [] };
    rpcAnswers = { record_payment: () => { throw new Error('сеть оборвалась'); }, deposit_balance: { balance: 0, debt: 0 } };
    desk.__test_payModal(mkEl('div'), INV, 378000);
    await tick();
    const ov = lastOverlay();
    const submit = buttonByText(ov, 'Принять оплату');
    submit.click();
    await tick(60);
    submit.click();
    await tick(60);
    const pays = calls.filter((c) => c[0] === 'record_payment');
    assert.equal(pays.length, 2);
    assert.equal(pays[1][1].idempotency_key, pays[0][1].idempotency_key, 'повтор той же неудачной формы — тот же ключ');
});

test('продажа карты печатает квитанцию', async () => {
    calls.length = 0;
    printed.length = 0;
    rpcAnswers = { cash_shift_summary: null, sell_card: { invoice: { invoice_number: 'CARD-A-26-00001' }, card: { id: 1, kind: 'gift_card', amount: 250000, remaining: 250000, sale_number: 'CARD-A-26-00001', name: 'Подарок' } } };
    tables = { patients: [{ id: 5, full_name: 'Покупатель Тестов', mrn: 'P-26-1', phone: '' }] };
    desk.__test_openSellCardModal(mkEl('div'));
    const ov = lastOverlay();
    const inputs = walk(ov).filter((e) => e.tagName === 'INPUT');
    inputs[0].value = '250 000';
    const search = inputs.find((i) => /Поиск покупателя/.test(i.getAttribute('placeholder') || ''));
    search.value = 'Покуп';
    search.fire('input');
    await tick(700);
    walk(ov).filter((e) => e.tagName === 'BUTTON').find((b) => /Покупатель Тестов/.test(textOf(b))).click();
    buttonByText(ov, 'Продать и принять оплату').click();
    await tick();
    const sell = calls.find((c) => c[0] === 'sell_card');
    assert.match(sell[1].idempotency_key, /^[A-Za-z0-9_-]{8,80}$/);
    assert.equal(printed.length, 1, 'квитанция напечатана');
    const t = htmlText(printed[0]);
    assert.match(t, /Квитанция/);
    assert.match(t, /Покупатель Тестов/);
    assert.match(t, /250 000 сум/);
    assert.match(t, /Наличные/);
});

test('приём депозита печатает квитанцию', async () => {
    printed.length = 0;
    rpcAnswers = {
        accept_deposit: { deposit: { id: 9, deposit_number: 'DEP-A-26-00009', amount: 300000, method: 'card', status: 'received' }, balance: 300000, debt_covered: 0 },
        deposit_balance: { balance: 0, debt: 0 }, cash_shift_summary: null,
    };
    desk.__test_openAcceptDepositModal({ id: 9, deposit_number: 'DEP-A-26-00009', amount: 300000, patient_name: 'Рахимов Жасур', patient_mrn: '0024815', status: 'pending' }, mkEl('div'));
    const ov = lastOverlay();
    buttonByText(ov, 'Карта').click();
    buttonByText(ov, 'Принять оплату').click();
    await tick();
    assert.equal(printed.length, 1);
    const t = htmlText(printed[0]);
    assert.match(t, /Квитанция/);
    assert.match(t, /DEP-A-26-00009/);
    assert.match(t, /Рахимов Жасур/);
    assert.match(t, /Карта/);
    assert.match(t, /Баланс пациента 300 000/);
});

test('«Документы»: без контактов поставщика и английского подвала, старые заготовки вычищаются', () => {
    const fresh = ds.loadDocSettings();
    for (const k of ['address', 'phone', 'email', 'footerNote', 'legalNote']) assert.equal(fresh[k], '', k);
    ds.saveDocSettings({
        address: 'Tashkent, 12 Amir Temur Ave., 100000', phone: '+998 71 200 12 00', email: 'hello@easy-med.uz',
        footerNote: 'Thank you for choosing our clinic. Please keep this document for your records.',
        legalNote: 'This document is generated electronically and is valid without a manual signature when sealed with a digital signature.',
    });
    const s = ds.loadDocSettings();
    for (const k of ['address', 'phone', 'email', 'footerNote', 'legalNote']) assert.equal(s[k], '', 'заготовка поставщика вычищена: ' + k);
    ds.saveDocSettings({ address: 'Ташкент, ул. Навои 1', footerNote: 'Берегите здоровье' });
    const own = ds.loadDocSettings();
    assert.equal(own.address, 'Ташкент, ул. Навои 1', 'своё клиника сохраняет');
    assert.equal(own.footerNote, 'Берегите здоровье');
});

// ---------------------------------------------------------------------------
// Вторая волна (сервер c80da42): «пациент заплатит заново», скидка после
// продажи, виртуальная смена, авто-закрытая смена.
// ---------------------------------------------------------------------------
const toasts = () => walk(document.body).filter((e) => e.attrs && e.attrs.id === 'toast').map((e) => e._text);

test('возврат оплаты: по умолчанию скидка после продажи (reopen_balance: false), и кассир её видит', async () => {
    calls.length = 0;
    rpcAnswers = { refund_payment: { invoice: { id: 1 }, to_balance: false, post_sale_discount: 40000 }, cash_shift_summary: null };
    desk.__test_openRefundConfirm({ id: 5, invoice_id: 1, amount: 140000, method: 'cash', paid_at: '2026-09-26T09:05:00Z' },
        { id: 1, invoice_number: 'INV-1', patient_name: 'Рахимов' }, mkEl('div'));
    const ov = lastOverlay();
    assert.match(textOf(ov), /Пациент заплатит заново/);
    walk(ov).find((e) => e.tagName === 'INPUT').value = '40 000';
    buttonByText(ov, 'Оформить возврат').click();
    await tick();
    const r = calls.find((c) => c[0] === 'refund_payment');
    assert.ok(r);
    assert.strictEqual(r[1].reopen_balance, false);
    assert.ok(toasts().some((t) => /скидка после продажи/.test(t) && /40 000/.test(t)), toasts().join(' | '));
});

test('возврат оплаты: «Пациент заплатит заново» отправляет reopen_balance: true', async () => {
    calls.length = 0;
    rpcAnswers = { refund_payment: { invoice: { id: 1 }, to_balance: false }, cash_shift_summary: null };
    desk.__test_openRefundConfirm({ id: 6, invoice_id: 1, amount: 140000, method: 'card', paid_at: '2026-09-26T09:05:00Z' },
        { id: 1, invoice_number: 'INV-1' }, mkEl('div'));
    const ov = lastOverlay();
    const label = walk(ov).find((e) => e.tagName === 'LABEL' && /Пациент заплатит заново/.test(textOf(e)));
    const box = walk(label).find((e) => e.tagName === 'INPUT');
    box.checked = true;
    walk(ov).find((e) => e.tagName === 'INPUT').value = '40 000';
    buttonByText(ov, 'Оформить возврат').click();
    await tick();
    const r = calls.find((c) => c[0] === 'refund_payment');
    assert.strictEqual(r[1].reopen_balance, true);
});

test('виртуальная смена (id: null): без «CASHIER/0null», окно закрытия не отправляет close_cash_shift', async () => {
    const summary = { shift: { id: null, virtual: true, opening_float: 0, opened_at: new Date().toISOString(), status: 'open' }, totals: { count: 0, total: 0, cash: 0, card: 0 }, cash_in: 0, cash_out: 0, expected_drawer: 0, cashier_name: 'Кассирова Д.' };
    const banner = desk.__test_shiftBanner(mkEl('div'), summary);
    assert.doesNotMatch(textOf(banner), /null/);
    assert.ok(!buttonByText(banner, 'Закрыть смену'), 'кнопки закрытия нет');
    calls.length = 0;
    const before = document.body.children.length;
    desk.__test_closeShiftModal(mkEl('div'), summary.shift, 0);
    assert.ok(!walk(document.body).slice(before).some((e) => e.tagName === 'BUTTON' && textOf(e).trim() === 'Закрыть смену'), 'окно закрытия не открылось');
    assert.ok(!calls.some((c) => c[0] === 'close_cash_shift'));
});

test('авто-закрытая смена (auto_closed = 1, over_short = NULL) — «не пересчитана», без красного числа', async () => {
    tables = {
        cash_shifts: [
            { id: 3, cashier_id: 1, users: { full_name: 'Кассирова Д.' }, status: 'closed', auto_closed: 1, opened_at: '2026-09-25T04:00:00Z', closed_at: '2026-09-25T19:00:00Z', opening_float: 0, expected_amount: 500000, counted_amount: 500000, over_short: null },
        ],
        payments: [],
    };
    const c = mkEl('div');
    await desk.renderCashierHead(c);
    await tick();
    const row = walk(c).filter((e) => e.tagName === 'TR')[1];
    assert.match(textOf(row), /не пересчитана/);
    const red = walk(row).filter((e) => e.style && e.style.color === 'var(--crit-600)');
    assert.equal(red.length, 0, 'NULL не рисуется красным');
});

// ═══════════════════════════════════════════════════════════════════════════
// RELEASE_SELECT_V1 (3.25.0) — «Что можно оказать сейчас» в окне оплаты кассы.
// ═══════════════════════════════════════════════════════════════════════════
const REL_LINES = [{ id: 501, name: 'Консультация терапевта', total: 100000 }, { id: 502, name: 'Общий анализ крови', total: 40000 }];
const REL_INV = { ...INV, subtotal: 140000, discount_amount: 0, total_amount: 140000 };
const relBlock = (ov) => walk(ov).find((e) => e.attrs && 'data-release-select' in e.attrs);
const relBox = (ov, id) => walk(ov).find((e) => e.tagName === 'INPUT' && e.getAttribute('data-release-line') === String(id));
const amountInput = (ov) => walk(ov).find((e) => e.tagName === 'INPUT' && e.getAttribute('placeholder') === 'Сумма');
const typeAmount = (ov, v) => { const a = amountInput(ov); a.value = v; a.fire('input'); };
async function openRelease(answers = {}) {
    calls.length = 0;
    tables = { invoice_items: ITEMS, visit_services: [], payment_providers: [], patient_discounts: [] };
    rpcAnswers = { deposit_balance: { balance: 0, debt: 0 }, invoice_release_lines: { invoice_id: 1, lines: REL_LINES }, ...answers };
    desk.__test_payModal(mkEl('div'), REL_INV, 140000);
    await tick();
    return lastOverlay();
}

test('RELEASE_SELECT_V1: полная сумма — списка нет и аргумента нет; меньше — список без отметок', async () => {
    const ov = await openRelease({ record_payment: { ok: true } });
    assert.ok(calls.some((c) => c[0] === 'invoice_release_lines' && c[1].invoice_id === 1), 'неотпущенные строки спрошены у сервера');
    const block = relBlock(ov);
    assert.ok(block, 'блок «Что можно оказать сейчас» есть в окне');
    assert.equal(block.style.display, 'none', 'полная сумма — блока не видно');
    typeAmount(ov, '100 000');
    assert.equal(block.style.display, '', 'частичная сумма — блок виден');
    assert.match(textOf(block), /Что можно оказать сейчас/);
    assert.match(textOf(block), /Консультация терапевта/);
    assert.match(textOf(block), /Общий анализ крови/);
    for (const id of [501, 502]) assert.ok(!('checked' in relBox(ov, id).attrs), 'по умолчанию ничего не отмечено');
    // Подписи галочек: каждая галочка — внутри <label> со своим названием (щелчок и чтение с экрана).
    const group = walk(block).find((e) => e.attrs && e.attrs.role === 'group');
    assert.ok(group && group.attrs['aria-labelledby'], 'группа галочек названа заголовком');
    typeAmount(ov, '140 000');
    assert.equal(block.style.display, 'none', 'снова полная сумма — блок спрятан');
    buttonByText(ov, 'Принять оплату').click();
    await tick(60);
    const pay = calls.find((c) => c[0] === 'record_payment');
    assert.ok(pay, 'оплата ушла');
    assert.ok(!('release_line_ids' in pay[1]), 'полная оплата отпускает всё сама — список не нужен');
});

test('RELEASE_SELECT_V1: частичная — уходят только отмеченные; сумма отмеченного рядом с внесённым', async () => {
    const ov = await openRelease({ record_payment: { ok: true } });
    typeAmount(ov, '100 000');
    const cb = relBox(ov, 501);
    cb.checked = true; cb.fire('change');
    const sum = walk(ov).find((e) => e.attrs && 'data-release-sum' in e.attrs);
    assert.match(textOf(sum), /Отмечено услуг на 100 000 сум/);
    buttonByText(ov, 'Принять оплату').click();
    await tick(60);
    const pay = calls.find((c) => c[0] === 'record_payment');
    assert.equal(pay[1].amount, 100000);
    assert.deepEqual(pay[1].release_line_ids, [501]);
});

test('RELEASE_SELECT_V1: частичная без отметок — уходит пустой список (сервер не отпустит ничего)', async () => {
    const ov = await openRelease({ record_payment: { ok: true } });
    typeAmount(ov, '50 000');
    buttonByText(ov, 'Принять оплату').click();
    await tick(60);
    assert.deepEqual(calls.find((c) => c[0] === 'record_payment')[1].release_line_ids, []);
});

test('RELEASE_SELECT_V1: разделённая частичная оплата несёт тот же выбор', async () => {
    const ov = await openRelease({ record_payment_split: { ok: true } });
    typeAmount(ov, '60 000');
    buttonByText(ov, '+ Разделить оплату (второй способ)').click();
    await tick();
    const inputs = walk(ov).filter((e) => e.tagName === 'INPUT' && e.getAttribute('placeholder') === 'Сумма');
    inputs[1].value = '20 000'; inputs[1].fire('input');
    const cb = relBox(ov, 502);
    cb.checked = true; cb.fire('change');
    buttonByText(ov, 'Принять оплату').click();
    await tick(60);
    const split = calls.find((c) => c[0] === 'record_payment_split');
    assert.ok(split, 'ушла оплата частями');
    assert.deepEqual(split[1].tenders.map((t) => t.amount), [60000, 20000]);
    assert.deepEqual(split[1].release_line_ids, [502]);
});

// RELEASE_SELECT_V1 (ревью) — часть денег, отмеченное и долг — ОДИН вызов
// mark_invoice_debt (одна транзакция сервера): прежде часть уходила record_payment,
// окно брало новый ключ, и упавший долг при повторном нажатии писал второй платёж.
test('RELEASE_SELECT_V1 (ревью): «Оставить как долг» с частью денег — один вызов mark_invoice_debt: части, отмеченное, ключ повтора, остаток окна', async () => {
    const ov = await openRelease({ mark_invoice_debt: { invoice: { id: 1, status: 'debt' } } });
    typeAmount(ov, '30 000');
    const cb = relBox(ov, 502);
    cb.checked = true; cb.fire('change');
    buttonByText(ov, 'Оставить как долг').click();
    await tick(60);
    assert.ok(!calls.some((c) => c[0] === 'record_payment' || c[0] === 'record_payment_split'), 'часть не уходит отдельной оплатой');
    const debt = calls.filter((c) => c[0] === 'mark_invoice_debt');
    assert.equal(debt.length, 1);
    assert.deepEqual(debt[0][1].tenders.map((t) => [t.method, t.amount]), [['cash', 30000]]);
    assert.deepEqual(debt[0][1].release_line_ids, [502], 'отмеченное несёт долг — одна транзакция с деньгами');
    assert.match(debt[0][1].idempotency_key, /^[A-Za-z0-9_-]{8,80}$/);
    assert.equal(debt[0][1].expected_balance, 140000, 'остаток, который видело окно');
});

test('RELEASE_SELECT_V1 (ревью): долг с деньгами не оформился — повтор уходит с ТЕМ ЖЕ ключом и той же формой', async () => {
    let n = 0;
    const ov = await openRelease({ mark_invoice_debt: () => { n += 1; if (n === 1) throw new Error('сеть оборвалась'); return { invoice: { id: 1, status: 'debt' } }; } });
    typeAmount(ov, '30 000');
    buttonByText(ov, 'Оставить как долг').click();
    await tick(60);
    buttonByText(ov, 'Оставить как долг').click();
    await tick(60);
    const debt = calls.filter((c) => c[0] === 'mark_invoice_debt');
    assert.equal(debt.length, 2, 'повтор ушёл на сервер');
    assert.equal(debt[1][1].idempotency_key, debt[0][1].idempotency_key, 'тот же ключ — сервер ответит квитанцией, если первый всё-таки прошёл');
    assert.deepEqual(debt[1][1].tenders, debt[0][1].tenders);
    assert.ok(!calls.some((c) => c[0] === 'record_payment'), 'ни одной отдельной оплаты');
});

test('RELEASE_SELECT_V1 (ревью): счёт изменился (409 invoice_changed) — окно открывается заново с новым остатком и списком услуг', async () => {
    const ov = await openRelease({ record_payment: () => ({ __refuse: { status: 409, code: 'invoice_changed', message: 'Счёт изменился — откройте оплату заново.' } }) });
    tables.invoices = [{ ...REL_INV, subtotal: 170000, total_amount: 170000, paid_amount: 0, status: 'unpaid' }];
    buttonByText(ov, 'Принять оплату').click();
    await tick(90);
    const pay = calls.find((c) => c[0] === 'record_payment');
    assert.equal(pay[1].expected_balance, 140000, 'окно прислало остаток, который видело');
    assert.ok(!('release_line_ids' in pay[1]), 'окно считало оплату полной');
    assert.ok(toasts().some((t) => /Счёт изменился/.test(t)), toasts().join(' | '));
    const ov2 = lastOverlay();
    assert.notEqual(ov2, ov, 'окно открыто заново');
    assert.match(textOf(ov2), /170 000/, 'новый остаток');
    assert.equal(calls.filter((c) => c[0] === 'invoice_release_lines').length, 2, 'список «Что можно оказать сейчас» спрошен заново');
    typeAmount(ov2, '140 000');
    assert.equal(relBlock(ov2).style.display, '', 'прежняя сумма теперь частичная — кассир выбирает услуги');
});

test('RELEASE_SELECT_V1: долг без денег и без отметок — пустой список', async () => {
    const ov = await openRelease({ mark_invoice_debt: { invoice: { id: 1, status: 'debt' } } });
    typeAmount(ov, '');
    assert.equal(relBlock(ov).style.display, '', 'сумма 0 — блок виден');
    buttonByText(ov, 'Оставить как долг').click();
    await tick(60);
    assert.ok(!calls.some((c) => c[0] === 'record_payment'));
    assert.deepEqual(calls.find((c) => c[0] === 'mark_invoice_debt')[1].release_line_ids, []);
});

test('RELEASE_SELECT_V1: строки не загрузились — окно говорит об этом, в работу не уходит ничего', async () => {
    const ov = await openRelease({ record_payment: { ok: true }, invoice_release_lines: () => { throw new Error('сеть'); } });
    typeAmount(ov, '10 000');
    assert.match(textOf(relBlock(ov)), /Не удалось загрузить услуги счёта/);
    buttonByText(ov, 'Принять оплату').click();
    await tick(60);
    assert.deepEqual(calls.find((c) => c[0] === 'record_payment')[1].release_line_ids, []);
});

test('RELEASE_SELECT_V1: слова блока — на трёх языках, узбекский и английский без кириллицы', async () => {
    const { STRINGS } = await import('../i18n-strings.js');
    for (const k of ['Что можно оказать сейчас', 'Отметьте услуги, которые пациент получит сейчас. Неотмеченные ждут оплаты: в лабораторию и к врачу они не попадут.',
        'Отмечено услуг на {sum} сум', 'Не удалось загрузить услуги счёта — ни одна не будет передана в работу.', 'Все услуги этого счёта уже переданы в работу.',
        'Загрузка услуг счёта…']) {
        const e = STRINGS[k];
        assert.ok(e && e.ru === k && e.uz && e.en, 'нет статьи словаря: ' + k);
        assert.ok(!/[А-Яа-яЁё]/.test(e.uz + e.en), 'кириллица в uz/en: ' + k);
    }
});

test('RELEASE_SELECT_V1: долг без денег с отмеченной услугой — отмеченное несёт сам долг', async () => {
    const ov = await openRelease({ mark_invoice_debt: { invoice: { id: 1, status: 'debt' } } });
    typeAmount(ov, '');
    const cb = relBox(ov, 501);
    cb.checked = true; cb.fire('change');
    buttonByText(ov, 'Оставить как долг').click();
    await tick(60);
    assert.ok(!calls.some((c) => c[0] === 'record_payment'), 'денег нет — оплаты нет');
    assert.deepEqual(calls.find((c) => c[0] === 'mark_invoice_debt')[1].release_line_ids, [501]);
});
