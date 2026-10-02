// CABINET_FIX_V1_R4 (2026-10-02) — РЕВЬЮ 4: ПОДПИСАННАЯ ВЕРСИЯ НЕ СТИРАЕТСЯ НИ
// ИЗ ДРУГОГО ОКНА, НИ ИЗ ПЕРЕРИСОВАННОГО ЭКРАНА; НЕЗАГРУЖЕННЫЙ ЛИСТ НЕ ПРИНИМАЕТ
// ВСТАВОК; НЕУДАЧНАЯ ЗАГРУЗКА ПОВТОРЯЕТСЯ И ГОВОРИТ ПРАВДУ; КНОПКИ НЕ «УМИРАЮТ».
//
// Настоящая форма кабинета в DOM-стенде и фальшивый сервер, который держит то
// же правило, что /api/db (services/domain/cabinet-notes.js): запись, потерявшая
// подписанную версию, — 409.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom, El, CONFIRMS, TOASTS, answerConfirm } from './cabinet-harness.mjs';
import { signedVersionsDropped, SIGNED_CONFLICT_MESSAGE } from '../../../../server/services/domain/cabinet-notes.js';

installFakeDom();
// Разбор разметки «как есть» (санитайзер кабинета без DOMParser экранирует её —
// здесь проверяется не он, а то, что делает кабинет с текстом врача).
globalThis.NodeFilter = { SHOW_ELEMENT: 1 };
globalThis.DOMParser = class {
    parseFromString(s) {
        const inner = String(s).replace(/^<div id="[^"]+">/, '').replace(/<\/div>$/, '');
        return { getElementById: () => ({ innerHTML: inner }), createTreeWalker: () => ({ nextNode: () => null }) };
    }
};

// ─── фальшивый сервер ─────────────────────────────────────────────────────────
const NOTES = new Map();
const HOLD = new Map();            // ключ -> Promise: все запросы ключа ждут
const QUEUE = new Map();           // ключ -> [Promise]: каждый следующий запрос ключа ждёт свой
const FAIL = new Set();            // ключи: ответ — ошибка сервера
const FAIL_RPC = new Map();        // имя RPC -> сколько раз ответить ошибкой
const LOG = [];
const READS = new Map();
const hold = (key) => { let release; HOLD.set(key, new Promise((r) => { release = r; })); return () => { HOLD.delete(key); release(); }; };
const holdNext = (key) => { let release; const p = new Promise((r) => { release = r; }); if (!QUEUE.has(key)) QUEUE.set(key, []); QUEUE.get(key).push(p); return release; };
const wait = async (key) => { if (HOLD.has(key)) await HOLD.get(key); const q = QUEUE.get(key); if (q && q.length) await q.shift(); };
const resp = (ok, status, payload) => ({ ok, status, json: async () => payload, headers: { getSetCookie: () => [] } });
globalThis.fetch = async (url, opts) => {
    const u = String(url);
    const body = JSON.parse((opts && opts.body) || '{}');
    const ok = (data) => resp(true, 200, { data });
    if (u.startsWith('/api/rpc/')) {
        const name = u.slice('/api/rpc/'.length);
        if (name === 'visit_document_archive') {
            LOG.push({ kind: 'archive-try', body });
            const left = FAIL_RPC.get(name) || 0;
            if (left > 0) { FAIL_RPC.set(name, left - 1); return resp(false, 500, { error: { message: 'сбой архива' } }); }
            LOG.push({ kind: 'archive', body });
        }
        return ok({ id: 1 });
    }
    if (u === '/api/db') {
        const idF = (body.filters || []).find((f) => f.col === 'id');
        const id = idF && Number(idF.val);
        if (body.table === 'visit_services' && body.op === 'select') {
            if (/^services\(type/.test(String(body.columns))) return ok({ services: { type: 'consultation', service_types: { name: 'Консультации' }, departments: null } });
            if (/notes/.test(String(body.columns))) {
                READS.set(id, (READS.get(id) || 0) + 1);
                await wait('read:' + id);
                if (FAIL.has('read:' + id)) return resp(false, 500, { error: { message: 'сбой чтения' } });
                return ok(NOTES.has(id) ? { notes: NOTES.get(id) } : null);
            }
            return ok([]);
        }
        if (body.table === 'visit_services' && body.op === 'update') {
            await wait('write:' + id);
            if (FAIL.has('write:' + id)) return resp(false, 500, { error: { message: 'сбой записи' } });
            if (body.values && body.values.notes != null && signedVersionsDropped(NOTES.get(id), body.values.notes)) {
                LOG.push({ kind: '409', id });
                return resp(false, 409, { error: { code: 'signed_conflict', message: SIGNED_CONFLICT_MESSAGE } });
            }
            LOG.push({ kind: 'line', id, values: body.values });
            if (body.values && body.values.notes != null) NOTES.set(id, body.values.notes);
            return ok(null);
        }
        if (body.table === 'patient_conditions' && body.op === 'delete') {
            const c = (body.filters || []).find((f) => f.col === 'code');
            LOG.push({ kind: 'cond-del', code: c && c.val });
            return ok(null);
        }
        if (body.table === 'visits' && body.op === 'update') { LOG.push({ kind: 'visit', id, values: body.values }); return ok(null); }
        return ok(body.op === 'select' && !body.single ? [] : null);
    }
    return ok(null);
};

const WS = await import('../views/service-workspace.js');
WS.__setTimingForTests({ retryBaseMs: 40, signTimeoutMs: 30000 });
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const notesOf = (current, extra = {}) => JSON.stringify({ __service_workspace_v1: 1, current, history: [], ...extra });
const parsed = (id) => JSON.parse(NOTES.get(id));
const kinds = (id) => parsed(id).history.map((e) => e.kind);
const SIGNED = (fields, at = '2026-10-01T08:00:00.000Z') => ({ kind: 'signed', savedAt: at, by: null, byName: 'Каримов Алишер', fields });
const MSUD = { code: 'E71.0', name: 'Болезнь "кленового сиропа"', type: 'main' };
const J209 = { code: 'J20.9', name: 'Острый бронхит', type: 'main' };

function cabinet(id, notes = notesOf(null), { container = new El('div'), type = 'conclusion', patient = {} } = {}) {
    const ctx = { container, visitServiceId: id, visitId: 100 + id, patient: { id, lastName: 'Пациент' + id, firstName: 'Тест', mrn: 'P-' + id, __service: { id, name: 'Услуга ' + id, doctorName: 'Каримов Алишер', doctorSpec: 'Терапевт' }, ...patient } };
    if (notes != null) NOTES.set(id, notes);
    WS.activateWorkspace(ctx);
    container.children = [];
    container.appendChild(WS.soapForm(ctx));
    const wrap = container.querySelector('[data-blank-wrap]');   // бланк виден, как после setBlankMode в renderServiceWorkspace
    if (wrap) wrap.style.display = '';
    WS.setDocType(ctx, type);
    return ctx;
}
async function opened(id, notes, o) { const ctx = cabinet(id, notes, o); await WS.hydrateLine(ctx); return ctx; }
const field = (ctx, k) => ctx.container.querySelector('.a4-input[data-field="' + k + '"]');
const put = (ctx, k, v) => { field(ctx, k).innerHTML = v; };
const buttonByText = (root, t) => root.querySelectorAll('button').find((b) => String(b.textContent).includes(t));
const iframeFields = (ctx) => { const fr = ctx.container.querySelector('iframe'); return fr ? fr.contentDocument.body.querySelectorAll('[data-field]') : []; };
const iframeBar = (ctx) => { const fr = ctx.container.querySelector('iframe'); const bar = fr && fr.contentDocument.body.querySelector('[data-ws-actions]'); return bar ? bar.querySelectorAll('button') : []; };
const iframeNote = (ctx) => { const fr = ctx.container.querySelector('iframe'); return fr ? fr.contentDocument.body.querySelector('[data-ws-loading]') : null; };
const modalsOpen = () => document.body.children.filter((c) => c.classList && (c.classList.contains('modal') || c.classList.contains('modal-backdrop'))).length;

// ─── 1. F9: пропавший текст «Диагноза» при выбранном коде ─────────────────────
test('1 (F9): текст «Диагноза» стёрт, код J20.9 по-прежнему выбран — новая подпись предупреждает; «Диагноз» до ревью 2, бывший только кодом, — нет', async () => {
    const fieldsDx = { chief_complaint: 'Кашель', primary_diagnosis: 'Обструктивный, средней тяжести' };
    const a = await opened(1, notesOf(fieldsDx, { diagnoses: [J209], dxSplit: 1, history: [SIGNED(fieldsDx)] }));
    put(a, 'primary_diagnosis', '');
    answerConfirm(true); CONFIRMS.length = 0;
    await WS.signDocument(a);
    assert.ok(CONFIRMS.some((m) => /пусты разделы.*Диагноз/.test(m)), 'стёртый текст «Диагноза» не назван: ' + CONFIRMS.join(' | '));
    const codeOnly = { chief_complaint: 'Кашель', primary_diagnosis: 'J20.9 — Острый бронхит' };
    const b = await opened(2, notesOf(codeOnly, { diagnoses: [J209], history: [SIGNED(codeOnly)] }));   // запись до ревью 2: код в строке врача
    assert.equal(field(b, 'primary_diagnosis').innerHTML, '', 'код старой записи не убран из строки врача');
    CONFIRMS.length = 0;
    await WS.signDocument(b);
    assert.ok(!CONFIRMS.some((m) => /пусты разделы/.test(m)), '«Диагноз», бывший только кодом, назван пропавшим');
    assert.deepEqual(WS.lostOnResign({ primary_diagnosis: 'Обструктивный' }, { primary_diagnosis: '' }, { diagnoses: [J209] }), ['Диагноз']);
    assert.deepEqual(WS.lostOnResign({ primary_diagnosis: 'J20.9 — Острый бронхит' }, { primary_diagnosis: '' }, { diagnoses: [J209] }), []);
    assert.deepEqual(WS.lostOnResign({ primary_diagnosis: 'J20.9 — Острый бронхит' }, { primary_diagnosis: '' }, { diagnoses: [] }), ['Диагноз'], 'код снят — «Диагноз» пропал');
});

// ─── 2. Другое окно подписало: 409, текст врача на экране, повтор проходит ────
test('2: другое окно подписало строку — «Сохранить» со старой копией: сервер отказывает, история с подписью принята, текст врача на экране; второе «Сохранить» — проходит', async () => {
    const a = await opened(3, notesOf({ chief_complaint: 'Кашель' }));
    // другая вкладка подписала документ
    const other = JSON.parse(NOTES.get(3));
    other.history.push(SIGNED({ chief_complaint: 'Кашель' }, '2026-10-02T09:00:00.000Z'));
    NOTES.set(3, JSON.stringify(other));
    put(a, 'chief_complaint', 'Кашель, МОЯ ПРАВКА');
    TOASTS.length = 0;
    assert.equal(await WS.saveDraft(a, { silent: true }), false, 'черновик со старой копией записан');
    assert.deepEqual(kinds(3), ['signed'], 'подписанная версия стёрта');
    assert.ok(TOASTS.some((t) => /подписан в другом окне.*Ваш текст остался на экране/.test(t)), 'врач не узнал, что произошло: ' + TOASTS.join(' | '));
    assert.equal(field(a, 'chief_complaint').innerHTML, 'Кашель, МОЯ ПРАВКА', 'текст врача пропал с экрана');
    assert.ok(await WS.saveDraft(a, { silent: true }), 'повторное «Сохранить» не прошло');
    assert.deepEqual(kinds(3), ['signed', 'draft']);
    assert.equal(parsed(3).current.chief_complaint, 'Кашель, МОЯ ПРАВКА');
});

test('2 [H]: смена языка, пока подпись «в пути»: новый экран той же строки не пишет, пока подпись не дошла, и потом пишет поверх подписанной истории', async () => {
    const root = new El('div');
    const a = await opened(4, notesOf(null), { container: root });
    WS.applyFields(a, { chief_complaint: 'Жалобы H' });
    answerConfirm(true);
    const release = hold('write:4');
    const signing = WS.signDocument(a);
    await tick(5);
    const b = await opened(4, null, { container: root });         // перерисовка в тот же корень: новый экран, записи до подписи
    TOASTS.length = 0;
    assert.equal(await WS.saveDraft(b, { silent: true }), false, 'новый экран писал, пока подпись «в пути»');
    assert.ok(TOASTS.some((t) => /подписывается/.test(t)));
    release(); await signing;
    assert.ok(await WS.saveDraft(b, { silent: true }), 'после подписи новый экран не пишет');
    assert.deepEqual(kinds(4), ['signed', 'draft'], 'черновик нового экрана стёр подпись');
    assert.ok(!LOG.some((e) => e.kind === '409' && e.id === 4), 'новый экран писал со старой копией (сервер отказал)');
});

// ─── 3. Незагруженный лист: вставки отказывают ────────────────────────────────
test('3 (F5): пока записи строки «в пути» — шаблон, «Вставить результаты», МКБ-10, рецепт и любая запись отказывают; «Шаблоны» и кнопки бланка заперты; после загрузки — работают', async () => {
    const release = hold('read:5');
    const ctx = cabinet(5, notesOf({ chief_complaint: 'СОХРАНЕНО' }));
    const loading = WS.hydrateLine(ctx);
    await tick(5);
    TOASTS.length = 0;
    const T = { doc_type: '0', body: { chief_complaint: 'ШАБЛОН' } };
    WS.tplApply(ctx, T);
    WS.a4InsertHtml(ctx, '<b>РЕЗУЛЬТАТ</b>', 'chief_complaint');
    const before = modalsOpen();
    WS.pastePickField(ctx, '<b>РЕЗУЛЬТАТ</b>', 'chief_complaint');
    WS.openDiagnosisModal(ctx);
    WS.openPrescriptionDialog(ctx, null);
    assert.equal(modalsOpen(), before, 'окно вставки / МКБ / рецепта открылось на незагруженном листе');
    assert.equal(field(ctx, 'chief_complaint').innerHTML, '', 'текст вставлен в незагруженный лист');
    assert.equal(await WS.writePayload(ctx, { __service_workspace_v1: 1, current: {}, history: [] }), false, 'запись незагруженной строки прошла');
    assert.ok(TOASTS.filter((t) => /ещё загружается/.test(t)).length >= 5, 'отказы без объяснения: ' + TOASTS.join(' | '));
    assert.equal(buttonByText(ctx.container, 'Шаблоны').disabled, true, '«Шаблоны» не заперта');
    assert.ok(iframeBar(ctx).length > 0 && iframeBar(ctx).every((b) => b.disabled), 'кнопки бланка («Рецепт», «Вставить результаты»…) не заперты');
    release(); await loading; await tick(5);
    assert.equal(field(ctx, 'chief_complaint').innerHTML, 'СОХРАНЕНО');
    assert.ok(!buttonByText(ctx.container, 'Шаблоны').disabled, '«Шаблоны» заперта после загрузки');
    assert.ok(iframeBar(ctx).length > 0 && iframeBar(ctx).every((b) => !b.disabled), 'кнопки бланка заперты после загрузки');
    WS.tplApply(ctx, T);
    assert.equal(field(ctx, 'chief_complaint').innerHTML, 'СОХРАНЕНО<br><br>ШАБЛОН', 'после загрузки шаблон не вставляется');
});

test('3 (F5): поля бланка (iframe) не редактируются, пока записи строки «в пути», и редактируются после', async () => {
    const release = hold('read:23');
    const ctx = cabinet(23, notesOf({ instrumental_text: 'ОПИСАНИЕ' }, { docType: 'diag' }), { type: 'diag' });
    const loading = WS.hydrateLine(ctx);
    await tick(5);
    assert.ok(iframeFields(ctx).length > 0, 'бланк без полей');
    assert.ok(iframeFields(ctx).every((f) => f.getAttribute('contenteditable') === 'false'), 'поля бланка правятся во время загрузки');
    release(); await loading; await tick(5);
    assert.ok(iframeFields(ctx).length > 0 && iframeFields(ctx).every((f) => f.getAttribute('contenteditable') === 'true'), 'поля бланка заперты после загрузки');
});

// ─── 4. Неудачная загрузка: повтор, правдивая надпись, «Повторить» ────────────
test('4 (F3): записи не прочитались — надпись «Не удалось загрузить документ.» с «Повторить»; повтор сам, с паузой; сервер ожил — лист загружен', async () => {
    FAIL.add('read:6');
    const ctx = cabinet(6, notesOf({ chief_complaint: 'НАСТОЯЩИЙ' }));
    await WS.hydrateLine(ctx);
    assert.equal(WS.wsLoading(ctx), true);
    const n = iframeNote(ctx);
    assert.ok(n && /Не удалось загрузить документ/.test(n.textContent), 'надпись не говорит о сбое: ' + (n && n.textContent));
    const retryBtn = n.querySelectorAll('button').find((b) => /Повторить/.test(b.textContent));
    assert.ok(retryBtn, 'нет кнопки «Повторить»');
    const r0 = READS.get(6);
    await tick(150);
    assert.ok(READS.get(6) > r0, 'загрузка не повторяется сама');
    const r1 = READS.get(6);
    retryBtn.dispatch('click');
    await tick(5);
    assert.ok(READS.get(6) > r1, '«Повторить» не читает записи');
    FAIL.delete('read:6');
    await tick(1500);
    assert.equal(WS.wsLoading(ctx), false, 'после того как сервер ожил, лист не загрузился');
    assert.equal(field(ctx, 'chief_complaint').innerHTML, 'НАСТОЯЩИЙ');
});

test('4 (F3): исключение внутри загрузки (раскладка полей) — тот же путь сбоя, лист не заперт молча навсегда', async () => {
    const ctx = cabinet(7, notesOf({ chief_complaint: 'ТЕКСТ' }));
    const root = ctx.container;
    const orig = root.querySelectorAll.bind(root);
    let boom = 1;
    root.querySelectorAll = (sel) => { if (boom && sel === '[data-field]') { boom--; throw new Error('сбой раскладки'); } return orig(sel); };
    await WS.hydrateLine(ctx);
    assert.equal(WS.wsLoading(ctx), true);
    assert.match((iframeNote(ctx) || {}).textContent || '', /Не удалось загрузить документ/);
    await tick(400);
    assert.equal(WS.wsLoading(ctx), false, 'после сбоя раскладки загрузка не повторилась');
    assert.equal(field(ctx, 'chief_complaint').innerHTML, 'ТЕКСТ');
});

// ─── 5. Кнопки «Черновик» / «Сохранить» не умирают после первого нажатия ──────
test('5: «Черновик» и «Сохранить» дважды подряд — оба раза пишут, кнопки снова доступны', async () => {
    const ctx = await opened(8, notesOf(null));
    WS.applyFields(ctx, { chief_complaint: 'первый' });
    for (const label of ['Черновик', 'Сохранить']) {
        for (const txt of ['первый ' + label, 'второй ' + label]) {
            put(ctx, 'chief_complaint', txt);
            field(ctx, 'chief_complaint').dispatch('input');   // правка врача
            const b = buttonByText(ctx.container, label);
            assert.ok(b && !b.disabled, '«' + label + '» заперта перед «' + txt + '»');
            b.dispatch('click');
            await b._pending; await tick(5);
            assert.equal(parsed(8).current.chief_complaint, txt, '«' + label + '» не записал «' + txt + '»');
        }
    }
});

// ─── 6. F8: код подписанной записи — и без названия ──────────────────────────
test('6 (F8): код записи, которого нет среди диагнозов строки, печатается строкой кода; «Вставить результаты» — код подписанной записи', async () => {
    assert.equal(WS.entryDx({ icd10: 'J20.9', primary_diagnosis: 'Средней тяжести' }, []), 'J20.9\nСредней тяжести');
    assert.equal(WS.entryDx({ icd10: 'J20.9', primary_diagnosis: 'Средней тяжести' }, [J209]), 'J20.9 — Острый бронхит\nСредней тяжести');
    assert.equal(WS.entryDx({ icd10: 'N28.9', primary_diagnosis: 'N28.9 — Болезнь почки<br>Текст' }, []), 'N28.9 — Болезнь почки\nТекст', 'код старой записи повторён');
    NOTES.set(9, notesOf(null, { diagnoses: [MSUD], history: [SIGNED({ primary_diagnosis: 'Текст врача', icd10: 'N28.9' })] }));
    const out = await WS.fillServiceConclusion(new El('div'), { id: 9 });
    assert.match(out.html, /Диагноз: N28\.9; Текст врача/, '«Вставить результаты» без кода подписанной записи: ' + out.html);
    assert.ok(!/E71\.0/.test(out.html), 'под «Подписано» — нынешний основной диагноз');
});

// ─── 7. Архив не записался — врач узнаёт; повтор безопасен ────────────────────
test('7: архив подписи не записался — вопрос «Повторить запись сейчас?»; повтор удался — подписано; не удался — понятное сообщение, а не «Документ подписан»', async () => {
    LOG.length = 0;
    const a = await opened(10, notesOf(null));
    WS.applyFields(a, { chief_complaint: 'Жалобы' });
    FAIL_RPC.set('visit_document_archive', 1);
    answerConfirm(true); CONFIRMS.length = 0; TOASTS.length = 0;
    await WS.signDocument(a);
    assert.ok(CONFIRMS.some((m) => /копия документа для печати не записалась в архив.*Повторить/.test(m)), 'врача не спросили о повторе: ' + CONFIRMS.join(' | '));
    assert.equal(LOG.filter((e) => e.kind === 'archive').length, 1, 'повтор не записал архив');
    assert.ok(TOASTS.some((t) => /Документ подписан/.test(t)));
    const b = await opened(11, notesOf(null));
    WS.applyFields(b, { chief_complaint: 'Жалобы' });
    FAIL_RPC.set('visit_document_archive', 2);
    TOASTS.length = 0;
    await WS.signDocument(b);
    assert.ok(TOASTS.some((t) => /Подпись сохранена, но копия документа для печати в архив не записалась/.test(t)), 'сбой архива не назван: ' + TOASTS.join(' | '));
    assert.ok(!TOASTS.some((t) => /^Документ подписан/.test(t)), 'сбой архива доложен как успех');
    assert.deepEqual(kinds(11), ['signed'], 'подпись строки не записана');
});

// ─── 8. «×» у «Диагноза» с кодами — через удаление диагнозов, с ожиданием записи ─
test('8: «×» у «Диагноза» с кодами — коды уходят и из карты пациента (patient_conditions); отказ записи — экран и записи не расходятся', async () => {
    LOG.length = 0;
    const ctx = await opened(12, notesOf({ primary_diagnosis: 'Текст' }, { diagnoses: [MSUD, { code: 'K29.7', name: 'Гастрит', type: 'concomitant' }], dxSplit: 1 }));
    answerConfirm(true);
    FAIL.add('write:12');
    assert.equal(await WS.wsRemoveSection(ctx, 'diagnosis'), false);
    FAIL.delete('write:12');
    assert.equal(field(ctx, 'primary_diagnosis').innerHTML, 'Текст', 'отказ записи — а текст стёрт');
    assert.equal((await WS.currentPayload(ctx)).diagnoses.length, 2, 'отказ записи — а коды убраны с экрана');
    assert.equal(await WS.wsRemoveSection(ctx, 'diagnosis'), true);
    assert.deepEqual(parsed(12).diagnoses, []);
    assert.deepEqual(LOG.filter((e) => e.kind === 'cond-del').map((e) => e.code).sort(), ['E71.0', 'K29.7'], 'коды остались в карте пациента');
    assert.equal(field(ctx, 'primary_diagnosis').innerHTML, '');
});

// ─── 9. _blankStrip: <br> перед блоком — не лишняя пустая строка ──────────────
test('9: «строка1<br><div>строка2</div>» — одна новая строка, а не пустая; прежние формы — как были', () => {
    assert.equal(WS._blankStrip('строка1<br><div>строка2</div>'), 'строка1\nстрока2');
    assert.equal(WS._blankStrip('E71.0 — X<div>Текст</div>'), 'E71.0 — X\nТекст');
    assert.equal(WS._blankStrip('а<div><br></div><div>б</div>'), 'а\n\nб');
    assert.equal(WS._blankStrip('а<br><br>б'), 'а\n\nб');
    assert.equal(WS._blankStrip('<div>а</div><div>б</div>'), 'а\nб');
});

// ─── 10. Зависшая запись подписи; смена языка во время загрузки ───────────────
test('10a: запись подписи не отвечает — через срок замок снят, врач предупреждён, строка снова пишет; поздний ответ ничего не стирает', async () => {
    WS.__setTimingForTests({ signTimeoutMs: 60 });
    try {
        const a = await opened(13, notesOf(null));
        WS.applyFields(a, { chief_complaint: 'Жалобы' });
        answerConfirm(true); TOASTS.length = 0;
        const release = hold('write:13');
        await WS.signDocument(a);
        assert.ok(TOASTS.some((t) => /Сервер не ответил — проверьте и повторите/.test(t)), 'зависание не названо');
        assert.equal(WS.lineSigning(13), false, 'замок подписи остался');
        assert.ok(a.container.querySelectorAll('[data-ws-finish]').every((b) => !b.disabled), '«Завершить приём» заперта навсегда');
        release(); await tick(10);                                   // поздний ответ подписи дошёл
        put(a, 'chief_complaint', 'Жалобы, позже');
        await WS.saveDraft(a, { silent: true });                     // старая копия — сервер отказывает, история принимается
        assert.ok(await WS.saveDraft(a, { silent: true }));
        assert.deepEqual(kinds(13), ['signed', 'draft'], 'поздний ответ подписи и черновик разошлись');
    } finally { WS.__setTimingForTests({ signTimeoutMs: 30000 }); }
});

test('10b: смена языка во время загрузки — старый экран, догрузившись позже, не запирает поля нового', async () => {
    const root = new El('div');
    const relA = holdNext('read:14'), relB = holdNext('read:14');
    NOTES.set(14, notesOf({ chief_complaint: 'Текст' }));
    const a = cabinet(14, null, { container: root });
    const la = WS.hydrateLine(a);
    await tick(2);
    const b = cabinet(14, null, { container: root });
    const lb = WS.hydrateLine(b);
    relB(); await lb;                                                // новый экран загрузился первым
    assert.equal(field(b, 'chief_complaint').contentEditable, 'true');
    relA(); await la;                                                // старый — позже
    assert.equal(field(b, 'chief_complaint').contentEditable, 'true', 'старый экран запер поля нового');
});

// ─── 11. ResizeObserver: снятый корень отключается ───────────────────────────
test('11: корень панели, снятый со страницы, отключает свой ResizeObserver', () => {
    const made = [];
    const Prev = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class { constructor(cb) { this.cb = cb; this.off = false; made.push(this); } observe() {} disconnect() { this.off = true; } unobserve() {} };
    try {
        const root = new El('div');
        cabinet(15, notesOf(null), { container: root });
        assert.equal(made.length, 1);
        Object.defineProperty(root, 'isConnected', { get: () => false, configurable: true });
        made[0].cb([{ contentRect: { width: 100, height: 100 } }]);
        assert.equal(made[0].off, true, 'наблюдатель снятого корня не отключён');
    } finally { globalThis.ResizeObserver = Prev; }
});

// ─── 12. Пробелы проверок ─────────────────────────────────────────────────────
test('12: непрочитанные записи не кэшируются — следующее обращение читает снова', async () => {
    FAIL.add('read:16');
    const ctx = cabinet(16, notesOf({ chief_complaint: 'НАСТОЯЩИЙ' }));
    const p1 = await WS.currentPayload(ctx);
    assert.equal(p1.current, null);
    FAIL.delete('read:16');
    const r = READS.get(16);
    const p2 = await WS.currentPayload(ctx);
    assert.equal(READS.get(16), r + 1, 'непрочитанное взято из кэша');
    assert.equal(p2.current.chief_complaint, 'НАСТОЯЩИЙ');
});

test('12: подпись строки, чьи записи устарели и не перечитались, отказывает и ничего не пишет; загружается — тоже', async () => {
    LOG.length = 0;
    const ctx = await opened(17, notesOf({ chief_complaint: 'Текст' }));
    WS.invalidateLine(17);                                           // подпись в другом экране — копия устарела
    FAIL.add('read:17');
    answerConfirm(true); CONFIRMS.length = 0;
    await WS.signDocument(ctx);
    FAIL.delete('read:17');
    assert.ok(!LOG.some((e) => e.kind === 'line' || e.kind === 'archive'), 'подпись по непрочитанным записям что-то записала');
    assert.deepEqual(CONFIRMS, []);
    const release = hold('read:18');
    const b = cabinet(18, notesOf(null));
    const lb = WS.hydrateLine(b);
    await WS.signDocument(b);
    assert.ok(!LOG.some((e) => e.kind === 'line' && e.id === 18));
    release(); await lb;
});

test('12: «Завершить приём» дважды, пока сохранение перед подписью «в пути», — одна подпись', async () => {
    LOG.length = 0;
    const a = await opened(19, notesOf(null));
    WS.applyFields(a, { chief_complaint: 'Жалобы' });
    answerConfirm(true); CONFIRMS.length = 0;
    const release = hold('write:19');
    const f1 = WS.finishVisit(a), f2 = WS.finishVisit(a);
    await tick(5);
    release();
    await Promise.all([f1, f2]);
    assert.equal(CONFIRMS.length, 1, 'подпись спросила ' + CONFIRMS.length + ' раз');
    assert.equal(LOG.filter((e) => e.kind === 'archive').length, 1);
    // второй щелчок ничего не делает — и не сохраняет второй черновик перед подписью
    assert.equal(LOG.filter((e) => e.kind === 'line' && e.id === 19 && !(e.values && e.values.status)).length, 1, 'второй щелчок «Завершить приём» сохранил черновик ещё раз');
});

test('12 (F7): открытие чистит код только у записей до ревью 2 (без dxSplit)', async () => {
    const ORVI = { code: 'J06.9', name: 'ОРВИ', type: 'main' };
    const marked = await opened(20, notesOf({ primary_diagnosis: 'J06.9 — ОРВИ<br>Текст' }, { diagnoses: [ORVI], dxSplit: 1 }));
    assert.equal(field(marked, 'primary_diagnosis').innerHTML, 'J06.9 — ОРВИ<br>Текст', 'текст записи ревью 2+ срезан при открытии');
    const old = await opened(21, notesOf({ primary_diagnosis: 'J06.9 — ОРВИ<br>Текст' }, { diagnoses: [ORVI] }));
    assert.equal(field(old, 'primary_diagnosis').innerHTML, 'Текст', 'код старой записи не убран');
    // черновик и подпись помечают запись: при следующем открытии строка врача не чистится
    put(old, 'primary_diagnosis', 'J06.9 — ОРВИ<br>Текст (шаблоном)');
    assert.ok(await WS.saveDraft(old, { silent: true }));
    assert.equal(parsed(21).dxSplit, 1, 'черновик не пометил запись ревью 2+');
    const again = await opened(21, null);
    assert.equal(field(again, 'primary_diagnosis').innerHTML, 'J06.9 — ОРВИ<br>Текст (шаблоном)', 'черновик ревью 2+ при открытии срезан');
    answerConfirm(true);
    const s = await opened(24, notesOf({ chief_complaint: 'Жалобы' }));
    await WS.signDocument(s);
    assert.equal(parsed(24).dxSplit, 1, 'подпись не пометила запись ревью 2+');
});

// ─── [U]: смена языка не теряет несохранённый текст ──────────────────────────
test('[U]: набранное и не сохранённое переживает перерисовку экрана (смена языка / здания)', async () => {
    const root = new El('div');
    const a = await opened(22, notesOf({ chief_complaint: 'СОХРАНЕНО' }), { container: root });
    put(a, 'chief_complaint', 'СОХРАНЕНО и НЕСОХРАНЁННОЕ');
    field(a, 'chief_complaint').dispatch('input');
    const b = await opened(22, null, { container: root });
    assert.equal(field(b, 'chief_complaint').innerHTML, 'СОХРАНЕНО и НЕСОХРАНЁННОЕ', 'несохранённый текст пропал');
    assert.ok(await WS.saveDraft(b, { silent: true }));
    assert.equal(parsed(22).current.chief_complaint, 'СОХРАНЕНО и НЕСОХРАНЁННОЕ');
    const c = await opened(22, null, { container: root });           // сохранено — дальше идёт запись сервера
    assert.equal(field(c, 'chief_complaint').innerHTML, 'СОХРАНЕНО и НЕСОХРАНЁННОЕ');
});

test('подписи ревью 4 — на трёх языках', async () => {
    const { STRINGS } = await import('../i18n-strings.js');
    for (const key of [
        'Документ подписан в другом окне. Ваш текст остался на экране — нажмите «Сохранить» ещё раз.',
        'Документ уже подписан в другом окне — обновите его и сохраните ещё раз.',
        'Не удалось загрузить документ.',
        'Повторить',
        'Подпись сохранена, но копия документа для печати не записалась в архив. Повторить запись сейчас?',
        'Подпись сохранена, но копия документа для печати в архив не записалась. Подпишите документ ещё раз или обратитесь к администратору.',
        'Сервер не ответил — проверьте и повторите.',
    ]) {
        const e = STRINGS[key];
        assert.ok(e, 'строки нет в словаре: ' + key);
        for (const lang of ['ru', 'uz', 'en']) assert.ok(e[lang], key + ': нет перевода ' + lang);
    }
});
