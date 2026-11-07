// CASHIER_DISCOUNT_V1 (решение владельца 2026-11-07, п. 2) — ОКНО СКИДКИ КАССЫ.
//
// «Скидка» в окне оплаты: процент или сумма, причина обязательна, переключатель
// «Скидка уменьшает долю врача» (по умолчанию да). Кнопка видна тому, у кого роль даёт
// «Кассир может давать скидку» (ненастроенная строка — касса и администратор), и только
// у неоплаченного счёта пациента. Деньги считает сервер (cashier_invoice_discount).
// Заглушка документа — та же, что у cashier-refund-any.test.mjs.
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


function asRole(grants = {}) {
    perms.setEffectiveFromRole({ name: 'cashier', permissions: { sections: ['cashier', 'patients'], levels: { cashier: 'admin', patients: 'editor' }, grants } });
    window.easymed.state.user = { id: 9, full_name: 'Кассир', role: 'cashier' };
}
const UNPAID = { id: 41, invoice_number: 'INV-A-26-00041', status: 'unpaid', subtotal: 100000, discount_amount: 10000, total_amount: 90000, paid_amount: 0,
    payer_id: null, patient_id: 3, patient_name: 'Рахимов Жасур', discount_note: 'Скидка группы «VIP» — 10%' };
const inputBy = (root, attr) => walk(root).find((e) => e.tagName === 'INPUT' && e.attrs[attr] !== undefined);

test('кнопка «Скидка» — только у неоплаченного счёта пациента и только при праве роли', () => {
    asRole();
    assert.equal(desk.cashierDiscountAllowed(UNPAID), true);
    assert.equal(desk.cashierDiscountAllowed({ ...UNPAID, payer_id: 5 }), false, 'счёт плательщику');
    assert.equal(desk.cashierDiscountAllowed({ ...UNPAID, status: 'partial', paid_amount: 1000 }), false, 'частично оплачен');
    assert.equal(desk.cashierDiscountAllowed({ ...UNPAID, status: 'paid', total_amount: 0 }), false, 'закрыт');
    assert.equal(desk.cashierDiscountAllowed({ ...UNPAID, invoice_number: 'DEP-00001' }), false, 'депозит');
    asRole({ 'cashier.discount': 'none' });
    assert.equal(desk.cashierDiscountAllowed(UNPAID), false, '«Кассир может давать скидку: Нет»');
    asRole({ 'cashier.discount': 'edit' });
    assert.equal(desk.cashierDiscountAllowed(UNPAID), true);
    asRole({ cashier: 'none', 'cashier.discount': 'edit' });
    assert.equal(desk.cashierDiscountAllowed(UNPAID), false, 'закрытый раздел «Касса» закрывает и строку');
});

test('окно скидки: 5 % с причиной — сервер получает процент, причину и «уменьшает долю врача: да»; без причины — не уходит', async () => {
    asRole();
    closeAll(); calls.length = 0; TOASTS.length = 0;
    rpcAnswers = { cashier_invoice_discount: (b) => ({ invoice: { ...UNPAID, discount_amount: 14500, total_amount: 85500 }, discount: 4500 }) };
    let done = null;
    desk.openCashierDiscount(UNPAID, (r) => { done = r; });
    const m = lastModal();
    assert.ok(textOf(m).includes('к оплате 90'), textOf(m).slice(0, 200));
    const val = inputBy(m, 'data-discount-value');
    val.value = '5'; val.fire('input');
    assert.match(textOf(byAttr(m, 'data-discount-preview', '')), /Скидка 4.500 сум — к оплате 85.500 сум/);
    const submit = buttonByText(m, 'Дать скидку');   // подпись кнопки на время запроса меняется — держим саму кнопку
    submit.click();
    await tick();
    assert.equal(rpcCalls('cashier_invoice_discount').length, 0, 'без причины ушло на сервер');
    assert.ok(TOASTS.some((t) => t.includes('Укажите причину скидки')), JSON.stringify(TOASTS));
    const why = inputBy(m, 'data-discount-reason');
    why.value = 'постоянный пациент';
    const box = inputBy(m, 'data-discount-reduces');
    assert.ok(box.hasAttribute('checked'), '«Скидка уменьшает долю врача» по умолчанию не отмечена');
    box.checked = true;   // браузер берёт отметку из атрибута; поддельный узел — нет
    submit.click();
    await tick();
    const [, body] = rpcCalls('cashier_invoice_discount')[0];
    assert.deepEqual([body.invoice_id, body.mode, body.value, body.reason, body.reduces_doctor_share], [41, 'pct', 5, 'постоянный пациент', true]);
    assert.ok(body.idempotency_key, 'нет ключа повтора');
    assert.equal(done.discount, 4500);
});

test('окно скидки: суммой 30 000 и «Скидка уменьшает долю врача» снята — сервер получает abs и false', async () => {
    asRole();
    closeAll(); calls.length = 0;
    rpcAnswers = { cashier_invoice_discount: () => ({ invoice: { ...UNPAID, total_amount: 60000 }, discount: 30000 }) };
    desk.openCashierDiscount(UNPAID, () => {});
    const m = lastModal();
    buttonByText(m, 'сум').click();
    const val = inputBy(m, 'data-discount-value');
    val.value = '30 000'; val.fire('input');
    inputBy(m, 'data-discount-reason').value = 'жалоба';
    const box = inputBy(m, 'data-discount-reduces');
    box.checked = false;
    buttonByText(m, 'Дать скидку').click();
    await tick();
    const [, body] = rpcCalls('cashier_invoice_discount')[0];
    assert.deepEqual([body.mode, body.value, body.reduces_doctor_share], ['abs', 30000, false]);
});

test('DISCOUNT_V2: счёт со скидкой 100 % — «скидка 100%» (сумма 0, скидка съела платные услуги); бесплатная услуга — нет', () => {
    assert.equal(desk.isFullDiscount({ total_amount: 0, subtotal: 100000, discount_amount: 100000 }), true);
    assert.equal(desk.isFullDiscount({ total_amount: 0, subtotal: 0, discount_amount: 0 }), false, 'бесплатная услуга — не скидка');
    assert.equal(desk.isFullDiscount({ total_amount: 5000, subtotal: 100000, discount_amount: 95000 }), false);
});
