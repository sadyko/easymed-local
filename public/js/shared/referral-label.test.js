// REFERRAL_SOURCE_CODE_V1 + SEARCHABLE_SELECT_V1 — подпись партнёра и поиск по
// ней. Проверяются ВМЕСТЕ, потому что требование владельца («искать по имени
// или по номеру») выполняется не одним модулем, а их согласием: подпись ставит
// номер первым, а правило поиска ищет каждое слово запроса где угодно в строке.
// Разойдись они — поиск по номеру перестал бы работать, и ни один тест на
// отдельный модуль этого бы не заметил.
import test from 'node:test';
import assert from 'node:assert/strict';
import { referralSourceLabel } from './referral-label.js';
import { filterByLabel } from './text-match.js';

const SOURCES = [
  { code: '0001', name: 'Внешный врач' },
  { code: '0002', name: 'Dilshod Dilshod' },
  { code: '0007', name: 'Набиев Ойбек' },
  { code: '0012', name: 'Каххоров Сирожиддин' },
];
const items = SOURCES.map((s) => ({ label: referralSourceLabel(s) }));
const found = (q) => filterByLabel(items, q).map((i) => i.label);

test('подпись: номер впереди имени', () => {
  // Впереди — чтобы работал и набор с клавиатуры по обычному <select>, который
  // ищет с начала подписи.
  assert.equal(referralSourceLabel({ code: '0002', name: 'Dilshod Dilshod' }), '0002 · Dilshod Dilshod');
});

test('подпись: источник без номера остаётся именем, а не «undefined ·»', () => {
  assert.equal(referralSourceLabel({ name: 'Партнёр' }), 'Партнёр');
  assert.equal(referralSourceLabel({ code: '0003', name: '   ' }), '0003 · (без имени)');
  assert.equal(referralSourceLabel(null), '');
});

test('поиск по НОМЕРУ находит одного партнёра', () => {
  assert.deepEqual(found('0002'), ['0002 · Dilshod Dilshod']);
  assert.deepEqual(found('0007'), ['0007 · Набиев Ойбек']);
});

test('поиск по имени — латиницей и кириллицей, в любом регистре', () => {
  assert.deepEqual(found('dilshod'), ['0002 · Dilshod Dilshod']);
  assert.deepEqual(found('КАХХОРОВ'), ['0012 · Каххоров Сирожиддин']);
});

test('слова запроса ищутся в любом порядке — у стойки помнят имя, а не фамилию', () => {
  assert.deepEqual(found('ойбек наб'), ['0007 · Набиев Ойбек']);
});

test('пустой запрос не отсеивает никого, а несовпадение — всех', () => {
  assert.equal(found('').length, SOURCES.length);
  assert.deepEqual(found('нет такого'), []);
});
