// DEPOSIT_ACCEPT_MODAL_V1 — окно приёма депозита в кассе.
//
// Способ оплаты выбирает КАССА, и выбор этот стоит денег: 'cash' пишет строку в
// ящик смены, 'card' и 'acquiring' — нет. Пока «Принять» был одной кнопкой,
// сервер молча подставлял наличные, и депозит, внесённый картой, завышал
// ожидаемый остаток в ящике до самого закрытия смены.
//
// Поэтому проверяется не «нарисовалось ли окно», а ЧТО УХОДИТ НА СЕРВЕР: три
// способа, ни одного лишнего, и на сервер попадает именно нажатый.
//
// Вид без DOM не поднимается, поэтому здесь минимальная заглушка документа —
// достаточная, чтобы h() и modal() отработали по-настоящему.

import { test } from 'node:test';
import assert from 'node:assert';

class FakeNode {
    constructor(tag) {
        this.tagName = String(tag).toUpperCase();
        this.style = {}; this.children = []; this.attrs = {};
        this.className = ''; this._text = ''; this._l = {}; this.dataset = {};
    }
    appendChild(c) { this.children.push(c); return c; }
    removeChild(c) { const i = this.children.indexOf(c); if (i > -1) this.children.splice(i, 1); return c; }
    get firstChild() { return this.children.length ? this.children[0] : null; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); }
    addEventListener(t, fn) { (this._l[t] || (this._l[t] = [])).push(fn); }
    removeEventListener() {}
    click() { for (const fn of this._l.click || []) fn({ currentTarget: this, preventDefault() {}, stopPropagation() {} }); }
    querySelector() { return null; }
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
    if (el.tagName === 'TEMPLATE') {   // ui.js Icon() строит svg через <template>
        el.content = { firstChild: null };
        Object.defineProperty(el, 'innerHTML', {
            set(v) { const s = new FakeNode('svg'); s._text = String(v); el.content.firstChild = s; },
            get() { return ''; },
        });
    }
    return el;
}

const calls = [];
globalThis.Node = FakeNode;
globalThis.document = {
    createElement: mkEl, createElementNS: (_n, t) => mkEl(t), createTextNode: (t) => new FakeText(t),
    head: mkEl('head'), body: mkEl('body'), documentElement: mkEl('html'),
    addEventListener() {}, removeEventListener() {}, getElementById() { return null; },
};
globalThis.window = { location: { hostname: 'localhost' }, localStorage: { getItem: () => null, setItem() {} } };
// I18N_LOCALE_PIN_V1 — pins the admin UI language to 'ru' regardless of the
// host OS locale. i18n.js's detect() checks localStorage.getItem('admin.lang')
// (the bare global, NOT window.localStorage above) before ever falling back
// to navigator.language/languages — so without this, the view below renders
// in whatever language the machine running the test defaults to: Russian on
// this dev box, English on GitHub's ubuntu-latest runner, breaking every
// assertion on a Russian string below there, identically, every run. Must be
// set before the view import: i18n.js picks the language once, at its own
// module-load time.
globalThis.localStorage = { getItem: (k) => (k === 'admin.lang' ? 'ru' : null), setItem() {}, removeItem() {}, clear() {} };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
// Приём денег обязан спрашивать способ в ОКНЕ. Если кто-то вернёт confirm(),
// тест упадёт здесь, а не в кассе на закрытии смены.
globalThis.confirm = () => { throw new Error('confirm() вернулся — приём депозита должен идти через окно'); };
globalThis.fetch = async (url, opts = {}) => {
    let body = {};
    try { body = JSON.parse(opts.body || '{}'); } catch { /* не json — не наш вызов */ }
    calls.push([String(url).split('/api/rpc/')[1] || String(url), body]);
    return { ok: true, json: async () => ({ data: { rows: [] } }), headers: { getSetCookie: () => [] } };
};

const desk = await import('../views/cashier-desk.js');

const DEP = {
    id: 42, deposit_number: 'DEP-26-00002', patient_name: '33 пр', patient_mrn: 'P-26-70035',
    amount: 4500000, method: null, status: 'pending', created_by_name: 'Administrator',
    created_at: '2026-08-18T12:21:00Z', notes: '',
};
const walk = (e, out = []) => { if (!e || typeof e !== 'object') return out; out.push(e); for (const c of e.children || []) walk(c, out); return out; };
const textOf = (e) => walk(e).map((x) => x._text || '').join(' ');

function openModal() {
    calls.length = 0;
    desk.__test_openAcceptDepositModal(DEP, mkEl('div'));
    const overlay = document.body.children[document.body.children.length - 1];
    const buttons = walk(overlay).filter((e) => e.tagName === 'BUTTON');
    return {
        overlay, buttons, text: textOf(overlay),
        methodBtns: buttons.filter((b) => ['Наличные', 'Карта', 'Эквайринг'].includes(textOf(b).trim())),
        submit: buttons.find((b) => textOf(b).trim() === 'Принять оплату'),
    };
}

test('окно показывает, за что и сколько принимаем', () => {
    const m = openModal();
    assert.match(m.text, /DEP-26-00002/);
    assert.match(m.text, /33 пр/);
    assert.match(m.text, /4 500 000/);
});

test('способов ровно три, «Перевод» отсутствует', () => {
    const m = openModal();
    assert.deepStrictEqual(m.methodBtns.map((b) => textOf(b).trim()), ['Наличные', 'Карта', 'Эквайринг']);
    assert.doesNotMatch(m.text, /Перевод/);
});

// Кассир должен знать это ДО подтверждения: наличные меняют ящик, безнал нет.
test('окно предупреждает про ящик смены', () => {
    assert.match(openModal().text, /ящик смены/);
});

test('на сервер уходит именно нажатый способ', async () => {
    for (const [label, value] of [['Наличные', 'cash'], ['Карта', 'card'], ['Эквайринг', 'acquiring']]) {
        const m = openModal();
        m.methodBtns.find((b) => textOf(b).trim() === label).click();
        m.submit.click();
        await new Promise((r) => setTimeout(r, 20));
        const accept = calls.find((c) => c[0] === 'accept_deposit');
        assert.ok(accept, 'accept_deposit не вызван для ' + label);
        assert.deepStrictEqual(accept[1], { deposit_id: 42, method: value }, label);
    }
});

// Ничего не нажали — уходит предвыбранное значение, а не undefined: сервер в
// этом случае откажет, и депозит остался бы висеть без объяснения.
test('без нажатия уходит предвыбранный способ, а не пустота', async () => {
    const m = openModal();
    m.submit.click();
    await new Promise((r) => setTimeout(r, 20));
    const accept = calls.find((c) => c[0] === 'accept_deposit');
    assert.ok(accept && accept[1].method, 'способ обязан быть заполнен');
    assert.ok(desk.__test_DEP_METHODS.some(([v]) => v === accept[1].method));
});
