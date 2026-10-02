// CABINET_FIX_V1_R8 (2026-10-03) — РЕВЬЮ 8: ОКНО РЕЦЕПТА ПИШЕТ ТОЛЬКО СВОИ
// ПРАВКИ — И ПЕРВЫМ «СОХРАНИТЬ», И ВТОРЫМ (после «повторите» окно показывает
// новую версию; один препарат — по содержимому, не по номеру); ЧЕРНОВИКИ
// ПРЕЖНИХ ЗАГРУЗОК ЭТОЙ ЖЕ ВКЛАДКИ (F5) — СВОИ.
//
// Проверка приёмки — пробы проверяющего (verify-cabinet-r7/r7-probe.test.mjs:
// PROBE-1, PROBE-2, PROBE-3) с ожидаемым исходом. Перезагрузку страницы в одном
// процессе проверки изображает WS.__reloadPageForTests (pagehide + новая метка),
// другую вкладку — WS.__setTabIdForTests.
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

// sessionStorage вкладки (переживает перезагрузку страницы, у другой вкладки — свой)
const SESSION = new Map();
globalThis.sessionStorage = { getItem: (k) => (SESSION.has(k) ? SESSION.get(k) : null), setItem: (k, v) => { SESSION.set(k, String(v)); }, removeItem: (k) => { SESSION.delete(k); } };
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

// ─── п. 1: окно рецепта — каждая запись через правки окна ─────────────────────
const rxOf = (id) => (parsed(id).prescriptions || []).map((p) => p.name + ' ' + p.dose);
const rowValues = () => { const d = rxDialog(); return d.names.map((n, i) => n.value + ' ' + (d.doses[i] ? d.doses[i].value : '')); };

test('п. 1 (PROBE-1): весь список — отказ «повторите», окно показывает новую версию; второе «Сохранить» ничего не стирает', async () => {
    closeDialogs();
    const a = await opened(91, notesOf({ chief_complaint: 'X' }, { prescriptions: [{ name: 'Парацетамол', dose: '500 мг' }, { name: 'Ибупрофен', dose: '200 мг' }] }));
    touch(a);
    WS.openPrescriptionDialog(a);
    let d = rxDialog();
    d.names[0].value = 'Парацетамол'; d.doses[0].value = '1000 мг';
    d.names[1].value = 'Ибупрофен'; d.doses[1].value = '200 мг';
    otherWindowWrites(91, 'ДРУГОЕ', { prescriptions: [{ name: 'Парацетамол', dose: '750 мг' }, { name: 'Ибупрофен', dose: '200 мг' }, { name: 'Амоксициллин', dose: '1 г' }] });
    TOASTS.length = 0;
    await clickSave();
    assert.ok(TOASTS.some((t) => /повторите действие/.test(t)), TOASTS.join(' | '));
    assert.deepEqual(rxOf(91), ['Парацетамол 750 мг', 'Ибупрофен 200 мг', 'Амоксициллин 1 г']);
    assert.equal(document.body.querySelectorAll('.modal').length, 1, 'окно рецепта закрылось');
    assert.deepEqual(rowValues(), ['Парацетамол 750 мг', 'Ибупрофен 200 мг', 'Амоксициллин 1 г'], 'окно не показывает новую версию');
    // второе «Сохранить» без правок — ничего не стирает
    TOASTS.length = 0;
    await clickSave();
    assert.deepEqual(rxOf(91), ['Парацетамол 750 мг', 'Ибупрофен 200 мг', 'Амоксициллин 1 г'], 'второе «Сохранить» стёрло правку другого окна');
    // врач повторяет правку в обновлённом окне
    WS.openPrescriptionDialog(a);
    d = rxDialog();
    const n = d.names.length;
    d.names[n - 3].value = 'Парацетамол'; d.doses[n - 3].value = '1000 мг';
    d.names[n - 2].value = 'Ибупрофен'; d.doses[n - 2].value = '200 мг';
    d.names[n - 1].value = 'Амоксициллин'; d.doses[n - 1].value = '1 г';
    await clickSave();
    assert.deepEqual(rxOf(91), ['Парацетамол 1000 мг', 'Ибупрофен 200 мг', 'Амоксициллин 1 г']);
    closeDialogs();
});

test('п. 1 (PROBE-2): один препарат — по содержимому, не по номеру: отказ «повторите», окно показывает его новую версию; второе «Сохранить» не двоит и не теряет', async () => {
    closeDialogs();
    const a = await opened(92, notesOf({ chief_complaint: 'X' }, { prescriptions: [{ name: 'A', dose: '1' }, { name: 'B', dose: '1' }, { name: 'C', dose: '1' }] }));
    touch(a);
    WS.openPrescriptionDialog(a, 2);
    let d = rxDialog();
    d.names[d.names.length - 1].value = 'C'; d.doses[d.doses.length - 1].value = '2';
    otherWindowWrites(92, 'ДРУГОЕ', { prescriptions: [{ name: 'B', dose: '1' }, { name: 'C', dose: '5' }, { name: 'D', dose: '1' }] });
    TOASTS.length = 0;
    await clickSave();
    assert.ok(TOASTS.some((t) => /повторите действие/.test(t)), TOASTS.join(' | '));
    assert.deepEqual(rxOf(92), ['B 1', 'C 5', 'D 1']);
    assert.deepEqual(rowValues().slice(-1), ['C 5'], 'окно не показывает новую версию препарата');
    TOASTS.length = 0;
    await clickSave();   // без правок
    assert.deepEqual(rxOf(92), ['B 1', 'C 5', 'D 1'], 'второе «Сохранить» потеряло D или задвоило C');
    // правка заново — ложится на C, а не на третий по номеру
    WS.openPrescriptionDialog(a, 1);
    d = rxDialog();
    d.names[d.names.length - 1].value = 'C'; d.doses[d.doses.length - 1].value = '2';
    await clickSave();
    assert.deepEqual(rxOf(92), ['B 1', 'C 2', 'D 1']);
    closeDialogs();
});

test('п. 1: и без отказа окно не пишет свой устаревший список поверх новой версии (записи строки перечитаны другой правкой)', async () => {
    closeDialogs();
    const a = await opened(94, notesOf({ chief_complaint: 'X' }, { prescriptions: [{ name: 'A', dose: '1' }] }));
    touch(a);
    WS.openPrescriptionDialog(a);   // окно открыто со списком [A]
    otherWindowWrites(94, 'ДРУГОЕ', { prescriptions: [{ name: 'A', dose: '1' }, { name: 'B', dose: '1' }] });
    // другая правка этой вкладки получила отказ и перечитала записи: у вкладки — новая версия, основа текущая
    put(a, 'chief_complaint', 'X2');
    assert.equal(await WS.saveDraft(a, { silent: true }), false);
    assert.ok(await WS.saveDraft(a, { silent: true }));
    const c0 = conflictsOf(94);
    const d = rxDialog();
    d.names[d.names.length - 1].value = 'A'; d.doses[d.doses.length - 1].value = '2';
    await clickSave();
    assert.equal(conflictsOf(94) - c0, 0, 'отказ был — проверка не о том');
    assert.deepEqual(rxOf(94), ['A 2', 'B 1'], 'устаревший список окна лёг поверх новой версии');
    closeDialogs();
});

test('п. 1: правка одного препарата после сдвига списка ложится на него, а не на тот же номер', async () => {
    closeDialogs();
    const a = await opened(95, notesOf({ chief_complaint: 'X' }, { prescriptions: [{ name: 'A', dose: '1' }, { name: 'B', dose: '1' }, { name: 'C', dose: '1' }] }));
    touch(a);
    WS.openPrescriptionDialog(a, 2);   // C
    otherWindowWrites(95, 'ДРУГОЕ', { prescriptions: [{ name: 'B', dose: '1' }, { name: 'C', dose: '1' }, { name: 'D', dose: '1' }] });
    put(a, 'chief_complaint', 'X2');
    assert.equal(await WS.saveDraft(a, { silent: true }), false);   // перечитала: [B, C, D]
    assert.ok(await WS.saveDraft(a, { silent: true }));
    const d = rxDialog();
    d.names[d.names.length - 1].value = 'C'; d.doses[d.doses.length - 1].value = '2';
    await clickSave();
    assert.deepEqual(rxOf(95), ['B 1', 'C 2', 'D 1'], 'правка легла по номеру');
    closeDialogs();
});

// ─── п. 2: свои черновики после перезагрузки страницы (F5) ────────────────────
test('п. 2 (PROBE-3): одна вкладка, три загрузки страницы — черновики прежних загрузок свои; подпись их убирает', async () => {
    SESSION.clear();
    WS.__reloadPageForTests('load-1');
    NOTES.set(93, notesOf({ chief_complaint: 'Исходно' }));
    try {
        for (const [i, id] of ['load-1', 'load-2', 'load-3'].entries()) {
            if (i) WS.__reloadPageForTests(id);
            const c = await opened(93, null, { container: new El('div') });
            touch(c); typeIn(c, 'chief_complaint', 'L' + (i + 1));
            assert.ok(await WS.saveDraft(c, { silent: true }), 'save ' + id);
        }
        assert.deepEqual(draftTexts(93), ['L3'], 'черновики прежних загрузок этой вкладки копятся как чужие');
        WS.__reloadPageForTests('load-4');
        const c4 = await opened(93, null, { container: new El('div') });
        touch(c4); typeIn(c4, 'chief_complaint', 'L4');
        answerConfirm(true);
        await WS.signDocument(c4);
        assert.deepEqual(parsed(93).history.map((e) => e.kind), ['signed'], 'после подписи остались черновики прежних загрузок');
    } finally { WS.__setTabIdForTests('tab-ME'); }
});

test('п. 2: другая вкладка (не перезагрузка) — её черновик чужой и остаётся; дублированная вкладка не делает живые вкладки «своими» друг другу', async () => {
    SESSION.clear();
    WS.__reloadPageForTests('A0');
    NOTES.set(96, notesOf({ chief_complaint: 'Исходно' }));
    const a0 = await opened(96, null, { container: new El('div') });
    touch(a0); typeIn(a0, 'chief_complaint', 'A0');
    assert.ok(await WS.saveDraft(a0, { silent: true }));
    // вкладка A перезагружена: живая страница A1; её список прежних загрузок — [A0]
    WS.__reloadPageForTests('A1');
    // «Дублировать»: браузер копирует sessionStorage — у копии тот же список [A0], страница своя (D1)
    const a = await opened(96, null, { container: new El('div') });
    const dup = await opened(96, null, { container: new El('div') });
    const save = async (ctx, id, text) => {
        WS.__setTabIdForTests(id); touch(ctx); put(ctx, 'chief_complaint', text);
        let ok = await WS.saveDraft(ctx, { silent: true }); if (!ok) ok = await WS.saveDraft(ctx, { silent: true });
        assert.ok(ok, 'не сохранилось: ' + text);
    };
    try {
        await save(a, 'A1', 'A1');
        assert.deepEqual(draftTexts(96), ['A1'], 'черновик прежней загрузки A0 не заменён своей вкладкой');
        await save(dup, 'D1', 'D1');
        await save(a, 'A1', 'A1b');
        assert.deepEqual(draftTexts(96), ['D1', 'A1b'], 'живые вкладки (оригинал и копия) стирают черновики друг друга');
    } finally { WS.__setTabIdForTests('tab-ME'); }
});

test('п. 2: sessionStorage недоступен — без ошибок, как прежде (прежняя загрузка — чужая)', async () => {
    const saved = globalThis.sessionStorage;
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get() { throw new Error('SecurityError'); } });
    try {
        WS.__reloadPageForTests('S1');
        NOTES.set(97, notesOf({ chief_complaint: 'Исходно' }));
        const c1 = await opened(97, null, { container: new El('div') });
        touch(c1); typeIn(c1, 'chief_complaint', 'S1');
        assert.ok(await WS.saveDraft(c1, { silent: true }));
        WS.__reloadPageForTests('S2');
        const c2 = await opened(97, null, { container: new El('div') });
        touch(c2); typeIn(c2, 'chief_complaint', 'S2');
        assert.ok(await WS.saveDraft(c2, { silent: true }));
        assert.deepEqual(draftTexts(97), ['S1', 'S2']);
    } finally {
        Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, writable: true, value: saved });
        WS.__setTabIdForTests('tab-ME');
    }
});

test('п. 2: подпись оставляет черновик другой вкладки, сохранённый после прошлой подписи, и убирает тот, что уже пережил подпись', async () => {
    const OLD = { kind: 'draft', savedAt: '2026-10-03T08:00:00.000Z', fields: { chief_complaint: 'X-старый' }, tab: 'tab-X' };
    const SIG = { kind: 'signed', savedAt: '2026-10-03T09:00:00.000Z', by: null, byName: 'Каримов Алишер', fields: { chief_complaint: 'Подписано' } };
    const NEW = { kind: 'draft', savedAt: '2026-10-03T10:00:00.000Z', fields: { chief_complaint: 'Y-новый' }, tab: 'tab-Y' };
    const a = await opened(98, notesOf({ chief_complaint: 'Подписано' }, { history: [OLD, SIG, NEW] }));
    put(a, 'chief_complaint', 'Подписано, правка');
    answerConfirm(true);
    await WS.signDocument(a);
    assert.deepEqual(parsed(98).history.map((e) => e.kind + ':' + e.fields.chief_complaint), ['signed:Подписано', 'draft:Y-новый', 'signed:Подписано, правка']);
});
