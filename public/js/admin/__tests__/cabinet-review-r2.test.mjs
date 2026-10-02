// CABINET_FIX_V1_R2 (2026-10-02) — РЕВЬЮ 2: ШАБЛОН НЕ ЗАТИРАЕТ НАПИСАННОЕ, КОД
// МКБ-10 ЖИВЁТ ОТДЕЛЬНО ОТ ТЕКСТА ВРАЧА, ПОДПИСЬ И ПОЗДНИЕ ОТВЕТЫ НЕ СМЕШИВАЮТ
// ПАЦИЕНТОВ.
//
// Настоящая форма кабинета (soapForm / renderServiceWorkspace) в DOM-стенде
// (cabinet-harness.mjs) и фальшивый сервер, у которого ответ можно задержать.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFakeDom, El, CONFIRMS, answerConfirm } from './cabinet-harness.mjs';

installFakeDom();

// ─── фальшивый сервер ─────────────────────────────────────────────────────────
const NOTES = new Map();          // visit_service_id -> notes
const KIND = new Map();           // visit_service_id -> { type, typeName }
const HOLD = new Map();           // ключ -> Promise (ответ «в пути»)
const LOG = [];                   // записи: { kind, ... }
const REC = new Map();            // patient_id -> рекомендации
const EMR = new Map();            // patient_id -> строки истории
const hold = (key) => { let release; HOLD.set(key, new Promise((r) => { release = r; })); return () => { HOLD.delete(key); release(); }; };
globalThis.fetch = async (url, opts) => {
    const u = String(url);
    const body = JSON.parse((opts && opts.body) || '{}');
    const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }), headers: { getSetCookie: () => [] } });
    if (u.startsWith('/api/rpc/')) {
        const name = u.slice('/api/rpc/'.length);
        if (name === 'visit_document_archive') LOG.push({ kind: 'archive', body });
        return ok({ id: 1 });
    }
    if (u === '/api/db') {
        const idF = (body.filters || []).find((f) => f.col === 'id');
        const id = idF && Number(idF.val);
        const pidF = (body.filters || []).find((f) => f.col === 'patient_id' || f.col === 'visits.patient_id');
        const pid = pidF && Number(pidF.val);
        if (body.table === 'recommended_services' && body.op === 'select') {
            if (HOLD.has('rec:' + pid)) await HOLD.get('rec:' + pid);
            return ok(REC.get(pid) || []);
        }
        if (body.table === 'visit_services' && body.op === 'select' && /visits!inner/.test(String(body.columns))) {
            if (HOLD.has('emr:' + pid)) await HOLD.get('emr:' + pid);
            return ok(EMR.get(pid) || []);
        }
        if (body.table === 'visit_services' && body.op === 'select') {
            if (/^services\(type/.test(String(body.columns))) {
                if (HOLD.has('kind:' + id)) await HOLD.get('kind:' + id);
                const k = KIND.get(id) || { type: 'consultation', typeName: 'Консультации' };
                return ok({ services: { type: k.type, service_types: { name: k.typeName }, departments: null } });
            }
            if (/notes/.test(String(body.columns))) return ok(NOTES.has(id) ? { notes: NOTES.get(id) } : null);
            return ok([]);
        }
        if (body.table === 'visit_services' && body.op === 'update') {
            if (HOLD.has('write:' + id)) await HOLD.get('write:' + id);
            LOG.push({ kind: 'line', id, values: body.values });
            if (body.values && body.values.notes != null) NOTES.set(id, body.values.notes);
            return ok(null);
        }
        if (body.table === 'visits' && body.op === 'update') { LOG.push({ kind: 'visit', id, values: body.values }); return ok(null); }
        return ok(body.op === 'select' && !body.single ? [] : null);
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
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

const notesOf = (current, extra = {}) => JSON.stringify({ __service_workspace_v1: 1, current, history: [], ...extra });
function cabinet(id, type = 'conclusion', patient = {}, payload = { __service_workspace_v1: 1, current: null, history: [] }) {
    const container = new El('div');
    const ctx = { container, visitServiceId: id, visitId: 100 + id, patient: { id, lastName: 'Пациент' + id, firstName: 'Тест', mrn: 'P-' + id, __service: { id, name: 'Услуга ' + id, doctorName: 'Каримов Алишер', doctorSpec: 'Врач УЗИ-диагностики' }, ...patient } };
    WS.activateWorkspace(ctx);
    container.appendChild(WS.soapForm(ctx));
    WS.setDocType(ctx, type);
    NOTES.set(id, JSON.stringify(payload));
    return ctx;
}
async function loaded(ctx) { await WS.loadLinePayload(ctx); return ctx; }
const field = (ctx, k) => ctx.container.querySelector('[data-field="' + k + '"]');
const put = (ctx, k, v) => { field(ctx, k).innerHTML = v; };

// ─── п. 1: шаблон ДОПИСЫВАЕТ к написанному, а не затирает ─────────────────────
const T0 = { doc_type: '0', body: { chief_complaint: 'TPL-ЖАЛОБЫ', therapy_text: 'TPL-ТЕРАПИЯ', instrumental_text: 'TPL-INSTR', primary_diagnosis: 'J06.9 — ОРВИ', labs_text: 'TPL-LABS' } };
const T1 = { doc_type: '1', body: { instrumental_text: 'TPL-INSTR', primary_diagnosis: 'TPL-ЗАКЛ' } };
for (const start of ['diag', 'conclusion']) {
    for (const tpl of [T0, T1]) {
        for (const typed of [false, true]) {
            test(`п. 1: шаблон рода ${tpl.doc_type} на «${start}», ${typed ? 'поля уже написаны' : 'поля пусты'} — ${typed ? 'дописывается после пустой строки' : 'вставляется'}`, () => {
                const ctx = cabinet(1, start);
                const mine = { chief_complaint: 'МОИ-ЖАЛОБЫ', therapy_text: 'МОЯ-ТЕРАПИЯ', instrumental_text: 'МОЁ-ОПИСАНИЕ', primary_diagnosis: 'МОЁ-ЗАКЛ', labs_text: 'МОИ-ЛАБЫ' };
                if (typed) {
                    WS.applyFields(ctx, start === 'conclusion' ? { chief_complaint: mine.chief_complaint, therapy_text: mine.therapy_text } : {});
                    for (const k of ['instrumental_text', 'primary_diagnosis', 'labs_text']) put(ctx, k, mine[k]);
                }
                answerConfirm(true);
                WS.tplApply(ctx, tpl);
                const got = WS.collectFields(ctx);
                for (const [k, v] of Object.entries(tpl.body)) {
                    const had = typed && (start === 'conclusion' || !['chief_complaint', 'therapy_text'].includes(k));
                    const want = had ? mine[k] + '<br><br>' + v : v;
                    assert.equal(got[k], want, `${k}: ${had ? 'написанное затёрто или потеряно' : 'шаблон не вставлен'}`);
                }
            });
        }
    }
}

// ─── п. 2 и 8: код МКБ-10 — своей строкой, текст врача не трогается никогда ─────
const MSUD = { code: 'E71.0', name: 'Болезнь "кленового сиропа"', type: 'main' };
test('п. 2a/2b: код выбирается, меняется и снимается — набранный текст «Диагноза»/«Заключения» не меняется ни на байт, при любом типе', async () => {
    for (const type of ['diag', 'conclusion']) {
        const ctx = await loaded(cabinet(1, type, {}, { __service_workspace_v1: 1, current: null, history: [], diagnoses: [] }));
        put(ctx, 'primary_diagnosis', 'Эхопризнаков патологии нет');
        // переход на другой тип и выбор кода
        WS.switchDocType(ctx, type === 'diag' ? 'conclusion' : 'diag');
        const pl = await WS.currentPayload(ctx);
        pl.diagnoses = [MSUD];
        WS.syncDiagnosisToDoc(ctx);
        assert.equal(field(ctx, 'primary_diagnosis').innerHTML, 'Эхопризнаков патологии нет', type + ': выбор кода изменил текст врача');
        pl.diagnoses = [MSUD, { code: 'K29.7', name: 'Гастрит', type: 'concomitant' }];
        WS.syncDiagnosisToDoc(ctx);
        assert.equal(field(ctx, 'primary_diagnosis').innerHTML, 'Эхопризнаков патологии нет', type + ': сопутствующий диагноз стёр текст');
        // на бумаге: код своей строкой, затем текст врача
        const snap = WS.docSnapshot(ctx, 'conclusion');
        assert.equal(snap.dx, 'E71.0 — Болезнь "кленового сиропа"\nЭхопризнаков патологии нет');
        pl.diagnoses = [];
        WS.syncDiagnosisToDoc(ctx);
        assert.equal(field(ctx, 'primary_diagnosis').innerHTML, 'Эхопризнаков патологии нет', type + ': снятие кода стёрло текст');
        assert.equal(WS.docSnapshot(ctx, 'conclusion').dx, 'Эхопризнаков патологии нет');
    }
});

test('п. 2/8: на бланке код — отдельный узел, не часть поля; «"» и строки Chrome его не ломают', () => {
    for (const v of ['classic', 'compact']) {
        const d = { __editor: true, patientName: 'Пациент', dxAuto: 'E71.0 — Болезнь "кленового сиропа"', dxText: 'Текст врача', dx: 'E71.0 — Болезнь "кленового сиропа"\nТекст врача', activeFields: ['primary_diagnosis'], sectionOrder: ['primary_diagnosis'] };
        const html = renderDesignedVariant('conclusion', v, S, d);
        const m = html.match(/data-field="primary_diagnosis"[^>]*>([^<]*)</);
        assert.ok(m, v + ': нет поля «Диагноз»');
        assert.equal(m[1], 'Текст врача', v + ': код попал в редактируемое поле');
        assert.match(html, /data-dx-auto[^>]*>E71\.0 — Болезнь &quot;кленового сиропа&quot;</, v + ': кода нет на бланке отдельным узлом');
        const dg = renderDesignedVariant('diag', v, S, { __editor: true, patientName: 'Пациент', conclusionAuto: 'E71.0 — X', conclusionText: 'Заключение врача', conclusion: 'E71.0 — X\nЗаключение врача' });
        const m2 = dg.match(/data-field="primary_diagnosis"[^>]*>([^<]*)</);
        assert.equal(m2[1], 'Заключение врача', v + ': код в поле «Заключения»');
        assert.match(dg, /data-dx-auto[^>]*>E71\.0 — X</);
        // на бумаге (не редактор) — всё одним текстом
        assert.match(text(renderDesignedVariant('diag', v, S, { patientName: 'Пациент', conclusion: 'E71.0 — X\nЗаключение врача' })), /E71\.0 — X Заключение врача/);
    }
});

test('п. 2/8: старые строки «Диагноза» с кодом внутри (до ревью 2) при открытии очищаются от кода — и с «"», и с <div> Chrome', async () => {
    const cases = [
        ['E71.0 — Болезнь &quot;кленового сиропа&quot;<br>Текст врача', 'Текст врача'],
        ['E71.0 — Болезнь "кленового сиропа"<br>Текст врача', 'Текст врача'],
        ['<div>E71.0 — Болезнь "кленового сиропа"</div><div>Текст врача</div>', '<div>Текст врача</div>'],
        ['E71.0 — Болезнь &quot;кленового сиропа&quot;', ''],
        ['Текст врача без кода', 'Текст врача без кода'],
    ];
    for (const [before, after] of cases) {
        const ctx = await loaded(cabinet(1, 'conclusion', {}, { __service_workspace_v1: 1, current: { primary_diagnosis: before }, history: [], diagnoses: [MSUD] }));
        put(ctx, 'primary_diagnosis', before);   // как пришло из записи (без DOMParser санитайзер стенда экранирует разметку)
        WS.syncDiagnosisToDoc(ctx, { keepBand: true });
        assert.equal(field(ctx, 'primary_diagnosis').innerHTML, after, JSON.stringify(before));
    }
});

test('п. 2: «Диагноз» целиком (печать, вставка результатов, история) — код строкой + текст врача, без повтора кода из старых записей', () => {
    assert.deepEqual(WS.dxParts('Текст врача', [MSUD]), { auto: 'E71.0 — Болезнь "кленового сиропа"', text: 'Текст врача', full: 'E71.0 — Болезнь "кленового сиропа"\nТекст врача' });
    assert.equal(WS.dxParts('E71.0 — Болезнь &quot;кленового сиропа&quot;<br>Текст врача', [MSUD]).full, 'E71.0 — Болезнь "кленового сиропа"\nТекст врача', 'код старой записи напечатан дважды');
    assert.equal(WS.dxParts('Текст врача', []).full, 'Текст врача');
    assert.equal(WS.dxParts('', [{ code: 'K29.7', name: 'Гастрит', type: 'concomitant' }]).full, '', 'сопутствующий выдан за основной');
    const c = code(WS_SRC);
    const fill = c.slice(c.indexOf('async function fillServiceConclusion('), c.indexOf('async function fillLabResults('));
    assert.match(fill, /dxParts\(f\.primary_diagnosis, payload && payload\.diagnoses\)\.full/, '«Вставить результаты» теряет код МКБ');
    assert.ok(!/f\.primary_diagnosis \|\| '—'/.test(fill) && !/esc\(f\.primary_diagnosis\)/.test(fill));
});

// ─── п. 3 и 6: подпись — снимок ЭТОЙ строки до первого ожидания; отказ — без записей ─
test('п. 3: подпись строки A, пока запись «в пути», врач открыл строку B — в архив и визит A уходит только A', async () => {
    LOG.length = 0;
    const a = await loaded(cabinet(1, 'conclusion', { lastName: 'Азизов' }, { __service_workspace_v1: 1, current: null, history: [], prescriptions: [{ name: 'A-DRUG' }], diagnoses: [{ code: 'A00', name: 'A-DX', type: 'main' }] }));
    WS.applyFields(a, { chief_complaint: 'A-COMPLAINT', conclusion_text: 'A-CONCL' });
    answerConfirm(true);
    const release = hold('write:1');
    const signing = WS.signDocument(a);
    await tick(5);
    const b = await loaded(cabinet(2, 'conclusion', { lastName: 'Каримова' }, { __service_workspace_v1: 1, current: null, history: [], prescriptions: [{ name: 'B-DRUG' }], diagnoses: [{ code: 'B00', name: 'B-DX', type: 'main' }] }));
    WS.applyFields(b, { chief_complaint: 'B-COMPLAINT', conclusion_text: 'B-CONCL' });
    release();
    await signing;
    const arch = LOG.find((e) => e.kind === 'archive');
    assert.ok(arch, 'архив не записан');
    assert.equal(arch.body.visit_service_id, 1);
    const d = arch.body.body;
    assert.match(d.patientName, /Азизов/, 'в архиве A — шапка другого пациента');
    assert.equal(d.complaint, 'A-COMPLAINT', 'в архив A ушли жалобы строки B');
    assert.deepEqual(d.prescriptions.map((r) => r.name), ['A-DRUG'], 'в архив A ушли рецепты строки B');
    assert.deepEqual(d.diagnoses.map((x) => x.code), ['A00']);
    const visit = LOG.find((e) => e.kind === 'visit');
    assert.equal(visit && visit.id, 101);
    assert.equal(visit.values.conclusion, 'A-CONCL', 'в визит A ушло заключение строки B');
    const notesA = JSON.parse(NOTES.get(1));
    assert.equal(notesA.current.chief_complaint, 'A-COMPLAINT');
    assert.equal(JSON.parse(NOTES.get(2)).current, null, 'записи строки B тронуты подписью A');
});

test('п. 6: подпись с отказом не пишет НИЧЕГО — ни статус и записи строки, ни архив, ни заключение визита', async () => {
    LOG.length = 0;
    const ctx = await loaded(cabinet(3, 'conclusion'));
    WS.applyFields(ctx, { chief_complaint: 'Текст приёма', conclusion_text: 'Заключение' });
    answerConfirm(true);
    WS.switchDocType(ctx, 'diag');   // текст приёма на диагностике не виден
    CONFIRMS.length = 0;
    await WS.signDocument(ctx);
    assert.deepEqual(LOG, [], 'отказанная подпись записала: ' + JSON.stringify(LOG.map((e) => e.kind)));
    assert.deepEqual(CONFIRMS, [], 'подпись спросила «подписать?» до отказа');
});

test('п. 3: печать, начатая в A, после ожидания в B не печатает (и черновик пишет поля, собранные до ожидания)', () => {
    const c = code(WS_SRC);
    const print = c.slice(c.indexOf('async function handlePrint('), c.indexOf('async function openRecipeModal('));
    assert.match(print, /await loadRecommendations\(ctx\);\s*if \(wsState\.ctx !== ctx\) \{ toast\(/, 'печать читает экран после ожидания без проверки строки');
    const draft = c.slice(c.indexOf('async function handleSaveDraft('), c.indexOf('async function handleSignFinalize('));
    const firstAwait = draft.indexOf('await ');
    assert.ok(draft.indexOf('collectFields(ctx)') < firstAwait && draft.indexOf('wsState.diagImages') < firstAwait && draft.indexOf('wsState.docType') < firstAwait,
        'черновик собирает поля / изображения / тип после ожидания');
});

// ─── п. 4: поздние ответы — только своей строке ─────────────────────────────────
test('п. 4: поздний ответ «вид услуги» строки A не переключает открытую строку B; A получает своё, когда к ней вернутся', async () => {
    KIND.set(11, { type: 'imaging', typeName: 'Диагностика' });
    KIND.set(12, { type: 'consultation', typeName: 'Консультации' });
    NOTES.set(11, notesOf(null)); NOTES.set(12, notesOf(null));
    const release = hold('kind:11');
    const ca = new El('div');
    WS.renderServiceWorkspace(ca, { onNavigate: () => {}, payload: { id: 11, lastName: 'Азизов', firstName: 'A', __service: { id: 11, visitId: 1, name: 'УЗИ' } } });
    await tick(5);
    const cb = new El('div');
    WS.renderServiceWorkspace(cb, { onNavigate: () => {}, payload: { id: 12, lastName: 'Каримова', firstName: 'B', __service: { id: 12, visitId: 2, name: 'Консультация' } } });
    await tick(20);
    release();
    await tick(20);
    assert.equal(cb.querySelector('[data-doctype]').value, 'conclusion', 'поздний ответ строки A переключил строку B на «Диагностику»');
    assert.notEqual(ca.querySelector('[data-doctype]').value, 'diag', 'строка A переключена, пока она не открыта');
    // врач вернулся к A — её тип восстанавливается и выбор по услуге доезжает
    ca.dispatch('pointerdown');
    await tick(5);
    assert.equal(ca.querySelector('[data-doctype]').value, 'diag', 'вернувшись к A, врач не получил её «Диагностику»');
    cb.dispatch('pointerdown');
    assert.equal(cb.querySelector('[data-doctype]').value, 'conclusion');
    const c = code(WS_SRC);
    const at = c.indexOf('resolveWsDoctorId(ctx)).then');
    assert.ok(at > -1);
    assert.match(c.slice(at, at + 1500), /wsState\.ctx !== ctx/, 'телефон врача: ответ не проверяет, чья строка открыта');
});

test('п. 4: поздние «рекомендации» и «история пациента» строки A уходят в её состояние — открытая строка B их не получает, A получает при возврате', async () => {
    REC.set(31, [{ id: 1, services: { name: 'A-REC' }, users: { full_name: 'Врач A' } }]);
    REC.set(32, [{ id: 2, services: { name: 'B-REC' }, users: { full_name: 'Врач B' } }]);
    EMR.set(31, [{ id: 91, status: 'completed', created_at: '2026-09-01', visit_id: 1, services: { name: 'A-EMR', type: 'consultation' }, visits: { visit_date: '2026-09-01' } }]);
    const relRec = hold('rec:31'), relEmr = hold('emr:31');
    const a = cabinet(31);
    const recA = WS.loadRecommendations(a), emrA = WS.loadPatientEmr(a.patient, a);
    await tick(5);
    const b = cabinet(32);
    await WS.loadRecommendations(b);
    relRec(); relEmr();
    await recA; await emrA;
    assert.deepEqual(WS.docSnapshot(b, 'conclusion').referrals.map((r) => r.name), ['B-REC'], 'рекомендации строки A попали в открытую строку B');
    assert.ok(JSON.stringify(a.__wsState.emr || null).includes('A-EMR'), 'история строки A потерялась');
    a.container.dispatch('pointerdown');   // врач вернулся к A
    assert.deepEqual(WS.docSnapshot(a, 'conclusion').referrals.map((r) => r.name), ['A-REC']);
    assert.ok(!JSON.stringify(b.__wsState.emr || null).includes('A-EMR'), 'история строки A попала в строку B');
});

// ─── п. 5: рецепт и сопутствующие диагнозы — в печати и архиве диагностики ──────
test('п. 5: снимок диагностики несёт рецепт и сопутствующие диагнозы; бланк их печатает', async () => {
    const ctx = await loaded(cabinet(4, 'diag', {}, { __service_workspace_v1: 1, current: null, history: [],
        prescriptions: [{ name: 'Канефрон', dose: '2 драже', freq: '3 раза в день', dur: '14 дней' }],
        diagnoses: [{ code: 'N28.9', name: 'Болезнь почки', type: 'main' }, { code: 'K29.7', name: 'Гастрит', type: 'concomitant' }] }));
    put(ctx, 'instrumental_text', 'Почки обычных размеров');
    const snap = WS.docSnapshot(ctx);
    assert.deepEqual(snap.prescriptions.map((r) => r.name), ['Канефрон']);
    assert.deepEqual(snap.diagnoses.map((x) => x.code), ['N28.9', 'K29.7']);
    for (const v of ['classic', 'compact']) {
        const t = text(renderDesignedVariant('diag', v, S, snap));
        assert.match(t, /Канефрон/, v + ': рецепт не напечатан');
        assert.match(t, /14 дней/);
        assert.match(t, /K29\.7/, v + ': сопутствующий диагноз не напечатан');
        assert.match(t, /Гастрит/);
    }
});

// ─── п. 9: «×» у раздела с текстом спрашивает ───────────────────────────────────
test('п. 9: «×» у раздела с текстом — вопрос; «Нет» — раздел открыт и текст цел; «Да» — текст стёрт и раздел убран', () => {
    const ctx = cabinet(5, 'conclusion');
    WS.applyFields(ctx, { primary_diagnosis: 'Острый пиелонефрит' });
    const sec = () => ctx.container.querySelector('[data-sec="diagnosis"]');
    CONFIRMS.length = 0;
    answerConfirm(false);
    WS.wsRemoveSection(ctx, 'diagnosis');
    assert.equal(CONFIRMS.length, 1);
    assert.match(CONFIRMS[0], /Удалить текст раздела «Диагноз»\?/);
    assert.ok(!sec().classList.contains('a4-sec-off'), '«Нет» — а раздел убран');
    assert.equal(WS.collectFields(ctx).primary_diagnosis, 'Острый пиелонефрит');
    answerConfirm(true);
    WS.wsRemoveSection(ctx, 'diagnosis');
    assert.ok(sec().classList.contains('a4-sec-off'));
    assert.ok(!('primary_diagnosis' in WS.collectFields(ctx)), 'убранный раздел с текстом всё равно печатается');
    // пустой раздел — без вопроса
    WS.applyFields(ctx, { therapy_text: ' ' });
    CONFIRMS.length = 0;
    WS.wsRemoveSection(ctx, 'therapy');
    assert.deepEqual(CONFIRMS, []);
    answerConfirm(true);
});

test('подписи ревью 2 — на трёх языках', async () => {
    const { STRINGS } = await import('../i18n-strings.js');
    for (const key of [
        'Удалить текст раздела «{name}»?',
        'Документ открыт в другой строке — вернитесь к нему и повторите.',
        'Документ ещё загружается — подождите секунду и повторите.',
        'Печать отменена: открыт документ другой строки.',
    ]) {   // «Сопутствующие диагнозы» бланка — в печатном документе (doc-variants, ru · uz), не в словаре
        const e = STRINGS[key];
        assert.ok(e, 'строки нет в словаре: ' + key);
        for (const lang of ['ru', 'uz', 'en']) assert.ok(e[lang], key + ': нет перевода ' + lang);
    }
});
