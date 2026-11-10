// VISIT_TIER_SHOWN_CASHIER_V1 (2026-11-10) — «ВТОРОЙ ВИЗИТ» / «ПОВТОРНЫЙ ВИЗИТ» В КАССЕ.
//
// Владелец: убедиться, что изменение цены по счёту визита видят касса и
// регистратура. Мастер визита и смета показывали чип и зачёркнутую цену первого
// визита; касса — одну сумму. Теперь окно оплаты («За что платим»), «Исправить
// услуги», «Выставить счёт» и «Платежи» спрашивают cashier_line_tiers и ставят тот
// же чип (класс wzc-tier) рядом с суммой строки, а чек печатает «(второй визит)».
// Каждая проверка — на русском и на английском экране (setLang), без кириллицы в
// английском.
// Заглушка документа — та же, что у cashier-discount-ui.test.mjs.
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
const printed = [];
globalThis.Node = FakeNode;
globalThis.CustomEvent = class { constructor(type, o) { this.type = type; this.detail = o && o.detail; } };
globalThis.document = {
    createElement: mkEl, createElementNS: (_n, t) => mkEl(t), createTextNode: (t) => new FakeText(t),
    head: mkEl('head'), body: mkEl('body'), documentElement: mkEl('html'),
    addEventListener() {}, removeEventListener() {}, getElementById() { return null; },
    querySelectorAll(sel) { return sel === '.modal' ? document.body.children.filter((c) => c.className === 'modal') : []; },
};
const openWin = () => {
    const w = { _html: '', document: { open() {}, write(x) { w._html += x; }, close() { printed.push(w._html); } }, focus() {}, print() {}, close() {} };
    return w;
};
globalThis.window = {
    location: { hostname: 'localhost' }, localStorage: { getItem: () => null, setItem() {} }, open: openWin,
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
    easymed: { state: { user: { id: 9, full_name: 'Кассир', role: 'cashier' } } },
};
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
        data = typeof a === 'function' ? await a(body) : (a !== undefined ? a : []);
    } else {
        calls.push(['db:' + body.table, body]);
        const rows = (tables[body.table] || []).filter((r) => (body.filters || []).every((f) => matches(r, f)));
        data = body.single ? (rows[0] || null) : rows;
    }
    return { ok: true, status: 200, json: async () => ({ data }), headers: { getSetCookie: () => [] } };
};

const { setLang } = await import('../i18n.js');
const desk = await import('../views/cashier-desk.js');
const lineFix = await import('../views/cashier-line-fix.js');
const perms = await import('../permissions.js');

const walk = (e, out = []) => { if (!e || typeof e !== 'object') return out; out.push(e); for (const c of e.children || []) walk(c, out); return out; };
const textOf = (e) => walk(e).map((x) => x._text || '').join(' ');
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const modals = () => document.body.children.filter((c) => c.className === 'modal');
const lastModal = () => modals()[modals().length - 1];
const closeAll = () => { document.body.children = document.body.children.filter((c) => c.className !== 'modal'); };
const chips = (root) => walk(root).filter((e) => e.className === 'wzc-tier');
const struckOf = (root) => walk(root).filter((e) => e.tagName === 'S' && e.attrs['data-tier-first'] !== undefined);
const rpcCalls = (name) => calls.filter(([n]) => n === name);
const htmlText = (x) => String(x).replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const CYR = /[А-Яа-яЁё]/;

perms.setEffectiveFromRole({ name: 'cashier', permissions: { sections: ['cashier', 'patients'], levels: { cashier: 'admin', patients: 'editor' }, grants: { 'cashier.lines': 'edit' } } });

// Пример владельца: приём 200 000, второй визит 60 000 (3 дня назад был первый); УЗИ — первичное.
const INV = { id: 41, invoice_number: 'INV-A-26-00041', status: 'unpaid', subtotal: 140000, discount_amount: 0, total_amount: 140000, paid_amount: 0,
    payer_id: null, patient_id: 3, visit_id: 70, patient_name: 'Тестов Пациент', mrn: 'P-1' };
const ITEMS = [
    { id: 501, invoice_id: 41, service_id: 1, description: 'Приём терапевта', quantity: 1, unit_price: 60000, total: 60000, discount_amount: 0, services: { id: 1, name: 'Приём терапевта' } },
    { id: 502, invoice_id: 41, service_id: 2, description: 'УЗИ', quantity: 1, unit_price: 80000, total: 80000, discount_amount: 0, services: { id: 2, name: 'УЗИ' } },
];
const VS = [
    { id: 901, visit_id: 70, service_id: 1, doctor_id: { id: 21, full_name: 'Врач Каталог' }, status: 'added', quantity: 1, unit_price: 60000, total: 60000, invoice_item_id: 501, price_tier: 'secondary', package_price: null, services: { name: 'Приём терапевта' } },
    { id: 902, visit_id: 70, service_id: 2, doctor_id: null, status: 'added', quantity: 1, unit_price: 80000, total: 80000, invoice_item_id: 502, price_tier: 'primary', package_price: null, services: { name: 'УЗИ' } },
];
const TIER_LINE = { visit_service_id: 901, invoice_item_id: 501, tier: 'secondary', quantity: 1, price: 60000, first_price: 200000, days_since: 3 };

function reset() {
    calls.length = 0; printed.length = 0; closeAll(); setLang('ru');
    tables = { invoice_items: ITEMS, visit_services: VS, invoices: [INV], payments: [], services: [] };
    rpcAnswers = { cashier_line_tiers: { lines: [TIER_LINE] } };
}

for (const lang of ['ru', 'en']) {
    const L = lang === 'ru'
        ? { chip: 'Второй визит', title: 'Прошлый визит по этой услуге — 3 дн. назад. Цена первого визита: 200 000', titleNoFirst: 'Прошлый визит по этой услуге — 3 дн. назад.' }
        : { chip: 'Second visit', title: 'Last visit for this service was 3 days ago. First-visit price: 200 000', titleNoFirst: 'Last visit for this service was 3 days ago.' };

    test(`[${lang}] окно оплаты «За что платим»: у строки второго визита — чип и зачёркнутая цена первого визита; у первичной — ничего`, async () => {
        reset(); setLang(lang);
        desk.__test_payModal(document.body, INV, 140000);
        await tick();
        assert.deepEqual(rpcCalls('cashier_line_tiers').map(([, b]) => b), [{ invoice_id: 41 }], 'ярусы спрашиваются по счёту');
        const m = lastModal();
        const line = walk(m).find((e) => e.attrs && e.attrs['data-pay-line'] === '501');
        const other = walk(m).find((e) => e.attrs && e.attrs['data-pay-line'] === '502');
        assert.ok(line && other, 'строки счёта не нарисованы');
        const [chip] = chips(line);
        assert.ok(chip, 'нет чипа у строки второго визита');
        assert.equal(textOf(chip).trim(), L.chip);
        assert.equal(chip.attrs.title, L.title);
        const [s] = struckOf(line);
        assert.ok(s, 'нет зачёркнутой цены первого визита');
        assert.equal(textOf(s).trim(), '200 000');
        assert.ok(textOf(line).includes('60 000'), 'сумма строки — цена счёта');
        assert.equal(chips(other).length, 0, 'у первичной строки чипа нет');
        if (lang === 'en') assert.ok(!CYR.test(textOf(chip) + chip.attrs.title), 'кириллица на английском экране: ' + textOf(chip) + ' / ' + chip.attrs.title);
        setLang('ru');
    });

    test(`[${lang}] цена первого визита неизвестна (first_price null) — чип и подсказка без цены, ничего не зачёркнуто`, async () => {
        reset(); setLang(lang);
        rpcAnswers.cashier_line_tiers = { lines: [{ ...TIER_LINE, first_price: null }] };
        desk.__test_payModal(document.body, INV, 140000);
        await tick();
        const line = walk(lastModal()).find((e) => e.attrs && e.attrs['data-pay-line'] === '501');
        const [chip] = chips(line);
        assert.ok(chip, 'чип остаётся');
        assert.equal(chip.attrs.title, L.titleNoFirst);
        assert.equal(struckOf(line).length, 0, 'без цены первого визита зачёркивать нечего');
        setLang('ru');
    });

    test(`[${lang}] «Исправить услуги»: чип и зачёркнутая цена рядом с суммой строки`, async () => {
        reset(); setLang(lang);
        await lineFix.openLineFix(INV, {});
        await tick();
        assert.deepEqual(rpcCalls('cashier_line_tiers').map(([, b]) => b), [{ invoice_id: 41 }]);
        const m = lastModal();
        const row = walk(m).find((e) => e.attrs && e.attrs['data-line'] === '901');
        const other = walk(m).find((e) => e.attrs && e.attrs['data-line'] === '902');
        assert.ok(row && other, 'строки не нарисованы');
        const [chip] = chips(row);
        assert.ok(chip, 'нет чипа');
        assert.equal(textOf(chip).trim(), L.chip);
        assert.equal(chip.attrs.title, L.title);
        assert.equal(textOf(struckOf(row)[0]).trim(), '200 000');
        assert.equal(chips(other).length, 0);
        setLang('ru');
    });

    test(`[${lang}] «Выставить счёт» (строки без счёта): ярусы по визиту, зачёркнуто — цена первого визита × количество`, async () => {
        reset(); setLang(lang);
        tables.visit_services = [
            { ...VS[0], invoice_item_id: null, quantity: 2, total: 120000 },
            { ...VS[1], invoice_item_id: null },
        ];
        rpcAnswers.cashier_line_tiers = { lines: [{ ...TIER_LINE, invoice_item_id: null, quantity: 2 }] };
        rpcAnswers.visit_refunded_lines = { line_ids: [] };
        await lineFix.openRebill({ visit_id: 70, visit_date: '2026-11-10T07:00:00Z', patient_name: 'Тестов Пациент' }, {});
        await tick();
        assert.deepEqual(rpcCalls('cashier_line_tiers').map(([, b]) => b), [{ visit_id: 70 }], 'ярусы спрашиваются по визиту');
        const m = lastModal();
        const row = walk(m).find((e) => e.attrs && e.attrs['data-rebill-line'] === '901');
        const [chip] = chips(row);
        assert.ok(chip, 'нет чипа');
        assert.equal(textOf(chip).trim(), L.chip);
        assert.equal(textOf(struckOf(row)[0]).trim(), '400 000', '2 × 200 000');
        assert.ok(textOf(row).includes('120 000'), 'сумма строки — 2 × 60 000');
        assert.equal(chips(walk(m).find((e) => e.attrs && e.attrs['data-rebill-line'] === '902')).length, 0);
        setLang('ru');
    });

    test(`[${lang}] «Платежи»: чип у строки (сумма здесь за вычетом скидки строки — без зачёркнутой цены, цена первого визита в подсказке)`, async () => {
        reset(); setLang(lang);
        const paid = { ...INV, status: 'paid', paid_amount: 140000 };
        await desk.__test_openInvoiceRefund(paid, document.body);
        await tick();
        const m = lastModal();
        const [chip] = chips(m);
        assert.ok(chip, 'нет чипа в «Платежах»');
        assert.equal(chips(m).length, 1, 'чип только у строки второго визита');
        assert.equal(textOf(chip).trim(), L.chip);
        assert.equal(chip.attrs.title, L.title);
        assert.equal(struckOf(m).length, 0);
        setLang('ru');
    });
}

test('счёт без услуг каталога (консультации, товары) — ярусы не спрашиваются, строки как прежде', async () => {
    reset();
    tables.invoice_items = [{ id: 601, invoice_id: 41, service_id: null, description: 'Консультация', quantity: 1, unit_price: 100000, total: 100000, discount_amount: 0, services: null }];
    desk.__test_payModal(document.body, INV, 100000);
    await tick();
    assert.equal(rpcCalls('cashier_line_tiers').length, 0);
    assert.equal(chips(lastModal()).length, 0);
});

test('сервер не ответил на ярусы (старый сервер, сбой) — состав счёта виден без чипов', async () => {
    reset();
    rpcAnswers.cashier_line_tiers = () => { throw new Error('нет такого'); };
    desk.__test_payModal(document.body, INV, 140000);
    await tick();
    const m = lastModal();
    assert.ok(walk(m).find((e) => e.attrs && e.attrs['data-pay-line'] === '501'), 'строки должны остаться');
    assert.equal(chips(m).length, 0);
});

test('чек: «Приём терапевта (второй визит)»; первичная строка и строка пакета — без пометки', async () => {
    reset();
    tables.visit_services = [VS[0], { ...VS[1], price_tier: 'repeat', package_price: 50000 }];
    await desk.__test_printFiscalCheck(INV, [{ method: 'cash', amount: 140000 }]);
    assert.equal(printed.length, 1, 'чек не напечатан');
    const t = htmlText(printed[0]);
    assert.ok(t.includes('Приём терапевта (второй визит)'), 'нет пометки яруса на чеке: ' + t.slice(0, 400));
    assert.ok(!t.includes('УЗИ (повторный визит)'), 'строка пакета не получает пометку яруса');
    // Перепечатка копии чека — та же пометка.
    printed.length = 0;
    const { printInvoiceCheck } = await import('../views/receipt-print.js?v=rp1');
    const { printableSheet } = await import('../views/doc-settings.js?v=noqr1');
    tables.invoices = [{ ...INV, status: 'paid', paid_amount: 140000 }];
    tables.patients = [{ id: 3, full_name: 'Тестов Пациент', mrn: 'P-1' }];
    tables.payments = [{ id: 1, invoice_id: 41, amount: 140000, method: 'cash', paid_at: '2026-11-10T08:00:00Z' }];
    const r = await printInvoiceCheck({ supabase: (await import('../../supabase.js')).supabase, printableSheet, invoiceId: 41 });
    assert.equal(r.ok, true);
    assert.ok(htmlText(printed[printed.length - 1]).includes('Приём терапевта (второй визит)'), 'копия чека без пометки яруса');
});
