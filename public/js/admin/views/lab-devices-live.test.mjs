// lab-devices-live.test.mjs — LIS_REAL_ANALYZERS_V1 (экран): живая лента
// «Последние результаты» собирает сообщения одной серии в одну строку.
//
// BS-200 шлёт по тесту в сообщении: проба из пяти тестов — пять строк ленты, и
// лента из десяти строк показывала бы две пробы. Серия — сообщения одного
// прибора по одному заказу за 60 минут (как у приёма, server/lis/match.js);
// строка ленты — «LAB-000123 · Иванов · BS-200 · 5 сообщений · принято».
import test from 'node:test';
import assert from 'node:assert/strict';
import { groupSeries } from './lab-devices-live.js';
import { SERIES_PENDING_PREFIX } from './lab-devices-lists.js';

const NOW = Date.parse('2026-10-01T10:00:00Z');
const at = (min) => new Date(NOW - min * 60000).toISOString().replace(/\.\d{3}Z$/, 'Z');
// lis_recent: от новых к старым.
const R = (id, min, extra = {}) => ({ id, received_at: at(min), device_id: 1, device_name: 'BS-200', sample_id: 'LAB-000123',
  visit_service_id: 123, patient_name: 'Иванов Иван', service_name: 'Биохимия', status: 'applied', detail: '', resolved_at: null,
  values: [{ parameter: 'Глюкоза', value: '5' }], ...extra });

test('серия из трёх принятых сообщений — одна строка: «3 сообщения», «принято»', () => {
  const g = groupSeries([R(3, 1), R(2, 2), R(1, 3)], NOW);
  assert.equal(g.length, 1);
  assert.equal(g[0].id, 3, 'строка — самое новое сообщение');
  assert.equal(g[0].count, 3);
  assert.deepEqual(g[0].ids, [3, 2, 1]);
  assert.equal(g[0].status, 'applied');
  assert.equal(g[0].patient_name, 'Иванов Иван');
});

test('серия идёт — «идёт приём»; одиночная строка «ждём» — тоже', () => {
  const pend = (id, min) => R(id, min, { status: 'unmapped', detail: SERIES_PENDING_PREFIX + 'не пришли: Креатинин (3)' });
  assert.equal(groupSeries([pend(2, 1), pend(1, 2)], NOW)[0].status, 'receiving');
  assert.equal(groupSeries([pend(1, 2)], NOW)[0].status, 'receiving');
  assert.equal(groupSeries([pend(1, 61)], NOW)[0].status, 'unmapped', 'за час серия не дошла — обычная беда');
});

test('в серии есть беда (повтор, неподтверждённое) — строка «не сопоставлено»; разобранная человеком бедой не считается', () => {
  const g = groupSeries([R(3, 1, { status: 'unmapped', detail: 'повтор: 2 (test2): было 5.1, в бланке 5.4' }), R(2, 2), R(1, 3)], NOW);
  assert.equal(g.length, 1);
  assert.equal(g[0].status, 'unmapped');
  const dismissed = groupSeries([R(3, 1), R(2, 2, { status: 'unmapped', detail: 'x', resolved_at: at(1) })], NOW);
  assert.equal(dismissed[0].status, 'applied');
});

test('другой заказ, другой прибор, больше 60 минут — отдельные строки', () => {
  const g = groupSeries([
    R(6, 1),
    R(5, 2, { visit_service_id: 124, sample_id: 'LAB-000124' }),   // другой заказ
    R(4, 3, { device_id: 2, device_name: 'BS-200 (2)' }),          // другой прибор
    R(3, 4),                                                       // та же серия, что 6
    R(2, 70),                                                      // 69 минут до 6 — новая серия
    R(1, 75),
  ], NOW);
  assert.deepEqual(g.map((x) => [x.id, x.count]), [[6, 2], [5, 1], [4, 1], [2, 2]]);
});

test('без заказа, «Не найден заказ», «Результат уже выдан» — не склеиваются', () => {
  const g = groupSeries([
    R(4, 1, { visit_service_id: null, status: 'unmatched', sample_id: '2' }),
    R(3, 2, { visit_service_id: null, status: 'unmatched', sample_id: '2' }),
    R(2, 3, { status: 'superseded' }),
    R(1, 4, { status: 'superseded' }),
  ], NOW);
  assert.deepEqual(g.map((x) => [x.id, x.count, x.status]), [[4, 1, 'unmatched'], [3, 1, 'unmatched'], [2, 1, 'superseded'], [1, 1, 'superseded']]);
});

test('сервер без device_id (старее) — прибор узнаётся по имени', () => {
  const g = groupSeries([R(2, 1, { device_id: undefined }), R(1, 2, { device_id: undefined })], NOW);
  assert.equal(g.length, 1);
  assert.equal(g[0].count, 2);
});

test('пустая лента — пусто', () => {
  assert.deepEqual(groupSeries([], NOW), []);
  assert.deepEqual(groupSeries(undefined, NOW), []);
});
