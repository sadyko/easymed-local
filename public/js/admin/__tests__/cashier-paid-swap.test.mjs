// CASHIER_PAID_SWAP_V1 (2026-09-28) — касса: замена услуги и врача в
// ОПЛАЧЕННОМ счёте с расчётом разницы и «Возвраты и отмены».
//
// Владелец: «Refunded bills in the cashier window disappear completely, so we
// need to see them somewhere so we can change the service. Or paid bills: we
// cannot change the service — [we need to] make a refund or bill more if the
// price is different.»
//
// Окно подтверждения показывает сумму и куда она уйдёт (предпросмотр
// сервера), дороже — открывается окно оплаты разницы; плашка «ВОЗВРАТЫ И
// ОТМЕНЫ» со своим периодом; «Выставить заново» — строки визита без счёта.
// Заглушка документа — та же, что у cashier-line-fix.test.mjs.

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
    } else {
        calls.push(['db:' + body.table, body]);
        const rows = (tables[body.table] || []).filter((r) => (body.filters || []).every((f) => matches(r, f)));
        data = body.single ? (rows[0] || null) : rows;
    }
    return { ok: true, status: 200, json: async () => ({ data }), headers: { getSetCookie: () => [] } };
};

const desk = await import('../views/cashier-desk.js');
const fix = await import('../views/cashier-line-fix.js');
const perms = await import('../permissions.js');
const rp = await import('../views/receipt-print.js');

const walk = (e, out = []) => { if (!e || typeof e !== 'object') return out; out.push(e); for (const c of e.children || []) walk(c, out); return out; };
const textOf = (e) => walk(e).map((x) => x._text || '').join(' ');
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const modals = () => document.body.children.filter((c) => c.className === 'modal');
const lastModal = () => modals()[modals().length - 1];
const buttons = (root) => walk(root).filter((e) => e.tagName === 'BUTTON');
const buttonByText = (root, t) => buttons(root).find((b) => textOf(b).trim() === t);
const byAttr = (root, k, v) => walk(root).find((e) => e.attrs && e.attrs[k] === v);
const fixButton = (row) => buttons(row).find((b) => b.getAttribute('title') === 'Исправить услуги');
const closeAll = () => { document.body.children = document.body.children.filter((c) => c.className !== 'modal'); };
const rpcCalls = (name) => calls.filter(([n]) => n === name);

function asRole(role, grants = { 'cashier.lines': 'edit' }) {
    const permissions = { sections: ['cashier', 'patients'], levels: { cashier: 'admin', patients: 'editor' }, grants };
    perms.setEffectiveFromRole({ name: role, permissions });
    window.easymed.state.user = { id: 9, full_name: 'Кассир', role };
}

const PAID = {
    id: 5, invoice_number: 'INV-A-26-00005', visit_id: 40, patient_id: 3, patient_name: 'Рахимов Жасур', mrn: '0024815',
    status: 'paid', subtotal: 150000, discount_amount: 0, total_amount: 150000, paid_amount: 150000, first_item: 'Приём терапевта', items_count: 1,
    created_at: '2026-09-28T05:00:00Z',
};
const ITEMS = [{ id: 71, invoice_id: 5, description: 'Приём терапевта', total: 150000, discount_amount: 0 }];
const LINES = [{ id: 101, invoice_item_id: 71, service_id: 1, status: 'queued', total: 150000, clinic_item_id: null, doctor_id: { id: 20, full_name: 'Врач Первый' } }];
const QUOTE_CHEAPER = (to_balance) => ({
    preview: true, changed: true, total_before: 150000, total_after: 80000, paid_before: 150000, refunded: 70000, due: 0,
    line_before: '«Приём терапевта», Врач Первый · 150 000', line_after: '«УЗИ», Врач Первый · 80 000',
    refund_plan: to_balance
        ? [{ payment_id: 2, method: 'card', refund_method: 'wallet', amount: 50000, to_balance: true }, { payment_id: 1, method: 'cash', refund_method: 'wallet', amount: 20000, to_balance: true }]
        : [{ payment_id: 2, method: 'card', refund_method: 'card', amount: 50000 }, { payment_id: 1, method: 'cash', refund_method: 'cash', amount: 20000 }],
});
function world(inv = PAID) {
    tables = { invoices: [inv], invoice_items: ITEMS, visit_services: LINES, payment_providers: [], patient_discounts: [],
        services: [{ id: 1, name: 'Приём терапевта', price: 100000, requires_doctor: 0, active: 1 }, { id: 2, name: 'УЗИ', price: 80000, requires_doctor: 0, active: 1 }, { id: 3, name: 'КТ', price: 200000, requires_doctor: 0, active: 1 }] };
    calls.length = 0;
    rpcAnswers = {
        cashier_line_swap_quote: (b) => (b.new_service_id === 3
            ? { preview: true, changed: true, total_before: 150000, total_after: 200000, paid_before: 150000, refunded: 0, due: 50000, refund_plan: [], line_before: 'Приём', line_after: 'КТ' }
            : QUOTE_CHEAPER(b.to_balance)),
        cashier_line_swap_paid: (b) => (b.new_service_id === 3
            ? { changed: true, refunded: 0, due: 50000, refund_plan: [], invoice: { ...inv, total_amount: 200000, status: 'partial' }, line_before: 'Приём', line_after: 'КТ' }
            : { ...QUOTE_CHEAPER(b.to_balance), preview: undefined, to_balance: !!b.to_balance, invoice: { ...inv, total_amount: 80000, paid_amount: 80000 } }),
        deposit_balance: { balance: 0, debt: 0 },
    };
}

test('оплаченный счёт: у кассира с правом — «Заменить услугу» и «Сменить врача», без «Убрать»', async () => {
    asRole('cashier');
    world();
    closeAll();
    await fix.openLineFix(PAID);
    const m = lastModal();
    assert.match(textOf(m), /разницу касса сразу вернёт/);
    const row = byAttr(m, 'data-line', '101');
    assert.ok(byAttr(row, 'data-swap', 'service') && byAttr(row, 'data-swap', 'doctor'));
    assert.equal(buttonByText(row, 'Убрать'), undefined, 'оплаченное снимает «Вернуть услугу»');
});

test('оплаченный счёт у регистратуры — замены нет: деньги двигает только касса', async () => {
    asRole('registrar', {});
    world();
    closeAll();
    assert.equal(perms.canSwapPaidLines(), false);
    await fix.openLineFix(PAID);
    const row = byAttr(lastModal(), 'data-line', '101');
    assert.equal(byAttr(row, 'data-swap', 'service'), undefined);
});

test('дешевле: окно показывает сумму и куда; выбор «на баланс» пересчитывает; квитанция «Возврат разницы»', async () => {
    asRole('cashier');
    world();
    closeAll();
    const slips = [];
    await fix.openLineFix(PAID, { printSlip: (d) => slips.push(d) });
    byAttr(byAttr(lastModal(), 'data-line', '101'), 'data-swap', 'service').click();
    await tick();
    byAttr(lastModal(), 'data-service-id', '2').click();
    await tick(80);
    const conf = lastModal();
    assert.match(textOf(conf), /Замена в оплаченном счёте/);
    assert.equal(byAttr(conf, 'data-swap-refund', '70000') != null, true);
    assert.match(textOf(conf), /Вернуть пациенту/);
    assert.match(textOf(conf), /Карта — 50 000 сум/);
    assert.match(textOf(conf), /Наличные — 20 000 сум/);
    assert.deepEqual(rpcCalls('cashier_line_swap_quote')[0][1], { visit_service_id: 101, new_service_id: 2, to_balance: false, card_fallback: 'cash' });
    // «На баланс пациента» — предпросмотр заново.
    const radio = walk(byAttr(conf, 'data-swap-dest', 'balance')).find((e) => e.tagName === 'INPUT');
    radio.fire('change');
    await tick(80);
    assert.equal(rpcCalls('cashier_line_swap_quote').length, 2);
    assert.equal(rpcCalls('cashier_line_swap_quote')[1][1].to_balance, true);
    assert.match(textOf(lastModal()), /На баланс пациента — 50 000 сум/);
    buttonByText(lastModal(), 'Заменить и вернуть 70 000 сум').click();
    await tick(80);
    const sent = rpcCalls('cashier_line_swap_paid')[0][1];
    assert.equal(sent.to_balance, true);
    assert.equal(sent.card_fallback, 'balance');
    assert.ok(typeof sent.idempotency_key === 'string' && sent.idempotency_key.length >= 8);
    assert.equal(slips.length, 1);
    assert.equal(slips[0].kind, 'swap');
    assert.equal(slips[0].refunded, 70000);
    const slip = rp.slipData(slips[0]);
    assert.equal(slip.subtitle, 'Возврат разницы');
    assert.equal(slip.amount, 70000);
    assert.match(slip.method, /На баланс пациента 50 000/);
});

test('дороже: окно говорит «К доплате», после замены касса открывает окно оплаты разницы', async () => {
    asRole('cashier');
    world();
    closeAll();
    const row = desk.__test_invoiceRow(PAID, mkEl('div'));
    fixButton(row).click();
    await tick(80);
    byAttr(byAttr(lastModal(), 'data-line', '101'), 'data-swap', 'service').click();
    await tick();
    byAttr(lastModal(), 'data-service-id', '3').click();
    await tick(80);
    const conf = lastModal();
    assert.equal(byAttr(conf, 'data-swap-due', '50000') != null, true);
    assert.match(textOf(conf), /К доплате/);
    buttonByText(conf, 'Заменить и принять доплату').click();
    await tick(120);
    assert.equal(rpcCalls('cashier_line_swap_paid').length, 1);
    const pay = lastModal();
    assert.match(textOf(pay), /Оплата · INV-A-26-00005/);
    assert.match(textOf(pay), /50 000/);
    // Приняли доплату — чек с пометкой «Доплата».
    printed.length = 0;
    rpcAnswers.record_payment = { invoice: { ...PAID, total_amount: 200000, paid_amount: 200000 } };
    rpcAnswers.cash_shift_summary = { shift: null };
    buttonByText(pay, 'Принять оплату').click();
    await tick(200);
    assert.equal(rpcCalls('record_payment')[0][1].amount, 50000);
    assert.ok(printed.some((html) => /Доплата/.test(html)), 'чек доплаты помечен «Доплата»');
});

test('плашка «ВОЗВРАТЫ И ОТМЕНЫ»: сегодня по умолчанию, сумма возвращённого', async () => {
    asRole('cashier');
    calls.length = 0;
    const st = desk.__test_cardState;
    st.refunds = { from: null, to: null, rows: [], totals: null };
    rpcAnswers = { cashier_refunds: { rows: [], totals: { n: 2, refunded: 220000 } } };
    await desk.__test_loadRefunds();
    const sent = rpcCalls('cashier_refunds')[0][1];
    assert.match(sent.from, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(sent.to, sent.from);
    const el = mkEl('div');
    desk.__test_paintChips(el, () => {});
    const chip = buttons(el).find((b) => /ВОЗВРАТЫ И ОТМЕНЫ/.test(textOf(b)));
    assert.ok(chip, 'плашка есть');
    assert.match(textOf(chip), /220 000/);
});

test('список «Возвраты и отмены»: что вернули, кто и почему; «Выставить заново» только когда есть что выставить', async () => {
    asRole('cashier');
    const st = desk.__test_cardState;
    st.refunds = {
        from: '2026-09-28', to: '2026-09-28', totals: { n: 2, refunded: 70000 },
        rows: [
            { invoice_id: 5, invoice_number: 'INV-A-26-00005', status: 'paid', patient_name: 'Рахимов Жасур', mrn: '0024815', visit_id: 40, patient_id: 3,
              refunded_total: 70000, refunds: [{ amount: 70000, method: 'cash', kind: 'swap', at: '2026-09-28T07:00:00Z', who: 'Кассир', reason: 'Замена услуги — возврат разницы' }],
              events: [], rebill_lines: [], can_rebill: false, total_amount: 80000, paid_amount: 80000 },
            { invoice_id: 6, invoice_number: 'INV-A-26-00006', status: 'void', patient_name: 'Каримова Нигора', visit_id: 41, patient_id: 4,
              refunded_total: 0, refunds: [], events: [{ action: 'void', at: '2026-09-28T08:00:00Z', who: 'Кассир', reason: 'другой врач', notes: '' }],
              rebill_lines: [{ id: 201, name: 'Приём терапевта', refunded: false }], can_rebill: true, total_amount: 150000, paid_amount: 0 },
        ],
    };
    const el = mkEl('div');
    desk.__test_paintRefunds(el, mkEl('div'));
    const a = byAttr(el, 'data-refund-row', '5');
    assert.match(textOf(a), /−70 000/);
    assert.match(textOf(a), /Наличные/);
    assert.match(textOf(a), /Замена услуги/);
    assert.match(textOf(a), /Возвращено 70 000 сум/);
    assert.ok(buttonByText(a, 'Открыть визит'));
    assert.equal(buttonByText(a, 'Выставить заново'), undefined);
    assert.ok(buttonByText(a, 'Исправить услуги'), 'оплаченный счёт с возвратом можно исправить');
    const b = byAttr(el, 'data-refund-row', '6');
    assert.match(textOf(b), /Счёт отменён/);
    assert.match(textOf(b), /другой врач/);
    assert.ok(buttonByText(b, 'Выставить заново'));
    assert.equal(buttonByText(b, 'Исправить услуги'), undefined, 'отменённый счёт не исправляют — выставляют заново');
    // Период: «Показать» спрашивает сервер за выбранные дни.
    calls.length = 0;
    rpcAnswers = { cashier_refunds: { rows: [], totals: { n: 0, refunded: 0 } } };
    const inputs = walk(byAttr(el, 'data-refunds-period', '1')).filter((e) => e.tagName === 'INPUT');
    inputs[0].value = '2026-09-01';
    inputs[1].value = '2026-09-28';
    buttonByText(el, 'Показать').click();
    await tick();
    assert.deepEqual(rpcCalls('cashier_refunds')[0][1], { from: '2026-09-01', to: '2026-09-28' });
    assert.match(textOf(el), /За этот период возвратов и отмен нет/);
});

test('«Выставить заново»: строки визита без счёта, «возвращено», выставить с rebill_refunded и сразу окно оплаты', async () => {
    asRole('cashier');
    closeAll();
    tables = {
        visit_services: [
            { id: 201, visit_id: 41, invoice_item_id: null, status: 'queued', service_id: 1, unit_price: 150000, quantity: 1, clinic_item_id: null, services: { name: 'Приём терапевта' }, doctor_id: { id: 20, full_name: 'Врач Первый' } },
            { id: 202, visit_id: 41, invoice_item_id: 99, status: 'queued', service_id: 2, unit_price: 80000, quantity: 1, clinic_item_id: null, services: { name: 'УЗИ' } },
        ],
        payment_providers: [], patient_discounts: [],
        services: [{ id: 2, name: 'УЗИ', price: 80000, requires_doctor: 0, active: 1 }],
    };
    calls.length = 0;
    rpcAnswers = {
        visit_refunded_lines: { line_ids: [201] },
        create_invoice_for_visit: { invoice: { id: 77, invoice_number: 'INV-A-26-00077', visit_id: 41, status: 'unpaid', subtotal: 150000, discount_amount: 0, total_amount: 150000, paid_amount: 0 } },
        deposit_balance: { balance: 0, debt: 0 },
        cash_shift_summary: { shift: null },
    };
    const st = desk.__test_cardState;
    st.refunds = { from: '2026-09-28', to: '2026-09-28', totals: { n: 1, refunded: 0 }, rows: [
        { invoice_id: 6, invoice_number: 'INV-A-26-00006', status: 'void', patient_name: 'Каримова Нигора', mrn: 'P-4', visit_id: 41, patient_id: 4,
          refunded_total: 150000, refunds: [], events: [], rebill_lines: [{ id: 201, name: 'Приём терапевта', refunded: true }], can_rebill: true },
    ] };
    const el = mkEl('div');
    desk.__test_paintRefunds(el, mkEl('div'));
    byAttr(el, 'data-rebill', '6').click();
    await tick(80);
    const dlg = lastModal();
    assert.match(textOf(dlg), /Выставить заново · INV-A-26-00006/);
    assert.ok(byAttr(dlg, 'data-rebill-line', '201'), 'невыставленная строка показана');
    assert.equal(byAttr(dlg, 'data-rebill-line', '202'), undefined, 'строка в другом счёте — нет');
    assert.match(textOf(dlg), /возвращено/);
    assert.ok(buttonByText(byAttr(dlg, 'data-rebill-line', '201'), 'Заменить услугу'));
    buttonByText(dlg, 'Выставить счёт и принять оплату').click();
    await tick(120);
    assert.deepEqual(rpcCalls('create_invoice_for_visit')[0][1], { visit_id: 41, visit_service_ids: [201], rebill_refunded: true });
    assert.match(textOf(lastModal()), /Оплата · INV-A-26-00077/);
});
