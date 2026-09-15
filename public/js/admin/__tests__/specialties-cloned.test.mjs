// SPECIALTIES_CLONED_V1 — the doctor specialty list is medcore's 51, cloned into the app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
globalThis.localStorage = { getItem: (k) => (k === 'admin.lang' ? 'ru' : null), setItem() {}, removeItem() {}, clear() {} };
globalThis.window = { location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, addEventListener() {} };
globalThis.document = { documentElement: { lang: 'ru', setAttribute() {} }, addEventListener() {} };
const { SPECIALTIES, SPECIALTY_ROWS, specialtyOptions, canonicalSpecialty } = await import('../specialties.js');

test('51 специальность, Подолог среди них, у каждой — slug, uz и en; slug уникален', () => {
    assert.equal(SPECIALTY_ROWS.length, 51);
    assert.ok(SPECIALTIES.includes('Подолог'), 'Подолог добавлен (владелец)');
    assert.ok(SPECIALTIES.includes('Отоларинголог (ЛОР)') && SPECIALTIES.includes('Семейный врач (ВОП)'));
    for (const r of SPECIALTY_ROWS) assert.ok(r.slug && r.ru && r.uz && r.en, 'неполная строка: ' + JSON.stringify(r));
    assert.equal(new Set(SPECIALTY_ROWS.map((r) => r.slug)).size, 51);
    const dict = fs.readFileSync(path.join(HERE, '..', 'i18n-strings.js'), 'utf8');
    for (const r of SPECIALTY_ROWS) assert.ok(dict.includes('\n  "' + r.ru + '": {'), 'нет перевода для ' + r.ru);
});

test('старые написания приводятся к medcore-названию; незнакомое — остаётся с пометкой «не из списка»', () => {
    assert.equal(canonicalSpecialty('Оториноларинголог (ЛОР)'), 'Отоларинголог (ЛОР)');
    assert.equal(canonicalSpecialty('Врач УЗД'), 'Врач УЗИ');
    assert.equal(canonicalSpecialty('Кардиолог'), 'Кардиолог');
    const opts = specialtyOptions('ЛОР');
    assert.ok(!opts.some(([v]) => v === 'ЛОР'), 'старое «ЛОР» не становится отдельным пунктом');
    const kept = specialtyOptions('Косметолог');
    assert.ok(kept.some(([v, l]) => v === 'Косметолог' && /не из списка/.test(l)), 'значение вне списка сохраняется и подписано');
});
