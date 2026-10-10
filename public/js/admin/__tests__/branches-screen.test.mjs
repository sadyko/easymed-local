// BRANCH_PROFILE_V1 — экран «Филиалы» (шаг 4 API клиники; план
// docs/plans/2026-10-10-clinic-api-4-branches.md, задачи 10, 12–15).
//
// Что проверяется вживую, на поддельном DOM и поддельном сервере:
//   * карточки адреса и карты «Компании» с заголовком, подсказкой и замком
//     от вызывающего (задача 10);
//   * страница здания: название на трёх языках, телефон, «Работает», адрес для
//     партнёров с ориентиром, карта, «показывать на сайте», часы работы и
//     предупреждение о врачах (задачи 12–14);
//   * список зданий и подключение к «Настройкам» (задача 15).
//
// Поддельный DOM — из company-profile.test.mjs (у него есть options /
// selectedIndex для списков). Язык закреплён ДО импорта видов: i18n.js
// выбирает его один раз при загрузке (ловушка локали CI).

import { test } from 'node:test';
import assert from 'node:assert/strict';

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
    appendChild(c) { if (c && typeof c === 'object') { if (c._parent && c._parent !== this) c._parent.removeChild(c); c._parent = this; } this.children.push(c); return c; }
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
    querySelector(sel) { return descendants(this).find((n) => matches(n, sel)) || null; }
    querySelectorAll(sel) { return descendants(this).filter((n) => matches(n, sel)); }
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
            toggle: (c, on) => { const has = list().includes(c); const want = on === undefined ? !has : !!on; s.className = (want ? list().concat(has ? [] : [c]) : list().filter((x) => x !== c)).join(' '); },
        };
    }
    get isConnected() { return true; }
    get options() { return this.children.filter((c) => c.tagName === 'OPTION'); }
    get selectedIndex() {
        const o = this.options;
        const i = o.findIndex((x) => x.selected === true || x.attrs.selected !== undefined);
        return i < 0 ? (o.length ? 0 : -1) : i;
    }
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
function matches(node, sel) {
    if (!node || !sel) return false;
    for (const part of String(sel).trim().split(/\s+/).slice(-1)) {
        const cls = part.match(/\.[A-Za-z0-9_-]+/g) || [];
        const id  = (part.match(/#([A-Za-z0-9_-]+)/) || [])[1];
        const tag = (part.match(/^[A-Za-z][A-Za-z0-9]*/) || [])[0];
        const have = String(node.className || '').split(/\s+/);
        if (tag && node.tagName !== tag.toUpperCase()) return false;
        if (id && node.attrs.id !== id) return false;
        for (const c of cls) if (!have.includes(c.slice(1))) return false;
        return true;
    }
    return false;
}
function mkEl(tag) {
    const el = new FakeNode(tag);
    if (el.tagName === 'TEMPLATE') {
        el.content = { firstChild: null };
        Object.defineProperty(el, 'innerHTML', {
            set(v) { const s = new FakeNode('svg'); s._text = ''; s.attrs.html = String(v); el.content.firstChild = s; },
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
    getElementById: (id) => descendants(BODY).find((n) => n.attrs.id === id) || null,
    querySelector: () => null,
    querySelectorAll: () => [],
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
    CLINIC: { id: 1, slug: 'local', name: 'Клиника «Шифо»', building_role: 'main' },
    location: { hostname: 'localhost', hash: '' },
    localStorage: globalThis.localStorage,
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    document: globalThis.document,
};
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();
globalThis.CustomEvent = class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } };

// ===========================================================================
// Поддельный сервер
// ===========================================================================
const GEO = {
    countries: [{ id: 1, name: 'Узбекистан', name_uz: 'O‘zbekiston', name_en: 'Uzbekistan', code: 'UZ', active: 1 },
                { id: 2, name: 'Казахстан', name_uz: 'Qozog‘iston', name_en: 'Kazakhstan', code: 'KZ', active: 1 }],
    regions:   [{ id: 14, country_id: 1, name: 'город Ташкент', name_uz: 'Toshkent shahri', name_en: 'Tashkent city', code: 'tashkent-city', active: 1 }],
    districts: [{ id: 101, region_id: 14, name: 'Юнусабадский район', name_uz: 'Yunusobod tumani', name_en: 'Yunusabad district', code: 'yunusobod', active: 1 }],
};
// Колонки миграции 241 — те же, что BRANCH_PROFILE_COLUMNS (shared/branch-profile.js).
const PROFILE_COLS = ['name_uz', 'name_en', 'country_code', 'region_code', 'district_code', 'street_ru', 'street_uz', 'street_en',
    'landmark_ru', 'landmark_uz', 'landmark_en', 'maps_url', 'show_public'];
const BLANK_ROW = { name: '', phone: '', address: '', license_number: '', is_24_7: 0, working_hours: '{}', active: 1,
    created_at: '2026-01-01T00:00:00Z', ...Object.fromEntries(PROFILE_COLS.map((c) => [c, c === 'show_public' ? 1 : ''])) };
let branchRows = [];      // строки branches «на сервере»
let companyRow = null;    // строка doc_settings (список «Филиалов» читает её для своего здания)
let writes = [];          // [{ op, values, filters }]
let impactCalls = [];     // тела branch_hours_impact
let impactReply = { data: { doctors: [] } };
const ok = (body) => ({ ok: true, status: 200, json: async () => body });
globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.startsWith('/api/rpc/branch_hours_impact')) {
        impactCalls.push(JSON.parse(opts.body || '{}'));
        if (impactReply.error) return { ok: false, status: impactReply.status || 500, json: async () => ({ error: impactReply.error }) };
        return ok({ data: impactReply.data });
    }
    if (u.startsWith('/api/rpc/')) return ok({ data: null });
    if (u.startsWith('/api/db')) {
        let desc = {};
        try { desc = JSON.parse(opts.body || '{}'); } catch (_) { /* пусто */ }
        const op = desc.op || 'select';
        if (desc.table === 'branches') {
            if (op === 'select') return ok({ data: branchRows.map((r) => ({ ...r })) });
            writes.push({ op, values: desc.values, filters: desc.filters || [] });
            if (op === 'update') {
                const id = (desc.filters || []).find((f) => f.col === 'id').val;
                const r = branchRows.find((x) => x.id === id);
                Object.assign(r, desc.values);
                return ok({ data: { ...r } });
            }
            const r = { ...BLANK_ROW, ...desc.values, id: 100 + branchRows.length };
            branchRows.push(r);
            return ok({ data: { ...r } });
        }
        if (desc.table === 'doc_settings') return ok({ data: companyRow ? { ...companyRow } : null });
        if (GEO[desc.table]) {
            let rows = GEO[desc.table].filter((r) => r.active);
            for (const f of desc.filters || []) if (f.op === 'eq' && f.col !== 'active') rows = rows.filter((r) => String(r[f.col]) === String(f.val));
            return ok({ data: rows.map((r) => ({ ...r })) });
        }
        return ok({ data: op === 'select' ? [] : null, count: 0 });
    }
    return ok({});
};

// ===========================================================================
// Помощники (как в company-profile.test.mjs)
// ===========================================================================
const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));
const textOf = (n) => (n ? n.textContent : '');
const labelText = (n) => {
    let out = '';
    (function walk(x) { if (!x || x.tagName === 'SVG') return; out += x._text || ''; for (const c of x.children || []) walk(c); })(n);
    return out.replace(/\s+/g, ' ').trim();
};
const isCtrl = (n) => n.tagName === 'INPUT' || n.tagName === 'TEXTAREA' || n.tagName === 'SELECT';
/** Группа на трёх языках (fieldset), чей заголовок содержит label → ячейка с тегом языка → её поле. */
function triInput(root, label, lang) {
    const set = descendants(root).find((n) => n.tagName === 'FIELDSET'
        && labelText(n.children.find((c) => c.tagName === 'LEGEND')).includes(label));
    assert.ok(set, 'нет группы «' + label + '»');
    const cell = descendants(set).find((n) => matches(n, '.docprof-tricell')
        && labelText(n.children.find((c) => c.tagName === 'LABEL')).startsWith(lang.toUpperCase()));
    assert.ok(cell, 'нет поля «' + label + '» ' + lang.toUpperCase());
    return descendants(cell).find(isCtrl);
}
/** .field, чья метка начинается с label → её поле (input / textarea / select). */
function fieldBox(root, label) {
    return descendants(root).find((n) => matches(n, '.field')
        && (() => { const l = n.children.find((c) => c.tagName === 'LABEL'); return labelText(l).startsWith(label); })()) || null;
}
function fieldInput(root, label) {
    const box = fieldBox(root, label);
    assert.ok(box, 'нет поля «' + label + '»');
    return descendants(box).find(isCtrl);
}
function fieldError(root, label) {
    const box = fieldBox(root, label);
    assert.ok(box, 'нет поля «' + label + '»');
    const e = descendants(box).find((n) => matches(n, '.cpf-err') && !n.hidden);
    return e ? textOf(e) : '';
}
function type(el, v) {
    el.value = v;
    el.dispatchEvent({ type: 'input', target: el, currentTarget: el });
}
const buttons = (root) => descendants(root).filter((n) => n.tagName === 'BUTTON');
const buttonByText = (root, re) => buttons(root).find((b) => re.test(labelText(b))) || null;
async function save(root) {
    const btn = buttonByText(root, /^Сохранить$/);
    assert.ok(btn, 'нет кнопки «Сохранить»');
    btn.click();
    await settle(60);
}
const toastText = () => textOf(document.getElementById('toast'));
const geoSel = (root, label) => fieldInput(root, label);
const selectedValue = (sel) => { const o = sel.options[sel.selectedIndex]; return o ? (o.attrs.value ?? '') : ''; };
async function choose(sel, value) {
    const opts = sel.options;
    assert.ok(opts.some((o) => o.attrs.value === value), 'в списке нет ' + value + ': ' + opts.map((o) => o.attrs.value).join(','));
    for (const o of opts) { o.selected = o.attrs.value === value; delete o.attrs.selected; }
    sel.dispatchEvent({ type: 'change', target: sel, currentTarget: sel });
    await settle(40);
}
const fullAddr = (root, key) => {
    const dd = descendants(root).find((n) => n.tagName === 'DD' && n.dataset && n.dataset.lang === key);
    assert.ok(dd, 'нет строки полного адреса ' + key);
    return textOf(dd);
};
function triError(root, label, lang) {
    const ctrl = triInput(root, label, lang);
    const e = descendants(ctrl._parent).find((n) => matches(n, '.cpf-err') && !n.hidden);
    return e ? textOf(e) : '';
}
const routeDd = (root) => {
    const dt = descendants(root).find((n) => n.tagName === 'DT' && labelText(n) === 'Кнопка «Маршрут»');
    assert.ok(dt, 'нет строки «Кнопка «Маршрут»»');
    const kids = dt._parent.children;
    return kids[kids.indexOf(dt) + 1];
};
const isOff = (n) => !!n && (n.disabled === true || n.attrs.disabled !== undefined);

// ===========================================================================
// Задача 10 — карточки шага 3 с заголовком, подсказкой и замком от вызывающего.
// ===========================================================================
const { addressCard, mapCard } = await import('../views/company-address.js');

test('адрес: свой заголовок, подсказка, замок, узел после улицы; без опций — как в «Компании» и с подсказкой про «Филиалы»', async () => {
    const st = { country_code: 'UZ', region_code: 'tashkent-city', district_code: 'yunusobod', street_ru: 'ул. Мира, 1', street_uz: '', street_en: '', maps_url: '' };
    const after = mkEl('p'); after.textContent = 'после улицы';
    const a = addressCard(st, { title: 'Адрес для партнёров и сайта', hint: 'Своя подсказка.', disabled: true, after });
    const root = mkEl('div'); root.appendChild(a.node);
    await a.load(); await settle(40);
    assert.match(textOf(root), /Своя подсказка\./);
    assert.doesNotMatch(textOf(root), /эти списки его не меняют/, 'своя подсказка заменяет подсказку «Компании»');
    for (const l of ['Страна', 'Город / область', 'Район']) assert.ok(isOff(geoSel(root, l)), l + ' выключен');
    assert.equal(selectedValue(geoSel(root, 'Район')), 'yunusobod', 'сохранённое видно и под замком');
    assert.ok(isOff(triInput(root, 'Улица, дом', 'ru')));
    assert.ok(descendants(a.node).includes(after));

    const plain = addressCard({ ...st }, {});
    assert.match(textOf(plain.node), /Адреса других зданий — в «Филиалах»\./, 'подсказка шага 3 возвращена');
    const pr = mkEl('div'); pr.appendChild(plain.node);
    await plain.load(); await settle(40);
    assert.ok(!isOff(geoSel(pr, 'Район')) && !isOff(triInput(pr, 'Улица, дом', 'ru')), 'без замка — как в «Компании»');

    const m = mapCard({ maps_url: '' }, { label: 'Ссылка на филиал в Яндекс Картах', hint: 'Подсказка карты.', disabled: true });
    const mr = mkEl('div'); mr.appendChild(m.node); m.load();
    assert.ok(isOff(fieldInput(mr, 'Ссылка на филиал в Яндекс Картах')));
    assert.match(textOf(mr), /Подсказка карты\./);
    const mDefault = mkEl('div'); mDefault.appendChild(mapCard({ maps_url: '' }).node);
    assert.ok(fieldInput(mDefault, 'Ссылка на клинику в Яндекс Картах'), 'без опций — подпись «Компании»');
    assert.ok(!isOff(fieldInput(mDefault, 'Ссылка на клинику в Яндекс Картах')));
});
