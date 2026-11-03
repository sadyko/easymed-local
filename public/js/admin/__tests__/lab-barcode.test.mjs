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

test('несколько этикеток — одним окном печати; на каждой номер, время, пациент и что в пробирке', () => {
    printed.length = 0; opened = 0;
    const ok = printBarcodeLabels([
        { code: '00000028', patientName: 'Тестов <Пациент>', mrn: 'P-1', dateStr: '02.11.2026, 19:06', tests: 'ОАК, СОЭ' },
        { code: '00000029', patientName: 'Тестов <Пациент>', mrn: 'P-1', dateStr: '02.11.2026, 19:07', tests: 'ОАМ' },
    ]);
    assert.equal(ok, true);
    assert.equal(opened, 1, 'второе окно подряд браузер заблокирует — одно окно на все этикетки');
    const html = printed[0];
    assert.equal((html.match(/<div class="lbl">/g) || []).length, 2);
    assert.match(html, /class="acc">№ 00000028</);
    assert.match(html, /class="acc">№ 00000029</);
    assert.match(html, /class="tests">ОАК, СОЭ</);
    assert.match(html, /class="date">02\.11\.2026, 19:06</);
    assert.match(html, /Тестов &lt;Пациент&gt;/);
    assert.match(html, /<rect x="14\.00"/, 'штрих-код с тихой зоной');
});

test('одна этикетка — прежний вызов, то же окно; без tests и mrn этих строк нет; пустой список — окна нет', () => {
    printed.length = 0; opened = 0;
    printBarcodeLabel({ code: '00000031', patientName: 'Тестов', mrn: '', dateStr: '02.11.2026, 19:06' });
    assert.equal(opened, 1);
    assert.equal((printed[0].match(/<div class="lbl">/g) || []).length, 1);
    assert.ok(!printed[0].includes('class="tests"'));
    assert.ok(!printed[0].includes('class="mrn"'));
    assert.equal(printBarcodeLabels([]), false);
    assert.equal(opened, 1);
});

// Ревью U11, L2 (проба p3, Chrome с настоящими шрифтами Onest): с новой строкой
// «что в пробирке» имя + ID + анализы + штрих-код занимали 36,94 мм из 37 мм
// этикетки 40 мм (запас 0,06 мм): штрих-код набора C с тихой зоной упирался в
// max-height 17 мм. Иной драйвер или округление — и номер под штрих-кодом
// обрезается. Теперь штрих-код не выше 15 мм (до U11 было 14,8 мм). Бюджет — по
// правилам самого окна печати: строки текста × высоту строки Onest (1,28 —
// с запасом к измеренным 1,27) + штрих-код + отступы.
test('ревью U11, L2: этикетка 40 мм — штрих-код не выше 15 мм, у текста и номера запас не меньше 1,5 мм', () => {
    printed.length = 0;
    printBarcodeLabels([{ code: '00000028', patientName: 'Абдурахмонова Мухлиса', mrn: '00012345', dateStr: '02.11.2026, 19:06', tests: 'ОАК, Ретикулоциты, СОЭ' }]);
    const html = printed[0];
    const rule = (sel) => {
        const m = new RegExp('\\' + sel + ' \\{([^}]*)\\}').exec(html);
        assert.ok(m, 'нет правила ' + sel);
        return m[1];
    };
    const num = (decl, prop) => {
        const m = new RegExp(prop + ':\\s*(-?[\\d.]+)(pt|mm)').exec(decl);
        assert.ok(m, prop + ' нет в «' + decl + '»');
        return m[2] === 'pt' ? Number(m[1]) * 25.4 / 72 : Number(m[1]);
    };
    const svgMax = num(rule('.bc svg'), 'max-height');
    assert.ok(svgMax <= 15, 'штрих-код выше 15 мм: ' + svgMax);
    const LINE = 1.28;   // высота строки Onest (normal), с запасом
    // Строка номера и времени — по номеру (крупнее), затем имя, ID, анализы, цифры под штрих-кодом.
    const text = ['.acc', '.name', '.mrn', '.tests', '.bcnum'].map((sel) => num(rule(sel), 'font-size') * LINE).reduce((a, b) => a + b, 0);
    const margins = num(rule('.mrn'), 'margin-top') + num(rule('.bcnum'), 'margin-top');
    const inner = 40 - 2 * num(rule('.lbl'), 'padding');
    const used = text + margins + svgMax;
    assert.ok(inner - used >= 1.5, 'запас этикетки ' + (inner - used).toFixed(2) + ' мм из ' + inner + ' (занято ' + used.toFixed(2) + ')');
});

// Ревью U11, NIT — этикетки партий склада (procurement.js, тот же barcodeSVG):
// своё экранирование не трогало кавычку, и имя товара с «"» рвало title="…".
test('ревью U11, NIT: этикетки партий экранируют и кавычку — имя товара в title="…" не рвёт атрибут', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('../views/procurement.js', import.meta.url), 'utf8');
    const at = src.indexOf('function printBatchLabels');
    assert.ok(at > 0, 'printBatchLabels пропала');
    const m = /const esc = (\(s\) => [^\n]+);/.exec(src.slice(at));
    assert.ok(m, 'esc печати партий не найден');
    const esc = (0, eval)(m[1]);
    assert.equal(esc('Бинт "Стерильный" <5×7> & Co'), 'Бинт &quot;Стерильный&quot; &lt;5×7&gt; &amp; Co');
});
