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
import fs from 'node:fs';

// ===========================================================================
// Поддельный DOM
// ===========================================================================
const focusLog = [];
const scrollLog = [];
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
    // Ревью шага 4 (находка 8) — куда экран увёл фокус и прокрутку после неудачного сохранения.
    focus() { focusLog.push(this); } blur() {} scrollIntoView() { scrollLog.push(this); } select() {}
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

// ===========================================================================
// Задачи 12–14 — страница здания.
// ===========================================================================
const { renderBranchPage } = await import('../views/branch-page.js');
const { BRANCH_MESSAGES, BRANCH_PROFILE_COLUMNS, PHONE_MAX } = await import('../../shared/branch-profile.js');
async function openPage(row, opts = {}) {
    branchRows = row ? [{ ...BLANK_ROW, ...row }] : [];
    writes = []; impactCalls = []; impactReply = { data: { doctors: [] } };
    const t = document.getElementById('toast'); if (t) t.textContent = '';
    let done = 0;
    const root = mkEl('div');
    await renderBranchPage(root, { row: row ? branchRows[0] : null, onDone: () => { done++; }, onBack: () => {}, ...opts });
    await settle(80);
    return { root, done: () => done };
}

test('харнесс: пустая строка сервера — ровно колонки миграции 241', () => {
    assert.deepEqual(PROFILE_COLS, [...BRANCH_PROFILE_COLUMNS]);
});

test('новый филиал: без названия RU — объяснение, запроса нет; с названием — вставка без «active»', async () => {
    const { root, done } = await openPage(null);
    const add = buttonByText(root, /^Добавить$/);
    assert.ok(add, 'у нового — «Добавить»');
    assert.match(textOf(root), /Новый филиал/);
    add.click(); await settle(60);
    assert.equal(writes.length, 0);
    assert.equal(triError(root, 'Название филиала', 'ru'), 'Введите название на русском.');
    type(triInput(root, 'Название филиала', 'ru'), 'Юнусабад');
    type(triInput(root, 'Название филиала', 'uz'), 'Yunusobod filiali');
    add.click(); await settle(60);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].op, 'insert');
    assert.deepEqual([writes[0].values.name, writes[0].values.name_uz], ['Юнусабад', 'Yunusobod filiali']);
    assert.ok(!('active' in writes[0].values), 'вставка active не принимает');
    assert.ok(!('address' in writes[0].values), 'прежний адрес экран не пишет (Р3)');
    assert.equal(done(), 1);
    assert.match(toastText(), /Филиал сохранён/);
});

test('прежний филиал: поля показывают строку; уходит только изменённое, по id', async () => {
    const { root } = await openPage({ id: 5, name: 'Юнусабад', name_uz: 'Yunusobod', phone: '+998 71 200 12 00' });
    assert.equal(triInput(root, 'Название филиала', 'ru').value, 'Юнусабад');
    assert.equal(triInput(root, 'Название филиала', 'uz').value, 'Yunusobod');
    type(triInput(root, 'Название филиала', 'en'), 'Yunusabad branch');
    await save(root);
    assert.equal(writes[0].op, 'update');
    assert.deepEqual(writes[0].values, { name_en: 'Yunusabad branch' });
    assert.deepEqual(writes[0].filters, [{ col: 'id', op: 'eq', val: 5 }]);
});

test('ничего не меняли — «Нет изменений», запроса нет', async () => {
    const { root } = await openPage({ id: 5, name: 'Юнусабад', phone: '+998712001200' });
    await save(root);
    assert.equal(writes.length, 0);
    assert.match(toastText(), /Нет изменений/);
});

test('телефон для пациентов и «Работает»', async () => {
    const { root } = await openPage({ id: 5, name: 'Юнусабад' });
    const ph = fieldInput(root, 'Телефон для пациентов');
    const label = fieldBox(root, 'Телефон для пациентов').children.find((c) => c.tagName === 'LABEL');
    assert.equal(label.attrs.for, ph.attrs.id, 'подпись связана с самим полем ввода (читалка экрана)');
    // Ревью шага 4, #3 — предел длины телефона (PHONE_MAX) виден полю, а не только серверу (400).
    assert.equal(ph.attrs.maxlength, String(PHONE_MAX));
    ph.value = '+998 90 111 22 33';   // phoneInput читается при сохранении
    const act = fieldInput(root, 'Работает');
    act.checked = false; act.dispatchEvent({ type: 'change', target: act });
    await save(root);
    assert.equal(writes[0].values.phone.replace(/\D/g, ''), '998901112233');
    assert.equal(writes[0].values.active, 0);
});

test('своё здание главного: телефон — из «Компании», только виден; кнопка ведёт в «Компанию»; уходит только своё «Филиалов»', async () => {
    const nav = [];
    const { root } = await openPage({ id: 1, name: 'Главный корпус', phone: 'старый' },
        { own: true, company: { phone: '+998 71 200 12 00' }, onNavigate: (r) => nav.push(r) });
    const ph = fieldInput(root, 'Телефон для пациентов');
    assert.ok(isOff(ph));
    assert.equal(ph.value.replace(/\D/g, ''), '998712001200');
    assert.match(textOf(root), /Это здание/);
    buttonByText(root, /Изменить в «Компании»/).click();
    assert.deepEqual(nav, ['documents-settings']);
    type(triInput(root, 'Название филиала', 'uz'), 'Bosh bino');
    await save(root);
    assert.deepEqual(writes[0].values, { name_uz: 'Bosh bino' });
});

test('своё здание: «Изменить в «Компании»» с несохранённым — спрашивает; отказ — остаёмся', async () => {
    const nav = []; const asked = [];
    globalThis.window.confirm = (t) => { asked.push(t); return false; };
    try {
        const { root } = await openPage({ id: 1, name: 'Главный корпус' }, { own: true, company: {}, onNavigate: (r) => nav.push(r) });
        type(triInput(root, 'Название филиала', 'en'), 'Main');
        buttonByText(root, /Изменить в «Компании»/).click();
        assert.deepEqual(nav, []);
        assert.match(asked[0], /не сохранён/);
    } finally { delete globalThis.window.confirm; }
});

test('филиал: всё только видно, вверху объяснение, кнопки сохранения нет', async () => {
    const { root } = await openPage({ id: 5, name: 'Главный корпус' }, { secondary: true });
    assert.ok(textOf(root).includes(BRANCH_MESSAGES.mainOnly));
    for (const l of ['ru', 'uz', 'en']) assert.ok(isOff(triInput(root, 'Название филиала', l)), l);
    assert.ok(isOff(fieldInput(root, 'Телефон для пациентов')) && isOff(fieldInput(root, 'Работает')));
    assert.equal(buttonByText(root, /^Сохранить$/), null);
    assert.match(textOf(root), /Только просмотр/);
});

test('«Филиалы: Просмотр» — всё только видно', async () => {
    const { root } = await openPage({ id: 5, name: 'Юнусабад' }, { readOnly: true });
    assert.equal(buttonByText(root, /^Сохранить$/), null);
    assert.ok(isOff(triInput(root, 'Название филиала', 'ru')));
    assert.ok(isOff(fieldInput(root, 'Работает')));
});

test('«К списку филиалов»: без изменений — сразу; с несохранённым — спрашивает', async () => {
    let backs = 0; const asked = [];
    globalThis.window.confirm = (t) => { asked.push(t); return false; };
    try {
        const { root } = await openPage({ id: 5, name: 'Юнусабад' }, { onBack: () => { backs++; } });
        buttonByText(root, /К списку филиалов/).click();
        assert.deepEqual([backs, asked.length], [1, 0]);
        type(triInput(root, 'Название филиала', 'en'), 'X');
        buttonByText(root, /К списку филиалов/).click();
        assert.equal(backs, 1, 'отказ — остаёмся');
        assert.match(asked[0], /не сохранён/);
    } finally { delete globalThis.window.confirm; }
});

test('отказ сервера: с полем — объяснение под ним; без поля — только тост; страница остаётся', async () => {
    const { root, done } = await openPage({ id: 5, name: 'Юнусабад' });
    const realFetch = globalThis.fetch;
    let reply = { status: 409, error: { code: 'conflict', message: BRANCH_MESSAGES.mainOnly } };
    globalThis.fetch = async (url, opts) => (String(url).startsWith('/api/db') && JSON.parse(opts.body || '{}').op === 'update'
        ? { ok: false, status: reply.status, json: async () => ({ error: reply.error }) } : realFetch(url, opts));
    try {
        type(triInput(root, 'Название филиала', 'en'), 'Yunusabad');
        await save(root);
        assert.equal(toastText(), BRANCH_MESSAGES.mainOnly);
        assert.equal(done(), 0, 'не сохранилось — к списку не уходим');
        reply = { status: 400, error: { code: 'bad_request', message: BRANCH_MESSAGES.name, field: 'name' } };
        type(triInput(root, 'Название филиала', 'ru'), 'Юнусабад-2');
        await save(root);
        assert.equal(triError(root, 'Название филиала', 'ru'), BRANCH_MESSAGES.name);
    } finally { globalThis.fetch = realFetch; }
});

// ---- задача 13: адрес для партнёров, ориентир, карта, показ на сайте ----
test('адрес для партнёров: коды, улица и ориентир на трёх языках; прежний адрес не трогается', async () => {
    const { root } = await openPage({ id: 5, name: 'Юнусабад', address: 'Юнусабад-4' });
    assert.equal(selectedValue(geoSel(root, 'Страна')), 'UZ');
    assert.match(textOf(root), /Прежний адрес из списка: Юнусабад-4/);
    await choose(geoSel(root, 'Город / область'), 'tashkent-city');
    await choose(geoSel(root, 'Район'), 'yunusobod');
    type(triInput(root, 'Улица, дом', 'ru'), 'ул. Амира Темура, 12');
    type(triInput(root, 'Ориентир', 'ru'), 'Напротив парка');
    type(triInput(root, 'Ориентир', 'uz'), 'Bog‘ qarshisida');
    assert.equal(fullAddr(root, 'ru'), 'город Ташкент, Юнусабадский район, ул. Амира Темура, 12');
    await save(root);
    const v = writes[0].values;
    assert.deepEqual([v.country_code, v.region_code, v.district_code, v.street_ru, v.landmark_ru, v.landmark_uz],
        ['UZ', 'tashkent-city', 'yunusobod', 'ул. Амира Темура, 12', 'Напротив парка', 'Bog‘ qarshisida']);
    assert.ok(!('address' in v), 'прежний адрес экран не пишет (Р3)');
});

test('начатый адрес доводится до конца; ориентир — не адрес', async () => {
    const { root } = await openPage({ id: 5, name: 'Юнусабад' });
    type(triInput(root, 'Ориентир', 'ru'), 'Напротив парка');
    await save(root);
    assert.deepEqual(writes[0].values, { landmark_ru: 'Напротив парка' });
    writes.length = 0;
    type(triInput(root, 'Улица, дом', 'ru'), 'ул. Мира, 1');
    await save(root);
    assert.equal(writes.length, 0);
    assert.equal(fieldError(root, 'Город / область'), 'Выберите город или область.');
});

test('сохранённые коды выбраны в списках; нетронутый адрес не шлётся', async () => {
    const { root } = await openPage({ id: 5, name: 'Юнусабад', country_code: 'UZ', region_code: 'tashkent-city', district_code: 'yunusobod', street_ru: 'ул. Мира, 1' });
    assert.equal(selectedValue(geoSel(root, 'Район')), 'yunusobod');
    assert.equal(triInput(root, 'Улица, дом', 'ru').value, 'ул. Мира, 1');
    assert.doesNotMatch(textOf(root), /Прежний адрес из списка/, 'прежнего адреса нет — подсказки нет');
    type(triInput(root, 'Улица, дом', 'uz'), 'Tinchlik ko‘chasi, 1');
    await save(root);
    assert.deepEqual(writes[0].values, { street_uz: 'Tinchlik ko‘chasi, 1' });
});

test('карта филиала: не Яндекс — объяснение; Яндекс — маршрут и запись', async () => {
    const { root } = await openPage({ id: 5, name: 'Юнусабад' });
    const maps = fieldInput(root, 'Ссылка на филиал в Яндекс Картах');
    type(maps, 'https://maps.google.com/x');
    await save(root);
    assert.equal(writes.length, 0);
    assert.match(fieldError(root, 'Ссылка на филиал в Яндекс Картах'), /Нужна ссылка из Яндекс Карт/);
    type(maps, 'https://yandex.uz/maps/?ll=69.24%2C41.29&pt=69.24,41.29');
    assert.ok(textOf(routeDd(root)).includes('https://yandex.uz/maps/?rtext=~41.29,69.24&rtt=auto'));
    await save(root);
    assert.equal(writes[0].values.maps_url, 'https://yandex.uz/maps/?ll=69.24%2C41.29&pt=69.24,41.29');
});

test('«Показывать филиал на сайте и у партнёров»: включено по умолчанию; снятая отметка — show_public 0; врачи — тоже', async () => {
    const { root } = await openPage({ id: 5, name: 'Юнусабад' });
    const pub = fieldInput(root, 'Показывать филиал на сайте и у партнёров');
    assert.equal(pub.checked, true);
    assert.match(textOf(root), /его врачей там тоже не покажут/);
    pub.checked = false; pub.dispatchEvent({ type: 'change', target: pub });
    await save(root);
    assert.deepEqual(writes[0].values, { show_public: 0 });
});

test('своё здание главного: адрес и карта — из «Компании», только видны; ориентир правится', async () => {
    const { root } = await openPage({ id: 1, name: 'Главный корпус', address: 'старый адрес' }, { own: true, company: { country_code: 'UZ',
        region_code: 'tashkent-city', district_code: 'yunusobod', street_ru: 'ул. Мира, 1', street_uz: '', street_en: '',
        maps_url: 'https://yandex.uz/maps/-/CDm', phone: '+998712001200' } });
    assert.equal(selectedValue(geoSel(root, 'Район')), 'yunusobod');
    assert.ok(isOff(geoSel(root, 'Район')) && isOff(triInput(root, 'Улица, дом', 'ru')) && isOff(fieldInput(root, 'Ссылка на филиал в Яндекс Картах')));
    assert.equal(fullAddr(root, 'ru'), 'город Ташкент, Юнусабадский район, ул. Мира, 1');
    assert.equal(fieldInput(root, 'Ссылка на филиал в Яндекс Картах').value, 'https://yandex.uz/maps/-/CDm');
    assert.doesNotMatch(textOf(root), /Прежний адрес из списка/, 'у своего здания адрес — в «Компании»: второго не рисуем');
    type(triInput(root, 'Ориентир', 'ru'), 'Напротив парка');
    await save(root);
    assert.deepEqual(writes[0].values, { landmark_ru: 'Напротив парка' });
});

test('филиал: адрес, ориентир, карта и показ на сайте — только видны', async () => {
    const { root } = await openPage({ id: 5, name: 'Главный корпус', country_code: 'UZ', region_code: 'tashkent-city', district_code: 'yunusobod' }, { secondary: true });
    for (const l of ['Страна', 'Город / область', 'Район']) assert.ok(isOff(geoSel(root, l)), l);
    assert.ok(isOff(triInput(root, 'Улица, дом', 'ru')) && isOff(triInput(root, 'Ориентир', 'uz')));
    assert.ok(isOff(fieldInput(root, 'Ссылка на филиал в Яндекс Картах')) && isOff(fieldInput(root, 'Показывать филиал на сайте и у партнёров')));
});

test('«нет перевода» — у пустых UZ / EN названия и улицы филиала; у ориентира — нет', async () => {
    const { root } = await openPage({ id: 5, name: 'Юнусабад', name_uz: 'Yunusobod' });
    const miss = (label, lang) => { const c = triInput(root, label, lang); const m = descendants(c._parent).find((n) => matches(n, '.cpf-miss')); return !!m && !m.hidden; };
    assert.deepEqual([miss('Название филиала', 'uz'), miss('Название филиала', 'en'), miss('Улица, дом', 'uz'), miss('Ориентир', 'uz')],
        [false, true, true, false]);
    type(triInput(root, 'Название филиала', 'en'), 'Yunusabad');
    assert.equal(miss('Название филиала', 'en'), false);
});

// ---- задача 14: часы работы и предупреждение о врачах ----
const { writeBranchHours, blankDays } = await import('../../shared/branch-hours.js');
const hoursMode = (root, label) => descendants(root).find((n) => matches(n, '.brf-mode') && labelText(n).startsWith(label));
const modeInput = (root, label) => descendants(hoursMode(root, label)).find((n) => n.tagName === 'INPUT');
async function pickMode(root, label) { const r = modeInput(root, label); r.checked = true; r.dispatchEvent({ type: 'change', target: r }); await settle(10); }
const dayRow = (root, day) => descendants(root).find((n) => matches(n, '.wkh-row') && labelText(n).startsWith(day));
const dayCtrls = (root, day) => descendants(dayRow(root, day)).filter((n) => n.tagName === 'INPUT');   // [отметка, с, до]
function setDay(root, day, { on, from, to }) {
    const [chk, f, t] = dayCtrls(root, day);
    if (on !== undefined) { chk.checked = on; chk.dispatchEvent({ type: 'change', target: chk }); }
    if (from !== undefined) { f.value = from; f.dispatchEvent({ type: 'change', target: f }); }
    if (to !== undefined) { t.value = to; t.dispatchEvent({ type: 'change', target: t }); }
}
const hoursCardNode = (root) => descendants(root).find((n) => matches(n, '.card') && descendants(n).some((c) => matches(c, '.brf-modes')));
const WEEK = () => writeBranchHours({ mode: 'week', days: blankDays() }).working_hours;

test('«Не ограничивать» → «По дням недели»: Пн–Пт 09–18, суббота до 15; никого не задело — записано сразу', async () => {
    const { root } = await openPage({ id: 5, name: 'Юнусабад' });
    assert.equal(modeInput(root, 'Не ограничивать').checked, true);
    assert.equal(descendants(root).find((n) => matches(n, '.wkh-grid')).hidden, true, 'сетка спрятана');
    await pickMode(root, 'По дням недели');
    assert.equal(descendants(root).find((n) => matches(n, '.wkh-grid')).hidden, false);
    setDay(root, 'Сб', { on: true, to: '15:00' });
    await save(root);
    const days = blankDays(); days.sat = { on: true, from: '09:00', to: '15:00' };
    const want = writeBranchHours({ mode: 'week', days });
    assert.deepEqual(impactCalls, [{ branch_id: 5, working_hours: want.working_hours, is_24_7: 0 }]);
    assert.deepEqual(writes[0].values, { working_hours: want.working_hours });
});

test('кто-то теряет время — сначала предупреждение со списком; «Вернуться к часам» — ничего не записано; «Сохранить всё равно» — записано', async () => {
    const { root } = await openPage({ id: 5, name: 'Юнусабад' });
    impactReply = { data: { doctors: [{ id: 8, name: 'Каримов Р.', lost: [{ day: 'sat', from: '09:00', to: '18:00' }, { day: 'sun', from: '09:00', to: '18:00' }] }] } };
    await pickMode(root, 'По дням недели');
    await save(root);
    assert.equal(writes.length, 0);
    const panel = descendants(root).find((n) => matches(n, '.brf-impact'));
    assert.ok(panel, 'нет предупреждения');
    assert.equal(panel.attrs.role, 'alertdialog');
    const head = descendants(panel).find((n) => n.attrs.id && n.attrs.id === panel.attrs['aria-labelledby']);
    assert.ok(head && /Эти врачи потеряют часы приёма/.test(labelText(head)), 'вопрос назван своим заголовком');
    assert.match(labelText(panel), /Эти врачи потеряют часы приёма/);
    assert.match(labelText(panel), /Каримов Р\. — Сб 09:00–18:00, Вс 09:00–18:00/);
    assert.match(labelText(panel), /Уже записанные пациенты не отменяются/);
    buttonByText(root, /Вернуться к часам/).click(); await settle(30);
    assert.equal(writes.length, 0);
    assert.equal(descendants(root).find((n) => matches(n, '.brf-impact')), undefined);
    await save(root);
    buttonByText(root, /Сохранить всё равно/).click(); await settle(60);
    assert.equal(writes.length, 1);
    assert.equal(impactCalls.length, 2);
});

test('правка часов, пока вопрос открыт: вопрос снят, ничего не записано, «Сохранить» снова работает', async () => {
    const { root } = await openPage({ id: 5, name: 'Юнусабад' });
    impactReply = { data: { doctors: [{ id: 8, name: 'Каримов Р.', lost: [{ day: 'sun', from: '09:00', to: '18:00' }] }] } };
    await pickMode(root, 'По дням недели');
    await save(root);
    assert.ok(descendants(root).find((n) => matches(n, '.brf-impact')));
    setDay(root, 'Вс', { on: true });
    await settle(30);
    assert.equal(descendants(root).find((n) => matches(n, '.brf-impact')), undefined, 'вопрос про прежние часы снят');
    assert.equal(writes.length, 0);
    impactReply = { data: { doctors: [] } };
    await save(root);
    assert.equal(writes.length, 1, 'сохранение не повисло');
});

test('вопрос открыт, а человек уходит «К списку филиалов» — уходит, ничего не записано', async () => {
    let backs = 0;
    globalThis.window.confirm = () => true;
    try {
        const { root } = await openPage({ id: 5, name: 'Юнусабад' }, { onBack: () => { backs++; } });
        impactReply = { data: { doctors: [{ id: 8, name: 'Каримов Р.', lost: [{ day: 'sun', from: '09:00', to: '18:00' }] }] } };
        await pickMode(root, 'По дням недели');
        await save(root);
        assert.ok(descendants(root).find((n) => matches(n, '.brf-impact')));
        buttonByText(root, /К списку филиалов/).click();
        await settle(30);
        assert.deepEqual([backs, writes.length], [1, 0]);
    } finally { delete globalThis.window.confirm; }
});

test('«Круглосуточно» и «Не ограничивать» никому время не закрывают — без проверки', async () => {
    const wk = WEEK();
    let { root } = await openPage({ id: 5, name: 'Юнусабад', working_hours: wk });
    assert.equal(modeInput(root, 'По дням недели').checked, true);
    await pickMode(root, 'Круглосуточно'); await save(root);
    assert.equal(impactCalls.length, 0);
    assert.deepEqual(writes[0].values, { working_hours: '{}', is_24_7: 1 });
    ({ root } = await openPage({ id: 5, name: 'Юнусабад', working_hours: wk }));
    await pickMode(root, 'Не ограничивать'); await save(root);
    assert.equal(impactCalls.length, 0);
    assert.deepEqual(writes[0].values, { working_hours: '{}' });
});

test('ни одного рабочего дня или конец раньше начала — объяснение, без проверки и записи', async () => {
    const { root } = await openPage({ id: 5, name: 'Юнусабад' });
    await pickMode(root, 'По дням недели');
    for (const d of ['Пн', 'Вт', 'Ср', 'Чт', 'Пт']) setDay(root, d, { on: false });
    await save(root);
    assert.equal(impactCalls.length + writes.length, 0);
    assert.match(labelText(hoursCardNode(root)), /Отметьте хотя бы один рабочий день/);
    setDay(root, 'Пн', { on: true, from: '18:00', to: '09:00' });
    await save(root);
    assert.equal(impactCalls.length + writes.length, 0);
    assert.match(labelText(hoursCardNode(root)), /Пн: время окончания должно быть позже начала\./);
});

test('часы не трогали — проверки нет; проверка не удалась — записи нет, объяснение', async () => {
    let { root } = await openPage({ id: 5, name: 'Юнусабад', working_hours: WEEK() });
    type(triInput(root, 'Название филиала', 'en'), 'Yunusabad');
    await save(root);
    assert.equal(impactCalls.length, 0);
    assert.deepEqual(writes[0].values, { name_en: 'Yunusabad' });
    ({ root } = await openPage({ id: 5, name: 'Юнусабад' }));
    impactReply = { status: 500, error: { code: 'internal', message: 'Ошибка сервера. Повторите позже.' } };
    await pickMode(root, 'По дням недели');
    await save(root);
    assert.equal(writes.length, 0);
    // Ревью шага 4 — часы закрываются не только врачам: «у кого из сотрудников».
    assert.match(toastText(), /^Не удалось проверить, у кого из сотрудников закроется время: Ошибка сервера\. Повторите позже\.$/);
    assert.doesNotMatch(toastText(), /врач/);
});

test('часы прежней формы (enabled) показываются по дням; нетронутые — не шлются', async () => {
    const old = JSON.stringify({ mon: { enabled: true, from: '08:00', to: '17:00' }, tue: { enabled: false, from: '08:00', to: '17:00' } });
    const { root } = await openPage({ id: 5, name: 'Юнусабад', working_hours: old });
    assert.equal(modeInput(root, 'По дням недели').checked, true);
    const [chk, f, t] = dayCtrls(root, 'Пн');
    assert.deepEqual([chk.checked, f.value, t.value], [true, '08:00', '17:00']);
    assert.equal(dayCtrls(root, 'Вт')[0].checked, false);
    await save(root);
    assert.equal(writes.length + impactCalls.length, 0, 'ничего не меняли — «Нет изменений»');
});

test('новый филиал с часами — без проверки (врачей у него ещё нет), часы уходят со вставкой', async () => {
    const { root } = await openPage(null);
    type(triInput(root, 'Название филиала', 'ru'), 'Сергели');
    await pickMode(root, 'По дням недели');
    buttonByText(root, /^Добавить$/).click(); await settle(60);
    assert.equal(impactCalls.length, 0);
    assert.equal(writes[0].values.working_hours, WEEK());
});

test('подсказка часов: ограничивают тех, у кого выбрано это здание — врачей и других исполнителей; без здания — нет (ответ владельца 2026-10-10)', async () => {
    const { root } = await openPage({ id: 5, name: 'Юнусабад' });
    const t = labelText(hoursCardNode(root));
    // Ревью шага 4, после 7e43f859 — каждый, к кому можно записать: врачи, медсёстры, другие исполнители.
    assert.match(t, /каждого сотрудника, к которому можно записать пациента, — врачей, медсестёр и других исполнителей/);
    assert.match(t, /Сотрудников без выбранного здания они не ограничивают/);
    assert.match(t, /Врачи, медсёстры и другие исполнители этого здания принимают по своему графику/, '«Не ограничивать» — тоже не только врачи');
    assert.doesNotMatch(t, /ограничивают только врачей|^Врачи этого здания/, 'ограничиваются не только врачи (ревью шага 4, находка 4)');
});

test('филиал: часы только видны — переключатели и сетка выключены', async () => {
    const { root } = await openPage({ id: 5, name: 'Юнусабад', working_hours: WEEK() }, { secondary: true });
    for (const l of ['Не ограничивать', 'По дням недели', 'Круглосуточно']) assert.ok(isOff(modeInput(root, l)), l);
    assert.ok(dayCtrls(root, 'Пн').every(isOff));
});

// ===========================================================================
// Задача 15 — список «Филиалов».
// ===========================================================================
const { renderBranchesEditor } = await import('../views/branches-editor.js');
const { setLang } = await import('../i18n.js');
let failBranchesSelect = false;   // чтение branches отвечает 503 (сервер перезапускается)
let failCompanySelect = false;    // чтение doc_settings отвечает 503
{
    const base = globalThis.fetch;
    globalThis.fetch = async (url, opts = {}) => {
        if (String(url).startsWith('/api/db')) {
            const d = JSON.parse(opts.body || '{}');
            const fail = (d.table === 'branches' && failBranchesSelect) || (d.table === 'doc_settings' && failCompanySelect);
            if (fail && (d.op || 'select') === 'select') return { ok: false, status: 503, json: async () => ({ error: { code: 'unavailable', message: 'server restarting' } }) };
        }
        return base(url, opts);
    };
}
async function openList(rows, { role = 'main', own = null, readOnly = false, company = null } = {}) {
    branchRows = rows.map((r, i) => ({ ...BLANK_ROW, id: i + 1, ...r }));
    companyRow = company; writes = []; impactCalls = []; impactReply = { data: { doctors: [] } };
    const t = document.getElementById('toast'); if (t) t.textContent = '';
    globalThis.window.CLINIC.building_role = role;
    if (own == null) delete globalThis.window.CLINIC.own_branch_id; else globalThis.window.CLINIC.own_branch_id = own;
    const nav = []; let backs = 0;
    const root = mkEl('div');
    await renderBranchesEditor(root, { onBack: () => { backs++; }, onNavigate: (r) => nav.push(r), readOnly });
    await settle(80);
    return { root, nav, backs: () => backs };
}
const items = (root) => descendants(root).filter((n) => matches(n, '.brf-item'));
const SAT_15 = (() => { const d = blankDays(); d.sat = { on: true, from: '09:00', to: '15:00' }; return writeBranchHours({ mode: 'week', days: d }).working_hours; })();

test('список: название на языке интерфейса, часы, карта, показ на сайте, «Работает»', async () => {
    const rows = [
        { name: 'Юнусабад', name_uz: 'Yunusobod filiali', street_ru: 'ул. Мира, 1', landmark_ru: 'у парка', working_hours: SAT_15, maps_url: 'https://yandex.uz/maps/-/CDx' },
        { name: 'Стационар', is_24_7: 1, show_public: 0, active: 0, address: 'Старый адрес' },
    ];
    let { root } = await openList(rows);
    const [a, b] = items(root).map(labelText);
    assert.match(a, /Юнусабад/);
    assert.match(a, /ул\. Мира, 1, у парка/);
    assert.match(a, /Пн–Пт 09:00–18:00, Сб 09:00–15:00/);
    assert.match(a, /Есть карта/);
    assert.match(a, /На сайте/);
    assert.match(a, /Работает/);
    assert.match(b, /Круглосуточно/);
    assert.match(b, /Скрыт с сайта/);
    assert.match(b, /Отключён/);
    assert.match(b, /Нет карты/);
    assert.match(b, /Старый адрес/, 'пока улицы нет — прежний адрес');
    assert.ok(buttonByText(root, /Добавить филиал/));
    assert.ok(buttonByText(root, /К плиткам настроек/));
    setLang('uz');
    try { ({ root } = await openList(rows)); assert.match(labelText(items(root)[0]), /Yunusobod filiali/); }
    finally { setLang('ru'); }
});

test('список: «Без ограничений», подсказки языков — RU / UZ / EN с переводом и без', async () => {
    const { root } = await openList([{ name: 'Юнусабад', street_ru: 'ул. Мира, 1', name_uz: 'Yunusobod', street_uz: 'Tinchlik, 1' }]);
    const t = labelText(items(root)[0]);
    assert.match(t, /Без ограничений/);
    const chips = descendants(items(root)[0]).filter((n) => matches(n, '.brf-chip'));
    assert.deepEqual(chips.map((c) => [labelText(c), c.classList.contains('on')]), [['RU', true], ['UZ', true], ['EN', false]]);
    assert.equal(chips[2].attrs.title, 'Нет перевода');
});

test('своё здание главного — «Это здание», адрес и телефон из «Компании»; страница открывается своим', async () => {
    const { root, nav } = await openList([{ name: 'Главный корпус', phone: 'старый', street_ru: 'не отсюда' }, { name: 'Чиланзар' }],
        { own: 1, company: { id: 1, phone: '+998 71 200 12 00', street_ru: 'ул. Мира, 1', country_code: 'UZ', region_code: '', district_code: '', street_uz: '', street_en: '', maps_url: '' } });
    const t = labelText(items(root)[0]);
    assert.match(t, /Это здание/);
    assert.match(t, /\+998 71 200 12 00/);
    assert.match(t, /ул\. Мира, 1/);
    assert.doesNotMatch(t, /не отсюда|старый/, 'второго адреса и телефона у своего здания нет');
    assert.doesNotMatch(labelText(items(root)[1]), /Это здание/);
    items(root)[0].click(); await settle(80);
    assert.ok(buttonByText(root, /Изменить в «Компании»/), 'страница своего здания');
    buttonByText(root, /Изменить в «Компании»/).click();
    assert.deepEqual(nav, ['documents-settings']);
});

test('строка → страница → «К списку филиалов»; после сохранения — снова список с новым значением', async () => {
    const { root } = await openList([{ name: 'Юнусабад' }]);
    items(root)[0].click(); await settle(80);
    assert.ok(buttonByText(root, /К списку филиалов/));
    assert.equal(items(root).length, 0, 'страница вместо списка');
    type(triInput(root, 'Название филиала', 'uz'), 'Yunusobod');
    await save(root);
    await settle(80);
    assert.equal(items(root).length, 1, 'вернулись к списку');
    assert.equal(branchRows[0].name_uz, 'Yunusobod');
    assert.match(labelText(items(root)[0]), /Юнусабад/);
    items(root)[0].click(); await settle(80);
    buttonByText(root, /К списку филиалов/).click(); await settle(80);
    assert.equal(items(root).length, 1);
});

test('«Добавить филиал» → новая страница → «Добавить» — в списке два здания', async () => {
    const { root } = await openList([{ name: 'Юнусабад' }]);
    buttonByText(root, /Добавить филиал/).click(); await settle(80);
    type(triInput(root, 'Название филиала', 'ru'), 'Сергели');
    buttonByText(root, /^Добавить$/).click(); await settle(120);
    assert.equal(writes[0].op, 'insert');
    assert.equal(items(root).length, 2);
});

test('филиал: «Добавить филиал» нет, вверху объяснение; «Просмотр»: «Только просмотр»', async () => {
    let { root } = await openList([{ name: 'Главный корпус' }], { role: 'secondary', own: 1 });
    assert.equal(buttonByText(root, /Добавить филиал/), null);
    assert.ok(textOf(root).includes(BRANCH_MESSAGES.mainOnly));
    assert.match(labelText(items(root)[0]), /Это здание/, 'своя строка филиала тоже помечена');
    items(root)[0].click(); await settle(80);
    assert.equal(buttonByText(root, /^Сохранить$/), null, 'в филиале страница только видна');
    ({ root } = await openList([{ name: 'Главный корпус' }], { readOnly: true }));
    assert.equal(buttonByText(root, /Добавить филиал/), null);
    assert.match(textOf(root), /Только просмотр/);
});

test('список не прочитался — объяснение, «Добавить филиал» выключено: вслепую здание не заводится', async () => {
    failBranchesSelect = true;
    try {
        const { root } = await openList([{ name: 'Юнусабад' }]);
        assert.match(textOf(root), /Не удалось загрузить филиалы/);
        const add = buttonByText(root, /Добавить филиал/);
        assert.ok(!add || isOff(add), '«Добавить филиал» выключено');
        assert.equal(items(root).length, 0);
    } finally { failBranchesSelect = false; }
});

test('«Компания» не прочиталась — у своего здания адреса и телефона не видно (не подставляем чужие), объяснение', async () => {
    failCompanySelect = true;
    try {
        const { root } = await openList([{ name: 'Главный корпус', phone: 'старый', street_ru: 'не отсюда' }], { own: 1, company: { phone: '+998 71 200 12 00' } });
        const t = labelText(items(root)[0]);
        assert.doesNotMatch(t, /не отсюда|старый/);
        assert.match(toastText(), /Не удалось загрузить данные компании/);
    } finally { failCompanySelect = false; }
});

test('прежний облачный адрес #settings:branches ведёт в хаб настроек; общего редактора у «Филиалов» больше нет', () => {
    const shell = fs.readFileSync(new URL('../../admin.js', import.meta.url), 'utf8');
    const legacy = shell.slice(shell.indexOf('const LEGACY_ROUTES = {'), shell.indexOf('function navigate('));
    assert.match(legacy, /'settings:branches':\s*\{\s*view:\s*'settings'\s*\}/);
    const hub = fs.readFileSync(new URL('../views/settings-hub.js', import.meta.url), 'utf8');
    assert.match(hub, /state\.section === 'branches'\) await renderBranchesEditor\(/);
    const lookup = hub.slice(hub.indexOf('const LOOKUP_CONFIG = {'));
    assert.doesNotMatch(lookup.slice(0, lookup.indexOf('\n};')), /\n    branches: \{/);
});

// ===========================================================================
// Ревью шага 4 (2026-10-10) — находки экрана: 1, 2, 4, 6, 7, 8.
// Повторы — из scratchpad/step4-review (zz-s4-*), перенесены сюда.
// ===========================================================================
const perms = await import('../permissions.js');
const LOSES_SAT = { data: { doctors: [{ id: 8, name: 'Каримов Р.', lost: [{ day: 'sat', from: '09:00', to: '18:00' }] }] } };

test('ревью 1: правка, набранная пока открыт вопрос о врачах, уходит вместе с часами по «Сохранить всё равно»', async () => {
    const { root, done } = await openPage({ id: 5, name: 'Юнусабад', phone: '+998 71 111 11 11' });
    impactReply = LOSES_SAT;
    await pickMode(root, 'По дням недели');
    await save(root);
    assert.ok(descendants(root).find((n) => matches(n, '.brf-impact')), 'вопрос открыт');
    type(triInput(root, 'Название филиала', 'ru'), 'Юнусабад-2');
    type(triInput(root, 'Название филиала', 'en'), 'Yunusabad branch');
    buttonByText(root, /Сохранить всё равно/).click(); await settle(80);
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0].values, { name: 'Юнусабад-2', name_en: 'Yunusabad branch', working_hours: WEEK() });
    assert.equal(done(), 1);
});

test('ревью 1: правка, набранная пока открыт вопрос, проверяется заново — неверное не уходит и часы тоже', async () => {
    const { root } = await openPage({ id: 5, name: 'Юнусабад' });
    impactReply = LOSES_SAT;
    await pickMode(root, 'По дням недели');
    await save(root);
    type(triInput(root, 'Название филиала', 'ru'), '  ');
    buttonByText(root, /Сохранить всё равно/).click(); await settle(80);
    assert.equal(writes.length, 0, 'пустое RU-название не уходит');
    assert.equal(triError(root, 'Название филиала', 'ru'), 'Введите название на русском.');
});

test('ревью 1 (список): дописанное EN-название после «Сохранить всё равно» не теряется', async () => {
    branchRows = [{ ...BLANK_ROW, id: 1, name: 'Юнусабад' }];
    companyRow = null; writes = []; impactCalls = []; impactReply = LOSES_SAT;
    globalThis.window.CLINIC.building_role = 'main'; delete globalThis.window.CLINIC.own_branch_id;
    const root = mkEl('div');
    await renderBranchesEditor(root, { onBack: () => {}, onNavigate: () => {} });
    await settle(80);
    items(root)[0].click(); await settle(80);
    await pickMode(root, 'По дням недели');
    await save(root);
    type(triInput(root, 'Название филиала', 'en'), 'Yunusabad branch');
    buttonByText(root, /Сохранить всё равно/).click(); await settle(120);
    assert.equal(writes.length, 1);
    assert.equal(branchRows[0].name_en, 'Yunusabad branch');
    assert.equal(items(root).length, 1, 'вернулись к списку');
});

test('ревью 2: ушли со страницы, пока проверка часов ещё идёт, и согласились бросить — ничего не записано', async () => {
    const realFetch = globalThis.fetch;
    let backs = 0;
    globalThis.window.confirm = () => true;
    try {
        const { root } = await openPage({ id: 5, name: 'Юнусабад' }, { onBack: () => { backs++; } });
        globalThis.fetch = async (url, opts) => {
            if (String(url).startsWith('/api/rpc/branch_hours_impact')) await new Promise((r) => setTimeout(r, 150));
            return realFetch(url, opts);
        };
        await pickMode(root, 'По дням недели');
        buttonByText(root, /^Сохранить$/).click();
        await settle(10);                                   // проверка ещё идёт
        buttonByText(root, /К списку филиалов/).click();    // «Изменения пропадут» → OK
        await settle(300);
        assert.equal(backs, 1);
        assert.equal(writes.length, 0, 'брошенные часы не записаны');
        assert.doesNotMatch(toastText(), /Филиал сохранён/);
    } finally { globalThis.fetch = realFetch; delete globalThis.window.confirm; }
});

test('ревью 2: ушли, но отказались бросать — проверка доходит, часы записываются как обычно', async () => {
    const realFetch = globalThis.fetch;
    let backs = 0;
    globalThis.window.confirm = () => false;
    try {
        const { root } = await openPage({ id: 5, name: 'Юнусабад' }, { onBack: () => { backs++; } });
        globalThis.fetch = async (url, opts) => {
            if (String(url).startsWith('/api/rpc/branch_hours_impact')) await new Promise((r) => setTimeout(r, 100));
            return realFetch(url, opts);
        };
        await pickMode(root, 'По дням недели');
        buttonByText(root, /^Сохранить$/).click();
        await settle(10);
        buttonByText(root, /К списку филиалов/).click();
        await settle(250);
        assert.deepEqual([backs, writes.length], [0, 1]);
    } finally { globalThis.fetch = realFetch; delete globalThis.window.confirm; }
});

test('ревью 4: исполнитель услуг (не врач) — в предупреждении с ролью; заголовок говорит «сотрудники»', async () => {
    const { root } = await openPage({ id: 5, name: 'Юнусабад' });
    impactReply = { data: { doctors: [
        { id: 8, name: 'Каримов Р.', lost: [{ day: 'sat', from: '09:00', to: '18:00' }] },
        { id: 12, name: 'Медсестра Н.', role: 'nurse', lost: [{ day: 'sat', from: '09:00', to: '13:00' }] },
    ] } };
    await pickMode(root, 'По дням недели');
    await save(root);
    const panel = descendants(root).find((n) => matches(n, '.brf-impact'));
    const t = labelText(panel);
    assert.match(t, /Эти сотрудники потеряют часы приёма/);
    assert.match(t, /Медсестра Н\. \(Медсестра\) — Сб 09:00–13:00/);
    assert.match(t, /Каримов Р\. — Сб 09:00–18:00/, 'у врача роль не дописывается');
    assert.doesNotMatch(t, /Каримов Р\. \(/);
});

// После 7e43f859 сервер отдаёт role: 'doctor', роль исполнителя процедур
// ('nurse', 'senior_nurse', 'head_doctor') или users.role исполнителя по ставкам
// (любая основная роль). Каждая — подписью; незнакомая и пустая — общим
// «Исполнитель», никогда не сырым ключом.
test('ревью 4: подпись роли — у каждого значения сервера; незнакомая и пустая — «Исполнитель», не ключ', async () => {
    const roles = [['nurse', 'Медсестра'], ['senior_nurse', 'Старшая медсестра'], ['head_doctor', 'Главный врач'], ['lab', 'Лаборант'],
        ['registrar', 'Регистратор'], ['cashier', 'Кассир'], ['admin', 'Администратор'], ['inventory', 'Склад'],
        ['callcenter', 'Оператор колл-центра'], ['head_cashier', 'Старший кассир'], ['masseur_x', 'Исполнитель'], ['', 'Исполнитель']];
    const { root } = await openPage({ id: 5, name: 'Юнусабад' });
    impactReply = { data: { doctors: [
        { id: 1, name: 'Врач Д.', role: 'doctor', lost: [{ day: 'sun', from: '09:00', to: '18:00' }] },
        ...roles.map(([role], i) => ({ id: 100 + i, name: 'Сотрудник ' + i, role, lost: [{ day: 'sun', from: '09:00', to: '18:00' }] })),
    ] } };
    await pickMode(root, 'По дням недели');
    await save(root);
    const panel = descendants(root).find((n) => matches(n, '.brf-impact'));
    const lines = descendants(panel).filter((n) => n.tagName === 'LI').map(labelText);
    assert.equal(lines[0], 'Врач Д. — Вс 09:00–18:00', 'врач — без подписи роли');
    roles.forEach(([role, label], i) => assert.equal(lines[i + 1], 'Сотрудник ' + i + ' (' + label + ') — Вс 09:00–18:00', 'роль «' + role + '»'));
    assert.doesNotMatch(labelText(panel), /masseur_x|senior_nurse|head_doctor|\(\)/, 'сырых ключей и пустых скобок нет');
    // Ответ сервера старше 7e43f859 — без role: это врачи, как раньше.
    impactReply = { data: { doctors: [{ id: 8, name: 'Каримов Р.', lost: [{ day: 'sun', from: '09:00', to: '18:00' }] }] } };
    buttonByText(root, /Вернуться к часам/).click(); await settle(30);
    await save(root);
    assert.match(labelText(descendants(root).find((n) => matches(n, '.brf-impact'))), /Эти врачи потеряют часы приёма.*Каримов Р\. — Вс/);
});

test('ревью 4: на узбекском и английском подпись роли переведена', async () => {
    const { setLang } = await import('../i18n.js');
    for (const [lang, want] of [['uz', /Hamshira/], ['en', /Nurse/]]) {
        setLang(lang);
        try {
            const { root } = await openPage({ id: 5, name: 'Юнусабад' });
            impactReply = { data: { doctors: [{ id: 12, name: 'N.', role: 'nurse', lost: [{ day: 'sat', from: '09:00', to: '13:00' }] },
                { id: 13, name: 'X.', role: 'unknown_role', lost: [{ day: 'sat', from: '09:00', to: '13:00' }] }] } };
            const week = descendants(root).find((n) => n.tagName === 'INPUT' && n.attrs.type === 'radio' && n.attrs.value === 'week');
            week.checked = true; week.dispatchEvent({ type: 'change', target: week }); await settle(10);
            const btn = buttons(root).find((b) => b.className.includes('btn-primary'));
            btn.click(); await settle(60);
            const t = labelText(descendants(root).find((n) => matches(n, '.brf-impact')));
            assert.match(t, want);
            assert.doesNotMatch(t, /unknown_role|[А-Яа-яЁё]/, lang + ': без кириллицы и сырого ключа');
        } finally { setLang('ru'); }
    }
});

test('ревью 8: ошибка только в часах — экран ведёт к ней: прокрутка и фокус в карточке часов', async () => {
    const within = (outer, n) => n === outer || descendants(outer).includes(n);
    let { root } = await openPage({ id: 5, name: 'Юнусабад' });
    await pickMode(root, 'По дням недели');
    for (const d of ['Пн', 'Вт', 'Ср', 'Чт', 'Пт']) setDay(root, d, { on: false });
    focusLog.length = 0; scrollLog.length = 0;
    await save(root);
    assert.equal(writes.length, 0);
    const card = hoursCardNode(root);
    assert.ok(focusLog.some((n) => within(card, n)) && scrollLog.some((n) => within(card, n)), 'фокус и прокрутка — в карточке часов');
    const [monChk] = dayCtrls(root, 'Пн');
    assert.equal(focusLog[focusLog.length - 1], monChk, 'ни одного рабочего дня — фокус на понедельнике');

    ({ root } = await openPage({ id: 5, name: 'Юнусабад' }));
    await pickMode(root, 'По дням недели');
    setDay(root, 'Ср', { from: '18:00', to: '09:00' });
    focusLog.length = 0;
    await save(root);
    const [, , wedTo] = dayCtrls(root, 'Ср');
    assert.equal(focusLog[focusLog.length - 1], wedTo, 'конец раньше начала — фокус на «до» этого дня');
    assert.equal(wedTo.attrs['aria-invalid'], 'true');
    setDay(root, 'Ср', { to: '19:00' });
    assert.equal(wedTo.attrs['aria-invalid'], undefined, 'исправили — пометка снята');
});

test('ревью 6: роль с «Филиалы: Изменение», но без «Компании» — кнопки «Изменить в «Компании»» нет, объяснение другое', async () => {
    perms.setEffectiveFromRole({ name: 'Офис', permissions: { sections: ['settings'], levels: {},
        grants: { settings: 'view', 'settings.branches': 'edit', 'settings.company': 'none' } } });
    try {
        assert.equal(perms.isRouteAllowed('documents-settings'), false, 'стенд: «Компания» роли закрыта');
        const nav = [];
        const { root } = await openPage({ id: 1, name: 'Главный корпус' }, { own: true, company: { phone: '+998 71 200 12 00' }, onNavigate: (r) => nav.push(r) });
        assert.equal(buttonByText(root, /Изменить в «Компании»/), null);
        assert.match(textOf(root), /её меняет администратор или тот, кому выдано изменение «Компании»/);
        assert.ok(isOff(fieldInput(root, 'Телефон для пациентов')), 'телефон по-прежнему только виден');
    } finally { perms.setFullAccess('Admin'); }
    const { root } = await openPage({ id: 1, name: 'Главный корпус' }, { own: true, company: {} });
    assert.ok(buttonByText(root, /Изменить в «Компании»/), 'полному доступу кнопка есть');
});

test('ревью 7: у своего здания главного список не показывает прежний адрес из branches (его нет ни на странице, ни в «Компании»)', async () => {
    const company = { id: 1, address: 'г. Ташкент, ул. Навои, 10 (бланк)', phone: '+998 71 200 12 00', country_code: 'UZ',
        region_code: '', district_code: '', street_ru: '', street_uz: '', street_en: '', maps_url: '' };
    const { root } = await openList([{ name: 'Главный корпус', address: 'ул. Старая, 5 (старый список)' },
        { name: 'Чиланзар', address: 'ул. Филиальная, 3' }], { own: 1, company });
    const [own, other] = items(root).map(labelText);
    assert.doesNotMatch(own, /ул\. Старая, 5/);
    assert.match(other, /ул\. Филиальная, 3/, 'у других зданий прежний адрес виден, как и на их странице');
    items(root)[0].click(); await settle(80);
    assert.doesNotMatch(textOf(root), /ул\. Старая, 5/);
});

// ===========================================================================
// CLINIC_API_STEP7_V1 — решение владельца 11 ПО ЗДАНИЯМ: пока включено подключение
// API (window.CLINIC.api_address_required), у филиала, показанного на сайте, адрес
// для партнёров обязателен — звёздочки, строка над полями, проверка до записи;
// отказ сервера partner_address_required — ошибка под полем и фокус (как «Компания»,
// ревью №9). Скрытый филиал, своё здание главного и филиал-установка — без этого.
// ===========================================================================
const HALF = { id: 5, name: 'Юнусабад', country_code: 'UZ', region_code: 'tashkent-city', district_code: '', street_ru: 'ул. Мира, 1' };
const stars = (root) => ['Город / область', 'Район'].map((l) => labelText(fieldBox(root, l).children.find((c) => c.tagName === 'LABEL')).includes('*'));
async function withApiOn(on, fn) {
    const prev = globalThis.window.CLINIC.api_address_required;
    globalThis.window.CLINIC.api_address_required = on;
    try { await fn(); } finally { globalThis.window.CLINIC.api_address_required = prev; }
}

test('подключение включено, филиал на сайте: звёздочки и строка; без района — объяснение под полем, записи нет', async () => {
    await withApiOn(true, async () => {
        const { root } = await openPage(HALF);
        assert.deepEqual(stars(root), [true, true]);
        assert.match(textOf(root), /Пока включены подключения API, адрес для партнёров обязателен/);
        type(triInput(root, 'Название филиала', 'en'), 'Yunusabad');
        await save(root);
        assert.equal(writes.length, 0, 'филиал на сайте без района ушёл на сервер');
        assert.ok(fieldError(root, 'Район'), 'нет объяснения под «Район»');
    });
});

test('подключение включено: снятая отметка «Показывать на сайте» снимает звёздочки, и скрыть можно без адреса', async () => {
    await withApiOn(true, async () => {
        const { root } = await openPage(HALF);
        const pub = fieldInput(root, 'Показывать филиал на сайте и у партнёров');
        pub.checked = false; pub.dispatchEvent({ type: 'change', target: pub });
        assert.deepEqual(stars(root), [false, false], 'звёздочки у скрытого филиала');
        await save(root);
        assert.deepEqual(writes[0] && writes[0].values, { show_public: 0 });
    });
});

test('подключение включено, филиал скрыт: звёздочек нет; отметка «Показывать на сайте» их ставит', async () => {
    await withApiOn(true, async () => {
        const { root } = await openPage({ ...HALF, show_public: 0 });
        assert.deepEqual(stars(root), [false, false]);
        type(triInput(root, 'Название филиала', 'en'), 'Yunusabad');
        await save(root);
        assert.equal(writes.length, 1, 'скрытый филиал не проверяется');
        const pub = fieldInput(root, 'Показывать филиал на сайте и у партнёров');
        pub.checked = true; pub.dispatchEvent({ type: 'change', target: pub });
        assert.deepEqual(stars(root), [true, true]);
    });
});

test('подключений нет — звёздочек нет, филиал без района сохраняется (как в шаге 4)', async () => {
    await withApiOn(false, async () => {
        const { root } = await openPage(HALF);
        assert.deepEqual(stars(root), [false, false]);
        type(triInput(root, 'Название филиала', 'en'), 'Yunusabad');
        await save(root);
        assert.equal(writes.length, 1);
    });
});

test('своё здание главного и филиал-установка: адрес только виден — звёздочек нет и при включённом подключении', async () => {
    await withApiOn(true, async () => {
        const own = await openPage({ ...HALF, id: 1, name: 'Главный корпус' }, { own: true, company: { country_code: 'UZ', region_code: '', district_code: '', street_ru: '' } });
        assert.deepEqual(stars(own.root), [false, false], 'своё здание главного проверяется только через «Компанию»');
        const sec = await openPage(HALF, { secondary: true });
        assert.deepEqual(stars(sec.root), [false, false], 'в филиале-установке правило не действует');
    });
});

test('флаг устарел (выключен): отказ сервера partner_address_required — ошибка под полем, фокус, звёздочки, флаг включён', async () => {
    await withApiOn(false, async () => {
        const { root } = await openPage(HALF);
        const realFetch = globalThis.fetch;
        const msg = 'Пока включены подключения API, у здания, которое показывается на сайте, адрес для партнёров обязателен: город или область, район и улица на русском. Заполните его или снимите «Показывать филиал на сайте и у партнёров».';
        globalThis.fetch = async (url, opts) => (String(url).startsWith('/api/db') && JSON.parse(opts.body || '{}').op === 'update'
            ? { ok: false, status: 400, json: async () => ({ error: { code: 'partner_address_required', message: msg, field: 'district_code' } }) }
            : realFetch(url, opts));
        try {
            type(triInput(root, 'Название филиала', 'en'), 'Yunusabad');
            await save(root);
            assert.equal(globalThis.window.CLINIC.api_address_required, true, 'флаг не исправлен');
            assert.ok(fieldError(root, 'Район'), 'нет ошибки под «Район»');
            assert.deepEqual(stars(root), [true, true], 'звёздочки не появились');
        } finally { globalThis.fetch = realFetch; }
    });
});
