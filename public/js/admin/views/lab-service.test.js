import test from 'node:test';
import assert from 'node:assert/strict';
import { isLabService, deptKindMap, typeNameMap, LAB_NAME_RE } from './lab-service.js';

// The rule ported from production easymed.uz. Each branch is pinned separately
// because each one is a route a clinic actually uses, and this build shipped for
// a while with only the first — which made a service look "not lab" even though
// the operator had done exactly what the server teaches.

test('the routing enum makes a service lab work', () => {
  assert.equal(isLabService({ type: 'lab' }), true);
  assert.equal(isLabService({ type: 'consultation' }), false);
});

test('the older is_lab flag still counts', () => {
  assert.equal(isLabService({ type: 'consultation', is_lab: 1 }), true);
  assert.equal(isLabService({ type: 'consultation', is_lab: true }), true);
  assert.equal(isLabService({ type: 'consultation', is_lab: 0 }), false);
});

test('a service in a laboratory DEPARTMENT is lab work', () => {
  const deptKindById = deptKindMap([
    { id: 1, name: 'Стационар', kind: 'inpatient' },
    { id: 5, name: 'Лаборатория', kind: 'laboratory' },
  ]);
  assert.equal(isLabService({ type: 'consultation', department_id: 5 }, { deptKindById }), true);
  assert.equal(isLabService({ type: 'consultation', department_id: 1 }, { deptKindById }), false);
  assert.equal(isLabService({ type: 'consultation', department_id: 99 }, { deptKindById }), false, 'unknown department is not lab');
  assert.equal(isLabService({ type: 'consultation', department_id: null }, { deptKindById }), false);
});

test('a service whose catalogue TYPE is named like a laboratory is lab work', () => {
  const typeNameById = typeNameMap([
    { id: 1, name: 'Консультация' },
    { id: 2, name: 'Лаборатория' },
    { id: 3, name: 'Laboratory' },
    { id: 4, name: 'Lab tests' },
    { id: 5, name: 'Лабораторная диагностика' },
  ]);
  for (const id of [2, 3, 4, 5]) {
    assert.equal(isLabService({ type: 'consultation', type_id: id }, { typeNameById }), true, 'type ' + id);
  }
  assert.equal(isLabService({ type: 'consultation', type_id: 1 }, { typeNameById }), false);
});

test('the name rule matches the three spellings and nothing accidental', () => {
  for (const s of ['Лаборатория', 'лаборатор', 'Laboratory', 'laboratory', 'Lab', 'LAB', 'Lab tests']) {
    assert.equal(LAB_NAME_RE.test(s), true, s + ' should match');
  }
  // «Лабильность» shares a prefix in Latin transliteration but not in Cyrillic;
  // more importantly a type named for something else must not be swept in.
  for (const s of ['Консультация', 'Процедуры', 'Диагностика', 'Хирургия', 'Collaboration']) {
    assert.equal(LAB_NAME_RE.test(s), false, s + ' should NOT match');
  }
});

test('a linked panel alone declares a service to be lab work', () => {
  assert.equal(isLabService({ type: 'consultation', id: 7 }, { hasPanel: (id) => id === 7 }), true);
  assert.equal(isLabService({ type: 'consultation', id: 8 }, { hasPanel: (id) => id === 7 }), false);
  assert.equal(isLabService({ type: 'consultation', id: 7 }, { hasPanel: true }), true);
});

test('missing lookups never throw and never guess', () => {
  assert.equal(isLabService({ type: 'consultation', department_id: 5, type_id: 2 }), false,
    'with no lookup maps the department/type branches cannot fire');
  assert.equal(isLabService(null), false);
  assert.equal(isLabService(undefined), false);
  assert.equal(isLabService({}), false);
});

test('the lookup builders tolerate junk', () => {
  assert.deepEqual(deptKindMap(null), {});
  assert.deepEqual(deptKindMap([null, { id: null, kind: 'laboratory' }, { id: 3 }]), { 3: '' });
  assert.deepEqual(typeNameMap(undefined), {});
  assert.deepEqual(typeNameMap([{ id: 2, name: 'Лаборатория' }]), { 2: 'Лаборатория' });
});
