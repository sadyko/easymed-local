// CLINIC_API_FIX_V1 — импорт Excel не обнуляет цены второго и повторного визита.
//
// price_secondary / price_repeat и их окна (мигр. 127, 130) ПУСТЫЕ, пока
// клиника их не задала: пусто — «как первый визит». Импорт писал в них 0 и
// когда колонок в листе нет, и когда ячейка пустая (а выгрузка пишет пустую
// ячейку у каждой услуги без ступеней). Для цены визита 0 — это «бесплатно»:
// visit-tier.js видит у услуги ступени, окно 0…0 дней, и второй визит в тот
// же день выставлялся по 0. Здесь — что попадает в строку и что из неё
// насчитает касса.
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
const { buildImportRow } = await import('../views/section-import-export.js');
const { tierFor } = await import('../../../../server/services/domain/visit-tier.js');

const BASE = { name: 'Приём кардиолога', group: 'Консультация', price: 200000 };
const TIER_KEYS = ['price_secondary', 'secondary_days_from', 'secondary_days_to', 'price_repeat', 'repeat_days_from', 'repeat_days_to'];
const EMPTY_TIERS = Object.fromEntries(TIER_KEYS.map((k) => [k, '']));

// Цена строки визита по услуге, собранной из импортированной строки: второй
// визит в тот же день после первичного.
const sameDaySecond = (payload) => tierFor({ ...payload }, { day: '2026-10-06', tier: 'primary' }, '2026-10-06');

test('колонок цен визита в листе нет — цены и окна не трогаются (старый файл не обнуляет настройку)', () => {
    const row = buildImportRow('services', { ...BASE });
    for (const k of TIER_KEYS) assert.ok(!(k in row.payload), k + ' попал в строку: ' + JSON.stringify(row.payload[k]));
    assert.strictEqual(row.status, 'ok');
});

test('пустые ячейки под своими заголовками — «не задано» (null), а не 0; второй визит в тот же день — по полной цене', () => {
    const row = buildImportRow('services', { ...BASE, ...EMPTY_TIERS });
    for (const k of TIER_KEYS) assert.strictEqual(row.payload[k], null, k);
    const q = sameDaySecond(row.payload);
    assert.strictEqual(q.price, 200000, 'второй визит выставлен по ' + q.price + ' — пустая ячейка стала «бесплатно»');
    assert.strictEqual(q.tier, 'primary');
});

test('заполненные ячейки читаются как раньше; 0 в цене повторного визита — осознанное «бесплатно»', () => {
    const row = buildImportRow('services', { ...BASE, ...EMPTY_TIERS,
        price_secondary: '60 000', secondary_days_from: 1, secondary_days_to: 6, price_repeat: 0, repeat_days_from: '', repeat_days_to: '' });
    assert.strictEqual(row.payload.price_secondary, 60000);
    assert.strictEqual(row.payload.secondary_days_from, 1);
    assert.strictEqual(row.payload.secondary_days_to, 6);
    assert.strictEqual(row.payload.price_repeat, 0);
    assert.strictEqual(row.payload.repeat_days_from, null);
    assert.strictEqual(row.payload.repeat_days_to, null);
    const q = tierFor({ ...row.payload }, { day: '2026-10-03', tier: 'primary' }, '2026-10-06');
    assert.deepStrictEqual([q.tier, q.price], ['secondary', 60000]);
});

// CLINIC_API_FIX_V1 (ревью итога, решение) — цена визита — деньги: не число
// в ней у НОВОЙ услуги строку не ввозит (как цена); в днях окна — «не задано».
test('не число в днях окна («abc») — «не задано», а не бесплатно', () => {
    const row = buildImportRow('services', { ...BASE, ...EMPTY_TIERS, price_secondary: 60000, secondary_days_from: 1, secondary_days_to: 'abc' });
    assert.strictEqual(row.payload.secondary_days_to, null);
    assert.notStrictEqual(row.status, 'error');
});

test('не число в цене визита («—», «нет») у новой услуги — строка не ввозится, а не «бесплатно» и не «не задано» молча', () => {
    for (const cells of [{ price_secondary: '—' }, { price_repeat: 'нет' }]) {
        const row = buildImportRow('services', { ...BASE, ...EMPTY_TIERS, ...cells });
        assert.strictEqual(row.status, 'error', JSON.stringify(row.notes));
    }
});

// CLINIC_API_FIX_V1 (ревью) — ячейка не число: строка ГОВОРИТ об этом (номер
// строки и колонка), а не молча ставит полную цену. (Ревью итога: у новой
// услуги — ошибкой, строка не ввозится.)
test('не число в ячейке цены визита — ошибка с номером строки и колонкой', () => {
    const row = buildImportRow('services', { ...BASE, ...EMPTY_TIERS, price_secondary: '—' }, { rowNum: 4 });
    assert.strictEqual(row.status, 'error');
    const note = row.notes.find((n) => /price_secondary/.test(String(n)));
    assert.ok(note, JSON.stringify(row.notes));
    assert.match(String(note), /Строка 4\b/);
    assert.match(String(note), /не число/);
});

// CLINIC_API_FIX_V1 (ревью) — правила окна услуги (service_save,
// VISIT_TIER_PRICING_V1 / REPEAT_WINDOW_V1): цена — неотрицательное число,
// дни — целые неотрицательные, «по» не раньше «с», окно без цены не задаётся.
// Строка, нарушившая правило, цен второго и повторного визита из файла не
// пишет (остаются прежние / не заданы) и говорит почему; остальное ложится.
const tierDropped = (row) => TIER_KEYS.every((k) => !(k in row.payload));
const CASES = [
    ['отрицательная цена', { price_secondary: -5000, secondary_days_from: 1, secondary_days_to: 6 }, /price_secondary — неотрицательное число/],
    ['дробные дни', { price_secondary: 60000, secondary_days_from: 1.5, secondary_days_to: 6 }, /secondary_days_from — целое неотрицательное число дней/],
    ['отрицательные дни', { price_repeat: 0, repeat_days_from: -1 }, /repeat_days_from — целое неотрицательное число дней/],
    ['окно второго визита наоборот', { price_secondary: 60000, secondary_days_from: 6, secondary_days_to: 1 }, /Окно второго визита: «по день» не может быть раньше «со дня»/],
    ['окно повторного визита наоборот', { price_repeat: 0, repeat_days_from: 10, repeat_days_to: 3 }, /Окно повторного визита: «не позже чем через» не может быть раньше «не раньше чем через»/],
    ['окно второго визита без цены', { secondary_days_from: 1, secondary_days_to: 6 }, /Укажите цену второго визита/],
    ['окно повторного визита без цены', { repeat_days_from: 7 }, /Укажите цену повторного визита/],
];
for (const [what, cells, re] of CASES) {
    test('правило окна услуги: ' + what + ' — цены визитов строки не пишутся, предупреждение', () => {
        const row = buildImportRow('services', { ...BASE, ...EMPTY_TIERS, ...cells, tax_rate: 12 }, { rowNum: 9 });
        assert.ok(tierDropped(row), 'цены визитов записаны: ' + JSON.stringify(row.payload));
        assert.strictEqual(row.payload.price, 200000, 'остальная строка ложится');
        assert.strictEqual(row.status, 'warn');
        const note = row.notes.find((n) => re.test(String(n)));
        assert.ok(note, JSON.stringify(row.notes));
        assert.match(String(note), /Строка 9\b/);
        assert.ok(String(note).includes('Приём кардиолога'));
    });
}

test('обновление: правило проверяется по тому, что окажется у услуги (файл поверх сохранённого)', () => {
    const stored = (extra) => ({ __wantUpdate: true, __stored: new Map([['приём кардиолога', {
        name: 'Приём кардиолога', price_secondary: 60000, secondary_days_from: 1, secondary_days_to: 6, price_repeat: null, repeat_days_from: null, repeat_days_to: null, ...extra }]]) });
    // Файл стирает цену второго визита, окно у услуги остаётся — окно без цены: отказ.
    const bad = buildImportRow('services', { ...BASE, price_secondary: '' }, { rowNum: 3, lookups: stored() });
    assert.ok(tierDropped(bad), JSON.stringify(bad.payload));
    assert.ok(bad.notes.some((n) => /Укажите цену второго визита/.test(String(n))), JSON.stringify(bad.notes));
    // У услуги есть цена повторного визита — окну есть что применять.
    const ok = buildImportRow('services', { ...BASE, price_secondary: '' }, { rowNum: 3, lookups: stored({ price_repeat: 0 }) });
    assert.strictEqual(ok.payload.price_secondary, null);
    assert.strictEqual(ok.status, 'ok', JSON.stringify(ok.notes));
    // Файл сдвигает «по день» раньше сохранённого «со дня» — отказ.
    const order = buildImportRow('services', { ...BASE, secondary_days_to: 0 }, { rowNum: 3, lookups: stored({ secondary_days_from: 2 }) });
    assert.ok(tierDropped(order));
    assert.ok(order.notes.some((n) => /«по день» не может быть раньше «со дня»/.test(String(n))), JSON.stringify(order.notes));
});

test('допустимые значения — как раньше, без предупреждений', () => {
    const row = buildImportRow('services', { ...BASE, ...EMPTY_TIERS, price_secondary: 60000, secondary_days_from: 0, secondary_days_to: 6,
        price_repeat: 0, repeat_days_from: 7, repeat_days_to: 30 });
    assert.strictEqual(row.status, 'ok', JSON.stringify(row.notes));
    assert.deepStrictEqual(TIER_KEYS.map((k) => row.payload[k]), [60000, 0, 6, 0, 7, 30]);
});
