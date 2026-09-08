// PATIENT_HISTORY_TAB_V1 — вкладка «История» в карте пациента: госпитализации, подшитые истории, переходы.
//
// Владелец: «we need to add a tab called history (for which the document from
// the history will be saved)».
import test from 'node:test';
import assert from 'node:assert/strict';

// ─── минимальный DOM (тот же, что в patient-card-tabs.test.mjs) ─────────────
class FakeNode {
    constructor(tag) {
        this.tagName = String(tag).toUpperCase();
        this.style = {}; this.children = []; this.attrs = {};
        this.className = ''; this._t = ''; this._l = {}; this.dataset = {};
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
    dispatchEvent(e) { for (const fn of this._l[e.type] || []) fn(Object.assign({ currentTarget: this, target: this, preventDefault() {}, stopPropagation() {} }, e)); return true; }
    click() { this.dispatchEvent({ type: 'click' }); }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    remove() { if (this._parent) this._parent.removeChild(this); }
    focus() {} blur() {}
    get textContent() { return this._t + this.children.map((c) => c.textContent).join(''); }
    set textContent(v) { this._t = String(v); this.children.length = 0; }
    get classList() { const s = this; return { contains: (c) => String(s.className).split(/\s+/).includes(c), add() {}, remove() {}, toggle() {} }; }
    get isConnected() { return true; }
}
class FakeText extends FakeNode { constructor(t) { super('#text'); this.nodeType = 3; this._t = String(t); } }
function mk(tag) {
    const el = new FakeNode(tag);
    if (el.tagName === 'TEMPLATE') {
        el.content = { firstChild: null };
        Object.defineProperty(el, 'innerHTML', {
            set(v) { const s = new FakeNode('svg'); s._t = String(v); el.content.firstChild = s; },
            get() { return ''; },
        });
    }
    return el;
}
globalThis.Node = FakeNode;
const BODY = mk('body');
globalThis.document = {
    createElement: mk, createElementNS: (_n, t) => mk(t), createTextNode: (t) => new FakeText(t),
    head: mk('head'), body: BODY, documentElement: mk('html'),
    addEventListener() {}, removeEventListener() {},
    getElementById(id) { return BODY.children.find((c) => c.attrs && c.attrs.id === id) || null; },
};
globalThis.window = { location: { hostname: 'localhost', hash: '' }, localStorage: { getItem: () => null, setItem() {} }, addEventListener() {}, CLINIC: {}, open: () => null,
    easymed: { state: { user: { id: 1, role: 'admin' } } } };
globalThis.localStorage = { getItem: (k) => (k === 'admin.lang' ? 'ru' : null), setItem() {}, removeItem() {}, clear() {} };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join(' ');
const buttons = (root) => walk(root).filter((n) => n.tagName === 'BUTTON');
const findBtn = (root, label) => buttons(root).find((b) => textOf(b).includes(label));
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

const PATIENT = { id: 1, mrn: 'MRN-1', full_name: 'Эргашев Жахонгир', gender: 'male', date_of_birth: '1990-04-01', phone: '+998', active: 1 };
const HISTORY = {
    admissions: [
        { id: 11, admission_no: 'ADM-00011', status: 'active', admitted_at: '2026-09-06T09:00:00Z', discharged_at: null, department: 'Терапия', discharge_outcome: null, ward_name: 'Терапия', bed_code: 'T-1', attending_name: 'Юсупов А.' },
        { id: 7, admission_no: 'ADM-00007', status: 'discharged', admitted_at: '2026-06-01T06:50:00Z', discharged_at: '2026-06-04T18:10:00Z', department: 'Хирургия', discharge_outcome: 'home', ward_name: 'Хирургия', bed_code: null, attending_name: 'Каримов Р.' },
    ],
    case_files: [
        { id: 61, title: 'История болезни № ADM-00007', created_at: '2026-06-04T17:00:00Z', created_by_name: 'Каримов Р.', admission_id: 7, admission_no: 'ADM-00007', complete: true, gaps: 0,
          body: { cover: { id: 7, admission_no: 'ADM-00007', patient_name: 'Эргашев Жахонгир' }, documents: [], gaps: [], complete: true } },
    ],
};
let payload = null;
globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }), headers: { getSetCookie: () => [] } });
    if (u.startsWith('/api/rpc/patient_card')) return ok(payload);
    return ok({});
};
const { renderPatientCard } = await import('../views/patient-card.js');
const { setFullAccess } = await import('../permissions.js');

function fullPayload(history) {
    return {
        tabs: { services: 'delete', labs: 'view', docs: 'delete', history: 'view', billing: 'view', visits: 'edit', details: 'edit' },
        caps: { services: { edit: true, del: true }, labs: { edit: false, del: false }, docs: { edit: true, del: true }, history: { edit: false, del: false },
                billing: { edit: false, del: false }, visits: { edit: true, del: false }, details: { edit: true, del: false } },
        patient: { ...PATIENT }, patient_limited: false, payer_name: null,
        visits: [], visit_count: 0, last_visit_date: null, services: [], lab_orders: [], lab_results: [],
        invoices: [], invoice_items: [], payments: [], docs: [], doc_notes: [],
        history,
    };
}
async function render(history, onNavigate = () => {}) {
    payload = fullPayload(history);
    setFullAccess('Администратор');
    const box = mk('div');
    renderPatientCard(box, { onNavigate, payload: { id: 1 } });
    await tick();
    const tab = buttons(box).find((b) => walk(b).some((n) => (n._t || '').trim() === 'История'));
    assert.ok(tab, 'вкладки «История» нет');
    tab.click();
    await tick();
    return box;
}

test('«История»: госпитализации с датами, койкой и врачом; подшитая история — под своей госпитализацией', async () => {
    const box = await render(HISTORY);
    const t = textOf(box);
    for (const piece of ['ADM-00011', 'ADM-00007', 'Терапия', 'T-1', 'Юсупов А.', 'Хирургия', 'Каримов Р.',
        'История болезни № ADM-00007', 'комплект полный', 'госпитализаций: 2']) {
        assert.ok(t.includes(piece), 'нет: ' + piece);
    }
    assert.ok(t.includes('ещё не подшита'), 'у госпитализации без подшитой истории сказано об этом');
    assert.ok(findBtn(box, 'Открыть'), 'подшитую историю можно открыть');
});

test('«История»: «Обзор» и «Документы» ведут в экраны госпитализации', async () => {
    const navs = [];
    const box = await render(HISTORY, (view, p) => navs.push({ view, p }));
    // Кнопки строки, а не вкладка «Документы» карты: ищем внутри действий госпитализации.
    const acts = walk(box).find((n) => n.className === 'ph-adm-acts');
    assert.ok(acts, 'у госпитализации нет действий');
    findBtn(acts, 'Обзор').click();
    assert.deepEqual(navs.pop(), { view: 'case-overview', p: { admissionId: 11 } });
    findBtn(acts, 'Документы').click();
    assert.deepEqual(navs.pop(), { view: 'case-file', p: { admissionId: 11 } });
});

test('«История» без госпитализаций — словами, не пустой карточкой', async () => {
    const box = await render({ admissions: [], case_files: [] });
    assert.ok(textOf(box).includes('Госпитализаций не было'));
});
