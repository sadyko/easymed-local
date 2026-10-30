// REFUND_ANY_V1 (2026-10-29) — КАБИНЕТ ВРАЧА: «УСЛУГА ВОЗВРАЩЕНА».
//
// Касса вернула пациенту деньги за строку (refunded_lines). Документы приёма
// не удаляются (медицинская запись): кабинет пишет «Услуга возвращена»,
// «Подписать» и «Завершить приём» — отказ словами до любой записи (сервер
// откажет и сам: routes/db.js refundedSignRefusal, visit_document_archive),
// печать — с пометкой над листом. Черновик пишется.
// Настоящая форма кабинета (soapForm) на стенде cabinet-harness.mjs.
import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFakeDom, El, TOASTS, CONFIRMS } from './cabinet-harness.mjs';
import { REFUNDED_SIGN_REFUSAL, REFUNDED_LINE_MARK } from '../../shared/refunded-line.js';

const test = (name, fn) => nodeTest(name, { timeout: 20000 }, fn);

installFakeDom();
globalThis.window.dispatchEvent = () => true;
globalThis.CustomEvent = class { constructor(type, o) { this.type = type; this.detail = o && o.detail; } };

const NOTES = new Map();
const WRITES = [];
const RPCS = [];
let REFUNDED = new Set();
let REFUSE_SIGNED = false;   // ревью B4: сервер отвечает 409 refunded_line на запись строки
globalThis.fetch = async (url, opts) => {
    const u = String(url);
    const body = JSON.parse((opts && opts.body) || '{}');
    const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }), headers: { getSetCookie: () => [] } });
    if (u.startsWith('/api/rpc/')) {
        const name = u.slice('/api/rpc/'.length);
        RPCS.push(name);
        if (name === 'refunded_lines') return ok({ line_ids: (body.line_ids || []).filter((id) => REFUNDED.has(Number(id))) });
        return ok({ id: 1 });
    }
    if (u === '/api/db' && body.table === 'visit_services') {
        const idF = (body.filters || []).find((f) => f.col === 'id');
        const id = idF && Number(idF.val);
        if (body.op === 'select') {
            if (/^services\(type/.test(String(body.columns))) return ok({ services: { type: 'consultation', service_types: { name: 'Консультации' }, departments: null } });
            if (/notes/.test(String(body.columns))) return ok(NOTES.has(id) ? { notes: NOTES.get(id) } : null);
            return ok([]);
        }
        if (body.op === 'update' && REFUSE_SIGNED) {
            return { ok: false, status: 409, json: async () => ({ error: { code: 'refunded_line', message: REFUNDED_SIGN_REFUSAL } }), headers: { getSetCookie: () => [] } };
        }
        if (body.op === 'update') { WRITES.push({ id, values: body.values }); if (body.values.notes) NOTES.set(id, body.values.notes); return ok(null); }
    }
    return ok(body.op === 'select' && !body.single ? [] : null);
};
const SESSION = new Map();
globalThis.sessionStorage = { getItem: (k) => (SESSION.has(k) ? SESSION.get(k) : null), setItem: (k, v) => { SESSION.set(k, String(v)); }, removeItem: (k) => { SESSION.delete(k); } };

const WS = await import('../views/service-workspace.js');
WS.__setTimingForTests({ retryBaseMs: 40, signTimeoutMs: 30000, writeTimeoutMs: 30000 });

const DOCTOR = { id: 3, full_name: 'Иванова А.', role: 'doctor', is_doctor: true, extra_roles: [], acting_admin: null };
globalThis.window.easymed = { state: { user: DOCTOR } };
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

test('возвращённая строка: пометка «Услуга возвращена»; «Подписать» и «Завершить приём» — отказ словами, ни одной записи', async () => {
    REFUNDED = new Set([61]);
    const ctx = cabinet(61);
    await WS.hydrateLine(ctx);
    assert.equal(await WS.loadRefundedMark(ctx), true);
    assert.equal(ctx.refunded, true);
    const note = ctx.container.querySelector('[data-refunded-note]');
    assert.ok(note, 'пометки нет');
    assert.ok(note.textContent.includes(REFUNDED_LINE_MARK), note.textContent);
    assert.equal(ctx.container.firstChild, note, 'пометка — первой, над документом');
    WRITES.length = 0; RPCS.length = 0; TOASTS.length = 0; CONFIRMS.length = 0;
    await WS.signDocument(ctx);
    await WS.finishVisit(ctx);
    assert.deepEqual(WRITES, [], 'ни одной записи строки');
    assert.ok(!RPCS.includes('visit_document_archive'), 'архив подписанного документа не трогается');
    assert.deepEqual(CONFIRMS, [], 'вопроса «Подписать?» не было — сразу отказ');
    assert.ok(TOASTS.filter((t) => t === REFUNDED_SIGN_REFUSAL).length >= 2, 'отказ словами: ' + TOASTS.join(' | '));
    // Черновик — не подпись.
    assert.ok(await WS.saveDraft(ctx, { silent: true }), 'черновик пишется');
    // Повторная проверка не дублирует пометку.
    await WS.loadRefundedMark(ctx);
    assert.equal(ctx.container.querySelectorAll('[data-refunded-note]').length, 1);
});

test('обычная строка: пометки нет, подпись — как прежде', async () => {
    REFUNDED = new Set();
    const ctx = cabinet(62);
    await WS.hydrateLine(ctx);
    assert.equal(await WS.loadRefundedMark(ctx), false);
    assert.equal(ctx.container.querySelector('[data-refunded-note]'), null);
    WRITES.length = 0; TOASTS.length = 0;
    await WS.signDocument(ctx);
    assert.ok(WRITES.length >= 1, 'подпись записана');
    assert.ok(!TOASTS.includes(REFUNDED_SIGN_REFUSAL));
});

// Ревью B4: касса вернула деньги, когда кабинет уже был открыт (пометки нет), —
// сервер отказал записи 409 refunded_line; кабинет спрашивает пометку снова, и
// «Услуга возвращена» встаёт над документом.
test('сервер отказал записи 409 refunded_line — кабинет ставит пометку «Услуга возвращена»', async () => {
    REFUNDED = new Set();
    const ctx = cabinet(63);
    await WS.hydrateLine(ctx);
    assert.equal(await WS.loadRefundedMark(ctx), false);
    assert.equal(ctx.container.querySelector('[data-refunded-note]'), null);
    REFUNDED = new Set([63]);
    REFUSE_SIGNED = true;
    try {
        WRITES.length = 0; TOASTS.length = 0;
        await WS.signDocument(ctx);
        assert.deepEqual(WRITES, [], 'запись прошла, хотя сервер отказал');
        assert.equal(ctx.refunded, true, 'после отказа 409 refunded_line пометка не спрошена');
        const note = ctx.container.querySelector('[data-refunded-note]');
        assert.ok(note && note.textContent.includes(REFUNDED_LINE_MARK), 'пометки нет над документом');
    } finally { REFUSE_SIGNED = false; REFUNDED = new Set(); }
});

test('источник: кабинет спрашивает пометку при открытии строки, печать ставит её над листом', () => {
    const HERE = path.dirname(fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.join(HERE, '..', 'views', 'service-workspace.js'), 'utf8');
    assert.match(src, /if \(ctx\.visitServiceId\) loadRefundedMark\(ctx\);/, 'renderServiceWorkspace не спрашивает refunded_lines');
    assert.match(src, /notice: ctx\.refunded \? REFUNDED_LINE_MARK : null/, 'печать без пометки «Услуга возвращена»');
    // Ревью B4: описание подписи (CABINET_FIX_V1_R2) — снова над своей функцией.
    assert.match(src, /Экспорт signDocument — для проверки\.\n \*\/\nasync function handleSignFinalize\(ctx\) \{/, 'описание handleSignFinalize оторвано от функции');
});

test('слова пометки — в словаре на трёх языках, uz/en без кириллицы', async () => {
    const { STRINGS } = await import('../i18n-strings.js');
    for (const key of [REFUNDED_LINE_MARK, REFUNDED_SIGN_REFUSAL, 'Пациенту вернули деньги за эту услугу. Документы приёма остаются в карте; новый документ на неё не подписывается.']) {
        const e = STRINGS[key];
        assert.ok(e, 'нет ключа словаря: ' + key);
        for (const lang of ['uz', 'en']) assert.doesNotMatch(e[lang] || 'нет', /[Ѐ-ӿ]/, key + ': ' + lang);
    }
});
