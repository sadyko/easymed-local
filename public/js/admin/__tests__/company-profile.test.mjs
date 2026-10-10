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
            if (op === 'update') { lastUpdate = desc.values; docRow = { ...docRow, ...desc.values }; }
            return ok({ data: { ...docRow } });
        }
        if (GEO[desc.table]) {
            let rows = GEO[desc.table].filter((r) => r.active);
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
    assert.equal(lastUpdate.clinic_name, 'Клиника «Шифо»', 'RU-название — то, что печатается, — не тронуто');
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

test('сохранение шлёт ровно колонки «Компании»; адрес, вписанный руками, — как был', async () => {
    const root = await open();
    await save(root);

    assert.ok(lastUpdate, 'запрос на сохранение не ушёл');
    assert.deepEqual(Object.keys(lastUpdate).sort(), [...COMPANY_COLUMNS].sort());
    for (const c of ['paper_size', 'show_watermark', 'footer_note', 'legal_note', 'lab_scope']) {
        assert.ok(!(c in lastUpdate), c + ' — не колонка «Компании»');
    }
    assert.equal(lastUpdate.address, 'Ташкент, ул. Мира 1');
    assert.equal(lastUpdate.logo_data_url, '', 'нет логотипа — пустая строка (колонка NOT NULL)');
    assert.equal(docRow.paper_size, 'A5', 'настройки печати в базе не тронуты');
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
    assert.equal(lastUpdate.logo_portrait_path, '');
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
        assert.equal(lastUpdate.logo_square_path, '');
        assert.equal(lastUpdate.logo_data_url, '');
    }
});

test('вертикальный PNG: свой путь portrait/…; печатная копия не меняется', async () => {
    const root = await open({ logo_data_url: 'data:image/png;base64,T0xE' });
    await pick(root, 'Вертикальный', fileOf(fakePng(600, 800)));
    assert.equal(uploads.length, 1);
    assert.match(uploads[0].url, /^\/api\/storage\/clinic-logos\/portrait\//);
    await save(root);
    assert.match(lastUpdate.logo_portrait_path, PT_PATH);
    assert.equal(lastUpdate.logo_data_url, 'data:image/png;base64,T0xE', 'прежний логотип печатается дальше');
    assert.equal(lastUpdate.logo_square_path, '');

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
    assert.equal(lastUpdate.logo_portrait_path, 'portrait/1-b.png');

    root = await open(both);
    buttonByText(logoTile(root, 'Вертикальный'), /Удалить/).click();
    await save(root);
    assert.equal(lastUpdate.logo_portrait_path, '');
    assert.equal(lastUpdate.logo_square_path, 'square/1-a.png');
    assert.equal(lastUpdate.logo_data_url, PRINT_COPY);
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
    assert.equal(lastUpdate.logo_square_path, '');
    assert.equal(lastUpdate.logo_data_url, '');
});
