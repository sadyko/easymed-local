// CLINIC_PROFILE_V1 — каскад «Страна → Регион → Район» — один модуль на
// программу (views/geo-cascade.js). Окно заведения пациента хранит ИМЕНА
// (как всегда), «Компания» — КОДЫ справочника (партнёры получают коды).
//
// Что закреплено:
//   * режим кодов: значения списков — коды мигр. 132; строки без кода (их
//     завела клиника в «Географии») не предлагаются; выбор по сохранённым
//     кодам; selected() отдаёт строки справочника целиком (name_uz для
//     адреса партнёрам); onChange зовётся с теми же строками;
//   * режим имён (по умолчанию) — регистрация как была: значения — русские
//     имена, строка без кода предложена;
//   * регион выбран, район ещё нет — в «Компании» районы всё равно загружены;
//   * чужой ответ /api/db (объект вместо массива) — пустые списки, а не
//     исключение.
//
// Поддельный DOM — из clinic-brand.test.mjs; язык 'ru' — ДО импорта видов.

import { test } from 'node:test';
import assert from 'node:assert/strict';

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
globalThis.Event = class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } };
globalThis.document = {
    createElement: mkEl, createElementNS: (_n, t) => mkEl(t), createTextNode: (t) => new FakeText(t),
    head: mkEl('head'), body: mkEl('body'), documentElement: mkEl('html'),
    addEventListener() {}, removeEventListener() {}, getElementById() { return null; },
};
const store = new Map();
globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    clear: () => store.clear(),
};
// I18N_LOCALE_PIN_V1 — до импорта видов: i18n.js выбирает язык при загрузке.
globalThis.localStorage.setItem('admin.lang', 'ru');
globalThis.window = { location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, addEventListener() {}, easymed: { state: { user: null } } };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();

// ---- поддельный /api/db: справочник географии с фильтрами ---------------------
const GEO = {
    countries: [{ id: 1, name: 'Узбекистан', name_uz: 'O‘zbekiston', name_en: 'Uzbekistan', code: 'UZ', active: 1 },
                { id: 2, name: 'Казахстан', name_uz: 'Qozog‘iston', name_en: 'Kazakhstan', code: 'KZ', active: 1 },
                { id: 9, name: 'Своя страна', name_uz: null, name_en: null, code: null, active: 1 }],
    regions:   [{ id: 14, country_id: 1, name: 'город Ташкент', name_uz: 'Toshkent shahri', name_en: 'Tashkent city', code: 'tashkent-city', active: 1 }],
    districts: [{ id: 101, region_id: 14, name: 'Юнусабадский район', name_uz: 'Yunusobod tumani', name_en: 'Yunusabad district', code: 'yunusobod', active: 1 },
                { id: 102, region_id: 14, name: 'Свой район', code: null, active: 1 }],
};
let answerWithObject = false;
const calls = [];
globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u === '/api/db') {
        const desc = opts && opts.body ? JSON.parse(opts.body) : {};
        calls.push(desc);
        // Чужой ответ: поддельный сервер settings-split отдаёт строку doc_settings на любой /api/db.
        if (answerWithObject) return { ok: true, status: 200, json: async () => ({ data: { id: 1, clinic_name: 'Шифо' } }) };
        let rows = (GEO[desc.table] || []).slice();
        for (const f of desc.filters || []) {
            if (f.col === 'active') continue;
            rows = rows.filter((r) => String(r[f.col]) === String(f.val));
        }
        return { ok: true, status: 200, json: async () => ({ data: rows }) };
    }
    return { ok: true, status: 200, json: async () => ({ data: null }) };
};

const { geoCascade } = await import('../views/geo-cascade.js');
const { geoCascade: viaModal } = await import('../views/patient-create-modal.js');

const values = (sel) => sel.options.map((o) => o.attrs.value);
const chosen = (sel) => { const o = sel.options[sel.selectedIndex]; return o ? o.attrs.value : null; };

test('режим кодов: значения — коды справочника, строки без кода не предлагаются, выбор по сохранённым кодам', async () => {
    answerWithObject = false;
    const seen = [];
    const geo = geoCascade({ by: 'code', onChange: (sel) => seen.push(sel) });
    geo.preset({ country: 'UZ', region: 'tashkent-city', district: 'yunusobod' });
    await geo.ready;

    assert.deepEqual(values(geo.countrySel), ['', 'KZ', 'UZ'], '«Своя страна» без кода не предложена');
    assert.equal(chosen(geo.countrySel), 'UZ');
    assert.equal(chosen(geo.regionSel), 'tashkent-city');
    assert.equal(chosen(geo.districtSel), 'yunusobod');
    assert.deepEqual(values(geo.districtSel), ['', 'yunusobod'], '«Свой район» без кода не предложен');

    const s = geo.selected();
    assert.equal(s.country.code, 'UZ');
    assert.equal(s.region.name_uz, 'Toshkent shahri');
    assert.equal(s.district.name_uz, 'Yunusobod tumani');
    assert.ok(seen.length >= 1, 'onChange вызван');
    const last = seen[seen.length - 1];
    assert.deepEqual([last.country.code, last.region.code, last.district.code], ['UZ', 'tashkent-city', 'yunusobod']);
    for (const d of calls.filter((c) => c.table === 'countries' || c.table === 'regions' || c.table === 'districts')) {
        assert.match(String(d.columns), /\bcode\b/, d.table + ': в режиме кодов код запрошен');
    }
});

test('режим по умолчанию (имена): регистрация как была — русские имена, строка без кода предложена', async () => {
    answerWithObject = false;
    calls.length = 0;
    const geo = geoCascade();
    geo.preset({ country: 'Узбекистан', region: 'город Ташкент', district: 'Юнусабадский район' });
    await geo.ready;
    assert.deepEqual(values(geo.countrySel), ['', 'Казахстан', 'Своя страна', 'Узбекистан']);
    assert.equal(chosen(geo.countrySel), 'Узбекистан');
    assert.equal(chosen(geo.regionSel), 'город Ташкент');
    assert.equal(chosen(geo.districtSel), 'Юнусабадский район');
    assert.deepEqual(values(geo.districtSel), ['', 'Свой район', 'Юнусабадский район']);
    for (const d of calls) assert.doesNotMatch(String(d.columns), /\bcode\b/, 'режим имён кодов не просит');
});

test('регион выбран, район ещё нет — в режиме кодов районы всё равно загружены', async () => {
    answerWithObject = false;
    const geo = geoCascade({ by: 'code' });
    geo.preset({ country: 'UZ', region: 'tashkent-city' });
    await geo.ready;
    assert.equal(chosen(geo.regionSel), 'tashkent-city');
    assert.deepEqual(values(geo.districtSel), ['', 'yunusobod'], 'пустая + yunusobod');
    assert.equal(geo.selected().district, null, 'район не выбран');
});

test('страна по умолчанию в режиме кодов — UZ', async () => {
    answerWithObject = false;
    const geo = geoCascade({ by: 'code' });
    await geo.ready;
    assert.equal(chosen(geo.countrySel), 'UZ');
    assert.deepEqual(values(geo.regionSel), ['', 'tashkent-city'], 'регионы страны по умолчанию загружены');
});

test('/api/db отвечает объектом вместо массива — списки пустые, исключения нет', async () => {
    answerWithObject = true;
    try {
        const geo = geoCascade({ by: 'code' });
        geo.preset({ country: 'UZ', region: 'tashkent-city', district: 'yunusobod' });
        await geo.ready;
        assert.deepEqual(values(geo.countrySel), [''], 'только подсказка');
        assert.deepEqual(values(geo.regionSel), ['']);
        assert.deepEqual(values(geo.districtSel), ['']);
        assert.deepEqual(geo.selected(), { country: null, region: null, district: null });
    } finally { answerWithObject = false; }
});

test('окно пациента отдаёт тот же каскад по прежнему адресу', () => {
    assert.equal(viaModal, geoCascade, 'patient-create-modal.js реэкспортирует geoCascade из geo-cascade.js');
});
