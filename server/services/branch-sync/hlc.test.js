// hlc.test.js — BRANCH_RECORDS_V1: порядок событий, переживающий разные часы.
//
// Сравнивать updated_at нельзя: часы двух зданий расходятся, а переведённые
// назад часы одного филиала ОТМЕНЯЛИ БЫ правки другого — молча и задним
// числом. Гибридные часы дают порядок, который не ломается от этого.
import test from 'node:test';
import assert from 'node:assert/strict';
import { nextStamp, compareStamps, parseStamp, isStamp } from './hlc.js';

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
  assert.notEqual(compareStamps(b.stamp, c.stamp), 0);
});

test('свежая метка соответствует замороженному формату', () => {
  const stamp = nextStamp(null, 'B', () => 42).stamp;
  assert.equal(isStamp(stamp), true);
  assert.match(stamp, /^[0-9a-f]{12}-[0-9a-f]{4}-[A-Z]{1,8}$/);
});

test('переполнение счётчика переносится в следующую миллисекунду', () => {
  const state = { ms: 1000, cnt: 0xffff };
  const next = nextStamp(state, 'B', () => 1000);
  assert.equal(next.ms, 1001);
  assert.equal(next.cnt, 0);
});

test('гибридность: своя метка обгоняет полученную от узла с более быстрыми часами', () => {
  const received = '0000000005dc-0002-C'; // ms=1500, cnt=2, узел C
  const next = nextStamp(null, 'B', () => 1000, received);
  assert.equal(next.ms, 1500);
  assert.equal(next.cnt, 3);
  assert.match(next.stamp, /-B$/);
  assert.equal(compareStamps(next.stamp, received) > 0, true,
    'иначе отстающий по часам узел молча проигрывал бы даже более поздние правки');
});

test('буква узла может быть длиннее одного символа, но обязана существовать', () => {
  const stamp = nextStamp(null, 'AA', () => 1).stamp;
  assert.match(stamp, /-AA$/);
  assert.throws(() => nextStamp(null, undefined, () => 1), /node letter required/);
  assert.throws(() => nextStamp(null, 'b1', () => 1), /node letter required/);
});

test('isStamp отличает валидную метку от мусора', () => {
  const stamp = nextStamp(null, 'B', () => 1).stamp;
  assert.equal(isStamp(stamp), true);
  assert.equal(isStamp('not-a-stamp'), false);
  assert.equal(isStamp(''), false);
  assert.equal(isStamp(null), false);
});

test('parseStamp — обратное преобразование к nextStamp', () => {
  const { stamp } = nextStamp(null, 'C', () => 777);
  const parsed = parseStamp(stamp);
  assert.deepEqual(parsed, { ms: 777, cnt: 0, node: 'C' });
  assert.equal(parseStamp('garbage'), null);
});

test('состояние из control_state приходит строками — коэрсия не должна ронять счётчик', () => {
  const next = nextStamp({ ms: '5000', cnt: '3' }, 'B', () => 1000);
  assert.equal(next.ms, 5000);
  assert.equal(next.cnt, 4);
});

test('счётчик у пола берёт максимум своего и полученного, а не первый совпавший', () => {
  // Проба ревьюера: свой счётчик отстаёт (1), у пришедшей метки он далеко
  // впереди (0x30=48). Взять «первый совпавший» (свой) значило бы отдать
  // узлу C выигрыш даже там, где B обязан был обогнать.
  const next = nextStamp({ ms: 1500, cnt: 1 }, 'B', () => 1000, '0000000005dc-0030-C');
  assert.equal(next.ms, 1500);
  assert.equal(next.cnt, 0x31);
  assert.equal(compareStamps(next.stamp, '0000000005dc-0030-C') > 0, true,
    'иначе B молча проигрывает C, которого только что обогнал');
  assert.equal(compareStamps(next.stamp, '0000000005dc-0001-B') > 0, true);
});

test('негодная полученная метка не проглатывается молча', () => {
  assert.throws(() => nextStamp(null, 'B', () => 1000, 'garbage'),
    /malformed received stamp/);
  assert.throws(() => nextStamp(null, 'B', () => 1000, '0000000005DC-0002-C'),
    /malformed received stamp/, 'формат заморожен на нижнем регистре hex');
  // null/undefined — это «нечего мёржить», а не мусор; часы просто не растут от чужого.
  assert.doesNotThrow(() => nextStamp(null, 'B', () => 1000, null));
  assert.doesNotThrow(() => nextStamp(null, 'B', () => 1000, undefined));
});
