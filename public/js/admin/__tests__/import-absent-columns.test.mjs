// CLINIC_API_FIX_V1 (ревью) — колонка, которой нет в файле, не меняет
// сохранённую услугу.
//
// Числовые, флаговые и ссылочные колонки импорта услуг писали значение по
// умолчанию и тогда, когда заголовка в листе нет вовсе: обновление прайс-листа
// файлом «название · раздел · цена» возвращало архивные услуги (active → true),
// ставило НДС 12 и 30 минут, «нужен врач», долю 0 % и стирало категорию,
// отделение и кабинет. Теперь при ОБНОВЛЕНИИ существующей услуги колонка без
// заголовка не трогается; новая услуга получает то же, что и раньше; пустая
// ячейка под своим заголовком значит то же, что и раньше.
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

// Файл из двух колонок: название и раздел (обе обязательны).
const MIN = { name: 'Приём кардиолога', group: 'Консультация' };
// Услуга «Приём кардиолога» уже есть, галочка «Обновлять существующие» стоит.
const UPDATE = () => ({ __wantUpdate: true, __stored: new Map([['приём кардиолога', { name: 'Приём кардиолога' }]]) });
// Та же услуга есть, но галочка снята — строка ляжет новой услугой.
const INSERT_TICK_OFF = () => ({ __wantUpdate: false, __stored: UPDATE().__stored });

const FLAGS = ['active', 'requires_doctor'];
const NUMBERS = ['price', 'tax_rate', 'duration_minutes', 'default_doctor_percent'];
const LINKS = ['category_id', 'department_id', 'room_id'];

test('обновление: флаги без колонки не трогаются — архивная услуга не возвращается, «нужен врач» не ставится', () => {
    const row = buildImportRow('services', MIN, { lookups: UPDATE() });
    for (const k of FLAGS) assert.ok(!(k in row.payload), k + ' = ' + JSON.stringify(row.payload[k]));
});

test('обновление: числа без колонки не трогаются — цена, НДС, длительность, доля; и без ложного «price пусто»', () => {
    const row = buildImportRow('services', MIN, { lookups: UPDATE() });
    for (const k of NUMBERS) assert.ok(!(k in row.payload), k + ' = ' + JSON.stringify(row.payload[k]));
    assert.strictEqual(row.status, 'ok', JSON.stringify(row.notes));
});

test('обновление: ссылки без колонки не стираются — категория, отделение, кабинет', () => {
    const row = buildImportRow('services', MIN, { lookups: UPDATE() });
    for (const k of LINKS) assert.ok(!(k in row.payload), k + ' = ' + JSON.stringify(row.payload[k]));
});

test('новая услуга (услуги нет или галочка снята): без колонки — те же значения, что и раньше; без цены — не ввозится', () => {
    for (const lookups of [{}, INSERT_TICK_OFF()]) {
        const row = buildImportRow('services', MIN, { lookups });
        assert.strictEqual(row.payload.active, true);
        assert.strictEqual(row.payload.requires_doctor, true);
        assert.strictEqual(row.payload.tax_rate, 12);
        assert.strictEqual(row.payload.duration_minutes, 30);
        assert.strictEqual(row.payload.default_doctor_percent, 0);
        for (const k of LINKS) assert.strictEqual(row.payload[k], null, k);
        // CLINIC_API_FIX_V1 (ревью 3, решение) — новая услуга без цены не ввозится (было: 0 с предупреждением).
        assert.ok(!('price' in row.payload), JSON.stringify(row.payload.price));
        assert.strictEqual(row.status, 'error', 'новая услуга без цены ввезена');
    }
});

test('обновление: пустая ячейка под своим заголовком — как и раньше; денежная — оставляет сохранённое', () => {
    const row = buildImportRow('services', { ...MIN, active: '', requires_doctor: '', price: '', tax_rate: '', duration_minutes: '',
        default_doctor_percent: '', category: '', department: '', room: '' }, { lookups: UPDATE() });
    assert.strictEqual(row.payload.active, true);
    assert.strictEqual(row.payload.requires_doctor, true);
    assert.strictEqual(row.payload.duration_minutes, 30);
    for (const k of LINKS) assert.strictEqual(row.payload[k], null, k);
    // CLINIC_API_FIX_V1 (ревью 3, решение) — цена, НДС и доля пустые: сохранённые
    // остаются (было: 0, 12 и 0 поверх сохранённых).
    for (const k of ['price', 'tax_rate', 'default_doctor_percent']) assert.ok(!(k in row.payload), k + ' = ' + JSON.stringify(row.payload[k]));
    assert.strictEqual(row.status, 'ok', JSON.stringify(row.notes));
});

test('обновление: заполненные колонки пишутся как раньше', () => {
    const row = buildImportRow('services', { ...MIN, active: 'false', requires_doctor: 'нет', price: '250 000', tax_rate: 0,
        duration_minutes: 45, default_doctor_percent: 30 }, { lookups: UPDATE() });
    assert.strictEqual(row.payload.active, false);
    assert.strictEqual(row.payload.requires_doctor, false);
    assert.strictEqual(row.payload.price, 250000);
    assert.strictEqual(row.payload.tax_rate, 0);
    assert.strictEqual(row.payload.duration_minutes, 45);
    assert.strictEqual(row.payload.default_doctor_percent, 30);
    assert.strictEqual(row.status, 'ok', JSON.stringify(row.notes));
});

// CLINIC_API_FIX_V1 (ревью) — ТИП УСЛУГИ. Колонки «type» в листе нет — тип
// подставлялся по «Разделу» и у обновляемой услуги: правка одних цен
// сбрасывала тип, выбранный клиникой («Кардиология» → «Консультации»). Теперь
// обновление без колонки типа тип не трогает — если «Раздел» услуги в файле
// тот же, что сохранён. Сменился «Раздел» — тип по новому разделу, как раньше.
const TYPED = ({ wantUpdate = true, type = 'consultation' } = {}) => ({
    __wantUpdate: wantUpdate,
    __stored: new Map([['приём кардиолога', { name: 'Приём кардиолога', type, type_id: 77 }]]),
    type: new Map([['кардиология', 77], ['консультации', 1]]),
});
const mirrorOf = (p) => p.type_id && p.type_id.__autoCreate && p.type_id.__autoCreate.value;

test('обновление без колонки типа, «Раздел» прежний — свой тип услуги не сбрасывается', () => {
    const row = buildImportRow('services', { ...MIN, price: 250000 }, { lookups: TYPED() });
    assert.ok(!('type_id' in row.payload), 'тип сброшен: ' + JSON.stringify(row.payload.type_id));
    assert.strictEqual(row.payload.type, 'consultation');
});

test('обновление без колонки типа, «Раздел» сменился — тип по новому разделу, как раньше', () => {
    const row = buildImportRow('services', { ...MIN, price: 250000 }, { lookups: TYPED({ type: 'lab' }) });
    assert.strictEqual(mirrorOf(row.payload), 'Консультации');
});

test('новая услуга без колонки типа — тип по «Разделу», как раньше', () => {
    for (const lookups of [TYPED({ wantUpdate: false }), {}]) {
        const row = buildImportRow('services', { ...MIN, price: 250000 }, { lookups });
        assert.strictEqual(mirrorOf(row.payload), 'Консультации');
    }
});

test('колонка типа есть: значение из справочника — оно; пустая ячейка — по «Разделу», как раньше', () => {
    const named = buildImportRow('services', { ...MIN, type: 'Кардиология' }, { lookups: TYPED() });
    assert.strictEqual(named.payload.type_id, 77);
    const blank = buildImportRow('services', { ...MIN, type: '' }, { lookups: TYPED() });
    assert.strictEqual(mirrorOf(blank.payload), 'Консультации');
});
