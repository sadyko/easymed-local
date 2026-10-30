// REFUND_SWAP_V1 (2026-10-29) — «Заменить услугу» в окне возврата «Платежи».
//
// Владелец: кнопку видит тот, чьей роли выдано «Исправляет услуги в счёте»
// и у кого есть денежная роль (касса или администратор — как требует сервер
// замены); новая услуга и исполнитель выбираются в одном окне, цену и
// разницу считает сервер; разница — деньгами или на баланс пациента по
// выбору кассира; дороже — сразу окно оплаты «Доплата»; по услуге уже начата
// работа (слово сервера: invoice_line_work performed или отказ line_performed)
// — «Вернуть эту услугу и выставить новую» одной операцией сервера.
//
// Поправка 7 плана: «Платежи», открытые из окна визита
// (openInvoiceRefundById), после замены закрывают только свои окна — окно
// визита остаётся, и onDone зовётся ровно один раз в конце (с доплатой —
// когда закрылось окно оплаты).
//
// Заглушка документа — как у cashier-paid-swap.test.mjs, но окна по-настоящему
// вынимаются из документа (remove) и находятся querySelectorAll('.modal');
// отказ сервера приходит телом { error: { code, message } }, как его отдаёт
// routes/rpc.js.

import { test } from 'node:test';
import assert from 'node:assert';

class FakeNode {
    constructor(tag) {
        this.tagName = String(tag).toUpperCase();
        this.style = {}; this.children = []; this.attrs = {}; this.parentNode = null;
        this.className = ''; this._text = ''; this._l = {}; this.dataset = {}; this.value = '';
    }
    appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); this.children.push(c); c.parentNode = this; return c; }
    removeChild(c) { const i = this.children.indexOf(c); if (i > -1) this.children.splice(i, 1); c.parentNode = null; return c; }
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
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
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

const walk = (e, out = []) => { if (!e || typeof e !== 'object') return out; out.push(e); for (const c of e.children || []) walk(c, out); return out; };
const isModal = (n) => String(n.className || '').split(/\s+/).includes('modal');

const calls = [];
let rpcAnswers = {};
let tables = {};
const printed = [];
const TOASTS = [];
const TOAST_EL = mkEl('div');
Object.defineProperty(TOAST_EL, 'textContent', { get() { return ''; }, set(v) { TOASTS.push(String(v)); }, configurable: true });
globalThis.Node = FakeNode;
globalThis.document = {
    createElement: mkEl, createElementNS: (_n, t) => mkEl(t), createTextNode: (t) => new FakeText(t),
    head: mkEl('head'), body: mkEl('body'), documentElement: mkEl('html'),
    addEventListener() {}, removeEventListener() {}, getElementById: (id) => (id === 'toast' ? TOAST_EL : null),
    // Окна — где угодно в документе, как у браузера.
    querySelectorAll: (sel) => (sel === '.modal' ? walk(document.body).filter((n) => n !== document.body && isModal(n)) : []),
};
const openWin = () => {
    const w = { _html: '', document: { open() {}, write(h) { w._html += h; }, close() { printed.push(w._html); } }, focus() {}, print() {}, close() {} };
    return w;
};
globalThis.window = { location: { hostname: 'localhost' }, localStorage: { getItem: () => null, setItem() {} }, open: openWin, easymed: { state: { user: { id: 9, full_name: 'Кассир' } } } };
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
    const reply = (status, json) => ({ ok: status < 400, status, json: async () => json, headers: { getSetCookie: () => [] } });
    const rpc = String(url).split('/api/rpc/')[1];
    if (rpc) {
        const name = decodeURIComponent(rpc);
        calls.push([name, body]);
        const a = rpcAnswers[name];
        const v = typeof a === 'function' ? a(body) : (a !== undefined ? a : []);
        if (v && v.__error) return reply(v.__error.status || 400, { error: { code: v.__error.code, message: v.__error.message } });
        return reply(200, { data: v });
    }
    calls.push(['db:' + body.table, body]);
    const rows = (tables[body.table] || []).filter((r) => (body.filters || []).every((f) => matches(r, f)));
    return reply(200, { data: body.single ? (rows[0] || null) : rows });
};

const desk = await import('../views/cashier-desk.js');
const perms = await import('../permissions.js');

const textOf = (e) => walk(e).map((x) => x._text || '').join(' ');
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const modals = () => walk(document.body).filter((n) => n !== document.body && isModal(n));
const lastModal = () => modals()[modals().length - 1];
const buttons = (root) => walk(root).filter((e) => e.tagName === 'BUTTON');
const buttonByText = (root, t) => buttons(root).find((b) => textOf(b).trim() === t);
const byAttr = (root, k, v) => walk(root).find((e) => e.attrs && e.attrs[k] === v);
const closeAll = () => { for (const m of modals()) m.remove(); };
const rpcCalls = (name) => calls.filter(([n]) => n === name);

function asRole(role, grants = { 'cashier.lines': 'edit' }) {
    const permissions = { sections: ['cashier', 'patients'], levels: { cashier: 'admin', patients: 'editor' }, grants };
    perms.setEffectiveFromRole({ name: role, permissions });
    window.easymed.state.user = { id: 9, full_name: 'Кассир', role };
}

// Оплаченный счёт визита: приём 150 000 (услуга) и бинт 5 000 (товар).
const PAID = {
    id: 5, invoice_number: 'INV-A-26-00005', visit_id: 40, patient_id: 3, patient_name: 'Рахимов Жасур', mrn: '0024815',
    status: 'paid', subtotal: 155000, discount_amount: 0, total_amount: 155000, paid_amount: 155000, first_item: 'Приём терапевта', items_count: 2,
    created_at: '2026-10-29T05:00:00Z',
};
const ITEMS = [
    { id: 71, invoice_id: 5, description: 'Приём терапевта', quantity: 1, unit_price: 150000, total: 150000, discount_amount: 0 },
    { id: 72, invoice_id: 5, description: 'Бинт стерильный', quantity: 1, unit_price: 5000, total: 5000, discount_amount: 0 },
];
const PAYS = [{ id: 1, invoice_id: 5, amount: 155000, method: 'cash', paid_at: '2026-10-29T05:10:00Z', notes: null }];
const CHEAPER = (b) => ({
    preview: true, changed: true, total_before: 155000, total_after: 85000, paid_before: 155000, refunded: 70000, due: 0,
    line_before: '«Приём терапевта», Врач Первый · 150 000', line_after: '«УЗИ», Врач Второй · 80 000',
    refund_plan: b && b.to_balance
        ? [{ payment_id: 1, method: 'cash', refund_method: 'wallet', amount: 70000, to_balance: true }]
        : [{ payment_id: 1, method: 'cash', refund_method: 'cash', amount: 70000 }],
});
const DEARER = {
    preview: true, changed: true, total_before: 155000, total_after: 205000, paid_before: 155000, refunded: 0, due: 50000,
    refund_plan: [], line_before: '«Приём терапевта», Врач Первый · 150 000', line_after: '«КТ», Врач Второй · 200 000',
};
// `performed` — слово сервера (invoice_line_work, правило lineHasWork); экран
// сам по статусу его не выводит. `lab` — строка счёта — анализ.
function world({ lineStatus = 'queued', performed = false, lab = false } = {}) {
    tables = {
        invoices: [PAID], invoice_items: ITEMS, payments: PAYS, payment_providers: [], patient_discounts: [],
        visit_services: [
            { id: 101, invoice_item_id: 71, service_id: lab ? 4 : 1, status: lineStatus, total: 150000, clinic_item_id: null, consultation_type_id: null,
                services: lab ? { name: 'Глюкоза крови', is_lab: 1, type: 'lab' } : { name: 'Приём терапевта', is_lab: 0, type: 'consultation' },
                doctor_id: { id: 20, full_name: 'Врач Первый' } },
            { id: 102, invoice_item_id: 72, service_id: null, status: 'completed', total: 5000, clinic_item_id: 900, consultation_type_id: null, services: null, doctor_id: null },
        ],
        services: [
            { id: 1, name: 'Приём терапевта', price: 100000, requires_doctor: 0, active: 1, is_lab: 0, type: 'consultation' },
            { id: 2, name: 'УЗИ', price: 80000, requires_doctor: 0, active: 1, is_lab: 0, type: 'procedure' },
            { id: 3, name: 'КТ', price: 200000, requires_doctor: 0, active: 1, is_lab: 0, type: 'procedure' },
            { id: 4, name: 'Глюкоза крови', price: 30000, requires_doctor: 0, active: 1, is_lab: 1, type: 'lab' },
            { id: 5, name: 'Общий анализ крови', price: 40000, requires_doctor: 0, active: 1, is_lab: 1, type: 'lab' },
        ],
    };
    calls.length = 0;
    TOASTS.length = 0;
    rpcAnswers = {
        invoice_line_work: { invoice_id: 5, lines: [
            { invoice_item_id: 71, kind: 'visit', status: lineStatus, product: false, sample: lab && performed, result: false, document: false, performed },
            { invoice_item_id: 72, kind: 'visit', status: 'completed', product: true, sample: false, result: false, document: false, performed: true },
        ] },
        cashier_invoice_search: (b) => ({ q: null, rows: Number(b.invoice_id) === 5 ? [PAID] : [], offset: 0, has_more: false }),
        cashier_line_performers: { performers: [{ id: 20, full_name: 'Врач Первый', unit_price: 80000 }, { id: 21, full_name: 'Врач Второй', specialty: 'Терапевт', unit_price: 80000 }], requires_doctor: false, catalog_price: 80000 },
        cashier_line_swap_quote: (b) => (b.new_service_id === 3 ? DEARER : CHEAPER(b)),
        cashier_line_swap_paid: (b) => (b.new_service_id === 3
            ? { ...DEARER, preview: undefined, invoice: { ...PAID, total_amount: 205000, paid_amount: 155000, status: 'partial' } }
            : { ...CHEAPER(b), preview: undefined, to_balance: !!b.to_balance, invoice: { ...PAID, total_amount: 85000, paid_amount: 85000 } }),
        // Предпросмотр возврата с новой отдаёт line: null — экран её не читает.
        cashier_line_rebill_quote: (b) => ({ ...CHEAPER(b), rebill: true, line: null, old_line_id: 101 }),
        cashier_line_rebill_paid: (b) => ({ ...CHEAPER(b), preview: undefined, rebill: true, to_balance: !!b.to_balance, invoice: { ...PAID, total_amount: 85000, paid_amount: 85000 } }),
        deposit_balance: { balance: 0, debt: 0 },
        cash_shift_summary: { shift: null },
    };
}
// Окно «Платежи» → «Заменить услугу» у приёма → услуга → исполнитель.
async function pickIn(win, serviceId, performer) {
    byAttr(win, 'data-pick', 'service').click();
    await tick();
    byAttr(lastModal(), 'data-service-id', String(serviceId)).click();
    await tick(60);
    byAttr(lastModal(), 'data-performer', String(performer)).click();
    await tick(80);
}
async function openAndPick(serviceId, performer) {
    await desk.__test_openInvoiceRefund(PAID, mkEl('div'));
    byAttr(lastModal(), 'data-refund-swap', '71').click();
    await tick();
    const win = lastModal();
    await pickIn(win, serviceId, performer);
    return win;
}
// Окно визита (внешнее окно) и «Платежи» из него — как visit-modal.js.
async function fromVisitWindow(onDone) {
    closeAll();
    const visitWin = mkEl('div');
    visitWin.className = 'modal';
    document.body.appendChild(visitWin);
    await desk.openInvoiceRefundById(5, { onDone });
    await tick();
    assert.equal(modals().length, 2, 'окно «Платежи» поверх окна визита');
    return visitWin;
}

test('«Заменить услугу» в окне «Платежи»: право строк и денежная роль — все четыре сочетания; у товара, плательщика, отменённого и стационара — нет', async () => {
    const offered = async (inv = PAID) => {
        closeAll();
        await desk.__test_openInvoiceRefund(inv, mkEl('div'));
        const m = lastModal();
        assert.equal(buttons(m).filter((b) => textOf(b).trim() === 'Вернуть услугу').length, 2, '«Вернуть услугу» — у обеих строк, как прежде');
        return !!byAttr(m, 'data-refund-swap', '71');
    };
    world();
    // Право «Исправляет услуги в счёте» есть, денежная роль есть.
    asRole('cashier');
    assert.equal(await offered(), true, 'кассир с правом');
    const m = lastModal();
    assert.match(textOf(m), /Платежи · INV-A-26-00005/);
    assert.equal(byAttr(m, 'data-refund-swap', '72'), undefined, 'у товара — нет');
    asRole('admin', {});
    assert.equal(await offered(), true, 'администратор — по своей роли');
    // Права нет, денежная роль есть.
    asRole('cashier', { 'cashier.lines': 'none' });
    assert.equal(await offered(), false, 'кассир без права — только «Вернуть услугу»');
    asRole('cashier', {});
    assert.equal(await offered(), false, 'кассир, которому право не выдано');
    // Право есть, денежной роли нет (сервер: 403 «её делает касса»).
    asRole('registrar', {});
    assert.equal(await offered(), false, 'регистратура правит неоплаченное, денег не двигает');
    asRole('nurse', { 'cashier.lines': 'edit' });
    assert.equal(await offered(), false, 'право строк без денежной роли');
    // Ни права, ни денежной роли.
    asRole('nurse', {});
    assert.equal(await offered(), false);
    // Счета, которые сервер замены не меняет.
    asRole('cashier');
    assert.equal(await offered({ ...PAID, payer_id: 7 }), false, 'счёт плательщику у кассы не правят');
    assert.equal(await offered({ ...PAID, status: 'void' }), false, 'отменённый счёт');
    assert.equal(await offered({ ...PAID, status: 'refunded' }), false, 'возвращённый счёт');
    assert.equal(await offered({ ...PAID, admission_id: 3 }), false, 'счёт стационара');
    assert.equal(rpcCalls('cashier_line_swap_quote').length, 0);
    closeAll();
});

test('дешевле: одно окно — услуга и исполнитель, разница крупно; «На баланс пациента» пересчитывает; квитанция «Возврат разницы»', async () => {
    asRole('cashier');
    world();
    closeAll();
    printed.length = 0;
    const win = await openAndPick(2, 21);
    assert.match(textOf(win), /Заменить услугу · Приём терапевта/);
    assert.match(textOf(win), /Выберите новую услугу и исполнителя/);
    assert.deepEqual(rpcCalls('cashier_line_performers').at(-1)[1], { service_id: 2, visit_id: 40 }, 'исполнитель — сразу за услугой');
    assert.match(textOf(byAttr(win, 'data-picked-performer', '21')), /Врач Второй/);
    assert.deepEqual(rpcCalls('cashier_line_swap_quote')[0][1], { visit_service_id: 101, new_service_id: 2, doctor_id: 21, card_fallback: 'cash' });
    assert.ok(byAttr(win, 'data-swap-refund', '70000'), 'разница крупно');
    assert.match(textOf(win), /Вернуть деньгами/);
    assert.match(textOf(win), /Наличные — 70 000 сум/);
    assert.equal(byAttr(win, 'data-swap-lab', '1'), undefined, 'не анализ — без слов о лаборатории');
    const radio = walk(byAttr(win, 'data-swap-dest', 'balance')).find((e) => e.tagName === 'INPUT');
    radio.fire('change');
    await tick(80);
    assert.deepEqual(rpcCalls('cashier_line_swap_quote')[1][1], { visit_service_id: 101, new_service_id: 2, doctor_id: 21, to_balance: true, card_fallback: 'balance' });
    assert.match(textOf(win), /На баланс пациента — 70 000 сум/);
    buttonByText(win, 'Заменить и вернуть 70 000 сум').click();
    await tick(150);
    const sent = rpcCalls('cashier_line_swap_paid')[0][1];
    assert.equal(sent.to_balance, true);
    assert.ok(typeof sent.idempotency_key === 'string' && sent.idempotency_key.length >= 8);
    assert.equal(rpcCalls('cashier_line_rebill_paid').length, 0);
    assert.ok(printed.some((html) => /Возврат разницы/.test(html)), 'квитанция «Возврат разницы»');
    assert.deepEqual(modals(), [], 'окно «Платежи» и окно замены закрыты');
    assert.ok(TOASTS.includes('Разница 70 000 сум зачислена на баланс пациента.'), TOASTS.join(' | '));
});

test('дороже: «К доплате» крупно, после замены — окно оплаты, чек «Доплата»', async () => {
    asRole('cashier');
    world();
    closeAll();
    printed.length = 0;
    const win = await openAndPick(3, 21);
    assert.ok(byAttr(win, 'data-swap-due', '50000'));
    assert.match(textOf(win), /После замены откроется окно оплаты разницы/);
    buttonByText(win, 'Заменить и принять доплату').click();
    await tick(150);
    assert.equal(rpcCalls('cashier_line_swap_paid').length, 1);
    assert.equal(modals().length, 1, 'открыто только окно оплаты');
    const pay = lastModal();
    assert.match(textOf(pay), /Оплата · INV-A-26-00005/);
    assert.match(textOf(pay), /50 000/);
    rpcAnswers.record_payment = { invoice: { ...PAID, total_amount: 205000, paid_amount: 205000 } };
    buttonByText(pay, 'Принять оплату').click();
    await tick(200);
    assert.equal(rpcCalls('record_payment')[0][1].amount, 50000);
    assert.ok(printed.some((html) => /Доплата/.test(html)), 'чек доплаты помечен «Доплата»');
    assert.deepEqual(modals(), []);
});

test('работа начата — по слову сервера (invoice_line_work performed), не по статусу строки', async () => {
    asRole('cashier');
    // В очереди, но документ уже есть: сервер говорит performed — сразу возврат с новой.
    world({ lineStatus: 'queued', performed: true });
    closeAll();
    const win = await openAndPick(2, 'none');
    assert.match(textOf(win), /уже начата работа/);
    assert.equal(rpcCalls('cashier_line_swap_quote').length, 0, 'обычная замена не спрашивается');
    assert.deepEqual(rpcCalls('cashier_line_rebill_quote')[0][1], { visit_service_id: 101, new_service_id: 2, no_doctor: true, card_fallback: 'cash' });
    assert.match(textOf(byAttr(win, 'data-picked-performer', 'none')), /Без врача/);
    buttonByText(win, 'Вернуть эту услугу и выставить новую').click();
    await tick(150);
    const sent = rpcCalls('cashier_line_rebill_paid')[0][1];
    assert.equal(sent.no_doctor, true);
    assert.ok(typeof sent.idempotency_key === 'string' && sent.idempotency_key.length >= 8);
    assert.equal(rpcCalls('cashier_line_swap_paid').length, 0);
    assert.ok(TOASTS.includes('Прежняя услуга возвращена: работа осталась в карте пациента и врачу не оплачивается.'), TOASTS.join(' | '));

    // Статус на экране экран не судит: сервер сказал «работы нет» — обычная замена.
    world({ lineStatus: 'completed', performed: false });
    closeAll();
    const win2 = await openAndPick(2, 21);
    assert.equal(rpcCalls('cashier_line_swap_quote').length, 1);
    assert.equal(rpcCalls('cashier_line_rebill_quote').length, 0);
    assert.match(textOf(win2), /Выберите новую услугу и исполнителя/);
    closeAll();
});

test('след работы, которого экран не видит: отказ line_performed переводит окно к возврату с новой услугой', async () => {
    asRole('cashier');
    world();
    closeAll();
    rpcAnswers.cashier_line_swap_quote = { __error: { status: 400, code: 'line_performed', message: 'услуга уже оказывается/оказана (взята проба, есть результат или документ) — заменить нельзя.' } };
    const win = await openAndPick(2, 21);
    assert.equal(rpcCalls('cashier_line_swap_quote').length, 1);
    assert.equal(rpcCalls('cashier_line_rebill_quote').length, 1);
    assert.match(textOf(win), /уже начата работа/);
    assert.ok(buttonByText(win, 'Вернуть эту услугу и выставить новую'));
    closeAll();
});

test('работа началась, пока окно открыто: замена отказала line_performed — денег нет, окно считает возврат с новой с другим ключом', async () => {
    asRole('cashier');
    world();
    closeAll();
    rpcAnswers.cashier_line_swap_paid = { __error: { status: 400, code: 'line_performed', message: 'услуга уже оказывается/оказана (взята проба, есть результат или документ) — заменить нельзя.' } };
    const win = await openAndPick(2, 21);
    buttonByText(win, 'Заменить и вернуть 70 000 сум').click();
    await tick(150);
    assert.equal(rpcCalls('cashier_line_swap_paid').length, 1);
    assert.equal(rpcCalls('cashier_line_rebill_quote').length, 1, 'пересчитано как возврат с новой');
    assert.ok(modals().includes(win), 'окно замены осталось');
    assert.match(textOf(win), /уже начата работа/);
    buttonByText(win, 'Вернуть эту услугу и выставить новую').click();
    await tick(150);
    const swapKey = rpcCalls('cashier_line_swap_paid')[0][1].idempotency_key;
    const rebillKey = rpcCalls('cashier_line_rebill_paid')[0][1].idempotency_key;
    assert.ok(rebillKey && rebillKey !== swapKey, 'другая операция — другой ключ повтора');
    closeAll();
});

test('другой отказ сервера показывается его словами, без перехода к возврату', async () => {
    asRole('cashier');
    world();
    closeAll();
    rpcAnswers.cashier_line_swap_quote = { __error: { status: 409, code: 'bad_request', message: 'Начисления врачам за этот месяц закрыты — услуги визита этого месяца уже не меняют.' } };
    const win = await openAndPick(2, 21);
    assert.match(textOf(win), /Начисления врачам за этот месяц закрыты/);
    assert.equal(rpcCalls('cashier_line_rebill_quote').length, 0);
    assert.equal(buttonByText(win, 'Вернуть эту услугу и выставить новую'), undefined);
    closeAll();
});

test('анализ на анализ: окно говорит, что новый уйдёт в лабораторию новым заказом и пробу отметят заново', async () => {
    asRole('cashier');
    // Проба взята — возврат с новой; новая услуга — тоже анализ.
    world({ lab: true, lineStatus: 'collected', performed: true });
    closeAll();
    const win = await openAndPick(5, 21);
    assert.match(textOf(win), /уже начата работа/);
    const note = byAttr(win, 'data-swap-lab', '1');
    assert.ok(note, 'нет слов о лаборатории');
    assert.match(textOf(note), /новым заказом/);
    assert.match(textOf(note), /той же пробирки/);
    // Новая услуга — не анализ: слов о лаборатории нет.
    await pickIn(win, 2, 21);
    assert.equal(byAttr(win, 'data-swap-lab', '1'), undefined);
    // Неначатый анализ — обычная замена, слова те же.
    world({ lab: true });
    closeAll();
    const win2 = await openAndPick(5, 21);
    assert.equal(rpcCalls('cashier_line_swap_quote').length, 1);
    assert.ok(byAttr(win2, 'data-swap-lab', '1'));
    // Не анализ меняют на анализ — фраза не про эту строку.
    world();
    closeAll();
    const win3 = await openAndPick(5, 21);
    assert.equal(byAttr(win3, 'data-swap-lab', '1'), undefined);
    closeAll();
});

test('поправка 7: «Платежи» из окна визита — после замены окно визита остаётся, onDone — один раз', async () => {
    asRole('cashier');
    world();
    let done = 0;
    const visitWin = await fromVisitWindow(() => { done++; });
    byAttr(lastModal(), 'data-refund-swap', '71').click();
    await tick();
    const win = lastModal();
    await pickIn(win, 2, 21);
    buttonByText(win, 'Заменить и вернуть 70 000 сум').click();
    await tick(150);
    assert.equal(rpcCalls('cashier_line_swap_paid').length, 1);
    assert.deepEqual(modals(), [visitWin], 'окно визита закрылось вместе с «Платежами» или «Платежи» остались');
    assert.equal(done, 1, 'окно визита перечитано ровно один раз');
    assert.equal(rpcCalls('cash_shift_summary').length, 0, 'касса без root не перерисовывается');

    // Возврат с новой — то же.
    world({ performed: true });
    done = 0;
    const visitWin2 = await fromVisitWindow(() => { done++; });
    byAttr(lastModal(), 'data-refund-swap', '71').click();
    await tick();
    const win2 = lastModal();
    await pickIn(win2, 2, 21);
    buttonByText(win2, 'Вернуть эту услугу и выставить новую').click();
    await tick(150);
    assert.equal(rpcCalls('cashier_line_rebill_paid').length, 1);
    assert.deepEqual(modals(), [visitWin2]);
    assert.equal(done, 1);
    closeAll();
});

test('поправка 7: дороже из окна визита — окно оплаты «Доплата» поверх окна визита; onDone — один раз, когда окно оплаты закрылось', async () => {
    asRole('cashier');
    world();
    printed.length = 0;
    let done = 0;
    const visitWin = await fromVisitWindow(() => { done++; });
    byAttr(lastModal(), 'data-refund-swap', '71').click();
    await tick();
    const win = lastModal();
    await pickIn(win, 3, 21);
    buttonByText(win, 'Заменить и принять доплату').click();
    await tick(150);
    assert.equal(modals().length, 2, 'окно визита и окно оплаты');
    assert.equal(modals()[0], visitWin);
    const pay = lastModal();
    assert.match(textOf(pay), /Оплата · INV-A-26-00005/);
    assert.equal(done, 0, 'до оплаты окно визита не перечитывается');
    rpcAnswers.record_payment = { invoice: { ...PAID, total_amount: 205000, paid_amount: 205000 } };
    buttonByText(pay, 'Принять оплату').click();
    await tick(200);
    assert.equal(rpcCalls('record_payment')[0][1].amount, 50000);
    assert.ok(printed.some((html) => /Доплата/.test(html)), 'чек «Доплата»');
    assert.deepEqual(modals(), [visitWin], 'окно оплаты закрылось, окно визита на месте');
    assert.equal(done, 1, 'окно визита перечитано ровно один раз');
    assert.equal(rpcCalls('cash_shift_summary').length, 0, 'касса без root не перерисовывается (и не падает)');

    // Окно оплаты закрыли без оплаты — разница остаётся долгом, окно визита
    // перечитывается тоже один раз.
    world();
    done = 0;
    const visitWin2 = await fromVisitWindow(() => { done++; });
    byAttr(lastModal(), 'data-refund-swap', '71').click();
    await tick();
    const win2 = lastModal();
    await pickIn(win2, 3, 21);
    buttonByText(win2, 'Заменить и принять доплату').click();
    await tick(150);
    const pay2 = lastModal();
    buttonByText(pay2, 'Отмена').click();
    await tick(60);
    assert.deepEqual(modals(), [visitWin2]);
    assert.equal(done, 1);
    assert.equal(rpcCalls('record_payment').length, 0);
    closeAll();
});
