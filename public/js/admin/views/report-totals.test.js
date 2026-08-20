import test from 'node:test';
import assert from 'node:assert/strict';
import { isSummableHeader, reportTotals } from './report-totals.js';

test('деньги и количества суммируются', () => {
  for (const h of ['Сумма без скидки', 'Оплачено', 'Остаток / долг', 'Total', 'Discount', 'Кол-во', 'Выручка']) {
    assert.equal(isSummableHeader(h), true, h);
  }
});

test('проценты, средние, возраст, годы, id и даты — не суммируются', () => {
  for (const h of ['Скидка, %', 'Процент врача', 'Средний чек', 'Avg', 'Возраст', 'Год', 'ID пациента', 'Дата оплаты', '№ счёта', 'Доля, %']) {
    assert.equal(isSummableHeader(h), false, h);
  }
});

// --- табличная часть: колонки массивом (reports-hub) ---
const COLS = [{ label: 'Пациент' }, { label: 'Сумма' }, { label: 'Скидка, %' }, { label: 'Оплачено' }];
const ROWS = [
  ['Иванов', 100000, 10, 100000],
  ['Петров', 50000, 0, 0],
  ['Сидоров', 30000, 5, 30000],
];
const get = (r, _c, ci) => r[ci];
const numeric = (_c, ci) => ci > 0;

test('итог считается по суммируемым колонкам и пропускает остальные', () => {
  assert.deepEqual(reportTotals(COLS, ROWS, get, numeric), [null, 180000, null, 130000]);
});

test('текстовая колонка итога не получает, даже если заголовок «денежный»', () => {
  const totals = reportTotals(COLS, ROWS, get, () => false);
  assert.deepEqual(totals, [null, null, null, null]);
});

test('пустые и нечисловые ячейки не ломают сумму', () => {
  const rows = [['А', 100, 0, null], ['Б', null, 0, ''], ['В', '—', 0, 50]];
  assert.deepEqual(reportTotals(COLS, rows, get, numeric), [null, 100, null, 50]);
});

test('колонка без единого числа итога не показывает', () => {
  const rows = [['А', null, null, null]];
  assert.deepEqual(reportTotals(COLS, rows, get, numeric), [null, null, null, null]);
});

test('копеечный хвост float не всплывает в итоге', () => {
  const rows = [['А', 0.1, 0, 0], ['Б', 0.2, 0, 0]];
  assert.equal(reportTotals(COLS, rows, get, numeric)[1], 0.3);
});

test('итог берётся по ВСЕМ строкам, а не по показанным', () => {
  const many = Array.from({ length: 500 }, () => ['x', 1000, 0, 0]);
  assert.equal(reportTotals(COLS, many, get, numeric)[1], 500000);
});
