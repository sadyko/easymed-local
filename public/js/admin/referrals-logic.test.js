// REFERRALS_CRM_V1 — чистая логика экрана «Реферирование».
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    defaultPeriod, dmy, fmtSum, subline, matches, groupByRepresentative, groupTotals,
    dynamicsCell, printSheet, ACTIVITY_LABELS, ACTIVITY_TAG,
} from './referrals-logic.js';

test('defaultPeriod: с 1-го числа месяца по сегодня, локальные даты', () => {
    assert.deepEqual(defaultPeriod(new Date(2026, 9, 26, 15, 0)), { from: '2026-10-01', to: '2026-10-26' });
    assert.deepEqual(defaultPeriod(new Date(2026, 0, 1, 0, 30)), { from: '2026-01-01', to: '2026-01-01' });
});

test('dmy / fmtSum / subline', () => {
    assert.equal(dmy('2026-10-26'), '26.10.2026');
    assert.equal(dmy(''), '—');
    assert.equal(fmtSum(14705000), '14 705 000');
    assert.equal(fmtSum('x'), '—');
    assert.equal(subline(['№ 0003', '', null, '998912098887']), '№ 0003 · 998912098887');
});

test('matches: несколько полей, без регистра, пустой запрос — всё', () => {
    const row = { name: 'Набиев Ойбек', code: '0086', phone: '+998 90 310 65 70' };
    assert.equal(matches(row, 'ойбек', ['name', 'code']), true);
    assert.equal(matches(row, '0086', ['name', 'code']), true);
    assert.equal(matches(row, '310', ['name', 'code']), false, 'телефон не в списке полей');
    assert.equal(matches(row, '', ['name']), true);
});

test('groupByRepresentative: группы в порядке представителей, пустая группа представителя остаётся, «Без представителя» — последняя и только непустая', () => {
    const reps = [{ id: 4, full_name: 'Один' }, { id: 7, full_name: 'Два' }];
    const sources = [
        { id: 1, name: 'А', representative_id: 7, visits: 2, patients: 2, received: 100 },
        { id: 2, name: 'Б', representative_id: null, visits: 0, patients: 0, received: 0 },
        { id: 3, name: 'В', representative_id: 99, visits: 1, patients: 1, received: 5 },   // уволенный — без представителя
    ];
    const g = groupByRepresentative(sources, reps);
    assert.deepEqual(g.map((x) => (x.rep ? x.rep.full_name : null)), ['Один', 'Два', null]);
    assert.deepEqual(g[0].rows, []);
    assert.deepEqual(g[1].rows.map((r) => r.id), [1]);
    assert.deepEqual(g[2].rows.map((r) => r.id), [2, 3]);
    assert.deepEqual(g[2].totals, { doctors: 2, referring: 1, visits: 1, patients: 1, received: 5 });
    assert.deepEqual(groupByRepresentative([{ id: 1, representative_id: 4, visits: 0 }], reps).length, 2, 'нет «без представителя» — группы нет');
});

test('groupTotals считает врачей, направлявших и суммы; нечисла — нули', () => {
    assert.deepEqual(groupTotals([{ visits: 3, patients: 2, received: '10' }, { visits: 0 }]),
        { doctors: 2, referring: 1, visits: 3, patients: 2, received: 10 });
});

test('dynamicsCell: «+3» / «−2» / «—»', () => {
    assert.deepEqual(dynamicsCell(5, 2), { text: '+3', kind: 'ok' });
    assert.deepEqual(dynamicsCell(1, 3), { text: '−2', kind: 'crit' });
    assert.deepEqual(dynamicsCell(0, 0), { text: '—', kind: '' });
    for (const k of Object.keys(ACTIVITY_LABELS)) assert.ok(k in ACTIVITY_TAG, 'нет цвета у статуса ' + k);
});

test('printSheet: колонки — подписи, строки — массивы в порядке колонок, числа остаются числами', () => {
    const sheet = printSheet({
        title: 'Врачи', from: '2026-10-01', to: '2026-10-26',
        columns: [{ key: 'name', label: 'Врач' }, { key: 'visits', label: 'Визитов' }, { label: 'Код', value: (r) => '№ ' + r.code }],
        rows: [{ name: 'А', visits: 3, code: '0001' }],
    });
    assert.deepEqual(sheet.res, { columns: ['Врач', 'Визитов', 'Код'], rows: [['А', 3, '№ 0001']] });
    assert.deepEqual(sheet.meta, { title: 'Врачи', from: '2026-10-01', to: '2026-10-26' });
});
