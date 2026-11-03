// REPEAT_VISIT_V1 (ревью, остаток 9) — ЖУРНАЛ ПАЦИЕНТА: detail ОБЪЕКТОМ ТЕРЯЛСЯ МОЛЧА.
//
// logPatientActivity шлёт строку в /api/db (patient_activity_log). Колонка detail — текст,
// и объект компилятор запроса не принимает: 400 «unsupported value type», а журнал
// пишется «не мешая делу» — запись пропадала без следа. Так звали его окно визита
// (смена статуса, услуга с ценой и врачом), рабочее место (выдача товара, направление)
// и возврат по счёту. Теперь объект превращается в JSON-строку в самом logPatientActivity.
// Запрос проверяется настоящим компилятором /api/db (server/db/query-compiler.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';

class F {
    constructor(t) { this.tagName = String(t).toUpperCase(); this.style = {}; this.children = []; this.attrs = {}; this.dataset = {}; this._t = ''; }
    appendChild(c) { this.children.push(c); return c; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    addEventListener() {}
    get textContent() { return this._t; } set textContent(v) { this._t = String(v); }
}
globalThis.Node = F;
globalThis.document = {
    createElement: (t) => new F(t), createElementNS: (_n, t) => new F(t), createTextNode: (t) => { const n = new F('#text'); n._t = String(t); return n; },
    head: new F('head'), body: new F('body'), documentElement: new F('html'),
    addEventListener() {}, removeEventListener() {}, getElementById: () => null, querySelector: () => null,
};
globalThis.localStorage = { getItem: (k) => (k === 'admin.lang' ? 'ru' : null), setItem() {}, removeItem() {} };
globalThis.window = { location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, addEventListener() {}, easymed: { state: { user: { id: 3, full_name: 'Регистратор', role: 'registrar' } } } };

const { compile } = await import('../../../../server/db/query-compiler.js');
const USER = { id: 3, role: 'registrar', extra_roles: [] };
const WRITES = [];
globalThis.fetch = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : null;
    if (String(url) === '/api/db' && body && body.op === 'insert') {
        WRITES.push(body);
        try { compile(body, USER); } catch (e) {
            return { ok: false, status: e.status || 400, json: async () => ({ error: { code: 'bad_request', message: e.message } }) };
        }
    }
    return { ok: true, status: 200, json: async () => ({ data: null }) };
};
const { logPatientActivity } = await import('../views/activity-log.js');

test('ревью, остаток 9: detail объектом уходит JSON-строкой, и /api/db такую строку принимает', async () => {
    WRITES.length = 0;
    const detail = { from: 'scheduled', to: 'arrived', trigger: 'service_attached' };
    await logPatientActivity({ patientId: 9, visitId: 4, entityType: 'visit', action: 'status_changed', detail });
    assert.equal(WRITES.length, 1);
    const row = WRITES[0].values;
    assert.equal(typeof row.detail, 'string', 'detail ушёл объектом: ' + JSON.stringify(row.detail));
    assert.deepEqual(JSON.parse(row.detail), detail);
    assert.doesNotThrow(() => compile(WRITES[0], USER), 'компилятор /api/db отказал строке журнала');
});

test('ревью, остаток 9: detail строкой — как есть (без второго JSON.stringify); без detail — null', async () => {
    WRITES.length = 0;
    const text = JSON.stringify({ reason: 'контроль', service_id: 5 });
    await logPatientActivity({ patientId: 9, entityType: 'visit', action: 'repeat_booked', detail: text });
    await logPatientActivity({ patientId: 9, entityType: 'visit', action: 'opened' });
    assert.equal(WRITES[0].values.detail, text);
    assert.equal(WRITES[1].values.detail, null);
    for (const w of WRITES) assert.doesNotThrow(() => compile(w, USER));
});
