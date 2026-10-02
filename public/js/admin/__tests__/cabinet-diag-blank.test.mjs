// CABINET_FIX_V1_DIAG (2026-10-02) — БЛАНК ДИАГНОСТИКИ ПОКАЗЫВАЕТ УСЛУГУ И НЕ
// ТЕРЯЕТ «ОПИСАНИЕ» И «ЗАКЛЮЧЕНИЕ».
//
// Владелец: «in the doctors cabinet when selected the document type,
// diagnostics, we cannot see in the blank, what type of service is that».
// Проверено в браузере на чистой базе с услугой «УЗИ почек и м/п» до правки:
//   • «Исследование» и «Область» в шапке — «—», карточка «Исследование» пустая:
//     шаблон читал d.study, а его не строил никто (только образец);
//   • набранное «Описание» не сохранялось: у формы под бланком не было поля
//     instrumental_text, и _syncBlankField писать было некуда;
//   • набранное «Заключение» уходило в primary_diagnosis свёрнутого раздела
//     «Диагноз», а collectFields свёрнутые разделы пропускает;
//   • печать с пустыми (несобранными) полями печатала ОБРАЗЕЦ — «Рахимов
//     Жасур / МРТ головного мозга» вместо этого пациента;
//   • подпись — зашитый «Врач-рентгенолог», и у УЗИ тоже;
//   • «Диагностика» сама не выбиралась: только у отделения kind='diagnostics',
//     а у диагностических услуг клиники отделения нет.
//
// Здесь — рисование бланка (doc-variants.js, чистые функции) и правила кабинета,
// вынесенные в экспорт ради поведенческой проверки (как addOwnService).
// Живой кабинет целиком проверен Playwright-прогоном на мигрированной базе.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {}, clear() {} };
globalThis.window = { location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, innerWidth: 1440, addEventListener() {} };
globalThis.document = { createElement: () => ({ style: {}, appendChild() {}, setAttribute() {} }), head: { appendChild() {} }, body: { appendChild() {} }, addEventListener() {}, getElementById: () => null, querySelector: () => null, documentElement: { style: {} } };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WS_SRC = fs.readFileSync(path.join(HERE, '..', 'views', 'service-workspace.js'), 'utf8');
const { renderDesignedVariant } = await import('../views/doc-variants.js');
const WS = await import('../views/service-workspace.js');

const S = { accent: '#167873', ink: '#16213f', clinicName: 'Клиника' };
const VARIANTS = ['classic', 'compact'];
const real = (extra = {}) => ({ patientName: 'Азизов Бахтиёр', mrn: 'P-1', service: 'УЗИ почек и м/п', description: '', conclusion: '', ...extra });
// Текст бланка без разметки: «Исследование» и значение стоят в соседних узлах.
const text = (html) => html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
// Шапка и правая колонка «Исследование» — до раздела «Описание».
const head = (html) => text(html).split(/Описание/)[0];

test('«Исследование» в шапке — название услуги: на экране, в печати и в архивном теле', () => {
    for (const v of VARIANTS) {
        // экран (__editor) и печать (без него) — одни данные
        for (const editor of [true, false]) {
            const html = renderDesignedVariant('diag', v, S, real({ __editor: editor }));
            assert.match(head(html), /УЗИ почек и м\/п/, v + (editor ? ' экран' : ' печать') + ': услуги нет в шапке');
        }
        // уже подписанный документ: в архивном теле есть `service`, `study` нет
        const archived = { __editor: false, patientName: 'Азизов Бахтиёр', service: 'УЗИ почек и м/п', description: 'Почки в норме.', conclusion: 'Патологии нет.' };
        assert.match(head(renderDesignedVariant('diag', v, S, archived)), /УЗИ почек и м\/п/, v + ': архивный документ без услуги в шапке');
    }
});

test('пустая «Область» не печатается прочерком, заполненная — печатается', () => {
    for (const v of VARIANTS) {
        assert.ok(!/Область/.test(head(renderDesignedVariant('diag', v, S, real()))), v + ': пустая «Область» осталась в шапке');
        assert.match(head(renderDesignedVariant('diag', v, S, real({ study: { area: 'Почки, мочевой пузырь' } }))), /Почки, мочевой пузырь/, v);
    }
});

test('карточка «Исследование» — только когда есть «Аппарат» или «Протокол»', () => {
    const empty = renderDesignedVariant('diag', 'classic', S, real());
    assert.ok(!/class="cards"/.test(empty), 'пустая карточка «Исследование» нарисована');
    const withDevice = renderDesignedVariant('diag', 'classic', S, real({ study: { device: 'Mindray DC-70' } }));
    assert.match(withDevice, /class="cards"/);
    assert.match(text(withDevice), /Mindray DC-70/);
    const withProtocol = renderDesignedVariant('diag', 'classic', S, real({ study: { protocol: 'B-режим, ЦДК' } }));
    assert.match(text(withProtocol), /B-режим, ЦДК/);
    // услуга, переданная study.kind, сильнее названия услуги (образец, старые вызовы)
    assert.match(head(renderDesignedVariant('diag', 'classic', S, real({ study: { kind: 'УЗИ почек с допплером' } }))), /УЗИ почек с допплером/);
});

test('подпись — основная специальность врача, иначе «Врач»; «Врач-рентгенолог» не зашит', () => {
    for (const v of VARIANTS) {
        const spec = renderDesignedVariant('diag', v, S, real({ radiologist: 'Каримов Алишер', radiologistSpec: 'Врач УЗИ-диагностики' }));
        assert.match(spec, /class="role">Врач УЗИ-диагностики/, v + ': подпись не по специальности');
        assert.ok(!/рентгенолог/i.test(spec), v + ': «Врач-рентгенолог» остался');
        const none = renderDesignedVariant('diag', v, S, real({ radiologist: 'Каримов Алишер', radiologistSpec: '' }));
        assert.match(none, /class="role">Врач[ <]/, v + ': без специальности подпись — не «Врач»');
        assert.ok(!/рентгенолог/i.test(none), v);
    }
});

test('образец «Рахимов Жасур / МРТ» — только для предпросмотра без данных, никогда для пациента', () => {
    for (const v of VARIANTS) {
        // предпросмотр в «Документах»: данных нет вовсе
        assert.match(renderDesignedVariant('diag', v, S, null), /Рахимов/, v + ': предпросмотр «Документов» потерял образец');
        // пустой бланк ЭТОГО пациента: ни описания, ни заключения
        const empty = renderDesignedVariant('diag', v, S, { patientName: 'Каримова Нилуфар', mrn: 'P-2', service: 'УЗИ щитовидной железы' });
        assert.ok(!/Рахимов|МРТ головного мозга/.test(empty), v + ': пустой бланк пациента напечатан образцом');
        assert.match(empty, /Каримова/, v);
    }
});

test('diagDocData — одни данные бланка исследования для экрана, печати и архива', () => {
    const base = { patientName: 'Азизов Бахтиёр', mrn: 'P-1', dob: '1980-05-01', sex: 'Муж.', doctorName: 'Каримов Алишер',
        doctorSpec: 'Врач УЗИ-диагностики', service: 'УЗИ почек и м/п', issueDate: '02.10.2026',
        instrumental: 'Почки обычных размеров.', dx: 'Патологии не выявлено.' };
    const d = WS.diagDocData(base, { editor: false, images: ['data:image/png;base64,AA'] });
    assert.equal(d.__editor, false);
    assert.equal(d.service, 'УЗИ почек и м/п');
    assert.equal(d.description, 'Почки обычных размеров.');
    assert.equal(d.conclusion, 'Патологии не выявлено.');
    assert.equal(d.radiologist, 'Каримов Алишер');
    assert.equal(d.radiologistSpec, 'Врач УЗИ-диагностики');
    assert.deepEqual(d.images, ['data:image/png;base64,AA']);
    assert.equal(WS.diagDocData(base, { editor: true }).__editor, true);
    // напечатанный бланк из этих данных — пациент, услуга, описание, заключение
    const html = renderDesignedVariant('diag', 'classic', S, d);
    for (const s of ['Азизов', 'УЗИ почек и м/п', 'Почки обычных размеров.', 'Патологии не выявлено.']) assert.ok(html.includes(s), s);
});

test('«Диагностика» открывается сама: группа «Диагностика» (imaging) или вид услуги «Диагностика»', () => {
    const f = WS.opensAsDiagnostics;
    assert.equal(f({ svcType: 'imaging', typeName: 'Консультации' }), true, 'группа imaging');
    assert.equal(f({ svcType: 'consultation', typeName: 'Диагностика' }), true, 'вид «Диагностика»');
    assert.equal(f({ svcType: '', typeName: 'лучевая диагностика ' }), true, 'вид «Лучевая диагностика»');
    assert.equal(f({ deptKind: 'diagnostics' }), true, 'отделение диагностики — как прежде');
    assert.equal(f({ svcType: 'consultation', typeName: 'Консультации' }), false);
    // в базе dev «C-реактивный белок» — анализ с видом «Диагностика»: бланк исследования ему не нужен
    assert.equal(f({ svcType: 'lab', typeName: 'Диагностика' }), false, 'анализ открылся бланком диагностики');
    assert.equal(f({}), false);
});

// ── сбор полей: у диагностики «Описание» и «Заключение» — всегда ─────────────
function field(key, html, { off = false, input = true } = {}) {
    return {
        innerHTML: html, value: html,
        getAttribute: (k) => (k === 'data-field' ? key : null),
        closest: (sel) => (sel === '.a4-sec-off' && off ? {} : null),
        classList: { contains: (c) => c === 'a4-input' && input },
    };
}
const ctxOf = (els) => ({ container: { querySelectorAll: () => els } });

test('collectFields: у диагностики «Описание» и «Заключение» собираются и из свёрнутого раздела', () => {
    const els = [
        field('instrumental_text', 'Почки обычных размеров.'),                 // хранилище бланка, вне разделов
        field('primary_diagnosis', 'Патологии не выявлено.', { off: true }),   // раздел «Диагноз» свёрнут
        field('therapy_text', 'Покой', { off: true }),
    ];
    const diag = WS.collectFields(ctxOf(els), { docType: 'diag' });
    assert.equal(diag.instrumental_text, 'Почки обычных размеров.');
    assert.equal(diag.primary_diagnosis, 'Патологии не выявлено.', '«Заключение» свёрнутого раздела потеряно');
    assert.ok(!('therapy_text' in diag), 'свёрнутый раздел приёма попал в документ диагностики');
    // у приёма правило прежнее: убранный раздел не сохраняется и не печатается
    const conc = WS.collectFields(ctxOf(els), { docType: 'conclusion' });
    // CABINET_FIX_V1_R1 (ревью п. 1) — строка «Диагноз» с текстом собирается при любом
    // типе: иначе переход диагностика → «Приём» терял «Заключение». Прочие свёрнутые — нет.
    assert.equal(conc.primary_diagnosis, 'Патологии не выявлено.');
    assert.ok(!('therapy_text' in conc));
    assert.equal(conc.instrumental_text, 'Почки обычных размеров.');
    // шаблон собирает свои разделы независимо от того, открыты ли они
    const tpl = WS.collectFields(ctxOf(els), { docType: 'conclusion', always: ['therapy_text'] });
    assert.equal(tpl.therapy_text, 'Покой');
});

test('строка «Диагноз»: без кода МКБ набранное «Заключение» не стирается — ни при открытии, ни при снятии', () => {
    const band = (t, mark = null) => {
        const attrs = mark == null ? {} : { 'data-auto-dx': mark };
        return {
            _t: t,
            get textContent() { return this._t; }, get innerHTML() { return this._t; }, set innerHTML(v) { this._t = String(v); },
            getAttribute: (k) => (k in attrs ? attrs[k] : null), setAttribute: (k, v) => { attrs[k] = String(v); }, removeAttribute: (k) => { delete attrs[k]; },
            attrs,
        };
    };
    const main = { code: 'N28.9', name: 'Болезнь почки' };
    // открытие сохранённого документа: основного диагноза нет — текст врача остаётся
    const b1 = band('Эхопризнаков патологии не выявлено.');
    WS.applyDxBand(b1, null, { keep: true });
    assert.equal(b1.textContent, 'Эхопризнаков патологии не выявлено.', 'открытие стёрло «Заключение»');
    // и при снятии диагноза: стирается только то, что строка получила от МКБ
    WS.applyDxBand(b1, null);
    assert.equal(b1.textContent, 'Эхопризнаков патологии не выявлено.', 'снятие диагноза стёрло набранный текст');
    // CABINET_FIX_V1_R2 (ревью 2, п. 2) — код в строку врача не пишется вовсе: он
    // рисуется на бланке своим узлом (data-dx-auto) и идёт в печать первой строкой.
    const b2 = band('');
    WS.applyDxBand(b2, main);
    assert.equal(b2.textContent, '', 'выбранный код вписан в строку врача');
    WS.applyDxBand(b2, null);
    assert.equal(b2.textContent, '');
    // открытие: в строке сохранён дописанный врачом текст — код его не затирает
    const b3 = band('N28.9 — Болезнь почки. Рекомендован контроль.');
    WS.applyDxBand(b3, main, { keep: true });
    assert.equal(b3.textContent, 'N28.9 — Болезнь почки. Рекомендован контроль.');
    // открытие с пустой строкой — строка остаётся пустой (код — на бланке своим узлом)
    const b4 = band('');
    WS.applyDxBand(b4, main, { keep: true });
    assert.equal(b4.textContent, '');
});

test('кабинет: проводка правил бланка диагностики', () => {
    const code = WS_SRC.replace(/\/\/[^\n]*/g, '');
    // тип бланка по услуге: группа, вид, отделение — одним правилом
    assert.match(code, /services\(type, service_types\(name\), departments\(kind\)\)/, 'при открытии не читается группа услуги');
    assert.match(code, /opensAsDiagnostics\(\{ deptKind: ctx\.deptKind, svcType: ctx\.svcType, typeName: ctx\.typeName \}\)/);
    // хранилище «Описания» под бланком — вне свёрнутых разделов
    assert.match(code, /'data-diag-fields': ''[\s\S]{0,200}'data-field': 'instrumental_text'/, 'у «Описания» нет поля под бланком');
    // открытие сохранённого документа не стирает строку «Диагноз»
    // CABINET_FIX_V1_R3 (F7) · CABINET_FIX_V1_R4 (п. 12) — открытие (keepBand) чистит только записи до
    // ревью 2 (без dxSplit): поведением — cabinet-review-r4.test.mjs, «12 (F7)»; здесь — что открытие
    // вообще идёт через paintDiagnoses с keepBand.
    assert.match(code, /paintDiagnoses\(ctx, \{ keepBand: [^}]+\}\)/, 'hydrate снова стирает «Заключение» диагностики');
    // экран, печать и архив берут данные бланка исследования из одного места
    // CABINET_FIX_V1_R1 — печать и архив берут ОДИН снимок (docSnapshot), а он у
    // диагностики — diagDocData; экран — тоже diagDocData.
    assert.match(code, /function docSnapshot\(ctx, type = wsState\.docType\) \{[\s\S]{0,120}if \(type === 'diag'\) return diagDocData\(/);
    assert.match(code, /data = diagDocData\(buildBlankData\(ctx\), \{ editor: true/, 'экран бланка — не diagDocData');
});
