// CABINET_FIX_V1_R7 (2026-10-03) — РЕВЬЮ 7: ПОВТОР ПРАВКИ НЕ СТИРАЕТ ЧУЖОЕ
// (препарат, диагноз другого окна), НЕ ДВОИТ ДИАГНОЗ; ЧЕРНОВИКИ НЕСУТ МЕТКУ
// ВКЛАДКИ — ЧУЖИЕ НЕ КОПЯТСЯ И НЕ ТЕРЯЮТСЯ ПРИ ПЕРЕЧИТЫВАНИИ; «ВОЗОБНОВИТЬ»
// СПРАШИВАЕТ ПРО НЕСОХРАНЁННОЕ; ПОЗДНИЙ ОТВЕТ НЕ ВОЗВРАЩАЕТ СТАРУЮ КОПИЮ;
// ПОЗДНИЙ ОТКАЗ ПОДПИСИ — СЛОВАМИ.
//
// Вкладки браузера в одном процессе проверки различает метка вкладки
// (WS.__setTabIdForTests) — в браузере она своя у каждой загрузки страницы.
import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom, El, TOASTS, CONFIRMS, answerConfirm } from './cabinet-harness.mjs';
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
const HOLDNEXT = new Map();    // следующая запись строки ждёт ДО обработки
const HOLDREPLY = new Map();   // следующая запись строки обработана, ответ ждёт
const FAILNEXT = new Map();
const LOG = [];
let INSERT_ID = 900;
const hold = (map, key) => { let release; map.set(key, new Promise((r) => { release = r; })); return () => release(); };
const resp = (ok, status, payload) => ({ ok, status, json: async () => payload, headers: { getSetCookie: () => [] } });
globalThis.fetch = async (url, opts) => {
    const u = String(url);
    const body = JSON.parse((opts && opts.body) || '{}');
    const ok = (data) => resp(true, 200, { data });
    if (u.startsWith('/api/rpc/')) {
        if (u.endsWith('visit_document_archive')) LOG.push({ kind: 'archive', body });
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
            let answer = null;
            if (Object.prototype.hasOwnProperty.call(values, 'notes')) {
                const refusal = notesWriteRefusal(NOTES.has(id) ? NOTES.get(id) : null, values.notes, base);
                if (refusal) { LOG.push({ kind: '409', id, reason: refusal.reason }); answer = resp(false, 409, { error: { code: 'notes_conflict', reason: refusal.reason, message: refusal.message } }); }
                else NOTES.set(id, values.notes);
            }
            if (!answer) { LOG.push({ kind: 'line', id, base, values }); answer = ok(null); }
            if (HOLDREPLY.has(key)) { const p = HOLDREPLY.get(key); HOLDREPLY.delete(key); await p; }
            return answer;
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
const drafts = (id) => parsed(id).history.filter((e) => e.kind === 'draft');
const draftTexts = (id) => drafts(id).map((e) => e.fields.chief_complaint);

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
const typeIn = (ctx, k, v) => { put(ctx, k, v); field(ctx, k).dispatch('input'); };
const touch = (ctx) => ctx.container.dispatch('pointerdown');
const conflictsOf = (id) => LOG.filter((e) => e.kind === '409' && e.id === id).length;
// «другое окно» (своя метка вкладки) записало строку мимо этой вкладки
const otherWindowWrites = (id, text, extra = {}, tab = 'tab-OTHER') => {
    const o = JSON.parse(NOTES.get(id));
    o.current = { ...(o.current || {}), chief_complaint: text };
    o.history = [...(o.history || []).filter((e) => !(e.kind === 'draft' && e.tab === tab)), { kind: 'draft', savedAt: new Date(Date.now() - 1000).toISOString(), fields: { chief_complaint: text }, tab }];
    Object.assign(o, extra);
    NOTES.set(id, JSON.stringify(o));
};
// окно рецепта: строки — по полю названия; поля строки, кнопки — по подписи
const rxDialog = () => {
    const inputs = document.body.querySelectorAll('input');
    const by = (ph) => inputs.filter((i) => i.getAttribute('placeholder') === ph);
    return { names: by('напр. Метформин'), doses: by('напр. 500 мг'), buttons: document.body.querySelectorAll('button') };
};
const clickSave = async () => {
    const save = document.body.querySelectorAll('button').filter((b) => /Сохранить рецепт/.test(b.textContent)).pop();
    save.dispatch('click');
    await save._pending;
};
const closeDialogs = () => { for (const o of document.body.querySelectorAll('.modal')) o.remove(); };
WS.__setTabIdForTests('tab-ME');

// ─── п. 1: окно рецепта (весь список) — повтор после отказа ────────────────────
test('п. 1: окно рецепта: правка дозы после отказа — препарат другого окна остаётся', async () => {
    closeDialogs();
    const a = await opened(71, notesOf({ chief_complaint: 'Исходно' }, { prescriptions: [{ name: 'Парацетамол', dose: '500 мг' }] }));
    touch(a);
    otherWindowWrites(71, 'ДРУГОЕ', { prescriptions: [{ name: 'Парацетамол', dose: '500 мг' }, { name: 'Амоксициллин', dose: '1 г' }] });
    const c0 = conflictsOf(71);
    TOASTS.length = 0;
    WS.openPrescriptionDialog(a);
    const d = rxDialog();
    d.names[d.names.length - 1].value = 'Парацетамол';
    d.doses[d.doses.length - 1].value = '1000 мг';
    await clickSave();
    assert.equal(conflictsOf(71) - c0, 1, 'отказа не было — проверка ничего не проверяет');
    assert.deepEqual(parsed(71).prescriptions.map((p) => p.name + ' ' + p.dose), ['Парацетамол 1000 мг', 'Амоксициллин 1 г'], 'препарат другого окна стёрт');
    assert.ok(TOASTS.some((t) => /изменение применено/.test(t)), TOASTS.join(' | '));
});

test('п. 1: окно рецепта: удалённый и добавленный препарат после отказа — ровно эти правки, чужое цело', async () => {
    closeDialogs();
    const a = await opened(72, notesOf({ chief_complaint: 'Исходно' }, { prescriptions: [{ name: 'Парацетамол', dose: '500 мг' }, { name: 'Ибупрофен', dose: '200 мг' }] }));
    touch(a);
    otherWindowWrites(72, 'ДРУГОЕ', { prescriptions: [{ name: 'Амоксициллин', dose: '1 г' }, { name: 'Парацетамол', dose: '500 мг' }, { name: 'Ибупрофен', dose: '200 мг' }] });
    WS.openPrescriptionDialog(a);
    // убрать Ибупрофен (вторая строка окна), добавить Лоратадин
    const trash = document.body.querySelectorAll('button').filter((b) => b.getAttribute('title') === 'Убрать препарат');
    trash[trash.length - 1].dispatch('click');
    document.body.querySelectorAll('button').filter((b) => /Добавить препарат/.test(b.textContent)).pop().dispatch('click');
    const d = rxDialog();
    d.names[d.names.length - 1].value = 'Лоратадин';
    d.doses[d.doses.length - 1].value = '10 мг';
    // поля строк из окна стенд не переносит в value — заполнить, как рукой
    d.names[d.names.length - 2].value = 'Парацетамол'; d.doses[d.doses.length - 2].value = '500 мг';
    await clickSave();
    assert.deepEqual(parsed(72).prescriptions.map((p) => p.name), ['Амоксициллин', 'Парацетамол', 'Лоратадин'], 'не те правки после отказа');
});

test('п. 1: окно рецепта: препарат изменён и в другом окне, и здесь — не угадывать: «повторите», чужая версия цела', async () => {
    closeDialogs();
    const a = await opened(73, notesOf({ chief_complaint: 'Исходно' }, { prescriptions: [{ name: 'Парацетамол', dose: '500 мг' }] }));
    touch(a);
    otherWindowWrites(73, 'ДРУГОЕ', { prescriptions: [{ name: 'Парацетамол', dose: '750 мг' }] });
    TOASTS.length = 0;
    WS.openPrescriptionDialog(a);
    const d = rxDialog();
    d.names[d.names.length - 1].value = 'Парацетамол';
    d.doses[d.doses.length - 1].value = '1000 мг';
    await clickSave();
    assert.deepEqual(parsed(73).prescriptions.map((p) => p.dose), ['750 мг'], 'правка легла поверх правки другого окна');
    assert.ok(TOASTS.some((t) => /повторите действие/.test(t)), TOASTS.join(' | '));
    assert.ok(!TOASTS.some((t) => /изменение применено|Рецепт сохранён|Рецепт обновлён/.test(t)), 'успех при невыполненной правке: ' + TOASTS.join(' | '));
});

// ─── п. 2: «×» у «Диагноза» — только подтверждённые коды ──────────────────────
test('п. 2: «×» у «Диагноза» после отказа убирает только коды из вопроса, код другого окна остаётся', async () => {
    const a = await opened(74, notesOf({ chief_complaint: 'Исходно' }, { diagnoses: [{ code: 'J06.9', name: 'ОРВИ', type: 'main' }] }));
    touch(a);
    otherWindowWrites(74, 'ДРУГОЕ', { diagnoses: [{ code: 'J06.9', name: 'ОРВИ', type: 'main' }, { code: 'I10', name: 'Гипертензия', type: 'concomitant' }] });
    CONFIRMS.length = 0;
    answerConfirm(true);
    const c0 = conflictsOf(74);
    assert.equal(await WS.wsRemoveSection(a, 'diagnosis'), true);
    assert.equal(conflictsOf(74) - c0, 1);
    assert.ok(/J06\.9/.test(CONFIRMS.slice(-1)[0]) && !/I10/.test(CONFIRMS.slice(-1)[0]));
    assert.deepEqual(parsed(74).diagnoses.map((x) => x.code), ['I10'], 'удалён код, о котором врача не спрашивали');
});

// ─── п. 3: диагноз не двоится ─────────────────────────────────────────────────
test('п. 3: диагноз, уже добавленный другим окном, после отказа не двоится', async () => {
    const a = await opened(75, notesOf({ chief_complaint: 'Исходно' }));
    otherWindowWrites(75, 'ДРУГОЕ', { diagnoses: [{ code: 'J06.9', name: 'ОРВИ', type: 'main' }] });
    await WS.addDiagnosisEntry(a, { code: 'J06.9', name: 'ОРВИ', type: 'main' });
    assert.deepEqual(parsed(75).diagnoses.map((x) => x.code + ':' + x.type), ['J06.9:main']);
});

// ─── п. 4: метка вкладки на черновиках ───────────────────────────────────────
test('п. 4: две вкладки сохраняют по очереди — по одному черновику на вкладку, подпись убирает только свои', async () => {
    const a = await opened(76, notesOf({ chief_complaint: 'Исходно' }), { container: new El('div') });
    const b = await opened(76, null, { container: new El('div') });
    const save = async (ctx, tab, text) => {
        WS.__setTabIdForTests(tab); touch(ctx); put(ctx, 'chief_complaint', text);
        let ok = await WS.saveDraft(ctx, { silent: true }); if (!ok) ok = await WS.saveDraft(ctx, { silent: true });
        assert.ok(ok, 'не сохранилось: ' + text);
    };
    try {
        for (let round = 1; round <= 4; round++) { await save(a, 'tab-A', 'A' + round); await save(b, 'tab-B', 'B' + round); }
        assert.deepEqual(draftTexts(76), ['A4', 'B4'], 'черновики копятся');
        assert.deepEqual(drafts(76).map((e) => e.tab), ['tab-A', 'tab-B']);
        WS.__setTabIdForTests('tab-B'); touch(b);
        answerConfirm(true);
        await WS.signDocument(b);
        assert.deepEqual(parsed(76).history.map((e) => e.kind + ':' + (e.fields && e.fields.chief_complaint)), ['draft:A4', 'signed:B4'], 'подпись убрала чужой черновик или оставила свой');
    } finally { WS.__setTabIdForTests('tab-ME'); }
});

test('п. 4: черновик другой вкладки не теряется, если до следующего сохранения строку перечитали (смена строки)', async () => {
    const root = new El('div');
    const a = await opened(77, notesOf({ chief_complaint: 'Исходно' }), { container: root });
    put(a, 'chief_complaint', 'A1');
    otherWindowWrites(77, 'ЧУЖОЙ');
    TOASTS.length = 0;
    assert.equal(await WS.saveDraft(a, { silent: true }), false);
    assert.ok(TOASTS.some((t) => /Версия из другого окна сохранена в истории/.test(t)), TOASTS.join(' | '));
    await opened(78, notesOf({ chief_complaint: 'другая строка' }));
    const a2 = await opened(77, null, { container: root });
    put(a2, 'chief_complaint', 'A2');
    assert.ok(await WS.saveDraft(a2, { silent: true }));
    assert.deepEqual(draftTexts(77), ['ЧУЖОЙ', 'A2'], 'черновик другого окна стёрт после перечитывания');
});

test('п. 4: от одной чужой вкладки остаётся один (последний) черновик; без метки (до обновления) — как прежде', async () => {
    const X1 = { kind: 'draft', savedAt: '2026-10-03T08:00:00.000Z', fields: { chief_complaint: 'X1' }, tab: 'tab-X' };
    const X2 = { kind: 'draft', savedAt: '2026-10-03T08:05:00.000Z', fields: { chief_complaint: 'X2' }, tab: 'tab-X' };
    const OLD = { kind: 'draft', savedAt: '2026-10-01T08:00:00.000Z', fields: { chief_complaint: 'OLD' } };
    const a = await opened(79, notesOf({ chief_complaint: 'Исходно' }, { history: [OLD, X1, X2] }));
    put(a, 'chief_complaint', 'МОЙ');
    assert.ok(await WS.saveDraft(a, { silent: true }));
    assert.deepEqual(draftTexts(79), ['X2', 'МОЙ'], 'чужие черновики одной вкладки копятся или черновик до обновления не заменился');
    assert.equal(drafts(79).pop().tab, 'tab-ME', 'свой черновик без метки вкладки');
});

test('п. 4: чужой черновик, который вкладка уже знает, — при новом отказе (заметка медсестры) без слов о «версии из другого окна»', async () => {
    const a = await opened(83, notesOf({ chief_complaint: 'Исходно' }));
    otherWindowWrites(83, 'ЧУЖОЙ');
    put(a, 'chief_complaint', 'МОЙ-1');
    assert.equal(await WS.saveDraft(a, { silent: true }), false);   // узнала о чужом черновике
    assert.ok(await WS.saveDraft(a, { silent: true }));
    const o = JSON.parse(NOTES.get(83)); o.nurseNote = 'в/в'; NOTES.set(83, JSON.stringify(o));
    put(a, 'chief_complaint', 'МОЙ-2');
    TOASTS.length = 0;
    assert.equal(await WS.saveDraft(a, { silent: true }), false);
    assert.ok(!TOASTS.some((t) => /Версия из другого окна/.test(t)), 'знакомый чужой черновик назван новым: ' + TOASTS.join(' | '));
    assert.ok(await WS.saveDraft(a, { silent: true }));
    assert.deepEqual(draftTexts(83), ['ЧУЖОЙ', 'МОЙ-2']);
});

test('п. 4: черновик вкладки 3.15.0 (без метки), пришедший во время работы, — как в ревью 6: «из другого окна», следующее «Сохранить» его не стирает', async () => {
    const a = await opened(84, notesOf({ chief_complaint: 'Исходно' }));
    const o = JSON.parse(NOTES.get(84));
    o.history = [{ kind: 'draft', savedAt: new Date().toISOString(), fields: { chief_complaint: 'СТАРАЯ-ВКЛАДКА' } }];
    NOTES.set(84, JSON.stringify(o));
    put(a, 'chief_complaint', 'МОЙ');
    TOASTS.length = 0;
    assert.equal(await WS.saveDraft(a, { silent: true }), false);
    assert.ok(TOASTS.some((t) => /Версия из другого окна сохранена в истории/.test(t)), TOASTS.join(' | '));
    assert.ok(await WS.saveDraft(a, { silent: true }));
    assert.deepEqual(draftTexts(84), ['СТАРАЯ-ВКЛАДКА', 'МОЙ'], 'черновик вкладки 3.15.0 стёрт');
});

// ─── п. 5: «Возобновить» спрашивает про несохранённое ────────────────────────
test('п. 5: «Возобновить» при несохранённом тексте — спрашивает; «Нет» — текст на экране цел', async () => {
    const D = { kind: 'draft', savedAt: '2026-10-03T07:00:00.000Z', fields: { chief_complaint: 'ИЗ ЧЕРНОВИКА' }, tab: 'tab-ME' };
    const a = await opened(80, notesOf({ chief_complaint: 'Исходно' }, { history: [D] }));
    CONFIRMS.length = 0;
    WS.resumeDraft(a, D);   // ничего не набрано — без вопроса
    assert.equal(CONFIRMS.length, 0, 'спросила, хотя несохранённого нет');
    assert.equal(field(a, 'chief_complaint').innerHTML, 'ИЗ ЧЕРНОВИКА');
    assert.ok(await WS.saveDraft(a, { silent: true }));
    typeIn(a, 'chief_complaint', 'НАБРАНО');
    answerConfirm(false);
    WS.resumeDraft(a, D);
    assert.equal(CONFIRMS.length, 1, 'не спросила перед заменой несохранённого текста');
    assert.equal(field(a, 'chief_complaint').innerHTML, 'НАБРАНО', 'несохранённый текст заменён без согласия');
    answerConfirm(true);
    WS.resumeDraft(a, D);
    assert.equal(field(a, 'chief_complaint').innerHTML, 'ИЗ ЧЕРНОВИКА');
});

// ─── п. 6: поздние ответы после потолка ожидания ─────────────────────────────
test('п. 6: поздний успех старой записи после потолка не возвращает старую копию — следующее сохранение без лишнего отказа', async () => {
    WS.__setTimingForTests({ writeTimeoutMs: 50, pendingMaxMs: 120 });
    try {
        const a = await opened(81, notesOf({ chief_complaint: 'Исходно' }));
        put(a, 'chief_complaint', 'W1');
        const releaseReply = hold(HOLDREPLY, 'write:81');   // W1 записана, ответ задержан
        assert.equal(await WS.saveDraft(a, { silent: true }), false);
        await tick(250);                                    // потолок: замок снят
        put(a, 'chief_complaint', 'W2');
        assert.equal(await WS.saveDraft(a, { silent: true }), false, 'W2 со старой основой прошла');   // у строки уже W1 — отказ, записи перечитаны
        put(a, 'chief_complaint', 'W3');
        assert.ok(await WS.saveDraft(a, { silent: true }));
        releaseReply(); await tick(30);                     // поздний успех W1
        const c0 = conflictsOf(81);
        put(a, 'chief_complaint', 'W4');
        assert.ok(await WS.saveDraft(a, { silent: true }), 'после позднего ответа сохранение не прошло');
        assert.equal(conflictsOf(81) - c0, 0, 'поздний ответ вернул старую копию — лишний отказ');
        assert.equal(parsed(81).current.chief_complaint, 'W4');
    } finally { WS.__setTimingForTests({ writeTimeoutMs: 30000, pendingMaxMs: 150000 }); }
});

test('п. 6: поздний отказ подписи после потолка — врачу сказано, что документ не подписан', async () => {
    WS.__setTimingForTests({ signTimeoutMs: 50, pendingMaxMs: 120 });
    try {
        const a = await opened(82, notesOf({ chief_complaint: 'Жалобы' }));
        answerConfirm(true);
        const release = hold(HOLDNEXT, 'write:82');          // подпись ещё не обработана
        await WS.signDocument(a);
        await tick(250);                                     // потолок
        put(a, 'chief_complaint', 'Жалобы, позже');
        assert.ok(await WS.saveDraft(a, { silent: true }));  // у строки — новый черновик: подпись получит отказ
        TOASTS.length = 0;
        release(); await tick(30);
        assert.ok(TOASTS.some((t) => /не подписан/.test(t)), 'поздний отказ подписи — молча: ' + TOASTS.join(' | '));
        assert.ok(!parsed(82).history.some((e) => e.kind === 'signed'));
    } finally { WS.__setTimingForTests({ signTimeoutMs: 30000, pendingMaxMs: 150000 }); }
});

test('подписи ревью 7 — на трёх языках', async () => {
    const { STRINGS } = await import('../i18n-strings.js');
    for (const key of [
        'На экране есть несохранённый текст. Заменить его этим черновиком?',
        'Подпись так и не прошла: документ не подписан. Проверьте его и подпишите ещё раз.',
    ]) {
        const e = STRINGS[key];
        assert.ok(e, 'строки нет в словаре: ' + key);
        assert.ok(e.ru && e.uz && e.en, 'не на трёх языках: ' + key);
        assert.ok(!/[А-Яа-яЁё]/.test(e.en), 'en с кириллицей: ' + key);
        assert.ok(!/[А-Яа-яЁё]/.test(e.uz), 'uz не латиницей: ' + key);
    }
});
