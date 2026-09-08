// INPATIENT_DOCS_V1 — три бумаги при поступлении: договор, согласие, памятка.
//
// Владелец: «in the dialogue window of the editing patients information we
// need to add a 3 types of the documents … also we need to add a documents
// content into a documents section». Текст — из настроек дизайнера, по
// умолчанию — формулировки образцов Aurora.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSheetHtml, INPATIENT_DOC_TYPES, INPATIENT_DOC_META, INPATIENT_DOC_DEFAULT_TEXT, inpatientDocText } from './doc-render.js';

const S = {
    clinicName: 'Клиника Тест', tagline: '', address: 'Ташкент', phone: '+998', email: '', web: '',
    accent: '#167873', accentSoft: '#effaf8', ink: '#0b1418', paperBg: '#fff',
    showWatermark: false, showStamp: false, showSignature: false, showQR: false,
    language: 'ru', paperSize: 'A4', fontPair: 'modern', cornerStyle: 'rounded', footerNote: '', legalNote: '', variant: {},
};
const D = { patientName: 'Иванов Иван Иванович', department: 'Терапия', ward: 'Т-1', bed: 'T-2', doctorName: '', date: '08.09.2026' };

test('три бумаги: заголовок, узбекский подзаголовок, текст по умолчанию, пациент, подписи', () => {
    assert.deepEqual(INPATIENT_DOC_TYPES, ['inpatient_contract', 'inpatient_consent', 'inpatient_memo']);
    for (const type of INPATIENT_DOC_TYPES) {
        const html = buildSheetHtml({ type, s: S, data: D });
        const m = INPATIENT_DOC_META[type];
        for (const piece of [m.titleRu, m.titleUz, 'Иванов Иван Иванович', 'Терапия', 'Т-1 / T-2', 'Пациент / Bemor', 'Врач / Shifokor', 'Клиника Тест', '08.09.2026']) {
            assert.ok(html.includes(piece), type + ': нет ' + piece);
        }
        const firstPara = INPATIENT_DOC_DEFAULT_TEXT[m.textKey].split(/\n\s*\n/)[0].slice(0, 40);
        assert.ok(html.includes(firstPara), type + ': текста по умолчанию нет');
    }
});

test('текст клиники из настроек вытесняет текст по умолчанию; пустой — нет', () => {
    const s = Object.assign({}, S, { inpatientContractText: 'Пункт первый.\n\nПункт второй.' });
    const html = buildSheetHtml({ type: 'inpatient_contract', s, data: D });
    assert.ok(html.includes('Пункт первый.') && html.includes('Пункт второй.'));
    assert.ok(!html.includes('Предмет договора'));
    assert.equal(inpatientDocText(Object.assign({}, S, { inpatientContractText: '   ' }), 'inpatient_contract'),
        INPATIENT_DOC_DEFAULT_TEXT.inpatientContractText);
});

test('без данных — образец для предпросмотра; без врача — линия для подписи; значения экранируются', () => {
    const html = buildSheetHtml({ type: 'inpatient_memo', s: S });
    assert.ok(html.includes('Пациент / Bemor'));
    const noDoc = buildSheetHtml({ type: 'inpatient_consent', s: S, data: Object.assign({}, D, { doctorName: '' }) });
    assert.ok(noDoc.includes('Врач / Shifokor'));
    const evil = buildSheetHtml({ type: 'inpatient_consent', s: S, data: Object.assign({}, D, { patientName: '<b>x</b>' }) });
    assert.ok(evil.includes('&lt;b&gt;x&lt;/b&gt;'));
});
