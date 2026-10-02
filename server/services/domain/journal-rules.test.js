// JOURNALS_V1 — правила журналов без базы: таблица примеров.
import test from 'node:test';
import assert from 'node:assert/strict';
import { birthYear } from './journal-rules.js';

test('год рождения — первые четыре знака даты, если это год', () => {
  assert.equal(birthYear('1971-07-03'), '1971');
  assert.equal(birthYear('1971'), '1971');
  assert.equal(birthYear(null), '');
  assert.equal(birthYear(''), '');
  assert.equal(birthYear('03.07.1971'), '');
});
