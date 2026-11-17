// LAB_DOC_SPLIT_V1 (решение владельца 2026-11-07, п. 8) — подтверждённая часть
// заказа — ОТДЕЛЬНЫЙ документ; остальное — свой документ, пока не будет готово.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { labDocBatches, labDocIssued, ISSUED_LEGACY } from './lab-doc-batches.js';

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

// LAB_DOC_NOT_READY_V1 (решение владельца, 3.25.0) — было: документ «внесены, не
// подтверждены» с полным набором результатов считался готовым (complete) и уходил в
// окно печати. Теперь complete значит только «у каждого заказа есть результат», а
// открыть и напечатать (printable) можно только ВЫДАННЫЙ документ.
test('complete — у каждого заказа документа есть результат; LAB_DOC_NOT_READY_V1: printable — только у выданного', () => {
    const docs = labDocBatches([o(1, 'resulted'), o(2, 'resulted')], { hasResult: has([1, 2]) });
    assert.equal(docs[0].complete, true);
    assert.equal(docs[0].printable, false, 'внесён полностью, но не подтверждён — не открывается и не печатается');
    assert.equal(labDocBatches([o(1, 'resulted'), o(2, 'queued')], { hasResult: has([1]) })[0].complete, false);
    const T = '2026-11-07T08:00:00.000Z';
    assert.equal(labDocBatches([o(1, 'completed', T), o(2, 'completed', T)], { hasResult: has([1, 2]) })[0].printable, true);
    assert.equal(labDocBatches([o(1, 'completed', T), o(2, 'completed', T)], { hasResult: has([1]) })[0].printable, false,
        'выдан, но у части заказов результата нет — печатать нечего');
});

// LAB_DOC_NOT_READY_V1 — ОДНО правило «документ выдан» на ленту «Документов», архив
// пациента, карту пациента и историю болезни: строка подтверждена («completed») или
// на ней стоит отметка проверки (verified_at). Внесённый, но не подтверждённый
// анализ ('resulted' без отметки) — «Не готов».
test('LAB_DOC_NOT_READY_V1: выдан — «completed» или отметка проверки; внесённый без подтверждения и всё, что раньше, — нет', () => {
    const T = '2026-11-07T08:00:00.000Z';
    assert.equal(labDocIssued('completed', null), true);
    assert.equal(labDocIssued('completed', T), true);
    assert.equal(labDocIssued('resulted', T), true, 'отметка проверки — выдан');
    assert.equal(labDocIssued('resulted', null), false);
    assert.equal(labDocIssued('resulted', ''), false);
    for (const s of ['added', 'queued', 'collected', 'in_progress', 'cancelled', '', null, undefined]) {
        assert.equal(labDocIssued(s, null), false, String(s));
    }
});

test('LAB_DOC_NOT_READY_V1: документы визита делятся тем же правилом — отметка проверки без «completed» тоже выдан', () => {
    const T = '2026-11-07T08:00:00.000Z';
    const docs = labDocBatches([o(1, 'resulted', T), o(2, 'resulted')], { hasResult: has([1, 2]) });
    assert.deepEqual(brief(docs), [['issued', [1], 1, 1], ['pending', [2], 1, 1]]);
    assert.deepEqual(docs.map((d) => d.printable), [true, false]);
});
