// CABINET_DX_KEEP_CONDITIONS_V1 (2026-10-03) — РЕШЕНИЕ ВЛАДЕЛЬЦА: КОД МКБ-10,
// СНЯТЫЙ С ДОКУМЕНТА ПРИЁМА, МЕНЯЕТ ТОЛЬКО ЭТОТ ДОКУМЕНТ. Список состояний
// пациента (patient_conditions) кабинет при снятии кода не трогает — ошибочное
// состояние убирают руками в карте пациента. Добавленный диагноз, как и прежде,
// ложится в список (активное состояние с тем же кодом не двоится).
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
const CONDITIONS = [];   // patient_conditions
const COND_LOG = [];     // всё, что кабинет делает со списком состояний пациента
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
        if (body.table === 'patient_conditions') {
            const f = (c) => { const x = (body.filters || []).find((y) => y.col === c); return x ? x.val : undefined; };
            if (body.op === 'select') {
                return ok(CONDITIONS.filter((r) => String(r.patient_id) === String(f('patient_id')) && (f('code') === undefined || r.code === f('code')) && (f('status') === undefined || r.status === f('status'))).map((r) => ({ id: r.id })));
            }
            if (body.op === 'insert') { const row = { id: CONDITIONS.length + 1, ...(body.values || {}) }; CONDITIONS.push(row); COND_LOG.push({ op: 'insert', row }); return ok(row); }
            COND_LOG.push({ op: body.op, filters: body.filters, values: body.values });
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

// ─── решение владельца: снятый код меняет только документ этого приёма ───────
const condOps = (kind) => COND_LOG.filter((e) => e.op === kind);

test('«Убрать» диагноз (МКБ-10) — снят только с документа приёма; список состояний пациента не трогается', async () => {
    COND_LOG.length = 0;
    const a = await opened(201, notesOf({ chief_complaint: 'X' }, { diagnoses: [{ code: 'J06.9', name: 'ОРВИ', type: 'main' }, { code: 'I10', name: 'Гипертензия', type: 'concomitant' }] }));
    await WS.removeDiagnosisEntry(a, 1);
    assert.deepEqual(parsed(201).diagnoses.map((d) => d.code), ['J06.9']);
    assert.deepEqual(condOps('delete').concat(condOps('update')), [], 'снятие кода тронуло список состояний пациента');
});

test('«×» у «Диагноза» с кодами — коды уходят из документа; список состояний пациента не трогается (и при повторе после отказа)', async () => {
    COND_LOG.length = 0;
    const a = await opened(202, notesOf({ chief_complaint: 'X' }, { diagnoses: [{ code: 'J06.9', name: 'ОРВИ', type: 'main' }] }));
    touch(a);
    answerConfirm(true);
    CONFIRMS.length = 0;
    assert.equal(await WS.wsRemoveSection(a, 'diagnosis'), true);
    assert.deepEqual(parsed(202).diagnoses, []);
    assert.ok(!/состояни|карт/i.test(CONFIRMS.join(' ')), 'вопрос говорит о списке пациента: ' + CONFIRMS.join(' | '));
    // повтор после отказа «документ изменился»
    const b = await opened(203, notesOf({ chief_complaint: 'X' }, { diagnoses: [{ code: 'K29.7', name: 'Гастрит', type: 'main' }] }));
    touch(b);
    const o = JSON.parse(NOTES.get(203)); o.current = { chief_complaint: 'ДРУГОЕ' }; NOTES.set(203, JSON.stringify(o));
    const c0 = conflictsOf(203);
    assert.equal(await WS.wsRemoveSection(b, 'diagnosis'), true);
    assert.equal(conflictsOf(203) - c0, 1, 'отказа не было — проверка не о том');
    assert.deepEqual(parsed(203).diagnoses, []);
    assert.deepEqual(condOps('delete').concat(condOps('update')), [], '«×» тронул список состояний пациента');
});

test('«Убрать» диагноз после отказа «документ изменился» — повтор тоже не трогает список состояний', async () => {
    COND_LOG.length = 0;
    const a = await opened(204, notesOf({ chief_complaint: 'X' }, { diagnoses: [{ code: 'J06.9', name: 'ОРВИ', type: 'main' }] }));
    const o = JSON.parse(NOTES.get(204)); o.current = { chief_complaint: 'ДРУГОЕ' }; NOTES.set(204, JSON.stringify(o));
    const c0 = conflictsOf(204);
    await WS.removeDiagnosisEntry(a, 0);
    assert.equal(conflictsOf(204) - c0, 1);
    assert.deepEqual(parsed(204).diagnoses, []);
    assert.deepEqual(condOps('delete').concat(condOps('update')), []);
});

test('добавленный диагноз по-прежнему ложится в список состояний — один раз: активное состояние с тем же кодом не двоится', async () => {
    COND_LOG.length = 0;
    CONDITIONS.length = 0;
    const a = await opened(205, notesOf({ chief_complaint: 'X' }));
    await WS.addDiagnosisEntry(a, { code: 'J06.9', name: 'ОРВИ', type: 'main' });
    await tick(5);
    assert.deepEqual(condOps('insert').map((e) => e.row.code), ['J06.9'], 'состояние не добавлено');
    // тот же код в другом приёме того же пациента — активное состояние уже есть
    const b = await opened(206, notesOf({ chief_complaint: 'Y' }));
    b.patient.id = a.patient.id;
    await WS.addDiagnosisEntry(b, { code: 'J06.9', name: 'ОРВИ', type: 'main' });
    await tick(5);
    assert.deepEqual(condOps('insert').map((e) => e.row.code), ['J06.9'], 'активное состояние с тем же кодом задвоено');
});
