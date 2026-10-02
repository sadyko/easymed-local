// CABINET_FIX_V1_R1 (2026-10-02) — РЕВЬЮ 1: ТЕКСТ ВРАЧА НЕ ТЕРЯЕТСЯ НИ ПРИ КАКОМ
// ПЕРЕКЛЮЧЕНИИ, ПЕЧАТЬ = АРХИВ, ОДНА СТРОКА — ОДНИ ЗАПИСИ.
//
// Проверяется на НАСТОЯЩЕЙ форме кабинета (soapForm) в маленьком DOM-стенде
// (cabinet-harness.mjs) и на чистых функциях кабинета; сервер — своими тестами
// (visit-document-archive, consultation-templates, rx, мигр. 236).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFakeDom, El, CONFIRMS, TOASTS, answerConfirm } from './cabinet-harness.mjs';

installFakeDom();

// ─── фальшивый сервер: /api/db (только чтение notes и запись notes) ─────────
const NOTES = new Map();          // visit_service_id -> notes (строка)
const WRITES = [];                // [{ id, notes }]
const HOLD = new Map();           // id -> Promise, пока ответ «в пути»
globalThis.fetch = async (url, opts) => {
    const body = JSON.parse((opts && opts.body) || '{}');
    const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }), headers: { getSetCookie: () => [] } });
    if (String(url) === '/api/db' && body.table === 'visit_services') {
        const idF = (body.filters || []).find((f) => f.col === 'id');
        const id = idF && Number(idF.val);
        if (body.op === 'select') {
            if (HOLD.has(id)) await HOLD.get(id);
            return ok(NOTES.has(id) ? { notes: NOTES.get(id) } : null);
        }
        if (body.op === 'update') { WRITES.push({ id, notes: body.values.notes }); NOTES.set(id, body.values.notes); return ok(null); }
    }
    return ok(null);
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WS_SRC = fs.readFileSync(path.join(HERE, '..', 'views', 'service-workspace.js'), 'utf8');
const code = (s) => s.replace(/\/\/[^\n]*/g, '');
const WS = await import('../views/service-workspace.js');
const { renderDesignedVariant } = await import('../views/doc-variants.js');
const S = { accent: '#167873', ink: '#16213f', clinicName: 'Клиника' };
const text = (html) => html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

// НАСТОЯЩАЯ форма кабинета: тот же soapForm, что рисует приём.
function realCabinet(type = 'conclusion', patient = {}) {
    const container = new El('div');
    const ctx = { container, patient: { lastName: 'Азизов', firstName: 'Бахтиёр', mrn: 'P-1', __service: { id: 1, name: 'УЗИ почек и м/п', doctorName: 'Каримов Алишер', doctorSpec: 'Врач УЗИ-диагностики' }, ...patient }, visitServiceId: 1 };
    WS.activateWorkspace(ctx);
    container.appendChild(WS.soapForm(ctx));
    WS.setDocType(ctx, type);
    ctx.__hydrated = true;   // CABINET_FIX_V1_R4 — открытая строка: записи легли в лист (вставки и записи незагруженного листа отказывают)
    return ctx;
}
const field = (ctx, k) => ctx.container.querySelector('[data-field="' + k + '"]');
const secOff = (ctx, sec) => ctx.container.querySelector('[data-sec="' + sec + '"]').classList.contains('a4-sec-off');

test('пробел тестов: «Описание» под НАСТОЯЩЕЙ формой — вне сворачиваемых разделов и собирается у диагностики', () => {
    const ctx = realCabinet('diag');
    const holder = field(ctx, 'instrumental_text');
    assert.ok(holder, 'у формы нет поля «Описание»');
    assert.equal(holder.closest('.a4-sec'), null, '«Описание» лежит в сворачиваемом разделе — свёрнутый раздел его не сохранит');
    holder.innerHTML = 'Почки обычных размеров';
    field(ctx, 'primary_diagnosis').innerHTML = 'Патологии нет';
    assert.ok(secOff(ctx, 'diagnosis'), 'раздел «Диагноз» по умолчанию свёрнут — проверка «из свёрнутого» ничего не проверяет');
    const got = WS.collectFields(ctx);
    assert.equal(got.instrumental_text, 'Почки обычных размеров');
    assert.equal(got.primary_diagnosis, 'Патологии нет');
});

test('п. 1: диагностика → «Приём» (вручную и шаблоном): «Заключение» и «Описание» сохраняются и видны; спрашивать нечего', () => {
    for (const how of ['select', 'template']) {
        const ctx = realCabinet('diag');
        field(ctx, 'instrumental_text').innerHTML = 'Почки обычных размеров';
        field(ctx, 'primary_diagnosis').innerHTML = 'Патологии нет';
        CONFIRMS.length = 0;
        if (how === 'select') assert.equal(WS.switchDocType(ctx, 'conclusion'), true);
        else WS.tplApply(ctx, { doc_type: '0', body: { chief_complaint: 'Жалоб нет' } });
        assert.equal(ctx.container.querySelector('[data-doctype]').value, 'conclusion', how);
        assert.deepEqual(CONFIRMS, [], how + ': на «Приёме» видны и «Описание», и «Заключение» — вопрос лишний');
        const got = WS.collectFields(ctx);
        assert.equal(got.primary_diagnosis, 'Патологии нет', how + ': «Заключение» пропало при переходе на «Приём»');
        assert.equal(got.instrumental_text, 'Почки обычных размеров', how);
        assert.ok(!secOff(ctx, 'diagnosis'), how + ': раздел «Диагноз» с текстом остался свёрнутым');
        // «Приём» показывает «Описание» разделом «Инструментальные исследования» — на экране, в печати, в архиве
        const snap = WS.docSnapshot(ctx);
        assert.ok(snap.sectionOrder.includes('instrumental_text') && snap.activeFields.includes('instrumental_text'));
        const html = renderDesignedVariant('conclusion', 'classic', S, snap);
        assert.match(text(html), /Почки обычных размеров/, how + ': «Описание» не попало на бумагу «Приёма»');
        assert.match(text(html), /Патологии нет/);
    }
});

test('п. 1: «Приём» → диагностика: вопрос, если текст приёма станет не виден; «Нет» — тип не меняется; «Да» — текст остаётся в записи', () => {
    const ctx = realCabinet('conclusion');
    WS.applyFields(ctx, { chief_complaint: 'Боль в пояснице', therapy_text: 'Покой' });
    CONFIRMS.length = 0;
    answerConfirm(false);
    assert.equal(WS.switchDocType(ctx, 'diag'), false);
    assert.equal(ctx.container.querySelector('[data-doctype]').value, 'conclusion', '«Нет» всё равно переключил тип');
    assert.equal(CONFIRMS.length, 1);
    assert.match(CONFIRMS[0], /В документе есть текст, который в бланке «Диагностика» не виден/);
    assert.match(CONFIRMS[0], /Жалобы/);
    assert.match(CONFIRMS[0], /Терапия/);
    // шаблон диагностики — тот же вопрос, «Нет» — ничего не вставлено
    CONFIRMS.length = 0;
    assert.equal(WS.tplApply(ctx, { doc_type: '1', body: { instrumental_text: 'Описание' } }), null);
    assert.equal(CONFIRMS.length, 1);
    assert.notEqual(WS.collectFields(ctx).instrumental_text, 'Описание', '«Нет» — а шаблон вставлен');
    answerConfirm(true);
    assert.equal(WS.switchDocType(ctx, 'diag'), true);
    const got = WS.collectFields(ctx);
    assert.equal(got.chief_complaint, 'Боль в пояснице', 'текст приёма удалён при переключении');
    assert.equal(got.therapy_text, 'Покой');
    // без текста приёма — не спрашиваем
    const empty = realCabinet('conclusion');
    CONFIRMS.length = 0;
    assert.equal(WS.switchDocType(empty, 'diag'), true);
    assert.deepEqual(CONFIRMS, []);
});

test('п. 1: подпись диагностики с невидимым текстом приёма — отказ с понятной причиной; печать — спрашивает', () => {
    const f = { chief_complaint: 'Боль в пояснице', physical_exam: '', therapy_text: 'Покой', instrumental_text: 'Почки' };
    assert.deepEqual(WS.hiddenTextFor(f, 'diag'), ['Жалобы', 'Терапия']);
    assert.deepEqual(WS.hiddenTextFor(f, 'conclusion'), [], '«Приём» показывает всё, что в нём написано');
    const msg = WS.signRefusal(f, 'diag');
    assert.match(msg, /Жалобы, Терапия/);
    assert.match(msg, /«Приём»/, 'причина не говорит, что делать');
    assert.equal(WS.signRefusal(f, 'conclusion'), null);
    const c = code(WS_SRC);
    const sign = c.slice(c.indexOf('async function handleSignFinalize('), c.indexOf('async function syncVisitStatus('));
    // CABINET_FIX_V1_R2 — тип берётся вместе с полями, до первого ожидания (docType)
    assert.match(sign, /const _refusal = signRefusal\(fields, docType\);\s*if \(_refusal\) \{ toast\(_refusal, 'fail'\); return; \}/, 'подпись не проверяет невидимый текст');
    const print = c.slice(c.indexOf('async function handlePrint('), c.indexOf('async function openRecipeModal('));
    assert.match(print, /hiddenTextFor\(/, 'печать не предупреждает о невидимом тексте');
});

test('п. 2: старый документ «Приёма» у УЗИ открывается «Приёмом», а не пустым бланком диагностики', () => {
    assert.equal(WS.savedDocType({ docType: 'diag', current: { chief_complaint: 'x' } }), 'diag', 'сохранённый тип — сильнее всего');
    assert.equal(WS.savedDocType({ current: { chief_complaint: 'Боль' } }), 'conclusion');
    assert.equal(WS.savedDocType({ current: { free_1: 'Глазное дно' } }), 'conclusion');
    assert.equal(WS.savedDocType({ current: { conclusion_text: 'Здоров' } }), 'conclusion');
    assert.equal(WS.savedDocType({ current: { instrumental_text: 'Почки', primary_diagnosis: 'Норма' } }), null, 'документ диагностики — выбор по услуге');
    assert.equal(WS.savedDocType({ current: { chief_complaint: '   ' } }), null);
    assert.equal(WS.savedDocType({ current: null }), null);
    assert.match(code(WS_SRC), /const _saved = savedDocType\(payload\);\s*if \(_saved\) \{ ctx\.docTypeSaved = true;/, 'открытие не восстанавливает тип старого документа');
});

test('п. 2: новая подпись беднее прежней — спросить, назвав пропадающие разделы', () => {
    const prev = { chief_complaint: 'Боль', physical_exam: 'Норма', therapy_text: '' };
    assert.deepEqual(WS.lostOnResign(prev, { chief_complaint: 'Боль', physical_exam: '' }), ['Осмотр']);
    assert.deepEqual(WS.lostOnResign(prev, { chief_complaint: 'Боль, слабость', physical_exam: 'Норма' }), []);
    assert.deepEqual(WS.lostOnResign(null, {}), []);
    const c = code(WS_SRC);
    assert.match(c, /const _lost = _last \? lostOnResign\(_last\.fields, fields, \{ diagnoses: payload\.diagnoses \}\) : \[\];/);   // CABINET_FIX_V1_R3 (F9) · CABINET_FIX_V1_R4 (п. 1) — диагнозы строки
});

test('п. 3: правка старого шаблона не стирает его ключи; «Использовать» кладёт «Диагноз» и старые разделы', () => {
    const old = { id: 9, name: 'ОРВИ', doc_type: '0', scope: 'private', body: { chief_complaint: 'Кашель', primary_diagnosis: 'J06.9 — ОРВИ', labs_text: 'ОАК без особенностей' } };
    const d = WS.tplDraftFrom(old);
    d.name = 'ОРВИ — взрослые';
    d.body.chief_complaint = 'Кашель, насморк';
    assert.deepEqual(WS.tplSaveBody(d), { chief_complaint: 'Кашель, насморк', primary_diagnosis: 'J06.9 — ОРВИ', labs_text: 'ОАК без особенностей' },
        'переименование / правка старого шаблона удалила его разделы');
    const ctx = realCabinet('conclusion');
    WS.tplApply(ctx, old);
    const got = WS.collectFields(ctx);
    assert.equal(got.primary_diagnosis, 'J06.9 — ОРВИ', '«Диагноз» старого шаблона не вставлен');
    assert.equal(got.labs_text, 'ОАК без особенностей', '«Лабораторные» старого шаблона не вставлены');
    const html = renderDesignedVariant('conclusion', 'classic', S, WS.docSnapshot(ctx));
    assert.match(text(html), /ОАК без особенностей/, '«Лабораторные» не видны на «Приёме»');
});

test('п. 4 и 12: «Заключение» и «Осмотр» приёма — на бланке, в печати и в архиве; печать = архив', () => {
    const ctx = realCabinet('conclusion');
    WS.applyFields(ctx, { physical_exam: 'Состояние удовлетворительное', conclusion_text: 'Практически здоров' });
    const snap = WS.docSnapshot(ctx);
    for (const v of ['classic', 'compact']) {
        for (const editor of [false, true]) {
            const html = text(renderDesignedVariant('conclusion', v, S, { ...snap, __editor: editor }));
            assert.match(html, /Состояние удовлетворительное/, v + ': «Осмотр» не напечатан');
            assert.match(html, /Практически здоров/, v + ': «Заключение» приёма не напечатано');
        }
        // старый архивный снимок без sectionOrder — тоже
        const legacy = text(renderDesignedVariant('conclusion', v, S, { patientName: 'Азизов', exam: 'Осмотр без особенностей', conclusionText: 'Здоров' }));
        assert.match(legacy, /Осмотр без особенностей/, v + ': без порядка разделов «Осмотр» выпадает');
        assert.match(legacy, /Здоров/);
    }
    const c = code(WS_SRC);
    const print = c.slice(c.indexOf('async function handlePrint('), c.indexOf('async function openRecipeModal('));
    assert.match(print, /docSnapshot\(ctx, _dt\)/, 'печать собирает свои данные, а не снимок архива');
    const sign = c.slice(c.indexOf('async function handleSignFinalize('), c.indexOf('async function syncVisitStatus('));
    // CABINET_FIX_V1_R2 — архив — тот же снимок (buildBlankData → diagDocData / __editor:false),
    // собранный до первого ожидания; поведенчески — cabinet-review-r2 п. 3
    assert.match(sign, /const _docData = docType === 'diag' \? diagDocData\(_base, \{ editor: false, images: diagImages \}\) : Object\.assign\(_base, \{ __editor: false \}\);/, 'архив собирает свои данные');
    const snap2 = c.slice(c.indexOf('export function docSnapshot('), c.indexOf('function buildBlankData('));
    assert.match(snap2, /diagDocData\(base, \{ editor: false, images: wsState\.diagImages \|\| \[\] \}\)/);
    assert.match(snap2, /base\.__editor = false;/);
});

test('п. 5: у диагностики МКБ-10 не затирает набранное «Заключение» и не стирает его при снятии кода', () => {
    // CABINET_FIX_V1_R2 (ревью 2, п. 2) — при ЛЮБОМ типе код в строку врача не
    // пишется: выбор, смена и снятие кода её не трогают (код — отдельный узел бланка).
    const band = (html) => { const e = new El('div'); e.innerHTML = html; return e; };
    const main = { code: 'N28.9', name: 'Болезнь почки' };
    const b = band('Эхопризнаков патологии нет');
    WS.applyDxBand(b, main);
    assert.equal(b.innerHTML, 'Эхопризнаков патологии нет', 'код затёр «Заключение»');
    WS.applyDxBand(b, { code: 'N20.0', name: 'Камни почки' });
    assert.equal(b.innerHTML, 'Эхопризнаков патологии нет', 'смена кода тронула «Заключение»');
    WS.applyDxBand(b, null);
    assert.equal(b.innerHTML, 'Эхопризнаков патологии нет', 'снятие кода стёрло «Заключение»');
    const e = band('');
    WS.applyDxBand(e, main);
    assert.equal(e.innerHTML, '', 'код вписан в строку врача');
    assert.match(code(WS_SRC), /applyDxBand\(band, main, \{ keep: !!opts\.keepBand \}\)/);
});

test('п. 6 и 7: вид архива — по сохранённому типу; подпись — один и тот же человек', () => {
    const c = code(WS_SRC);
    assert.ok(!/ctx\.deptKind === 'diagnostics'\) \|\| \(wsState\.docType === 'diag'\)/.test(c), 'вид архива снова зависит от отделения');
    assert.match(c, /const _isDiag\s+= docType === 'diag';/);   // CABINET_FIX_V1_R2 — тип, взятый до первого ожидания
    assert.deepEqual(WS.docSigner({ doctorName: 'Каримов Алишер', doctorSpec: '' }, { full_name: 'Администратор', specialty: 'Терапевт' }),
        { doctorName: 'Каримов Алишер', doctorSpec: '' }, 'имя одного врача, специальность другого');
    assert.deepEqual(WS.docSigner({}, { full_name: 'Юсупова Нигора', specialty: 'Терапевт' }), { doctorName: 'Юсупова Нигора', doctorSpec: 'Терапевт' });
    assert.deepEqual(WS.docSigner({ doctorName: 'Каримов Алишер', doctorSpec: 'Врач УЗИ' }, { full_name: 'X', specialty: 'Y' }), { doctorName: 'Каримов Алишер', doctorSpec: 'Врач УЗИ' });
});

test('п. 9 и 10: шаблон рецепта удаляется и переименовывается; подсказки — один раз за сеанс, после сохранения — заново', () => {
    const c = code(WS_SRC);
    const dlg = c.slice(c.indexOf('function openPrescriptionDialog('), c.indexOf('async function removePrescription('));
    assert.match(dlg, /canManage\(t\)/, 'в списке шаблонов рецептов нет прав автора / администратора');
    assert.match(dlg, /from\('consultation_templates'\)\.delete\(\)\.eq\('id', t\.id\)/, 'шаблон рецепта не удалить');
    assert.match(dlg, /from\('consultation_templates'\)\.update\(\{ name: [^}]*\}\)\.eq\('id', t\.id\)/, 'шаблон рецепта не переименовать');
    assert.match(c, /let rxSourcesCache = null;/, 'подсказки не держатся на сеанс');
    assert.match(c, /if \(rxSourcesCache && !force\) return rxSourcesCache;/);
    assert.ok((dlg.match(/loadRxSources\(\{ force: true \}\)/g) || []).length >= 2, 'после сохранения рецепта или шаблона подсказки не перечитываются');
});

test('п. 13: ответ прежней строки, пришедший поздно, не попадает в открытую; чужие записи в строку не пишутся', async () => {
    NOTES.set(1, JSON.stringify({ __service_workspace_v1: 1, current: { chief_complaint: 'Строка A' }, history: [] }));
    NOTES.set(2, JSON.stringify({ __service_workspace_v1: 1, current: { chief_complaint: 'Строка B' }, history: [] }));
    let release;
    HOLD.set(1, new Promise((r) => { release = r; }));
    const ctxA = { container: new El('div'), visitServiceId: 1, patient: {} };
    const ctxB = { container: new El('div'), visitServiceId: 2, patient: {}, __hydrated: true };   // CABINET_FIX_V1_R4 — лист B загружен
    WS.activateWorkspace(ctxA);
    const pA = WS.loadLinePayload(ctxA);          // ответ строки A «в пути»
    WS.activateWorkspace(ctxB);                   // врач открыл строку B
    const b = await WS.loadLinePayload(ctxB);
    assert.equal(b.current.chief_complaint, 'Строка B');
    release(); HOLD.delete(1);
    assert.equal(await pA, null, 'поздний ответ строки A принят после открытия строки B');
    const cur = await WS.currentPayload(ctxB);
    assert.equal(cur.current.chief_complaint, 'Строка B', 'открытая строка B получила записи строки A');
    // запись записей строки A в строку B — отказ
    const payloadA = JSON.parse(NOTES.get(1));
    WRITES.length = 0;
    const foreign = await WS.loadLinePayload(ctxA, { force: true });   // загружено ДЛЯ A (без захвата экрана)
    assert.equal(await WS.writePayload(ctxB, foreign), false, 'записи строки A записаны в строку B');
    assert.deepEqual(WRITES, []);
    assert.equal(await WS.writePayload(ctxB, cur), true);
    assert.equal(WRITES.length, 1);
    assert.equal(WRITES[0].id, 2);
    assert.ok(payloadA);
});

test('подписи ревью 1 — на трёх языках', async () => {
    const { STRINGS } = await import('../i18n-strings.js');
    for (const key of [
        'В документе есть текст, который в бланке «{type}» не виден: {list}. Переключить всё равно? Текст останется в записи.',
        'В документе есть текст, которого нет в бланке «{type}»: {list}. Переключите тип документа на «{other}» или удалите этот текст — подписанный документ должен содержать всё, что написано.',
        'На бумагу не попадёт текст, которого нет в бланке «{type}»: {list}. Печатать всё равно?',
        'В новой версии пусты разделы, которые были в подписанной: {list}. Подписать всё равно? Прежняя версия останется в истории.',
        'Записи открыты для другой строки — сохранение отменено. Откройте приём заново.',
        'Шаблон не изменён: менять и удалять его может только автор или администратор (или шаблон уже удалён).',
        'Переименовать', 'Удалить шаблон «{name}»?', 'Шаблон удалён', 'Лабораторные исследования', 'Инструментальные исследования',
    ]) {
        const e = STRINGS[key];
        assert.ok(e, 'строки нет в словаре: ' + key);
        for (const lang of ['ru', 'uz', 'en']) assert.ok(e[lang], key + ': нет перевода ' + lang);
    }
    assert.ok(TOASTS);
});
