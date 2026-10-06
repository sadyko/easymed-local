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

test('не число в ячейке («—», «нет») — «не задано», а не бесплатно', () => {
    const row = buildImportRow('services', { ...BASE, ...EMPTY_TIERS, price_secondary: '—', price_repeat: 'нет', secondary_days_to: 'abc' });
    assert.strictEqual(row.payload.price_secondary, null);
    assert.strictEqual(row.payload.price_repeat, null);
    assert.strictEqual(row.payload.secondary_days_to, null);
    assert.strictEqual(sameDaySecond(row.payload).price, 200000);
});
