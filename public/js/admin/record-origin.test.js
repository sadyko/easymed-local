// record-origin.test.js — BRANCH_ORIGIN_V1: «откуда эта запись».
//
// Проверяется ровно то решение, которое нельзя переиграть позже: происхождение
// строки читается из ХРАНИМОЙ метки sync_origin, а не из буквы MRN. Буква MRN
// говорит, где пациент ЗАВЕДЁН; визит пациента из C, пришедшего в B, — работа
// B, и по MRN он выглядел бы чужим.
import test from 'node:test';
import assert from 'node:assert/strict';
import { originTag, isOwnBuilding } from './record-origin.js';

test('строка, приехавшая из C, подписана буквой C', () => {
  assert.equal(originTag({ sync_origin: 'C' }), 'C');
  assert.equal(isOwnBuilding({ sync_origin: 'C' }), false, 'чужая работа не своя');
});

test('своя строка не подписывается — метка на всём подряд ничего не значит', () => {
  assert.equal(originTag({ sync_origin: null }), null);
  assert.equal(originTag({ sync_origin: undefined }), null);
  assert.equal(originTag({}), null, 'колонки может не быть в выборке вовсе');
  assert.equal(originTag({ sync_origin: '' }), null, 'пустая строка — это не буква филиала');
});

test('«своё здание» — это NULL, пустое и отсутствующее: на этом стоят рабочие списки', () => {
  assert.equal(isOwnBuilding({ sync_origin: null }), true);
  assert.equal(isOwnBuilding({ sync_origin: undefined }), true);
  assert.equal(isOwnBuilding({}), true);
  assert.equal(isOwnBuilding({ sync_origin: '' }), true);
});

test('нет строки — нет и метки: рендер не должен падать на пустом значении', () => {
  assert.equal(originTag(null), null);
  assert.equal(originTag(undefined), null);
  assert.equal(isOwnBuilding(null), true);
});

test('пробелы вокруг буквы срезаются, буква не переименовывается', () => {
  assert.equal(originTag({ sync_origin: ' C ' }), 'C');
  assert.equal(originTag({ sync_origin: 'B' }), 'B', 'своей букву делает NULL, а не совпадение с этой установкой');
});
