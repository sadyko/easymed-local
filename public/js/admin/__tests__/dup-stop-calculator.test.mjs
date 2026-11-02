// DUP_STOP_V1 (ревью m6, m7) — КАЛЬКУЛЯТОР УСЛУГ И ПОВТОР В ВИЗИТЕ.
//
// m6 — проверка повтора до записи спрашивала с одним врачом строки (у консультации — врач
//      строки каталога), а в базу строка уходила с другим (только врач сметы): сервер
//      решал по ключу, которого экран не проверял. Теперь врач строки — один
//      (calcLineDoctorId) для проверки, вставки и записи колл-центра.
// m7 — отказ строки (409 повтора, любой отказ двери) калькулятор глотал в консоль:
//      визит записан без строки, человек не знает почему. Теперь отказ — словами сервера
//      в тосте; не легла ни одна строка — только что заведённая запись убирается
//      (discard_empty_visit), как в остальных путях отказа.
//
// Стенд — как у invoice-append-review.test.mjs: поддельный DOM, /api/db и /api/rpc —
// настоящие compile() и реестр RPC над SQLite в памяти; FAIL_LINE — дверь /api/db
// отказывает строке этой услуги (409, как отказ повтора, когда второй регистратор успел
// между проверкой и записью).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

class FakeNode {
    constructor(tag) {
        this.tagName = String(tag).toUpperCase();
        this.style = {}; this.children = []; this.attrs = {};
        this.className = ''; this._text = ''; this._l = {}; this.dataset = {};
        this.value = ''; this.checked = false; this.disabled = false;
    }
    appendChild(c) { this.children.push(c); if (c && typeof c === 'object') { c._parent = this; c.parentElement = this; } return c; }
    append(...cs) { for (const c of cs) if (c) this.appendChild(c); }
    removeChild(c) { const i = this.children.indexOf(c); if (i > -1) this.children.splice(i, 1); return c; }
    get firstChild() { return this.children.length ? this.children[0] : null; }
    replaceChildren() { this.children.length = 0; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    removeAttribute(k) { delete this.attrs[k]; }
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); }
    addEventListener(t, fn) { (this._l[t] || (this._l[t] = [])).push(fn); }
    removeEventListener() {}
    dispatchEvent(e) { for (const fn of this._l[e.type] || []) fn(Object.assign({ currentTarget: this, target: this, preventDefault() {}, stopPropagation() {} }, e)); return true; }
    click() { this.dispatchEvent({ type: 'click' }); }
    querySelector() { return new FakeNode('div'); }
    querySelectorAll() { return []; }
    remove() { if (this._parent) this._parent.removeChild(this); }
    focus() {} blur() {} select() {} scrollTo() {} scrollIntoView() {}
    contains() { return false; }
    getBoundingClientRect() { return { top: 0, left: 0, right: 200, bottom: 60, width: 200, height: 60 }; }
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
    set textContent(v) { this._text = String(v); this.children.length = 0; }
    get classList() { const s = this; return { contains: (c) => String(s.className).split(/\s+/).includes(c), add() {}, remove() {}, toggle() {} }; }
    get isConnected() { return true; }
}
class FakeText extends FakeNode { constructor(t) { super('#text'); this.nodeType = 3; this._text = String(t); } }
function mkEl(tag) {
    const el = new FakeNode(tag);
    if (el.tagName === 'TEMPLATE') {
        el.content = { firstChild: null };
        Object.defineProperty(el, 'innerHTML', { set(v) { const s = new FakeNode('svg'); s._text = String(v); el.content.firstChild = s; }, get() { return ''; } });
    }
    return el;
}
globalThis.Node = FakeNode;
globalThis.Event = class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } };
const BODY = mkEl('body');
const TOASTS = [];
const TOAST_EL = new FakeNode('div');
Object.defineProperty(TOAST_EL, 'textContent', { get() { return ''; }, set(v) { TOASTS.push(String(v)); }, configurable: true });
globalThis.document = {
    createElement: mkEl, createElementNS: (_n, t) => mkEl(t), createTextNode: (t) => new FakeText(t),
    head: mkEl('head'), body: BODY, documentElement: mkEl('html'),
    addEventListener() {}, removeEventListener() {},
    getElementById(id) { return id === 'toast' ? TOAST_EL : null; },
};
globalThis.localStorage = { getItem: (k) => (k === 'admin.lang' ? 'ru' : null), setItem() {}, removeItem() {}, clear() {} };
globalThis.window = {
    location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, innerWidth: 1440, innerHeight: 900,
    addEventListener() {}, CLINIC: {}, easymed: { state: { user: null } },
    open: () => ({ document: { open() {}, write() {}, close() {} }, focus() {}, print() {} }),
};
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();
globalThis.confirm = () => true;

const walk = (e, out = []) => { if (!e || typeof e !== 'object') return out; out.push(e); for (const c of e.children || []) walk(c, out); return out; };
const textOf = (e) => walk(e).map((x) => x._text || '').join(' ').replace(/\s+/g, ' ');
const byClass = (root, c) => walk(root).filter((e) => String(e.className || '').split(/\s+/).includes(c));
const until = async (cond, what, ms = 8000) => {
    const t0 = Date.now();
    while (!cond()) {
        if (Date.now() - t0 > ms) throw new Error('не дождались: ' + what);
        await new Promise((r) => setTimeout(r, 15));
    }
};

process.env.LIS_ENABLED = '0';
const { openDb } = await import('../../../../server/db/connection.js');
const { migrate } = await import('../../../../server/db/migrate.js');
const { compile } = await import('../../../../server/db/query-compiler.js');
const { readableColumns, jsonColumns } = await import('../../../../server/db/schema-registry.js');
const { getRpc } = await import('../../../../server/services/rpc/index.js');
const { stampWriteBody } = await import('../../../../server/services/domain/package-lines.js');

const USER = { id: 1, role: 'admin', extra_roles: [] };
let DB = null;
let FAIL_LINE = null;   // service_id, строке которой дверь /api/db откажет
const REFUSAL = 'Эта услуга уже назначена в этом визите: «ОАК» — Регистратор Второй, 03.11.2026 10:00, счёта ещё нет.';
const RPC = [];
globalThis.fetch = async (url, opts) => {
    const u = String(url);
    const body = JSON.parse((opts && opts.body) || '{}');
    const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }), headers: { getSetCookie: () => [] } });
    const fail = (status, message, code = 'bad_request', params) => ({ ok: false, status, json: async () => ({ error: { code, message, params } }), headers: { getSetCookie: () => [] } });
    if (u === '/api/rpc/calendar_slots') return ok({ date: body.date, slots: [{ start: '10:00', end: '10:30' }], busy: [] });
    if (u.startsWith('/api/rpc/')) {
        const name = decodeURIComponent(u.slice('/api/rpc/'.length));
        RPC.push({ name, body });
        const handler = getRpc(name);
        if (!handler) return fail(501, 'RPC not implemented');
        try { return ok(await handler(DB, body, USER)); } catch (e) { return fail(e.status || 500, e.message, e.code || 'bad_request', e.params); }
    }
    if (u === '/api/db') {
        if (body.table === 'visit_services' && body.op === 'insert' && FAIL_LINE != null && Number(body.values && body.values.service_id) === FAIL_LINE) {
            return fail(409, REFUSAL, 'duplicate_order');
        }
        stampWriteBody(DB, body);
        let compiled;
        try { compiled = compile(body, USER, { db: DB }); } catch (e) { return fail(403, e.message); }
        const { sql, params, meta } = compiled;
        if (meta.op === 'insert' && meta.returning) {
            const info = DB.prepare(sql).run(...params);
            const row = DB.prepare(`SELECT ${readableColumns(meta.table).map((c) => `"${c}"`).join(', ')} FROM "${meta.table}" WHERE rowid = ?`).get(info.lastInsertRowid);
            return ok(meta.single ? row : [row]);
        }
        const rows = meta.op === 'select' ? DB.prepare(sql).all(...params) : (DB.prepare(sql).run(...params), []);
        for (const r of rows) for (const c of jsonColumns(meta.table)) if (r && typeof r[c] === 'string') { try { r[c] = JSON.parse(r[c]); } catch { /* как есть */ } }
        if (meta.single === 'single') return ok(rows[0]);
        if (meta.single === 'maybe') return ok(rows[0] ?? null);
        return ok(rows);
    }
    return fail(404, 'no route ' + u);
};

const { openServicePickerModal, forgetSlots, calcLineDoctorId } = await import('../views/service-picker-modal.js');
const PATIENT = { id: 3, fullName: 'Иванов Иван', lastName: 'Иванов', firstName: 'Иван', mrn: 'P-3', phone: '' };

// ОАК (21) — анализ без врача; ЭКГ (23) — процедура без врача.
function seed() {
    const db = openDb(':memory:');
    migrate(db);
    db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (1,'adm','x','Администратор','admin')").run();
    db.prepare("INSERT INTO patients (id, mrn, full_name) VALUES (3,'P-3','Иванов Иван')").run();
    const type = db.prepare('SELECT id FROM service_types ORDER BY id LIMIT 1').get().id;
    db.prepare(`INSERT INTO services (id, name, price, type_id, type, active, requires_doctor, is_lab, code) VALUES
        (21,'ОАК',100000,?,'lab',1,0,1,'S-21'), (23,'ЭКГ',50000,?,'procedure',1,0,0,'S-23')`).run(type, type);
    if (DB) DB.close();
    DB = db;
    RPC.length = 0; TOASTS.length = 0; FAIL_LINE = null;
    return db;
}
const top = () => BODY.children[BODY.children.length - 1];
const addOf = (name) => byClass(top(), 'wzc-svc').filter((r) => textOf(r).includes(name)).map((r) => byClass(r, 'wzc-add')[0]).find(Boolean);
const buttonWith = (text) => walk(top()).find((n) => n.tagName === 'BUTTON' && n.style.display !== 'none' && textOf(n).includes(text));
function openCalc() {
    forgetSlots();
    BODY.children.length = 0;
    openServicePickerModal({ calculator: true, title: 'Калькулятор услуг', onPick: () => {}, patient: PATIENT });
}
/** Смета → «Далее: Направление» → «Далее →» → «Создать визит и счёт»; ждём тост отказа строки. */
async function saveCalc(expect) {
    await until(() => byClass(top(), 'wzc-cta')[0] && byClass(top(), 'wzc-cta')[0].disabled === false, 'смета готова');
    byClass(top(), 'wzc-cta')[0].click();
    await until(() => buttonWith('Далее →'), 'шаг «Направление»');
    buttonWith('Далее →').click();
    await until(() => buttonWith('Создать визит'), 'шаг «Подтверждение»');
    buttonWith('Создать визит').click();
    await until(() => TOASTS.some((t) => expect.test(t)), 'тост ' + expect + ': ' + JSON.stringify(TOASTS));
    await new Promise((r) => setTimeout(r, 200));
}

test('DUP_STOP_V1 (ревью m7): калькулятор — строка не легла (409): отказ словами сервера; ни одной строки — запись убрана', async () => {
    seed();
    FAIL_LINE = 21;
    openCalc();
    await until(() => addOf('ОАК'), 'строка ОАК в каталоге');
    addOf('ОАК').click();
    await saveCalc(/Ни одна услуга не записалась/);
    const t = TOASTS.find((x) => /Ни одна услуга не записалась/.test(x));
    assert.ok(t.includes(REFUSAL), 'причина отказа не названа: ' + t);
    assert.ok(RPC.some((c) => c.name === 'calendar_book'), 'запись не дошла до calendar_book');
    assert.ok(RPC.some((c) => c.name === 'discard_empty_visit'), 'пустая запись не убрана');
    assert.equal(DB.prepare('SELECT COUNT(*) n FROM visits').get().n, 0, 'пустой визит остался');
    assert.equal(RPC.some((c) => c.name === 'create_invoice_for_visit'), false, 'счёт выставлен');
});

test('DUP_STOP_V1 (ревью m7): калькулятор — одна строка из двух не легла: отказ словами сервера, счёт не выставлен, легшая строка цела', async () => {
    seed();
    FAIL_LINE = 21;
    openCalc();
    await until(() => addOf('ОАК'), 'строка ОАК в каталоге');
    addOf('ОАК').click();
    await until(() => addOf('ЭКГ'), 'строка ЭКГ в каталоге');
    addOf('ЭКГ').click();
    await saveCalc(/Записались не все услуги \(1 из 2\)/);
    const t = TOASTS.find((x) => /Записались не все услуги/.test(x));
    assert.ok(t.includes('«ОАК»') && t.includes(REFUSAL), 'причина отказа не названа: ' + t);
    assert.equal(RPC.some((c) => c.name === 'create_invoice_for_visit'), false, 'счёт выставлен по половине сметы');
    assert.equal(RPC.some((c) => c.name === 'discard_empty_visit'), false, 'запись с легшей строкой убрана');
    assert.deepEqual(DB.prepare('SELECT service_id FROM visit_services').all().map((r) => r.service_id), [23]);
});

test('DUP_STOP_V1 (ревью m6): врач строки калькулятора — один для проверки повтора и для записи', () => {
    const consult = { service: { id: 'c|7|4', __consult: true, consultation_type_id: 4, __consultDoctorId: 7 }, doctor: null };
    assert.equal(calcLineDoctorId(consult), null, 'регистратура пишет строку с врачом сметы — его нет');
    assert.equal(calcLineDoctorId(consult, { viaBooking: true }), 7, 'колл-центр (booking_lines_add) — врач строки каталога');
    assert.equal(calcLineDoctorId({ ...consult, doctor: { id: 9 } }), 9);
    assert.equal(calcLineDoctorId({ service: { id: 21 }, doctor: null }, { viaBooking: true }), null);
    // исходник: проверка повтора, вставка и запись колл-центра берут врача у calcLineDoctorId
    const HERE = path.dirname(fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.join(HERE, '..', 'views', 'service-picker-modal.js'), 'utf8').replace(/\/\/[^\n]*/g, '');
    const pre = src.slice(src.indexOf('await precheckOrders({'), src.indexOf('await calendarBookOrAsk({'));
    assert.match(pre, /doctor_id: calcLineDoctorId\(a, \{ viaBooking: !canAddVisitLines\(\) \}\)/, 'проверка повтора — с другим врачом, чем запись');
    assert.ok(!/__consultDoctorId/.test(pre), 'проверка повтора берёт врача строки каталога мимо записи');
    const ins = src.slice(src.indexOf("insertRow('visit_services'"), src.indexOf("insertRow('visit_services'") + 600);
    assert.match(ins, /doctor_id:\s+calcLineDoctorId\(a\),/);
    const book = src.slice(src.indexOf('const lineOf = (a) => a.service.__consult'), src.indexOf("supabase.rpc('booking_lines_add'"));
    assert.match(book, /calcLineDoctorId\(a, \{ viaBooking: true \}\)/);
});

test.after(() => { if (DB) DB.close(); DB = null; });
