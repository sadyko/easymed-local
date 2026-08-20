import test from 'node:test';
import assert from 'node:assert/strict';
import { ratesOf, assignedTo, doctorPoolFor } from './doctor-pool.js';

const DOCS = [
  { id: 1, full_name: 'Азиза',  service_rates: [{ service_id: 10 }, { service_id: 11 }] },
  { id: 2, full_name: 'Борис',  service_rates: [{ service_id: 11 }] },
  { id: 3, full_name: 'Вера',   service_rates: null },
  { id: 4, full_name: 'Гуля',   service_rates: '[{"service_id": 10}]' },   // строкой из БД
  { id: 5, full_name: 'Дилноза', service_rates: '{битый жсон' },           // 9 таких в живой базе
];

test('service_rates читается и массивом, и строкой; битый JSON не роняет', () => {
  assert.equal(ratesOf(DOCS[0]).length, 2);
  assert.equal(ratesOf(DOCS[2]).length, 0);
  assert.equal(ratesOf(DOCS[3]).length, 1, 'строка разбирается');
  assert.equal(ratesOf(DOCS[4]).length, 0, 'битый JSON — пустой список, а не исключение');
});

test('назначенные исполнители — только те, кому услуга отмечена', () => {
  assert.deepEqual(assignedTo(DOCS, 10).map(d => d.full_name), ['Азиза', 'Гуля']);
  assert.deepEqual(assignedTo(DOCS, 11).map(d => d.full_name), ['Азиза', 'Борис']);
});

test('есть назначенные — фолбэк не нужен', () => {
  assert.deepEqual(doctorPoolFor(DOCS, { id: 11, requires_doctor: 1 }).map(d => d.id), [1, 2]);
});

test('услуга требует врача, а исполнителей нет — предлагаем всех', () => {
  const pool = doctorPoolFor(DOCS, { id: 999, requires_doctor: 1 });
  assert.equal(pool.length, DOCS.length, 'иначе мастер визита встаёт в тупик');
});

test('услуге без врача пустой список — правильный ответ, а не тупик', () => {
  assert.deepEqual(doctorPoolFor(DOCS, { id: 999, requires_doctor: 0 }), []);
});
