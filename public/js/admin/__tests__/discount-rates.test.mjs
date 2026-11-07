// DISCOUNT_RATES_V1 (3.22.0) — ставки скидки по группе, категории и услуге: одно правило
// у сервера и экранов (discount-rates.js). Самая точная ставка побеждает: услуга >
// категория > группа > процент скидки. 0 % — без скидки, 100 % — бесплатно.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRates, hasRates, rateGroupOf, lineDiscountPct, ratedDiscount, ratesSummary, cleanRates, RATE_GROUPS } from '../discount-rates.js';

const CONSULT = { id: 1, type: 'consultation', category_id: 7 };
const UZI = { id: 2, type: 'imaging', category_id: 8 };
const CBC = { id: 3, type: 'lab', is_lab: 1, category_id: 9 };
const XRAY = { id: 4, type: 'radiology', category_id: null };

test('ставки читаются из строки и объекта; мусор отбрасывается; процент зажат 0..100', () => {
    assert.deepEqual(parseRates('{"g":{"consultation":100,"bogus":5},"c":{"7":"50","x":3},"s":{"2":0,"3":150,"4":-5,"5":null,"6":""}}'),
        { g: { consultation: 100 }, c: { 7: 50 }, s: { 2: 0, 3: 100, 4: 0 } });
    assert.deepEqual(parseRates(null), { g: {}, c: {}, s: {} });
    assert.deepEqual(parseRates('не json'), { g: {}, c: {}, s: {} });
    assert.deepEqual(parseRates([1, 2]), { g: {}, c: {}, s: {} });
    assert.equal(hasRates('{}'), false);
    assert.equal(hasRates({ g: { lab: 0 } }), true, 'явный 0 % — тоже ставка');
    assert.deepEqual(RATE_GROUPS, ['consultation', 'imaging', 'lab', 'procedure', 'other']);
});

test('группа услуги: тип услуги; «Лучевая диагностика» — Диагностика; консультация по виду приёма — Консультации; товар — без группы', () => {
    assert.equal(rateGroupOf(CONSULT), 'consultation');
    assert.equal(rateGroupOf(XRAY), 'imaging');
    assert.equal(rateGroupOf({ id: 9, type: '', is_lab: 1 }), 'lab');
    assert.equal(rateGroupOf({ consultation: true }), 'consultation');
    assert.equal(rateGroupOf(null), null);
});

test('самая точная ставка: услуга > категория > группа > процент скидки', () => {
    const d = { pct: 20, rates: { g: { consultation: 100, imaging: 30 }, c: { 8: 40 }, s: { 2: 0 } } };
    assert.equal(lineDiscountPct(d, CONSULT), 100, 'группа');
    assert.equal(lineDiscountPct(d, UZI), 0, 'услуга 0 % сильнее категории и группы');
    assert.equal(lineDiscountPct({ ...d, rates: { g: { imaging: 30 }, c: { 8: 40 } } }, UZI), 40, 'категория сильнее группы');
    assert.equal(lineDiscountPct(d, CBC), 20, 'без ставки — процент скидки');
    assert.equal(lineDiscountPct(d, null), 20, 'товар — процент скидки');
    assert.equal(lineDiscountPct(null, CONSULT), 0);
    assert.equal(lineDiscountPct({ pct: 20, rates: {} }, UZI), 20, 'без ставок — как прежде');
});

test('«Только на эти услуги»: вне списка — 0 %, внутри — ставки', () => {
    const d = { pct: 10, rates: { g: { imaging: 50 } }, scope: [2, 3] };
    assert.equal(lineDiscountPct(d, CONSULT), 0);
    assert.equal(lineDiscountPct(d, UZI), 50);
    assert.equal(lineDiscountPct(d, CBC), 10);
    assert.equal(lineDiscountPct(d, null), 0, 'товар вне списка');
});

test('скидка сметы по ставкам: «Сотрудники» 20 %, Консультации 100 % — консультация 100 000 → 0, УЗИ 200 000 → 160 000', () => {
    const d = { pct: 20, rates: { g: { consultation: 100 } } };
    const r = ratedDiscount(d, [{ service: CONSULT, total: 100000 }, { service: UZI, total: 200000 }]);
    assert.deepEqual(r.lines.map((l) => [l.pct, l.off]), [[100, 100000], [20, 40000]]);
    assert.equal(r.total, 140000);
    assert.equal(300000 - r.total, 160000);
    assert.equal(ratedDiscount(d, [{ service: UZI, total: 33333 }]).total, 6666.6, 'до 0,01 по строке, как round2 сервера');
});

test('сводка у строки скидки: процент по умолчанию, группы со ставками, число категорий и услуг', () => {
    assert.deepEqual(ratesSummary(20, { g: { consultation: 100 }, c: { 7: 0 }, s: { 1: 0, 2: 5, 3: 50 } }),
        { def: 20, groups: [{ key: 'consultation', pct: 100 }], categories: 1, services: 3 });
    assert.equal(ratesSummary(20, {}), null, 'без ставок сводки нет');
});

test('чистка перед записью: пустые поля уходят, числа — числами, порядок групп — фиксированный', () => {
    assert.deepEqual(cleanRates({ g: { lab: '', consultation: '100' }, c: { 7: null }, s: { 2: '0' } }), { g: { consultation: 100 }, s: { 2: 0 } });
    assert.deepEqual(cleanRates({}), {});
});

test('смета = счёт: «Скидка группы» и прежний экран — ставки; «вручную» больше ставок — своя скидка; промокод со ставками', async () => {
    const { ratedOutcome } = await import('../discount-rates.js');
    const group = { name: 'Сотрудники', pct: 20, rates: { g: { consultation: 100 } } };
    const lines = [{ service: CONSULT, total: 100000 }, { service: UZI, total: 200000 }];
    assert.equal(ratedOutcome({ key: 'group', group, sent: 999999, lines }).off, 140000, 'группа — присланное не важно');
    assert.equal(ratedOutcome({ key: null, group, sent: 0, lines }).rated, true);
    assert.deepEqual([ratedOutcome({ key: 'manual', group, sent: 200000, lines }).rated, ratedOutcome({ key: 'manual', group, sent: 140000, lines }).rated], [false, true]);
    assert.equal(ratedOutcome({ key: 'none', group, lines }), null);
    assert.equal(ratedOutcome({ key: 'group', group: { name: 'VIP', pct: 10 }, lines }), null, 'без ставок — прежнее правило экрана');
    const promo = { id: 5, kind: 'promo', percent: 10, service_ids: [2], discount_rates: '{"c":{"8":50}}' };
    assert.equal(ratedOutcome({ key: 'promo:5', group, promo, lines }).off, 100000, 'промокод только на УЗИ, категория 50 %');
    assert.equal(ratedOutcome({ key: 'promo:5', promo: { ...promo, percent: 0, amount: 5000 }, lines }), null, 'промокод суммой ставок не знает');
});
