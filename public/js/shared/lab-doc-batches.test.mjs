// LAB_DOC_SPLIT_V1 (решение владельца 2026-11-07, п. 8) — подтверждённая часть
// заказа — ОТДЕЛЬНЫЙ документ; остальное — свой документ, пока не будет готово.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { labDocBatches, ISSUED_LEGACY } from './lab-doc-batches.js';

const o = (id, status, verifiedAt = null, visitId = 20) => ({ id, visitId, status, verifiedAt });
const has = (ids) => (id) => ids.includes(id);
const brief = (docs) => docs.map((d) => [d.kind, d.orderIds, d.ready, d.total]);

test('ничего не подтверждено — один документ визита «готовится»: готово N из M', () => {
    const docs = labDocBatches([o(1, 'resulted'), o(2, 'queued'), o(3, 'in_progress')], { hasResult: has([1]) });
    assert.deepEqual(brief(docs), [['pending', [1, 2, 3], 1, 3]]);
});

test('подтвердили часть — она отдельным документом; остальное — свой документ, пока не готово', () => {
    const T1 = '2026-11-07T08:00:00.000Z';
    const docs = labDocBatches([o(1, 'completed', T1), o(2, 'resulted'), o(3, 'queued')], { hasResult: has([1, 2]) });
    assert.deepEqual(brief(docs), [['issued', [1], 1, 1], ['pending', [2, 3], 1, 2]]);
    assert.equal(docs[0].verifiedAt, T1);
});

test('подтверждали в два приёма — два документа; всё подтверждено — документа «готовится» нет; выданное не дублируется', () => {
    const T1 = '2026-11-07T08:00:00.000Z';
    const T2 = '2026-11-07T11:30:00.000Z';
    const docs = labDocBatches([o(3, 'completed', T2), o(1, 'completed', T1), o(2, 'completed', T2)], { hasResult: has([1, 2, 3]) });
    assert.deepEqual(brief(docs), [['issued', [1], 1, 1], ['issued', [2, 3], 2, 2]]);
    const ids = docs.flatMap((d) => d.orderIds);
    assert.equal(new Set(ids).size, ids.length, 'каждый заказ — ровно в одном документе');
});

test('всё подтверждено разом («Подтвердить») — один документ, как прежде', () => {
    const T = '2026-11-07T08:00:00.000Z';
    assert.deepEqual(brief(labDocBatches([o(1, 'completed', T), o(2, 'completed', T)], { hasResult: has([1, 2]) })), [['issued', [1, 2], 2, 2]]);
});

test('выданные до обновления без отметки времени — один документ визита; отменённые и возвращённые — не документ; визиты — отдельно', () => {
    const docs = labDocBatches([
        o(1, 'completed', null), o(2, 'completed', null), o(3, 'cancelled'), o(4, 'refunded'),
        o(9, 'resulted', null, 21),
    ], { hasResult: has([1, 2, 9]) });
    assert.deepEqual(docs.map((d) => [d.visitId, d.kind, d.orderIds]), [[20, 'issued', [1, 2]], [21, 'pending', [9]]]);
    assert.equal(docs[0].verifiedAt, ISSUED_LEGACY);
});

test('ready: документ «готов», когда у каждого его заказа есть результат', () => {
    const docs = labDocBatches([o(1, 'resulted'), o(2, 'resulted')], { hasResult: has([1, 2]) });
    assert.equal(docs[0].complete, true);
    assert.equal(labDocBatches([o(1, 'resulted'), o(2, 'queued')], { hasResult: has([1]) })[0].complete, false);
});
