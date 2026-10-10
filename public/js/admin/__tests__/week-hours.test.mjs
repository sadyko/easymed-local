// BRANCH_PROFILE_V1 — сетка «день недели: работает, с — до» (views/week-hours.js).
// Одна на программу: рабочее время сотрудника («Сотрудники») и часы здания
// («Филиалы»). План docs/plans/2026-10-10-clinic-api-4-branches.md, задача 8.
//
// Поддельный DOM — из company-profile.test.mjs. Язык закреплён ДО импорта
// видов: i18n.js выбирает его один раз при загрузке (ловушка локали CI).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// ===========================================================================
// Поддельный DOM
// ===========================================================================
class FakeNode {
    constructor(tag) {
        this.tagName = String(tag).toUpperCase();
        this.style = makeStyle(); this.children = []; this.attrs = {};
        this.className = ''; this._text = ''; this._l = {};
        this.dataset = {}; this.value = ''; this.hidden = false;
        this._parent = null;
    }
    appendChild(c) { if (c && typeof c === 'object') c._parent = this; this.children.push(c); return c; }
    append(...cs) { for (const c of cs) this.appendChild(typeof c === 'string' ? new FakeText(c) : c); }
    insertBefore(c, ref) {
        if (c && typeof c === 'object') c._parent = this;
        const i = ref ? this.children.indexOf(ref) : -1;
        if (i < 0) this.children.push(c); else this.children.splice(i, 0, c);
        return c;
    }
    removeChild(c) { const i = this.children.indexOf(c); if (i > -1) { this.children.splice(i, 1); c._parent = null; } return c; }
    get firstChild() { return this.children[0] || null; }
    replaceChildren() { this.children.length = 0; }
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = String(v); }
    getAttribute(k) { return this.attrs[k] ?? null; }
    hasAttribute(k) { return k in this.attrs; }
    removeAttribute(k) { delete this.attrs[k]; }
    addEventListener(t, fn) { (this._l[t] || (this._l[t] = [])).push(fn); }
    removeEventListener() {}
    dispatchEvent(e) {
        for (const fn of this._l[e.type] || []) fn(e);
        const prop = this['on' + e.type];
        if (typeof prop === 'function') prop.call(this, e);
        return true;
    }
    click() { this.dispatchEvent({ type: 'click', currentTarget: this, target: this, preventDefault() {}, stopPropagation() {} }); }
    closest() { return null; }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    remove() { if (this._parent) this._parent.removeChild(this); }
    focus() {} blur() {} scrollIntoView() {} select() {}
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
    set textContent(v) { this._text = String(v); this.children.length = 0; }
    get classList() {
        const s = this;
        const list = () => String(s.className || '').split(/\s+/).filter(Boolean);
        return {
            contains: (c) => list().includes(c),
            add: (c) => { if (!list().includes(c)) s.className = list().concat(c).join(' '); },
            remove: (c) => { s.className = list().filter((x) => x !== c).join(' '); },
            toggle() {},
        };
    }
    get isConnected() { return true; }
}
class FakeText extends FakeNode { constructor(t) { super('#text'); this.nodeType = 3; this._text = String(t); } }
function makeStyle() {
    const st = {};
    Object.defineProperties(st, {
        setProperty:    { value(k, v) { st[k] = v; }, enumerable: false },
        removeProperty: { value(k) { delete st[k]; }, enumerable: false },
        getPropertyValue: { value(k) { return st[k] ?? ''; }, enumerable: false },
    });
    return st;
}
function descendants(root, out = []) {
    for (const c of root.children || []) { out.push(c); descendants(c, out); }
    return out;
}
function mkEl(tag) {
    const el = new FakeNode(tag);
    if (el.tagName === 'TEMPLATE') {
        el.content = { firstChild: null };
        Object.defineProperty(el, 'innerHTML', {
            set(v) { const s = new FakeNode('svg'); s.attrs.html = String(v); el.content.firstChild = s; },
            get() { return ''; },
        });
    }
    return el;
}
globalThis.Node = FakeNode;
const BODY = mkEl('body');
globalThis.document = {
    createElement: mkEl, createElementNS: (_n, t) => mkEl(t), createTextNode: (t) => new FakeText(t),
    head: mkEl('head'), body: BODY, documentElement: mkEl('html'), title: 'Easy-Med',
    addEventListener() {}, removeEventListener() {},
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    get activeElement() { return null; },
};
const lsStore = new Map([['admin.lang', 'ru']]);   // I18N_LOCALE_PIN_V1 — до импорта видов
globalThis.localStorage = {
    getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null),
    setItem: (k, v) => { lsStore.set(k, String(v)); },
    removeItem: (k) => { lsStore.delete(k); },
    clear: () => lsStore.clear(),
};
globalThis.window = {
    CLINIC: { id: 1, building_role: 'main' },
    location: { hostname: 'localhost', hash: '' },
    localStorage: globalThis.localStorage,
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    document: globalThis.document,
};
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();

const { weekHoursGrid, WEEK_DAYS } = await import('../views/week-hours.js');
const labelText = (n) => {
    let out = '';
    (function walk(x) { if (!x || x.tagName === 'SVG') return; out += x._text || ''; for (const c of x.children || []) walk(c); })(n);
    return out.replace(/\s+/g, ' ').trim();
};

test('семь строк; отмеченный день — время открыто, неотмеченный — закрыто; подписи времени', () => {
    const g = weekHoursGrid({ mon: { on: true, from: '08:00', to: '17:00' } });
    assert.deepEqual(Object.keys(g.rows), WEEK_DAYS.map(([k]) => k));
    assert.equal(g.rows.mon.chk.checked, true);
    assert.deepEqual([g.rows.mon.from.value, g.rows.mon.to.value, g.rows.mon.from.disabled], ['08:00', '17:00', false]);
    assert.equal(g.rows.tue.chk.checked, false);
    assert.deepEqual([g.rows.tue.from.value, g.rows.tue.from.disabled], ['09:00', true]);
    assert.equal(g.rows.mon.from.getAttribute('aria-label'), 'Пн, с');
    assert.equal(g.rows.mon.to.getAttribute('aria-label'), 'Пн, до');
    // Строка дня — подпись дня в начале (по ней её находят «Филиалы» и читалка экрана).
    const rows = descendants(g.node).filter((n) => String(n.className).split(/\s+/).includes('wkh-row'));
    assert.deepEqual(rows.map((r) => labelText(r).slice(0, 2)), ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']);
});

test('изменение дня — onChange(ключ, { on, from, to }); время открывается вместе с днём', () => {
    const calls = [];
    const g = weekHoursGrid({}, { onChange: (k, e) => calls.push([k, e]) });
    g.rows.sat.chk.checked = true;
    g.rows.sat.chk.dispatchEvent({ type: 'change', target: g.rows.sat.chk });
    assert.deepEqual(calls, [['sat', { on: true, from: '09:00', to: '18:00' }]]);
    assert.equal(g.rows.sat.from.disabled, false);
    g.rows.sat.to.value = '15:00';
    g.rows.sat.to.dispatchEvent({ type: 'change', target: g.rows.sat.to });
    assert.deepEqual(calls[1], ['sat', { on: true, from: '09:00', to: '15:00' }]);
});

test('замок: всё выключено; снятый замок возвращает правило «время — у отмеченных»', () => {
    const g = weekHoursGrid({ mon: { on: true, from: '09:00', to: '18:00' } }, { disabled: true });
    assert.ok(Object.values(g.rows).every((r) => r.chk.disabled && r.from.disabled && r.to.disabled));
    g.setDisabled(false);
    assert.equal(g.rows.mon.from.disabled, false);
    assert.equal(g.rows.tue.from.disabled, true);
});

test('«Сотрудники» берут ту же сетку — своей больше нет', () => {
    const src = fs.readFileSync(new URL('../views/employees.js', import.meta.url), 'utf8');
    assert.match(src, /import \{ weekHoursGrid \} from '\.\/week-hours\.js'/);
    assert.doesNotMatch(src, /type: 'time'/);
});
