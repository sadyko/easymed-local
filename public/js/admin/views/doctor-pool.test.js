import test from 'node:test';
import assert from 'node:assert/strict';
import { ratesOf, assignedTo, doctorPoolFor, needsPerformer, performerCandidates, soleCandidate } from './doctor-pool.js';

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

// DIAG_ROUTE_V1 (D1, решение владельца 2026-11-03) — пустой список только у групп
// «Лаборатория» и «Процедуры»: строке кабинета без исполнителя не видна ни одному врачу.
test('анализу и процедуре без исполнителей — пустой список; услуге кабинета «без врача» — все врачи', () => {
  assert.deepEqual(doctorPoolFor(DOCS, { id: 999, requires_doctor: 0, type: 'lab' }), []);
  assert.deepEqual(doctorPoolFor(DOCS, { id: 999, requires_doctor: 0, type: 'procedure' }), []);
  assert.deepEqual(doctorPoolFor(DOCS, { id: 999, requires_doctor: 0, type: 'imaging', is_lab: 1 }), [], 'is_lab — группа «Лаборатория»');
  for (const type of ['imaging', 'consultation', 'other', 'radiology']) {
    assert.equal(doctorPoolFor(DOCS, { id: 999, requires_doctor: 0, type }).length, DOCS.length, type);
  }
});

test('needsPerformer: всем, кроме «Лаборатории» и «Процедур»; галочка «нужен врач» — всегда', () => {
  assert.equal(needsPerformer({ type: 'imaging', requires_doctor: 0 }), true);
  assert.equal(needsPerformer({ type: 'other', requires_doctor: 0 }), true);
  assert.equal(needsPerformer({ type: 'lab', requires_doctor: 0 }), false);
  assert.equal(needsPerformer({ type: 'procedure', requires_doctor: 0 }), false);
  assert.equal(needsPerformer({ type: 'procedure', requires_doctor: 1 }), true);
  assert.equal(needsPerformer({ type: 'imaging', requires_doctor: 0, is_lab: 1 }), false);
  assert.equal(needsPerformer(null), false);
});

// DIAG_ROUTE_V1 (поправка ревью) — группа «Консультации» (умолчание колонки) идёт в лабораторию
// отделением или типом каталога; исполнитель ей тогда не нужен, а пул кандидатов — пуст.
test('needsPerformer / doctorPoolFor: анализ группы «Консультации» из отделения «Лаборатория» — без исполнителя', () => {
  const docs = [{ id: 1, is_doctor: 1, service_rates: [] }];
  const labByDept = { id: 9, type: 'consultation', requires_doctor: 0, departments: { kind: 'laboratory' }, service_types: null };
  const labByType = { id: 10, type: 'consultation', requires_doctor: 0, departments: null, service_types: { name: 'Лабораторные исследования' } };
  const consult = { id: 11, type: 'consultation', requires_doctor: 0, departments: { kind: 'clinical' }, service_types: { name: 'Консультация' } };
  assert.equal(needsPerformer(labByDept), false);
  assert.equal(needsPerformer(labByType), false);
  assert.equal(needsPerformer(consult), true);
  assert.deepEqual(doctorPoolFor(docs, labByDept), []);
  assert.deepEqual(doctorPoolFor(docs, consult).map((d) => d.id), [1]);
  assert.equal(needsPerformer({ type: 'imaging', requires_doctor: 0, departments: { kind: 'laboratory' } }), true, 'УЗИ группы «Диагностика» — врачу всегда');
});

test('фолбэк «все врачи» — по is_doctor, не по роли; отмеченный исполнитель — при любой роли', () => {
  const staff = [
    { id: 1, full_name: 'Врач', role: 'doctor', is_doctor: 1, service_rates: [] },
    { id: 2, full_name: 'Админ-врач', role: 'admin', is_doctor: 1, service_rates: null },
    { id: 3, full_name: 'Медсестра УЗИ', role: 'nurse', is_doctor: 0, service_rates: [{ service_id: 31 }] },
    { id: 4, full_name: 'Регистратор', role: 'registrar', is_doctor: 0, service_rates: [] },
    { id: 5, full_name: 'Главврач', role: 'head_doctor', is_doctor: true, service_rates: [{ service_id: 31 }] },
  ];
  const cands = performerCandidates(staff);
  assert.deepEqual(cands.map((u) => u.id), [1, 2, 3, 5], 'регистратор без услуг — не исполнитель');
  assert.deepEqual(doctorPoolFor(cands, { id: 31, type: 'imaging' }).map((u) => u.id), [3, 5], 'отмеченные — медсестра и главврач');
  assert.deepEqual(doctorPoolFor(cands, { id: 32, type: 'imaging' }).map((u) => u.id), [1, 2, 5], 'никого не отмечено — все is_doctor');
  assert.equal(soleCandidate([cands[0]]), cands[0]);
  assert.equal(soleCandidate(cands), null, 'двое и больше — выбирает регистратура');
  assert.equal(soleCandidate([]), null);
});
