// SERVICE_GROUPS_V1 — the group resolver.
//
// The bug this replaces: pickers compared `svc.type_id === selectedGroupId`
// against a column that was NULL for every service, so selecting any group
// returned nothing and the chip rail collapsed to a single «Прочее». These tests
// pin the derivation so a catalogue imported without type_id still groups.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    TYPE_TO_GROUP_NAME, serviceTypeKey, resolveTypeId, serviceGroupLabel, serviceInGroup,
} from './service-group.js';

// The live service_types rows.
const TYPES = [
    { id: 1, name: 'Консультации' },
    { id: 2, name: 'Диагностика' },
    { id: 3, name: 'Лаборатория' },
    { id: 4, name: 'Процедуры' },
    { id: 5, name: 'Хирургия' },
];

test('an explicit type_id wins — an admin who moved a service by hand is obeyed', () => {
    // type says lab, but someone filed it under Диагностика: honour the filing.
    assert.equal(resolveTypeId({ type: 'lab', type_id: 2 }, TYPES), '2');
});

test('a NULL type_id is derived from the routing type — the whole bug in one line', () => {
    assert.equal(resolveTypeId({ type: 'lab', type_id: null }, TYPES), '3');
    assert.equal(resolveTypeId({ type: 'consultation', type_id: null }, TYPES), '1');
    assert.equal(resolveTypeId({ type: 'imaging', type_id: null }, TYPES), '2');
    assert.equal(resolveTypeId({ type: 'procedure', type_id: null }, TYPES), '4');
    assert.equal(resolveTypeId({ type: 'other', type_id: null }, TYPES), '5');
});

test('every routing value in the CHECK set maps to a group name', () => {
    // Mirrors migration 023's CHECK — a value with no mapping would fall into a
    // bucket the UI cannot show, which is exactly what happened before.
    for (const t of ['consultation', 'lab', 'procedure', 'imaging', 'radiology', 'other']) {
        assert.ok(TYPE_TO_GROUP_NAME[t], `no group name for type=${t}`);
    }
});

test('is_lab rescues a service whose type is blank', () => {
    assert.equal(serviceTypeKey({ type: '', is_lab: 1 }), 'lab');
    assert.equal(resolveTypeId({ type: null, is_lab: 1, type_id: null }, TYPES), '3');
});

test('an unknown type falls back to a real group, never to nothing', () => {
    assert.equal(serviceTypeKey({ type: 'wat' }), 'consultation');
    assert.equal(resolveTypeId({ type: 'wat', type_id: null }, TYPES), '1');
});

test('resolveTypeId returns "" only when the types list is unusable', () => {
    assert.equal(resolveTypeId({ type: 'lab', type_id: null }, []), '');
    assert.equal(resolveTypeId({ type: 'lab', type_id: null }, null), '');
    assert.equal(resolveTypeId(null, TYPES), '');
});

test('serviceInGroup: a blank group id means "all" and matches every service', () => {
    for (const g of ['', null, undefined]) {
        assert.equal(serviceInGroup({ type: 'lab', type_id: null }, g, TYPES), true);
    }
});

test('serviceInGroup: selecting a group returns its services and excludes others', () => {
    const labs = { type: 'lab', type_id: null };
    const cons = { type: 'consultation', type_id: null };
    assert.equal(serviceInGroup(labs, '3', TYPES), true);
    assert.equal(serviceInGroup(cons, '3', TYPES), false);
    assert.equal(serviceInGroup(cons, 1, TYPES), true, 'a numeric group id compares the same');
});

test('a NULL-type_id catalogue no longer collapses into one group', () => {
    // The live shape before migration 056: every service NULL, five real types.
    const catalogue = [
        { name: 'Приём', type: 'consultation', type_id: null },
        { name: 'ОАК', type: 'lab', type_id: null },
        { name: 'УЗИ', type: 'imaging', type_id: null },
        { name: 'Инъекция', type: 'procedure', type_id: null },
        { name: 'Лапароскопия', type: 'other', type_id: null },
    ];
    const groups = new Set(catalogue.map(s => resolveTypeId(s, TYPES)));
    assert.equal(groups.size, 5, 'five distinct groups, not one');
    assert.ok(!groups.has(''), 'and none unresolved');

    // And every group's filter returns exactly its own service.
    for (const t of TYPES) {
        const hits = catalogue.filter(s => serviceInGroup(s, String(t.id), TYPES));
        assert.equal(hits.length, 1, `group ${t.name} must not come back empty`);
    }
});

test('serviceGroupLabel prefers the real type, then the embed, then the derivation', () => {
    assert.equal(serviceGroupLabel({ type_id: 3 }, TYPES), 'Лаборатория');
    assert.equal(serviceGroupLabel({ type_id: null, service_types: { name: 'Своя группа' } }, TYPES), 'Своя группа');
    assert.equal(serviceGroupLabel({ type_id: null, type: 'imaging' }, TYPES), 'Диагностика');
    // The old behaviour: no type_id and no embed produced «Прочее» for everything.
    assert.notEqual(serviceGroupLabel({ type_id: null, type: 'lab' }, TYPES), 'Прочее');
});
