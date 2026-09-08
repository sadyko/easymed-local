// CASE_OVERVIEW_V1 — обзор госпитализации: шапка, стрелки, главное действие, блоки, выписка со счётом.
//
// Владелец: «list of the patients → pressed opens a patients dashboard and
// main action → opens the documents to fill for the doctor. but in the
// dashboard we can see status of the patient, services prescription, and
// discharge button with generating the payments».
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

// ─── «сервер» ───────────────────────────────────────────────────────────────
const OV = {
    now: '2026-09-08T12:00:00Z',
    admission: { id: 11, admission_no: 'H-7', status: 'active', department: 'Хирургия', admitted_at: '2026-09-06T09:00:00Z', admission_type: 'planned',
        ward_name: 'Хирургия', bed_code: 'X-2', attending_name: 'Юсупов А.', attending_doctor_id: 5, planned_discharge_at: null, discharged_at: null, days: 3 },
    patient: { id: 101, full_name: 'Иванов Иван Иванович', mrn: 'ID-1', date_of_birth: '1994-11-15', gender: 'male', allergies: 'пенициллин', blood_type: 'O(I) Rh+' },
    title_sheet: { complete: true, bmi: 27, sheet: { temp_c: 36.6, bp_sys: 120, bp_dia: 80, pulse_bpm: 72, height_cm: 172, weight_kg: 80 } },
    diagnosis: { referral: 'K35.8', clinical: 'Острый аппендицит', clinical_at: '2026-09-06T10:00:00Z', outcome: null },
    diet: { current: { diet_code: '1', name: 'Стол №1 (щадящий)', since: '2026-09-06T11:00:00Z' }, meals_today: { eaten: 2, refused: 1 } },
    orders: { active: 2, by_kind: { med: 2 }, today: { due: 4, given: 2, refused: 0, missed: 1, held: 0 }, list: [{ id: 1, kind: 'med', name: 'Цефтриаксон', dose: '1 г', route: 'в/м', freq_code: '2x', prn: false }] },
    services: { count: 2, billed: 0, unbilled: 2, sum_total: 950000, sum_unbilled: 950000, list: [{ id: 1, name: 'Аппендэктомия', quantity: 1, total: 900000, invoiced: false }] },
    operation: { state: 'planned', at: null, has_surgery_service: true, docs: ['preop'] },
    bill: { accommodation: { stay_units: 3, invoiced: { units: 0, total: 0 }, current: { units: 3, rate: 100000, gross: 300000, net: 300000, mode: 'daily' } }, invoices: [], total: 0, paid: 0, debt: 0 },
    docs: { progress: { done: 3, total: 9, overdue: 1, draft: 1 }, next_kind: 'rationale', overdue: 1, incomplete: ['title', 'rationale'] },
    discharge: { status: 'active', requested_at: null, planned_at: null, outcome: null, discharged_at: null },
    neighbours: { index: 1, total: 3, mine: false, prev: { id: 10, full_name: 'Алиев А.' }, next: { id: 12, full_name: 'Каримов К.' } },
};
const rpcCalls = [];
globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    let body = {}; try { body = JSON.parse(opts.body || '{}'); } catch { /* not ours */ }
    const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }), headers: { getSetCookie: () => [] } });
    const fail = (message) => ({ ok: false, status: 400, json: async () => ({ error: { message } }), headers: { getSetCookie: () => [] } });
    if (!u.startsWith('/api/rpc/')) return fail('unexpected ' + u);
    const name = u.slice('/api/rpc/'.length);
    rpcCalls.push({ name, args: body });
    if (name === 'admission_overview') return ok(OV);
    if (name === 'admission_discharge_request') return ok({ admission: { id: 11, status: 'discharging' }, bill: { invoice_number: 'INV-7', total_amount: 1250000, items: 3 } });
    return ok({});
};

async function render(onNavigate) {
    const { renderCaseOverview } = await import('../views/case-overview.js');
    const container = mkEl('div');
    BODY.appendChild(container);
    await renderCaseOverview(container, { payload: { admissionId: 11 }, onNavigate });
    await settle();
    return container;
}

test('шапка: пациент, день, койка, лечащий врач, аллергия; стрелки ведут к соседям; пациент и вкладка — в документы', async () => {
    const navs = [];
    const root = await render((view, payload) => navs.push({ view, payload }));
    const t = textOf(root);
    for (const piece of ['Иванов Иван Иванович', '3-й день', 'Хирургия', 'X-2', 'Юсупов А.', 'H-7', 'Аллергия: пенициллин', '2 из 3', 'Мужской', 'ID-1']) {
        assert.ok(t.includes(piece), 'в шапке нет: ' + piece);
    }
    const arrows = walk(root).filter((e) => e.tagName === 'BUTTON' && e.className.includes('btn-sm') && (e._parent && e._parent.className === 'co-nav'));
    assert.equal(arrows.length, 2, 'должно быть две стрелки');
    arrows[0].click();
    assert.deepEqual(navs.pop(), { view: 'case-overview', payload: { admissionId: 10 } }, '«‹» ведёт к предыдущему');
    arrows[1].click();
    assert.deepEqual(navs.pop(), { view: 'case-overview', payload: { admissionId: 12 } }, '«›» ведёт к следующему');

    walk(root).find((e) => e.className === 'co-av').click();
    assert.deepEqual(navs.pop(), { view: 'case-file', payload: { admissionId: 11 } }, 'пациент ведёт в документы');
    findBtn(root, 'Документы').click();
    assert.deepEqual(navs.pop(), { view: 'case-file', payload: { admissionId: 11 } }, 'вкладка «Документы» ведёт в документы');
});

test('главное действие открывает документы НА СЛЕДУЮЩЕМ ШАГЕ; «Лист назначений» — на лист', async () => {
    const navs = [];
    const root = await render((view, payload) => navs.push({ view, payload }));
    const main = walk(root).find((e) => e.tagName === 'BUTTON' && e.className.includes('co-main'));
    assert.ok(main, 'главного действия нет');
    assert.ok(textOf(main).includes('Обоснование клинического диагноза'), 'кнопка должна называть следующий документ');
    main.click();
    assert.deepEqual(navs.pop(), { view: 'case-file', payload: { admissionId: 11, kind: 'rationale' } });
    findBtn(root, 'Лист назначений').click();
    assert.equal(navs.pop().view, 'mar-sheet');
});

test('блоки: статус, диагноз, состояние, стол, назначения, услуги, операция, счёт, история, выписка', async () => {
    const root = await render(() => {});
    const t = textOf(root);
    // Z-схема: 1 пациент сейчас · 2 выписка и счёт · 3 плитки · 4 операция · 5 списки · 6 следующий шаг.
    for (const piece of ['Пациент сейчас', 'K35.8', 'Острый аппендицит', '36.6', '120/80', 'Стол №1', 'съедено 2', 'отказ 1',
        'Цефтриаксон', 'введено 2 из 4', 'пропущено 1', 'Аппендэктомия', '900 000', 'не выставлено',
        'Запланирована', 'Койко-дней', '300 000', 'Оформлено 3 из 9', 'просрочено 1', 'Обоснование клинического диагноза',
        'Выписать и выставить счёт', 'Заполнить документ', 'День в отделении', 'Дозы сегодня']) {
        assert.ok(t.includes(piece), 'в блоках нет: ' + piece);
    }
    // Порядок чтения — как на схеме владельца: 1 → 2 → 3 → 4 → 5 → 6.
    const order = ['Пациент сейчас', 'Выписка и счёт', 'День в отделении', 'Операция', 'Назначения и услуги', 'Следующий шаг']
        .map((s) => t.indexOf(s));
    assert.ok(order.every((i, k) => i >= 0 && (k === 0 || i > order[k - 1])), 'блоки идут не в порядке Z-схемы: ' + order.join(','));
    // Плитки — кнопки туда, где это делают; «День» — нет.
    const tiles = walk(root).filter((e) => e.className && String(e.className).split(/\s+/).includes('co-tile'));
    assert.equal(tiles.length, 4);
    assert.equal(tiles.filter((e) => e.tagName === 'BUTTON').length, 3);
});

test('«Выписка» подаёт заявку с generate_bill и говорит, какой счёт ушёл в кассу', async () => {
    rpcCalls.length = 0;
    const root = await render(() => {});
    const btn = allBtns(root, 'Выписка').find((b) => b.className.includes('btn'));
    assert.ok(btn, 'кнопки «Выписка» нет');
    btn.click();
    await settle();
    const modal = topOverlay();
    assert.ok(modal && textOf(modal).includes('Заявка на выписку'), 'окно заявки не открылось');
    assert.ok(textOf(modal).includes('Счёт будет сформирован сразу'), 'окно должно предупредить, что счёт формируется');
    findBtn(modal, 'Подать заявку').click();
    await settle(); await settle();
    const call = rpcCalls.find((c) => c.name === 'admission_discharge_request');
    assert.ok(call, 'заявка не ушла');
    assert.equal(call.args.generate_bill, true);
    assert.equal(call.args.admission_id, 11);
    assert.ok(lastToast().includes('INV-7'), 'подтверждение должно называть счёт: ' + lastToast());
    assert.ok(lastToast().includes('1 250 000'), 'и сумму');
});
