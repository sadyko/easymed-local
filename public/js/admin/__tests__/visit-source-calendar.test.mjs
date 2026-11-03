// DIAG_ROUTE_V1 (D8; ревью полировки L-1, M-1) — МАСТЕР ЗАПИСИ КАЛЕНДАРЯ: ШАГ
// «НАПРАВЛЕНИЕ» — ТОЛЬКО СТОЙКЕ И КОЛЛ-ЦЕНТРУ.
//
// Врач доходит до мастера щелчком по слоту своего календаря (room-calendar.js,
// CALENDAR_ROLES включает врача). Шаг 2 «Направление» был в маршруте всегда, а
// calendar_book от врача направившего визита молча не читает (61679d07). Теперь
// шаг пропускается, как «Кто платит» при самооплате, и calendar_book уходит без
// источника; стойке — как было.
//
// Стенд — как у dup-stop-calculator.test.mjs: поддельный DOM, /api/db и /api/rpc —
// настоящие миграции, компилятор и реестр RPC.
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

const { openServicePickerModal, forgetSlots, calcLineDoctorId } = await import('../views/service-picker-modal.js?v=ownrep4');
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

const perms = await import('../permissions.js');
function asRole(role, id) {
    Object.assign(USER, { id, role, extra_roles: [] });
    window.easymed = { state: { user: { id, role, extra_roles: [] } } };
    perms.setActorRoles([role]);
}
const chip = (n) => byClass(top(), 'pkw-step').find((b) => textOf(b).includes(n));
async function toNextStep() {
    await until(() => byClass(top(), 'wzc-cta')[0] && byClass(top(), 'wzc-cta')[0].disabled === false, 'смета готова');
    byClass(top(), 'wzc-cta')[0].click();
    await until(() => buttonWith('Далее →') || buttonWith('Создать визит'), 'следующий шаг');
}

test('врач в мастере календаря: шаг «Направление» пропущен (подпись — кто его укажет), calendar_book — без источника', async () => {
    seed();
    DB.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (7,'doc','x','Петров','doctor',1)").run();
    asRole('doctor', 7);
    try {
        openCalc();
        await until(() => addOf('ОАК'), 'строка ОАК в каталоге');
        addOf('ОАК').click();
        await toNextStep();
        assert.ok(buttonWith('Создать визит'), 'врач попал не на «Подтверждение»');
        assert.ok(!textOf(top()).includes('Источник направления для всех услуг'), 'врачу показан шаг «Направление»');
        const c2 = chip('Направление');
        assert.ok(c2 && 'disabled' in c2.attrs, 'шаг «Направление» не помечен пропущенным');
        assert.equal(c2.attrs.title, 'Кто направил пациента, укажет регистратура');
        // «← Назад» с «Подтверждения» — мимо пропущенных шагов, в смету
        buttonWith('← Назад').click();
        await until(() => byClass(top(), 'wzc-cta')[0], 'назад — в смету');
        await toNextStep();
        buttonWith('Создать визит').click();
        await until(() => RPC.some((c) => c.name === 'calendar_book'), 'calendar_book');
        const book = RPC.find((c) => c.name === 'calendar_book');
        assert.equal(book.body.referral_source_id, null);
    } finally { asRole('admin', 1); perms.setActorRoles([]); delete window.easymed; }
});

test('регистратура в мастере календаря: шаг «Направление» на месте', async () => {
    seed();
    DB.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (2,'reg','x','Регистратор','registrar')").run();
    asRole('registrar', 2);
    try {
        openCalc();
        await until(() => addOf('ОАК'), 'строка ОАК в каталоге');
        addOf('ОАК').click();
        await toNextStep();
        await until(() => textOf(top()).includes('Источник направления для всех услуг'), 'стойке не показан шаг «Направление»');
        const c2 = chip('Направление');
        assert.ok(c2 && !('disabled' in c2.attrs));
    } finally { asRole('admin', 1); perms.setActorRoles([]); delete window.easymed; }
});
