// LAB_TUBE_LABEL_V1 (решение владельца 2026-11-02) — штрих-код этикетки пробирки.
//
// Номер этикетки — 8 цифр (LAB_BARCODE_DIGITS_V1). Теперь он кодируется набором C
// Code128 (пара цифр — один знак: символ короче, полоски шире) и окружён тихой
// зоной в 10 модулей. Прочие строки — набором B, как было. Несколько этикеток
// (пробирки визита) печатаются одним окном.
//
// Эталоны — python-barcode 0.16.1 (им же когда-то сверена таблица). Он теряет
// ВЕДУЩУЮ пару «99» в наборе C (99999999 → 999999), поэтому «00000099» и
// «99999999» сверены по стандарту (ISO/IEC 15417), а не по нему.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const printed = [];
let opened = 0;
globalThis.window = { open: () => { opened++; return { document: { write(s) { printed.push(String(s)); }, close() {} } }; } };
globalThis.alert = (m) => { throw new Error('alert: ' + m); };

const { code128Modules, barcodeSVG, printBarcodeLabels, printBarcodeLabel, QUIET_MODULES } = await import('../views/lab-barcode.js');

const START_B = '11010010000';
const START_C = '11010011100';
const STOP = '1100011101011';

// python-barcode 0.16.1, Code128 (сам выбрал набор C).
const PY_C = {
    '00000028': '1101001110011011001100110110011001101100110011100110100110001001001100011101011',
    '00000032': '1101001110011011001100110110011001101100110011000110110111011001001100011101011',
    '12345678': '1101001110010110011100100010110001110001011011000010100100011101101100011101011',
    '17874421': '1101001110010011100110111100101001000110111011011100100101111011101100011101011',   // контрольный знак 100
};
// python-barcode 0.16.1, чистый набор B — прежний вид не изменился.
const PY_B = {
    'ABCDEF': '11010010000101000110001000101100010001000110101100010001000110100010001100010101100011101100011101011',
    'LAB-9': '110100100001000110111010100011000100010110001001101110011100101100100101111001100011101011',
};

test('номер этикетки (8 цифр) — набор C, побайтово как у python-barcode', () => {
    for (const [code, want] of Object.entries(PY_C)) assert.equal(code128Modules(code), want, code);
    assert.equal(code128Modules('00000028').length, 79, 'Start C + 4 пары + контрольный + Stop');
});

test('пара «99» — по стандарту: Start C, 00 00 00 99, контрольный (105 + 4·99) mod 103 = 89, Stop', () => {
    const want = START_C + '11011001100'.repeat(3) + '10111011110' + '11011011110' + STOP;
    assert.equal(code128Modules('00000099'), want);
});

test('всё, кроме чётного числа одних цифр, — набор B, как было', () => {
    for (const [code, want] of Object.entries(PY_B)) assert.equal(code128Modules(code), want, code);
    for (const code of ['0000003', 'LAB-000032', '00000028 ', '', null]) {
        assert.ok(code128Modules(code).startsWith(START_B), JSON.stringify(code) + ' — набор B');
    }
});

// Рисунки знаков 0…99 — из самого кодировщика (таблица прибита эталонами выше);
// 100…102 бывают только контрольным знаком — по стандарту.
const PAIR = Array.from({ length: 100 }, (_, v) => code128Modules(String(v).padStart(2, '0')).slice(11, 22));
const HIGH = { 100: '10111101110', 101: '11101011110', 102: '11110101110' };
const symbol = (v) => (v < 100 ? PAIR[v] : HIGH[v]);

test('набор C читается обратно для номеров 1…3000 и крайних: те же цифры, контрольный знак по стандарту', () => {
    assert.equal(new Set(PAIR).size, 100, 'у каждой пары свой рисунок');
    const nums = [...Array.from({ length: 3000 }, (_, i) => i + 1), 9999999, 10000000, 99999999];
    for (const n of nums) {
        const code = String(n).padStart(8, '0');
        const m = code128Modules(code);
        assert.equal(m.length, 79, code);
        assert.ok(m.startsWith(START_C) && m.endsWith(STOP), code);
        const vals = [0, 1, 2, 3].map((i) => PAIR.indexOf(m.slice(11 + 11 * i, 22 + 11 * i)));
        assert.equal(vals.map((v) => String(v).padStart(2, '0')).join(''), code, 'прочитано не то: ' + code);
        const check = (105 + vals.reduce((s, v, i) => s + (i + 1) * v, 0)) % 103;
        assert.equal(m.slice(55, 66), symbol(check), 'контрольный знак: ' + code);
    }
});

test('тихая зона: 10 модулей пустоты с каждой стороны, растягивается вместе с полосками', () => {
    assert.equal(QUIET_MODULES, 10);
    const svg = barcodeSVG('00000028', { moduleW: 1.4, height: 48 });
    const w = parseFloat(/ width="([\d.]+)"/.exec(svg)[1]);
    const rects = [...svg.matchAll(/<rect x="([\d.]+)" y="0" width="([\d.]+)"/g)].map((m) => [parseFloat(m[1]), parseFloat(m[2])]);
    assert.ok(Math.abs(w - (79 + 20) * 1.4) < 0.05, 'ширина — символ и две зоны: ' + w);
    assert.ok(Math.abs(rects[0][0] - 14) < 0.005, 'слева 10 модулей: ' + rects[0][0]);
    const [lx, lw] = rects[rects.length - 1];
    assert.ok(Math.abs(w - (lx + lw) - 14) < 0.05, 'справа 10 модулей: ' + (w - lx - lw));
    assert.match(svg, /viewBox="0 0 138\.6 48"/);
    assert.match(barcodeSVG('00000028', { moduleW: 1.4, quiet: 0 }), /<rect x="0\.00"/, 'quiet: 0 — без зоны');
});
