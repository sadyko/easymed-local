// CARD_SALE_V1 / CASHBACK_DEBT_V1 (владелец, 2026-09-27) — касса: вкладка
// «Карты» и долг по кэшбэку в окне приёма депозита.
//
// Проверяется то, что уходит на сервер и что видит кассир:
//   • «Продать карту» отправляет sell_card с видом, номиналом, способом и
//     выбранным покупателем; без покупателя — не отправляет;
//   • список карт: выданная в настройках — «без оплаты» и без кнопки возврата;
//     проданная с остатком — «Вернуть остаток» (refund_card_sale);
//   • окно приёма депозита показывает долг по кэшбэку ДО приёма.
//
// Вид без DOM не поднимается — та же заглушка документа, что у
// deposit-accept-modal.test.mjs.

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
let dbRows = [];
globalThis.Node = FakeNode;
globalThis.document = {
    createElement: mkEl, createElementNS: (_n, t) => mkEl(t), createTextNode: (t) => new FakeText(t),
    head: mkEl('head'), body: mkEl('body'), documentElement: mkEl('html'),
    addEventListener() {}, removeEventListener() {}, getElementById() { return null; },
};
globalThis.window = { location: { hostname: 'localhost' }, localStorage: { getItem: () => null, setItem() {} } };
globalThis.localStorage = { getItem: (k) => (k === 'admin.lang' ? 'ru' : null), setItem() {}, removeItem() {}, clear() {} };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.confirm = () => { throw new Error('confirm() — касса работает окнами'); };
globalThis.fetch = async (url, opts = {}) => {
    let body = {};
    try { body = JSON.parse(opts.body || '{}'); } catch { /* не json */ }
    const u = String(url);
    const rpc = u.split('/api/rpc/')[1];
    calls.push([rpc || u, body]);
    const data = rpc ? (rpcAnswers[rpc] !== undefined ? rpcAnswers[rpc] : { rows: [] }) : dbRows;
    return { ok: true, json: async () => ({ data }), headers: { getSetCookie: () => [] } };
};

const desk = await import('../views/cashier-desk.js');

const walk = (e, out = []) => { if (!e || typeof e !== 'object') return out; out.push(e); for (const c of e.children || []) walk(c, out); return out; };
const textOf = (e) => walk(e).map((x) => x._text || '').join(' ');
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const lastOverlay = () => document.body.children[document.body.children.length - 1];
const buttonByText = (root, t) => walk(root).filter((e) => e.tagName === 'BUTTON').find((b) => textOf(b).trim() === t);

test('«Продать карту»: без покупателя не отправляет; с покупателем уходит sell_card с видом, номиналом и способом', async () => {
    calls.length = 0;
    rpcAnswers = { sell_card: { invoice: { invoice_number: 'CARD-A-26-00001' }, card: { id: 1 } } };
    dbRows = [{ id: 5, full_name: 'Покупатель Тестов', mrn: 'P-26-1', phone: '' }];
    desk.__test_openSellCardModal(mkEl('div'));
    const ov = lastOverlay();
    const inputs = walk(ov).filter((e) => e.tagName === 'INPUT');
    const amount = inputs[0];
    const search = inputs.find((i) => /Поиск покупателя/.test(i.getAttribute('placeholder') || ''));
    assert.ok(search, 'поле поиска покупателя есть');
    // Кнопку берём один раз: modal() на время запроса меняет её текст.
    const submit = buttonByText(ov, 'Продать и принять оплату');
    buttonByText(ov, 'Сертификат').click();
    buttonByText(ov, 'Эквайринг').click();
    amount.value = '250 000';
    submit.click();
    await tick();
    assert.ok(!calls.some((c) => c[0] === 'sell_card'), 'без покупателя продажа не уходит');

    search.value = 'Покуп';
    search.fire('input');
    await tick(700);   // дебаунс поиска 500 мс
    const hit = walk(ov).filter((e) => e.tagName === 'BUTTON').find((b) => /Покупатель Тестов/.test(textOf(b)));
    assert.ok(hit, 'найденный пациент показан');
    hit.click();
    assert.match(textOf(ov), /Покупатель: Покупатель Тестов/);
    submit.click();
    await tick();
    const sell = calls.find((c) => c[0] === 'sell_card');
    assert.ok(sell, 'sell_card вызван');
    // V3120_FIX — плюс ключ повтора: двойной щелчок не продаёт карту дважды.
    const { idempotency_key: key, ...args } = sell[1];
    assert.match(key, /^[A-Za-z0-9_-]{8,80}$/);
    assert.deepStrictEqual(args, { kind: 'certificate', amount: 250000, method: 'acquiring', patient_id: 5 });
});

test('список карт: «без оплаты» без возврата; проданная с остатком — «Вернуть остаток» → refund_card_sale', async () => {
    desk.__test_cardState.cards = [
        { id: 1, name: 'Промо', kind: 'certificate', amount: 100000, remaining: 100000, active: 1, sale_number: null, refunded: 0 },
        { id: 2, name: 'Подарок', kind: 'gift_card', amount: 300000, remaining: 200000, active: 1, sale_number: 'CARD-A-26-00001',
          buyer_name: 'Покупатель', sale_method: 'cash', refunded: 0 },
        { id: 3, name: 'Пустая', kind: 'gift_card', amount: 50000, remaining: 0, active: 1, sale_number: 'CARD-A-26-00002', refunded: 0 },
    ];
    const el = mkEl('div');
    desk.__test_paintCards(el, mkEl('div'));
    const rows = walk(el).filter((e) => e.tagName === 'TR').slice(1);
    assert.equal(rows.length, 3);
    assert.match(textOf(rows[0]), /без оплаты/);
    assert.ok(!buttonByText(rows[0], 'Вернуть остаток'), 'за выданную без оплаты денег не брали');
    assert.ok(!buttonByText(rows[2], 'Вернуть остаток'), 'потраченную не возвращают');
    assert.match(textOf(rows[2]), /Потрачена/);
    const btn = buttonByText(rows[1], 'Вернуть остаток');
    assert.ok(btn);
    calls.length = 0;
    rpcAnswers = { refund_card_sale: { refunded: 200000 } };
    btn.click();
    const ov = lastOverlay();
    assert.match(textOf(ov), /200 000/);
    assert.match(textOf(ov), /Наличные/);
    buttonByText(ov, 'Вернуть остаток').click();
    await tick();
    const r = calls.find((c) => c[0] === 'refund_card_sale');
    assert.deepStrictEqual(r && r[1], { card_id: 2 });
});

test('окно приёма депозита показывает долг по кэшбэку до приёма', async () => {
    rpcAnswers = { deposit_balance: { balance: 0, debt: 30000, rows: [] } };
    desk.__test_openAcceptDepositModal({ id: 9, deposit_number: 'DEP-A-26-00009', patient_id: 4, patient_name: 'П', amount: 100000, status: 'pending' }, mkEl('div'));
    await tick();
    const t = textOf(lastOverlay());
    assert.match(t, /Долг по кэшбэку: 30 000 сум/);
    assert.match(t, /ляжет 70 000 сум/);
});
