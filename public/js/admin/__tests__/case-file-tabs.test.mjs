// ACT_ADD_SERVICE_V1 — кнопки «+ Анализы и диагностика» и «+ Операция» во
// вкладках истории болезни.
//
// Владелец: «add + add prescription + add analyses and diagnostics + add
// surgery (get service type surgery from the services list)».
//
// Проверяется то, из-за чего кнопка была бы бесполезной:
//
//   1. кнопка есть и зовёт того, кто открывает справочник услуг;
//   2. НАЗНАЧЕННОЕ ВИДНО СРАЗУ — до всякого результата: иначе врач не находит
//      только что назначенный анализ и назначает его второй раз;
//   3. вкладки разбирают назначенное ПО РАЗДЕЛУ справочника: операция не
//      показывается среди анализов, анализ — среди операций.
import test from 'node:test';
import assert from 'node:assert/strict';

// ─── минимальный DOM (тот же, что в title-sheet.test.mjs) ───────────────────
class FakeNode {
    constructor(tag) {
        this.tagName = String(tag).toUpperCase();
        this.style = {}; this.children = []; this.attrs = {};
        this.className = ''; this._text = ''; this._l = {}; this.dataset = {};
        this.value = '';
    }
    appendChild(c) { this.children.push(c); if (c && typeof c === 'object') c._parent = this; return c; }
    removeChild(c) { const i = this.children.indexOf(c); if (i > -1) this.children.splice(i, 1); return c; }
    get firstChild() { return this.children.length ? this.children[0] : null; }
    replaceChildren() { this.children.length = 0; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); }
    addEventListener(t, fn) { (this._l[t] || (this._l[t] = [])).push(fn); }
    removeEventListener() {}
    dispatchEvent(e) { for (const fn of this._l[e.type] || []) fn(Object.assign({ currentTarget: this, preventDefault() {}, stopPropagation() {} }, e)); return true; }
    click() { this.dispatchEvent({ type: 'click' }); }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    remove() { if (this._parent) this._parent.removeChild(this); }
    focus() {} blur() {}
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
    set textContent(v) { this._text = String(v); this.children.length = 0; }
    get classList() { const s = this; return { contains: (c) => String(s.className).split(/\s+/).includes(c), add() {}, remove() {}, toggle() {} }; }
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
globalThis.Node = FakeNode;
const BODY = mkEl('body');
globalThis.document = {
    createElement: mkEl, createElementNS: (_n, t) => mkEl(t), createTextNode: (t) => new FakeText(t),
    head: mkEl('head'), body: BODY, documentElement: mkEl('html'),
    addEventListener() {}, removeEventListener() {},
    getElementById(id) { return BODY.children.find((c) => c.attrs && c.attrs.id === id) || null; },
};
globalThis.window = { location: { hostname: 'localhost' }, localStorage: { getItem: () => null, setItem() {} }, addEventListener() {}, CLINIC: {}, open: () => null };
globalThis.localStorage = { getItem: (k) => (k === 'admin.lang' ? 'ru' : null), setItem() {}, removeItem() {}, clear() {} };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();

const walk = (e, out = []) => { if (!e || typeof e !== 'object') return out; out.push(e); for (const c of e.children || []) walk(c, out); return out; };
const textOf = (e) => walk(e).map((x) => x._text || '').join(' ');
const findBtn = (root, label) => walk(root).find((e) => e.tagName === 'BUTTON' && textOf(e).includes(label));
const allBtns = (root, label) => walk(root).filter((e) => e.tagName === 'BUTTON' && textOf(e).includes(label));
const topOverlay = () => BODY.children.filter((c) => c.className === 'modal').pop() || null;
const lastToast = () => { const t = BODY.children.filter((c) => c.attrs && c.attrs.id === 'toast').pop(); return t ? t.textContent : ''; };
const settle = () => new Promise((r) => setTimeout(r, 30));

globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    let body = {}; try { body = JSON.parse(opts.body || '{}'); } catch { /* не наш запрос */ }
    const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }), headers: { getSetCookie: () => [] } });
    if (u.startsWith('/api/db')) return ok([]);
    if (!u.startsWith('/api/rpc/')) return { ok: false, status: 400, json: async () => ({ error: { message: 'unexpected ' + u } }), headers: { getSetCookie: () => [] } };
    const name = u.slice('/api/rpc/'.length);
    if (name === 'admission_doc_sources') return ok(SOURCES);
    if (name === 'admission_charges') return ok(CHARGES_FULL);
    rpc.push({ name, args: body });
    return ok({ invoice_number: 'INV-77' });
};

const rpc = [];
let SOURCES = { lab: [], imaging: [], functional: [] };
const { caseExamsPanel, caseSurgeryPanel, caseActPanel,
    caseInvoicesPanel } = await import('../views/case-file-tabs.js');

/** Акт, каким его присылает сервер: у строки есть раздел справочника. */
const CHARGES = {
    lines: [
        { id: 1, kind: 'service', name: 'Общий анализ крови', service_type: 'Лаборатория',
          quantity: 1, unit_price: 40000, total: 40000, billable: true, doctor_name: 'Др. Азиза',
          at: '2026-09-10T09:00:00Z', invoice_number: '' },
        { id: 2, kind: 'service', name: 'Аппендэктомия', service_type: 'Хирургия',
          quantity: 1, unit_price: 3000000, total: 3000000, billable: true, doctor_name: 'Др. Азиза',
          at: '2026-09-10T10:00:00Z', invoice_number: 'INV-9' },
        { id: 3, kind: 'item', name: 'Система для инфузий', service_type: '',
          quantity: 3, unit_price: 7000, total: 21000, billable: true, doctor_name: '', at: null, invoice_number: '' },
    ],
    totals: {},
};

test('во вкладке «Обследования» есть кнопка, и она зовёт справочник услуг', async () => {
    let called = 0;
    const box = caseExamsPanel(11, { onAdd: () => { called += 1; }, charges: CHARGES });
    const btn = findBtn(box, 'Анализы и диагностика');
    assert.ok(btn, 'кнопки «Анализы и диагностика» нет — назначить нечем');
    btn.click();
    assert.equal(called, 1, 'кнопка не позвала окно выбора услуги');
    await settle();
});

test('назначенный анализ виден СРАЗУ, до результата, и сказано, что лаборатория его не видит', async () => {
    SOURCES = { lab: [], imaging: [], functional: [] };
    const box = caseExamsPanel(11, { onAdd: () => {}, charges: CHARGES });
    await settle();
    const t = textOf(box);
    assert.ok(t.includes('Общий анализ крови'), 'назначенный анализ не показан — врач назначит его второй раз');
    assert.ok(t.includes('Назначена'), 'у назначенного нет состояния');
    assert.ok(t.includes('40 000'), 'в реестре нет денег назначенного');
    // Честность важнее краткости: пробирку по этой записи никто не возьмёт.
    assert.ok(t.includes('рабочий список лаборатории'), 'экран умалчивает, что лаборатория этого не увидит');
    // Операция — не анализ: чужой раздел во вкладке не показывается.
    assert.ok(!t.includes('Аппендэктомия'), 'операция попала во вкладку анализов');
    assert.ok(!t.includes('Система для инфузий'), 'расходник — не обследование');
});

test('пришедший результат — строка «Результат готов», и она ОТКРЫВАЕТ ДОКУМЕНТ', async () => {
    SOURCES = { lab: [{ name: 'Биохимия крови', at: '2026-09-10T09:10:00Z', doctor_name: 'Лаборатория',
        results: [{ parameter: 'Глюкоза', value: '6.4', unit: 'ммоль/л', reference_range: '3.9–6.1', flag: 'high' }] }],
        imaging: [], functional: [] };
    // Печать открывает окно и пишет в него документ: ловим написанное.
    const written = [];
    const openWas = globalThis.window.open;
    globalThis.window.open = () => ({
        document: { open() {}, write(html) { written.push(String(html)); }, close() {} },
        focus() {}, print() {},
    });
    try {
        const box = caseExamsPanel(11, { onAdd: () => {}, charges: CHARGES,
            patient: { full_name: 'Иванов Иван', mrn: 'ID-1', date_of_birth: '1994-11-15', gender: 'male' } });
        await settle();
        assert.ok(textOf(box).includes('Результат готов'), 'результат не показан состоянием');
        // Значения не разворачиваются строкой под строкой: их место в документе.
        assert.ok(!textOf(box).includes('Глюкоза'), 'значения высыпались в реестр');

        const btn = findBtn(box, 'Просмотреть');
        assert.ok(btn, 'результат нечем открыть');
        btn.click();
        await settle();
        assert.equal(written.length, 1, 'документ не открылся');
        assert.ok(written[0].includes('Глюкоза'), 'в документе нет самого результата');
        assert.ok(written[0].includes('Иванов Иван'), 'документ без имени пациента подшить некуда');
    } finally {
        globalThis.window.open = openWas;
        SOURCES = { lab: [], imaging: [], functional: [] };
    }
});

test('во вкладке «Операция» видна назначенная операция и её кнопка', async () => {
    let called = 0;
    const box = caseSurgeryPanel({ operation: { state: 'planned' } }, { items: [] },
        { onAdd: () => { called += 1; }, charges: CHARGES });
    const btn = findBtn(box, 'Операция');
    assert.ok(btn, 'кнопки «Операция» нет');
    btn.click();
    assert.equal(called, 1, 'кнопка не позвала окно выбора услуги');
    const t = textOf(box);
    assert.ok(t.includes('Аппендэктомия'), 'назначенная операция не показана');
    assert.ok(!t.includes('Общий анализ крови'), 'анализ попал во вкладку операции');
});

/** Акт целиком: услуга, расходник и койко-день — как их присылает сервер. */
const CHARGES_FULL = {
    admission_no: 'H-7',
    lines: [
        { id: 1, kind: 'service', name: 'Аппендэктомия', service_type: 'Хирургия', product_category: '',
          unit: '', quantity: 1, unit_price: 3000000, total: 3000000, billable: true, locked: false,
          doctor_name: 'Др. Азиза', at: '2026-09-10T10:00:00Z', invoice_id: null, invoice_number: '', paid: false },
        { id: 2, kind: 'item', name: 'Система для инфузий', service_type: '', product_category: 'consumable',
          unit: 'шт.', quantity: 3, unit_price: 7000, total: 21000, billable: true, locked: false,
          doctor_name: '', at: '2026-09-10T08:00:00Z', invoice_id: null, invoice_number: '', paid: false },
        { id: 3, kind: 'stay', name: 'Проживание · Палата 1', service_type: '', product_category: '',
          unit: '', quantity: 2, unit_price: 200000, total: 400000, billable: true, locked: true,
          doctor_name: '', at: '2026-09-09T00:00:00Z', invoice_id: 5, invoice_number: 'СЧ-04054', paid: true },
        { id: 4, kind: 'item', name: 'Перчатки', service_type: '', product_category: 'drug',
          unit: 'пара', quantity: 8, unit_price: 6500, total: 52000, billable: false, locked: false,
          doctor_name: '', at: '2026-09-10T09:00:00Z', invoice_id: null, invoice_number: '', paid: false },
    ],
    totals: { accrued: 3473000, billable: 3421000, invoiced: 400000, pending: 3021000, not_billable: 52000, lines: 4 },
};

test('акт — реестр: вид и тип расхода, единица, дата и номер счёта', async () => {
    const box = caseActPanel(11, { onInvoice: () => {}, onAddExpense: () => {}, onPrint: () => {} });
    await settle();
    const t = textOf(box);
    // Тип расхода строка не придумывает: у товара он свой, у услуги — раздел справочника.
    assert.ok(t.includes('Мед. изделия'), 'расходник не назвал свой тип: ' + t.slice(0, 300));
    assert.ok(t.includes('Медикаменты'), 'медикамент не назван медикаментом');
    assert.ok(t.includes('Хирургия'), 'у услуги не показан раздел справочника');
    assert.ok(t.includes('Койко-день'), 'проживание не названо койко-днём');
    assert.ok(t.includes('шт.'), 'единица расходника потерялась');
    assert.ok(t.includes('СЧ-04054'), 'номер счёта не показан');
    assert.ok(t.includes('не выставлен'), 'невыставленная строка не помечена');
    assert.ok(t.includes('3 000 000'), 'сумма не разбита разрядами');
});

test('счёт выставляется РОВНО на отмеченные строки', async () => {
    let got = null;
    const box = caseActPanel(11, { onInvoice: (_reload, ids) => { got = ids; } });
    await settle();
    const boxes = walk(box).filter((e) => e.tagName === 'INPUT' && e.attrs.type === 'checkbox');
    // Галочек ровно две: у строки в счёте и у строки «за счёт клиники» их нет,
    // плюс одна общая в шапке таблицы.
    assert.equal(boxes.length, 3, 'галочки стоят не у тех строк: ' + boxes.length);
    boxes[1].dispatchEvent({ type: 'change', target: { checked: true } });
    await settle();
    const btn = findBtn(box, 'Выставить счёт');
    assert.ok(textOf(btn).includes('1'), 'кнопка не показала, сколько отмечено: ' + textOf(btn));
    btn.click();
    assert.deepEqual(got, [1], 'в счёт ушла не отмеченная строка');
});

test('без отметок счёт выставляется на всё невыставленное', async () => {
    let got = 'не звали';
    const box = caseActPanel(11, { onInvoice: (_reload, ids) => { got = ids; } });
    await settle();
    findBtn(box, 'Выставить счёт').click();
    assert.equal(got, null, 'экран сам решил, какие строки выставлять, вместо «всё невыставленное»');
});

test('счета: номер, суммы и долг — теми же цифрами, что у кассы', () => {
    const box = caseInvoicesPanel({ bill: {
        invoices: [
            { id: 1, invoice_number: 'СЧ-04054', total_amount: 3000000, paid_amount: 3000000, status: 'paid', created_at: '2026-09-09T10:00:00Z' },
            { id: 2, invoice_number: 'СЧ-04061', total_amount: 421000, paid_amount: 0, status: 'debt', created_at: '2026-09-10T10:00:00Z' },
        ],
        total: 3421000, paid: 3000000, debt: 421000,
    } });
    const t = textOf(box);
    assert.ok(t.includes('СЧ-04054') && t.includes('СЧ-04061'), 'счета не перечислены');
    assert.ok(t.includes('Оплачен'), 'состояние счёта не названо');
    assert.ok(t.includes('Долг'), 'долг не показан, а это главный вопрос к вкладке');
    assert.ok(t.includes('421 000'), 'сумма долга не показана');
});

test('счетов нет — сказано, где их выставляют, а не пустая карточка', () => {
    const box = caseInvoicesPanel({ bill: { invoices: [], total: 0, paid: 0, debt: 0 } });
    assert.ok(textOf(box).includes('акте выполненных работ'), 'пустая вкладка не подсказывает, что делать');
});
