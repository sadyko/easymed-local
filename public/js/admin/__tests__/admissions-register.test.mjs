// ADMISSIONS_REGISTER_V1 — журнал госпитализаций: колонки образца, фильтры, красный долг, переход в обзор.
import test from 'node:test';
import assert from 'node:assert/strict';

// ─── минимальный DOM ────────────────────────────────────────────────────────
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
    dispatchEvent(e) { for (const fn of this._l[e.type] || []) fn(Object.assign({ currentTarget: this, target: this, preventDefault() {}, stopPropagation() {} }, e)); return true; }
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
const navs = [];
globalThis.window = { location: { hostname: 'localhost' }, localStorage: { getItem: () => null, setItem() {} }, addEventListener() {},
    easymed: { navigate: (view, payload) => navs.push({ view, payload }), state: { user: { id: 1, role: 'admin' } } } };
globalThis.localStorage = { getItem: (k) => (k === 'admin.lang' ? 'ru' : null), setItem() {}, removeItem() {}, clear() {} };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();

const walk = (e, out = []) => { if (!e || typeof e !== 'object') return out; out.push(e); for (const c of e.children || []) walk(c, out); return out; };
const textOf = (e) => walk(e).map((x) => x._text || '').join(' ');
const settle = () => new Promise((r) => setTimeout(r, 30));

const ROWS = [
    { id: 51, admission_no: '2026/00051', status: 'active', admitted_at: '2026-06-06T22:10:00Z', discharged_at: null, department: 'Реанимация',
        patient_id: 31002, mrn: '31002', full_name: 'Каримов Темур Алишерович', date_of_birth: '1971-07-03', ward_name: 'Реанимация', bed_code: '01-01/1',
        attending_name: 'Каримов Рустам Шухратович', payer_name: null, act_total: 22795500, invoiced_total: 16452000, paid_total: 0, balance: -16452000 },
    { id: 46, admission_no: '2026/00046', status: 'discharged', admitted_at: '2026-06-01T06:50:00Z', discharged_at: '2026-06-04T18:10:00Z', department: 'Реанимация',
        patient_id: 27431, mrn: '27431', full_name: 'Юлдашев Сардор Комилович', date_of_birth: '1985-03-30', ward_name: 'Реанимация', bed_code: null,
        attending_name: 'Каримов Рустам Шухратович', payer_name: 'Страховая А', act_total: 20798500, invoiced_total: 20798500, paid_total: 20798500, balance: 0 },
];
let registerAnswer = () => ({ ok: true, data: { rows: ROWS, total: ROWS.length } });
globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }), headers: { getSetCookie: () => [] } });
    const fail = (message) => ({ ok: false, status: 400, json: async () => ({ error: { message } }), headers: { getSetCookie: () => [] } });
    if (u.startsWith('/api/rpc/admissions_register')) { const a = registerAnswer(); return a.ok ? ok(a.data) : fail(a.message); }
    return ok({});
};

async function renderRegister() {
    const { admissionsHistoryCard } = await import('../views/ward-beds.js?v=board4');
    const card = await admissionsHistoryCard();
    await settle();
    return card;
}
const rowsOf = (card) => walk(card).filter((e) => e.tagName === 'TR' && String(e.className).split(/\s+/).includes('ar-row'));

test('журнал: колонки образца, аватар с номером и именем, возраст, чипы статуса, деньги, красный долг', async () => {
    const card = await renderRegister();
    const t = textOf(card);
    for (const col of ['Пациент', 'Дата рожд.', '№ истории', 'Статус', 'Госпит.', 'Выписка', 'Отделение', 'Койка', 'Врач', 'Покрытие', 'Сумма акта', 'Выставлено', 'Баланс']) {
        assert.ok(t.includes(col), 'нет колонки ' + col);
    }
    assert.ok(!t.includes('Филиал'), 'колонки «Филиал» быть не должно — у госпитализаций нет филиала');
    for (const piece of ['31002', 'Каримов Темур Алишерович', '03.07.1971', '2026/00051', 'Реанимация / 01-01/1', 'Каримов Рустам Шухратович',
        '22 795 500', '16 452 000', '-16 452 000', 'Страховая А', 'Пациент', 'Показано 2 из 2']) {
        assert.ok(t.includes(piece), 'в журнале нет: ' + piece);
    }
    const rows = rowsOf(card);
    assert.equal(rows.length, 2);
    const neg = walk(rows[0]).find((e) => String(e.className).includes('ar-neg'));
    assert.ok(neg && textOf(neg).includes('-16 452 000'), 'долг должен быть выделен');
    assert.ok(!walk(rows[1]).some((e) => String(e.className).includes('ar-neg')), 'нулевой баланс не красный');
    const av = walk(rows[0]).find((e) => String(e.className).includes('ar-av'));
    assert.ok(av && textOf(av).trim().length >= 1, 'аватара с инициалами нет');
    assert.equal(walk(card).filter((e) => e.tagName === 'INPUT' && e.className === 'ar-filter').length, 13, 'фильтр под каждой колонкой');
});

test('фильтр под колонкой сужает список по тексту ячейки; пусто — «ничего не найдено»', async () => {
    const card = await renderRegister();
    const inputs = walk(card).filter((e) => e.tagName === 'INPUT' && e.className === 'ar-filter');
    const { admissionStatusLabel } = await import('../../shared/admission-status.js');
    const status = inputs[3];
    status.value = admissionStatusLabel('discharged').toLowerCase();   // подпись закрытой госпитализации — какая есть в системе
    status.dispatchEvent({ type: 'input' });
    let rows = rowsOf(card);
    assert.equal(rows.length, 1);
    assert.ok(textOf(rows[0]).includes('Юлдашев'));
    assert.ok(textOf(card).includes('Показано 1 из 2'));
    inputs[0].value = 'Каримов';
    inputs[0].dispatchEvent({ type: 'input' });
    assert.equal(rowsOf(card).length, 0, 'два фильтра складываются');
    assert.ok(textOf(card).includes('По фильтру ничего не найдено'));
});

test('строка ведёт в обзор госпитализации — мышью и клавиатурой', async () => {
    navs.length = 0;
    const card = await renderRegister();
    const rows = rowsOf(card);
    rows[0].click();
    assert.deepEqual(navs.pop(), { view: 'case-overview', payload: { admissionId: 51 } });
    rows[1].dispatchEvent({ type: 'keydown', key: 'Enter' });
    assert.deepEqual(navs.pop(), { view: 'case-overview', payload: { admissionId: 46 } });
    assert.equal(rows[0].attrs.tabindex, '0', 'строка должна быть доступна с клавиатуры');
});

test('отказ сервера — словами, а не пустой таблицей', async () => {
    registerAnswer = () => ({ ok: false, message: 'Журнал госпитализаций — недоступно вашей роли.' });
    try {
        const card = await renderRegister();
        assert.ok(textOf(card).includes('недоступно вашей роли'));
    } finally { registerAnswer = () => ({ ok: true, data: { rows: ROWS, total: ROWS.length } }); }
});
