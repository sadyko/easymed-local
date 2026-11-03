// INVOICE_APPEND_V1 / PICK_DAY_V1 (ревью) — КАЛЬКУЛЯТОР УСЛУГ ЦЕЛИКОМ: от
// сметы до счёта, оплаты балансом, номеров очереди и печати.
//
// M1 — пациент уже стоит в неоплаченном счёте дня, калькулятор добавляет ЭКГ и
//      платит БАЛАНСОМ «не больше сметы». В дописанном счёте это частичная
//      оплата, а record_payment отпускает в очередь все строки счёта — и
//      прежний неоплаченный анализ. Теперь калькулятор просит новый счёт
//      (append: false) и платит ровно его по сумме сервера.
// M2 — дописанный счёт: номера очереди строкам этой сметы калькулятор выдаёт
//      сам, как и при новом счёте (раньше — только через печать счёта), а
//      бумага (весь счёт с сервера) несёт блок очереди.
// m4 — запись из календаря кабинетов (дорожка кабинета, врача нет): день
//      каталога — день, по которому щёлкнули, а не сегодня.
//
// Стенд — как у pick-day-calculator.test.mjs: поддельный DOM, /api/db и
// /api/rpc — настоящие сервер и дверь над SQLite в памяти; calendar_slots —
// врач УЗИ свободен с 10:00 каждый день, busyToday — сегодня занят.
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
    querySelector() { return new FakeNode('div'); }   // окно печати навешивает кнопки на найденные узлы
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
// Печать открывает окно и пишет в него документ: ловим написанное.
const PRINTED = [];
globalThis.window = {
    location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, innerWidth: 1440, innerHeight: 900,
    addEventListener() {}, CLINIC: {}, easymed: { state: { user: null } },
    open: () => ({ document: { open() {}, write(html) { PRINTED.push(String(html)); }, close() {} }, focus() {}, print() {} }),
};
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

const ADMIN = { id: 1, role: 'admin', extra_roles: [] };
let USER = ADMIN;
let DB = null;
let busyToday = false;
let busyOn = null;   // 'ГГГГ-ММ-ДД' — в этот день врач УЗИ занят
const RPC = [];
globalThis.fetch = async (url, opts) => {
    const u = String(url);
    const body = JSON.parse((opts && opts.body) || '{}');
    const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }), headers: { getSetCookie: () => [] } });
    const fail = (status, message, code = 'bad_request', params) => ({ ok: false, status, json: async () => ({ error: { code, message, params } }), headers: { getSetCookie: () => [] } });
    if (u === '/api/rpc/calendar_slots') {
        // Врач УЗИ свободен с 10:00 каждый день; busyToday — сегодня занят.
        if ((busyToday && body.date === ymd(new Date())) || body.date === busyOn) return ok({ date: body.date, slots: [], busy: [] });
        return ok({ date: body.date, slots: [{ start: '10:00', end: '10:30' }], busy: [] });
    }
    if (u.startsWith('/api/rpc/')) {
        const name = decodeURIComponent(u.slice('/api/rpc/'.length));
        RPC.push({ name, body });
        const handler = getRpc(name);
        if (!handler) return fail(501, 'RPC not implemented');
        try { return ok(await handler(DB, body, USER)); } catch (e) { return fail(e.status || 500, e.message, e.code || 'bad_request', e.params); }
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
const { nearestButtonText } = await import('../views/pick-day.js');

const PATIENT = { id: 3, fullName: 'Иванов Иван', lastName: 'Иванов', firstName: 'Иван', mrn: 'P-3', phone: '' };

// ОАК (21) — анализ без врача; УЗИ (22) — нужен врач, назначен один (5);
// ЭКГ (23) — процедура без врача. balance — баланс пациента на старте.
function seed({ balance = 0 } = {}) {
    const db = openDb(':memory:');
    migrate(db);
    db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (1,'adm','x','Администратор','admin')").run();
    db.prepare("INSERT INTO patients (id, mrn, full_name) VALUES (3,'P-3','Иванов Иван')").run();
    const type = db.prepare('SELECT id FROM service_types ORDER BY id LIMIT 1').get().id;
    db.prepare(`INSERT INTO services (id, name, price, type_id, type, active, requires_doctor, is_lab, code) VALUES
        (21,'ОАК',100000,?,'lab',1,0,1,'S-21'), (22,'УЗИ',50000,?,'imaging',1,1,0,'S-22'), (23,'ЭКГ',50000,?,'procedure',1,0,0,'S-23')`).run(type, type, type);
    db.prepare(`INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, service_rates)
                VALUES (5,'uzi','x','Узистов Улугбек','doctor',1,'[{"service_id":22,"pct":10}]')`).run();
    if (balance > 0) {
        const tok = db.prepare('INSERT INTO ledger_write_token DEFAULT VALUES').run().lastInsertRowid;   // строки с деньгами пишет только сервер (мигр. 160)
        db.prepare("INSERT INTO patient_deposits (patient_id, amount, status, kind) VALUES (3, ?, 'received', 'credit')").run(balance);
        db.prepare('DELETE FROM ledger_write_token WHERE id = ?').run(tok);
    }
    if (DB) DB.close();
    DB = db;
    RPC.length = 0; TOASTS.length = 0; PRINTED.length = 0;
    return db;
}

/** Сегодня пациент уже записан на ОАК, счёт выставлен и не оплачен. */
function unpaidLabToday() {
    const at = new Date(); at.setHours(9, 0, 0, 0);
    const vid = Number(DB.prepare("INSERT INTO visits (patient_id, visit_date, status, created_by) VALUES (3, ?, 'arrived', 1)").run(at.toISOString()).lastInsertRowid);
    const lab = Number(DB.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status, created_by) VALUES (?, 21, 1, 100000, 100000, 'added', 1)").run(vid).lastInsertRowid);
    const inv = getRpc('create_invoice_for_visit')(DB, { visit_id: vid, visit_service_ids: [lab] }, USER).invoice;
    return { vid, lab, inv };
}

const top = () => BODY.children[BODY.children.length - 1];
const addOf = (name) => byClass(top(), 'wzc-svc').filter((r) => textOf(r).includes(name)).map((r) => byClass(r, 'wzc-add')[0]).find(Boolean);
const buttonWith = (text) => walk(top()).find((n) => n.tagName === 'BUTTON' && n.style.display !== 'none' && textOf(n).includes(text));

function openCalc(extra = {}) {
    forgetSlots();
    BODY.children.length = 0;
    openServicePickerModal({ calculator: true, title: 'Калькулятор услуг', onPick: () => {}, patient: PATIENT, ...extra });
}

/**
 * Смета готова → «Далее: Направление» → «Далее →» (самооплата пропускает «Кто
 * платит») → «Создать визит и счёт». Визит дня с работой уже есть — сервер
 * отказывает day_visit_busy, окно спрашивает «Добавить в этот визит» — да.
 */
async function saveCalc() {
    await until(() => byClass(top(), 'wzc-cta')[0] && byClass(top(), 'wzc-cta')[0].disabled === false, 'смета готова');
    byClass(top(), 'wzc-cta')[0].click();
    await until(() => buttonWith('Далее →'), 'шаг «Направление»');
    buttonWith('Далее →').click();
    await until(() => buttonWith('Создать визит'), 'шаг «Подтверждение»');
    const before = RPC.length;
    buttonWith('Создать визит').click();
    const addToDay = () => walk(BODY).find((n) => n.tagName === 'BUTTON' && textOf(n).includes('Добавить в этот визит'));
    await until(() => addToDay() || RPC.slice(before).some((c) => c.name === 'create_invoice_for_visit'), 'визит дня или счёт');
    if (addToDay()) addToDay().click();
    await until(() => RPC.slice(before).some((c) => c.name === 'create_invoice_for_visit'), 'счёт выставлен: ' + TOASTS.join(' | '));
    await new Promise((r) => setTimeout(r, 300));   // оплата, номера очереди и печать — после счёта
}

const status = (id) => DB.prepare('SELECT status FROM visit_services WHERE id = ?').get(id).status;

test('M1: калькулятор платит балансом — счёт НОВЫЙ по сумме сервера, прежний неоплаченный не тронут, в очередь — только ЭКГ', async () => {
    seed({ balance: 200000 });
    const before = unpaidLabToday();
    openCalc();
    await until(() => addOf('ЭКГ'), 'строка ЭКГ в каталоге');
    addOf('ЭКГ').click();
    await until(() => walk(top()).some((n) => n.tagName === 'LABEL' && textOf(n).includes('Баланс: использовать')), '«Баланс: использовать»');
    const label = walk(top()).find((n) => n.tagName === 'LABEL' && textOf(n).includes('Баланс: использовать'));
    const chk = label.children.find((n) => n.tagName === 'INPUT');
    chk.checked = true;
    chk.dispatchEvent({ type: 'change' });
    await saveCalc();
    const call = RPC.find((c) => c.name === 'create_invoice_for_visit');
    assert.equal(call.body.append, false, 'калькулятор не попросил новый счёт');
    const inv = DB.prepare('SELECT * FROM invoices ORDER BY id').all();
    assert.equal(inv.length, 2, 'ЭКГ дописана в неоплаченный счёт: ' + JSON.stringify(inv.map((i) => [i.invoice_number, i.total_amount, i.paid_amount])));
    assert.deepEqual([inv[0].id, inv[0].total_amount, inv[0].paid_amount, inv[0].status], [before.inv.id, 100000, 0, 'unpaid'], 'прежний счёт тронут');
    assert.deepEqual([inv[1].visit_id, inv[1].total_amount, inv[1].paid_amount, inv[1].status], [before.vid, 50000, 50000, 'paid'], 'новый счёт того же визита оплачен не целиком');
    assert.equal(status(before.lab), 'added', 'неоплаченный ОАК ушёл в очередь');
    const ecg = DB.prepare('SELECT id FROM visit_services WHERE service_id = 23').get().id;
    assert.equal(status(ecg), 'queued');
    assert.equal(getRpc('deposit_balance')(DB, { patient_id: 3 }, USER).balance, 150000, 'с баланса списано не ровно за ЭКГ');
});

test('M2: дописанный счёт — номера очереди строкам этой сметы калькулятор выдаёт сам; на бумаге (весь счёт с сервера) — блок очереди', async () => {
    seed();
    const before = unpaidLabToday();
    openCalc();
    await until(() => addOf('ЭКГ'), 'строка ЭКГ в каталоге');
    addOf('ЭКГ').click();
    await saveCalc();
    await until(() => PRINTED.length > 0, 'счёт напечатан');
    const call = RPC.find((c) => c.name === 'create_invoice_for_visit');
    assert.equal(call.body.append, undefined, 'без баланса и карты — обычное дописывание');
    const inv = DB.prepare('SELECT * FROM invoices ORDER BY id').all();
    assert.equal(inv.length, 1, 'ЭКГ не дописана в неоплаченный счёт');
    assert.equal(inv[0].total_amount, 150000);
    const ecg = DB.prepare('SELECT id, queue_no FROM visit_services WHERE service_id = 23').get();
    assert.ok(RPC.some((c) => c.name === 'issue_queue_numbers' && JSON.stringify(c.body.p_ids) === JSON.stringify([ecg.id])),
        'калькулятор не выдал номер строкам своей сметы: ' + JSON.stringify(RPC.filter((c) => c.name === 'issue_queue_numbers').map((c) => c.body)));
    assert.ok(ecg.queue_no > 0, 'у ЭКГ нет номера очереди');
    assert.equal(status(before.lab), 'added');
    const html = PRINTED.join('\n');
    assert.match(html, /Номера? очереди/, 'на бумаге дописанного счёта нет блока очереди');
    assert.ok(html.includes(before.inv.invoice_number), 'напечатан не весь счёт с сервера');
});

// m4 — календарь кабинетов: дорожка кабинета (lockedDoctor нет), щелчок по дню
// через три дня. Врачебная строка каталога берёт время В ЭТОТ день.
for (const [what, busy] of [['врач свободен и сегодня', false], ['сегодня врач занят', true]]) {
    test(`m4: запись из календаря кабинетов на ${ymd(dayAt(3))} (${what}) — время УЗИ в щёлкнутый день, не сегодня; пометки «Сегодня…» нет`, async () => {
        seed();
        busyToday = busy;
        try {
            const day = ymd(dayAt(3));
            const at = new Date(dayAt(3)); at.setHours(14, 0, 0, 0);
            openCalc({ roomId: null, lockedDoctor: null, scheduledISO: at.toISOString(), initialDateIso: day });
            await until(() => addOf('УЗИ'), 'строка УЗИ в каталоге');
            addOf('УЗИ').click();
            await until(() => byClass(top(), 'wzc-cta')[0] && byClass(top(), 'wzc-cta')[0].disabled === false, 'смета готова');
            assert.ok(!textOf(top()).includes('Сегодня у врача нет свободного времени'), 'пометка про сегодня на записи другого дня');
            assert.ok(!byAttr(top(), 'data-no-today'), 'у строки нет времени в щёлкнутый день');
            const note = byAttr(top(), 'data-visit-day');
            assert.ok(note, 'смета не говорит, что визит не сегодня');
            assert.equal(note.attrs['data-visit-day'], day);
            await saveCalc();
            const book = RPC.find((c) => c.name === 'calendar_book');
            assert.ok(book, 'запись не дошла до calendar_book');
            assert.equal(ymd(new Date(book.body.start)), day, 'визит записан не на щёлкнутый день');
            const v = DB.prepare('SELECT visit_date FROM visits ORDER BY id DESC LIMIT 1').get();
            assert.equal(ymd(new Date(v.visit_date)), day);
        } finally { busyToday = false; }
    });
}

test(`m4: запись из календаря кабинетов на ${ymd(dayAt(3))}, врач в этот день занят — пометка «В этот день…», а не «Сегодня…»; «Ближайшее» — следующий день`, async () => {
    seed();
    busyOn = ymd(dayAt(3));
    try {
        const at = new Date(dayAt(3)); at.setHours(14, 0, 0, 0);
        openCalc({ roomId: null, lockedDoctor: null, scheduledISO: at.toISOString(), initialDateIso: ymd(dayAt(3)) });
        await until(() => addOf('УЗИ'), 'строка УЗИ в каталоге');
        addOf('УЗИ').click();
        await until(() => byAttr(top(), 'data-pick-nearest', 22), 'кнопка «Ближайшее»');
        assert.ok(textOf(top()).includes('В этот день у врача нет свободного времени'), 'нет пометки про щёлкнутый день');
        assert.ok(!textOf(top()).includes('Сегодня у врача нет свободного времени'), 'пометка про сегодня на записи другого дня');
        assert.equal(textOf(byAttr(top(), 'data-pick-nearest', 22)).trim(), nearestButtonText(ymd(dayAt(4)), 600));
        assert.equal(byClass(top(), 'wzc-cta')[0].disabled, true, 'смета без времени ушла бы дальше');
    } finally { busyOn = null; }
});

test.after(() => { if (DB) DB.close(); DB = null; });
