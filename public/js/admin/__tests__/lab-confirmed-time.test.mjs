// LAB_CONFIRMED_TIME_V1 (2026-11-23, владелец: «we need to make for the analysis
// reports the time of the confirmed») — бланк анализов называет, КОГДА лаборатория
// подтвердила результат: поле «Подтверждено · Tasdiqlandi» с датой и временем по
// местным часам, в обоих видах бланка (полный и экономный). Нет подтверждения — «—».
// Время ставит сервер (routes/db.js stampVerifiedServerTime), а не часы компьютера
// лаборанта.
// Пояс задан явно — правило про МЕСТНОЕ время клиники (как print-visit-date.test.mjs).
process.env.TZ = 'Asia/Tashkent';

const { test } = await import('node:test');
const { default: assert } = await import('node:assert/strict');
const { renderDesignedVariant } = await import('../views/doc-variants.js');
const { labIssueDates } = await import('../views/lab-doc.js');
const { stampVerifiedServerTime } = await import('../../../../server/routes/db.js');

const S = { accent: '#167873', ink: '#16213f', clinicName: 'Клиника' };
const text = (html) => html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const sheet = (extra) => ({
    patientName: 'Тестов Пациент', dob: '01.01.1990', sex: 'Мужской', mrn: '0000001', requestNo: '00000042',
    groups: [{ title: 'ОАК · № 00000042', tests: [{ name: 'Гемоглобин', value: '140', unit: 'г/л', ref: '120–160', flag: '' }] }],
    ...extra,
});

test('подтверждено в 02:30 по Ташкенту (вчерашние 21:30Z): «Подтверждено 19.08.2026, 02:30», «Выдан» — 19.08', () => {
    const d = labIssueDates({ visitDate: '2026-08-18T05:00:00Z', verifiedAt: '2026-08-18T21:30:00Z', lastEnteredAt: '2026-08-18T12:00:00Z' });
    assert.deepEqual(d, { dateIn: '18.08.2026', dateOut: '19.08.2026', confirmedAt: '19.08.2026, 02:30' });
});

for (const variant of ['classic', 'compact']) {
    test(`бланк «${variant}»: поле «Подтверждено · Tasdiqlandi» с датой и временем; без подтверждения — «—»`, () => {
        const done = text(renderDesignedVariant('lab', variant, S, sheet({ dateIn: '18.08.2026', dateOut: '19.08.2026', confirmedAt: '19.08.2026, 02:30' })));
        assert.match(done, /Подтверждено 19\.08\.2026, 02:30 Tasdiqlandi/, 'на бланке нет времени подтверждения');
        const open = text(renderDesignedVariant('lab', variant, S, sheet({ dateIn: '18.08.2026', dateOut: '18.08.2026', confirmedAt: '' })));
        assert.match(open, /Подтверждено — Tasdiqlandi/, 'неподтверждённый бланк выдаёт время подтверждения');
    });
}

test('сервер ставит своё время в verified_at (lab_results, visit_services); снятие отметки и чужие таблицы — как прислано', () => {
    const before = Date.now();
    const body = { values: { verified_by: 5, verified_at: '1999-01-01T00:00:00Z' } };
    assert.equal(stampVerifiedServerTime({ table: 'lab_results', op: 'update' }, body), true);
    const t = Date.parse(body.values.verified_at);
    assert.ok(t >= before - 1000 && t <= Date.now() + 1000, 'время — не серверное: ' + body.values.verified_at);
    assert.match(body.values.verified_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, 'вид отметки не тот, что у экрана');

    const vs = { values: { status: 'completed', verified_at: '2000-01-01T00:00:00Z' } };
    assert.equal(stampVerifiedServerTime({ table: 'visit_services', op: 'update' }, vs), true);
    assert.notEqual(vs.values.verified_at, '2000-01-01T00:00:00Z');

    const cleared = { values: { verified_by: null, verified_at: null } };
    assert.equal(stampVerifiedServerTime({ table: 'lab_results', op: 'update' }, cleared), false);
    assert.equal(cleared.values.verified_at, null, 'снятая отметка получила время');

    const other = { values: { verified_at: '2000-01-01T00:00:00Z' } };
    assert.equal(stampVerifiedServerTime({ table: 'visit_documents', op: 'update' }, other), false);
    assert.equal(stampVerifiedServerTime({ table: 'lab_results', op: 'select' }, { values: null }), false);
});
