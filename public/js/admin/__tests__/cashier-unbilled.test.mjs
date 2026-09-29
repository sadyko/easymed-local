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
// Тосты слышны: toast() пишет текст в #toast (ui.js) — журнал, как в
// wizard-booking.test.mjs. Печать слышна: окно печати собирает HTML бланка.
const TOASTS = [];
const printed = [];
globalThis.Node = FakeNode;
const TOAST_EL = mkEl('div');
Object.defineProperty(TOAST_EL, 'textContent', { get() { return ''; }, set(v) { TOASTS.push(String(v)); }, configurable: true });
globalThis.document = {
    createElement: mkEl, createElementNS: (_n, t) => mkEl(t), createTextNode: (t) => new FakeText(t),
    head: mkEl('head'), body: mkEl('body'), documentElement: mkEl('html'),
    addEventListener() {}, removeEventListener() {}, getElementById(id) { return id === 'toast' ? TOAST_EL : null; }, querySelectorAll() { return []; },
};
const openWin = () => {
    const w = { _html: '', document: { open() {}, write(x) { w._html += x; }, close() { printed.push(w._html); } }, focus() {}, print() {}, close() {} };
    return w;
};
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

test('карточки «Ждут счёта»: пациент, карта, дата, услуги, «добавил», сумма; окно — сегодня и 30 дней назад', async () => {
    asCashier();
    const st = desk.__test_cardState;
    st.filter = 'unbilled';
    st.search = '';
    st.unbilled = { rows: [ROW_A, ROW_B], totals: { n: 2, sum: 160000 }, found: null };
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
    // REFBILL_REVIEW_V1 (ревью M1) — окно по умолчанию названо: сегодня и 30
    // дней назад; будущие записи — в свой день или поиском.
    assert.ok(textOf(el).includes('Услуги записаны, а счёта нет — сегодня и за 30 дней назад. Выставьте счёт и примите оплату.'), textOf(el).slice(0, 200));
    const s = mkEl('div');
    desk.__test_paintSearch(s, () => {});
    assert.match(textOf(s), /Показано\s+2\s+из\s+2/);
    st.unbilled = { rows: [], totals: { n: 0, sum: 0 }, found: null };
    const e4 = mkEl('div');
    desk.__test_paintTable(e4, mkEl('div'));
    assert.ok(textOf(e4).includes('Ждущих счёта за сегодня и 30 дней назад нет. Записи на будущие дни появятся здесь в свой день или по поиску.'), textOf(e4));
    st.filter = 'unpaid';
});

// REFBILL_REVIEW_V1 (ревью M1) — ПОИСК «ЖДУТ СЧЁТА» — НА СЕРВЕРЕ. Проба
// ревьюера: 320 записей + направление — в первые 300 строк направление не
// попадало, и поиск в браузере по этим 300 не находил «Рахимова». Экран шлёт
// строку поиска серверу (cashier_unbilled { q }) и рисует его ответ — с
// будущими визитами; плашка остаётся числом окна по умолчанию.
test('поиск «Ждут счёта» — на сервере: экран шлёт q, рисует ответ (и будущие визиты), плашка — число окна', async () => {
    asCashier();
    const st = desk.__test_cardState;
    st.filter = 'unbilled';
    st.search = '';
    st.unbilled = { rows: [ROW_A, ROW_B], totals: { n: 2, sum: 160000 }, found: null };
    const FUTURE = { ...ROW_B, visit_id: 42, visit_date: new Date(Date.now() + 5 * 86400000).toISOString() };
    calls.length = 0;
    rpcAnswers = { ...LISTS(), cashier_unbilled: (b) => (b.q === 'карим'
        ? { q: 'карим', rows: [ROW_B, FUTURE], totals: { n: 2, sum: 80000 } }
        : { q: b.q || null, rows: [], totals: { n: 0, sum: 0 } }) };
    st.search = 'карим';
    const repaints = { n: 0 };
    const s = mkEl('div');
    desk.__test_paintSearch(s, () => { repaints.n++; });
    // Пока сервер отвечает — «Ищем…», не местный отбор.
    const busy = mkEl('div');
    desk.__test_paintTable(busy, mkEl('div'));
    assert.match(textOf(busy), /Ищем…/);
    await tick(60);
    assert.deepEqual(rpcCalls('cashier_unbilled').map(([, b]) => b), [{ q: 'карим' }], 'строка поиска не ушла на сервер');
    assert.equal(repaints.n, 1, 'ответ поиска не перерисовал экран');
    const e2 = mkEl('div');
    desk.__test_paintTable(e2, mkEl('div'));
    const shown = walk(e2).filter((x) => x.attrs && x.attrs['data-unbilled-row']).map((x) => x.attrs['data-unbilled-row']);
    assert.deepEqual(shown, ['41', '42'], 'экран рисует ответ сервера — и будущий визит');
    const s2 = mkEl('div');
    desk.__test_paintSearch(s2, () => { repaints.n++; });
    await tick(20);
    assert.equal(rpcCalls('cashier_unbilled').length, 1, 'тот же поиск спрошен второй раз');
    assert.match(textOf(s2), /Показано\s+2\s+из\s+2/);
    const chips = mkEl('div');
    desk.__test_paintChips(chips, () => {});
    assert.match(textOf(buttons(chips).find((b) => /ЖДУТ СЧЁТА/.test(textOf(b)))), /(^|\s)2(\s|$)/, 'плашка — число окна по умолчанию');
    // Никого — так и сказано.
    st.search = 'никого';
    desk.__test_paintSearch(mkEl('div'), () => {});
    await tick(60);
    const e3 = mkEl('div');
    desk.__test_paintTable(e3, mkEl('div'));
    assert.match(textOf(e3), /Нет пациентов по этому поиску\./);
    // Поиск стёрт — снова окно по умолчанию, без сервера.
    st.search = '';
    const before = rpcCalls('cashier_unbilled').length;
    desk.__test_paintSearch(mkEl('div'), () => {});
    const e4 = mkEl('div');
    desk.__test_paintTable(e4, mkEl('div'));
    assert.equal(rpcCalls('cashier_unbilled').length, before);
    assert.deepEqual(walk(e4).filter((x) => x.attrs && x.attrs['data-unbilled-row']).map((x) => x.attrs['data-unbilled-row']), ['40', '41']);
    // Источник: в браузере «Ждут счёта» больше не отбираются.
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('../views/cashier-desk.js', import.meta.url), 'utf8');
    assert.ok(!/function filteredUnbilled\(/.test(src), 'местный отбор «Ждут счёта» вернулся');
    st.filter = 'unpaid';
    st.search = '';
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

// REFBILL_REVIEW_V1 (ревью m6) — отказ сервера (строку, пока окно было
// открыто, выставил другой кассир: «уже в счёте») оставлял в окне прежние
// строки и галочки: второе нажатие снова слало ту же строку. Теперь окно
// перечитывает строки — выставленной нет, её галочки нет, остаток выставляется.
test('m6: отказ сервера — окно перечитывает строки, устаревшие галочки уходят; второе нажатие — только живые строки', async () => {
    asCashier();
    closeAll();
    tables = {
        visit_services: [
            { id: 301, visit_id: 40, invoice_item_id: null, status: 'added', service_id: 1, unit_price: 100000, quantity: 1, clinic_item_id: null, services: { name: 'Приём терапевта' } },
            { id: 304, visit_id: 40, invoice_item_id: null, status: 'added', service_id: 2, unit_price: 20000, quantity: 1, clinic_item_id: null, services: { name: 'Анализ крови' } },
        ],
        payment_providers: [], patient_discounts: [], services: [],
    };
    TOASTS.length = 0;
    rpcAnswers = {
        ...LISTS(),
        visit_refunded_lines: { line_ids: [] },
        create_invoice_for_visit: { __error: 'Услуга №301 уже в счёте.' },
        cash_shift_summary: SUMMARY,
        cashier_unbilled: { rows: [], totals: { n: 0, sum: 0 } },
        deposit_balance: { balance: 0, debt: 0 },
    };
    const st = desk.__test_cardState;
    st.filter = 'unbilled';
    st.search = '';
    st.unbilled = { rows: [ROW_A], totals: { n: 1, sum: 120000 }, found: null };
    const el = mkEl('div');
    desk.__test_paintTable(el, mkEl('div'));
    buttonByText(byAttr(el, 'data-unbilled-row', '40'), 'Выставить счёт').click();
    await tick(80);
    const dlg = lastModal();
    tables.visit_services[0].invoice_item_id = 99;   // строку 301 выставил другой кассир
    calls.length = 0;
    buttonByText(dlg, 'Выставить счёт и принять оплату').click();
    await tick(200);
    assert.deepEqual(rpcCalls('create_invoice_for_visit')[0][1], { visit_id: 40, visit_service_ids: [301, 304] });
    assert.ok(TOASTS.some((t) => t.includes('Услуга №301 уже в счёте.')), JSON.stringify(TOASTS));
    assert.equal(lastModal(), dlg, 'окно закрылось после отказа');
    assert.equal(byAttr(dlg, 'data-rebill-line', '301'), undefined, 'выставленная строка осталась в окне');
    const box = walk(byAttr(dlg, 'data-rebill-line', '304')).find((e) => e.tagName === 'INPUT');
    assert.ok(box && box.hasAttribute('checked'), 'живая строка потеряла галочку');
    rpcAnswers.create_invoice_for_visit = { invoice: { id: 89, invoice_number: 'INV-A-26-00089', visit_id: 40, status: 'unpaid', subtotal: 20000, discount_amount: 0, total_amount: 20000, paid_amount: 0 } };
    calls.length = 0;
    buttonByText(dlg, 'Выставить счёт и принять оплату').click();
    await tick(200);
    assert.deepEqual(rpcCalls('create_invoice_for_visit')[0][1], { visit_id: 40, visit_service_ids: [304] }, 'второе нажатие снова шлёт выставленную строку');
    st.filter = 'unpaid';
});

// ═══════════════════════════════════════════════════════════════════════════
// Решение владельца 2026-09-29: «Card's payer, can split». В окне «Выставить
// счёт» у пациента с ДЕЙСТВУЮЩИМ плательщиком в карте — «Кому счёт»: этот
// плательщик (по умолчанию) или «Пациенту»; других плательщиков нет. Счёт
// плательщику — без окна оплаты: тост и АКТ (та же сборка, что у мастера
// визита, payer-act.js); окно остаётся с невыставленными строками — второй
// проход выставляет их пациенту с окном оплаты.
// ═══════════════════════════════════════════════════════════════════════════
// Визит СЕГОДНЯ: счёт плательщику — со дня визита («From the visit day»).
const INSURED = {
    ...ROW_A, visit_id: 50, lines_count: 2, total: 140000, names: ['Анализ крови', 'Приём терапевта'],
    visit_date: new Date().toISOString(),
    card_payer_id: 5, card_payer_name: 'Esado', card_payer_kind: 'insurance', card_policy_no: 'POL-77',
};
function insuredWorld() {
    tables = {
        visit_services: [
            { id: 401, visit_id: 50, invoice_item_id: null, status: 'added', service_id: 2, unit_price: 40000, quantity: 1, clinic_item_id: null, services: { name: 'Анализ крови' } },
            { id: 402, visit_id: 50, invoice_item_id: null, status: 'added', service_id: 1, unit_price: 100000, quantity: 1, clinic_item_id: null, services: { name: 'Приём терапевта' }, doctor_id: { id: 20, full_name: 'Иванов Врач' } },
        ],
        payment_providers: [], patient_discounts: [], services: [],
        // REFBILL_REVIEW_V1 (ревью m2) — окно само перечитывает плательщика карты.
        patients: [{ id: 3, payer_id: 5, insurance_policy_number: 'POL-77' }],
        payers: [{ id: 5, name: 'Esado', kind: 'insurance', active: 1 }, { id: 6, name: 'Uzbekinvest', kind: 'insurance', active: 1 }],
    };
    // Сервер привязывает выставленные строки к счёту — окно перечитает остаток.
    let seq = 90;
    const bill = (b) => {
        const no = ++seq;
        const byPayer = b.payer_id != null;
        const lines = tables.visit_services.filter((l) => b.visit_service_ids.includes(l.id));
        const items = lines.map((l, i) => ({ id: no * 10 + i, invoice_id: no, description: l.services.name, quantity: 1, unit_price: l.unit_price, total: l.unit_price, discount_amount: 0 }));
        lines.forEach((l, i) => { l.invoice_item_id = items[i].id; });
        const total = items.reduce((a, it) => a + it.total, 0);
        return { invoice: { id: no, invoice_number: 'INV-A-26-000' + no, visit_id: 50, patient_id: 3, payer_id: byPayer ? b.payer_id : null, status: 'unpaid', subtotal: total, discount_amount: 0, total_amount: total, paid_amount: 0 }, items, rest_discount: 0 };
    };
    calls.length = 0; TOASTS.length = 0; printed.length = 0;
    rpcAnswers = {
        ...LISTS(),
        visit_refunded_lines: { line_ids: [] },
        create_invoice_for_visit: bill,
        issue_queue_numbers: (b) => (b.p_ids || []).map((id) => ({ visit_service_id: id, label: 'Лаборатория', number: 12, queue_key: 'lab' })),
        cash_shift_summary: SUMMARY,
        cashier_unbilled: { rows: [], totals: { n: 0, sum: 0 } },
        deposit_balance: { balance: 0, debt: 0 },
    };
}
function openInsuredBill(row = INSURED) {
    const st = desk.__test_cardState;
    st.filter = 'unbilled';
    st.search = '';
    st.unbilled = { rows: [row], totals: { n: 1, sum: row.total } };
    const el = mkEl('div');
    desk.__test_paintTable(el, mkEl('div'));
    return el;
}
const targetRadio = (dlg, v) => walk(byAttr(dlg, 'data-bill-target', v)).find((e) => e.tagName === 'INPUT');
const lineBox = (dlg, id) => walk(byAttr(dlg, 'data-rebill-line', String(id))).find((e) => e.tagName === 'INPUT');

test('плательщик в карте: карточка говорит «Плательщик в карте: …», окно — «Кому счёт» только тогда', async () => {
    asCashier();
    closeAll();
    insuredWorld();
    const el = openInsuredBill();
    const card = byAttr(el, 'data-unbilled-row', '50');
    assert.match(textOf(card), /Плательщик в карте: Esado/);
    buttonByText(card, 'Выставить счёт').click();
    await tick(80);
    const dlg = lastModal();
    assert.match(textOf(dlg), /Кому счёт/);
    assert.ok(targetRadio(dlg, 'payer') && targetRadio(dlg, 'payer').hasAttribute('checked'), 'плательщик из карты — по умолчанию');
    assert.ok(targetRadio(dlg, 'patient') && !targetRadio(dlg, 'patient').hasAttribute('checked'));
    assert.match(textOf(byAttr(dlg, 'data-bill-target', 'payer')), /Esado/);
    assert.ok(buttonByText(dlg, 'Выставить счёт плательщику'), 'кнопка говорит, кому счёт');
    // Без плательщика в карте — выбора нет вовсе.
    closeAll();
    tables.patients[0].payer_id = null;   // REFBILL_REVIEW_V1 — и в самой карте плательщика нет
    const plain = openInsuredBill({ ...INSURED, card_payer_id: null, card_payer_name: null, card_payer_kind: null });
    assert.ok(!/Плательщик в карте/.test(textOf(plain)));
    buttonByText(byAttr(plain, 'data-unbilled-row', '50'), 'Выставить счёт').click();
    await tick(80);
    const dlg2 = lastModal();
    assert.ok(!/Кому счёт/.test(textOf(dlg2)), '«Кому счёт» без плательщика в карте');
    assert.equal(byAttr(dlg2, 'data-bill-target', 'payer'), undefined);
    assert.ok(buttonByText(dlg2, 'Выставить счёт и принять оплату'));
    desk.__test_cardState.filter = 'unpaid';
});

test('раздельно: анализ — плательщику (тост, акт, без окна оплаты, окно остаётся), приём — пациенту (окно оплаты)', async () => {
    asCashier();
    closeAll();
    insuredWorld();
    const el = openInsuredBill();
    buttonByText(byAttr(el, 'data-unbilled-row', '50'), 'Выставить счёт').click();
    await tick(80);
    const dlg = lastModal();
    // Первый проход: только анализ, плательщику.
    const b402 = lineBox(dlg, 402);
    b402.fire('change');   // снять приём: в свежем окне отмечено всё, а свойство checked у заглушки — false
    buttonByText(dlg, 'Выставить счёт плательщику').click();
    await tick(250);
    assert.deepEqual(rpcCalls('create_invoice_for_visit')[0][1], { visit_id: 50, visit_service_ids: [401], payer_id: 5, discount_amount: 0 });
    assert.ok(TOASTS.some((t) => t.includes('Счёт плательщику Esado выставлен — оплата по акту')), 'тоста нет: ' + JSON.stringify(TOASTS));
    assert.ok(!modals().some((m) => /Оплата · /.test(textOf(m))), 'по счёту плательщика у кассы окна оплаты нет');
    const act = printed.find((x) => /Акт оказанных медицинских услуг/.test(x));
    assert.ok(act, 'акт не напечатан');
    assert.match(act, /Esado/);
    assert.match(act, /АКТ INV-A-26-00091/);
    assert.match(act, /POL-77/, 'полис из карты');
    assert.match(act, /Анализ крови/);
    assert.doesNotMatch(act, /Приём терапевта/, 'в акте только строки плательщика');
    assert.match(act, /Лаборатория/, 'талон очереди на акте');
    // Окно осталось: невыставленный приём, теперь — пациенту и отмечен.
    const still = lastModal();
    assert.equal(still, dlg, 'окно «Выставить счёт» закрылось после счёта плательщику');
    assert.equal(byAttr(still, 'data-rebill-line', '401'), undefined, 'выставленная строка всё ещё в окне');
    assert.ok(lineBox(still, 402).hasAttribute('checked'), 'остаток отмечен для второго прохода');
    assert.ok(targetRadio(still, 'patient').hasAttribute('checked'), 'второй проход — пациенту');
    calls.length = 0;
    buttonByText(still, 'Выставить счёт и принять оплату').click();
    await tick(250);
    assert.deepEqual(rpcCalls('create_invoice_for_visit')[0][1], { visit_id: 50, visit_service_ids: [402] });
    assert.match(textOf(lastModal()), /Оплата · INV-A-26-00092/, 'окно оплаты счёта пациента не открылось');
    assert.equal(printed.filter((x) => /Акт оказанных/.test(x)).length, 1, 'по счёту пациента акта нет');
    desk.__test_cardState.filter = 'unpaid';
});

test('плательщик в карте, но касса выбрала «Пациенту» — обычный счёт и окно оплаты, без акта', async () => {
    asCashier();
    closeAll();
    insuredWorld();
    const el = openInsuredBill();
    buttonByText(byAttr(el, 'data-unbilled-row', '50'), 'Выставить счёт').click();
    await tick(80);
    const dlg = lastModal();
    targetRadio(dlg, 'patient').fire('change');
    await tick(20);
    buttonByText(dlg, 'Выставить счёт и принять оплату').click();
    await tick(250);
    assert.deepEqual(rpcCalls('create_invoice_for_visit')[0][1], { visit_id: 50, visit_service_ids: [401, 402] });
    assert.match(textOf(lastModal()), /Оплата · INV-A-26-00091/);
    assert.equal(printed.filter((x) => /Акт оказанных/.test(x)).length, 0);
    desk.__test_cardState.filter = 'unpaid';
});

// ═══════════════════════════════════════════════════════════════════════════
// Решение владельца 2026-09-29: «From the visit day». Счёт плательщику из
// карты — только со дня визита (местный день). Визит впереди — плательщик в
// «Кому счёт» виден, но не выбирается, сказано почему; выставить можно только
// пациенту (предоплата). В день визита и позже — как прежде.
// ═══════════════════════════════════════════════════════════════════════════
test('визит впереди: плательщик из карты виден, но не выбирается, с пояснением; счёт — пациенту', async () => {
    asCashier();
    closeAll();
    insuredWorld();
    const future = new Date(Date.now() + 2 * 86400000).toISOString();
    const el = openInsuredBill({ ...INSURED, visit_date: future });
    buttonByText(byAttr(el, 'data-unbilled-row', '50'), 'Выставить счёт').click();
    await tick(80);
    const dlg = lastModal();
    const payerRadio = targetRadio(dlg, 'payer');
    assert.ok(payerRadio, 'плательщик из карты должен быть виден');
    assert.ok(payerRadio.hasAttribute('disabled'), 'до дня визита плательщика выбрать нельзя');
    assert.ok(!payerRadio.hasAttribute('checked'));
    assert.ok(targetRadio(dlg, 'patient').hasAttribute('checked'), 'выбран «Пациенту»');
    const { fmtDate } = await import('../ui.js');
    assert.ok(textOf(dlg).includes('Счёт плательщику — со дня визита (' + fmtDate(future) + '). Сейчас можно выставить только пациенту (предоплата).'),
        'нет пояснения: ' + textOf(dlg));
    assert.ok(buttonByText(dlg, 'Выставить счёт и принять оплату'), 'кнопка — счёт пациенту');
    assert.equal(buttonByText(dlg, 'Выставить счёт плательщику'), undefined);
    payerRadio.fire('change');   // нажатие по выключенному ничего не меняет
    await tick(20);
    buttonByText(dlg, 'Выставить счёт и принять оплату').click();
    await tick(250);
    assert.deepEqual(rpcCalls('create_invoice_for_visit')[0][1], { visit_id: 50, visit_service_ids: [401, 402] }, 'до дня визита счёт уходит пациенту');
    assert.match(textOf(lastModal()), /Оплата · /, 'предоплата — окно оплаты');
    assert.equal(printed.filter((x) => /Акт оказанных/.test(x)).length, 0);
    desk.__test_cardState.filter = 'unpaid';
});

test('визит сегодня: плательщик из карты выбирается и стоит по умолчанию, пояснения нет', async () => {
    asCashier();
    closeAll();
    insuredWorld();
    const el = openInsuredBill({ ...INSURED, visit_date: new Date().toISOString() });
    buttonByText(byAttr(el, 'data-unbilled-row', '50'), 'Выставить счёт').click();
    await tick(80);
    const dlg = lastModal();
    const payerRadio = targetRadio(dlg, 'payer');
    assert.ok(payerRadio && !payerRadio.hasAttribute('disabled'), 'в день визита плательщик доступен');
    assert.ok(payerRadio.hasAttribute('checked'), 'и стоит по умолчанию');
    assert.ok(!/со дня визита/.test(textOf(dlg)));
    buttonByText(dlg, 'Выставить счёт плательщику').click();
    await tick(250);
    assert.equal(rpcCalls('create_invoice_for_visit')[0][1].payer_id, 5, 'счёт ушёл плательщику');
    desk.__test_cardState.filter = 'unpaid';
});

// ═══════════════════════════════════════════════════════════════════════════
// REFBILL_REVIEW_V1 (ревью m2) — окно «Выставить счёт» выставляло плательщику
// из СТРОКИ СПИСКА: если регистратура убрала или сменила страховую в карте,
// пока список висел или окно было открыто, счёт молча уходил прежней. Теперь
// окно перечитывает плательщика карты при открытии и ещё раз перед счётом;
// изменился — перерисовка и слова, а счёт не уходит, пока касса не нажмёт снова.
// ═══════════════════════════════════════════════════════════════════════════
test('m2: плательщика убрали из карты после списка — окно при открытии говорит об этом, «Кому счёт» нет, счёт — пациенту', async () => {
    asCashier();
    closeAll();
    insuredWorld();
    tables.patients[0].payer_id = null;   // регистратура убрала страховую, список ещё старый
    const el = openInsuredBill();
    buttonByText(byAttr(el, 'data-unbilled-row', '50'), 'Выставить счёт').click();
    await tick(120);
    const dlg = lastModal();
    assert.ok(TOASTS.some((t) => t.includes('В карте пациента больше нет плательщика «Esado» — счёт выставляется пациенту.')), JSON.stringify(TOASTS));
    assert.equal(byAttr(dlg, 'data-bill-target', 'payer'), undefined, 'старый плательщик остался в «Кому счёт»');
    assert.ok(!/Кому счёт/.test(textOf(dlg)));
    calls.length = 0;
    buttonByText(dlg, 'Выставить счёт и принять оплату').click();
    await tick(250);
    assert.deepEqual(rpcCalls('create_invoice_for_visit')[0][1], { visit_id: 50, visit_service_ids: [401, 402] }, 'счёт ушёл не пациенту');
    desk.__test_cardState.filter = 'unpaid';
});

test('m2: плательщик в карте сменился, пока окно открыто — счёт не уходит прежнему; окно перерисовано и сказано; второе нажатие — новому', async () => {
    asCashier();
    closeAll();
    insuredWorld();
    const el = openInsuredBill();
    buttonByText(byAttr(el, 'data-unbilled-row', '50'), 'Выставить счёт').click();
    await tick(120);
    const dlg = lastModal();
    assert.match(textOf(byAttr(dlg, 'data-bill-target', 'payer')), /Esado/);
    tables.patients[0].payer_id = 6;   // пока окно открыто, в карте поставили другую страховую
    calls.length = 0; TOASTS.length = 0;
    buttonByText(dlg, 'Выставить счёт плательщику').click();
    await tick(250);
    assert.equal(rpcCalls('create_invoice_for_visit').length, 0, 'счёт ушёл прежнему плательщику');
    assert.ok(TOASTS.some((t) => t.includes('Плательщик в карте пациента изменился: теперь «Uzbekinvest». Проверьте «Кому счёт».')), JSON.stringify(TOASTS));
    assert.match(textOf(byAttr(dlg, 'data-bill-target', 'payer')), /Uzbekinvest/, '«Кому счёт» не перерисован');
    buttonByText(dlg, 'Выставить счёт плательщику').click();
    await tick(250);
    assert.equal(rpcCalls('create_invoice_for_visit')[0][1].payer_id, 6, 'второе нажатие — новому плательщику');
    desk.__test_cardState.filter = 'unpaid';
});
