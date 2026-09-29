// REFERRAL_BILL_V1 (2026-09-29) — «ЖДУТ СЧЁТА» В «ПРИЁМЕ ОПЛАТ».
//
// Владелец: «While we are seeing the patient as a doctor and refer to another
// service or a doctor we cannot see them in the cashier's window. Which means
// flow is broken.» Касса видела одни счета; визит со строками без счёта ей был
// не виден. Плашка «ЖДУТ СЧЁТА» (cashier_unbilled) грузится вместе со счетами;
// карточка — пациент, карта, дата, услуги, «добавил: …», сумма; «Выставить
// счёт» — окно «Выставить заново» (openRebill) с заголовком «Выставить счёт ·
// {пациент}», затем сразу окно оплаты, как у «Возвратов и отмен»; поиск кассы
// фильтрует и карточки. Заглушка документа — та же, что у
// cashier-paid-swap.test.mjs.

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
globalThis.Node = FakeNode;
globalThis.document = {
    createElement: mkEl, createElementNS: (_n, t) => mkEl(t), createTextNode: (t) => new FakeText(t),
    head: mkEl('head'), body: mkEl('body'), documentElement: mkEl('html'),
    addEventListener() {}, removeEventListener() {}, getElementById() { return null; }, querySelectorAll() { return []; },
};
const openWin = () => ({ document: { open() {}, write() {}, close() {} }, focus() {}, print() {}, close() {} });
globalThis.window = { location: { hostname: 'localhost' }, localStorage: { getItem: () => null, setItem() {} }, open: openWin, easymed: { state: { user: { id: 9, full_name: 'Кассир', role: 'cashier' } } } };
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
        // Отказ сервера — { __error: 'текст' }: ответ 500 с сообщением.
        if (a && a.__error) return { ok: false, status: 500, json: async () => ({ error: { message: a.__error } }), headers: { getSetCookie: () => [] } };
        data = typeof a === 'function' ? a(body) : (a !== undefined ? a : []);
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
const closeAll = () => { document.body.children = document.body.children.filter((c) => c.className !== 'modal'); };
const rpcCalls = (name) => calls.filter(([n]) => n === name);

function asCashier() {
    perms.setEffectiveFromRole({ name: 'cashier', permissions: { sections: ['cashier', 'patients'], levels: { cashier: 'admin', patients: 'editor' }, grants: { 'cashier.lines': 'edit' } } });
    window.easymed.state.user = { id: 9, full_name: 'Кассир', role: 'cashier' };
}

const ROW_A = {
    visit_id: 40, visit_date: '2026-09-29T05:00:00Z', patient_id: 3, patient_name: 'Рахимов Жасур', mrn: 'A-000015',
    phone: '+998901112233', date_of_birth: '1990-05-01', gender: 'male',
    lines_count: 3, total: 120000, names: ['Приём терапевта', 'Анализ крови'], added_by: 'Иванов Врач',
};
const ROW_B = {
    visit_id: 41, visit_date: '2026-09-28T06:00:00Z', patient_id: 4, patient_name: 'Каримова Нигора', mrn: 'A-000016',
    phone: '+998907776655', lines_count: 1, total: 40000, names: ['Анализ крови'], added_by: 'Регистратура',
};
const LISTS = () => ({
    cashier_invoices: { rows: [], counts: null },
    list_deposits: { rows: [] },
    list_card_sales: { rows: [] },
    cashier_refunds: { rows: [], totals: { n: 0, refunded: 0 } },
});
const SUMMARY = {
    shift: { id: 1, opening_float: 0, opened_at: new Date().toISOString(), status: 'open' },
    totals: { count: 0, total: 0, cash: 0, card: 0, acquiring: 0 },
    cash_in: 0, cash_out: 0, expected_drawer: 0, cashier_name: 'Кассир',
};

test('плашка «ЖДУТ СЧЁТА»: грузится вместе со счетами, число и сумма — из cashier_unbilled; сбой не прячет счета', async () => {
    asCashier();
    calls.length = 0;
    rpcAnswers = { ...LISTS(), cashier_unbilled: { from: '2026-08-30', rows: [ROW_A, ROW_B], totals: { n: 2, sum: 160000 } } };
    await desk.__test_loadInvoices();
    assert.equal(rpcCalls('cashier_invoices').length, 1);
    assert.equal(rpcCalls('cashier_unbilled').length, 1, '«Ждут счёта» не грузится вместе со счетами');
    const el = mkEl('div');
    desk.__test_paintChips(el, () => {});
    const chip = buttons(el).find((b) => /ЖДУТ СЧЁТА/.test(textOf(b)));
    assert.ok(chip, 'плашки «ЖДУТ СЧЁТА» нет');
    assert.match(textOf(chip), /(^|\s)2(\s|$)/, 'число ждущих');
    assert.match(textOf(chip), /160 000/, 'их сумма');
    // Сбой списка «Ждут счёта» счета не прячет — плашка просто 0.
    rpcAnswers = { ...LISTS(), cashier_invoices: { rows: [{ id: 5, status: 'unpaid', total_amount: 1000, paid_amount: 0 }], counts: null }, cashier_unbilled: { __error: 'нет связи' } };
    await desk.__test_loadInvoices();
    assert.equal(desk.__test_cardState.rows.length, 1, 'счета пропали вместе со списком «Ждут счёта»');
    const el2 = mkEl('div');
    desk.__test_paintChips(el2, () => {});
    assert.match(textOf(buttons(el2).find((b) => /ЖДУТ СЧЁТА/.test(textOf(b)))), /(^|\s)0(\s|$)/);
});

test('карточки «Ждут счёта»: пациент, карта, дата, услуги, «добавил», сумма; поиск кассы фильтрует и их', async () => {
    asCashier();
    const st = desk.__test_cardState;
    st.filter = 'unbilled';
    st.search = '';
    st.unbilled = { rows: [ROW_A, ROW_B], totals: { n: 2, sum: 160000 } };
    const el = mkEl('div');
    desk.__test_paintTable(el, mkEl('div'));
    const a = byAttr(el, 'data-unbilled-row', '40');
    assert.ok(a, 'нет карточки визита 40');
    const ta = textOf(a);
    const { fmtDate } = await import('../ui.js');
    for (const piece of ['Рахимов Жасур', 'A-000015', fmtDate(ROW_A.visit_date), 'Приём терапевта, Анализ крови', '+1 ещё', 'добавил: Иванов Врач', '120 000']) {
        assert.ok(ta.includes(piece), 'в карточке нет «' + piece + '»: ' + ta);
    }
    assert.ok(buttonByText(a, 'Выставить счёт'), 'нет «Выставить счёт»');
    assert.ok(buttonByText(a, 'Открыть визит'), 'нет «Открыть визит»');
    assert.ok(byAttr(el, 'data-unbilled-row', '41'));
    // Поиск: фамилия, карта, телефон.
    for (const [q, want] of [['карим', '41'], ['A-000015', '40'], ['998901112233', '40']]) {
        st.search = q;
        const e2 = mkEl('div');
        desk.__test_paintTable(e2, mkEl('div'));
        const shown = walk(e2).filter((x) => x.attrs && x.attrs['data-unbilled-row']).map((x) => x.attrs['data-unbilled-row']);
        assert.deepEqual(shown, [want], 'поиск «' + q + '»');
    }
    // «Показано N из M» считает карточки, а не счета.
    st.search = 'карим';
    const s = mkEl('div');
    desk.__test_paintSearch(s, () => {});
    assert.match(textOf(s), /Показано\s+1\s+из\s+2/);
    st.search = 'никого';
    const e3 = mkEl('div');
    desk.__test_paintTable(e3, mkEl('div'));
    assert.equal(byAttr(e3, 'data-unbilled-row', '40'), undefined);
    st.search = '';
    st.unbilled = { rows: [], totals: { n: 0, sum: 0 } };
    const e4 = mkEl('div');
    desk.__test_paintTable(e4, mkEl('div'));
    assert.match(textOf(e4), /ждущих счёта нет/);
    st.filter = 'unpaid';
});

test('«Выставить счёт»: окно «Выставить счёт · пациент», возвращённая строка не отмечена; счёт — и сразу окно оплаты; обе ленты перечитаны', async () => {
    asCashier();
    closeAll();
    tables = {
        visit_services: [
            { id: 301, visit_id: 40, invoice_item_id: null, status: 'added', service_id: 1, unit_price: 100000, quantity: 1, clinic_item_id: null, services: { name: 'Приём терапевта' }, doctor_id: { id: 20, full_name: 'Иванов Врач' } },
            { id: 302, visit_id: 40, invoice_item_id: null, status: 'completed', service_id: 2, unit_price: 20000, quantity: 1, clinic_item_id: null, services: { name: 'Анализ крови' } },
            { id: 303, visit_id: 40, invoice_item_id: 99, status: 'queued', service_id: 2, unit_price: 20000, quantity: 1, clinic_item_id: null, services: { name: 'Анализ крови' } },
        ],
        payment_providers: [], patient_discounts: [], services: [],
    };
    calls.length = 0;
    rpcAnswers = {
        ...LISTS(),
        visit_refunded_lines: { line_ids: [302] },
        create_invoice_for_visit: { invoice: { id: 88, invoice_number: 'INV-A-26-00088', visit_id: 40, status: 'unpaid', subtotal: 100000, discount_amount: 0, total_amount: 100000, paid_amount: 0 } },
        cash_shift_summary: SUMMARY,
        cashier_unbilled: { rows: [], totals: { n: 0, sum: 0 } },
        deposit_balance: { balance: 0, debt: 0 },
    };
    const st = desk.__test_cardState;
    st.filter = 'unbilled';
    st.search = '';
    st.unbilled = { rows: [ROW_A], totals: { n: 1, sum: 120000 } };
    const el = mkEl('div');
    const root = mkEl('div');
    desk.__test_paintTable(el, root);
    buttonByText(byAttr(el, 'data-unbilled-row', '40'), 'Выставить счёт').click();
    await tick(80);
    const dlg = lastModal();
    assert.ok(dlg, 'окно не открылось');
    assert.match(textOf(dlg), /Выставить счёт · Рахимов Жасур/, 'заголовок окна: ' + textOf(dlg).slice(0, 120));
    assert.ok(!/Выставить заново/.test(textOf(dlg)), 'заголовок «Выставить заново» — это окно отменённых счетов');
    const box = (id) => walk(byAttr(dlg, 'data-rebill-line', String(id))).find((e) => e.tagName === 'INPUT');
    assert.ok(box(301).hasAttribute('checked'), 'строка без счёта не отмечена');
    assert.ok(!box(302).hasAttribute('checked'), 'строку, за которую вернули деньги, отсюда молча не выставляют');
    assert.match(textOf(byAttr(dlg, 'data-rebill-line', '302')), /возвращено/);
    assert.equal(byAttr(dlg, 'data-rebill-line', '303'), undefined, 'строка в другом счёте — нет');
    calls.length = 0;
    buttonByText(dlg, 'Выставить счёт и принять оплату').click();
    await tick(200);
    assert.deepEqual(rpcCalls('create_invoice_for_visit')[0][1], { visit_id: 40, visit_service_ids: [301] });
    const pay = lastModal();
    assert.match(textOf(pay), /Оплата · INV-A-26-00088/, 'окно оплаты не открылось');
    assert.match(textOf(pay), /100 000/);
    assert.ok(rpcCalls('cashier_invoices').length >= 1, 'список счетов не перечитан');
    assert.ok(rpcCalls('cashier_unbilled').length >= 1, 'список «Ждут счёта» не перечитан');
    st.filter = 'unpaid';
});
