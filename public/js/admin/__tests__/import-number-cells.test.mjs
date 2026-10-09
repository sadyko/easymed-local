// CLINIC_API_FIX_V1 (ревью итога) — ЧИСЛОВАЯ ЯЧЕЙКА ИМПОРТА: ОДНО ПРАВИЛО.
//
// Было: num() убирал пробелы и запятые и звал Number(); всё, что не
// разобралось, молча становилось значением по умолчанию — у цены это 0.
// Ячейка «150 000 сум» в строке, ОБНОВЛЯЮЩЕЙ услугу, давала price = 0, статус
// «готово», ни слова — и сохранённая цена услуги становилась 0. «40%» в доле
// исполнителя — тоже 0. Цены второго/повторного визита (88e6d03) уже
// говорили о не числе; остальные числовые колонки — нет.
//
// Правило теперь одно для каждой числовой колонки:
//   • число — «150000», «150 000» (пробелы, в том числе неразрывные, —
//     разделитель тысяч), «12,5» / «12.5» (запятая или точка — десятичный
//     знак), в колонке процентов — ещё «40%»;
//   • непустое не число в 0 не превращается НИКОГДА: строка, обновляющая
//     запись, это поле не пишет (сохранённое остаётся) и говорит, в какой
//     колонке что стояло; новая строка с не числом в ДЕНЕЖНОЙ колонке (цена,
//     НДС, любая доля или процент, цены визита) не ввозится вовсе (ошибка);
//     прочее (длительность) — как пустая ячейка, но вслух;
//   • пустая ячейка и отсутствующая колонка — как раньше.
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
const { buildImportRow, readImportNumber } = await import('../views/section-import-export.js');
const { STRINGS } = await import('../i18n-strings.js');

const MIN = { name: 'Приём кардиолога', group: 'Консультация' };
// Услуга есть, галочка «Обновлять существующие» стоит — строка её ОБНОВИТ.
const SAVED = { name: 'Приём кардиолога', price: 200000, tax_rate: 12, price_secondary: 150000, secondary_days_from: 1, secondary_days_to: 30,
    price_repeat: null, repeat_days_from: null, repeat_days_to: null, doctor_tier_from: 10, doctor_tier_percent: 30 };
const UPDATE = () => ({ __wantUpdate: true, __stored: new Map([['приём кардиолога', { ...SAVED }]]) });
// Та же услуга есть, но галочка снята — строка ляжет новой услугой.
const INSERT_TICK_OFF = () => ({ __wantUpdate: false, __stored: UPDATE().__stored });
const noteAbout = (row, col) => row.notes.map(String).find((n) => n.includes('колонке ' + col + ' '));

// --- разбор ячейки ---------------------------------------------------------

test('readImportNumber: обычная запись чисел — пробелы тысяч (и неразрывные), запятая или точка, % только в процентах', () => {
    const n = (v, pct) => readImportNumber(v, pct).n;
    assert.strictEqual(n(150000), 150000, 'число из Excel — как есть');
    assert.strictEqual(n('150000'), 150000);
    assert.strictEqual(n('150 000'), 150000);
    assert.strictEqual(n('150 000'), 150000, 'неразрывный пробел');
    assert.strictEqual(n('150 000'), 150000, 'узкий неразрывный пробел');
    assert.strictEqual(n(' 1 500 000 '), 1500000);
    assert.strictEqual(n('12,5'), 12.5);
    assert.strictEqual(n('12.5'), 12.5);
    assert.strictEqual(n('1 500,50'), 1500.5);
    assert.strictEqual(n('0,125'), 0.125);
    assert.strictEqual(n('1500,000'), 1500, 'четыре цифры до запятой — не тысячи: десятичная запятая');
    assert.strictEqual(n('-5'), -5, 'знак читается; границы проверяют правила колонки');
    assert.strictEqual(n('40%', true), 40);
    assert.strictEqual(n('12,5 %', true), 12.5);
    assert.deepStrictEqual(readImportNumber('', false), { empty: true });
    assert.deepStrictEqual(readImportNumber('   ', false), { empty: true });
    assert.deepStrictEqual(readImportNumber(null, false), { empty: true });
    assert.deepStrictEqual(readImportNumber(undefined, false), { empty: true });
});

test('readImportNumber: не число остаётся не числом — с текстом ячейки, а не 0', () => {
    for (const [v, pct] of [['150 000 сум', false], ['сум 150000', false], ['—', false], ['нет', false], ['40%', false],
        ['15 00', false], ['1e5', false], ['12,5,1', false], [true, false], ['сорок', true], ['%40', true]]) {
        const r = readImportNumber(v, pct);
        assert.ok('bad' in r, JSON.stringify(v) + ' прочитано как ' + JSON.stringify(r));
        assert.strictEqual(r.bad, String(v).trim());
    }
});

test('readImportNumber: «1,500» и «150.000» — не число (это и полтора, и полторы тысячи), а не молча 1,5 или 150', () => {
    for (const v of ['1,500', '150.000', '12.500', '-1,500']) {
        assert.ok('bad' in readImportNumber(v, false), v + ' прочитано как ' + JSON.stringify(readImportNumber(v, false)));
    }
});

// --- строка, обновляющая услугу ----------------------------------------------

test('обновление: цена «150 000 сум» — сохранённая цена остаётся, строка предупреждает и называет колонку и ячейку', () => {
    const row = buildImportRow('services', { ...MIN, price: '150 000 сум' }, { rowNum: 7, lookups: UPDATE() });
    assert.ok(!('price' in row.payload), 'цена записана: ' + JSON.stringify(row.payload.price));
    assert.strictEqual(row.status, 'warn');
    const note = noteAbout(row, 'price');
    assert.ok(note, JSON.stringify(row.notes));
    assert.ok(note.includes('Строка 7') && note.includes('«150 000 сум»'), note);
    assert.strictEqual(note, 'Строка 7: в колонке price не число («150 000 сум») — оставлено сохранённое значение.');
});

test('обновление: «150 000» — 150000; «40%» в доле исполнителя — 40; «12,5» в НДС — 12,5; без предупреждений', () => {
    const row = buildImportRow('services', { ...MIN, price: '150 000', default_doctor_percent: '40%', tax_rate: '12,5', duration_minutes: '45' }, { lookups: UPDATE() });
    assert.strictEqual(row.payload.price, 150000);
    assert.strictEqual(row.payload.default_doctor_percent, 40);
    assert.strictEqual(row.payload.tax_rate, 12.5);
    assert.strictEqual(row.payload.duration_minutes, 45);
    assert.strictEqual(row.status, 'ok', JSON.stringify(row.notes));
});

test('обновление: «сорок» в доле, «полчаса» в длительности, «150.000» в цене — каждое поле остаётся сохранённым, каждое названо', () => {
    const row = buildImportRow('services', { ...MIN, price: '150.000', default_doctor_percent: 'сорок', duration_minutes: 'полчаса' }, { lookups: UPDATE() });
    for (const k of ['price', 'default_doctor_percent', 'duration_minutes']) {
        assert.ok(!(k in row.payload), k + ' записано: ' + JSON.stringify(row.payload[k]));
        assert.ok(noteAbout(row, k), k + ': нет предупреждения — ' + JSON.stringify(row.notes));
    }
    assert.strictEqual(row.status, 'warn');
});

test('обновление: «40%» в цене — не число (процент только в колонке процентов)', () => {
    const row = buildImportRow('services', { ...MIN, price: '40%' }, { lookups: UPDATE() });
    assert.ok(!('price' in row.payload));
    assert.ok(noteAbout(row, 'price'));
});

// CLINIC_API_FIX_V1 (ревью 3, решение) — пустая денежная ячейка в строке,
// ОБНОВЛЯЮЩЕЙ запись, оставляет сохранённое (было: цена 0 с «price пусто»).
test('обновление: пустая ячейка цены — сохранённая цена остаётся, замечание «пусто — оставлено как было»', () => {
    const row = buildImportRow('services', { ...MIN, price: '' }, { rowNum: 4, lookups: UPDATE() });
    assert.ok(!('price' in row.payload), 'цена записана: ' + JSON.stringify(row.payload.price));
    assert.ok(row.notes.includes('Строка 4: price пусто — оставлено как было.'), JSON.stringify(row.notes));
});

// --- новая строка -----------------------------------------------------------

test('новая услуга с не числом в цене не ввозится — ошибка с колонкой и ячейкой', () => {
    for (const lookups of [{}, INSERT_TICK_OFF()]) {
        const row = buildImportRow('services', { ...MIN, price: '150 000 сум' }, { rowNum: 5, lookups });
        assert.strictEqual(row.status, 'error', JSON.stringify(row));
        assert.notStrictEqual(row.payload.price, 0, 'цена стала 0');
        assert.strictEqual(noteAbout(row, 'price'), 'Строка 5: в колонке price не число («150 000 сум») — строка не импортирована.');
    }
});

test('новая услуга: «150 000» — 150000, без ошибки', () => {
    const row = buildImportRow('services', { ...MIN, price: '150 000' });
    assert.strictEqual(row.payload.price, 150000);
    assert.strictEqual(row.status, 'ok', JSON.stringify(row.notes));
});

// CLINIC_API_FIX_V1 (ревью итога, решение) — НОВАЯ строка с не числом в
// денежной колонке не ввозится, как с ценой: «без НДС» не становится НДС 12 %.
// Не денежная колонка (длительность) — значение пустой ячейки и предупреждение.
test('новая услуга: не число в НДС или в доле исполнителя — строка не ввозится, как с ценой', () => {
    for (const [col, v] of [['tax_rate', 'без НДС'], ['default_doctor_percent', 'сорок']]) {
        for (const lookups of [{}, INSERT_TICK_OFF()]) {
            const row = buildImportRow('services', { ...MIN, price: 1000, [col]: v }, { rowNum: 3, lookups });
            assert.strictEqual(row.status, 'error', col + ': ' + JSON.stringify(row.notes));
            assert.strictEqual(noteAbout(row, col), 'Строка 3: в колонке ' + col + ' не число («' + v + '») — строка не импортирована.');
        }
    }
});

test('новая услуга: не число в длительности — 30, как пустая ячейка, с предупреждением (не деньги — строка ввозится)', () => {
    const row = buildImportRow('services', { ...MIN, price: 1000, duration_minutes: 'полчаса' }, { rowNum: 3 });
    assert.strictEqual(row.status, 'warn', JSON.stringify(row.notes));
    assert.strictEqual(row.payload.duration_minutes, 30);
    assert.strictEqual(noteAbout(row, 'duration_minutes'), 'Строка 3: в колонке duration_minutes не число («полчаса») — записано 30, как для пустой ячейки.');
});

test('обновление: не число в НДС и доле — поле остаётся сохранённым, строка ввозится с предупреждением', () => {
    const row = buildImportRow('services', { ...MIN, tax_rate: 'без НДС', default_doctor_percent: 'сорок' }, { lookups: UPDATE() });
    assert.strictEqual(row.status, 'warn', JSON.stringify(row.notes));
    assert.ok(!('tax_rate' in row.payload) && !('default_doctor_percent' in row.payload), JSON.stringify(row.payload));
});

// CLINIC_API_FIX_V1 (ревью 3, решение) — новая услуга без цены не ввозится:
// «укажите цену (0 — если бесплатно)»; явный 0 — допустимая цена. НДС и доля
// пустые — как раньше (12 и 0).
test('новая услуга с пустой ценой или без колонки цены — не ввозится; явный 0 — ввозится', () => {
    for (const raw of [{ ...MIN }, { ...MIN, price: '' }]) {
        const row = buildImportRow('services', raw, { rowNum: 6 });
        assert.strictEqual(row.status, 'error', JSON.stringify(raw));
        assert.ok(row.notes.includes('Строка 6: укажите цену (0 — если бесплатно).'), JSON.stringify(row.notes));
    }
    const free = buildImportRow('services', { ...MIN, price: 0, tax_rate: '', default_doctor_percent: '' });
    assert.strictEqual(free.status, 'ok', JSON.stringify(free.notes));
    assert.strictEqual(free.payload.price, 0);
    assert.strictEqual(free.payload.tax_rate, 12);
    assert.strictEqual(free.payload.default_doctor_percent, 0);
    assert.strictEqual(buildImportRow('services', { ...MIN, price: '0' }).payload.price, 0);
});

// --- цены второго/повторного визита и ступени — то же правило ---------------

test('цены визита: «60 000» и неразрывный пробел читаются; при обновлении не число оставляет сохранённую цену', () => {
    const fresh = buildImportRow('services', { ...MIN, price: 200000, price_secondary: '60 000', secondary_days_from: 1, secondary_days_to: 6,
        price_repeat: '', repeat_days_from: '', repeat_days_to: '' });
    assert.strictEqual(fresh.payload.price_secondary, 60000);
    assert.strictEqual(fresh.status, 'ok', JSON.stringify(fresh.notes));

    const upd = buildImportRow('services', { ...MIN, price: 200000, price_secondary: '60 000 сум' }, { rowNum: 8, lookups: UPDATE() });
    assert.ok(!('price_secondary' in upd.payload), 'сохранённая цена второго визита стёрта: ' + JSON.stringify(upd.payload.price_secondary));
    assert.strictEqual(noteAbout(upd, 'price_secondary'), 'Строка 8: в колонке price_secondary не число («60 000 сум») — оставлено сохранённое значение.');
    assert.strictEqual(upd.status, 'warn');
});

test('цены визита: «1,5» дня — дробный день по правилу окна, а не 15 дней', () => {
    const row = buildImportRow('services', { ...MIN, price: 200000, price_secondary: 60000, secondary_days_from: '1,5', secondary_days_to: 6 }, { rowNum: 4 });
    assert.ok(!('secondary_days_from' in row.payload), JSON.stringify(row.payload));
    assert.ok(row.notes.some((n) => /secondary_days_from — целое неотрицательное число дней/.test(String(n))), JSON.stringify(row.notes));
});

test('ступени: «40%» в доле ступени — 40; «сорок» при обновлении — ступень из файла не сохраняется, колонка и ячейка названы', () => {
    const ok = buildImportRow('services', { ...MIN, price: 1000, doctor_tier_from: '10', doctor_tier_percent: '40%' });
    assert.strictEqual(ok.payload.doctor_tier_from, 10);
    assert.strictEqual(ok.payload.doctor_tier_percent, 40);
    assert.strictEqual(ok.status, 'ok', JSON.stringify(ok.notes));

    const bad = buildImportRow('services', { ...MIN, price: 1000, doctor_tier_from: '10', doctor_tier_percent: 'сорок' }, { rowNum: 6, lookups: UPDATE() });
    assert.ok(!('doctor_tier_from' in bad.payload) && !('doctor_tier_percent' in bad.payload), 'ступень записана: ' + JSON.stringify(bad.payload));
    assert.strictEqual(noteAbout(bad, 'doctor_tier_percent'),
        'Строка 6, «Приём кардиолога»: в колонке doctor_tier_percent не число («сорок») — ступень 1 из файла не сохранена.');
    assert.strictEqual(bad.status, 'warn');
});

test('ступени новой услуги: не число в доле — строка не ввозится (деньги); не число в пороге — ступень не сохраняется, с предупреждением', () => {
    const pct = buildImportRow('services', { ...MIN, price: 1000, doctor_tier_from: '10', doctor_tier_percent_2: '', doctor_tier_from_2: '', doctor_tier_percent: 'сорок' }, { rowNum: 6 });
    assert.strictEqual(pct.status, 'error', JSON.stringify(pct.notes));
    assert.strictEqual(noteAbout(pct, 'doctor_tier_percent'), 'Строка 6: в колонке doctor_tier_percent не число («сорок») — строка не импортирована.');
    const from = buildImportRow('services', { ...MIN, price: 1000, doctor_tier_from: 'десять', doctor_tier_percent: '40' }, { rowNum: 6 });
    assert.strictEqual(from.status, 'warn', JSON.stringify(from.notes));
    assert.ok(!('doctor_tier_from' in from.payload) && !('doctor_tier_percent' in from.payload));
    assert.ok(noteAbout(from, 'doctor_tier_from'), JSON.stringify(from.notes));
});

test('цены визита новой услуги: не число в цене второго визита — строка не ввозится; в днях — не задано, с предупреждением', () => {
    const price = buildImportRow('services', { ...MIN, price: 1000, price_secondary: '60 000 сум', secondary_days_from: 1, secondary_days_to: 6 }, { rowNum: 5 });
    assert.strictEqual(price.status, 'error', JSON.stringify(price.notes));
    assert.strictEqual(noteAbout(price, 'price_secondary'), 'Строка 5: в колонке price_secondary не число («60 000 сум») — строка не импортирована.');
    const days = buildImportRow('services', { ...MIN, price: 1000, price_secondary: 60000, secondary_days_from: 1, secondary_days_to: 'месяц' }, { rowNum: 5 });
    assert.strictEqual(days.status, 'warn', JSON.stringify(days.notes));
    assert.strictEqual(days.payload.secondary_days_to, null);
    assert.strictEqual(noteAbout(days, 'secondary_days_to'), 'Строка 5: в колонке secondary_days_to не число («месяц») — не записано.');
});

// --- другие разделы: то же правило ------------------------------------------

test('товары: цена «1 500» — 1500; «1 500 сум» — строка не ввозится; не число в НДС — тоже', () => {
    assert.strictEqual(buildImportRow('clinic_items', { name: 'Шприц', price: '1 500' }).payload.price, 1500);
    const bad = buildImportRow('clinic_items', { name: 'Шприц', price: '1 500 сум' }, { rowNum: 2 });
    assert.strictEqual(bad.status, 'error');
    assert.strictEqual(noteAbout(bad, 'price'), 'Строка 2: в колонке price не число («1 500 сум») — строка не импортирована.');
    // НДС — деньги: строка товара (новая ли она, узнаётся только при импорте) не ввозится.
    const vat = buildImportRow('clinic_items', { name: 'Шприц', price: 1500, tax_rate: 'без НДС' });
    assert.strictEqual(vat.status, 'error', JSON.stringify(vat.notes));
    assert.ok(noteAbout(vat, 'tax_rate'));
    assert.strictEqual(buildImportRow('clinic_items', { name: 'Шприц', price: 1500, tax_rate: '12%' }).payload.tax_rate, 12);

    const proc = buildImportRow('procurement_items', { 'товар': 'Шапочка', 'цена': '3 210 сум' }, { rowNum: 4 });
    assert.strictEqual(proc.status, 'error');
    assert.ok(noteAbout(proc, 'цена'), JSON.stringify(proc.notes));
    assert.strictEqual(buildImportRow('procurement_items', { 'товар': 'Шапочка', 'цена': '3 210' }).payload.price, 3210);
});

test('остаток при импорте товаров: «50» — приход 50; «50 шт» — без прихода, вслух', () => {
    assert.strictEqual(buildImportRow('procurement_items', { 'товар': 'Шапочка', 'цена': 749, 'остаток': '1 200' }).captures.qty, 1200);
    const bad = buildImportRow('procurement_items', { 'товар': 'Шапочка', 'цена': 749, 'остаток': '50 шт' });
    assert.ok(!(Number(bad.captures.qty) > 0), 'приход из «50 шт»: ' + JSON.stringify(bad.captures));
    assert.strictEqual(bad.status, 'warn');
    assert.ok(noteAbout(bad, 'остаток'), JSON.stringify(bad.notes));
});

test('сотрудники: «30%» в проценте зарплаты — 30; «тридцать» или оклад «4 млн» — строка не ввозится (деньги)', () => {
    const base = { username: 'a.yusupov', role: 'doctor', last_name: 'Юсупов', first_name: 'Азиз' };
    assert.strictEqual(buildImportRow('users', { ...base, salary_percent: '30%' }).payload.salary_percent, 30);
    assert.strictEqual(buildImportRow('users', { ...base, salary_fixed: '4 000 000' }).payload.salary_fixed, 4000000);
    for (const cells of [{ salary_percent: 'тридцать' }, { salary_fixed: '4 млн' }]) {
        const bad = buildImportRow('users', { ...base, ...cells });
        assert.strictEqual(bad.status, 'error', JSON.stringify(bad.notes));
        assert.ok(noteAbout(bad, Object.keys(cells)[0]), JSON.stringify(bad.notes));
    }
});

test('новые сообщения — на трёх языках, узбекский латиницей', () => {
    for (const k of [
        'Строка {n}: в колонке {col} не число («{v}») — оставлено сохранённое значение.',
        'Строка {n}: в колонке {col} не число («{v}») — строка не импортирована.',
        'Строка {n}: в колонке {col} не число («{v}») — записано {def}, как для пустой ячейки.',
        'Строка {n}: в колонке {col} не число («{v}») — не записано.',
        'Строка {n}, «{service}»: в колонке {col} не число («{v}») — ступень {step} из файла не сохранена.',
    ]) {
        const e = STRINGS[k];
        assert.ok(e && e.ru === k && e.uz && e.en, 'нет перевода: ' + k);
        assert.ok(!/[Ѐ-ӿ]/.test(e.uz), 'кириллица в узбекском: ' + e.uz);
        for (const ph of ['{n}', '{col}', '{v}']) assert.ok(e.uz.includes(ph) && e.en.includes(ph), ph + ' потерян в переводе: ' + k);
    }
});

// CLINIC_API_FIX_V1 (ревью 3) — ДОЛЯ ВНЕ 0…100 %. В колонке процентов (НДС,
// доли, процент зарплаты, скидки) 120 или −5 — не доля: для правила числа это
// то же, что не число. Новая строка не ввозится, обновляемая оставляет
// сохранённое; сообщение называет причину — «доля больше 100%» / «меньше 0%».
test('доля вне 0…100 %: новая услуга не ввозится, обновляемая оставляет сохранённое, причина названа', () => {
    const fresh = buildImportRow('services', { ...MIN, price: 1000, default_doctor_percent: '120' }, { rowNum: 3 });
    assert.strictEqual(fresh.status, 'error', JSON.stringify(fresh.notes));
    assert.strictEqual(noteAbout(fresh, 'default_doctor_percent'), 'Строка 3: в колонке default_doctor_percent доля больше 100% («120») — строка не импортирована.');

    const upd = buildImportRow('services', { ...MIN, tax_rate: '-5' }, { rowNum: 3, lookups: UPDATE() });
    assert.strictEqual(upd.status, 'warn', JSON.stringify(upd.notes));
    assert.ok(!('tax_rate' in upd.payload), 'НДС −5 записан');
    assert.strictEqual(noteAbout(upd, 'tax_rate'), 'Строка 3: в колонке tax_rate доля меньше 0% («-5») — оставлено сохранённое значение.');

    const pct = buildImportRow('services', { ...MIN, price: 1000, default_doctor_percent: '140%' });
    assert.strictEqual(pct.status, 'error');
});

test('доля 0 и 100 % — допустимы', () => {
    const row = buildImportRow('services', { ...MIN, price: 1000, default_doctor_percent: '100', tax_rate: '0' });
    assert.strictEqual(row.status, 'ok', JSON.stringify(row.notes));
    assert.strictEqual(row.payload.default_doctor_percent, 100);
    assert.strictEqual(row.payload.tax_rate, 0);
});

test('доля вне 0…100 % в ступени, товаре и зарплате — тоже отказ новой строки', () => {
    const tier = buildImportRow('services', { ...MIN, price: 1000, doctor_tier_from: 10, doctor_tier_percent: 120 }, { rowNum: 4 });
    assert.strictEqual(tier.status, 'error', JSON.stringify(tier.notes));
    assert.ok(noteAbout(tier, 'doctor_tier_percent').includes('доля больше 100%'), JSON.stringify(tier.notes));
    assert.strictEqual(buildImportRow('clinic_items', { name: 'Шприц', price: 1500, tax_rate: '150' }).status, 'error');
    assert.strictEqual(buildImportRow('users', { username: 'a.b', role: 'doctor', salary_percent: '101' }).status, 'error');
});

test('сообщения о доле вне 0…100 % — на трёх языках', () => {
    for (const k of ['Строка {n}: в колонке {col} {why} («{v}») — строка не импортирована.',
        'Строка {n}: в колонке {col} {why} («{v}») — оставлено сохранённое значение.',
        'доля больше 100%', 'доля меньше 0%']) {
        const e = STRINGS[k];
        assert.ok(e && e.ru === k && e.uz && e.en, 'нет перевода: ' + k);
    }
});

// CLINIC_API_FIX_V1 (ревью 3) — ДЕНЬГИ В РАЗДЕЛАХ ИЗ sections.js. Суммы кешбэка
// (min_purchase, max_cashback) и лимит страхового полиса (max_limit) не были
// помечены деньгами: «много» в них не отказывало строке. Доля определяется по
// КЛЮЧУ (percent/pct/tax_rate), а не по «%» в подписи: bonus_value — «% или
// сумма», и 150 в нём — допустимая сумма, а не доля больше 100 %.
const refusedFor = (section, raw, col) => {
    const row = buildImportRow(section, raw, { rowNum: 2 });
    return String(noteAbout(row, col) || '');
};
test('кешбэк и полис: не число в сумме — строка не ввозится', () => {
    assert.ok(refusedFor('cashback', { name: 'Кешбэк', min_purchase: 'много' }, 'min_purchase').includes('строка не импортирована'));
    assert.ok(refusedFor('cashback', { name: 'Кешбэк', max_cashback: 'без предела' }, 'max_cashback').includes('строка не импортирована'));
    assert.ok(refusedFor('payer_policies', { name: 'Полис', max_limit: 'без лимита' }, 'max_limit').includes('строка не импортирована'));
    assert.ok(refusedFor('doctor_referral_bonuses', { bonus_value: 'много' }, 'bonus_value').includes('строка не импортирована'));
});

test('бонус направившему 150 — сумма, а не доля больше 100 %; покрытие полиса 120 % — доля больше 100 %', () => {
    const bonus = buildImportRow('doctor_referral_bonuses', { bonus_value: '150' });
    assert.strictEqual(bonus.payload.bonus_value, 150);
    assert.ok(!noteAbout(bonus, 'bonus_value'), JSON.stringify(bonus.notes));
    assert.ok(refusedFor('payer_policies', { name: 'Полис', coverage_percentage: '120' }, 'coverage_percentage').includes('доля больше 100%'));
});

// CLINIC_API_FIX_V1 (ревью 3, решение) — ПУСТАЯ ДЕНЕЖНАЯ ЯЧЕЙКА НЕ ПИШЕТ 0.
//  • строка обновляет услугу — поле остаётся сохранённым (цена, НДС, доля,
//    цены визита, ступени), замечание «пусто — оставлено как было»;
//  • разделы, где новая ли строка, узнаётся только при импорте (товары,
//    закупка, сотрудники…), — поле не пишется никогда, замечание «пусто — не
//    записано»; колонки в листе нет — без замечаний;
//  • свой экспорт, импортированный обратно, ничего не меняет.
test('обновление: пустые НДС, доля, цена визита и ступень — сохранённые остаются', () => {
    const row = buildImportRow('services', { ...MIN, tax_rate: '', default_doctor_percent: '', price_secondary: '',
        doctor_tier_from: '', doctor_tier_percent: '' }, { rowNum: 3, lookups: UPDATE() });
    for (const k of ['tax_rate', 'default_doctor_percent', 'price_secondary', 'doctor_tier_from', 'doctor_tier_percent']) {
        assert.ok(!(k in row.payload), k + ' записано: ' + JSON.stringify(row.payload[k]));
    }
    assert.notStrictEqual(row.status, 'error', JSON.stringify(row.notes));
    for (const k of ['tax_rate', 'default_doctor_percent', 'price_secondary']) {
        assert.ok(row.notes.includes('Строка 3: ' + k + ' пусто — оставлено как было.'), k + ': ' + JSON.stringify(row.notes));
    }
});

test('обновление: полупара ступени — ступень из файла не пишется, сохранённая остаётся (не обнуляется)', () => {
    const row = buildImportRow('services', { ...MIN, doctor_tier_from: 20, doctor_tier_percent: '' }, { lookups: UPDATE() });
    assert.ok(!('doctor_tier_from' in row.payload) && !('doctor_tier_percent' in row.payload), JSON.stringify(row.payload));
    assert.strictEqual(row.status, 'warn');
});

test('товары, закупка, сотрудники: пустая денежная ячейка не пишется (не 0), колонки нет — без замечаний', () => {
    const item = buildImportRow('clinic_items', { name: 'Шприц', price: '', tax_rate: '' }, { rowNum: 2 });
    assert.ok(!('price' in item.payload) && !('tax_rate' in item.payload), JSON.stringify(item.payload));
    assert.ok(item.notes.includes('Строка 2: price пусто — не записано.'), JSON.stringify(item.notes));
    const proc = buildImportRow('procurement_items', { 'Товар': 'Шприц', 'Цена': '' });
    assert.ok(!('price' in proc.payload), JSON.stringify(proc.payload));
    const noCol = buildImportRow('procurement_items', { 'Товар': 'Шприц' });
    assert.ok(!('price' in noCol.payload), 'нет колонки «цена» — а цена записана: ' + JSON.stringify(noCol.payload.price));
    assert.deepEqual(noCol.notes, []);
    const staff = buildImportRow('users', { username: 'a.b', role: 'doctor', salary_fixed: '', salary_percent: '' }, { rowNum: 5 });
    assert.ok(!('salary_fixed' in staff.payload) && !('salary_percent' in staff.payload), JSON.stringify(staff.payload));
    assert.ok(staff.notes.includes('Строка 5: salary_fixed пусто — не записано.'), JSON.stringify(staff.notes));
    const staffNoCol = buildImportRow('users', { username: 'a.b', role: 'doctor' });
    assert.ok(!('salary_fixed' in staffNoCol.payload));
});

test('свой экспорт обратно (обновление): денежные поля не меняются', () => {
    const stored = { name: 'Приём кардиолога', price: 150000, tax_rate: 12, default_doctor_percent: 30,
        price_secondary: null, secondary_days_from: null, secondary_days_to: null, price_repeat: 0, repeat_days_from: 7, repeat_days_to: 30,
        doctor_tier_from: 25, doctor_tier_percent: 40, doctor_tier_from_2: 0, doctor_tier_percent_2: 0, doctor_tier_from_3: 0, doctor_tier_percent_3: 0,
        duration_minutes: 30 };
    // Экспорт пишет null пустой ячейкой, число — числом (exportSectionCell).
    const cell = (v) => (v == null ? '' : v);
    const raw = { name: stored.name, group: 'Консультация' };
    for (const k of Object.keys(stored)) if (k !== 'name') raw[k] = cell(stored[k]);
    const lookups = { __wantUpdate: true, __stored: new Map([['приём кардиолога', { ...stored }]]) };
    const row = buildImportRow('services', raw, { lookups });
    assert.notStrictEqual(row.status, 'error', JSON.stringify(row.notes));
    for (const k of Object.keys(stored)) {
        if (k === 'name' || !(k in row.payload)) continue;
        assert.strictEqual(row.payload[k], stored[k], k + ': ' + JSON.stringify(row.payload[k]) + ' вместо ' + JSON.stringify(stored[k]));
    }
});

test('сообщения о пустой денежной ячейке — на трёх языках', () => {
    for (const k of ['Строка {n}: {col} пусто — оставлено как было.', 'Строка {n}: {col} пусто — не записано.', 'Строка {n}: укажите цену (0 — если бесплатно).']) {
        const e = STRINGS[k];
        assert.ok(e && e.ru === k && e.uz && e.en, 'нет перевода: ' + k);
    }
});
