// PICK_DAY_V1 (решение владельца 2026-11-02) — КАЛЬКУЛЯТОР УСЛУГ: время
// ставится само только сегодня.
//
// catPickDoc брал первый свободный слот из семи дней каталога: врач сегодня
// занят — строка молча получала завтра, а с ней и ВЕСЬ визит калькулятора
// (cartVisitDateIso — день самой ранней строки со временем): анализ, который
// пациент сдаёт сейчас, уезжал на завтра. Теперь: сегодня нет времени —
// красная пометка, «Ближайшее: …», дальше нельзя; выбранный другой день виден
// в смете («Визит — …»).
//
// Стенд — как у picker-attach-package-day.test.mjs: поддельный DOM, /api/db и
// /api/rpc — настоящие сервер и дверь в памяти; calendar_slots — врач УЗИ
// свободен в 10:00 каждый день, busyToday — сегодня занят.
import test from 'node:test';
import assert from 'node:assert/strict';

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
    querySelector() { return null; }
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
const TOAST_EL = new FakeNode('div');
Object.defineProperty(TOAST_EL, 'textContent', { get() { return ''; }, set() {}, configurable: true });
globalThis.document = {
    createElement: mkEl, createElementNS: (_n, t) => mkEl(t), createTextNode: (t) => new FakeText(t),
    head: mkEl('head'), body: BODY, documentElement: mkEl('html'),
    addEventListener() {}, removeEventListener() {},
    getElementById(id) { return id === 'toast' ? TOAST_EL : null; },
};
// I18N_LOCALE_PIN_V1 — русский ДО импорта видов.
globalThis.localStorage = { getItem: (k) => (k === 'admin.lang' ? 'ru' : null), setItem() {}, removeItem() {}, clear() {} };
globalThis.window = { location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, innerWidth: 1440, innerHeight: 900, addEventListener() {}, CLINIC: {}, open: () => null, easymed: { state: { user: null } } };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();
globalThis.confirm = () => true;

const walk = (e, out = []) => { if (!e || typeof e !== 'object') return out; out.push(e); for (const c of e.children || []) walk(c, out); return out; };
const textOf = (e) => walk(e).map((x) => x._text || '').join(' ').replace(/\s+/g, ' ');
const byClass = (root, c) => walk(root).filter((e) => String(e.className || '').split(/\s+/).includes(c));
const byAttr = (root, k, v) => walk(root).find((e) => e.attrs && e.attrs[k] !== undefined && (v === undefined || e.attrs[k] === String(v)));
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

const ymd = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const dayAt = (off) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + off); return d; };

const USER = { id: 1, role: 'registrar', extra_roles: [] };
let DB = null;
let busyToday = false;
globalThis.fetch = async (url, opts) => {
    const u = String(url);
    const body = JSON.parse((opts && opts.body) || '{}');
    const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }), headers: { getSetCookie: () => [] } });
    const fail = (status, message) => ({ ok: false, status, json: async () => ({ error: { code: 'bad_request', message } }), headers: { getSetCookie: () => [] } });
    if (u === '/api/rpc/calendar_slots') {
        // Врач УЗИ свободен с 10:00 каждый день; busyToday — сегодня занят.
        if (busyToday && body.date === ymd(new Date())) return ok({ date: body.date, slots: [], busy: [] });
        return ok({ date: body.date, slots: [{ start: '10:00', end: '10:30' }], busy: [] });
    }
    if (u.startsWith('/api/rpc/')) {
        const handler = getRpc(decodeURIComponent(u.slice('/api/rpc/'.length)));
        if (!handler) return fail(501, 'RPC not implemented');
        try { return ok(await handler(DB, body, USER)); } catch (e) { return fail(e.status || 500, e.message); }
    }
    if (u === '/api/db') {
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

const { openServicePickerModal, forgetSlots } = await import('../views/service-picker-modal.js');
const { nearestButtonText } = await import('../views/pick-day.js');

// ОАК — без врача; УЗИ — врач нужен, назначен один (каталог выберет его сам).
function seed() {
    const db = openDb(':memory:');
    migrate(db);
    db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (1,'reg','x','Регистратор','registrar')").run();
    db.prepare("INSERT INTO patients (id, mrn, full_name) VALUES (3,'P-3','Иванов Иван')").run();
    const lab = db.prepare('SELECT id FROM service_types ORDER BY id LIMIT 1').get().id;
    db.prepare("INSERT INTO services (id, name, price, type_id, type, active, requires_doctor, code) VALUES (21,'ОАК',100000,?,'lab',1,0,'S-21'), (22,'УЗИ',50000,?,'imaging',1,1,'S-22')").run(lab, lab);
    db.prepare(`INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, service_rates)
                VALUES (5,'uzi','x','Узистов Улугбек','doctor',1,'[{"service_id":22,"pct":10}]')`).run();
    if (DB) DB.close();
    DB = db;
}

/** Калькулятор на пациента 3; в смету — УЗИ. */
async function openWithUzi() {
    seed();
    forgetSlots();
    BODY.children.length = 0;
    openServicePickerModal({ calculator: true, title: 'Калькулятор услуг', onPick: () => {},
        patient: { id: 3, fullName: 'Иванов Иван', lastName: 'Иванов', firstName: 'Иван', mrn: 'P-3', phone: '' } });
    const top = () => BODY.children[BODY.children.length - 1];
    const addOf = (name) => byClass(top(), 'wzc-svc').filter((r) => textOf(r).includes(name)).map((r) => byClass(r, 'wzc-add')[0]).find(Boolean);
    await until(() => addOf('УЗИ'), 'строка УЗИ в каталоге');
    addOf('УЗИ').click();
    return { top, addOf };
}

test('врач сегодня занят: строка без времени, красная пометка, «Ближайшее» — завтра 10:00; смету дальше не отправить', async () => {
    busyToday = true;
    try {
        const { top } = await openWithUzi();
        await until(() => byAttr(top(), 'data-pick-nearest', 22), 'кнопка «Ближайшее»');
        assert.equal(textOf(byAttr(top(), 'data-pick-nearest', 22)).trim(), nearestButtonText(ymd(dayAt(1)), 600));
        assert.ok(byAttr(top(), 'data-pick-day', 22), 'нет «Выбрать день»');
        assert.ok(textOf(top()).includes('Сегодня у врача нет свободного времени'), 'нет пометки');
        assert.equal(byClass(top(), 'wzc-cta')[0].disabled, true, 'смета без времени ушла бы дальше');
        assert.ok(!byAttr(top(), 'data-visit-day'), 'визит уже «перенесён», хотя день никто не выбирал');
    } finally { busyToday = false; }
});

test('«Ближайшее» ставит завтра 10:00 — смета готова, и в ней сказано, что визит завтра (cartVisitDateIso)', async () => {
    busyToday = true;
    try {
        const { top } = await openWithUzi();
        await until(() => byAttr(top(), 'data-pick-nearest', 22), 'кнопка «Ближайшее»');
        byAttr(top(), 'data-pick-nearest', 22).click();
        await until(() => byClass(top(), 'wzc-cta')[0] && byClass(top(), 'wzc-cta')[0].disabled === false, 'смета готова');
        const note = byAttr(top(), 'data-visit-day');
        assert.ok(note, 'перенос визита на завтра не виден в смете');
        assert.equal(note.attrs['data-visit-day'], ymd(dayAt(1)));
        assert.ok(!byAttr(top(), 'data-no-today'), 'пометка осталась после выбора дня');
    } finally { busyToday = false; }
});

test('время сегодня есть — каталог ставит его сам; визит — сегодня, пометок нет', async () => {
    const { top } = await openWithUzi();
    await until(() => byClass(top(), 'wzc-cta')[0] && byClass(top(), 'wzc-cta')[0].disabled === false, 'смета готова');
    assert.ok(!byAttr(top(), 'data-no-today'));
    assert.ok(!byAttr(top(), 'data-visit-day'), 'визит не сегодня');
    assert.match(textOf(top()), /сегодня 10:00/);
});

test.after(() => { if (DB) DB.close(); DB = null; });
