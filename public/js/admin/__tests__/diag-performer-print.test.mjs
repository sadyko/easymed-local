// DIAG_ROUTE_V1 · 3.22.0 (решение владельца 2026-11-07, п. 9) — НА ПЕЧАТИ ДИАГНОСТИКИ — ВРАЧ,
// КОТОРЫЙ ВЫПОЛНИЛ ИССЛЕДОВАНИЕ.
//
// Имя врача в бланке исследования стояло только в блоке подписи (.sig), а он скрыт правилом
// `.sheet:not(.show-signature) .sig{display:none}` — класс show-signature не выдаётся никогда
// (NO_FAKE_MARKS_V1, toggleCls). На бумаге имени того, кто делал УЗИ, не было вовсе. Теперь
// строка «Выполнил» стоит в шапке (классический) и в блоке «Исследование» (компактный) — вне
// подписи; имя — врач строки (radiologist, его ставит diagDocData), а у старого листа без него —
// doctorName (заключение визита, patient-documents.js printConclusion). Нет имени — нет строки.
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {}, clear() {} };
globalThis.window = { location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, innerWidth: 1440, addEventListener() {} };
globalThis.document = { createElement: () => ({ style: {}, appendChild() {}, setAttribute() {} }), head: { appendChild() {} }, body: { appendChild() {} }, addEventListener() {}, getElementById: () => null, querySelector: () => null, documentElement: { style: {} } };

const { renderDesignedVariant } = await import('../views/doc-variants.js');

const S = { accent: '#167873', ink: '#16213f', clinicName: 'Клиника' };
const VARIANTS = ['classic', 'compact'];
const base = (extra = {}) => ({ patientName: 'Азизов Бахтиёр', mrn: 'P-1', service: 'УЗИ почек', description: 'Почки в норме.', conclusion: 'Патологии нет.', ...extra });
// Текст листа БЕЗ скрытого блока подписи (.signoff — подпись, которую печать прячет).
const visible = (html) => html.replace(/<style[\s\S]*?<\/style>/g, '')
  .replace(/<div class="signoff">[\s\S]*?<div class="sign-right"><\/div><\/div>/g, ' ')
  .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('бланк диагностики печатает «Выполнил» с врачом строки — вне скрытой подписи, в обоих вариантах', () => {
  for (const v of VARIANTS) {
    const html = renderDesignedVariant('diag', v, S, base({ radiologist: 'Каримова Дилноза Анваровна', radiologistSpec: 'Врач УЗИ' }));
    const t = visible(html);
    assert.match(t, /Выполнил/, v + ': строки «Выполнил» нет');
    assert.match(t, /Каримова Д\. А\./, v + ': имени врача, выполнившего исследование, нет на видимой части листа');
  }
});

test('старый лист без radiologist (заключение визита) — «Выполнил» из doctorName; без имени строки нет', () => {
  for (const v of VARIANTS) {
    assert.match(visible(renderDesignedVariant('diag', v, S, base({ doctorName: 'Усмонов Тимур' }))), /Выполнил[^А-Яа-я]*Усмонов Т\./, v);
    assert.doesNotMatch(visible(renderDesignedVariant('diag', v, S, base())), /Выполнил/, v + ': пустая строка «Выполнил»');
  }
});

test('подпись в блоке подписи тоже берёт doctorName у старого листа, а не прочерк', () => {
  for (const v of VARIANTS) {
    const html = renderDesignedVariant('diag', v, S, base({ doctorName: 'Усмонов Тимур' }));
    assert.match(html, /<div class="name">Усмонов Тимур<\/div>/, v);
  }
});
