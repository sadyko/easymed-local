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
    if (!u.startsWith('/api/rpc/')) return { ok: false, status: 400, json: async () => ({ error: { message: 'unexpected ' + u } }), headers: { getSetCookie: () => [] } };
    const name = u.slice('/api/rpc/'.length);
    if (name === 'admission_doc_sources') return ok({ lab: [], imaging: [], functional: [] });
    return ok({});
};

const { caseExamsPanel, caseSurgeryPanel, caseOrdersPanel } = await import('../views/case-file-tabs.js');

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
    const box = caseExamsPanel(11, { onAdd: () => {}, charges: CHARGES });
    const t = textOf(box);
    assert.ok(t.includes('Назначено'), 'нет раздела «Назначено»');
    assert.ok(t.includes('Общий анализ крови'), 'назначенный анализ не показан — врач назначит его второй раз');
    // Честность важнее краткости: пробирку по этой записи никто не возьмёт.
    assert.ok(t.includes('рабочий список лаборатории'), 'экран умалчивает, что лаборатория этого не увидит');
    // Операция — не анализ: чужой раздел во вкладке не показывается.
    assert.ok(!t.includes('Аппендэктомия'), 'операция попала во вкладку анализов');
    assert.ok(!t.includes('Система для инфузий'), 'расходник — не обследование');
    await settle();
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

test('во вкладке «Назначения» кнопка открывает ту же форму, что и лист назначений', () => {
    let called = 0;
    const box = caseOrdersPanel({ orders: [] }, { onOpenSheet: () => {}, onAdd: () => { called += 1; } });
    const btn = findBtn(box, 'Назначение');
    assert.ok(btn, 'кнопки «Назначение» нет');
    btn.click();
    assert.equal(called, 1, 'кнопка не открыла форму назначения');
});
