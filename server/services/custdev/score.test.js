// CUSTDEV_V1 — правило, ради которого всё написано: три оценки -> одна колонка.
// Без базы: таблица комбинаций должна проверяться напрямую, а не через фикстуру.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rateOutcome, ScoreError } from './score.js';

const ok = (o) => rateOutcome({ comment: '', ...o });

test('ноль жалоб — «Доволен»', () => {
  assert.equal(ok({ registrar: 'good', cashier: 'good', doctor: 'good' }).status, 'satisfied');
});

test('одна жалоба — «Частично доволен», как и просил владелец про «двое из трёх»', () => {
  assert.equal(rateOutcome({ registrar: 'good', cashier: 'good', doctor: 'bad', comment: 'долго ждал' }).status, 'partial');
  assert.equal(rateOutcome({ registrar: 'bad', cashier: 'good', doctor: 'good', comment: 'нагрубили' }).status, 'partial');
});

test('две и больше — «Недоволен»', () => {
  assert.equal(rateOutcome({ registrar: 'bad', cashier: 'bad', doctor: 'good', comment: 'очередь' }).status, 'unsatisfied');
  assert.equal(rateOutcome({ registrar: 'bad', cashier: 'bad', doctor: 'bad', comment: 'всё плохо' }).status, 'unsatisfied');
});

test('«Не применимо» не считается ни довольным, ни недовольным', () => {
  // Лабораторный визит: врача не было. Две «доволен» дают «Доволен», а не «Частично».
  assert.equal(ok({ registrar: 'good', cashier: 'good', doctor: 'na' }).status, 'satisfied');
  // И одна жалоба из двух применимых — это по-прежнему ровно одна жалоба.
  assert.equal(rateOutcome({ registrar: 'good', cashier: 'bad', doctor: 'na', comment: 'сдача' }).status, 'partial');
});

test('невыставленная оценка сохраниться не может', () => {
  assert.throws(() => ok({ registrar: 'good', cashier: 'good', doctor: 'unrated' }), ScoreError);
  assert.throws(() => ok({ registrar: 'good', cashier: 'good' }), ScoreError);
  assert.throws(() => ok({ registrar: 'good', cashier: 'good', doctor: 'отлично' }), ScoreError);
});

test('три «Не применимо» — отказ, а не «Доволен»', () => {
  // Оценивать нечего, и «Доволен» тут был бы враньём в отчёте.
  assert.throws(() => ok({ registrar: 'na', cashier: 'na', doctor: 'na' }), ScoreError);
});

test('жалоба без причины не сохраняется', () => {
  assert.throws(() => ok({ registrar: 'good', cashier: 'good', doctor: 'bad' }), ScoreError);
  assert.throws(() => rateOutcome({ registrar: 'good', cashier: 'good', doctor: 'bad', comment: '   ' }), ScoreError);
});

test('комментарий возвращается обрезанным, и не требуется когда жалоб нет', () => {
  const out = rateOutcome({ registrar: 'good', cashier: 'good', doctor: 'good', comment: '  спасибо  ' });
  assert.equal(out.comment, 'спасибо');
  assert.equal(ok({ registrar: 'good', cashier: 'good', doctor: 'good' }).comment, '');
});
