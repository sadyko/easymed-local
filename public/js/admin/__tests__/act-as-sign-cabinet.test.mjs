// ADMIN_ACT_AS_V1 (2026-10-28) — R3 В КАБИНЕТЕ ВРАЧА: ПОДПИСЬ ОТ ЧУЖОГО ИМЕНИ.
//
// Спецификация — docs/specs/2026-10-28-admin-act-as-design.md, R3: подпись и
// переподпись заключения приёма от чужого имени запрещена. Сервер отказывает
// сам (403 sign_while_acting); экран не предлагает действие, которое заведомо
// получит отказ: «Завершить приём» (это подпись) неактивна, подсказка — текст
// отказа R3. «Черновик» и «Сохранить» работают: черновик не подписан.
//
// Настоящая форма кабинета (soapForm) на стенде cabinet-harness.mjs.
import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom, El, TOASTS, CONFIRMS } from './cabinet-harness.mjs';
import { ACT_AS_SIGN_REFUSAL } from '../../shared/act-as.js';

const test = (name, fn) => nodeTest(name, { timeout: 20000 }, fn);

installFakeDom();
globalThis.window.dispatchEvent = () => true;
globalThis.CustomEvent = class { constructor(type, o) { this.type = type; this.detail = o && o.detail; } };

const NOTES = new Map();
const WRITES = [];
const RPCS = [];
globalThis.fetch = async (url, opts) => {
    const u = String(url);
    const body = JSON.parse((opts && opts.body) || '{}');
    const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }), headers: { getSetCookie: () => [] } });
    if (u.startsWith('/api/rpc/')) { RPCS.push(u.slice('/api/rpc/'.length)); return ok({ id: 1 }); }
    if (u === '/api/db' && body.table === 'visit_services') {
        const idF = (body.filters || []).find((f) => f.col === 'id');
        const id = idF && Number(idF.val);
        if (body.op === 'select') {
            if (/^services\(type/.test(String(body.columns))) return ok({ services: { type: 'consultation', service_types: { name: 'Консультации' }, departments: null } });
            if (/notes/.test(String(body.columns))) return ok(NOTES.has(id) ? { notes: NOTES.get(id) } : null);
            return ok([]);
        }
        if (body.op === 'update') { WRITES.push({ id, values: body.values }); if (body.values.notes) NOTES.set(id, body.values.notes); return ok(null); }
    }
    return ok(body.op === 'select' && !body.single ? [] : null);
};
const SESSION = new Map();
globalThis.sessionStorage = { getItem: (k) => (SESSION.has(k) ? SESSION.get(k) : null), setItem: (k, v) => { SESSION.set(k, String(v)); }, removeItem: (k) => { SESSION.delete(k); } };

const WS = await import('../views/service-workspace.js');
const { setLang } = await import('../i18n.js');
WS.__setTimingForTests({ retryBaseMs: 40, signTimeoutMs: 30000, writeTimeoutMs: 30000 });

const DOCTOR = { id: 3, full_name: 'Иванова А.', role: 'doctor', is_doctor: true, extra_roles: [], acting_admin: null };
const ACTING = { ...DOCTOR, acting_admin: { id: 1, full_name: 'Петров П.' } };
const setUser = (u) => { globalThis.window.easymed = { state: { user: u } }; };
const notesOf = (current) => JSON.stringify({ __service_workspace_v1: 1, current, history: [] });

function cabinet(id) {
    const container = new El('div');
    const ctx = { container, visitServiceId: id, visitId: 100 + id, patient: { id, lastName: 'Пациент' + id, firstName: 'Тест', mrn: 'P-' + id, __service: { id, name: 'Услуга ' + id, doctorName: 'Иванова А.', doctorSpec: 'Терапевт' } } };
    NOTES.set(id, notesOf({ chief_complaint: 'Кашель' }));
    WS.activateWorkspace(ctx);
    container.appendChild(WS.soapForm(ctx));
    const wrap = container.querySelector('[data-blank-wrap]');
    if (wrap) wrap.style.display = '';
    WS.setDocType(ctx, 'conclusion');
    return ctx;
}
const finishButtons = (ctx) => ctx.container.querySelectorAll('[data-ws-finish]');
const buttonText = (ctx, re) => ctx.container.querySelectorAll('button').find((b) => re.test(b.textContent));

test('работая от имени: «Завершить приём» неактивна с подсказкой R3; «Черновик» и «Сохранить» — работают', async () => {
    setUser(ACTING);
    const ctx = cabinet(51);
    await WS.hydrateLine(ctx);
    const fin = finishButtons(ctx);
    assert.ok(fin.length >= 1, 'кнопка подписи на листе');
    for (const b of fin) {
        assert.equal(b.disabled, true, 'подпись от чужого имени — неактивна');
        assert.equal(b.getAttribute('title'), ACT_AS_SIGN_REFUSAL, 'подсказка — текст отказа R3');
    }
    assert.notEqual(buttonText(ctx, /Черновик/).disabled, true, '«Черновик» не подписан — можно');
    assert.notEqual(buttonText(ctx, /Сохранить/).disabled, true, '«Сохранить» — черновик, можно');
});

test('работая от имени: подпись и «Завершить приём» — отказ словами до любой записи; черновик пишется', async () => {
    setUser(ACTING);
    const ctx = cabinet(52);
    await WS.hydrateLine(ctx);
    WRITES.length = 0; RPCS.length = 0; TOASTS.length = 0; CONFIRMS.length = 0;
    await WS.signDocument(ctx);
    await WS.finishVisit(ctx);
    assert.deepEqual(WRITES, [], 'ни одной записи строки');
    assert.ok(!RPCS.includes('visit_document_archive'), 'архив подписанного документа не трогается');
    assert.deepEqual(CONFIRMS, [], 'вопроса «Подписать?» не было — сразу отказ');
    assert.ok(TOASTS.filter((t) => t === ACT_AS_SIGN_REFUSAL).length >= 2, 'отказ R3 словами: ' + TOASTS.join(' | '));
    // Черновик — не подпись.
    assert.ok(await WS.saveDraft(ctx, { silent: true }), 'черновик от имени сохраняется');
    const last = JSON.parse(WRITES[WRITES.length - 1].values.notes);
    assert.ok(!last.history.some((e) => e.kind === 'signed'), 'подписи нет');
});

test('без входа от имени: «Завершить приём» — как была (активна, без подсказки R3)', async () => {
    setUser(DOCTOR);
    const ctx = cabinet(53);
    await WS.hydrateLine(ctx);
    for (const b of finishButtons(ctx)) {
        assert.notEqual(b.disabled, true);
        assert.notEqual(b.getAttribute('title'), ACT_AS_SIGN_REFUSAL);
    }
});

test('uz/en: подсказка на кнопке подписи — без кириллицы', async () => {
    for (const lang of ['uz', 'en']) {
        setLang(lang);
        setUser(ACTING);
        const ctx = cabinet(54);
        for (const b of finishButtons(ctx)) assert.doesNotMatch(b.getAttribute('title'), /[Ѐ-ӿ]/, lang);
    }
    setLang('ru');
});
