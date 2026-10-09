// CLINIC_API_FIX_V1 (ревью итога) — ФАЙЛ ИМПОРТА ЧИТАЕТСЯ ТАК, ЧТОБЫ ПРАВИЛО
// ЧИСЛА (readImportNumber) ВИДЕЛО ЯЧЕЙКУ, А НЕ ДОГАДКУ SheetJS.
//
// XLSX.read без raw: true сам превращал текст CSV в числа ДО импорта:
// «150.000» → 150, «1,500» → 1500, «12,5» → 125 (и в CSV с «;» из
// русского Excel), «40%» → 0,4 — со статусом «готово» и без слова. Здесь —
// настоящий SheetJS из public/js/vendor и настоящий путь чтения окна импорта
// (readSheetRows), затем та же сборка строки, что в окне (buildImportRow).
import { test } from 'node:test';
import assert from 'node:assert/strict';

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
const { readSheetRows, buildImportRow } = await import('../views/section-import-export.js');

// CSV так, как его сохраняет Excel «CSV UTF-8» (с меткой порядка байтов).
const csv = (text) => new TextEncoder().encode('﻿' + text).buffer;
const UPDATE = () => ({ __wantUpdate: true, __stored: new Map([['приём кардиолога', { name: 'Приём кардиолога', price: 200000 }]]) });
const rowsOf = (buf, section, lookups = {}) => readSheetRows(XLSX, buf, section)
    .map((raw, i) => buildImportRow(section, raw, { rowNum: i + 2, lookups }));

test('CSV: ячейки остаются текстом — «150.000», «1,500», «12,5», «40%» доходят до правила числа как есть', () => {
    const raw = readSheetRows(XLSX, csv('name,group,price,tax_rate,default_doctor_percent\nПриём кардиолога,Консультация,150.000,"12,5",40%\n'), 'services');
    assert.equal(raw.length, 1);
    assert.strictEqual(raw[0].price, '150.000', 'SheetJS сам сделал из «150.000» число: ' + JSON.stringify(raw[0].price));
    assert.strictEqual(raw[0].tax_rate, '12,5');
    assert.strictEqual(raw[0].default_doctor_percent, '40%');
});

test('CSV: «150.000» в цене обновляемой услуги — не 150, цена остаётся, предупреждение', () => {
    const [row] = rowsOf(csv('name,group,price\nПриём кардиолога,Консультация,150.000\n'), 'services', UPDATE());
    assert.ok(!('price' in row.payload), 'цена записана: ' + JSON.stringify(row.payload.price));
    assert.strictEqual(row.status, 'warn');
    assert.ok(row.notes.some((n) => String(n).includes('«150.000»')), JSON.stringify(row.notes));
});

test('CSV: «150 000» — 150000; «12,5» в НДС — 12,5; «40%» в доле — 40 (и в CSV с «;» из русского Excel)', () => {
    for (const text of [
        'name,group,price,tax_rate,default_doctor_percent\nПриём кардиолога,Консультация,150 000,"12,5",40%\n',
        'name;group;price;tax_rate;default_doctor_percent\nПриём кардиолога;Консультация;150 000;12,5;40%\n',
    ]) {
        const [row] = rowsOf(csv(text), 'services', UPDATE());
        assert.strictEqual(row.payload.price, 150000, text);
        assert.strictEqual(row.payload.tax_rate, 12.5, text);
        assert.strictEqual(row.payload.default_doctor_percent, 40, text);
        assert.strictEqual(row.status, 'ok', JSON.stringify(row.notes));
    }
});

test('CSV: новая услуга с «1,500» в цене не ввозится (не 1500 молча)', () => {
    const [row] = rowsOf(csv('name,group,price\nПриём невролога,Консультация,"1,500"\n'), 'services');
    assert.strictEqual(row.status, 'error', JSON.stringify(row));
    assert.notStrictEqual(row.payload.price, 1500);
});

test('.xlsx: числовые ячейки читаются числами, как раньше', () => {
    const ws = XLSX.utils.aoa_to_sheet([['name', 'group', 'price', 'tax_rate'], ['Приём кардиолога', 'Консультация', 150000, 12]]);
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Services');
    const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
    const raw = readSheetRows(XLSX, buf, 'services');
    assert.strictEqual(raw[0].price, 150000);
    const [row] = rowsOf(buf, 'services', UPDATE());
    assert.strictEqual(row.payload.price, 150000);
    assert.strictEqual(row.payload.tax_rate, 12);
    assert.strictEqual(row.status, 'ok', JSON.stringify(row.notes));
});
