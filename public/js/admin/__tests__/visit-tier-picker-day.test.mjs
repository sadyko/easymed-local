// VISIT_TIER_ON_JOIN_V1 (3.23.0, поток G) — КАЛЬКУЛЯТОР УСЛУГ СЧИТАЕТ ЦЕНУ ВИЗИТА ПО ДНЮ
// САМОГО ВИЗИТА.
//
// Владелец: «applied price changes in the service settings not applying». Цена второго и
// повторного визита (VISIT_TIER_PRICING_V1) зависит от того, сколько дней прошло с прошлого
// визита по этой услуге ДО ДНЯ НОВОГО ВИЗИТА. Мастер визита спрашивает котировку на день
// строки (date), кабинет врача и окно визита — на визит (visit_id), сервер (касса, запись
// колл-центра, зеркало заявки) — на день визита без самого визита. Калькулятор услуг
// (service-picker-modal.js) спрашивал БЕЗ дня — на сегодня, а строку писал на день записи:
//   • прошлый визит 2 дня назад, окно второго визита 3–5 дн., запись на завтра (3 дня) —
//     второй визит, а калькулятор писал первичный: 80 000 вместо 20 000;
//   • прошлый визит 5 дней назад, запись на завтра (6 дней — окно прошло) — первичный, а
//     калькулятор писал второй: 20 000 вместо 80 000;
//   • «Добавить услуги к визиту» на визите другого дня (окно визита) — то же, и строки
//     самого визита считались «прошлым визитом».
// Ярус пишется в строку, и касса выставляет счёт по нему — ошибка доходила до денег.
//
// Стенд — как у pick-day-calculator.test.mjs: поддельный DOM, /api/db и /api/rpc —
// настоящие сервер и база в памяти; calendar_slots — врач УЗИ свободен в 10:00 каждый день,
// busyToday — сегодня занят («Ближайшее» — завтра).
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
const TOASTS = [];
const TOAST_EL = new FakeNode('div');
Object.defineProperty(TOAST_EL, 'textContent', { get() { return ''; }, set(v) { TOASTS.push(String(v)); }, configurable: true });
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
const settle = async (ms = 120) => { await new Promise((r) => setTimeout(r, ms)); };

process.env.LIS_ENABLED = '0';
const { openDb } = await import('../../../../server/db/connection.js');
const { migrate } = await import('../../../../server/db/migrate.js');
const { compile } = await import('../../../../server/db/query-compiler.js');
const { readableColumns, jsonColumns } = await import('../../../../server/db/schema-registry.js');
const { getRpc } = await import('../../../../server/services/rpc/index.js');
const { stampWriteBody } = await import('../../../../server/services/domain/package-lines.js');

const ymd = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const dayAt = (off, hh = 0, mm = 0) => { const d = new Date(); d.setHours(hh, mm, 0, 0); d.setDate(d.getDate() + off); return d; };

const USER = { id: 1, role: 'registrar', extra_roles: [] };
let DB = null;
let busyToday = false;
const QUOTES = [];
globalThis.fetch = async (url, opts) => {
    const u = String(url);
    const body = JSON.parse((opts && opts.body) || '{}');
    const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }), headers: { getSetCookie: () => [] } });
    const fail = (status, message) => ({ ok: false, status, json: async () => ({ error: { code: 'bad_request', message } }), headers: { getSetCookie: () => [] } });
    if (u === '/api/rpc/calendar_slots') {
        if (busyToday && body.date === ymd(new Date())) return ok({ date: body.date, slots: [], busy: [] });
        return ok({ date: body.date, slots: [{ start: '10:00', end: '10:30' }], busy: [] });
    }
    if (u === '/api/rpc/service_price_quote') QUOTES.push(body);
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

const { openServicePickerModal, forgetSlots } = await import('../views/service-picker-modal.js?v=ownrep4');

// Визит сервер находит по местному дню SQLite, а смета — по часам JS. Предзагрузка tz-late
// двигает только пояс JS: дни расходятся, проверки дней здесь не имеют смысла (как в
// pick-day-calculator.test.mjs).
const TZ_SPLIT = (() => {
    const db = openDb(':memory:');
    const iso = '2030-01-07T00:30:00Z';
    const sql = db.prepare("SELECT strftime('%Y-%m-%d %H:%M', ?, 'localtime') AS v").get(iso).v;
    db.close();
    const d = new Date(iso);
    const js = `${ymd(d)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    return sql === js ? false : 'пояс JS не совпадает с поясом SQLite (предзагрузка tz-late) — дни визитов не сверить';
})();

// УЗИ владельца: первый 80 000, второй 20 000 через 3–5 дн., повторный 10 000 через 6–10 дн.
const TIER = { price_secondary: 20000, secondary_days_from: 3, secondary_days_to: 5, price_repeat: 10000, repeat_days_from: 6, repeat_days_to: 10 };
function seed() {
    const db = openDb(':memory:');
    migrate(db);
    db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (1,'reg','x','Регистратор','registrar')").run();
    db.prepare("INSERT INTO patients (id, mrn, full_name) VALUES (3,'P-3','Тестов Тест')").run();
    const t = db.prepare('SELECT id FROM service_types ORDER BY id LIMIT 1').get().id;
    db.prepare(`INSERT INTO services (id, name, price, type_id, type, active, requires_doctor, code, price_secondary, secondary_days_from, secondary_days_to, price_repeat, repeat_days_from, repeat_days_to)
                VALUES (22,'УЗИ брюшной полости',80000,?,'imaging',1,1,'S-22',@price_secondary,@secondary_days_from,@secondary_days_to,@price_repeat,@repeat_days_from,@repeat_days_to)`.replace('?', String(t))).run(TIER);
    db.prepare(`INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, service_rates)
                VALUES (5,'uzi','x','Узистов Улугбек','doctor',1,'[{"service_id":22,"pct":10}]')`).run();
    if (DB) DB.close();
    DB = db;
}
/** Прошлый визит пациента по УЗИ: `daysAgo` местных дней назад, строка выполнена, ярус первичный. */
function pastUzi(daysAgo, tier = 'primary') {
    const at = dayAt(-daysAgo, 10, 0);
    const vid = Number(DB.prepare("INSERT INTO visits (patient_id, visit_date, doctor_id, status, created_by) VALUES (3, ?, 5, 'arrived', 1)").run(at.toISOString()).lastInsertRowid);
    DB.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, price_tier, created_by) VALUES (?, 22, 5, 1, 80000, 80000, 'completed', ?, 1)").run(vid, tier);
    return vid;
}

const PATIENT = { id: 3, fullName: 'Тестов Тест', lastName: 'Тестов', firstName: 'Тест', mrn: 'P-3', phone: '' };
const top = () => BODY.children[BODY.children.length - 1];
const addOf = (name) => byClass(top(), 'wzc-svc').filter((r) => textOf(r).includes(name)).map((r) => byClass(r, 'wzc-add')[0]).find(Boolean);
const ctaReady = () => byClass(top(), 'wzc-cta')[0] && byClass(top(), 'wzc-cta')[0].disabled === false;
/** Строка сметы УЗИ: её чип яруса и цена. */
function smetaLine() {
    const ln = byClass(top(), 'wzc-ln').find((r) => textOf(r).includes('УЗИ брюшной полости'));
    assert.ok(ln, 'строки УЗИ нет в смете');
    const chip = byClass(ln, 'wzc-tier')[0];
    const nums = walk(ln).filter((n) => n.tagName === 'SPAN' && String(n.className).includes('num'));
    const price = nums.length ? Number(textOf(nums[nums.length - 1]).replace(/\D/g, '')) : null;
    return { chip: chip ? textOf(chip).trim() : null, price };
}
const btnText = (root, text) => walk(root).find((n) => n.tagName === 'BUTTON' && n.style.display !== 'none' && textOf(n).includes(text));
async function saveCalcFlow() {
    await until(ctaReady, 'смета готова');
    byClass(top(), 'wzc-cta')[0].click();
    await until(() => btnText(top(), 'Далее →'), 'шаг «Направление»');
    btnText(top(), 'Далее →').click();
    await until(() => btnText(top(), 'Создать визит'), 'шаг «Подтверждение»');
    btnText(top(), 'Создать визит').click();
    await until(() => DB.prepare('SELECT COUNT(*) n FROM visit_services WHERE status = ?').get('added').n > 0, 'строка не легла: ' + JSON.stringify(TOASTS));
    await settle(200);
}
/** Калькулятор на пациента; УЗИ в смету; сегодня врач занят — «Ближайшее» (завтра). */
async function openCalcWithUzi({ tomorrow = false } = {}) {
    forgetSlots();
    BODY.children.length = 0; TOASTS.length = 0; QUOTES.length = 0;
    busyToday = tomorrow;
    openServicePickerModal({ calculator: true, title: 'Калькулятор услуг', onPick: () => {}, patient: PATIENT });
    await until(() => addOf('УЗИ брюшной полости'), 'строка УЗИ в каталоге');
    addOf('УЗИ брюшной полости').click();
    if (tomorrow) {
        await until(() => byAttr(top(), 'data-pick-nearest', 22), 'кнопка «Ближайшее»');
        byAttr(top(), 'data-pick-nearest', 22).click();
    }
    await until(ctaReady, 'смета готова');
    await settle(200);   // ответ котировки
}
const savedLine = () => DB.prepare("SELECT vs.price_tier, vs.unit_price, v.visit_date FROM visit_services vs JOIN visits v ON v.id = vs.visit_id WHERE vs.service_id = 22 AND vs.status = 'added'").get();
const invoicedUzi = () => DB.prepare('SELECT unit_price FROM invoice_items WHERE service_id = 22').get();

// ═══════════════════════════════════════════════════════════════════════════
// Сегодня — как было: настоящий второй визит, чип и цена второго визита, строка и счёт
// ═══════════════════════════════════════════════════════════════════════════
test('калькулятор, запись сегодня, прошлый УЗИ 4 дня назад (окно 3–5): чип «Второй визит», 20 000; строка и счёт — 20 000, ярус «второй»', { skip: TZ_SPLIT }, async () => {
    try {
        seed();
        pastUzi(4);
        await openCalcWithUzi();
        assert.deepEqual(smetaLine(), { chip: 'Второй визит', price: 20000 });
        await saveCalcFlow();
        const line = savedLine();
        assert.deepEqual([line.price_tier, line.unit_price], ['secondary', 20000]);
        const inv = invoicedUzi();
        assert.ok(inv, 'счёт не выставлен: ' + JSON.stringify(TOASTS));
        assert.equal(inv.unit_price, 20000, 'счёт — не по ярусу строки');
    } finally { busyToday = false; }
});

test('калькулятор, запись сегодня, прошлый УЗИ 2 дня назад (раньше окна 3–5): первичный, 80 000, без чипа', { skip: TZ_SPLIT }, async () => {
    try {
        seed();
        pastUzi(2);
        await openCalcWithUzi();
        assert.deepEqual(smetaLine(), { chip: null, price: 80000 });
    } finally { busyToday = false; }
});

// ═══════════════════════════════════════════════════════════════════════════
// Запись на другой день — котировка на день визита
// ═══════════════════════════════════════════════════════════════════════════
test('калькулятор, запись на ЗАВТРА, прошлый УЗИ 2 дня назад: к визиту — 3 дня, второй визит: чип и 20 000; строка «второй», 20 000', { skip: TZ_SPLIT }, async () => {
    try {
        seed();
        pastUzi(2);
        await openCalcWithUzi({ tomorrow: true });
        assert.ok(byAttr(top(), 'data-visit-day', ymd(dayAt(1))), 'визит не на завтра');
        assert.deepEqual(smetaLine(), { chip: 'Второй визит', price: 20000 }, 'котировка на сегодня, а визит завтра');
        assert.ok(QUOTES.some((q) => q.date === ymd(dayAt(1))), 'котировка не спрошена на день визита: ' + JSON.stringify(QUOTES));
        await saveCalcFlow();
        const line = savedLine();
        assert.equal(ymd(new Date(line.visit_date)), ymd(dayAt(1)));
        assert.deepEqual([line.price_tier, line.unit_price], ['secondary', 20000], 'строка записана с ярусом сегодняшнего дня');
    } finally { busyToday = false; }
});

test('калькулятор, запись на ЗАВТРА, прошлый УЗИ 5 дней назад: к визиту — 6 дней, окно прошло: первичный, 80 000; строка «первичный»', { skip: TZ_SPLIT }, async () => {
    try {
        seed();
        pastUzi(5);
        await openCalcWithUzi({ tomorrow: true });
        assert.deepEqual(smetaLine(), { chip: null, price: 80000 }, 'смета дала скидку второго визита на визит после окна');
        await saveCalcFlow();
        const line = savedLine();
        assert.notEqual(line.price_tier, 'secondary', 'строка «второй визит» на визит после окна — счёт 20 000 вместо 80 000');
        assert.equal(line.unit_price, 80000);
    } finally { busyToday = false; }
});

// ═══════════════════════════════════════════════════════════════════════════
// «Добавить услуги к визиту» (окно визита) — котировка на день ЭТОГО визита, без его строк
// ═══════════════════════════════════════════════════════════════════════════
test('окно визита на ЗАВТРА: прошлый УЗИ 2 дня назад — onPick получает ярус «второй» и 20 000; котировка — на день визита, сам визит исключён', { skip: TZ_SPLIT }, async () => {
    seed();
    pastUzi(2);
    const at = dayAt(1, 10, 0);
    const vid = Number(DB.prepare("INSERT INTO visits (patient_id, visit_date, doctor_id, status, created_by) VALUES (3, ?, 5, 'scheduled', 1)").run(at.toISOString()).lastInsertRowid);
    forgetSlots();
    BODY.children.length = 0; TOASTS.length = 0; QUOTES.length = 0;
    const picks = [];
    openServicePickerModal({
        attachMode: true, title: 'Добавить услуги к визиту', patient: PATIENT, patientId: 3,
        visitId: vid, initialDateIso: ymd(at), packageDay: at.toISOString(), showSchedule: true,
        onPick: async (p) => { picks.push(p); },
    });
    await until(() => addOf('УЗИ брюшной полости'), 'строка УЗИ в каталоге');
    addOf('УЗИ брюшной полости').click();
    await until(ctaReady, 'смета готова');
    await settle(200);
    assert.deepEqual(smetaLine(), { chip: 'Второй визит', price: 20000 });
    const q = QUOTES[QUOTES.length - 1];
    assert.equal(q.date, ymd(at), 'котировка не на день визита');
    assert.equal(Number(q.visit_id), vid, 'строки самого визита считаются «прошлым визитом»');
    byClass(top(), 'wzc-cta')[0].click();
    await until(() => picks.length > 0, 'onPick не позван');
    assert.deepEqual([picks[0].price_tier, picks[0].unit_price], ['secondary', 20000]);
});

test('окно визита на ЗАВТРА: в визите уже есть УЗИ (записан) — она не «прошлый визит»; прошлого нет — первичный, 80 000', { skip: TZ_SPLIT }, async () => {
    seed();
    const at = dayAt(1, 10, 0);
    const vid = Number(DB.prepare("INSERT INTO visits (patient_id, visit_date, doctor_id, status, created_by) VALUES (3, ?, 5, 'scheduled', 1)").run(at.toISOString()).lastInsertRowid);
    DB.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, price_tier, created_by) VALUES (?, 22, 5, 1, 80000, 80000, 'added', 'primary', 1)").run(vid);
    // «Не раньше чем через 0» — второй визит в тот же день тоже считается: строка самого
    // визита дала бы «второй визит», если бы её считали прошлым.
    DB.prepare('UPDATE services SET secondary_days_from = 0 WHERE id = 22').run();
    forgetSlots();
    BODY.children.length = 0; TOASTS.length = 0; QUOTES.length = 0;
    openServicePickerModal({
        attachMode: true, title: 'Добавить услуги к визиту', patient: PATIENT, patientId: 3,
        visitId: vid, initialDateIso: ymd(at), packageDay: at.toISOString(), showSchedule: true,
        onPick: async () => {},
    });
    await until(() => addOf('УЗИ брюшной полости'), 'строка УЗИ в каталоге');
    addOf('УЗИ брюшной полости').click();
    await until(ctaReady, 'смета готова');
    await settle(200);
    assert.deepEqual(smetaLine(), { chip: null, price: 80000 }, 'строка самого визита стала «прошлым визитом»');
});

// ═══════════════════════════════════════════════════════════════════════════
// Кабинет врача (ревью потока G): каталог приёма — attachMode без брони времени, день и
// визит приёма. Приём 3 дня назад: смета — на день приёма, строки самого приёма не в счёт.
// Строку пишет addOwnService (visit-tier-cabinet.test.mjs) — той же котировкой.
// ═══════════════════════════════════════════════════════════════════════════
async function openCabinetPicker(visitDaysAgo) {
    const at = dayAt(-visitDaysAgo, 10, 0);
    const vid = Number(DB.prepare("INSERT INTO visits (patient_id, visit_date, doctor_id, status, created_by) VALUES (3, ?, 5, 'arrived', 1)").run(at.toISOString()).lastInsertRowid);
    forgetSlots();
    BODY.children.length = 0; TOASTS.length = 0; QUOTES.length = 0;
    const picks = [];
    openServicePickerModal({
        attachMode: true, requireSlot: false, title: 'Добавить услуги к приёму', ctaLabel: 'Добавить к приёму',
        patient: PATIENT, visitDoctorId: 5, defaultPerformerId: 5, packageDay: at.toISOString(), visitId: vid,
        onPick: async (p) => { picks.push(p); },
    });
    await until(() => addOf('УЗИ брюшной полости'), 'строка УЗИ в каталоге');
    addOf('УЗИ брюшной полости').click();
    await until(ctaReady, 'смета готова');
    await settle(200);
    return { vid, at, picks };
}

test('кабинет: приём 3 дня назад, прошлый УЗИ 7 дней назад (к приёму 4 дня) — смета «Второй визит» 20 000, onPick — «второй», 20 000', { skip: TZ_SPLIT }, async () => {
    seed();
    pastUzi(7);
    const { vid, at, picks } = await openCabinetPicker(3);
    assert.deepEqual(smetaLine(), { chip: 'Второй визит', price: 20000 });
    const q = QUOTES[QUOTES.length - 1];
    assert.deepEqual([q.date, Number(q.visit_id)], [ymd(at), vid]);
    byClass(top(), 'wzc-cta')[0].click();
    await until(() => picks.length > 0, 'onPick не позван');
    assert.deepEqual([picks[0].price_tier, picks[0].unit_price], ['secondary', 20000]);
});

test('кабинет: приём 3 дня назад, прошлый УЗИ 4 дня назад (к приёму 1 день) — смета первичный, 80 000', { skip: TZ_SPLIT }, async () => {
    seed();
    pastUzi(4);
    await openCabinetPicker(3);
    assert.deepEqual(smetaLine(), { chip: null, price: 80000 });
});

test.after(() => { if (DB) DB.close(); DB = null; });
