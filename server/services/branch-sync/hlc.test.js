// hlc.test.js — BRANCH_RECORDS_V1: порядок событий, переживающий разные часы.
//
// Сравнивать updated_at нельзя: часы двух зданий расходятся, а переведённые
// назад часы одного филиала ОТМЕНЯЛИ БЫ правки другого — молча и задним
// числом. Гибридные часы дают порядок, который не ломается от этого.
import test from 'node:test';
import assert from 'node:assert/strict';
import { nextStamp, compareStamps } from './hlc.js';

test('метка растёт даже когда часы стоят на месте', () => {
  const clock = () => 1000;
  let state = null;
  const a = nextStamp(state, 'B', clock); state = a;
  const b = nextStamp(state, 'B', clock);
  assert.equal(compareStamps(b.stamp, a.stamp) > 0, true, 'вторая метка больше первой');
});

test('метка растёт, когда часы перевели НАЗАД', () => {
  let now = 5000;
  const clock = () => now;
  let state = nextStamp(null, 'B', clock);
  now = 1000;                       // кто-то поправил время на машине
  const after = nextStamp(state, 'B', clock);
  assert.equal(compareStamps(after.stamp, state.stamp) > 0, true,
    'иначе правки после перевода часов проиграли бы старым');
});

test('метки сравниваются лексикографически — как строки в SQL ORDER BY', () => {
  const clock = () => 2000;
  const a = nextStamp(null, 'B', clock);
  const b = nextStamp(a, 'B', clock);
  const sorted = [b.stamp, a.stamp].sort();
  assert.deepEqual(sorted, [a.stamp, b.stamp],
    'порядок строк обязан совпадать с порядком событий: журнал читают SQL-ом');
});

test('узел входит в метку — две машины в одну миллисекунду не сольются', () => {
  const clock = () => 3000;
  const b = nextStamp(null, 'B', clock);
  const c = nextStamp(null, 'C', clock);
  assert.notEqual(b.stamp, c.stamp);
});
