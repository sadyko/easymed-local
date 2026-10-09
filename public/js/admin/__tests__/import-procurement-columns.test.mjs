// CLINIC_API_FIX_V1 (ревью итога) — ИМПОРТ «ТОВАРОВ» ЗАКУПКИ: КОЛОНКИ С
// ПРОБЕЛОМ В НАЗВАНИИ ЧИТАЮТСЯ.
//
// Заголовки листа приводятся к виду «нижний регистр, пробелы → _» («Цена
// закупки» → «цена_закупки»), а колонка искалась по своему ключу как есть
// («цена закупки»). Шесть колонок шаблона (99cea7b) не находились никогда:
// «базовая ед.», «ед. выдачи», «кол-во в ед. выдачи», «цена закупки»,
// «ед. закупки», «кол-во в ед. закупки» — единицы, кратность и закупочные
// условия из файла молча пропадали. И текстовые колонки-захваты
// («поставщик», «ед. закупки») шли через разбор числа и становились null.
//
// Привязка поставщиков (linkSuppliers) остаётся ВЫКЛЮЧЕННОЙ, как и была на
// деле: создавать поставщиков из файла — решение владельца.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Minimal DOM so the view module (and i18n it pulls) can load; nothing renders here.
class F { constructor(t) { this.tagName = String(t).toUpperCase(); this.style = {}; this.children = []; this.attrs = {}; this.className = ''; this._t = ''; this.dataset = {}; this.value = ''; }
    appendChild(c) { this.children.push(c); return c; } removeChild() {} setAttribute(k, v) { this.attrs[k] = String(v); } getAttribute(k) { return this.attrs[k] ?? null; }
    addEventListener() {} removeEventListener() {} querySelector() { return null; } querySelectorAll() { return []; } remove() {}
    get textContent() { return this._t; } set textContent(v) { this._t = String(v); }
    get classList() { return { contains: () => false, add() {}, remove() {}, toggle() {} }; } }
const mk = (t) => new F(t);
globalThis.Node = F;
globalThis.localStorage = { getItem: (k) => (k === 'admin.lang' ? 'ru' : null), setItem() {}, removeItem() {}, clear() {} };
globalThis.document = { createElement: mk, createElementNS: (_n, t) => mk(t), createTextNode: (t) => { const e = mk('#text'); e._t = String(t); return e; }, head: mk('head'), body: mk('body'), documentElement: mk('html'), addEventListener() {}, removeEventListener() {}, getElementById() { return null; } };
globalThis.window = { location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, addEventListener() {}, removeEventListener() {} };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();

const XLSX = await import(new URL('../../vendor/xlsx-0.20.3.js', import.meta.url).href);
const { buildImportRow, readSheetRows } = await import('../views/section-import-export.js');

// Строка со ВСЕМИ колонками шаблона «Товары» — заголовки как в шаблоне.
const HEADER = ['Товар', 'Код', 'Категория', 'Ед.изм', 'Базовая ед.', 'Ед. выдачи', 'Кол-во в ед. выдачи', 'Цена', 'ИКПУ',
    'Остаток', 'Себестоимость', 'Поставщик', 'Цена закупки', 'Ед. закупки', 'Кол-во в ед. закупки'];
const ROW = ['Перекись водорода 3% 100мл', '10327', 'Лекарственные средства', 'фл', 'мл', 'фл', 100, 1225, '03004326008132006',
    77, 1145, 'Aventus', '1 145', 'кор', 40];
const asRaw = () => Object.fromEntries(HEADER.map((k, i) => [k, ROW[i]]));

function check(row) {
    assert.notStrictEqual(row.status, 'error', JSON.stringify(row.notes));
    const p = row.payload;
    assert.strictEqual(p.name, 'Перекись водорода 3% 100мл');
    assert.strictEqual(p.price, 1225);
    assert.strictEqual(p.unit, 'фл');
    assert.strictEqual(p.base_unit, 'мл', 'базовая единица из файла пропала');
    assert.strictEqual(p.consumption_unit, 'фл', 'единица выдачи из файла пропала');
    assert.strictEqual(p.consumption_factor, 100, 'кол-во в единице выдачи из файла пропало');
    const c = row.captures;
    assert.strictEqual(c.qty, 77);
    assert.strictEqual(c.cost, 1145, 'себестоимость');
    assert.strictEqual(c.supplier, 'Aventus', 'поставщик — текст, а не null');
    assert.strictEqual(c.supPrice, 1145, 'цена закупки из файла пропала');
    assert.strictEqual(c.supUnit, 'кор', 'единица закупки — текст из файла');
    assert.strictEqual(c.supPack, 40, 'кол-во в единице закупки из файла пропало');
}

test('строка «Товаров» со всеми колонками шаблона: единицы, кратность, себестоимость и закупка — в строке', () => {
    check(buildImportRow('procurement_items', asRaw()));
});

test('то же через настоящий .xlsx и путь чтения окна (заголовок над строками — с поиском шапки)', () => {
    const ws = XLSX.utils.aoa_to_sheet([['Выгрузка склада'], [], HEADER, ROW]);
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Товары');
    const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
    const raws = readSheetRows(XLSX, buf, 'procurement_items');
    assert.equal(raws.length, 1);
    check(buildImportRow('procurement_items', raws[0]));
});

test('колонки с пробелом в названии ищутся и по синониму («кратность закупки», «единица закупки»)', () => {
    const row = buildImportRow('procurement_items', { 'Товар': 'Шприц', 'Цена': 1200, 'Кратность закупки': '10', 'Единица закупки': ' уп ' });
    assert.strictEqual(row.captures.supPack, 10);
    assert.strictEqual(row.captures.supUnit, 'уп');
});

test('привязка поставщиков из файла выключена (решение владельца), а не включилась вместе с чтением колонки', () => {
    const src = fs.readFileSync(new URL('../views/section-import-export.js', import.meta.url), 'utf8');
    assert.match(src, /const SUPPLIER_LINK_ON = false;/, 'нет явного выключателя привязки поставщиков');
    assert.match(src, /if \(SUPPLIER_LINK_ON\) \{\s*try \{ supMsg = await linkSuppliers\(\); \}/, 'linkSuppliers зовётся без выключателя');
});
