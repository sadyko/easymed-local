// GLYPH_ICON_V1 (2026-09-11) — крестик закрытия рождается значком системы.
//
// Владелец: «apply icons of the systems». Буква «×» стояла в шестидесяти
// кнопках; менять их по одной значило бы шестьдесят поводов сделать чуть иначе.
// h() — единственное место, где рождается каждая кнопка, поэтому правило одно:
// кнопка с текстом «×» или «✕» получает значок X и имя для читалки.
import { test } from 'node:test';
import assert from 'node:assert/strict';

class El {
    constructor(tag) { this.tagName = String(tag).toUpperCase(); this.children = []; this.attrs = {}; this.className = ''; this._t = ''; this.style = {}; this.dataset = {}; this._l = {}; }
    appendChild(c) { this.children.push(c); return c; }
    removeChild(c) { const i = this.children.indexOf(c); if (i > -1) this.children.splice(i, 1); return c; }
    get firstChild() { return this.children[0] || null; }
    setAttribute(k, v) { this.attrs[k] = String(v); } getAttribute(k) { return this.attrs[k] ?? null; } hasAttribute(k) { return k in this.attrs; }
    addEventListener(t, fn) { (this._l[t] || (this._l[t] = [])).push(fn); }
    get textContent() { return this._t + this.children.map((c) => c.textContent).join(''); }
    set textContent(v) { this._t = String(v); this.children.length = 0; }
    get classList() { const s = this; return { contains: (c) => String(s.className).split(/\s+/).includes(c), add(c) { s.className = (s.className + ' ' + c).trim(); }, remove() {}, toggle() {} }; }
}
class Tx extends El { constructor(t) { super('#text'); this.nodeType = 3; this._t = String(t); } }
function mk(t) {
    const el = new El(t);
    if (el.tagName === 'TEMPLATE') {
        el.content = { firstChild: null };
        Object.defineProperty(el, 'innerHTML', { set(v) { const s = new El('svg'); s._t = String(v); el.content.firstChild = s; }, get() { return ''; } });
    }
    return el;
}
globalThis.Node = El;
globalThis.document = { createElement: mk, createElementNS: (_n, t) => mk(t), createTextNode: (t) => new Tx(t), head: mk('head'), body: mk('body'), documentElement: mk('html'), addEventListener() {}, removeEventListener() {}, getElementById() { return null; } };
globalThis.window = { location: { hostname: 'localhost' }, localStorage: { getItem: () => null, setItem() {} }, addEventListener() {} };
globalThis.localStorage = { getItem: (k) => (k === 'admin.lang' ? 'ru' : null), setItem() {}, removeItem() {}, clear() {} };

const { h } = await import('../ui.js');

test('кнопка с «×» рождается со значком X и именем для читалки', () => {
    for (const glyph of ['\u00d7', '\u2715']) {
        const b = h('button', { class: 'modal-close', onclick: () => {} }, glyph);
        assert.equal(b.children.length, 1, 'вместо буквы должен стоять один значок');
        assert.equal(b.children[0].tagName, 'SVG');
        assert.ok(!b.textContent.includes(glyph), 'буква «×» осталась в кнопке');
        assert.ok(b.getAttribute('aria-label'), 'у кнопки закрытия нет имени для читалки');
    }
});

test('чип-удалялка без класса modal-close тоже получает значок', () => {
    const b = h('button', { class: 'btn btn-sm', type: 'button' }, '\u00d7');
    assert.equal(b.children[0] && b.children[0].tagName, 'SVG');
    assert.ok(b.getAttribute('aria-label'));
});

test('обычная кнопка с текстом не трогается', () => {
    const b = h('button', { class: 'btn' }, 'Сохранить');
    assert.equal(b.children.length, 1);
    assert.equal(b.children[0].nodeType, 3, 'текст кнопки заменён');
    assert.equal(b.getAttribute('aria-label'), null, 'обычная кнопка получила чужое имя');
});
