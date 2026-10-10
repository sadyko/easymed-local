// CLINIC_PROFILE_V1 — экран «Компания» как профиль клиники (шаг 3 API клиники,
// план docs/plans/2026-10-10-clinic-api-3-company-profile.md, задачи 10–13).
//
// Что проверяется вживую, на поддельном DOM и поддельном сервере:
//   * названия и описание на трёх языках; сайт, Telegram, Instagram — с
//     проверкой формата до отправки и нормализацией (ссылка → @имя);
//   * сохранение шлёт ровно колонки «Компании» (COMPANY_COLUMNS) — настройки
//     печатного шаблона и lab_scope не трогаются;
//   * адрес для партнёров — списками справочника (коды) и улицей на трёх
//     языках; «Адрес в документах» — прежнее поле, вписанное руками: списки
//     его не меняют (ответ владельца 2026-10-10, вариант B);
//   * карта и маршрут; два логотипа; «Как это увидят пациенты».
//
// Поддельный DOM — из clinic-brand.test.mjs (у него есть options /
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
                { id: 2, name: 'Казахстан', name_uz: 'Qozog‘iston', name_en: 'Kazakhstan', code: 'KZ', active: 1 },
                { id: 9, name: 'Своя страна', name_uz: null, name_en: null, code: null, active: 1 }],
    regions:   [{ id: 14, country_id: 1, name: 'город Ташкент', name_uz: 'Toshkent shahri', name_en: 'Tashkent city', code: 'tashkent-city', active: 1 }],
    districts: [{ id: 101, region_id: 14, name: 'Юнусабадский район', name_uz: 'Yunusobod tumani', name_en: 'Yunusabad district', code: 'yunusobod', active: 1 },
                { id: 102, region_id: 14, name: 'Свой район', name_uz: null, name_en: null, code: null, active: 1 }],
};

const { COMPANY_COLUMNS } = await import('../../shared/clinic-profile.js');

let docRow;
let lastUpdate;
let uploads;
let nextStorageError = null;   // { status, error } — отказ хранилища на следующую загрузку
let failNextDocSelect = false; // CLINIC_PROFILE_V1 (ревью C1) — чтение doc_settings отвечает 503 (сервер перезапускается)
let geoTables = GEO;           // CLINIC_PROFILE_V1 (ревью I1) — справочник подменяется на «настоящие» id
// Строка doc_settings после миграции 240: прежние поля заполнены, новые пусты.
function freshRow(extra = {}) {
    const row = { id: 1, paper_size: 'A5', show_watermark: 1, footer_note: 'Спасибо за визит.', legal_note: 'Электронный документ.', lab_scope: 'building' };
    for (const c of COMPANY_COLUMNS) row[c] = '';
    Object.assign(row, {
        clinic_name: 'Клиника «Шифо»', address: 'Ташкент, ул. Мира 1', phone: '+998 71 200 12 00',
        email: 'info@shifo.uz', license: 'LIC-1', accent_color: '#167873',
    }, extra);
    return row;
}

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.startsWith('/api/rpc/get_clinic_by_slug')) return ok({ data: globalThis.window.CLINIC });
    if (u.startsWith('/api/rpc/')) return ok({ data: null });
    if (u.startsWith('/api/storage/')) {
        if (nextStorageError) {
            const { status, error } = nextStorageError; nextStorageError = null;
            return { ok: false, status, json: async () => ({ error }) };
        }
        uploads.push({ url: u, type: (opts.headers || {})['Content-Type'], method: opts.method });
        return ok({ data: { path: u } });
    }
    if (u.startsWith('/api/db')) {
        let desc = {};
        try { desc = JSON.parse(opts.body || '{}'); } catch (_) { /* пусто */ }
        const op = desc.op || 'select';
        if (desc.table === 'doc_settings') {
            if (op === 'select' && failNextDocSelect) {
                failNextDocSelect = false;
                return { ok: false, status: 503, json: async () => ({ error: { code: 'unavailable', message: 'server restarting' } }) };
            }
            if (op === 'update') { lastUpdate = desc.values; docRow = { ...docRow, ...desc.values }; }
            return ok({ data: { ...docRow } });
        }
        if (geoTables[desc.table]) {
            let rows = geoTables[desc.table].filter((r) => r.active);
            for (const f of desc.filters || []) {
                if (f.op === 'eq' && f.col !== 'active') rows = rows.filter((r) => String(r[f.col]) === String(f.val));
            }
            return ok({ data: rows.map((r) => ({ ...r })) });
        }
        return ok({ data: op === 'select' ? [] : null, count: 0 });
    }
    return ok({});
};

const { renderDocumentsSettings } = await import('../views/documents-settings.js');
const { logoDeps } = await import('../views/company-logos.js');
const { fakePng } = await import('../../../../server/test-helpers/fake-png.js');
// В поддельном DOM нет canvas: печатная копия — подставная, время — постоянное.
const PRINT_COPY = 'data:image/png;base64,UFJJTlQ=';
logoDeps.printCopy = async () => PRINT_COPY;
logoDeps.now = () => 1760000000000;

// ===========================================================================
// Помощники
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
/** Текст видимой ошибки под полем label. */
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

async function open(extra = {}) {
    docRow = freshRow(extra);
    lastUpdate = null;
    uploads = [];
    const t = document.getElementById('toast'); if (t) t.textContent = '';
    const root = mkEl('div');
    await renderDocumentsSettings(root, { onNavigate: () => {} });
    await settle(80);
    return root;
}

// ===========================================================================
// Задача 10 — названия и описание на трёх языках, сайт и соцсети
// ===========================================================================

test('названия RU / UZ / EN показывают clinic_name / name_uz / name_en; UZ, EN и описание уходят на сервер', async () => {
    const root = await open({ name_uz: 'Shifo eski', name_en: '' });
    assert.equal(triInput(root, 'Название клиники', 'ru').value, 'Клиника «Шифо»');
    assert.equal(triInput(root, 'Название клиники', 'uz').value, 'Shifo eski');
    assert.equal(triInput(root, 'Название клиники', 'en').value, '');

    type(triInput(root, 'Название клиники', 'uz'), 'Shifo');
    type(triInput(root, 'Название клиники', 'en'), 'Shifo Clinic');
    const about = triInput(root, 'Коротко о клинике', 'ru');
    assert.equal(about.tagName, 'TEXTAREA', 'описание — многострочное поле');
    type(about, 'Семейная клиника.');
    await save(root);

    assert.ok(lastUpdate, 'запрос на сохранение не ушёл');
    assert.equal(lastUpdate.name_uz, 'Shifo');
    assert.equal(lastUpdate.name_en, 'Shifo Clinic');
    assert.equal(lastUpdate.about_ru, 'Семейная клиника.');
    assert.ok(!('clinic_name' in lastUpdate), 'RU-название не меняли — не шлётся');
    assert.equal(docRow.clinic_name, 'Клиника «Шифо»', 'RU-название — то, что печатается, — не тронуто');
});

test('сайт без https://, ссылки t.me и instagram.com — сохраняются как https://… и @имя', async () => {
    const root = await open();
    type(fieldInput(root, 'Сайт'), 'shifo.uz');
    type(fieldInput(root, 'Telegram-бот'), 'https://t.me/shifo_clinic_bot');
    type(fieldInput(root, 'Instagram'), 'https://instagram.com/shifo.uz/');
    await save(root);

    assert.ok(lastUpdate, 'запрос на сохранение не ушёл');
    assert.equal(lastUpdate.website, 'https://shifo.uz');
    assert.equal(lastUpdate.telegram_bot, '@shifo_clinic_bot');
    assert.equal(lastUpdate.instagram, '@shifo.uz');
    assert.equal(fieldInput(root, 'Сайт').value, 'https://shifo.uz', 'после сохранения поле показывает то, что записано');
});

test('Telegram-бот без «bot» в конце — запрос не уходит, под полем объяснение', async () => {
    const root = await open();
    type(fieldInput(root, 'Telegram-бот'), '@shifo');
    await save(root);

    assert.equal(lastUpdate, null, 'неверное имя бота не должно уйти на сервер');
    assert.match(fieldError(root, 'Telegram-бот'), /Имя Telegram-бота заканчивается на «bot»/);
    assert.match(toastText(), /Проверьте выделенные поля/);

    // Исправили — ошибка уходит, сохранение проходит.
    type(fieldInput(root, 'Telegram-бот'), '@shifo_bot');
    assert.equal(fieldError(root, 'Telegram-бот'), '', 'исправленное поле не должно оставаться красным');
    await save(root);
    assert.equal(lastUpdate && lastUpdate.telegram_bot, '@shifo_bot');
});

// CLINIC_PROFILE_V1 (ревью C1) — сохранение шлёт только то, что изменилось
// относительно прочитанной строки: нетронутое поле не может быть затёрто.
test('сохранение шлёт только изменённые колонки «Компании»; адрес, вписанный руками, — как был', async () => {
    const root = await open({ logo_data_url: null });
    type(fieldInput(root, 'Электронная почта'), 'hello@shifo.uz');
    type(fieldInput(root, 'Номер лицензии'), 'LIC-2');
    await save(root);

    assert.ok(lastUpdate, 'запрос на сохранение не ушёл');
    assert.deepEqual(Object.keys(lastUpdate).sort(), ['email', 'license']);
    for (const c of Object.keys(lastUpdate)) assert.ok(COMPANY_COLUMNS.includes(c), c + ' — колонка «Компании»');
    assert.ok(!Object.values(lastUpdate).includes(null), 'null база отклоняет (NOT NULL)');
    assert.equal(docRow.address, 'Ташкент, ул. Мира 1');
    assert.equal(docRow.paper_size, 'A5', 'настройки печати в базе не тронуты');
    assert.equal(docRow.lab_scope, 'building');
});

test('нетронутое сохранение ничего не шлёт — «Нет изменений»', async () => {
    const extra = { name_uz: 'Shifo', name_en: 'Shifo Clinic', about_ru: 'о', website: 'https://shifo.uz', telegram_bot: '@shifo_clinic_bot',
        instagram: '@shifo.uz', logo_data_url: 'data:image/png;base64,TEVHQUNZ', street_ru: 'ул. Мира 1', country_code: 'UZ',
        region_code: 'tashkent-city', district_code: 'yunusobod', maps_url: 'https://yandex.uz/maps/-/CDabc' };
    const root = await open(extra);
    const before = { ...docRow };
    await save(root);
    assert.equal(lastUpdate, null, 'нечего сохранять — запроса нет');
    assert.match(toastText(), /Нет изменений/);
    assert.deepEqual(docRow, before);

    // Прежняя клиника без кодов: страна по умолчанию (UZ) в списке — ещё не изменение.
    const root2 = await open();
    await save(root2);
    assert.equal(lastUpdate, null);
    assert.equal(docRow.country_code, '');
});

// CLINIC_PROFILE_V1 (ревью C1, R1) — чтение строки не удалось (сервер
// перезапускается): экран показывает значения по умолчанию, и «Сохранить»
// записало бы их поверх всей «Компании» — а синхронизация унесла бы это в филиалы.
test('ревью R1: строка не прочиталась — «Сохранить» выключено, объяснение; ничего не уходит', async () => {
    failNextDocSelect = true;
    const root = await open({ name_uz: 'Shifo', website: 'https://shifo.uz', logo_data_url: 'data:image/png;base64,TEVHQUNZ', street_ru: 'ул. 1' });
    const before = { ...docRow };
    const btn = buttonByText(root, /^Сохранить$/);
    assert.ok(btn.disabled === true || btn.attrs.disabled !== undefined, '«Сохранить» выключено');
    assert.match(textOf(root), /Не удалось загрузить данные компании — обновите страницу, чтобы сохранить/);
    type(fieldInput(root, 'Электронная почта'), 'x@y.uz');
    await save(root);   // даже если клик дошёл
    assert.equal(lastUpdate, null, 'значения по умолчанию не должны лечь поверх строки');
    assert.deepEqual(docRow, before);
});

// ===========================================================================
// Задача 12 — два логотипа
// ===========================================================================
const logoTile = (root, title) => descendants(root).find((n) => matches(n, '.cpf-logo')
    && labelText(n.children.find((c) => c.tagName === 'B')) === title) || null;
function fileOf(buf, name = 'logo.png', type = 'image/png') {
    return { name, type, size: buf.length, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) };
}
async function pick(root, title, file) {
    const tile = logoTile(root, title);
    assert.ok(tile, 'нет плитки «' + title + '»');
    const input = descendants(tile).find((n) => n.tagName === 'INPUT' && n.attrs.type === 'file');
    assert.ok(input, 'у плитки «' + title + '» нет выбора файла');
    assert.equal(input.attrs.accept, 'image/png');
    input.files = [file];
    input.dispatchEvent({ type: 'change', target: input, currentTarget: input });
    await settle(40);
}
const tileImg = (root, title) => descendants(logoTile(root, title)).find((n) => n.tagName === 'IMG') || null;
const SQ_PATH = /^square\/1760000000000-[a-z0-9]{6}\.png$/;
const PT_PATH = /^portrait\/1760000000000-[a-z0-9]{6}\.png$/;

test('прежний логотип (data URL) без квадратного — в квадратной плитке, с пометкой', async () => {
    const root = await open({ logo_data_url: 'data:image/png;base64,T0xE' });
    const img = tileImg(root, 'Квадратный, 1:1');
    assert.ok(img, 'прежний логотип не показан');
    assert.equal(img.attrs.src, 'data:image/png;base64,T0xE');
    assert.match(textOf(logoTile(root, 'Квадратный, 1:1')), /Прежний логотип — печатается, пока не загружен квадратный/);
    assert.match(textOf(logoTile(root, 'Вертикальный')), /Нет файла/);
});

test('квадратный PNG: файл — в clinic-logos/square/…, печатная копия — в logo_data_url', async () => {
    const root = await open({ logo_data_url: 'data:image/png;base64,T0xE' });
    await pick(root, 'Квадратный, 1:1', fileOf(fakePng(512, 512)));

    assert.equal(uploads.length, 1, 'файл не загружен');
    assert.match(uploads[0].url, /^\/api\/storage\/clinic-logos\/square\/1760000000000-[a-z0-9]{6}\.png$/);
    assert.equal(uploads[0].type, 'image/png');
    assert.equal(uploads[0].method, 'POST');
    assert.match(tileImg(root, 'Квадратный, 1:1').attrs.src, /^\/api\/storage\/clinic-logos\/square\//, 'плитка показывает загруженный файл');
    assert.doesNotMatch(textOf(logoTile(root, 'Квадратный, 1:1')), /Прежний логотип/);

    await save(root);
    assert.match(lastUpdate.logo_square_path, SQ_PATH);
    assert.equal('/api/storage/clinic-logos/' + lastUpdate.logo_square_path, uploads[0].url, 'путь в строке — тот, что загружен');
    assert.equal(lastUpdate.logo_data_url, PRINT_COPY, 'печатная копия заменила прежний логотип');
    assert.ok(!('logo_portrait_path' in lastUpdate), 'вертикальный не меняли — не шлётся');
    assert.equal(docRow.logo_portrait_path, '');
});

test('JPG, непрозрачный PNG, не квадрат — загрузки нет, понятный отказ, строка не меняется', async () => {
    const cases = [
        [fileOf(fakePng(512, 512), 'logo.jpg', 'image/jpeg'), /Логотип — только PNG с прозрачным фоном/],
        [fileOf(fakePng(512, 512, { colorType: 2 })), /У этого PNG нет прозрачности/],
        [fileOf(fakePng(600, 500)), /Квадратный логотип 600×500 px — стороны должны быть равны/],
        [fileOf(fakePng(200, 200)), /Логотип 200×200 px\. Нужно от 256 до 2048 px/],
    ];
    for (const [file, msg] of cases) {
        const root = await open();
        await pick(root, 'Квадратный, 1:1', file);
        assert.equal(uploads.length, 0, file.name + ': отказ на экране — до загрузки');
        assert.match(toastText(), msg);
        await save(root);
        assert.equal(lastUpdate, null, 'отказ ничего не меняет — сохранять нечего');
        assert.equal(docRow.logo_square_path, '');
        assert.equal(docRow.logo_data_url, '');
    }
});

test('вертикальный PNG: свой путь portrait/…; печатная копия не меняется', async () => {
    const root = await open({ logo_data_url: 'data:image/png;base64,T0xE' });
    await pick(root, 'Вертикальный', fileOf(fakePng(600, 800)));
    assert.equal(uploads.length, 1);
    assert.match(uploads[0].url, /^\/api\/storage\/clinic-logos\/portrait\//);
    await save(root);
    assert.match(lastUpdate.logo_portrait_path, PT_PATH);
    assert.deepEqual(Object.keys(lastUpdate), ['logo_portrait_path'], 'печатная копия и квадратный не шлются');
    assert.equal(docRow.logo_data_url, 'data:image/png;base64,T0xE', 'прежний логотип печатается дальше');
    assert.equal(docRow.logo_square_path, '');

    const root2 = await open();
    await pick(root2, 'Вертикальный', fileOf(fakePng(800, 800)));
    assert.equal(uploads.length, 0, 'квадрат в вертикальную плитку не грузится');
    assert.match(toastText(), /высота должна быть больше ширины/);
});

test('«Удалить»: квадратный снимается с бланков вместе с копией; вертикальный — только свой путь', async () => {
    const both = { logo_square_path: 'square/1-a.png', logo_portrait_path: 'portrait/1-b.png', logo_data_url: PRINT_COPY };
    let root = await open(both);
    let del = buttonByText(logoTile(root, 'Квадратный, 1:1'), /Удалить/);
    assert.ok(del, 'у загруженного квадратного нет «Удалить»');
    del.click();
    assert.match(textOf(logoTile(root, 'Квадратный, 1:1')), /Нет файла/);
    await save(root);
    assert.equal(lastUpdate.logo_square_path, '');
    assert.equal(lastUpdate.logo_data_url, '', 'копия на бланках тоже снята');
    assert.ok(!('logo_portrait_path' in lastUpdate));
    assert.equal(docRow.logo_portrait_path, 'portrait/1-b.png');

    root = await open(both);
    buttonByText(logoTile(root, 'Вертикальный'), /Удалить/).click();
    await save(root);
    assert.deepEqual(lastUpdate, { logo_portrait_path: '' });
    assert.equal(docRow.logo_square_path, 'square/1-a.png');
    assert.equal(docRow.logo_data_url, PRINT_COPY);
    assert.equal(uploads.length, 0, '«Удалить» не трогает хранилище');
});

test('печатная копия больше 90 000 знаков — загрузки нет, объяснение', async () => {
    const saved = logoDeps.printCopy;
    logoDeps.printCopy = async () => 'data:image/png;base64,' + 'A'.repeat(90001);
    try {
        const root = await open();
        await pick(root, 'Квадратный, 1:1', fileOf(fakePng(512, 512)));
        assert.equal(uploads.length, 0);
        assert.match(toastText(), /Не удалось подготовить логотип для печати/);
    } finally { logoDeps.printCopy = saved; }
});

test('отказ хранилища с шаблоном — переведён в тосте; строка не меняется', async () => {
    const root = await open();
    nextStorageError = { status: 415, error: { code: 'logo_not_transparent', message: 'raw',
        template: 'У этого PNG нет прозрачности: фон будет виден белым прямоугольником. Сохраните логотип с прозрачным фоном.', params: {} } };
    await pick(root, 'Квадратный, 1:1', fileOf(fakePng(512, 512)));
    assert.match(toastText(), /^Не удалось загрузить логотип: У этого PNG нет прозрачности/);
    await save(root);
    assert.equal(lastUpdate, null, 'отказ ничего не меняет — сохранять нечего');
    assert.equal(docRow.logo_square_path, '');
    assert.equal(docRow.logo_data_url, '');
});

// ===========================================================================
// Задача 11 — адрес для партнёров и сайта (списки, улица), «Адрес в
// документах» (вписан руками, печатается), карта и маршрут.
// Ответ владельца 2026-10-10 (вариант B): бланки печатают поле, вписанное
// руками; списки его не меняют; кнопки «Собрать из списков» нет.
// ===========================================================================
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

test('новая клиника: списки и улица — коды и полный адрес на трёх языках; «Адрес в документах» не собирается', async () => {
    const root = await open({ address: '' });
    assert.deepEqual(geoSel(root, 'Страна').options.map((o) => o.attrs.value), ['', 'KZ', 'UZ'], 'страны без кода не предлагаются');
    assert.equal(selectedValue(geoSel(root, 'Страна')), 'UZ', 'страна по умолчанию — Узбекистан');

    await choose(geoSel(root, 'Город / область'), 'tashkent-city');
    await choose(geoSel(root, 'Район'), 'yunusobod');
    type(triInput(root, 'Улица, дом', 'ru'), 'ул. Амира Темура, 12');
    type(triInput(root, 'Улица, дом', 'uz'), 'Amir Temur ko‘chasi, 12');

    assert.equal(fullAddr(root, 'ru'), 'город Ташкент, Юнусабадский район, ул. Амира Темура, 12');
    assert.equal(fullAddr(root, 'uz'), 'Toshkent shahri, Yunusobod tumani, Amir Temur ko‘chasi, 12');
    assert.equal(fullAddr(root, 'en'), 'Tashkent city, Yunusabad district, ул. Амира Темура, 12', 'улицы на EN нет — русская');
    assert.equal(fullAddr(root, 'codes'), 'UZ · tashkent-city · yunusobod');
    assert.equal(fieldInput(root, 'Адрес в документах').value, '', 'списки в адрес для бланка ничего не собирают');

    await save(root);
    assert.ok(lastUpdate, 'запрос на сохранение не ушёл');
    assert.equal(lastUpdate.country_code, 'UZ');
    assert.equal(lastUpdate.region_code, 'tashkent-city');
    assert.equal(lastUpdate.district_code, 'yunusobod');
    assert.equal(lastUpdate.street_ru, 'ул. Амира Темура, 12');
    assert.equal(lastUpdate.street_uz, 'Amir Temur ko‘chasi, 12');
    assert.ok(!('street_en' in lastUpdate) && !('address' in lastUpdate), 'нетронутое не шлётся');
    assert.equal(docRow.address, '', 'адрес для бланка — только то, что вписано руками');
    assert.ok(!('address_manual' in lastUpdate), 'отметки «вписан вручную» нет');
});

test('сохранённые коды выбраны в списках после открытия; повторное сохранение их не теряет', async () => {
    const root = await open({ country_code: 'UZ', region_code: 'tashkent-city', district_code: 'yunusobod', street_ru: 'ул. Мира 1' });
    assert.equal(selectedValue(geoSel(root, 'Страна')), 'UZ');
    assert.equal(selectedValue(geoSel(root, 'Город / область')), 'tashkent-city');
    assert.equal(selectedValue(geoSel(root, 'Район')), 'yunusobod');
    assert.deepEqual(geoSel(root, 'Район').options.map((o) => o.attrs.value), ['', 'yunusobod'], 'районы без кода не предлагаются');
    assert.equal(fullAddr(root, 'ru'), 'город Ташкент, Юнусабадский район, ул. Мира 1');
    assert.equal(triInput(root, 'Улица, дом', 'ru').value, 'ул. Мира 1');
    type(triInput(root, 'Улица, дом', 'uz'), 'Tinchlik ko‘chasi, 1');
    await save(root);
    assert.deepEqual(lastUpdate, { street_uz: 'Tinchlik ko‘chasi, 1' }, 'коды не трогали — не шлются');
    assert.equal(docRow.region_code, 'tashkent-city');
    assert.equal(docRow.district_code, 'yunusobod');
    assert.equal(docRow.street_ru, 'ул. Мира 1');
});

test('прежняя клиника без кодов: сохранение без правок проходит, адрес для бланка — как был', async () => {
    const root = await open();
    assert.equal(fieldInput(root, 'Адрес в документах').value, 'Ташкент, ул. Мира 1');
    type(fieldInput(root, 'Электронная почта'), 'hello@shifo.uz');
    await save(root);
    assert.ok(lastUpdate, 'пустой адрес для партнёров не должен останавливать сохранение');
    assert.deepEqual(lastUpdate, { email: 'hello@shifo.uz' });
    assert.equal(docRow.address, 'Ташкент, ул. Мира 1');
    assert.deepEqual([docRow.country_code, docRow.region_code, docRow.district_code, docRow.street_ru], ['', '', '', '']);
});

test('«Адрес в документах» и адрес для партнёров независимы; «Собрать из списков» нет', async () => {
    const root = await open();
    type(fieldInput(root, 'Адрес в документах'), 'Ташкент, Юнусабад-4');
    assert.equal(fullAddr(root, 'ru'), '—', 'вписанный адрес для бланка не идёт партнёрам');

    await choose(geoSel(root, 'Город / область'), 'tashkent-city');
    await choose(geoSel(root, 'Район'), 'yunusobod');
    type(triInput(root, 'Улица, дом', 'ru'), 'ул. Амира Темура, 12');
    assert.equal(fieldInput(root, 'Адрес в документах').value, 'Ташкент, Юнусабад-4', 'списки не переписали адрес для бланка');
    assert.equal(buttonByText(root, /Собрать из списков/), null);
    assert.doesNotMatch(textOf(root), /Вписан вручную/);

    await save(root);
    assert.equal(lastUpdate.address, 'Ташкент, Юнусабад-4');
    assert.equal(lastUpdate.street_ru, 'ул. Амира Темура, 12');
});

test('начатый адрес доводится до конца: город / область, район, улица RU', async () => {
    const root = await open();
    type(triInput(root, 'Улица, дом', 'ru'), 'ул. Мира 1');
    await save(root);
    assert.equal(lastUpdate, null, 'адрес без города не должен уйти партнёрам');
    assert.equal(fieldError(root, 'Город / область'), 'Выберите город или область.');

    await choose(geoSel(root, 'Город / область'), 'tashkent-city');
    assert.equal(fieldError(root, 'Город / область'), '', 'выбранный город снимает ошибку');
    await save(root);
    assert.equal(lastUpdate, null);
    assert.equal(fieldError(root, 'Район'), 'Выберите район из списка.');

    await choose(geoSel(root, 'Район'), 'yunusobod');
    type(triInput(root, 'Улица, дом', 'ru'), '');
    type(triInput(root, 'Улица, дом', 'uz'), 'Tinchlik ko‘chasi, 1');
    await save(root);
    assert.equal(lastUpdate, null);
    assert.equal(triError(root, 'Улица, дом', 'ru'), 'Впишите улицу и дом на русском.');

    type(triInput(root, 'Улица, дом', 'ru'), 'ул. Мира 1');
    await save(root);
    assert.ok(lastUpdate, 'полный адрес сохраняется');
    assert.equal(lastUpdate.district_code, 'yunusobod');
});

test('карта: не Яндекс — объяснение и запроса нет; Яндекс с координатами — маршрут «от меня»', async () => {
    const root = await open();
    assert.match(textOf(routeDd(root)), /Появится, когда будет ссылка на карту/);
    const maps = fieldInput(root, 'Ссылка на клинику в Яндекс Картах');
    type(maps, 'https://maps.google.com/x');
    assert.match(textOf(routeDd(root)), /Появится, когда будет ссылка на карту/, 'по чужой ссылке маршрут не обещаем');
    await save(root);
    assert.equal(lastUpdate, null);
    assert.match(fieldError(root, 'Ссылка на клинику в Яндекс Картах'), /Нужна ссылка из Яндекс Карт/);

    const url = 'https://yandex.uz/maps/?ll=69.24%2C41.29&pt=69.24,41.29';
    type(maps, url);
    assert.equal(fieldError(root, 'Ссылка на клинику в Яндекс Картах'), '');
    const route = 'https://yandex.uz/maps/?rtext=~41.29,69.24&rtt=auto';
    const dd = routeDd(root);
    assert.ok(textOf(dd).includes(route), 'строка маршрута: ' + textOf(dd));
    const a = descendants(dd).find((n) => n.tagName === 'A');
    assert.ok(a, 'нет ссылки «Открыть маршрут»');
    assert.match(labelText(a), /Открыть маршрут/);
    assert.equal(a.attrs.href, route);
    assert.equal(a.attrs.target, '_blank');
    assert.match(a.attrs.rel, /noopener/);
    await save(root);
    assert.equal(lastUpdate.maps_url, url);
});

// ===========================================================================
// Задача 13 — «Как это увидят пациенты»: RU / UZ / EN, «Позвонить»,
// «Маршрут», Telegram, Instagram, сайт. Подписи — на языке предпросмотра.
// ===========================================================================
const preview = (root) => {
    const p = descendants(root).find((n) => matches(n, '.cpf-preview'));
    assert.ok(p, 'нет карточки «Как это увидят пациенты»');
    return p;
};
const previewName = (root) => textOf(descendants(preview(root)).find((n) => matches(n, '.cpf-pname')));
const previewSubs = (root) => descendants(preview(root)).filter((n) => matches(n, '.cpf-psub')).map(textOf);
const previewLinks = (root) => descendants(preview(root)).filter((n) => n.tagName === 'A')
    .map((a) => ({ text: labelText(a), href: a.attrs.href, target: a.attrs.target || '', rel: a.attrs.rel || '' }));
const langButton = (root, tag) => {
    const seg = descendants(root).find((n) => matches(n, '.segmented') && n.attrs['aria-label'] === 'Язык');
    assert.ok(seg, 'нет переключателя языка предпросмотра');
    return seg.children.find((b) => labelText(b) === tag);
};

test('предпросмотр на UZ: узбекское название, адрес из справочника, «Qo‘ng‘iroq qilish» набирает номер', async () => {
    const root = await open({ name_uz: 'Shifo', country_code: 'UZ', region_code: 'tashkent-city', district_code: 'yunusobod',
        street_ru: 'ул. Мира 1', street_uz: 'Tinchlik ko‘chasi, 1' });
    assert.equal(langButton(root, 'RU').attrs['aria-pressed'], 'true', 'по умолчанию — RU');
    assert.equal(previewName(root), 'Клиника «Шифо»');

    langButton(root, 'UZ').click();
    assert.equal(langButton(root, 'UZ').attrs['aria-pressed'], 'true');
    assert.equal(langButton(root, 'RU').attrs['aria-pressed'], 'false');
    assert.equal(preview(root).attrs.lang, 'uz');
    assert.equal(previewName(root), 'Shifo');
    assert.ok(previewSubs(root).includes('Toshkent shahri, Yunusobod tumani, Tinchlik ko‘chasi, 1'), previewSubs(root).join(' | '));
    const call = previewLinks(root).find((l) => l.text === 'Qo‘ng‘iroq qilish');
    assert.ok(call, 'нет кнопки «Qo‘ng‘iroq qilish»: ' + previewLinks(root).map((l) => l.text).join(', '));
    assert.equal(call.href, 'tel:+998712001200');

    type(triInput(root, 'Название клиники', 'uz'), 'Shifo Plus');
    assert.equal(previewName(root), 'Shifo Plus', 'предпросмотр следует за вводом');
});

test('предпросмотр на EN: без перевода — русское название; без описания — пометка; «Call»', async () => {
    const root = await open({ about_ru: 'Семейная клиника.' });
    langButton(root, 'EN').click();
    assert.equal(previewName(root), 'Клиника «Шифо»');
    assert.match(textOf(preview(root)), /Нет описания на этом языке — партнёры покажут русское\./);
    assert.ok(previewLinks(root).some((l) => l.text === 'Call' && l.href === 'tel:+998712001200'));

    langButton(root, 'RU').click();
    assert.match(textOf(preview(root)), /Семейная клиника\./);
});

test('кнопки-ссылки: без карты «Маршрута» нет; с картой, ботом, Instagram и сайтом — верные адреса', async () => {
    const root = await open();
    assert.deepEqual(previewLinks(root).map((l) => l.text), ['Позвонить']);

    const url = 'https://yandex.uz/maps/?ll=69.24%2C41.29&pt=69.24,41.29';
    type(fieldInput(root, 'Ссылка на клинику в Яндекс Картах'), url);
    type(fieldInput(root, 'Telegram-бот'), '@shifo');   // ещё не годится — кнопки нет
    type(fieldInput(root, 'Instagram'), 'https://instagram.com/shifo.uz/');
    type(fieldInput(root, 'Сайт'), 'shifo.uz');
    let links = previewLinks(root);
    assert.ok(!links.some((l) => l.text === '@shifo'), 'неверное имя бота — без кнопки');
    const route = links.find((l) => l.text === 'Маршрут');
    assert.ok(route, 'нет кнопки «Маршрут»');
    assert.equal(route.href, 'https://yandex.uz/maps/?rtext=~41.29,69.24&rtt=auto');
    assert.equal(route.target, '_blank');
    assert.match(route.rel, /noopener/);
    assert.equal(links.find((l) => l.text === '@shifo.uz').href, 'https://instagram.com/shifo.uz');
    assert.equal(links.find((l) => l.text === 'Сайт').href, 'https://shifo.uz');

    type(fieldInput(root, 'Telegram-бот'), 't.me/shifo_bot');
    links = previewLinks(root);
    assert.equal(links.find((l) => l.text === '@shifo_bot').href, 'https://t.me/shifo_bot');
});

test('логотип в предпросмотре: квадратный файл, иначе печатная копия', async () => {
    let root = await open({ logo_square_path: 'square/1-a.png', logo_data_url: PRINT_COPY });
    let mark = descendants(preview(root)).find((n) => n.tagName === 'IMG');
    assert.equal(mark && mark.attrs.src, '/api/storage/clinic-logos/square/1-a.png');
    root = await open({ logo_data_url: 'data:image/png;base64,T0xE' });
    mark = descendants(preview(root)).find((n) => n.tagName === 'IMG');
    assert.equal(mark && mark.attrs.src, 'data:image/png;base64,T0xE');
});

test('«Как это выглядит в документах»: адрес, вписанный руками; сайта на бланке нет', async () => {
    const root = await open({ website: 'https://shifo-clinic.uz', street_ru: 'ул. Амира Темура, 12' });
    const card = descendants(root).find((n) => matches(n, '.card')
        && labelText(descendants(n).find((x) => x.tagName === 'H3')) === 'Как это выглядит в документах');
    assert.ok(card, 'нет карточки «Как это выглядит в документах»');
    assert.match(textOf(card), /Ташкент, ул\. Мира 1/, 'на бланке — «Адрес в документах»');
    assert.doesNotMatch(textOf(card), /shifo-clinic\.uz/, 'сайт на бланках не печатается (ответ владельца)');
    assert.doesNotMatch(textOf(card), /Амира Темура/, 'адрес для партнёров на бланк не идёт');
    assert.ok(previewLinks(root).some((l) => l.text === 'Сайт'), 'а пациентам и партнёрам сайт виден');
});

test('ширина телефона: две колонки .col в обёртке с переносом; ни одна не требует больше 380 px', async () => {
    const root = await open();
    const main = descendants(root).find((n) => matches(n, '.cpf-main'));
    const side = descendants(root).find((n) => matches(n, '.cpf-side'));
    assert.ok(main && side, 'нет колонок экрана');
    for (const col of [main, side]) {
        assert.ok(col.classList.contains('col'));
        assert.equal(col._parent.style.flexWrap, 'wrap', 'колонки переносятся в один столбец');
        const px = Object.values(col.style).join(' ').match(/\d+(?=px)/g) || [];
        for (const n of px) assert.ok(Number(n) <= (col === side ? 380 : 480), 'колонка задаёт ' + n + 'px');
        assert.match(String(col.style.minWidth), /min\(320px, 100%\)/, 'минимум не шире экрана телефона');
    }
    assert.ok(!('width' in side.style) && !('maxWidth' in side.style), 'правая колонка не задаёт ширину в стиле');
});

// ===========================================================================
// Задача 14 — «Компания» в филиале: общее для клиники — только просмотр
// ===========================================================================
const isOff = (n) => !!n && (n.disabled === true || n.attrs.disabled !== undefined);
async function openAs(role, extra = {}) {
    const prev = globalThis.window.CLINIC.building_role;
    globalThis.window.CLINIC.building_role = role;
    try { return await open(extra); } finally { globalThis.window.CLINIC.building_role = prev; }
}

test('филиал: названия, описание, лицензия, цвет, сайт и соцсети, логотипы — выключены; вверху заметка; адрес этого здания', async () => {
    const { COMPANY_BUILDING } = await import('../../shared/clinic-profile.js');
    const root = await openAs('secondary', { name_uz: 'Shifo', website: 'https://shifo.uz', logo_data_url: 'data:image/png;base64,T0xE' });
    for (const lang of ['ru', 'uz', 'en']) {
        assert.ok(isOff(triInput(root, 'Название клиники', lang)), 'название ' + lang);
        assert.ok(isOff(triInput(root, 'Коротко о клинике', lang)), 'описание ' + lang);
    }
    for (const label of ['Номер лицензии', 'Фирменный цвет', 'Сайт', 'Telegram-бот', 'Telegram-канал', 'Instagram']) {
        assert.ok(isOff(fieldInput(root, label)), label + ' — общее для клиники, правится в главном здании');
    }
    for (const title of ['Квадратный, 1:1', 'Вертикальный']) {
        const btns = descendants(logoTile(root, title)).filter((n) => n.tagName === 'BUTTON');
        assert.ok(btns.length > 0 && btns.every(isOff), 'кнопки логотипа «' + title + '» выключены');
    }
    const note = descendants(root).find((n) => n.attrs && n.attrs.role === 'note');
    assert.ok(note, 'нет заметки филиала');
    assert.match(textOf(note), /^Название, описание, логотипы, сайт и соцсети, лицензия и фирменный цвет меняются в главном здании\./);
    assert.match(textOf(root), /Адрес этого здания/);

    // Своё у здания — открыто и сохраняется; уходит только своё у здания
    // (CLINIC_PROFILE_V1, ревью C1: и только изменённое). Общее для клиники не
    // уходит, даже если значение в нём как-то поменяли.
    for (const label of ['Адрес в документах', 'Телефон', 'Электронная почта']) assert.ok(!isOff(fieldInput(root, label)), label);
    type(fieldInput(root, 'Адрес в документах'), 'ул. Филиальная, 7');
    type(fieldInput(root, 'Сайт'), 'https://other.uz');
    await save(root);
    assert.ok(lastUpdate, 'запрос ушёл');
    for (const c of Object.keys(lastUpdate)) assert.ok(COMPANY_BUILDING.includes(c), c + ' — своё у здания');
    assert.deepEqual(lastUpdate, { address: 'ул. Филиальная, 7' });
});

test('главное здание: всё открыто, заметки филиала нет, сохраняются все колонки «Компании»', async () => {
    const root = await openAs('main');
    assert.ok(!isOff(triInput(root, 'Название клиники', 'ru')));
    assert.ok(!isOff(fieldInput(root, 'Сайт')));
    assert.ok(!descendants(root).some((n) => n.attrs && n.attrs.role === 'note'), 'заметки филиала нет');
    type(triInput(root, 'Название клиники', 'uz'), 'Shifo');
    type(fieldInput(root, 'Адрес в документах'), 'ул. Главная, 1');
    await save(root);
    assert.deepEqual(lastUpdate, { name_uz: 'Shifo', address: 'ул. Главная, 1' }, 'общее для клиники и своё — оба уходят');
});
