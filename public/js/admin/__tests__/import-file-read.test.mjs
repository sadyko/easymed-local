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

// CLINIC_API_FIX_V1 (ревью итога) — ЯЧЕЙКА В ПРОЦЕНТНОМ ФОРМАТЕ EXCEL. «40%»,
// набранное в Excel, хранится числом 0,4 и только показывается «40%». Импорт
// брал 0,4: доля исполнителя 0,4 %, НДС 0,12 %, ступень 0,45 % — со статусом
// «готово». Теперь такая ячейка доходит до правила числа как «40%»: колонка
// процентов читает 40, колонка не процентов («цена») — отказывает.
function xlsxWith(header, cells) {
    const ws = XLSX.utils.aoa_to_sheet([header, cells.map((c) => (c && typeof c === 'object' ? c.v : c))]);
    cells.forEach((c, i) => { if (c && typeof c === 'object') ws[XLSX.utils.encode_cell({ r: 1, c: i })].z = c.z; });
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Services');
    return XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
}

test('.xlsx в процентном формате: 40% — 40, 12% — 12, 45,0% — 45, а не 0,4 / 0,12 / 0,45', () => {
    const buf = xlsxWith(['name', 'group', 'price', 'tax_rate', 'default_doctor_percent', 'doctor_tier_from', 'doctor_tier_percent'],
        ['Приём кардиолога', 'Консультация', 150000, { v: 0.12, z: '0%' }, { v: 0.4, z: '0%' }, 10, { v: 0.45, z: '0.0%' }]);
    const raw = readSheetRows(XLSX, buf, 'services');
    assert.strictEqual(raw[0].default_doctor_percent, '40%');
    assert.strictEqual(raw[0].price, 150000, 'обычная числовая ячейка — число, как раньше');
    const [row] = rowsOf(buf, 'services', UPDATE());
    assert.strictEqual(row.payload.tax_rate, 12);
    assert.strictEqual(row.payload.default_doctor_percent, 40);
    assert.strictEqual(row.payload.doctor_tier_from, 10);
    assert.strictEqual(row.payload.doctor_tier_percent, 45);
    assert.strictEqual(row.status, 'ok', JSON.stringify(row.notes));
});

test('.xlsx в процентном формате без дробной части: 12,5% показано «13%», а читается 12,5', () => {
    const buf = xlsxWith(['name', 'group', 'price', 'default_doctor_percent'], ['Приём кардиолога', 'Консультация', 150000, { v: 0.125, z: '0%' }]);
    const [row] = rowsOf(buf, 'services', UPDATE());
    assert.strictEqual(row.payload.default_doctor_percent, 12.5);
});

test('.xlsx: процентный формат в цене — не число (у обновляемой цена остаётся, новая не ввозится)', () => {
    const buf = xlsxWith(['name', 'group', 'price'], ['Приём кардиолога', 'Консультация', { v: 0.5, z: '0%' }]);
    const [upd] = rowsOf(buf, 'services', UPDATE());
    assert.ok(!('price' in upd.payload), 'цена записана: ' + JSON.stringify(upd.payload.price));
    assert.ok(upd.notes.some((n) => String(n).includes('«50%»')), JSON.stringify(upd.notes));
    const [fresh] = rowsOf(buf, 'services');
    assert.strictEqual(fresh.status, 'error');
});

test('.xlsx: знак % как подпись в формате (0"%") — число не умножается на 100', () => {
    const buf = xlsxWith(['name', 'group', 'price', 'default_doctor_percent'], ['Приём кардиолога', 'Консультация', 150000, { v: 40, z: '0"%"' }]);
    const [row] = rowsOf(buf, 'services', UPDATE());
    assert.strictEqual(row.payload.default_doctor_percent, 40);
});

// CLINIC_API_FIX_V1 (ревью итога) — КОДИРОВКА CSV. SheetJS читал байты CSV
// без метки порядка байтов как latin-1: UTF-8 без метки («Приём» →
// «ÐŸÑ€Ð¸Ñ‘Ð¼») и CSV русского Excel в cp1251 приходили кашей — названия не
// совпадали ни с одной услугой, «Раздел» не узнавался. Теперь .csv
// декодируется до SheetJS: UTF-8 (строго, метка снимается), иначе cp1251.

// cp1251: А–я подряд с 0xC0, Ё — 0xA8, ё — 0xB8; латиница, цифры и знаки — как есть.
function cp1251(text) {
    return new Uint8Array([...text].map((ch) => {
        const c = ch.codePointAt(0);
        if (c < 0x80) return c;
        if (c >= 0x410 && c <= 0x44F) return c - 0x410 + 0xC0;
        if (ch === 'Ё') return 0xA8;
        if (ch === 'ё') return 0xB8;
        throw new Error('нет в таблице теста: ' + ch);
    })).buffer;
}
const utf8 = (text) => new TextEncoder().encode(text).buffer;
const CSV_TEXT = 'name;group;price;tax_rate\nПриём кардиолога;Консультация;150 000;12,5\nЁлочный массаж;Процедуры;80 000;12\n';

test('CSV в UTF-8 с меткой, UTF-8 без метки и cp1251 читаются одинаково — названия и числа', () => {
    const variants = {
        'UTF-8 с меткой': utf8('\uFEFF' + CSV_TEXT),
        'UTF-8 без метки': utf8(CSV_TEXT),
        'cp1251 (русский Excel)': cp1251(CSV_TEXT),
    };
    for (const [what, buf] of Object.entries(variants)) {
        const raws = readSheetRows(XLSX, buf, 'services', 'uslugi.csv');
        assert.deepEqual(raws.map((r) => r.name), ['Приём кардиолога', 'Ёлочный массаж'], what + ': ' + JSON.stringify(raws));
        assert.ok(!Object.keys(raws[0]).some((k) => k.charCodeAt(0) === 0xFEFF), what + ': метка порядка байтов попала в заголовок');
        const rows = raws.map((raw, i) => buildImportRow('services', raw, { rowNum: i + 2 }));
        assert.deepEqual(rows.map((r) => r.payload.type), ['consultation', 'procedure'], what + ': «Раздел» не узнан');
        assert.deepEqual(rows.map((r) => r.payload.price), [150000, 80000], what);
        assert.deepEqual(rows.map((r) => r.payload.tax_rate), [12.5, 12], what);
        assert.ok(rows.every((r) => r.status === 'ok'), what + ': ' + JSON.stringify(rows.map((r) => r.notes)));
    }
});

test('.xlsx с именем файла — как раньше: числа числами, кириллица как есть', () => {
    const ws = XLSX.utils.aoa_to_sheet([['name', 'group', 'price'], ['Приём кардиолога', 'Консультация', 150000]]);
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Services');
    const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
    const raws = readSheetRows(XLSX, buf, 'services', 'uslugi.xlsx');
    assert.deepEqual(raws, [{ name: 'Приём кардиолога', group: 'Консультация', price: 150000 }]);
});
