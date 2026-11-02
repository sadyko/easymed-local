// PRINT_VISIT_DATE_V1 (3.21.0) — ДАТА В ПЕЧАТИ ПРОТОКОЛА — ДЕНЬ ПРИЁМА.
//
// Часть 1 — правило и листы, без кабинета:
//   • «день документа» (shared/cabinet-doc.js docDayText): местный день визита,
//     иначе первая подпись записи, иначе сегодня;
//   • заключение (doc-variants.js): «Тип визита» печатается только настоящий —
//     выдуманного «Первичный приём» по умолчанию больше нет;
//   • лист диагностики: день из данных (dateOut), старый архивный лист без
//     dateOut — свой issueDate, а не день перепечатки.
// Пояс задан явно — правило про МЕСТНЫЙ день клиники (как rpc/visits.local-day.test.js).
process.env.TZ = 'Asia/Tashkent';

const { test } = await import('node:test');
const { default: assert } = await import('node:assert/strict');
const { docDayText } = await import('../../shared/cabinet-doc.js');
const { dateNumeric } = await import('../../shared/date-words.js');
const { renderDesignedVariant, visitTypeLabel } = await import('../views/doc-variants.js');

const S = { accent: '#167873', ink: '#16213f', clinicName: 'Клиника' };
const text = (html) => html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const TODAY = dateNumeric(new Date());

test('день документа — МЕСТНЫЙ день визита: приём в 00:30 по Ташкенту (вчерашние 19:30Z) — тот же день, не вчера', () => {
    assert.equal(docDayText({ visitDate: '2026-10-30T19:30:00.000Z' }), '31.10.2026');
    assert.equal(docDayText({ visitDate: '2026-10-31T09:00:00.000Z' }), '31.10.2026');
    assert.equal(docDayText({ visitDate: '2026-10-31' }), '31.10.2026', 'дата без времени — местная полночь, а не вчерашний день');
});

test('день документа: нет визита — день ПЕРВОЙ подписи; нет и её — сегодня', () => {
    const history = [
        { kind: 'draft', savedAt: '2026-09-30T10:00:00.000Z' },
        { kind: 'signed', savedAt: '2026-10-01T08:00:00.000Z' },
        { kind: 'signed', savedAt: '2026-10-05T08:00:00.000Z' },
    ];
    assert.equal(docDayText({ visitDate: null, history }), '01.10.2026', 'взята не первая подпись');
    assert.equal(docDayText({ visitDate: 'не дата', history }), '01.10.2026', 'испорченная дата визита напечаталась');
    assert.equal(docDayText({ history: [history[0]], now: new Date(2026, 10, 2, 15, 0) }), '02.11.2026', 'черновик — не подпись');
    assert.equal(docDayText(), TODAY);
});

test('«Тип визита» — ступень цены строки; «primary» и пусто — без строки', () => {
    assert.equal(visitTypeLabel('secondary'), 'Второй визит');
    assert.equal(visitTypeLabel('repeat'), 'Повторный визит');
    for (const t of ['primary', null, undefined, '', 'другое']) assert.equal(visitTypeLabel(t), '', String(t));
});

test('заключение (classic): «Тип визита» — только настоящий; «Первичный приём» по умолчанию не печатается', () => {
    const base = { patientName: 'Пациент Тест', mrn: 'P-1', doctorName: 'Врач Тест', issueDate: '28.10.2026', complaint: 'Кашель' };
    const none = text(renderDesignedVariant('conclusion', 'classic', S, base));
    assert.ok(!none.includes('Тип визита'), 'без данных строка «Тип визита» осталась');
    assert.ok(!none.includes('Первичный приём'), '«Первичный приём» по умолчанию остался');
    assert.match(none, /Дата приёма 28\.10\.2026/);
    const rep = text(renderDesignedVariant('conclusion', 'classic', S, { ...base, visitType: 'Повторный визит' }));
    assert.match(rep, /Тип визита Повторный визит/);
});

test('лист диагностики: dateOut — его день; старый архивный лист без dateOut — свой issueDate, не день перепечатки', () => {
    const diag = { patientName: 'Пациент Тест', mrn: 'P-1', service: 'УЗИ почек', description: 'Почки обычных размеров', conclusion: 'Норма' };
    for (const v of ['classic', 'compact']) {
        const archived = text(renderDesignedVariant('diag', v, S, { ...diag, issueDate: '05.10.2026' }));
        assert.ok(archived.includes('05.10.2026'), v + ': старый лист без dateOut не напечатал свой issueDate');
        if (TODAY !== '05.10.2026') assert.ok(!archived.includes(TODAY), v + ': старый лист датирован днём перепечатки');
        const fresh = text(renderDesignedVariant('diag', v, S, { ...diag, issueDate: '05.10.2026', dateOut: '04.10.2026' }));
        assert.ok(fresh.includes('04.10.2026') && !fresh.includes('05.10.2026'), v + ': dateOut не главнее issueDate');
        const bare = text(renderDesignedVariant('diag', v, S, diag));
        assert.ok(bare.includes(TODAY), v + ': лист без даты остался без даты');
    }
});
