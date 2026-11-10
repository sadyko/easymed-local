// CRM_DAY_LINES_V1 — выбор строк заявок для сметы дня: тот же, что был у браузера
// (crm-lines.js до 3.23.0), теперь общий для сервера (RPC crm_day_lines).
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickDayLines } from './crm-day-lines.js';

const DAY = '2026-10-05';
const lineOf = (over) => ({ id: 901, service_id: 10, consultation_type_id: null, scheduled_date: DAY, doctor_id: null, visit_id: null, ...over });

test('визит известен — строки ЭТОГО приёма', () => {
  const lines = [lineOf({ id: 901, visit_id: 555 }), lineOf({ id: 902, service_id: 11, visit_id: 777 })];
  assert.deepEqual(pickDayLines(lines, 555).map((l) => l.id), [901]);
});

test('визит известен, но ни одна строка на него не ссылается — весь день', () => {
  const lines = [lineOf({ id: 901 }), lineOf({ id: 902, service_id: 11 })];
  assert.deepEqual(pickDayLines(lines, 555).map((l) => l.id), [901, 902]);
});

test('визит не назван — весь день', () => {
  const lines = [lineOf({ id: 901, visit_id: 555 }), lineOf({ id: 902, service_id: 11, visit_id: 777 })];
  assert.deepEqual(pickDayLines(lines).map((l) => l.id), [901, 902]);
});

test('одинаковые строки двух карточек (услуга + врач) — в смету одна; из одинаковых — этого приёма', () => {
  const lines = [
    lineOf({ id: 901, service_id: 10, doctor_id: 3, visit_id: null }),
    lineOf({ id: 902, service_id: 10, doctor_id: 3, visit_id: 555 }),
    lineOf({ id: 903, service_id: 10, doctor_id: 4, visit_id: 555 }),
    lineOf({ id: 904, service_id: 20, doctor_id: null, visit_id: null }),
  ];
  assert.deepEqual(pickDayLines(lines).map((l) => l.id), [901, 903, 904]);
  assert.deepEqual(pickDayLines(lines, 555).map((l) => l.id), [902, 903]);
});

test('консультация по виду приёма — тоже одна строка; строка без услуги — сама по себе', () => {
  const lines = [
    lineOf({ id: 911, service_id: null, consultation_type_id: 5, doctor_id: 10 }),
    lineOf({ id: 912, service_id: null, consultation_type_id: 5, doctor_id: 10 }),
    lineOf({ id: 913, service_id: null, consultation_type_id: 6, doctor_id: 10 }),
    lineOf({ id: 914, service_id: null, consultation_type_id: null }),
    lineOf({ id: 915, service_id: null, consultation_type_id: null }),
  ];
  assert.deepEqual(pickDayLines(lines).map((l) => l.id).sort(), [911, 913, 914, 915]);
  assert.deepEqual(pickDayLines(null), []);
});
