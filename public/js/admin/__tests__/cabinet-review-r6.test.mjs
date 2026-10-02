// CABINET_FIX_V1_R6 (2026-10-03) — РЕВЬЮ 6: ВЕРСИЯ ДРУГОГО ОКНА ОСТАЁТСЯ В
// ИСТОРИИ; ЗАМЕТКА МЕДСЕСТРЫ-«ЧИСЛО» НЕ ТЕРЯЕТСЯ; ЗАМОК «ЖДЁМ ОТВЕТА» НЕ
// ВЕЧЕН; ФРАЗЫ СЕРВЕРА — НА ЯЗЫКЕ ЭКРАНА; ПРАВКА СПИСКОВ (ДИАГНОЗ, РЕЦЕПТ,
// УСЛУГА, ЗАПИСЬ ИСТОРИИ) ПЕРЕЖИВАЕТ ОТКАЗ «ДОКУМЕНТ ИЗМЕНИЛСЯ»; В КАБИНЕТЕ НЕТ
// ЭМОДЗИ.
//
// Фальшивый сервер держит то же правило, что /api/db: notesWriteRefusal из
// public/js/shared/cabinet-notes.js. Каждая запись кабинета обязана нести
// основу — это проверяется отдельно (правило совместимости сервера пропускает
// запись без основы по правилу ревью 4, и без этой проверки кабинет мог бы
// незаметно перестать её слать).
import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { installFakeDom, El, TOASTS, answerConfirm } from './cabinet-harness.mjs';
import { notesWriteRefusal, NOTES_BASE_KEY } from '../../shared/cabinet-notes.js';

const test = (name, fn) => nodeTest(name, { timeout: 20000 }, fn);

installFakeDom();
globalThis.NodeFilter = { SHOW_ELEMENT: 1 };
globalThis.DOMParser = class {
    parseFromString(s) {
        const inner = String(s).replace(/^<div id="[^"]+">/, '').replace(/<\/div>$/, '');
        return { getElementById: () => ({ innerHTML: inner }), createTreeWalker: () => ({ nextNode: () => null }) };
    }
};
globalThis.CustomEvent = class { constructor(type, o) { this.type = type; this.detail = o && o.detail; } };
globalThis.window.dispatchEvent = () => true;

// ─── фальшивый сервер ─────────────────────────────────────────────────────────
const NOTES = new Map();
const HOLDNEXT = new Map();   // следующая запись строки ждёт (только одна)
const FAILNEXT = new Map();   // следующая запись строки получает этот ответ
const FAILVISIT = { message: null };   // запись заключения в визит отказывает этими словами
const LOG = [];
let INSERT_ID = 900;
const holdNext = (key) => { let release; HOLDNEXT.set(key, new Promise((r) => { release = r; })); return () => release(); };
const resp = (ok, status, payload) => ({ ok, status, json: async () => payload, headers: { getSetCookie: () => [] } });
globalThis.fetch = async (url, opts) => {
    const u = String(url);
    const body = JSON.parse((opts && opts.body) || '{}');
    const ok = (data) => resp(true, 200, { data });
    if (u.startsWith('/api/rpc/')) {
        if (u.endsWith('visit_document_archive')) LOG.push({ kind: 'archive', body });
        if (u.endsWith('remove_own_visit_line')) LOG.push({ kind: 'rm-line', body });
        return ok({ id: 1 });
    }
    if (u === '/api/db') {
        const idF = (body.filters || []).find((f) => f.col === 'id');
        const id = idF && Number(idF.val);
        if (body.table === 'visit_services' && body.op === 'select') {
            if (/^services\(type/.test(String(body.columns))) return ok({ services: { type: 'consultation', service_types: { name: 'Консультации' }, departments: null } });
            if (/notes/.test(String(body.columns))) return ok(NOTES.has(id) ? { notes: NOTES.get(id) } : null);
            return ok([]);
        }
        if (body.table === 'visit_services' && body.op === 'insert') return ok({ id: ++INSERT_ID });
        if (body.table === 'visit_services' && body.op === 'update') {
            const key = 'write:' + id;
            if (HOLDNEXT.has(key)) { const p = HOLDNEXT.get(key); HOLDNEXT.delete(key); await p; }
            if (FAILNEXT.has(key)) { const f = FAILNEXT.get(key); FAILNEXT.delete(key); return resp(false, f.status, { error: f.error }); }
            const values = { ...(body.values || {}) };
            const base = values[NOTES_BASE_KEY];
            delete values[NOTES_BASE_KEY];
            if (Object.prototype.hasOwnProperty.call(values, 'notes')) {
                const refusal = notesWriteRefusal(NOTES.has(id) ? NOTES.get(id) : null, values.notes, base);
                if (refusal) { LOG.push({ kind: '409', id, reason: refusal.reason }); return resp(false, 409, { error: { code: 'notes_conflict', reason: refusal.reason, message: refusal.message } }); }
                NOTES.set(id, values.notes);
            }
            LOG.push({ kind: 'line', id, base, values });
            return ok(null);
        }
        if (body.table === 'visits' && body.op === 'update') {
            if (FAILVISIT.message) return resp(false, 400, { error: { code: 'bad_request', message: FAILVISIT.message } });
            LOG.push({ kind: 'visit', id, values: body.values });
            return ok(null);
        }
        return ok(body.op === 'select' && !body.single ? [] : null);
    }
    return ok(null);
};

const WS = await import('../views/service-workspace.js');
WS.__setTimingForTests({ retryBaseMs: 40, signTimeoutMs: 30000, writeTimeoutMs: 30000 });
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const notesOf = (current, extra = {}) => JSON.stringify({ __service_workspace_v1: 1, current, history: [], ...extra });
const parsed = (id) => JSON.parse(NOTES.get(id));
const kinds = (id) => parsed(id).history.map((e) => e.kind);
const draftTexts = (id) => parsed(id).history.filter((e) => e.kind === 'draft').map((e) => e.fields.chief_complaint);

function cabinet(id, notes = notesOf(null), { container = new El('div'), type = 'conclusion' } = {}) {
    const ctx = { container, visitServiceId: id, visitId: 100 + id, patient: { id, lastName: 'Пациент' + id, firstName: 'Тест', mrn: 'P-' + id, __service: { id, name: 'Услуга ' + id, doctorName: 'Каримов Алишер', doctorSpec: 'Терапевт' } } };
    if (notes != null) NOTES.set(id, notes);
    WS.activateWorkspace(ctx);
    container.children = [];
    container.appendChild(WS.soapForm(ctx));
    const wrap = container.querySelector('[data-blank-wrap]');
    if (wrap) wrap.style.display = '';
    WS.setDocType(ctx, type);
    return ctx;
}
async function opened(id, notes, o) { const ctx = cabinet(id, notes, o); await WS.hydrateLine(ctx); return ctx; }
const field = (ctx, k) => ctx.container.querySelector('.a4-input[data-field="' + k + '"]');
const put = (ctx, k, v) => { field(ctx, k).innerHTML = v; };
const touch = (ctx) => ctx.container.dispatch('pointerdown');
// «другое окно» записало строку мимо этой вкладки
const otherWindowWrites = (id, text, extra = {}) => {
    const o = JSON.parse(NOTES.get(id));
    o.current = { ...(o.current || {}), chief_complaint: text };
    o.history = [...(o.history || []).filter((e) => e.kind !== 'draft'), { kind: 'draft', savedAt: new Date(Date.now() - 1000).toISOString(), fields: { chief_complaint: text } }];
    Object.assign(o, extra);
    NOTES.set(id, JSON.stringify(o));
};

// ─── A: основа — в каждой записи ─────────────────────────────────────────────
test('каждая запись кабинета несёт основу (черновик, подпись, диагноз, удаление)', async () => {
    LOG.length = 0;
    const a = await opened(20, notesOf({ chief_complaint: 'Исходно' }));
    put(a, 'chief_complaint', 'Жалобы');
    assert.ok(await WS.saveDraft(a, { silent: true }));
    await WS.addDiagnosisEntry(a, { code: 'J06.9', name: 'ОРВИ', type: 'main' });
    answerConfirm(true);
    await WS.signDocument(a);
    const writes = LOG.filter((e) => e.kind === 'line' && e.id === 20);
    assert.ok(writes.length >= 3, 'записей меньше, чем ожидалось: ' + writes.length);
    for (const w of writes) assert.equal(typeof w.base, 'string', 'запись без основы: ' + JSON.stringify(Object.keys(w.values)));
});

// ─── п. 2: две вкладки ────────────────────────────────────────────────────────
test('п. 2: две вкладки — версия другой вкладки остаётся в истории, второе «Сохранить» её не стирает; подпись её не убирает', async () => {
    const a = await opened(21, notesOf({ chief_complaint: 'Исходно' }), { container: new El('div') });
    const b = await opened(21, null, { container: new El('div') });
    touch(a);
    put(a, 'chief_complaint', 'ТЕКСТ-A');
    assert.ok(await WS.saveDraft(a, { silent: true }));
    touch(b);
    put(b, 'chief_complaint', 'ТЕКСТ-B');
    TOASTS.length = 0;
    assert.equal(await WS.saveDraft(b, { silent: true }), false);
    assert.ok(TOASTS.some((t) => /Ваш текст остался на экране.*Версия из другого окна сохранена в истории/.test(t)), TOASTS.join(' | '));
    assert.equal(field(b, 'chief_complaint').innerHTML, 'ТЕКСТ-B');
    assert.ok(await WS.saveDraft(b, { silent: true }));
    assert.deepEqual(draftTexts(21), ['ТЕКСТ-A', 'ТЕКСТ-B'], 'черновик вкладки A стёрт вторым «Сохранить» вкладки B');
    assert.equal(parsed(21).current.chief_complaint, 'ТЕКСТ-B');
    // свой следующий черновик вкладка B по-прежнему заменяет, чужой — нет
    put(b, 'chief_complaint', 'ТЕКСТ-B2');
    assert.ok(await WS.saveDraft(b, { silent: true }));
    assert.deepEqual(draftTexts(21), ['ТЕКСТ-A', 'ТЕКСТ-B2']);
    // подпись убирает свои черновики, а версию другого окна — нет
    answerConfirm(true);
    await WS.signDocument(b);
    assert.deepEqual(kinds(21), ['draft', 'signed']);
    assert.deepEqual(draftTexts(21), ['ТЕКСТ-A']);
});

test('п. 2: документ изменился без чужого черновика (заметка медсестры) — без слов о «версии из другого окна»', async () => {
    const a = await opened(22, notesOf({ chief_complaint: 'Исходно' }));
    const o = JSON.parse(NOTES.get(22)); o.nurseNote = 'в/в'; NOTES.set(22, JSON.stringify(o));
    put(a, 'chief_complaint', 'Жалобы');
    TOASTS.length = 0;
    assert.equal(await WS.saveDraft(a, { silent: true }), false);
    assert.ok(TOASTS.some((t) => /Документ изменился/.test(t)), TOASTS.join(' | '));
    assert.ok(!TOASTS.some((t) => /Версия из другого окна/.test(t)), TOASTS.join(' | '));
    assert.ok(await WS.saveDraft(a, { silent: true }));
    assert.equal(parsed(22).nurseNote, 'в/в');
    assert.deepEqual(draftTexts(22), ['Жалобы']);
    // свой прежний черновик (записанный этой вкладкой) — не «версия из другого окна»:
    // после новой заметки медсестры он заменяется, как всегда, а не копится
    const o2 = JSON.parse(NOTES.get(22)); o2.nurseNote = 'в/в, повторно'; NOTES.set(22, JSON.stringify(o2));
    put(a, 'chief_complaint', 'Жалобы 2');
    TOASTS.length = 0;
    assert.equal(await WS.saveDraft(a, { silent: true }), false);
    assert.ok(!TOASTS.some((t) => /Версия из другого окна/.test(t)), 'свой черновик назван версией другого окна: ' + TOASTS.join(' | '));
    assert.ok(await WS.saveDraft(a, { silent: true }));
    assert.deepEqual(draftTexts(22), ['Жалобы 2'], 'свой прежний черновик остался как «чужой»');
});

// ─── п. 3: заметка медсестры — корректный JSON ───────────────────────────────
test('п. 3: заметка медсестры «37.5» (и любой JSON не кабинета) не теряется при первом сохранении кабинета', async () => {
    for (const [id, note] of [[23, '37.5'], [33, '{"t":1}'], [43, 'true'], [53, '[1,2]']]) {
        const ctx = await opened(id, note);
        put(ctx, 'chief_complaint', 'Жалобы');
        assert.ok(await WS.saveDraft(ctx, { silent: true }));
        assert.equal(parsed(id).nurseNote, note, 'заметка ' + note + ' потеряна');
    }
});

// ─── п. 4: замок «ждём ответа» — не вечный ───────────────────────────────────
test('п. 4: запись без ответа запирает строку не навсегда; поздний отказ после снятия замка ничего не стирает и не пугает', async () => {
    WS.__setTimingForTests({ writeTimeoutMs: 50, pendingMaxMs: 150 });
    try {
        const a = await opened(24, notesOf({ chief_complaint: 'Исходно' }));
        put(a, 'chief_complaint', 'ПЕРВОЕ');
        const release = holdNext('write:24');
        assert.equal(await WS.saveDraft(a, { silent: true }), false);
        assert.ok(WS.lineWritePending(24));
        TOASTS.length = 0;
        await tick(300);
        assert.equal(WS.lineWritePending(24), false, 'строка заперта до перезагрузки');
        assert.ok(TOASTS.some((t) => /так и не ответил/.test(t)), TOASTS.join(' | '));
        put(a, 'chief_complaint', 'ВТОРОЕ');
        assert.ok(await WS.saveDraft(a, { silent: true }), 'после снятия замка строка не пишется');
        assert.equal(parsed(24).current.chief_complaint, 'ВТОРОЕ');
        TOASTS.length = 0;
        release(); await tick(30);
        assert.equal(parsed(24).current.chief_complaint, 'ВТОРОЕ', 'поздний ответ стёр новое');
        assert.ok(!TOASTS.some((t) => /Документ изменился|Не удалось/.test(t)), 'поздний отказ после снятия замка: ' + TOASTS.join(' | '));
        assert.equal(field(a, 'chief_complaint').innerHTML, 'ВТОРОЕ');
    } finally { WS.__setTimingForTests({ writeTimeoutMs: 30000, pendingMaxMs: 150000 }); }
});

// ─── п. 5: фразы сервера — на языке экрана ───────────────────────────────────
test('п. 5: 413 и отказ сервера на узбекском экране — по-узбекски (снимки кабинет называет сам)', async () => {
    const { setLang } = await import('../i18n.js');
    const { STRINGS } = await import('../i18n-strings.js');
    const a = await opened(25, notesOf({ chief_complaint: 'Исходно' }));
    put(a, 'chief_complaint', 'Жалобы');
    const shown = [];
    setLang('uz');
    try {
        FAILNEXT.set('write:25', { status: 413, error: { code: 'too_large', message: 'Запрос слишком большой для сохранения (больше 8 МБ) — сократите данные и повторите.' } });
        TOASTS.length = 0;
        assert.equal(await WS.saveDraft(a, { silent: true }), false);
        shown.push(...TOASTS);
        assert.ok(TOASTS.some((t) => t.includes(STRINGS['Документ слишком большой для сохранения (больше 8 МБ) — уберите часть снимков или замените их снимками поменьше и сохраните снова.'].uz)), TOASTS.join(' | '));
        FAILNEXT.set('write:25', { status: 400, error: { code: 'bad_request', message: 'Записи строки не прочитаны — правка не выполнена.' } });
        TOASTS.length = 0;
        assert.equal(await WS.saveDraft(a, { silent: true }), false);
        shown.push(...TOASTS);
        assert.ok(TOASTS.some((t) => t.includes(STRINGS['Записи строки не прочитаны — правка не выполнена.'].uz)), TOASTS.join(' | '));
    } finally { setLang('ru'); }
    for (const t of shown) assert.ok(!/[А-Яа-яЁё]/.test(t), 'на узбекском экране — по-русски: ' + t);
});

// ─── п. 6: правка списков переживает «документ изменился» ────────────────────
test('п. 6: диагноз, рецепт, услуга, удаление записи — когда документ изменился в другом окне, правка ложится в новую версию', async () => {
    const a = await opened(26, notesOf({ chief_complaint: 'Исходно' }, { prescriptions: [{ name: 'Парацетамол' }, { name: 'Ибупрофен' }] }));
    const conflicts = () => LOG.filter((e) => e.kind === '409' && e.id === 26).length;
    // диагноз
    otherWindowWrites(26, 'ДРУГОЕ-1');
    TOASTS.length = 0;
    let c0 = conflicts();
    await WS.addDiagnosisEntry(a, { code: 'J06.9', name: 'ОРВИ', type: 'main' });
    assert.equal(conflicts() - c0, 1, 'отказа не было — проверка ничего не проверяет');
    assert.deepEqual(parsed(26).diagnoses.map((d) => d.code), ['J06.9'], 'диагноз пропал после отказа');
    assert.equal(parsed(26).current.chief_complaint, 'ДРУГОЕ-1', 'версия другого окна стёрта');
    assert.ok(!TOASTS.some((t) => /нажмите «Сохранить» ещё раз/.test(t)), TOASTS.join(' | '));
    assert.ok(TOASTS.some((t) => /изменение применено/.test(t)), TOASTS.join(' | '));
    // удаление диагноза — тот же, а не по номеру
    otherWindowWrites(26, 'ДРУГОЕ-2', { diagnoses: [{ code: 'I10', name: 'Гипертензия', type: 'concomitant' }, ...parsed(26).diagnoses] });
    c0 = conflicts();
    await WS.removeDiagnosisEntry(a, 0);   // на экране этой вкладки 0 — это J06.9
    assert.equal(conflicts() - c0, 1);
    assert.deepEqual(parsed(26).diagnoses.map((d) => d.code), ['I10'], 'удалён не тот диагноз');
    // рецепт
    otherWindowWrites(26, 'ДРУГОЕ-3', { prescriptions: [{ name: 'Амоксициллин' }, ...parsed(26).prescriptions] });
    c0 = conflicts();
    answerConfirm(true);
    await WS.removePrescriptionEntry(a, 1);   // на экране этой вкладки 1 — Ибупрофен
    assert.equal(conflicts() - c0, 1);
    assert.deepEqual(parsed(26).prescriptions.map((p) => p.name), ['Амоксициллин', 'Парацетамол'], 'удалён не тот препарат');
    // своя услуга
    otherWindowWrites(26, 'ДРУГОЕ-4');
    c0 = conflicts();
    await WS.addOwnService(a, { id: 7, name: 'Общий анализ крови', price: 50000 }, null);
    assert.equal(conflicts() - c0, 1);
    assert.deepEqual((parsed(26).services || []).map((s) => s.name), ['Общий анализ крови'], 'услуга пропала из приёма после отказа');
    // запись истории
    const R = { kind: 'referral', savedAt: '2026-10-03T08:00:00.000Z', service: { name: 'R' } };
    otherWindowWrites(26, 'ДРУГОЕ-5', { history: [...parsed(26).history, R] });
    await WS.hydrateLine(a);
    otherWindowWrites(26, 'ДРУГОЕ-6', { history: [...parsed(26).history] });
    c0 = conflicts();
    await WS.deleteHistoryEntry(a, R);
    assert.equal(conflicts() - c0, 1);
    assert.ok(!parsed(26).history.some((e) => e.kind === 'referral'), 'запись не удалена после отказа');
    assert.equal(parsed(26).current.chief_complaint, 'ДРУГОЕ-6');
});

test('п. 6: правка препарата в окне рецепта, «×» у «Диагноза», снятая своя услуга — после отказа ложатся в новую версию', async () => {
    const a = await opened(28, notesOf({ chief_complaint: 'Исходно' }, {
        prescriptions: [{ name: 'Парацетамол', dose: '500 мг' }, { name: 'Ибупрофен', dose: '200 мг' }],
        diagnoses: [{ code: 'J06.9', name: 'ОРВИ', type: 'main' }],
        services: [{ name: 'Общий анализ крови', price: 50000, vsId: 77, serviceId: 7 }],
    }));
    touch(a);
    const conflicts = () => LOG.filter((e) => e.kind === '409' && e.id === 28).length;
    // окно рецепта: правка дозы Ибупрофена (на экране этой вкладки — №1)
    otherWindowWrites(28, 'ДРУГОЕ-1', { prescriptions: [{ name: 'Амоксициллин', dose: '1 г' }, ...parsed(28).prescriptions] });
    let c0 = conflicts();
    WS.openPrescriptionDialog(a, 1);
    const dose = document.body.querySelectorAll('input').filter((i) => i.getAttribute('placeholder') === 'напр. 500 мг').pop();
    assert.ok(dose, 'окно рецепта не открылось');
    // стенд не переносит value из h() в свойство — поля строки заполняются как рукой врача
    document.body.querySelectorAll('input').filter((i) => i.getAttribute('placeholder') === 'напр. Метформин').pop().value = 'Ибупрофен';
    dose.value = '400 мг';
    const save = document.body.querySelectorAll('button').filter((b) => /Сохранить рецепт/.test(b.textContent)).pop();
    save.dispatch('click');
    await save._pending;
    assert.equal(conflicts() - c0, 1, 'отказа не было — проверка ничего не проверяет');
    assert.deepEqual(parsed(28).prescriptions.map((p) => p.name + ' ' + p.dose), ['Амоксициллин 1 г', 'Парацетамол 500 мг', 'Ибупрофен 400 мг'], 'правка препарата пропала или легла не туда');
    // «×» у «Диагноза» с кодом — коды убираются и из новой версии
    otherWindowWrites(28, 'ДРУГОЕ-2');
    c0 = conflicts();
    answerConfirm(true);
    assert.equal(await WS.wsRemoveSection(a, 'diagnosis'), true);
    assert.equal(conflicts() - c0, 1);
    assert.deepEqual(parsed(28).diagnoses, [], 'коды остались после отказа');
    assert.equal(parsed(28).current.chief_complaint, 'ДРУГОЕ-2');
    // снятая своя услуга (строка визита уже снята сервером) — пункт уходит и из новой версии
    otherWindowWrites(28, 'ДРУГОЕ-3');
    c0 = conflicts();
    await WS.removeOwnServiceEntry(a, 0);
    assert.equal(conflicts() - c0, 1);
    assert.deepEqual(parsed(28).services, [], 'пункт снятой услуги остался в приёме');
});

test('п. 5: заключение, не записанное в визит, — словами экрана', async () => {
    const { setLang } = await import('../i18n.js');
    const a = await opened(29, notesOf({ chief_complaint: 'Жалобы', conclusion_text: 'Здоров' }));
    FAILVISIT.message = 'Записи строки не прочитаны — правка не выполнена.';
    answerConfirm(true);
    setLang('uz');
    let shown = [];
    try { TOASTS.length = 0; await WS.signDocument(a); shown = TOASTS.slice(); } finally { setLang('ru'); FAILVISIT.message = null; }
    const { STRINGS } = await import('../i18n-strings.js');
    assert.ok(shown.some((x) => x.includes(STRINGS['Записи строки не прочитаны — правка не выполнена.'].uz)), 'заключение: ' + shown.join(' | '));
    for (const x of shown) assert.ok(!/Записи строки не прочитаны/.test(x), 'фраза сервера не переведена: ' + x);
});

test('п. 6: правка, которую повторить нельзя (диагноз уже убран в другом окне), — врачу сказано, что делать', async () => {
    const a = await opened(27, notesOf({ chief_complaint: 'Исходно' }, { diagnoses: [{ code: 'J06.9', name: 'ОРВИ', type: 'main' }] }));
    const o = JSON.parse(NOTES.get(27)); o.diagnoses = []; o.current = { chief_complaint: 'ДРУГОЕ' }; NOTES.set(27, JSON.stringify(o));
    TOASTS.length = 0;
    await WS.removeDiagnosisEntry(a, 0);
    assert.deepEqual(parsed(27).diagnoses, []);
    assert.equal(parsed(27).current.chief_complaint, 'ДРУГОЕ');
    assert.ok(TOASTS.some((t) => /повторите действие/.test(t)), TOASTS.join(' | '));
});

// ─── п. 8: эмодзи ─────────────────────────────────────────────────────────────
test('п. 8: в кабинете врача нет эмодзи (кнопка «Ссылка» — иконка набора)', () => {
    const src = fs.readFileSync(new URL('../views/service-workspace.js', import.meta.url), 'utf8');
    const code = src.split('\n').map((l) => l.replace(/^\s*(\/\/|\*|\/\*).*$/, '')).join('\n');
    const hit = code.match(/\p{Extended_Pictographic}/u);
    assert.equal(hit, null, 'эмодзи «' + (hit && hit[0]) + '» в кабинете — иконки берутся из набора');
    assert.match(src, /fb\('Ссылка', Icon\('Link'/);
});

test('подписи ревью 6 — на трёх языках', async () => {
    const { STRINGS } = await import('../i18n-strings.js');
    for (const key of [
        'Версия из другого окна сохранена в истории.',
        'Черновик из другого окна',
        'Сервер так и не ответил на прошлое сохранение — сохранять снова можно. Если то сохранение всё же дойдёт, оно ничего не перезапишет.',
        'Документ изменился, пока шло сохранение — изменение применено к новой версии.',
        'Документ изменился, пока шло сохранение. Список обновлён — повторите действие, если оно ещё нужно.',
        'Запрос слишком большой для сохранения (больше 8 МБ) — сократите данные и повторите.',
    ]) {
        const e = STRINGS[key];
        assert.ok(e, 'строки нет в словаре: ' + key);
        assert.ok(e.ru && e.uz && e.en, 'не на трёх языках: ' + key);
        assert.ok(!/[А-Яа-яЁё]/.test(e.en), 'en с кириллицей: ' + key);
        assert.ok(!/[А-Яа-яЁё]/.test(e.uz), 'uz не латиницей: ' + key);
    }
});
