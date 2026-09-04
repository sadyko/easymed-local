// BUILDING_REPORTS_V1 — перечень ЗДАНИЙ клиники.
//
// Одна ошибка, ради которой этот модуль существует: выборка филиалов в
// «Отчётах» грузилась с `.eq('active', 1)`, а соседнее здание заводится приёмом
// справочника ИМЕННО как `active = 0` (branch-sync/catalogue.js: «строка
// заводится, чтобы была ИЗВЕСТНА БУКВА соседа»). То есть отчёт не мог даже
// назвать второе здание — не то что посчитать его. Первый тест здесь про это.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildingOptions, normalizeLetter, ownKeyOf, coversAll, buildingKey, OWN_KEY,
} from './report-buildings.js';

test('соседнее здание попадает в список, хотя его строка active = 0', () => {
  const list = buildingOptions({
    branches: [
      { name: 'Главный корпус', letter: 'A', active: 1 },
      { name: 'Чиланзар', letter: 'B', active: 0 },
    ],
    ownLetter: 'A',
  });
  assert.deepEqual(list.map((o) => o.key), ['A', 'B']);
  assert.equal(list[1].name, 'Чиланзар');
  assert.equal(list[1].own, false);
});

test('своё здание всегда первое и названо своим именем', () => {
  const list = buildingOptions({
    branches: [{ name: 'Чиланзар', letter: 'B' }, { name: 'Главный корпус', letter: 'A' }],
    ownLetter: 'A',
  });
  assert.equal(list[0].key, 'A');
  assert.equal(list[0].own, true);
  assert.equal(list[0].name, 'Главный корпус');
});

test('здание, приславшее записи, называется даже без строки в перечне', () => {
  // Худший из отказов — свалить чужие строки в «своё»: цифры сойдутся, и никто
  // не заметит, что половина работы приписана не тому дому.
  const list = buildingOptions({ branches: [{ name: 'Главный', letter: 'A' }], ownLetter: 'A', seen: ['C'] });
  assert.deepEqual(list.map((o) => o.key), ['A', 'C']);
  assert.equal(list[1].name, null, 'имени нет — подпись сделает тот, кто показывает');
});

test('буква — только заглавная латиница; мусор не создаёт здания-призрака', () => {
  assert.equal(normalizeLetter('b'), 'B');
  assert.equal(normalizeLetter(' B '), 'B');
  assert.equal(normalizeLetter(''), null);
  assert.equal(normalizeLetter('С'), null, 'кириллическая «С» — не буква узла');
  assert.equal(normalizeLetter('A1'), null);
  assert.equal(normalizeLetter(null), null);
  const list = buildingOptions({ branches: [{ name: 'Мусор', letter: 'A-' }], ownLetter: 'A', seen: [''] });
  assert.deepEqual(list.map((o) => o.key), ['A']);
});

test('база без выданной буквы всё равно даёт выбираемое «это здание»', () => {
  const list = buildingOptions({ branches: [], ownLetter: null, seen: ['B'] });
  assert.equal(list[0].key, OWN_KEY);
  assert.equal(list[0].own, true);
  assert.equal(ownKeyOf(list), OWN_KEY);
  assert.equal(buildingKey(list[0]), OWN_KEY);
});

test('«выбрано всё» = «фильтра нет»', () => {
  const list = buildingOptions({ branches: [{ name: 'Г', letter: 'A' }, { name: 'Ч', letter: 'B' }], ownLetter: 'A' });
  assert.equal(coversAll(['A', 'B'], list), true);
  assert.equal(coversAll([], list), true, 'пустой выбор не должен означать «ничего не показывать»');
  assert.equal(coversAll(['B'], list), false);
});
