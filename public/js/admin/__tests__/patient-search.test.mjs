// PATIENT_SEARCH_TOKENS_V1 — поиск по КУСКАМ фамилии и имени.
//
// Раньше поиск был одним ilike('full_name', '%запрос%'), то есть искал запрос
// как НЕПРЕРЫВНУЮ подстроку. «Эрг Жах» не находило «Эргашев Жахонгир Нурийигит
// Ўғли», хотя оба куска в имени есть — регистратура набирает именно так.
//
// Разбиваем запрос на слова: каждое слово должно найтись где-то в карточке
// (И между словами), но может найтись в ЛЮБОМ поле (ИЛИ между полями).

import { test } from 'node:test';
import assert from 'node:assert';
import { searchTokens, MAX_TOKENS } from '../patient-search.js';

test('несколько слов — несколько условий', () => {
  assert.deepStrictEqual(searchTokens('Эрг Жах'), ['Эрг', 'Жах']);
});

test('лишние пробелы и переносы не создают пустых условий', () => {
  assert.deepStrictEqual(searchTokens('  Эрг   \t Жах \n '), ['Эрг', 'Жах']);
});

test('пустой запрос — ни одного условия', () => {
  for (const empty of ['', '   ', null, undefined]) {
    assert.deepStrictEqual(searchTokens(empty), [], JSON.stringify(empty));
  }
});

// Один и тот же кусок дважды — это то же самое условие; повтор только
// удлиняет запрос к базе.
test('повторяющиеся слова схлопываются', () => {
  assert.deepStrictEqual(searchTokens('Эрг эрг ЭРГ'), ['Эрг']);
});

// Защита от вставленного в поиск абзаца: каждое слово — отдельный OR-блок в SQL.
test('число слов ограничено', () => {
  const many = Array.from({ length: MAX_TOKENS + 8 }, (_, i) => 'w' + i).join(' ');
  assert.equal(searchTokens(many).length, MAX_TOKENS);
});

// % и _ в ilike — подстановочные знаки. Без экранирования «%» находил бы всех.
test('подстановочные знаки экранируются', () => {
  assert.deepStrictEqual(searchTokens('100%'), ['100' + '\\' + '%']);
  assert.deepStrictEqual(searchTokens('a_b'), ['a' + '\\' + '_b']);
});

// --- PATIENT_SEARCH_PHONE_V1 -------------------------------------------------
import { loosePhonePattern } from '../patient-search.js';

test('запятая разделяет слова, а не попадает внутрь условия', () => {
  assert.deepStrictEqual(searchTokens('Эргашев, Жахонгир'), ['Эргашев', 'Жахонгир']);
});

test('длинный цифровой запрос ищется сквозь пробелы формата', () => {
  assert.strictEqual(loosePhonePattern('9487767'), '%9%4%8%7%7%6%7%');
});

// Порог измерен на настоящей базе: 4 цифры так находят 559 карточек вместо 28.
test('короткий цифровой запрос так не ищется — иначе находит всех', () => {
  for (const short of ['4988', '123', '99']) assert.strictEqual(loosePhonePattern(short), null, short);
});

test('нецифровой запрос телефонным шаблоном не становится', () => {
  for (const t of ['Эргашев', 'P-26-70002', '998a1234567', '']) assert.strictEqual(loosePhonePattern(t), null, t);
});
