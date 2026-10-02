// CABINET_FIX_V1_R3 (2026-10-02) — РЕВЬЮ 3: ПОДПИСАННАЯ ВЕРСИЯ НЕ ТЕРЯЕТСЯ,
// НЕЗАГРУЖЕННАЯ СТРОКА НЕ СОХРАНЯЕТСЯ И НЕ ПРАВИТСЯ, ПОВТОРНЫЙ ЭКРАН НЕ
// ДОБАВЛЯЕТ СЛУШАТЕЛЕЙ, ДВОЙНОЙ ЩЕЛЧОК НЕ ПОДПИСЫВАЕТ ДВАЖДЫ.
//
// Настоящая форма кабинета в DOM-стенде (cabinet-harness.mjs) и фальшивый
// сервер, у которого любой ответ можно задержать.
import nodeTest from 'node:test';
// CABINET_FIX_V1_R5 (F) — тест, который повис бы, падает по сроку, а не держит весь файл
const test = (name, fn) => nodeTest(name, { timeout: 20000 }, fn);
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFakeDom, El, CONFIRMS, TOASTS, answerConfirm } from './cabinet-harness.mjs';

installFakeDom();

// ─── фальшивый сервер ─────────────────────────────────────────────────────────
const NOTES = new Map();          // visit_service_id -> notes
const HOLD = new Map();           // ключ -> Promise (ответ «в пути»)
const FAIL = new Set();           // ключи, на которые сервер отвечает ошибкой
const LOG = [];                   // записи и чтения: { kind, ... }
const hold = (key) => { let release; HOLD.set(key, new Promise((r) => { release = r; })); return () => { HOLD.delete(key); release(); }; };
globalThis.fetch = async (url, opts) => {
    const u = String(url);
    const body = JSON.parse((opts && opts.body) || '{}');
    const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }), headers: { getSetCookie: () => [] } });
    const bad = () => ({ ok: false, status: 500, json: async () => ({ error: { message: 'сбой сервера' } }), headers: { getSetCookie: () => [] } });
    if (u.startsWith('/api/rpc/')) {
        const name = u.slice('/api/rpc/'.length);
        if (name === 'visit_document_archive') LOG.push({ kind: 'archive', body });
        return ok({ id: 1 });
    }
    if (u === '/api/db') {
        const idF = (body.filters || []).find((f) => f.col === 'id');
        const id = idF && Number(idF.val);
        if (body.table === 'visit_services' && body.op === 'select') {
            if (/^services\(type/.test(String(body.columns))) return ok({ services: { type: 'consultation', service_types: { name: 'Консультации' }, departments: null } });
            if (/notes/.test(String(body.columns))) {
                LOG.push({ kind: 'read', id });
                if (HOLD.has('read:' + id)) await HOLD.get('read:' + id);
                if (FAIL.has('read:' + id)) return bad();
                return ok(NOTES.has(id) ? { notes: NOTES.get(id) } : null);
            }
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

const MSUD = { code: 'E71.0', name: 'Болезнь "кленового сиропа"', type: 'main' };
const notesOf = (current, extra = {}) => JSON.stringify({ __service_workspace_v1: 1, current, history: [], ...extra });
const parsed = (id) => JSON.parse(NOTES.get(id));
// Кабинет строки, как его открывает врач: форма, тип, записи с сервера — в лист.
function cabinet(id, type = 'conclusion', patient = {}, notes = notesOf(null)) {
    const container = new El('div');
    const ctx = { container, visitServiceId: id, visitId: 100 + id, patient: { id, lastName: 'Пациент' + id, firstName: 'Тест', mrn: 'P-' + id, __service: { id, name: 'Услуга ' + id, doctorName: 'Каримов Алишер', doctorSpec: 'Врач УЗИ-диагностики' }, ...patient } };
    NOTES.set(id, notes);
    WS.activateWorkspace(ctx);
    container.appendChild(WS.soapForm(ctx));
    WS.setDocType(ctx, type);
    return ctx;
}
async function opened(id, type, patient, notes) {
    const ctx = cabinet(id, type, patient, notes);
    await WS.hydrateLine(ctx);
    return ctx;
}
const field = (ctx, k) => ctx.container.querySelector('[data-field="' + k + '"]');
const put = (ctx, k, v) => { field(ctx, k).innerHTML = v; };
const touch = (ctx) => ctx.container.dispatch('pointerdown');

// ─── F1: подписанная версия не теряется, если строку отложили во время подписи ─
test('F1: подпись A «в пути», врач открыл B и вернулся к A — у A подписанная версия; «Черновик» её не стирает; новая подпись — «уже подписан», версия 2', async () => {
    LOG.length = 0;
    const a = await opened(1, 'conclusion', { lastName: 'Азизов' });
    WS.applyFields(a, { chief_complaint: 'Жалобы A', conclusion_text: 'Заключение A' });
    answerConfirm(true);
    const release = hold('write:1');
    const signing = WS.signDocument(a);
    await tick(5);
    await opened(2, 'conclusion', { lastName: 'Каримова' });   // A отложена с записями ДО подписи
    release();
    await signing;
    touch(a);                                                    // врач вернулся к A
    const pl = await WS.currentPayload(a);
    assert.deepEqual(pl.history.map((e) => e.kind), ['signed'], 'у A после возврата нет подписанной версии');
    assert.ok(await WS.saveDraft(a, { silent: true }), 'черновик A не записан');
    assert.deepEqual(parsed(1).history.map((e) => e.kind), ['signed', 'draft'], '«Черновик» стёр подписанную версию');
    CONFIRMS.length = 0;
    await WS.signDocument(a);
    assert.match(CONFIRMS[0] || '', /уже подписан/, 'повторная подпись спросила не «уже подписан»');
    const arch = LOG.filter((e) => e.kind === 'archive');
    assert.deepEqual(arch.map((e) => e.body.body.meta.version), [1, 2], 'обе подписи — версия 1');
});

test('F1: подпись диагностики A «в пути», открыта B («Приём») — архив A: тип, описание, рецепт, диагнозы и заключение A', async () => {
    LOG.length = 0;
    const a = await opened(3, 'diag', { lastName: 'Азизов' }, notesOf(null, {
        prescriptions: [{ name: 'Канефрон', dur: '14 дней' }],
        diagnoses: [{ code: 'N28.9', name: 'Болезнь почки', type: 'main' }, { code: 'K29.7', name: 'Гастрит', type: 'concomitant' }] }));
    put(a, 'instrumental_text', 'Почки обычных размеров');
    put(a, 'primary_diagnosis', 'Эхопризнаков патологии нет');
    answerConfirm(true);
    const release = hold('write:3');
    const signing = WS.signDocument(a);
    await tick(5);
    const b = await opened(4, 'conclusion', { lastName: 'Каримова' }, notesOf({ chief_complaint: 'Жалобы B' }, { prescriptions: [{ name: 'B-DRUG' }] }));
    put(b, 'instrumental_text', 'ОПИСАНИЕ B');
    release();
    await signing;
    const arch = LOG.find((e) => e.kind === 'archive');
    assert.ok(arch, 'архив не записан');
    assert.equal(arch.body.visit_service_id, 3);
    assert.equal(arch.body.doc_type, 'diag', 'вид архива — от открытой строки B');
    const d = arch.body.body;
    assert.match(d.patientName, /Азизов/);
    assert.equal(d.description, 'Почки обычных размеров');
    assert.equal(d.conclusion, 'N28.9 — Болезнь почки\nЭхопризнаков патологии нет');
    assert.equal(d.conclusionBody, 'Эхопризнаков патологии нет');
    assert.ok(!('conclusionText' in d), 'текст врача снова под ключом «Заключения» протокола (журнал теряет код)');
    assert.deepEqual(d.prescriptions.map((r) => r.name), ['Канефрон']);
    assert.deepEqual(d.diagnoses.map((x) => x.code), ['N28.9', 'K29.7']);
    assert.equal(JSON.parse(NOTES.get(4)).current.chief_complaint, 'Жалобы B', 'записи B тронуты подписью A');
    // бланк печатает ровно то же
    const t = text(renderDesignedVariant('diag', 'classic', S, d));
    assert.match(t, /N28\.9 — Болезнь почки Эхопризнаков патологии нет/);
});

// ─── F3 и F5: незагруженная строка не сохраняется и не правится ─────────────
test('F3/F5: пока записи строки «в пути» — лист не правится, «Черновик» и подпись отказывают и ничего не пишут; пришли — текст на месте, всё работает', async () => {
    LOG.length = 0;
    const release = hold('read:5');
    const ctx = cabinet(5, 'conclusion', {}, notesOf({ chief_complaint: 'СОХРАНЁННЫЕ ЖАЛОБЫ' }, { history: [{ kind: 'draft', savedAt: '2026-10-01T08:00:00Z', fields: {} }] }));
    const loading = WS.hydrateLine(ctx);
    await tick(5);
    assert.equal(WS.wsLoading(ctx), true);
    assert.equal(field(ctx, 'chief_complaint').contentEditable, 'false', 'лист можно править, пока записи не пришли — набранное пропадёт');
    TOASTS.length = 0;
    assert.equal(await WS.saveDraft(ctx), false, 'черновик незагруженной строки записан');
    answerConfirm(true); CONFIRMS.length = 0;
    await WS.signDocument(ctx);
    assert.ok(!LOG.some((e) => e.kind === 'line' || e.kind === 'archive'), 'незагруженная строка что-то записала');
    assert.deepEqual(CONFIRMS, [], 'подпись незагруженной строки спросила «подписать?»');
    assert.ok(TOASTS.some((t) => /ещё загружается/.test(t)), 'отказ без объяснения');
    release();
    await loading;
    assert.equal(WS.wsLoading(ctx), false);
    assert.equal(field(ctx, 'chief_complaint').contentEditable, 'true', 'после загрузки лист не правится');
    assert.equal(WS.collectFields(ctx).chief_complaint, 'СОХРАНЁННЫЕ ЖАЛОБЫ');
    assert.ok(await WS.saveDraft(ctx, { silent: true }));
    assert.equal(parsed(5).current.chief_complaint, 'СОХРАНЁННЫЕ ЖАЛОБЫ', 'черновик после загрузки стёр текст');
});

test('F3: записи не прочитались (ошибка сервера) — это не «пустой документ»: ничего не пишется, при следующей попытке читаются заново', async () => {
    LOG.length = 0;
    const saved = notesOf({ chief_complaint: 'НАСТОЯЩИЙ ДОКУМЕНТ' }, { history: [{ kind: 'signed', savedAt: '2026-10-01T08:00:00Z', fields: {} }] });
    const ctx = cabinet(6, 'conclusion', {}, saved);
    FAIL.add('read:6');
    await WS.hydrateLine(ctx);
    assert.equal(WS.wsLoading(ctx), true, 'непрочитанные записи сочтены загруженными');
    assert.equal(await WS.saveDraft(ctx, { silent: true }), false);
    const pl = await WS.currentPayload(ctx);
    assert.equal(await WS.writePayload(ctx, pl), false, 'непрочитанные записи (пустые) записаны поверх документа');
    assert.equal(NOTES.get(6), saved, 'документ строки стёрт');
    await tick(10);                                              // повторные чтения, запущенные отказами, завершились
    FAIL.delete('read:6');
    assert.equal(await WS.saveDraft(ctx, { silent: true }), false);   // отказ запускает повторное чтение
    await tick(10);
    assert.equal(WS.wsLoading(ctx), false, 'повторное чтение не запущено');
    assert.equal(WS.collectFields(ctx).chief_complaint, 'НАСТОЯЩИЙ ДОКУМЕНТ');
});

// ─── F4: повторный экран в тот же корень — один набор слушателей ───────────
test('F4: смена языка трижды перерисовала кабинет в тот же корень — по одному слушателю; нажатие клавиши не перечитывает записи', async () => {
    NOTES.set(7, notesOf({ chief_complaint: 'Текст' }));
    const root = new El('div');
    const payload = { id: 7, lastName: 'Азизов', firstName: 'A', __service: { id: 7, visitId: 7, name: 'Консультация' } };
    for (let i = 0; i < 3; i++) {
        root.children = [];                     // admin.js: clear(root) и новый экран в тот же корень
        WS.renderServiceWorkspace(root, { onNavigate: () => {}, payload });
        await tick(10);
    }
    for (const ev of ['pointerdown', 'keydown']) assert.equal((root._l[ev] || []).length, 1, ev + ': слушатели прежних экранов остались');
    LOG.length = 0;
    for (let i = 0; i < 5; i++) root.dispatch('keydown');
    await tick(10);
    assert.equal(LOG.filter((e) => e.kind === 'read').length, 0, 'нажатие клавиши перечитывает записи строки');
});

// ─── F7: код из строки врача убирается только у записей до ревью 2 ─────────
test('F7: «J06.9 — ОРВИ<br>Текст», записанное после ревью 2, при открытии не трогается; у старой записи — убирается; строка кода в середине — остаётся', async () => {
    const ORVI = { code: 'J06.9', name: 'ОРВИ', type: 'main' };
    const marked = await opened(8, 'conclusion', {}, notesOf({ primary_diagnosis: 'J06.9 — ОРВИ<br>Текст' }, { diagnoses: [ORVI], dxSplit: 1 }));
    put(marked, 'primary_diagnosis', 'J06.9 — ОРВИ<br>Текст');   // как пришло (санитайзер стенда без DOMParser экранирует)
    WS.syncDiagnosisToDoc(marked, { keepBand: !JSON.parse(NOTES.get(8)).dxSplit });
    assert.equal(field(marked, 'primary_diagnosis').innerHTML, 'J06.9 — ОРВИ<br>Текст', 'текст, вставленный шаблоном после ревью 2, срезан');
    // CABINET_FIX_V1_R4 (п. 12) — открытие и отметка dxSplit черновиком и подписью — поведением: cabinet-review-r4.test.mjs, «12 (F7)»
    const band = (html) => { const e = new El('div'); e.innerHTML = html; return e; };
    const old = band('J06.9 — ОРВИ<br>Текст');
    WS.applyDxBand(old, ORVI, { keep: true });
    assert.equal(old.innerHTML, 'Текст', 'старая запись не очищена');
    const mid = band('Текст<br>E71.0 — Болезнь &quot;кленового сиропа&quot;<br>ещё');
    WS.applyDxBand(mid, MSUD, { keep: true });
    assert.equal(mid.innerHTML, 'Текст<br>E71.0 — Болезнь &quot;кленового сиропа&quot;<br>ещё', 'строка кода в середине текста удалена');
});

// ─── F8: «Вставить результаты» — код подписанной записи ────────────────────
test('F8: «Диагноз» подписанной записи — её код (icd10) с названием, а не нынешний основной диагноз строки', () => {
    const f = { primary_diagnosis: 'Текст врача', icd10: 'N28.9' };
    const now = [{ code: 'E71.0', name: 'Болезнь "кленового сиропа"', type: 'main' }, { code: 'N28.9', name: 'Болезнь почки', type: 'concomitant' }];
    // CABINET_FIX_V1_R4 (п. 6) — кода записи нет среди диагнозов строки: строка кода, затем текст
    assert.equal(WS.entryDx(f, [MSUD]), 'N28.9\nТекст врача', 'под «Подписано» — нынешний основной диагноз (или код записи потерян)');
    assert.equal(WS.entryDx(f, [{ code: 'N28.9', name: 'Болезнь почки', type: 'main' }]), 'N28.9 — Болезнь почки\nТекст врача');
    // код записи в строке сейчас — сопутствующий: название берётся, код — основной этой записи
    assert.equal(WS.entryDx({ primary_diagnosis: '', icd10: 'N28.9' }, now), 'N28.9 — Болезнь почки');
    // поведение «Вставить результаты» — cabinet-review-r4.test.mjs, п. 6 (fillServiceConclusion)
});

// ─── F9: код — тоже содержимое «Диагноза» ─────────────────────────────────
test('F9: «Диагноз» записи до ревью 2 был только кодом — при новой подписи с тем же кодом он не «пуст»', () => {
    // CABINET_FIX_V1_R4 (п. 1) — opts.diagnoses: «Диагноз», бывший ТОЛЬКО строкой выбранного кода, — не пропал
    assert.deepEqual(WS.lostOnResign({ primary_diagnosis: 'E71.0 — Болезнь "кленового сиропа"' }, { primary_diagnosis: '' }, { diagnoses: [MSUD] }), []);
    assert.deepEqual(WS.lostOnResign({ primary_diagnosis: 'E71.0 — Болезнь "кленового сиропа"' }, { primary_diagnosis: '' }), ['Диагноз'], 'без кода — пропал');
    // поведение при подписи — cabinet-review-r4.test.mjs, п. 1
});

// ─── F10: строки Chrome ────────────────────────────────────────────────────
test('F10: «код<div>текст</div>» (так пишет Chrome) — код узнаётся, печатается один раз; блоки — строки, а не склейка', () => {
    assert.equal(WS._blankStrip('E71.0 — X<div>Текст</div>'), 'E71.0 — X\nТекст');
    assert.equal(WS._blankStrip('<div>а</div><div>б</div>'), 'а\nб');
    assert.equal(WS._blankStrip('а<div><br></div><div>б</div>'), 'а\n\nб');
    assert.equal(WS._blankStrip('а<br><br>б'), 'а\n\nб');
    assert.equal(WS._blankStrip('<p>а</p>б'), 'а\nб');
    const band = new El('div');
    band.innerHTML = 'E71.0 — Болезнь &quot;кленового сиропа&quot;<div>Текст врача</div>';
    WS.applyDxBand(band, MSUD, { keep: true });
    assert.equal(band.innerHTML, '<div>Текст врача</div>');
    assert.equal(WS.dxParts('E71.0 — Болезнь "кленового сиропа"<div>Текст врача</div>', [MSUD]).full, 'E71.0 — Болезнь "кленового сиропа"\nТекст врача', 'код напечатан дважды или склеен с текстом');
});

// ─── F11: двойной щелчок ──────────────────────────────────────────────────
test('F11: двойной щелчок «Подписать» / «Завершить приём» — одна подпись, один вопрос, одна версия; кнопки заперты, пока подпись «в пути»', async () => {
    LOG.length = 0;
    const a = await opened(9, 'conclusion');
    WS.applyFields(a, { chief_complaint: 'Жалобы' });
    answerConfirm(true); CONFIRMS.length = 0;
    const release = hold('write:9');
    const s1 = WS.signDocument(a), s2 = WS.signDocument(a);
    const f3 = WS.finishVisit(a);
    await tick(5);
    const btns = a.container.querySelectorAll('[data-ws-finish]');
    assert.ok(btns.length > 0 && btns.every((b) => b.disabled), '«Завершить приём» не заперта, пока подпись «в пути»');
    release();
    await Promise.all([s1, s2, f3]);
    assert.equal(CONFIRMS.length, 1, 'подпись спросила ' + CONFIRMS.length + ' раз');
    assert.equal(LOG.filter((e) => e.kind === 'archive').length, 1, 'две подписи в архиве');
    assert.ok(btns.every((b) => !b.disabled), 'после подписи кнопка осталась запертой');
    // запись строки, пока подпись «в пути», не стирает подписанную версию
    const release2 = hold('write:9');
    const s4 = WS.signDocument(a);
    await tick(5);
    TOASTS.length = 0;
    assert.equal(await WS.saveDraft(a, { silent: true }), false, 'черновик записан поверх подписи «в пути»');
    release2(); await s4;
    assert.deepEqual(parsed(9).history.map((e) => e.kind), ['signed', 'signed']);
});

// ─── F12: возврат к строке дорисовывает всё ───────────────────────────────
test('F12: пока A была отложена, её записи изменились (диагноз) — при возврате скрытый icd10 и лист — из её состояния', async () => {
    const a = await opened(10, 'conclusion');
    await opened(11, 'conclusion');                              // A отложена
    const pl = JSON.parse(JSON.stringify(await WS.currentPayload(a)));
    pl.diagnoses = [MSUD];
    assert.ok(await WS.writePayload(a, pl), 'запись отложенной строки не прошла');   // поздняя запись A
    touch(a);
    const icd = a.container.querySelector('[data-field="icd10"]');
    assert.equal(icd && icd.value, 'E71.0', 'скрытый icd10 A остался прежним');
    assert.match(code(WS_SRC), /function repaintLine\(ctx\)/);
    // ничего не пришло — лист при возврате не перерисовывается (щелчок не теряет место ввода)
    assert.match(code(WS_SRC), /if \(ctx\.__wsDirty\) \{ ctx\.__wsDirty = false; repaintLine\(ctx\); \}/);
    assert.equal(a.__wsDirty, false, 'отметка «пришло, пока отложена» не снята');
});

// ─── «×» у «Диагноза» с кодом; санитайзер ──────────────────────────────────
test('«×» у «Диагноза» с выбранным кодом: вопрос называет коды; «Да» — код уходит вместе с текстом (экран = архив); «Нет» — всё на месте', async () => {
    const ctx = await opened(12, 'conclusion', {}, notesOf(null, { diagnoses: [MSUD] }));
    CONFIRMS.length = 0;
    answerConfirm(false);
    WS.wsRemoveSection(ctx, 'diagnosis');
    assert.match(CONFIRMS[0] || '', /E71\.0/, 'вопрос не называет код');
    assert.equal((await WS.currentPayload(ctx)).diagnoses.length, 1);
    answerConfirm(true);
    WS.wsRemoveSection(ctx, 'diagnosis');
    await tick(5);
    assert.deepEqual((await WS.currentPayload(ctx)).diagnoses, []);
    assert.deepEqual(parsed(12).diagnoses, [], 'код остался в записях — архив его напечатает');
    assert.equal(WS.docSnapshot(ctx, 'conclusion').dx, '');
});

test('санитайзеры не пропускают <noscript> и другие «сырые» элементы (mXSS)', () => {
    const SAN = fs.readFileSync(path.join(HERE, '..', 'sanitize.js'), 'utf8');
    for (const [name, src, n] of [['service-workspace.js', WS_SRC, 2], ['sanitize.js', SAN, 1]]) {
        const sets = src.match(/BAD_TAGS = new Set\(\[[^\]]*\]/g) || [];
        assert.equal(sets.length, n, name);
        for (const s of sets) for (const t of ['NOSCRIPT', 'NOEMBED', 'NOFRAMES', 'TEMPLATE', 'XMP', 'PLAINTEXT']) assert.ok(s.includes("'" + t + "'"), name + ': нет ' + t);
    }
});

test('подписи ревью 3 — на трёх языках', async () => {
    const { STRINGS } = await import('../i18n-strings.js');
    for (const key of [
        'Документ подписывается — подождите секунду и повторите.',
        'Документ загружается — подождите секунду.',
        'Удалить раздел «{name}» вместе с кодами МКБ-10 ({codes})?',
    ]) {
        const e = STRINGS[key];
        assert.ok(e, 'строки нет в словаре: ' + key);
        for (const lang of ['ru', 'uz', 'en']) assert.ok(e[lang], key + ': нет перевода ' + lang);
    }
});
