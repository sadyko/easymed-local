// PAYER_COMPANY_IN_ESTIMATE_V1 — поведение ряда компаний в СМЕТЕ.
//
// Эти две функции существуют отдельно от visit-wizard.js по причине, а не для
// красоты: тот файл тесты не импортируют (он тянет supabase, иконки и весь
// экран), про него пишут проверки по ИСХОДНИКУ. Одиночность выбора, снятие
// повторным кликом и переполнение «Ещё N» исходником не проверяются — их
// проверяют настоящими вызовами, здесь.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { splitCompanies, toggleCompanyId } from '../views/payer-choice.js';

const P = (id, name) => ({ id, name });
const FIVE = [P(1, 'Cenergo'), P(2, 'Grandpharm'), P(3, 'Uzbekinvest'), P(4, 'Kafolat'), P(5, 'Alskom')];

test('короткий список показывается целиком, «Ещё N» не появляется', () => {
  const r = splitCompanies(FIVE.slice(0, 3), 'self');
  assert.equal(r.shown.length, 3);
  assert.equal(r.hiddenCount, 0);
});

test('список ровно в предел не прячет ничего', () => {
  const r = splitCompanies(FIVE.slice(0, 4), 'self');
  assert.equal(r.shown.length, 4);
  assert.equal(r.hiddenCount, 0);
});

test('длинный список прячет хвост под «Ещё N»', () => {
  const r = splitCompanies(FIVE, 'self');
  assert.equal(r.shown.length, 4);
  assert.equal(r.hiddenCount, 1);
  assert.deepEqual(r.hidden.map(p => p.name), ['Alskom']);
});

// Ряд без единой отметки — это ряд, который врёт: компания выбрана, а глазами
// этого не видно, и регистратор выбирает её второй раз.
test('выбранная компания из хвоста поднимается в видимые', () => {
  const r = splitCompanies(FIVE, 5);
  assert.ok(r.shown.some(p => String(p.id) === '5'), 'выбранная видна');
  assert.equal(r.shown.length, 4, 'ряд не разросся');
  assert.equal(r.hiddenCount, 1, 'вытесненная ушла в хвост');
  assert.ok(r.hidden.some(p => String(p.id) === '4'), 'вытеснена именно последняя видимая');
});

test('пустой и мусорный вход не роняют', () => {
  for (const bad of [undefined, null, [], [null, undefined]]) {
    const r = splitCompanies(bad, 'self');
    assert.equal(r.shown.length, 0);
    assert.equal(r.hiddenCount, 0);
  }
});

// У визита ровно один payer_id: отметка на второй компании обязана снять первую.
test('клик по другой компании переносит выбор', () => {
  assert.equal(toggleCompanyId(1, 2), '2');
});

test('повторный клик по выбранной снимает выбор', () => {
  assert.equal(toggleCompanyId(2, 2), 'self');
  assert.equal(toggleCompanyId('2', 2), 'self', 'число и строка — один и тот же плательщик');
});

test('клик при пустом выборе выбирает', () => {
  assert.equal(toggleCompanyId('self', 3), '3');
});
