// SERVICES_PACKAGES_V1 (ревью шага 6, C2) — окно визита «Добавить услуги»
// (каталог в attachMode, параметры visit-modal.js) на визит в БУДУЩЕМ, пакет
// действует с дня визита, строки пакета — без врача и времени (анализы).
//
// Смета брала день пакета из cartVisitDateIso(): без строки с врачом и
// временем — «сегодня 09:00», а не день визита (packageDay). Сегодня пакет ещё
// не действует — смета считала обычную цену (или цену яруса «Повторный
// визит»), а дверь /api/db ставила цену пакета по дню визита, и счёт выходил
// другим: 150 000 в смете — 120 000 в счёте; на повторном визите 80 000 — 120 000
// (пациенту назвали меньше, чем выставили).
//
// Повторная проверка (ревью исправлений шага 6): то же, когда у строки ЕСТЬ
// время. Услугу одного врача каталог сам ставит на ближайшее свободное время —
// а дни каталога начинаются с СЕГОДНЯ (catDays), не с дня визита, и строка
// получала время сегодня на визите завтра. Смета брала день пакета из этого
// времени, а сервер ставит и выставляет цену пакета по дню визита. В окне на
// визите день пакета — день визита (packageDay); кабинет врача теперь тоже
// передаёт день своего визита.
//
// Стенд — поддельный DOM; /api/db и /api/rpc — настоящие сервер и дверь в
// памяти: отказ пакета вне срока (packageStampRefusal) и цена пакета на строке
// (stampWriteBody), как routes/db.js; calendar_slots — врач свободен с 10:00
// каждый день (или занят сегодня).
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
let DB = null;
let busyToday = false;
globalThis.fetch = async (url, opts) => {
    const u = String(url);
    const body = JSON.parse((opts && opts.body) || '{}');
    const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }), headers: { getSetCookie: () => [] } });
    const fail = (status, message) => ({ ok: false, status, json: async () => ({ error: { code: 'bad_request', message } }), headers: { getSetCookie: () => [] } });
    if (u === '/api/rpc/calendar_slots') {
        // Врач УЗИ свободен с 10:00 каждый день; busyToday — сегодня занят (время уедет на завтра).
        if (busyToday && body.date === ymd(new Date())) return ok({ date: body.date, slots: [], busy: [] });
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

const ymd = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const NOW = new Date();
const dayAt = (off) => new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + off, 12, 0, 0);

// ОАК 100 000 + глюкоза 50 000 = 150 000; пакет 20 % → 120 000 (96 000 + 24 000 — по 1 000 и 100 сум).
// timed — вторая услуга не глюкоза, а УЗИ (50 000) у ОДНОГО врача: каталог сам ставит ему время.
function seed({ visitOffset, pkgFromOffset, pkgUntilOffset = 40, repeat = false, timed = false }) {
    const db = openDb(':memory:');
    migrate(db);
    db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (1,'reg','x','Регистратор','registrar')").run();
    db.prepare("INSERT INTO patients (id, mrn, full_name) VALUES (3,'P-3','Иванов Иван')").run();
    const lab = db.prepare('SELECT id FROM service_types ORDER BY id LIMIT 1').get().id;
    if (timed) {
        db.prepare("INSERT INTO services (id, name, price, type_id, type, active, requires_doctor, code) VALUES (21,'ОАК',100000,?,'lab',1,0,'S-21'), (22,'УЗИ',50000,?,'imaging',1,1,'S-22')").run(lab, lab);
        db.prepare(`INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, service_rates)
                    VALUES (5,'uzi','x','Узистов Улугбек','doctor',1,'[{"service_id":22,"pct":10}]')`).run();
    } else {
        db.prepare("INSERT INTO services (id, name, price, type_id, type, active, requires_doctor, code) VALUES (21,'ОАК',100000,?,'lab',1,0,'S-21'), (22,'Глюкоза',50000,?,'lab',1,0,'S-22')").run(lab, lab);
    }
    db.prepare(`INSERT INTO service_templates (id, name, service_ids, discount_percent, is_package, discount_mode, discount_value, valid_from, valid_until, active)
                VALUES (9, 'Чек-ап', '[21,22]', 20, 1, 'percent', 20, ?, ?, 1)`).run(ymd(dayAt(pkgFromOffset)), ymd(dayAt(pkgUntilOffset)));
    db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (40, 3, ?, 'scheduled')").run(dayAt(visitOffset).toISOString());
    if (repeat) {
        // Ярус «Повторный визит»: ОАК на повторном (0..30 дн.) — 30 000; прошлый визит 3 дня назад.
        db.prepare('UPDATE services SET price_secondary = 30000, secondary_days_from = 0, secondary_days_to = 30 WHERE id = 21').run();
        const pv = db.prepare("INSERT INTO visits (patient_id, visit_date, status) VALUES (3, ?, 'arrived')").run(dayAt(-3).toISOString()).lastInsertRowid;
        db.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status, price_tier) VALUES (?, 21, 1, 100000, 100000, 'completed', 'primary')").run(pv);
    }
    if (DB) DB.close();
    DB = db;
}

/**
 * Смета окна и счёт по тем же строкам: { shown, billed, lines }. cabinet —
 * кабинет врача: параметры каталога и запись строк — как у карточки «Услуги
 * приёма» (service-workspace.js servicesCard → addOwnService); день визита
 * кабинет берёт из строки «Мои услуги» (__service.visitDate, consultation.js).
 */
async function quoteAndBill(opts) {
    seed(opts);
    forgetSlots();
    BODY.children.length = 0;
    const picks = [];
    const visit = DB.prepare('SELECT * FROM visits WHERE id = 40').get();
    const patient = { id: 3, fullName: 'Иванов Иван', lastName: 'Иванов', firstName: 'Иван', mrn: 'P-3', phone: '',
        __service: { id: 900, doctorId: null, visitId: 40, visitDate: visit.visit_date } };
    openServicePickerModal(opts.cabinet
        // Как service-workspace.js servicesCard.
        ? { attachMode: true, requireSlot: false, patient, visitDoctorId: null, title: 'Добавить услуги к приёму', ctaLabel: 'Добавить к приёму',
            packageDay: patient.__service.visitDate, excludeServiceIds: [], onPick: (p) => { picks.push(p); } }
        // Как окно визита (visit-modal.js, «Добавить услуги к визиту»).
        : { attachMode: true, title: 'Добавить услуги к визиту', patient,
            visitDoctorId: null, showSchedule: true, patientId: 3, visitId: 40,
            initialDateIso: ymd(new Date(visit.visit_date)), packageDay: visit.visit_date, excludeServiceIds: [],
            onPick: (p) => { picks.push(p); } });
    const top = () => BODY.children[BODY.children.length - 1];
    const btn = (re) => walk(top()).find((e) => e.tagName === 'BUTTON' && re.test(textOf(e)));
    await until(() => btn(/Выбрать шаблон/), 'кнопка «Выбрать шаблон»');
    btn(/Выбрать шаблон/).click();
    await until(() => btn(/Чек-ап/), 'пакет в списке на день визита');
    btn(/Чек-ап/).click();
    await until(() => byClass(top(), 'wzc-ln').length === 2, 'две строки сметы');
    await new Promise((r) => setTimeout(r, 250));   // цены яруса доезжают
    const tot = byClass(top(), 'wzc-tot').map(textOf);
    const shown = digits(tot[tot.length - 1].replace(/^.*?(Итого|К оплате)/, ''));
    if (opts.noSave) return { shown, ctaOk: !byClass(top(), 'wzc-cta')[0].disabled, rail: byClass(top(), 'wzc-ln').map(textOf).join(' | ') };
    byClass(top(), 'wzc-cta')[0].click();
    await until(() => picks.length === 2, 'обе строки ушли в onPick');
    if (opts.cabinet) {
        const ctx = { visitId: 40, visitServiceId: 900, patient, container: null };
        WS.activateWorkspace(ctx);   // как при открытии приёма: состояние кабинета — этой строки
        for (const p of picks) await WS.addOwnService(ctx, p.service, p.doctor, p.package);
    } else {
        const state = { visit, patient: { id: 3 }, services: [] };
        for (const p of picks) await VM.addServiceFromPicker(state, p, () => {});
    }
    const vs = DB.prepare('SELECT id, service_id, scheduled_at, package_id FROM visit_services WHERE visit_id = 40 ORDER BY id').all();
    assert.equal(vs.length, 2, 'строки визита не заведены');
    assert.ok(vs.every((r) => Number(r.package_id) === 9), 'строки без пакета: ' + JSON.stringify(vs));
    const inv = getRpc('create_invoice_for_visit')(DB, { visit_id: 40, visit_service_ids: vs.map((r) => r.id) }, USER);
    return { shown, billed: Number(inv.invoice.total_amount), lines: vs, picks };
}

test('визит завтра, пакет с завтра, строки без врача и времени: смета — цена пакета, как счёт', async () => {
    const r = await quoteAndBill({ visitOffset: 1, pkgFromOffset: 1 });
    assert.deepEqual([r.shown, r.billed], [120000, 120000], 'смета ' + r.shown + ', счёт ' + r.billed);
});

test('то же на повторном визите (ярус): смета не называет цену яруса, которую счёт не возьмёт', async () => {
    const r = await quoteAndBill({ visitOffset: 1, pkgFromOffset: 1, repeat: true });
    assert.equal(r.shown, r.billed, 'смета ' + r.shown + ', счёт ' + r.billed);
    assert.equal(r.billed, 120000);
});

test('контроль: визит завтра, пакет действует с сегодня — смета = счёт', async () => {
    const r = await quoteAndBill({ visitOffset: 1, pkgFromOffset: 0 });
    assert.deepEqual([r.shown, r.billed], [120000, 120000]);
});

// --- Строки со временем: каталог сам поставил врачу УЗИ ближайшее время ---------

test('время строки — сегодня, визит завтра, пакет с завтра: смета — по дню визита, как счёт', async () => {
    const r = await quoteAndBill({ visitOffset: 1, pkgFromOffset: 1, timed: true });
    assert.ok(r.picks.some((p) => p.service && p.service.id === 22 && p.startISO), 'каталог не поставил УЗИ время — проверка не о том');
    assert.deepEqual([r.shown, r.billed], [120000, 120000], 'смета ' + r.shown + ', счёт ' + r.billed);
});

test('то же на повторном визите (ярус): пациенту не называют 80 000 при счёте 120 000', async () => {
    const r = await quoteAndBill({ visitOffset: 1, pkgFromOffset: 1, timed: true, repeat: true });
    assert.deepEqual([r.shown, r.billed], [120000, 120000], 'смета ' + r.shown + ', счёт ' + r.billed);
});

// BACKLOG_1011_V1 — время строки в окне визита — только в день визита: занятый
// сегодня врач больше не получает время «на завтра» на сегодняшнем визите (строка
// легла бы на другой день, чем визит). Смету без времени не отправить.
test('визит сегодня, пакет до сегодня, врач УЗИ сегодня занят: времени на завтра нет — смету без времени не отправить', async () => {
    busyToday = true;
    try {
        const r = await quoteAndBill({ visitOffset: 0, pkgFromOffset: -5, pkgUntilOffset: 0, timed: true, repeat: true, noSave: true });
        assert.equal(r.ctaOk, false, 'строка ушла бы без времени: ' + r.rail);
        assert.doesNotMatch(r.rail, /\d{2}:\d{2}/, 'время на другой день: ' + r.rail);
        assert.equal(r.shown, 120000, 'смета — по дню визита (пакет действует): ' + r.rail);
    } finally { busyToday = false; }
});

test('кабинет врача: визит завтра, пакет с завтра, УЗИ у одного врача — смета по дню визита, как счёт', async () => {
    const r = await quoteAndBill({ visitOffset: 1, pkgFromOffset: 1, timed: true, cabinet: true });
    assert.deepEqual([r.shown, r.billed], [120000, 120000], 'смета ' + r.shown + ', счёт ' + r.billed);
});

test('кабинет врача: визит сегодня, пакет до сегодня, врач сегодня занят, повторный визит — смета = счёт', async () => {
    busyToday = true;
    try {
        const r = await quoteAndBill({ visitOffset: 0, pkgFromOffset: -5, pkgUntilOffset: 0, timed: true, repeat: true, cabinet: true });
        assert.deepEqual([r.shown, r.billed], [120000, 120000], 'смета ' + r.shown + ', счёт ' + r.billed);
    } finally { busyToday = false; }
});

test.after(() => { if (DB) DB.close(); DB = null; });
