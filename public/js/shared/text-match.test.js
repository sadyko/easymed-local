// TEXT_MATCH_V1 — правила поиска по длинному списку имён (список врачей и т.п.).

import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesQuery, filterByLabel } from './text-match.js';

// Настоящий список из стационара — тот самый, что не помещался на экран.
const DOCS = [
  { value: '', label: '— Лечащий врач —' },
  { value: '1', label: 'Doctor test' },
  { value: '2', label: 'Азимова Барно' },
  { value: '3', label: 'Бесчастный Николай' },
  { value: '4', label: 'Набиев Ойбек' },
  { value: '5', label: 'Нармурадов Умар' },
  { value: '6', label: 'Норматов Маъруфжон' },
  { value: '7', label: 'Усмонкулов Шароф' },
];
const labels = (rows) => rows.map((r) => r.label);

test('пустой запрос показывает весь список', () => {
  assert.equal(filterByLabel(DOCS, '').length, DOCS.length);
  assert.equal(filterByLabel(DOCS, '   ').length, DOCS.length);
});

test('поиск по фамилии', () => {
  assert.deepEqual(labels(filterByLabel(DOCS, 'наб')), ['Набиев Ойбек']);
});

test('поиск по ИМЕНИ, а не только по фамилии', () => {
  assert.deepEqual(labels(filterByLabel(DOCS, 'ойбек')), ['Набиев Ойбек']);
});

test('слова в любом порядке — у стойки помнят имя, а в списке первая фамилия', () => {
  assert.deepEqual(labels(filterByLabel(DOCS, 'ойбек наб')), ['Набиев Ойбек']);
  assert.deepEqual(labels(filterByLabel(DOCS, 'наб ойб')), ['Набиев Ойбек']);
});

test('регистр не важен; латиница ищется так же', () => {
  assert.deepEqual(labels(filterByLabel(DOCS, 'DOCTOR')), ['Doctor test']);
  assert.deepEqual(labels(filterByLabel(DOCS, 'АЗИМ')), ['Азимова Барно']);
});

test('общая часть даёт несколько попаданий', () => {
  assert.deepEqual(labels(filterByLabel(DOCS, 'нар')), ['Нармурадов Умар']);
  assert.equal(filterByLabel(DOCS, 'ов').length, 4, 'Азимова, Нармурадов, Норматов, Усмонкулов');
});

test('ничего не найдено — пустой список, а не весь справочник', () => {
  assert.deepEqual(filterByLabel(DOCS, 'жжж'), []);
});

test('матчер: должны совпасть ВСЕ слова', () => {
  assert.equal(matchesQuery('Набиев Ойбек', 'наб ойб'), true);
  assert.equal(matchesQuery('Набиев Ойбек', 'наб азим'), false);
  assert.equal(matchesQuery(null, 'наб'), false);
  assert.equal(matchesQuery('Набиев', ''), true);
});

test('пустой/битый вход не роняет', () => {
  assert.deepEqual(filterByLabel(null, 'наб'), []);
  assert.deepEqual(filterByLabel([{ value: '1' }], 'наб'), [], 'элемент без label просто не совпадает');
});
