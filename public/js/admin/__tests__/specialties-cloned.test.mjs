// SPECIALTIES_CLONED_V1 — the doctor specialty list is medcore's 51, cloned into the app,
// plus two the owner asked for on 2026-10-02 (JOURNALS_V1_SPECIALTIES): 53.
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

test('53 специальности, Подолог среди них, у каждой — slug, uz и en; slug уникален', () => {
    assert.equal(SPECIALTY_ROWS.length, 53);   // JOURNALS_V1_SPECIALTIES — 51 + Иглотерапевт + Нейрофизиолог
    assert.ok(SPECIALTIES.includes('Подолог'), 'Подолог добавлен (владелец)');
    assert.ok(SPECIALTIES.includes('Отоларинголог (ЛОР)') && SPECIALTIES.includes('Семейный врач (ВОП)'));
    for (const r of SPECIALTY_ROWS) assert.ok(r.slug && r.ru && r.uz && r.en, 'неполная строка: ' + JSON.stringify(r));
    assert.equal(new Set(SPECIALTY_ROWS.map((r) => r.slug)).size, 53);   // JOURNALS_V1_SPECIALTIES
    for (const r of SPECIALTY_ROWS) assert.match(r.slug, /^[a-z0-9-]+$/, 'slug не ASCII: ' + r.slug);   // JOURNALS_V1_SPECIALTIES
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

// JOURNALS_V1_SPECIALTIES (владелец, 2026-10-02): «in the employees, we need to
// add 2 specialties, "иглотерапевт" and "нейрофизиолог"». По алфавиту листа:
// Иглотерапевт — перед Инфекционистом, Нейрофизиолог — перед Нейрохирургом.
test('Иглотерапевт и Нейрофизиолог — в списке по алфавиту, со слагом, uz и en; канон узнаёт их в любом регистре', () => {
    const at = (ru) => SPECIALTY_ROWS.findIndex((r) => r.ru === ru);
    assert.deepEqual(SPECIALTY_ROWS[at('Иглотерапевт')], { slug: 'igloterapevt', ru: 'Иглотерапевт', uz: 'Ignaterapevt', en: 'Acupuncturist' });
    assert.deepEqual(SPECIALTY_ROWS[at('Нейрофизиолог')], { slug: 'neyrofiziolog', ru: 'Нейрофизиолог', uz: 'Neyrofiziolog', en: 'Neurophysiologist' });
    assert.equal(at('Иглотерапевт') + 1, at('Инфекционист'));
    assert.equal(at('Диетолог') + 1, at('Иглотерапевт'));
    assert.equal(at('Нейрофизиолог') + 1, at('Нейрохирург'));
    assert.equal(at('Невролог') + 1, at('Нейрофизиолог'));
    assert.ok(specialtyOptions('').some(([v]) => v === 'Иглотерапевт') && specialtyOptions('').some(([v]) => v === 'Нейрофизиолог'), 'пункты выпадающего списка карточки');
    assert.ok(!specialtyOptions('Нейрофизиолог').some(([, l]) => /не из списка/.test(l)), 'сохранённый — уже из списка');
    assert.equal(canonicalSpecialty(' Иглотерапевт '), 'Иглотерапевт');
});
