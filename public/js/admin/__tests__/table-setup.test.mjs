// TABLE_SETUP_V1 / CRUD_LIST_V2 — one «Настройка таблицы» for every list, and
// the settings registers in the services list's shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(HERE, '..', rel), 'utf8');

const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k), clear: () => store.clear() };
class F { constructor(t) { this.tagName = String(t).toUpperCase(); this.style = {}; this.children = []; this.attrs = {}; this.className = ''; this._t = ''; this.dataset = {}; }
    appendChild(c) { this.children.push(c); return c; } setAttribute(k, v) { this.attrs[k] = String(v); } getAttribute(k) { return this.attrs[k] ?? null; }
    addEventListener() {} removeEventListener() {} remove() {} querySelector() { return null; } querySelectorAll() { return []; }
    get textContent() { return this._t; } set textContent(v) { this._t = String(v); }
    get classList() { return { contains: () => false, add() {}, remove() {}, toggle() {} }; } }
const mk = (t) => new F(t);
globalThis.Node = F;
globalThis.document = { createElement: mk, createElementNS: (_n, t) => mk(t), createTextNode: (t) => { const e = mk('#text'); e._t = String(t); return e; }, head: mk('head'), body: mk('body'), documentElement: mk('html'), addEventListener() {}, removeEventListener() {}, getElementById() { return null; } };
globalThis.window = { location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, addEventListener() {}, removeEventListener() {} };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
const { readColPrefs, writeColPrefs, widthShare } = await import('../views/table-setup.js');

test('prefs: only a valid saved order comes back; the default order is stored as nothing', () => {
    store.clear();
    assert.equal(readColPrefs('k', ['a', 'b']), null);
    writeColPrefs('k', ['b', 'a'], ['a', 'b']);
    assert.deepEqual(readColPrefs('k', ['a', 'b']), ['b', 'a']);
    writeColPrefs('k', ['a', 'b'], ['a', 'b']);
    assert.equal(store.has('k'), false, 'умолчание — без записи');
    store.set('k', JSON.stringify(['a', 'zzz']));
    assert.equal(readColPrefs('k', ['a', 'b']), null, 'неизвестная колонка — весь выбор отбрасывается');
});

test('widthShare: shares of the card minus the fixed columns, summing to one', () => {
    const share = widthShare([{ key: 'a', w: 3 }, { key: 'b', w: 1 }], 78);
    assert.equal(share({ key: 'a', w: 3 }), 'calc((100% - 78px) * 0.7500)');
    const byKind = widthShare([{ key: 'x' }, { key: 'y', type: 'bool' }], 0, (c) => (c.type === 'bool' ? 1 : 3));
    assert.equal(byKind({ key: 'y', type: 'bool' }), 'calc((100% - 0px) * 0.2500)');
});

test('the services list and the settings registers share the dialog and the layout', () => {
    const svc = read('views/services.js');
    const crud = read('views/section-crud.js');
    for (const src of [svc, crud]) {
        assert.match(src, /from '\.\/table-setup\.js'/, 'общий модуль');
        assert.match(src, /openTableSetup\(\{/, 'общий диалог');
        assert.match(src, /widthShare\(/, 'ширины — доли карточки');
        assert.match(src, /class: 'svc-toolbar'/, 'одна панель инструментов');
        assert.match(src, /class: 'svc-th-label'/, 'подпись и фильтр в одной ячейке шапки');
    }
    assert.ok(!/function openTableSetup\(/.test(svc), 'у списка услуг нет своей копии диалога');
    const sections = read('sections.js');
    const block = sections.slice(sections.indexOf('    patients: {'), sections.indexOf('        fields: [', sections.indexOf('    patients: {')));
    assert.equal((block.match(/optional: true/g) || []).length, 4, 'у пациентов четыре колонки по умолчанию скрыты (филиал, врач, плательщик, полис)');
    assert.match(block, /key: 'gender'.*enum_text/, 'пол — словом, не кодом');
    assert.match(crud, /if \(col\.type === 'enum_text'\) return opt \? tr\(opt\[1\]\)/, 'enum_text рисуется словом, не плашкой');
});
