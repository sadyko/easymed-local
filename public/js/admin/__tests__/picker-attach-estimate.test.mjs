// BACKLOG_1011_V1 — каталог в режиме привязки (attachMode): окно визита
// «Добавить услуги к визиту» (visit-modal.js) и кабинет врача «Добавить»
// (service-workspace.js servicesCard → addOwnService). То, что смета называет,
// должно лечь строкой и выйти счётом: смета = строка визита = счёт.
//
// Стенд — поддельный DOM; /api/db и /api/rpc — настоящие сервер и дверь в
// памяти (отказ пакета вне срока, цена пакета на строке — как routes/db.js);
// calendar_slots — врач свободен с 10:00 каждый день, кроме дней из busyDays.
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
const digits = (s) => Number(String(s).replace(/[^\d]/g, ''));
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
const { packageStampRefusal } = await import('../../../../server/services/rpc/billing.js');

const USER = { id: 1, role: 'registrar', extra_roles: [] };
const ADMIN = { id: 1, role: 'admin', extra_roles: [] };
let DB = null;
const busyDays = new Set();
globalThis.fetch = async (url, opts) => {
    const u = String(url);
    const body = JSON.parse((opts && opts.body) || '{}');
    const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }), headers: { getSetCookie: () => [] } });
    const fail = (status, message) => ({ ok: false, status, json: async () => ({ error: { code: 'bad_request', message } }), headers: { getSetCookie: () => [] } });
    if (u === '/api/rpc/calendar_slots') {
        // Врач свободен с 10:00 каждый день; busyDays — дни, когда свободного времени нет.
        if (busyDays.has(body.date)) return ok({ date: body.date, slots: [], busy: [] });
        return ok({ date: body.date, slots: [{ start: '10:00', end: '10:30' }], busy: [] });
    }
    if (u.startsWith('/api/rpc/')) {
        const handler = getRpc(decodeURIComponent(u.slice('/api/rpc/'.length)));
        if (!handler) return fail(501, 'RPC not implemented');
        try { return ok(await handler(DB, body, USER)); } catch (e) { return fail(e.status || 500, e.message); }
    }
    if (u === '/api/db') {
        // Как routes/db.js: пакет вне срока дня визита — 409, затем цена пакета на строке.
        if (body.table === 'visit_services' && body.op === 'insert') {
            const r = packageStampRefusal(DB, Array.isArray(body.values) ? body.values : [body.values]);
            if (r) return fail(409, r);
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


const { openServicePickerModal, forgetSlots } = await import('../views/service-picker-modal.js');
const VM = await import('../views/visit-modal.js');
const WS = await import('../views/service-workspace.js');
const fs = await import('node:fs');
const path = await import('node:path');
const { fileURLToPath } = await import('node:url');
const HERE = path.dirname(fileURLToPath(import.meta.url));

const ymd = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const NOW = new Date();
const dayAt = (off) => new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + off, 12, 0, 0);

/**
 * ОАК 100 000 (анализ, без врача) и УЗИ 50 000 (врачебная). УЗИ делает врач 5
 * (своя цена — ownPrice), при twoPerformers — ещё врач 6 (без своей цены):
 * тогда каталог врача сам не ставит. visitDoctor — врач визита / приёма.
 */
function seed({ visitOffset = 0, visitDoctor = null, ownPrice = null, ownLabPrice = null, twoPerformers = false,
    repeat = false, uziTier = false, categoryPct = 0, pkg = false } = {}) {
    const db = openDb(':memory:');
    migrate(db);
    db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (1,'reg','x','Регистратор','registrar')").run();
    let cat = null;
    if (categoryPct) cat = db.prepare("INSERT INTO patient_categories (name, discount_percent, active) VALUES ('VIP', ?, 1)").run(categoryPct).lastInsertRowid;
    db.prepare("INSERT INTO patients (id, mrn, full_name, category_id) VALUES (3,'P-3','Иванов Иван', ?)").run(cat);
    const lab = db.prepare('SELECT id FROM service_types ORDER BY id LIMIT 1').get().id;
    db.prepare("INSERT INTO services (id, name, price, type_id, type, active, requires_doctor, is_lab, code) VALUES (21,'ОАК',100000,?,'lab',1,0,1,'S-21'), (22,'УЗИ',50000,?,'imaging',1,1,0,'S-22')").run(lab, lab);
    const rate = (sid, price) => (price != null ? { service_id: sid, pct: 10, price } : { service_id: sid, pct: 10 });
    const rates5 = [rate(22, ownPrice)];
    if (ownLabPrice != null) rates5.push(rate(21, ownLabPrice));
    db.prepare(`INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, service_rates)
                VALUES (5,'uzi','x','Узистов Улугбек','doctor',1,?)`).run(JSON.stringify(rates5));
    if (twoPerformers) {
        db.prepare(`INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, service_rates)
                    VALUES (6,'uzi2','x','Второй Узист','doctor',1,'[{"service_id":22,"pct":10}]')`).run();
    }
    if (pkg) {
        db.prepare(`INSERT INTO service_templates (id, name, service_ids, discount_percent, is_package, discount_mode, discount_value, valid_from, valid_until, active)
                    VALUES (9, 'Анализы', '[21]', 20, 1, 'percent', 20, NULL, NULL, 1)`).run();
    }
    db.prepare("INSERT INTO visits (id, patient_id, visit_date, status, doctor_id) VALUES (40, 3, ?, 'scheduled', ?)").run(dayAt(visitOffset).toISOString(), visitDoctor);
    if (repeat) {
        if (uziTier) db.prepare('UPDATE services SET price_secondary = 20000, secondary_days_from = 0, secondary_days_to = 30 WHERE id = 22').run();
        const pv = db.prepare("INSERT INTO visits (patient_id, visit_date, status) VALUES (3, ?, 'arrived')").run(dayAt(-3).toISOString()).lastInsertRowid;
        db.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status, price_tier) VALUES (?, 22, 1, 50000, 50000, 'completed', 'primary')").run(pv);
    }
    if (DB) DB.close();
    DB = db;
}

/** Параметры каталога — как у окна-хозяина (визит / кабинет). */
function pickerOptions(win, visit, patient, picks) {
    if (win === 'cabinet') {
        // Как service-workspace.js servicesCard (проверяется ниже по исходнику).
        return { attachMode: true, requireSlot: false, patient, visitDoctorId: patient.__service.doctorId,
            defaultPerformerId: patient.__service.doctorId, packageDay: patient.__service.visitDate || null,
            title: 'Добавить услуги к приёму', ctaLabel: 'Добавить к приёму', excludeServiceIds: [], onPick: (p) => { picks.push(p); } };
    }
    // Как visit-modal.js «Добавить услуги к визиту».
    return { attachMode: true, title: 'Добавить услуги к визиту', patient, visitDoctorId: visit.doctor_id || null, showSchedule: true,
        patientId: 3, visitId: 40, initialDateIso: ymd(new Date(visit.visit_date)), packageDay: visit.visit_date, excludeServiceIds: [],
        onPick: (p) => { picks.push(p); } };
}

/**
 * Окно, смета, запись строк и счёт по ним. add — названия услуг из каталога;
 * pkg — ещё и пакет «Анализы» (кнопка «Выбрать шаблон»).
 * → { shown, total, lines, picks, billed, rail, top }.
 */
async function run(opts) {
    seed(opts);
    forgetSlots();
    BODY.children.length = 0;
    const picks = [];
    const visit = DB.prepare('SELECT * FROM visits WHERE id = 40').get();
    const patient = { id: 3, fullName: 'Иванов Иван', lastName: 'Иванов', firstName: 'Иван', mrn: 'P-3', phone: '',
        __service: { id: 900, doctorId: opts.visitDoctor || null, visitId: 40, visitDate: visit.visit_date } };
    const win = opts.window || 'visit';
    openServicePickerModal(pickerOptions(win, visit, patient, picks));
    const top = () => BODY.children[BODY.children.length - 1];
    const btn = (re) => walk(top()).find((e) => e.tagName === 'BUTTON' && re.test(textOf(e)));
    let expect = 0;
    if (opts.pkg) {
        await until(() => btn(/Выбрать шаблон/), 'кнопка «Выбрать шаблон»');
        btn(/Выбрать шаблон/).click();
        await until(() => btn(/Анализы/), 'пакет в списке');
        btn(/Анализы/).click();
        expect += 1;
        await until(() => byClass(top(), 'wzc-ln').length === expect, 'строка пакета в смете');
    }
    for (const name of opts.add || []) {
        await until(() => byClass(top(), 'wzc-svc').some((r) => new RegExp(name).test(textOf(r))), 'строка ' + name + ' в каталоге');
        const row = byClass(top(), 'wzc-svc').find((r) => new RegExp(name).test(textOf(r)));
        walk(row).find((e) => e.tagName === 'BUTTON' && String(e.className).includes('wzc-add')).click();
        expect += 1;
        await until(() => byClass(top(), 'wzc-ln').length === expect, 'строки сметы');
    }
    await new Promise((r) => setTimeout(r, 300));   // котировки яруса, время врача, группа пациента
    const tot = byClass(top(), 'wzc-tot').map(textOf);
    const shown = digits(tot[tot.length - 1].replace(/^.*?(Итого|К оплате)/, ''));
    const total = digits(tot[0].replace(/^.*?Итого/, ''));
    const rail = byClass(top(), 'wzc-ln').map(textOf).join(' | ') + ' || ' + tot.join(' | ');
    const ctaOk = !byClass(top(), 'wzc-cta')[0].disabled;
    if (opts.noSave) return { shown, total, rail, ctaOk, top: top() };
    byClass(top(), 'wzc-cta')[0].click();
    await until(() => picks.length === expect, 'строки ушли в onPick');
    if (win === 'cabinet') {
        const ctx = { visitId: 40, visitServiceId: 900, patient, container: null };
        WS.activateWorkspace(ctx);   // как при открытии приёма
        for (const p of picks) await WS.addOwnService(ctx, p.service, p.doctor, p.package);
    } else {
        const state = { visit, patient: { id: 3 }, services: [] };
        for (const p of picks) await VM.addServiceFromPicker(state, p, () => {});
    }
    const lines = DB.prepare(`SELECT id, service_id, doctor_id, unit_price, total, price_tier, package_id, scheduled_at,
                                     date(scheduled_at, 'localtime') AS sday FROM visit_services WHERE visit_id = 40 ORDER BY id`).all();
    assert.equal(lines.length, expect, 'строки визита не заведены: ' + JSON.stringify(lines));
    const inv = getRpc('create_invoice_for_visit')(DB, { visit_id: 40, visit_service_ids: lines.map((r) => r.id) }, USER);
    return { shown, total, lines, picks, billed: Number(inv.invoice.total_amount), rail, ctaOk };
}
const brief = (r) => JSON.stringify({ shown: r.shown, billed: r.billed, rail: r.rail, lines: r.lines });

// ---- 1. Смета = строка = счёт: исполнитель, которого запишет окно -----------
//
// Кабинет врача записывает строке без выбранного врача врача приёма
// (addOwnService → linePerformer), и счёт берёт его свою цену. Смета считала
// строку без врача — по прайсу: 50 000 в смете, 80 000 в строке и в счёте.

test('кабинет: УЗИ у двух врачей, врача не выбрали — смета по врачу приёма (своя цена 80 000), как строка и счёт', async () => {
    const r = await run({ window: 'cabinet', add: ['УЗИ'], ownPrice: 80000, twoPerformers: true, visitDoctor: 5 });
    assert.equal(r.picks[0].doctor, null, 'проверка о строке без выбранного врача');
    assert.deepEqual([r.shown, r.lines[0].doctor_id, r.lines[0].unit_price, r.billed], [80000, 5, 80000, 80000], brief(r));
});

test('кабинет: то же на повторном визите — своя цена врача приёма со скидкой яруса (80 000 × 20 000 / 50 000 = 32 000)', async () => {
    const r = await run({ window: 'cabinet', add: ['УЗИ'], ownPrice: 80000, twoPerformers: true, visitDoctor: 5, repeat: true, uziTier: true });
    assert.deepEqual([r.shown, r.lines[0].unit_price, r.billed], [32000, 32000, 32000], brief(r));
});

test('кабинет (контроль): анализ врач приёма не делает (linePerformer) — смета по прайсу, как строка без исполнителя и счёт', async () => {
    const r = await run({ window: 'cabinet', add: ['ОАК'], ownPrice: 80000, visitDoctor: 5 });
    assert.deepEqual([r.shown, r.lines[0].doctor_id, r.lines[0].unit_price, r.billed], [100000, null, 100000, 100000], brief(r));
});

test('окно визита (контроль): врача УЗИ каталог ставит сам — смета, строка и счёт по его своей цене', async () => {
    const r = await run({ window: 'visit', add: ['УЗИ'], ownPrice: 80000 });
    assert.equal(r.picks[0].doctor && r.picks[0].doctor.id, 5);
    assert.deepEqual([r.shown, r.lines[0].doctor_id, r.lines[0].unit_price, r.billed], [80000, 5, 80000, 80000], brief(r));
});

test('кабинет передаёт каталогу исполнителя по умолчанию — врача приёма, того же, кого запишет addOwnService', () => {
    const src = fs.readFileSync(path.join(HERE, '..', 'views', 'service-workspace.js'), 'utf8').replace(/\/\/[^\n]*/g, '');
    const card = src.match(/function servicesCard\(ctx\)[\s\S]*?\n\}/);
    assert.ok(card, 'servicesCard не найден');
    assert.match(card[0], /defaultPerformerId:\s*ctx\.patient\?\.__service\?\.doctorId\s*\|\|\s*null/);
    assert.match(src, /linePerformer\(svc,\s*doctor\?\.id,\s*ctx\.patient\?\.__service\?\.doctorId\)/, 'addOwnService записывает другого исполнителя');
});

// ---- 2. Время строки — в день визита -------------------------------------
//
// Дни каталога начинались с сегодня, и услуге одного врача каталог сам ставил
// ближайшее свободное время — сегодня на визите завтра: строка ложилась
// (scheduled_at) и получала талон очереди на другой день, чем её визит. В окне
// на существующем визите время — только в день визита; окно без брони
// (requireSlot: false — кабинет врача, быстрая регистрация) время не ставит
// вовсе: addOwnService его и не пишет.

/** Талоны очереди по строкам визита — как их выдаёт касса / регистратура. */
function queueLines(lines) {
    getRpc('issue_queue_numbers')(DB, { p_ids: lines.map((l) => l.id) }, ADMIN);
    return DB.prepare(`SELECT id, queue_key, date(scheduled_at, 'localtime') AS sday FROM visit_services WHERE visit_id = 40 ORDER BY id`).all();
}
const visitDay = () => DB.prepare("SELECT date(visit_date, 'localtime') AS d FROM visits WHERE id = 40").get().d;

test('окно визита: визит завтра, врач свободен и сегодня — время ставится на день визита; строка и талон — в день визита', async () => {
    busyDays.clear();
    const r = await run({ window: 'visit', add: ['УЗИ'], visitOffset: 1 });
    const vday = visitDay();
    assert.equal(vday, ymd(dayAt(1)));
    assert.ok(r.picks[0].startISO, 'время не поставлено');
    assert.equal(r.lines[0].sday, vday, 'строка легла на другой день: ' + brief(r));
    const q = queueLines(r.lines);
    assert.ok(q.every((l) => String(l.queue_key || '').endsWith(vday)), 'талон на другой день: ' + JSON.stringify(q));
    assert.doesNotMatch(r.rail, /сегодня/, 'в смете «сегодня» у времени завтрашнего визита: ' + r.rail);
});

test('окно визита: визит завтра, врач сегодня занят — время в день визита', async () => {
    busyDays.clear(); busyDays.add(ymd(dayAt(0)));
    try {
        const r = await run({ window: 'visit', add: ['УЗИ'], visitOffset: 1 });
        assert.equal(r.lines[0].sday, visitDay(), brief(r));
    } finally { busyDays.clear(); }
});

test('окно визита: визит завтра, врач занят в день визита — время на другой день не ставится; строка не уходит без времени', async () => {
    busyDays.clear(); busyDays.add(ymd(dayAt(1)));
    try {
        const r = await run({ window: 'visit', add: ['УЗИ'], visitOffset: 1, noSave: true });
        assert.equal(r.ctaOk, false, 'строка без времени ушла бы в визит: ' + r.rail);
        assert.doesNotMatch(r.rail, /\d{2}:\d{2}/, 'время на другой день: ' + r.rail);
        // День в выборе времени один — день визита.
        const days = byClass(r.top, 'wzc-day').map(textOf);
        assert.equal(days.length, 1, 'дни выбора: ' + JSON.stringify(days));
        assert.match(days[0], new RegExp('\\b' + dayAt(1).getDate() + '\\b'));
    } finally { busyDays.clear(); }
});

test('кабинет врача (без брони): визит завтра — каталог времени не ставит, строка без времени', async () => {
    busyDays.clear();
    const r = await run({ window: 'cabinet', add: ['УЗИ'], visitOffset: 1 });
    assert.equal(r.picks[0].doctor && r.picks[0].doctor.id, 5, 'врач по-прежнему подставлен');
    assert.equal(r.picks[0].startISO, null, 'время, которое кабинет не запишет: ' + r.picks[0].startISO);
    assert.doesNotMatch(r.rail, /\d{2}:\d{2}/, r.rail);
    assert.equal(r.lines[0].scheduled_at, null);
});

test.after(() => { if (DB) DB.close(); DB = null; });
