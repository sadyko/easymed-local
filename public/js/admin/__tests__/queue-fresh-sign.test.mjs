// QUEUE_FRESH_V1 (3.21.0) — ОКНО ПРИЁМА СООБЩАЕТ КАБИНЕТУ, ЧТО ПРИЁМ ЗАВЕРШЁН.
//
// «Завершить приём» (подпись) пишет строке 'completed' — и сразу сообщает об
// этом кабинету (queue-fresh.js), а возвращает врача в «Мои приёмы» адресом с
// вкладкой ({ sub: 'work' }): по нему кэшированный кабинет перечитывает очередь
// (ctx.onPayload). «Черновик» статус не меняет и ничего не сообщает — строка
// остаётся «Идёт приём». Настоящая форма кабинета на стенде cabinet-harness.mjs.
import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installFakeDom, El } from './cabinet-harness.mjs';

const test = (name, fn) => nodeTest(name, { timeout: 20000 }, fn);

installFakeDom();
globalThis.window.dispatchEvent = () => true;
globalThis.CustomEvent = class { constructor(type, o) { this.type = type; this.detail = o && o.detail; } };

const NOTES = new Map();
globalThis.fetch = async (url, opts) => {
    const u = String(url);
    const body = JSON.parse((opts && opts.body) || '{}');
    const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }), headers: { getSetCookie: () => [] } });
    if (u.startsWith('/api/rpc/')) {
        if (u.endsWith('/refunded_lines')) return ok({ line_ids: [] });
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
        if (body.op === 'update') { if (body.values.notes) NOTES.set(id, body.values.notes); return ok(null); }
    }
    return ok(body.op === 'select' && !body.single ? [] : null);
};
const SESSION = new Map();
globalThis.sessionStorage = { getItem: (k) => (SESSION.has(k) ? SESSION.get(k) : null), setItem: (k, v) => { SESSION.set(k, String(v)); }, removeItem: (k) => { SESSION.delete(k); } };

const WS = await import('../views/service-workspace.js');
WS.__setTimingForTests({ retryBaseMs: 40, signTimeoutMs: 30000, writeTimeoutMs: 30000 });
const QF = await import('../queue-fresh.js');
const NOTED = [];
QF.onLineStatus((id, s) => NOTED.push([id, s]));

const DOCTOR = { id: 3, full_name: 'Иванова А.', role: 'doctor', is_doctor: true, extra_roles: [], acting_admin: null };
globalThis.window.easymed = { state: { user: DOCTOR } };
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function cabinet(id, nav) {
    const container = new El('div');
    const ctx = { container, visitServiceId: id, visitId: 100 + id, onNavigate: (v, p) => nav.push([v, p]),
        patient: { id, lastName: 'Пациент' + id, firstName: 'Тест', mrn: 'P-' + id,
            __service: { id, name: 'Услуга ' + id, doctorName: 'Иванова А.', doctorSpec: 'Терапевт' } } };
    NOTES.set(id, JSON.stringify({ __service_workspace_v1: 1, current: { chief_complaint: 'Кашель', conclusion_text: 'Здоров' }, history: [] }));
    WS.activateWorkspace(ctx);
    container.appendChild(WS.soapForm(ctx));
    const wrap = container.querySelector('[data-blank-wrap]');
    if (wrap) wrap.style.display = '';
    WS.setDocType(ctx, 'conclusion');
    return ctx;
}

test('«Завершить приём»: кабинет узнаёт сразу (строка → completed), врача ведут в «Мои приёмы» с адресом вкладки', async () => {
    const NAV = [];
    const ctx = cabinet(81, NAV);
    await WS.hydrateLine(ctx);
    NOTED.length = 0;
    await WS.signDocument(ctx);
    assert.deepEqual(NOTED, [[81, 'completed']], 'кабинету не сообщили о завершённой строке');
    await tick(700);
    assert.deepEqual(NAV, [['consultation', { sub: 'work' }]], 'возврат без адреса вкладки — кэшированный кабинет его не заметит');
});

test('«Черновик» — статус не меняется: кабинету сообщать нечего, строка остаётся «Идёт приём»', async () => {
    const NAV = [];
    const ctx = cabinet(82, NAV);
    await WS.hydrateLine(ctx);
    NOTED.length = 0;
    assert.ok(await WS.saveDraft(ctx, { silent: true }), 'черновик не записан');
    assert.deepEqual(NOTED, []);
    assert.deepEqual(NAV, []);
});

test('источник: один экземпляр почты (импорт без ?v=); «Пауза» тоже возвращает в «Мои приёмы»', () => {
    const src = readFileSync(new URL('../views/service-workspace.js', import.meta.url), 'utf8');
    assert.match(src, /\nimport \{ noteLineStatus \} from '\.\.\/queue-fresh\.js';/);
    const pause = (src.match(/async function pauseAndLeave\(ctx\) \{[\s\S]*?\n\}/) || [''])[0];
    assert.match(pause, /ctx\.onNavigate\('consultation', \{ sub: 'work' \}\)/);
});
