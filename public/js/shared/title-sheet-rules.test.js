// TITLE_SHEET_V1 — правила титульного листа: числа, ИМТ, полнота.
import test from 'node:test';
import assert from 'node:assert/strict';
import { numOrNull, bmiOf, sheetCompleteness, MEASURES, REQUIRED_KEYS } from './title-sheet-rules.js';

test('numOrNull: запятая = точка, пусто = null, мусор = NaN', () => {
    assert.equal(numOrNull('72,5'), 72.5);
    assert.equal(numOrNull(' 172 '), 172);
    assert.equal(numOrNull(''), null);
    assert.equal(numOrNull(null), null);
    assert.ok(Number.isNaN(numOrNull('abc')));
    assert.ok(Number.isNaN(numOrNull('1.2.3')));
});

test('bmiOf: одна цифра после запятой, без роста или веса — null', () => {
    assert.equal(bmiOf(172, 80), 27.0);
    assert.equal(bmiOf('172', '72,5'), 24.5);
    assert.equal(bmiOf('', 80), null);
    assert.equal(bmiOf(172, ''), null);
    assert.equal(bmiOf('x', 80), null);
});

test('sheetCompleteness: шесть измерений и два ответа медсестры', () => {
    assert.deepEqual(REQUIRED_KEYS, ['height_cm', 'weight_kg', 'temp_c', 'bp_sys', 'bp_dia', 'pulse_bpm', 'pediculosis', 'sanitation']);
    assert.deepEqual(sheetCompleteness(null), { complete: false, missing: REQUIRED_KEYS.slice() });
    const full = { height_cm: 172, weight_kg: 80, temp_c: 36.6, bp_sys: 120, bp_dia: 80, pulse_bpm: 72, pediculosis: 'none', sanitation: 'full', note: '' };
    assert.deepEqual(sheetCompleteness(full), { complete: true, missing: [] });
    assert.deepEqual(sheetCompleteness(Object.assign({}, full, { weight_kg: null, sanitation: '' })),
        { complete: false, missing: ['weight_kg', 'sanitation'] });
});

test('диапазоны — те, что в спецификации', () => {
    assert.deepEqual(Object.keys(MEASURES), ['height_cm', 'weight_kg', 'temp_c', 'bp_sys', 'bp_dia', 'pulse_bpm']);
    assert.deepEqual([MEASURES.height_cm.min, MEASURES.height_cm.max], [30, 250]);
    assert.deepEqual([MEASURES.bp_dia.min, MEASURES.bp_dia.max, MEASURES.bp_dia.int], [20, 200, true]);
});
