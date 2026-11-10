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
        // DISCOUNT_CHANGE_PAID_V1 — ответ-функция может отказать с кодом: { __refuse: { status, code, message } }.
        if (data && data.__refuse) return { ok: false, status: data.__refuse.status || 400, json: async () => ({ error: { code: data.__refuse.code, message: data.__refuse.message } }), headers: { getSetCookie: () => [] } };
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

// ═══ DISCOUNT_CHANGE_PAID_V1 (3.23.0, решения владельца Q2–Q4) — «ИЗМЕНИТЬ СКИДКУ» ═══
// Скидку счёта меняют и после оплаты; окно спрашивает новую скидку (0 — без скидки), причину и
// переключатель доли врача, а сервер (предпросмотр cashier_invoice_discount_change_quote) говорит,
// что будет с деньгами: «Вернуть пациенту» — тем же способом или на баланс — или «К доплате».
const PAID = { id: 52, invoice_number: 'INV-A-26-00052', status: 'paid', subtotal: 200000, discount_amount: 40000, total_amount: 160000, paid_amount: 160000,
    payer_id: null, patient_id: 3, visit_id: 77, patient_name: 'Рахимов Жасур', mrn: 'A-26-00015', discount_note: 'Касса: постоянный пациент — 20% — 40 000 сум' };
const FULL = { ...PAID, id: 53, invoice_number: 'INV-A-26-00053', discount_amount: 200000, total_amount: 0, paid_amount: 0, discount_note: 'Скидка вручную' };
const STATE = { changed: false, preview: true, base: 200000, line_discounts: 0, discount_before: 40000, pct_before: 20, share_before: 1, post_sale_before: 0,
    total_before: 160000, paid_before: 160000, discount_after: 40000, pct_after: 20, total_after: 160000, refunded: 0, due: 0, refund_plan: [] };
function quoteFor(b) {
    if (b.value == null) return STATE;
    const after = b.mode === 'abs' ? b.value : 200000 * b.value / 100;
    const total = 200000 - after;
    const refunded = Math.max(0, 160000 - total);
    return { ...STATE, changed: true, discount_after: after, pct_after: after / 2000, total_after: total, refunded, due: Math.max(0, total - 160000),
        refund_plan: refunded > 0 ? [{ payment_id: 1, method: 'cash', refund_method: b.to_balance ? 'wallet' : 'cash', amount: refunded, to_balance: !!b.to_balance, to_card: false }] : [],
        to_balance: !!b.to_balance, invoice: { ...PAID, total_amount: total, paid_amount: Math.min(160000, total), discount_amount: after, status: total > 160000 ? 'partial' : 'paid' } };
}
const DC_ANSWERS = () => ({ cashier_invoice_discount_change_quote: quoteFor, cashier_invoice_discount_change: (b) => quoteFor(b) });
const dcCalls = (name) => rpcCalls(name).map(([, b]) => b);

test('DISCOUNT_CHANGE_PAID_V1: «Изменить скидку» — оплаченный, частично, долг, скидка 100 %; не до оплаты, не плательщику, не депозит, не стационар; право и денежная роль', () => {
    asRole();
    assert.equal(desk.cashierDiscountChangeAllowed(PAID), true);
    assert.equal(desk.cashierDiscountChangeAllowed({ ...PAID, status: 'partial', paid_amount: 50000 }), true);
    assert.equal(desk.cashierDiscountChangeAllowed({ ...PAID, status: 'debt', paid_amount: 0 }), true, 'долг — пациент ушёл');
    assert.equal(desk.cashierDiscountChangeAllowed(FULL), true, 'скидка 100 % — окна «Платежи» нет, но скидку меняют');
    assert.equal(desk.cashierDiscountChangeAllowed(UNPAID), false, 'до оплаты — обычная «Скидка»');
    assert.equal(desk.cashierDiscountChangeAllowed({ ...PAID, payer_id: 5 }), false, 'плательщик');
    assert.equal(desk.cashierDiscountChangeAllowed({ ...PAID, invoice_number: 'DEP-A-26-00001' }), false, 'депозит');
    assert.equal(desk.cashierDiscountChangeAllowed({ ...PAID, status: 'void' }), false, 'отменён');
    assert.equal(desk.cashierDiscountChangeAllowed({ ...PAID, visit_id: null, admission_id: 4 }), false, 'стационар — при выписке');
    assert.equal(desk.cashierDiscountChangeAllowed({ ...PAID, subtotal: 0, total_amount: 0, discount_amount: 0, paid_amount: 0 }), false, 'бесплатная услуга');
    asRole({ 'cashier.discount': 'none' });
    assert.equal(desk.cashierDiscountChangeAllowed(PAID), false, '«Кассир может давать скидку: Нет»');
    perms.setEffectiveFromRole({ name: 'registrar', permissions: { sections: ['cashier'], levels: { cashier: 'editor' }, grants: { 'cashier.discount': 'edit' } } });
    window.easymed.state.user = { id: 7, full_name: 'Регистратор', role: 'registrar' };
    assert.equal(desk.cashierDiscountChangeAllowed(PAID), false, 'деньги двигает касса: кассир или администратор');
    asRole();
});

test('DISCOUNT_CHANGE_PAID_V1: окно — нынешняя скидка, 50 % → «Вернуть пациенту 60 000», «На баланс пациента»; без причины не уходит; сервер получает выбор', async () => {
    asRole();
    closeAll(); calls.length = 0; TOASTS.length = 0;
    rpcAnswers = DC_ANSWERS();
    desk.openDiscountChange(PAID, null, {});
    await tick();
    const m = lastModal();
    assert.match(textOf(m), /Изменить скидку · INV-A-26-00052/);
    assert.match(textOf(m), /Сейчас скидка счёта: 20% — 40.000 сум/);
    assert.match(textOf(m), /Скидки строк \(пакет, ставки по услугам\) здесь не меняются\./);
    assert.match(textOf(m), /Касса: постоянный пациент — 20% — 40.000 сум/, 'причина скидки');
    assert.deepEqual(dcCalls('cashier_invoice_discount_change_quote')[0], { invoice_id: 52 }, 'нынешнее состояние — предпросмотр без значения');
    const val = inputBy(m, 'data-dc-value');
    assert.equal(val.value, '20', 'окно открывается с нынешним процентом');
    assert.ok(inputBy(m, 'data-dc-reduces').checked, '«Скидка уменьшает долю врача» — как у счёта');
    val.value = '50'; val.fire('input');
    await tick();
    assert.match(textOf(byAttr(m, 'data-dc-refund', '60000')), /Вернуть пациенту\s+60.000 сум/);
    assert.match(textOf(m), /160.000 → 100.000 сум/);
    assert.match(textOf(m), /Оплата подарочной картой всегда возвращается на ту же карту\./);
    const q1 = dcCalls('cashier_invoice_discount_change_quote').pop();
    assert.deepEqual([q1.mode, q1.value, q1.card_fallback, 'reduces_doctor_share' in q1], ['pct', 50, 'cash', false], 'переключатель не трогали — доля прежняя');
    const balance = walk(byAttr(m, 'data-dc-dest', 'balance')).find((e) => e.tagName === 'INPUT');
    balance.fire('change');
    await tick();
    const q2 = dcCalls('cashier_invoice_discount_change_quote').pop();
    assert.deepEqual([q2.to_balance, q2.card_fallback], [true, 'balance']);
    const submit = buttonByText(m, 'Сохранить скидку');
    submit.click();
    await tick();
    assert.equal(dcCalls('cashier_invoice_discount_change').length, 0, 'без причины ушло на сервер');
    assert.ok(TOASTS.some((t) => t.includes('Укажите причину скидки')), JSON.stringify(TOASTS));
    inputBy(m, 'data-dc-reason').value = 'акция';
    submit.click();
    await tick(80);
    const [c] = dcCalls('cashier_invoice_discount_change');
    assert.deepEqual([c.invoice_id, c.mode, c.value, c.reason, c.to_balance, c.card_fallback, 'reduces_doctor_share' in c], [52, 'pct', 50, 'акция', true, 'balance', false]);
    assert.ok(c.idempotency_key, 'нет ключа повтора');
    assert.ok(TOASTS.some((t) => /Скидка изменена — разница 60.000 сум зачислена на баланс пациента\./.test(t)), JSON.stringify(TOASTS));
    assert.equal(modals().length, 0, 'окно скидки закрыто');
});

test('DISCOUNT_CHANGE_PAID_V1: скидку сняли (0 %) — «К доплате 40 000», после сохранения — окно оплаты «Доплата»; тронутый переключатель уходит на сервер', async () => {
    asRole();
    closeAll(); calls.length = 0; TOASTS.length = 0;
    rpcAnswers = DC_ANSWERS();
    desk.openDiscountChange(PAID, null, {});
    await tick();
    const m = lastModal();
    const box = inputBy(m, 'data-dc-reduces');
    box.checked = false; box.fire('change');
    const val = inputBy(m, 'data-dc-value');
    val.value = '0'; val.fire('input');
    await tick();
    assert.match(textOf(byAttr(m, 'data-dc-due', '40000')), /К доплате\s+40.000 сум/);
    assert.match(textOf(m), /После сохранения откроется окно оплаты разницы\./);
    inputBy(m, 'data-dc-reason').value = 'скидка дана ошибочно';
    buttonByText(m, 'Сохранить скидку').click();
    await tick(80);
    const [c] = dcCalls('cashier_invoice_discount_change');
    assert.deepEqual([c.value, c.reduces_doctor_share], [0, false]);
    assert.ok(TOASTS.some((t) => /Скидка изменена — к доплате 40.000 сум\./.test(t)), JSON.stringify(TOASTS));
    const pay = lastModal();
    assert.ok(pay, 'окно оплаты не открылось');
    assert.match(textOf(pay), /Оплата · INV-A-26-00052/);
    closeAll();
});

test('DISCOUNT_CHANGE_PAID_V1: двери — строка счёта со скидкой 100 %, окно «Платежи», окно оплаты частично оплаченного счёта', async () => {
    asRole();
    closeAll(); calls.length = 0;
    rpcAnswers = DC_ANSWERS();
    tables = {};
    const row = desk.__test_invoiceRow(FULL, mkEl('div'));
    const btn = byAttr(row, 'data-discount-change', '53');
    assert.ok(btn, 'у счёта со скидкой 100 % нет «Изменить скидку»');
    assert.ok(!byAttr(desk.__test_invoiceRow(PAID, mkEl('div')), 'data-discount-change', '52'), 'у оплаченного — в «Платежах», не в строке');
    btn.click();
    await tick();
    assert.match(textOf(lastModal()), /Изменить скидку · INV-A-26-00053/);
    closeAll();
    await desk.__test_openInvoiceRefund(PAID, mkEl('div'));
    await tick();
    const pm = lastModal();
    assert.match(textOf(pm), /Платежи · INV-A-26-00052/);
    assert.ok(byAttr(pm, 'data-discount-change', '52'), 'в «Платежах» нет «Изменить скидку»');
    assert.match(textOf(pm), /Скидка счёта: 40.000 сум/);
    closeAll();
    const PART = { ...PAID, status: 'partial', paid_amount: 100000 };
    desk.__test_payModal(mkEl('div'), PART, 60000);
    await tick();
    const pay = lastModal();
    assert.ok(byAttr(pay, 'data-discount-change', '52'), 'в окне оплаты частично оплаченного счёта нет «Изменить скидку»');
    assert.ok(!byAttr(pay, 'data-cashier-discount', '52'), '«Скидка» до оплаты здесь не предлагается');
    closeAll();
    asRole({ 'cashier.discount': 'none' });
    assert.ok(!byAttr(desk.__test_invoiceRow(FULL, mkEl('div')), 'data-discount-change', '53'), 'без права — кнопки нет');
    asRole();
});

test('DISCOUNT_CHANGE_PAID_V1: новые строки окна — в словаре на трёх языках, uz/en без кириллицы', async () => {
    const { STRINGS } = await import('../i18n-strings.js');
    for (const key of ['Изменить скидку', 'Изменить скидку · {no}', 'Изменение скидки', 'Скидка счёта: {sum} сум', 'Скидки у счёта нет.',
        'Счёт {no} · услуги {sub} сум · оплачено {paid} сум', 'Сейчас скидка счёта: {pct}% — {sum} сум', 'Сейчас скидки счёта нет.', 'Причина: {note}',
        'Скидки строк (пакет, ставки по услугам) здесь не меняются.', 'Скидки строк (пакет, ставки по услугам) — {sum} сум — здесь не меняются.',
        'Подняли скидку — касается добавленной части; снизили — всей оставшейся.',
        'Сейчас скидка уменьшает долю врача частично — не трогайте переключатель, и так и останется.',
        'Скидка та же — менять нечего.', 'Скидка — не больше суммы услуг без своей скидки: {sum} сум.', 'Вернуть тем же способом',
        'Оплата подарочной картой всегда возвращается на ту же карту.', 'После сохранения откроется окно оплаты разницы.',
        'Сумма к оплате не меняется — деньги не двигаются.', 'Сохранить скидку', 'Скидка не изменена.',
        'Скидка изменена — пациенту возвращено {sum} сум.', 'Скидка изменена — разница {sum} сум зачислена на баланс пациента.',
        'Скидка изменена — к доплате {sum} сум.', 'Скидка изменена — сумма к оплате не изменилась.',
        'Касса после оплаты: {reason} — было {wasPct}% ({wasSum} сум), стало {nowPct}% ({nowSum} сум)', '(доля врача — частично от цены до скидки)']) {
        const e = STRINGS[key];
        assert.ok(e, 'нет ключа словаря: ' + key);
        assert.equal(e.ru, key);
        for (const lang of ['uz', 'en']) {
            assert.ok(e[lang], key + ': нет перевода ' + lang);
            assert.doesNotMatch(e[lang], /[Ѐ-ӿ]/, key + ': кириллица в ' + lang);
        }
    }
});

// Ревью R2 — значение в поле не трогали (кассир только переключил «Скидка уменьшает долю врача»):
// окно шлёт ту же скидку СУММОЙ (discount_before), а не округлённый процент — деньги не двигаются.
test('ревью R2: значение не трогали — окно шлёт прежнюю скидку суммой, а не округлённый процент', async () => {
    asRole();
    closeAll(); calls.length = 0; TOASTS.length = 0;
    rpcAnswers = DC_ANSWERS();
    desk.openDiscountChange(PAID, null, {});
    await tick();
    const m = lastModal();
    const box = inputBy(m, 'data-dc-reduces');
    box.checked = false; box.fire('change');
    await tick();
    const q = dcCalls('cashier_invoice_discount_change_quote').pop();
    assert.deepEqual([q.mode, q.value, q.reduces_doctor_share], ['abs', 40000, false], 'предпросмотр — прежней суммой');
    inputBy(m, 'data-dc-reason').value = 'клиника берёт скидку на себя';
    buttonByText(m, 'Сохранить скидку').click();
    await tick(80);
    const [c] = dcCalls('cashier_invoice_discount_change');
    assert.deepEqual([c.mode, c.value, c.reduces_doctor_share], ['abs', 40000, false]);
    closeAll();
});

// Ревью R10 — сохранение несёт сумму и оплаченное из предпросмотра; сервер ответил «счёт изменился» —
// окно остаётся, говорит это и пересчитывает с новым счётом.
test('ревью R10: сохранение несёт то, что видел кассир; «счёт изменился» — окно пересчитывает заново', async () => {
    asRole();
    closeAll(); calls.length = 0; TOASTS.length = 0;
    let changedOnce = false;
    rpcAnswers = {
        cashier_invoice_discount_change_quote: quoteFor,
        cashier_invoice_discount_change: (b) => {
            if (!changedOnce) { changedOnce = true; return { __refuse: { status: 409, code: 'invoice_changed', message: 'Счёт изменился, пока окно было открыто — проверьте сумму ещё раз.' } }; }
            return quoteFor(b);
        },
    };
    desk.openDiscountChange(PAID, null, {});
    await tick();
    const m = lastModal();
    const val = inputBy(m, 'data-dc-value');
    val.value = '50'; val.fire('input');
    await tick();
    inputBy(m, 'data-dc-reason').value = 'акция';
    const quotesBefore = dcCalls('cashier_invoice_discount_change_quote').length;
    buttonByText(m, 'Сохранить скидку').click();
    await tick(80);
    const [c] = dcCalls('cashier_invoice_discount_change');
    assert.deepEqual([c.expect_total_before, c.expect_paid_before], [160000, 160000], 'нет того, что видел кассир');
    assert.ok(TOASTS.some((t) => /Счёт изменился, пока окно было открыто/.test(t)), JSON.stringify(TOASTS));
    assert.ok(modals().includes(m), 'окно закрылось после отказа');
    assert.ok(dcCalls('cashier_invoice_discount_change_quote').length >= quotesBefore + 2, 'окно не пересчитало: нынешняя скидка и предпросмотр');
    closeAll();
});

// Ревью п. 10 — результат предпросмотра объявляется читалке экрана; окно кассы — настоящий диалог.
test('ревью п. 10: результат — aria-live="polite"; окно — role="dialog", aria-modal, заголовок', async () => {
    asRole();
    closeAll(); calls.length = 0;
    rpcAnswers = DC_ANSWERS();
    desk.openDiscountChange(PAID, null, {});
    await tick();
    const m = lastModal();
    assert.equal(byAttr(m, 'data-dc-result', '').attrs['aria-live'], 'polite');
    const card = walk(m).find((e) => e.attrs && e.attrs.role === 'dialog');
    assert.ok(card, 'нет role="dialog"');
    assert.equal(card.attrs['aria-modal'], 'true');
    const labelId = card.attrs['aria-labelledby'];
    assert.ok(labelId && walk(m).some((e) => e.attrs && e.attrs.id === labelId), 'aria-labelledby не указывает на заголовок');
    closeAll();
});
