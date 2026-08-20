// CRM_SERVICE_FILTER_V1 — the call centre's «Интересующие услуги» search had a
// name box and nothing else: 511 services behind one text field, and an
// operator who did not know the exact wording had to guess it while the patient
// waited. The registrar's picker has had a counted category rail for a while
// (service-picker-modal.js paintCatGroups) — this is that rail's logic, made
// pure so it can be tested away from the DOM.
//
// The load-bearing rule: picking a category NARROWS THE SEARCH. Typing after
// choosing «Лаборатория» must not surface a consultation.

import test from 'node:test';
import assert from 'node:assert/strict';
import { serviceGroupCounts, filterServicePool } from './service-search.js';

// The live service_types rows, same shape as service-group.test.js.
const TYPES = [
    { id: 1, name: 'Консультации' },
    { id: 2, name: 'Диагностика' },
    { id: 3, name: 'Лаборатория' },
];

// type_id deliberately NULL on some rows: that is the state the catalogue
// shipped in, and the bug that collapsed the other picker into one «Прочее».
const CATALOG = [
    { id: 10, name: 'Консультация кардиолога', price: 100000, type: 'consultation', type_id: 1 },
    { id: 11, name: 'Консультация невролога',  price: 90000,  type: 'consultation', type_id: null },
    { id: 12, name: 'МРТ головного мозга',     price: 400000, type: 'imaging',      type_id: 2 },
    { id: 13, name: 'Общий анализ крови',      price: 50000,  type: 'lab',          type_id: null },
    { id: 14, name: 'Анализ крови на сахар',   price: 60000,  type: 'lab',          type_id: 3 },
];

test('no category and no query returns the whole catalogue', () => {
    const pool = filterServicePool(CATALOG, { types: TYPES });
    assert.equal(pool.length, 5);
});

test('a category narrows the pool, deriving the group when type_id is NULL', () => {
    const pool = filterServicePool(CATALOG, { groupId: '3', types: TYPES });
    // Both lab rows, though only one of them carries a type_id.
    assert.deepEqual(pool.map((s) => s.id), [13, 14]);
});

test('search inside a category never escapes it — the whole point of the feature', () => {
    // «крови» matches two lab services; «консультация» matches none IN Лаборатория,
    // even though the catalogue has two consultations by that name.
    assert.deepEqual(
        filterServicePool(CATALOG, { groupId: '3', query: 'крови', types: TYPES }).map((s) => s.id),
        [13, 14],
    );
    assert.deepEqual(
        filterServicePool(CATALOG, { groupId: '3', query: 'консультация', types: TYPES }),
        [],
    );
});

test('search is case-insensitive and matches anywhere in the name', () => {
    assert.deepEqual(
        filterServicePool(CATALOG, { query: 'МРТ', types: TYPES }).map((s) => s.id), [12]);
    assert.deepEqual(
        filterServicePool(CATALOG, { query: 'мрт', types: TYPES }).map((s) => s.id), [12]);
    assert.deepEqual(
        filterServicePool(CATALOG, { query: 'сахар', types: TYPES }).map((s) => s.id), [14]);
});

test('already-picked services drop out of the pool', () => {
    const pool = filterServicePool(CATALOG, { chosen: [13, '14'], types: TYPES });
    assert.deepEqual(pool.map((s) => s.id), [10, 11, 12]);
});

test('limit caps the result, and is applied AFTER filtering', () => {
    const pool = filterServicePool(CATALOG, { groupId: '1', limit: 1, types: TYPES });
    assert.equal(pool.length, 1);
    assert.equal(pool[0].id, 10, 'the cap must not reorder or skip the category match');
});

test('counts are per group and exclude what is already picked', () => {
    const counts = serviceGroupCounts(CATALOG, { types: TYPES });
    assert.equal(counts.total, 5);
    assert.equal(counts.byGroup['1'], 2, 'both consultations, one with a NULL type_id');
    assert.equal(counts.byGroup['2'], 1);
    assert.equal(counts.byGroup['3'], 2);

    const after = serviceGroupCounts(CATALOG, { chosen: [13], types: TYPES });
    assert.equal(after.total, 4);
    assert.equal(after.byGroup['3'], 1, 'picking a lab service decrements Лаборатория');
});

test('an empty catalogue counts to zero rather than throwing', () => {
    const counts = serviceGroupCounts([], { types: TYPES });
    assert.equal(counts.total, 0);
    assert.deepEqual(counts.byGroup, {});
    assert.deepEqual(filterServicePool([], { types: TYPES }), []);
});
