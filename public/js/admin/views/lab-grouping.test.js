import test from 'node:test';
import assert from 'node:assert/strict';
import { pluralRu, groupLabRows, parseOptions, selectOptionsFor } from './lab-grouping.js';

// ---------------------------------------------------------------------------
// pluralRu
// ---------------------------------------------------------------------------
test('pluralRu: 1/21/31/... -> one form', () => {
  for (const n of [1, 21, 31, 101, 121]) {
    assert.equal(pluralRu(n, 'анализ', 'анализа', 'анализов'), 'анализ', `n=${n}`);
  }
});

test('pluralRu: 2-4 / 22-24 -> few form', () => {
  for (const n of [2, 3, 4, 22, 23, 24, 102, 103]) {
    assert.equal(pluralRu(n, 'анализ', 'анализа', 'анализов'), 'анализа', `n=${n}`);
  }
});

test('pluralRu: 0, 5-20, 25-30, 11-14 -> many form', () => {
  for (const n of [0, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 20, 25, 30, 100, 111]) {
    assert.equal(pluralRu(n, 'анализ', 'анализа', 'анализов'), 'анализов', `n=${n}`);
  }
});

// ---------------------------------------------------------------------------
// groupLabRows
// ---------------------------------------------------------------------------
const patientMap = {
  10: { visit_date: '2026-08-01', patient: { id: 1, full_name: 'Иванов Иван', mrn: 'MRN-1', gender: 'male', date_of_birth: '1990-01-01' } },
  11: { visit_date: '2026-08-02', patient: { id: 2, full_name: 'Петрова Анна', mrn: 'MRN-2', gender: 'female', date_of_birth: '1985-05-05' } },
};

test('groupLabRows: rows sharing a visit_id land in one group, in first-seen order', () => {
  const rows = [
    { id: 100, visit_id: 10, service_id: 1 },
    { id: 101, visit_id: 11, service_id: 2 },
    { id: 102, visit_id: 10, service_id: 3 },
  ];
  const groups = groupLabRows(rows, patientMap);
  assert.equal(groups.length, 2, 'two distinct visits -> two groups');
  assert.equal(groups[0].visitId, 10, 'first-seen visit stays first');
  assert.deepEqual(groups[0].rows.map(r => r.id), [100, 102], 'both visit-10 rows land in the same group, in row order');
  assert.equal(groups[1].visitId, 11);
  assert.deepEqual(groups[1].rows.map(r => r.id), [101]);
});

test('groupLabRows: carries patient fields from patientMap onto the group', () => {
  const rows = [{ id: 100, visit_id: 10 }];
  const [g] = groupLabRows(rows, patientMap);
  assert.equal(g.patientId, 1);
  assert.equal(g.patientName, 'Иванов Иван');
  assert.equal(g.patientMrn, 'MRN-1');
  assert.equal(g.patientSex, 'male');
  assert.equal(g.patientDob, '1990-01-01');
});

test('groupLabRows: an order with no visit gets its own "_solo_"+id group, never merged with another solo order', () => {
  const rows = [
    { id: 200, visit_id: null },
    { id: 201, visit_id: null },
  ];
  const groups = groupLabRows(rows, patientMap);
  assert.equal(groups.length, 2, 'two solo orders -> two separate groups, not merged');
  assert.equal(groups[0].key, '_solo_200');
  assert.equal(groups[1].key, '_solo_201');
  assert.equal(groups[0].visitId, null);
});

test('groupLabRows: missing patientMap entry -> safe fallback fields, no throw', () => {
  const rows = [{ id: 300, visit_id: 999 }];
  const groups = groupLabRows(rows, {});
  assert.equal(groups.length, 1);
  assert.equal(groups[0].patientName, '—');
  assert.equal(groups[0].patientMrn, '');
  assert.equal(groups[0].patientId, null);
});

test('groupLabRows: accessionOf callback stamps the group from its first row', () => {
  const rows = [
    { id: 100, visit_id: 10 },
    { id: 102, visit_id: 10 },
  ];
  const accessionOf = (r) => 'LAB-' + String(r.id).padStart(6, '0');
  const [g] = groupLabRows(rows, patientMap, accessionOf);
  assert.equal(g.accession, 'LAB-000100', 'group accession comes from the FIRST row, not later ones');
});

test('groupLabRows: empty input -> empty output', () => {
  assert.deepEqual(groupLabRows([], patientMap), []);
  assert.deepEqual(groupLabRows(null, patientMap), []);
});

// ---------------------------------------------------------------------------
// parseOptions / selectOptionsFor — LAB_SELECT_OPTIONS_V1
// ---------------------------------------------------------------------------
test('parseOptions: comma form (what the panel editor and migrations 051/052 write)', () => {
  assert.deepEqual(parseOptions('Отрицательно, Следы, +, ++, +++'),
    ['Отрицательно', 'Следы', '+', '++', '+++']);
  assert.deepEqual(parseOptions('O(I), A(II), B(III), AB(IV)'),
    ['O(I)', 'A(II)', 'B(III)', 'AB(IV)']);
});

test('parseOptions: JSON array form (the production LIS wrote this) still reads', () => {
  assert.deepEqual(parseOptions('["Rh+","Rh-"]'), ['Rh+', 'Rh-']);
});

test('parseOptions: newline / semicolon separators, blanks dropped', () => {
  assert.deepEqual(parseOptions('Прозрачная\nСлегка мутная;Мутная,,'),
    ['Прозрачная', 'Слегка мутная', 'Мутная']);
});

test('parseOptions: nothing configured -> empty list, never throws', () => {
  for (const raw of [null, undefined, '', '   ']) assert.deepEqual(parseOptions(raw), []);
});

test('selectOptionsFor: plain case -> exactly the configured options', () => {
  const a = { value_type: 'select', value_options: 'Rh+ (положительный), Rh- (отрицательный)' };
  assert.deepEqual(selectOptionsFor(a, null), ['Rh+ (положительный)', 'Rh- (отрицательный)']);
});

test('selectOptionsFor: a saved answer the clinic later removed is kept, first', () => {
  // Reopening an old result must not silently blank a value a tech signed off.
  const a = { value_type: 'select', value_options: 'Отрицательно, Положительно' };
  assert.deepEqual(selectOptionsFor(a, { value: 'Сомнительно' }),
    ['Сомнительно', 'Отрицательно', 'Положительно']);
});

test('selectOptionsFor: a saved answer still on the list is not duplicated', () => {
  const a = { value_type: 'select', value_options: 'Отрицательно, Положительно' };
  assert.deepEqual(selectOptionsFor(a, { value: 'Положительно' }),
    ['Отрицательно', 'Положительно']);
});

test('selectOptionsFor: empty/whitespace previous value adds nothing', () => {
  const a = { value_type: 'select', value_options: 'Да, Нет' };
  assert.deepEqual(selectOptionsFor(a, { value: '' }), ['Да', 'Нет']);
  assert.deepEqual(selectOptionsFor(a, { value: '   ' }), ['Да', 'Нет']);
  assert.deepEqual(selectOptionsFor(a, { value: null }), ['Да', 'Нет']);
});

test('selectOptionsFor: analyte with no options configured -> empty (form shows «—» only)', () => {
  assert.deepEqual(selectOptionsFor({ value_type: 'select' }, null), []);
  assert.deepEqual(selectOptionsFor(null, null), []);
});

// ---------------------------------------------------------------------------
// LAB_ONE_CLINIC_V1 — метка филиала на карточке очереди.
//
// Когда лаборатория обслуживает всю клинику (doc_settings.lab_scope, миграция
// 085), в одной очереди стоят пробирки разных зданий. Без буквы лаборант ищет
// пациента, которого в его корпусе никогда не было, — а найдя пустоту, решает,
// что заказ ошибочный.
// ---------------------------------------------------------------------------

test('groupLabRows: заказ из другого здания несёт букву своего филиала', () => {
  const groups = groupLabRows(
    [{ id: 1, visit_id: 10, sync_origin: 'C' }, { id: 2, visit_id: 10, sync_origin: 'C' }],
    { 10: { patient: { id: 5, full_name: 'Иванов', mrn: 'C-26-00042' } } },
    null);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].originLetter, 'C', 'карточка подписана филиалом, где пациента регистрировали');
});

test('groupLabRows: своя работа не подписывается', () => {
  const groups = groupLabRows(
    [{ id: 1, visit_id: 10, sync_origin: null }, { id: 2, visit_id: 10 }],
    { 10: { patient: { id: 5, full_name: 'Иванов', mrn: 'B-26-00001' } } },
    null);
  assert.equal(groups[0].originLetter, null,
    'подпись на каждой карточке перестала бы что-либо значить');
});

test('groupLabRows: буква — из sync_origin, а НЕ из буквы MRN', () => {
  // Пациент заведён в C, пришёл лечиться в B: работа сделана здесь, и очередь
  // не должна называть её чужой.
  const groups = groupLabRows(
    [{ id: 1, visit_id: 10, sync_origin: null }],
    { 10: { patient: { id: 5, full_name: 'Иванов', mrn: 'C-26-00042' } } },
    null);
  assert.equal(groups[0].originLetter, null);
});
