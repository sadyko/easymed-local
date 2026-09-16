// LAB_BLANK_COLUMNS_V1 + LAB_BAR_FROM_REF_V1 (2026-09-16)
//
// Владелец прислал напечатанный бланк: один показатель «Пенициллин —
// устойчивый», и рядом четыре пустые графы — «Ед. —», «Референс —»,
// «Диапазон», «Флаг», плюс легенда «выше нормы / ниже нормы». И вторая беда:
// «в лаборатории диапазон не работает».
//
// Правила, которые держит этот тест:
//   1. графа печатается, только если её заполняет хотя бы одна строка;
//   2. легенда отклонений — только когда есть флаги или полоски;
//   3. числовой бланк печатается целиком, как раньше;
//   4. полоска «Диапазон» строится по ТОЙ ЖЕ норме, что напечатана в графе
//      «Референс» — то есть по справочнику, а не только по границам,
//      сохранённым в самой строке результата.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSheetHtml } from '../../shared/doc-render.js';
import { labPosCell, labPosFor, labBounds, labValueNumber } from '../views/lab-doc.js';

const S = { clinicName: 'Клиника', accent: '#0f766e', ink: '#16213f' };
const sheet = (tests, variant) => buildSheetHtml({
    type: 'lab', s: variant ? { ...S, variant: { lab: variant } } : S,
    data: { patientName: 'Тест Т.', groups: [{ title: 'Анализ', tests }] },
});
const headers = (html) => [...html.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)]
    .map((m) => m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());

const WORDS = [{ name: 'Пенициллин', value: 'Устойчивый', unit: '', ref: '', flag: '', pos: null }];
const NUMBERS = [{ name: 'Лейкоциты', code: 'WBC', value: '6,8', unit: '×10⁹/л', ref: '4,0 – 9,0', flag: 'N', pos: 54 }];

test('анализ словами печатается двумя графами — без единиц, диапазона и флага', () => {
    const html = sheet(WORDS);
    const th = headers(html).join(' | ');
    assert.match(th, /Показатель/);
    assert.match(th, /Результат/);
    assert.ok(!/Ед\./.test(th), 'единиц у слова нет');
    assert.ok(!/Референс/.test(th), 'нормы-числа у слова нет');
    assert.ok(!/Диапазон/.test(th), 'полоске нечего показывать');
    assert.ok(!/Флаг/.test(th), 'флага у слова нет');
    assert.ok(!/class="legend"/.test(html), 'легенда отклонений тоже лишняя');
    assert.match(html, /Устойчивый/, 'сам результат на месте');
});

test('текстовая норма из справочника графу возвращает', () => {
    const html = sheet([{ name: 'Белок', value: 'Отрицательно', unit: '', ref: 'Отрицательно', flag: '', pos: null }]);
    const th = headers(html).join(' | ');
    assert.match(th, /Референс/, 'норма задана — графа нужна');
    assert.ok(!/Ед\./.test(th) && !/Диапазон/.test(th), 'остальные по-прежнему не нужны');
});

test('числовой бланк печатается целиком', () => {
    const html = sheet(NUMBERS);
    const th = headers(html).join(' | ');
    for (const c of ['Показатель', 'Результат', 'Ед.', 'Референс', 'Диапазон', 'Флаг']) {
        assert.ok(th.includes(c), 'графа ' + c);
    }
    assert.match(html, /class="legend"/, 'легенда объясняет флаги');
    assert.match(html, /class="range"/, 'полоска нарисована');
});

test('ширины граф делят лист целиком, сколько бы их ни осталось', () => {
    for (const rows of [WORDS, NUMBERS]) {
        const w = [...sheet(rows).matchAll(/<col style="width:([\d.]+)%">/g)].map((m) => Number(m[1]));
        assert.ok(w.length >= 2);
        assert.ok(Math.abs(w.reduce((a, b) => a + b, 0) - 100) < 0.5, 'сумма ширин ≈ 100%');
    }
});

test('короткий бланк (compact) живёт по тому же правилу', () => {
    const th = headers(sheet(WORDS, 'compact')).join(' | ');
    assert.match(th, /Показатель/);
    assert.ok(!/Ед\./.test(th) && !/Флаг/.test(th));
});

// ── полоска по норме показателя ─────────────────────────────────────────────
test('полоска рисуется по норме справочника, когда в строке границ нет', () => {
    const row = { value: '6,8' };                       // ни numeric_value, ни ref_low/high
    assert.equal(labPosFor(row), null, 'старое правило метки не давало');
    const pos = labPosCell(row, { ref_low: 4, ref_high: 9 }, '');
    assert.ok(pos > 22 && pos < 78, 'значение внутри нормы — метка внутри полосы');
});

test('границы самой строки важнее справочника: лист показывает ту норму, по которой оценивали', () => {
    assert.deepEqual(labBounds({ ref_low: 1, ref_high: 2 }, { ref_low: 4, ref_high: 9 }, 'male'), [1, 2]);
});

test('норма по полу пациента идёт раньше общей', () => {
    const a = { ref_low: 4, ref_high: 9, ref_low_f: 3, ref_high_f: 8, ref_low_m: 5, ref_high_m: 10 };
    assert.deepEqual(labBounds({}, a, 'female'), [3, 8]);
    assert.deepEqual(labBounds({}, a, 'male'), [5, 10]);
    assert.deepEqual(labBounds({}, a, ''), [4, 9], 'пол неизвестен — общая норма');
});

test('слово числом не станет, и полоски у него не будет', () => {
    assert.equal(labValueNumber({ value: 'Устойчивый' }), null);
    assert.equal(labPosCell({ value: 'Устойчивый' }, { ref_low: 4, ref_high: 9 }, ''), null);
    assert.equal(labValueNumber({ value: '6,8' }), 6.8, 'запятая — обычная запись бланка');
});
