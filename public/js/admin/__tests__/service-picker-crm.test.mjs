// CRM_LINKS_V1 (2026-09-20) — ЗАПИСЬ ИЗ КАЛЕНДАРЯ ПОДХВАТЫВАЕТ ЗАЯВКУ.
//
// Колл-центр записал пациента на четверг: услуга и дата лежат строкой в
// crm_request_services, и в четверг регистратура обязана увидеть эту услугу уже
// в смете. В «Добавить услуги к визиту» так и было. А запись ИЗ КАЛЕНДАРЯ
// (щелчок по пустому слоту → мастер записи) заявку не видела вовсе, и притом
// дважды:
//
//   1. мастер открывался БЕЗ дня — а подстановка сверяет дату строки с днём
//      записи, и без дня она молча выходит первой же строкой;
//   2. пациента в мастере привязывают ПОСЛЕ открытия окна, а подстановка
//      запускалась ровно один раз — до того, как пациент известен.
//
// И даже подставившись, строки заявки не закрывались: мастер записи закрывал их
// только в режиме привязки к существующему визиту. Заявка оставалась «Записан»
// с прошедшей датой — и ночная автоматика уносила пришедшего пациента в
// «Не пришёл».
//
// Стенд — тот же поддельный DOM, что в service-picker-attach.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

class FakeNode {
    constructor(tag) {
        this.tagName = String(tag).toUpperCase();
        this.style = {}; this.children = []; this.attrs = {};
        this.className = ''; this._text = ''; this._l = {}; this.dataset = {};
        this.value = '';
    }
    appendChild(c) { this.children.push(c); if (c && typeof c === 'object') c._parent = this; return c; }
    removeChild(c) { const i = this.children.indexOf(c); if (i > -1) this.children.splice(i, 1); return c; }
    get firstChild() { return this.children.length ? this.children[0] : null; }
    replaceChildren() { this.children.length = 0; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    removeAttribute(k) { delete this.attrs[k]; }
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); }
    addEventListener(t, fn) { (this._l[t] || (this._l[t] = [])).push(fn); }
    removeEventListener() {}
    dispatchEvent(e) { for (const fn of this._l[e.type] || []) fn(Object.assign({ currentTarget: this, preventDefault() {}, stopPropagation() {} }, e)); return true; }
    click() { this.dispatchEvent({ type: 'click' }); }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    remove() { if (this._parent) this._parent.removeChild(this); }
    focus() {} blur() {}
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
        Object.defineProperty(el, 'innerHTML', {
            set(v) { const s = new FakeNode('svg'); s._text = String(v); el.content.firstChild = s; },
            get() { return ''; },
        });
    }
    return el;
}
globalThis.Node = FakeNode;
const BODY = mkEl('body');
globalThis.document = {
    createElement: mkEl, createElementNS: (_n, t) => mkEl(t), createTextNode: (t) => new FakeText(t),
    head: mkEl('head'), body: BODY, documentElement: mkEl('html'),
    addEventListener() {}, removeEventListener() {},
    getElementById(id) { return BODY.children.find((c) => c.attrs && c.attrs.id === id) || null; },
};
globalThis.window = { location: { hostname: 'localhost' }, localStorage: { getItem: () => null, setItem() {} }, addEventListener() {}, CLINIC: {}, open: () => null };
globalThis.localStorage = { getItem: (k) => (k === 'admin.lang' ? 'ru' : null), setItem() {}, removeItem() {}, clear() {} };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();
// QUICK_PATIENT_V1 — каталог спрашивает перед уходом (confirmLeaveCatalog) ГОЛЫМ
// confirm(), как это делает браузер. В node его нет вовсе, и любая проверка,
// дошедшая до Escape с набранной сметой, падала бы на «confirm is not defined»
// — то есть по причине, к предмету проверки отношения не имеющей. Умолчание
// «да, закрывай»; проверке, которой важен сам вопрос, эту заглушку подменяют и
// возвращают обратно.
globalThis.confirm = () => true;

const walk = (e, out = []) => { if (!e || typeof e !== 'object') return out; out.push(e); for (const c of e.children || []) walk(c, out); return out; };
const textOf = (e) => walk(e).map((x) => x._text || '').join(' ');
const hasClass = (e, c) => String(e.className || '').split(/\s+/).includes(c);
const byClass = (root, c) => walk(root).filter((e) => hasClass(e, c));
const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));

// ─── «сервер» ──────────────────────────────────────────────────────────────
const DAY = '2026-10-08';
const DAY_ISO = DAY + 'T10:00:00.000Z';
const TYPES = [{ id: 1, name: 'Консультации', active: 1 }];
const SERVICES = [
    { id: 10, name: 'Приём терапевта', price: 90000, type_id: 1, type: 'consultation', active: 1, duration_minutes: 30, requires_doctor: true },
    // Услуга ЗАЯВКИ: именно её обязан подставить мастер, открытый на этот день.
    { id: 20, name: 'УЗИ почек', price: 120000, type_id: 1, type: 'imaging', active: 1, duration_minutes: 20, requires_doctor: false },
];
const USERS = [
    { id: 7, full_name: 'Петров П.П.', specialty: 'Терапевт', is_doctor: true, active: 1, role: 'doctor' },
];
const PATIENTS = [
    { id: 3, full_name: 'Иванов Иван', mrn: 'A-3', phone: '+998901112233' },
    // Второй пациент нужен ровно для одного — перепривязки. Заявок у него нет.
    { id: 4, full_name: 'Петров Пётр', mrn: 'A-4', phone: '+998901112244' },
];
let CRM_REQS = [];
let CRM_LINES = [];
let CALLS = [];
globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    let body = {}; try { body = JSON.parse(opts.body || '{}'); } catch { /* не наш запрос */ }
    const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }), headers: { getSetCookie: () => [] } });
    const gone = () => ({ ok: false, status: 404, json: async () => ({ error: { message: 'нет такого' } }), headers: { getSetCookie: () => [] } });
    if (u.startsWith('/api/db')) {
        CALLS.push(body);
        if (body.table === 'service_types') return ok(TYPES);
        if (body.table === 'services') return ok(SERVICES);
        if (body.table === 'users') return ok(USERS);
        if (body.table === 'patients' && body.op === 'select') return ok(PATIENTS);
        if (body.table === 'crm_requests' && body.op === 'select') {
            // Заявки принадлежат ПАЦИЕНТУ: у второго их нет, и подстановке
            // после перепривязки взять неоткуда.
            const f = (body.filters || []).find((x) => x.col === 'patient_id');
            return ok(f && String(f.val) !== '3' ? [] : CRM_REQS);
        }
        if (body.table === 'crm_request_services' && body.op === 'select') return ok(CRM_LINES);
        if (body.op === 'insert') return ok({ id: 'row-1' });
        return ok([]);
    }
    if (u.startsWith('/api/rpc/calendar_book')) return ok({ visit: { id: 'v-1', visit_number: 'V-1', branch_id: null, visit_date: DAY_ISO } });
    if (u.startsWith('/api/rpc/')) return ok({});
    return gone();
};

const { openServicePickerModal } = await import('../views/service-picker-modal.js');

const overlays = () => BODY.children.filter((c) => String(c.className || '').includes('modal'));
const topOverlay = () => overlays()[overlays().length - 1];
const btnWith = (root, text) => walk(root).find((n) => n.tagName === 'BUTTON' && textOf(n).includes(text));
const addBtnFor = (box, name) => byClass(box, 'wzc-svc')
    .filter((row) => textOf(row).includes(name))
    .map((row) => byClass(row, 'wzc-add')[0])
    .find(Boolean);

/** Мастер записи ровно так, как его открывает щелчок по пустому слоту календаря. */
async function openFromCalendar(extra = {}) {
    BODY.children.length = 0;
    CALLS = [];
    CRM_REQS = [{ id: 501 }];
    CRM_LINES = [{ id: 901, request_id: 501, service_id: 20, scheduled_date: DAY, status: 'pending', doctor_id: null }];
    openServicePickerModal(Object.assign({
        calculator: true,
        scheduledISO: DAY_ISO,
        initialDateIso: DAY,
        onCreatePatient() {},
        onPick: () => {},
    }, extra));
    await settle(60);
    const box = topOverlay();
    assert.ok(box, 'мастер записи не открылся');
    return box;
}

/** Привязать пациента ТЕМ ЖЕ путём, что регистратор: кнопка → строка списка. */
async function attachPatientViaUi(box, nth = 0) {
    const attach = btnWith(topOverlay() || box, 'Привязать пациента');
    assert.ok(attach, 'в смете нет кнопки «Привязать пациента»');
    attach.click();
    await settle(60);
    const row = byClass(topOverlay(), 'pk2-attach-row')[nth];
    assert.ok(row, 'список пациентов пуст — привязать некого');
    row.click();
    await settle(60);
}

/** Отвязать пациента — тот же крестик в смете. */
async function detachPatientViaUi() {
    const x = walk(topOverlay()).find((n) => n.tagName === 'BUTTON' && n.getAttribute('title') === 'Отвязать пациента');
    assert.ok(x, 'в смете нет кнопки «Отвязать пациента»');
    x.click();
    await settle(60);
}

/** Строки СМЕТЫ (правая колонка мастера). */
const cartLines = () => byClass(topOverlay(), 'wzc-ln');
/** Убрать услугу из сметы — крестик той же строки. */
async function removeFromCart(name) {
    const row = cartLines().find((l) => textOf(l).includes(name));
    assert.ok(row, 'в смете нет строки «' + name + '»');
    const rm = walk(row).find((n) => n.tagName === 'BUTTON' && n.getAttribute('aria-label') === 'Убрать услугу');
    assert.ok(rm, 'у строки сметы нет крестика «Убрать услугу»');
    rm.click();
    await settle(60);
}

const lineSelects = () => CALLS.filter((c) => c.table === 'crm_request_services' && c.op === 'select');
const lineUpdates = () => CALLS.filter((c) => c.table === 'crm_request_services' && c.op === 'update');
const filterOf = (call, col) => (call.filters || []).find((f) => f.col === col);

test('пациента привязали ПОСЛЕ открытия — услуги заявки на этот день всё равно подставились', async () => {
    const box = await openFromCalendar();

    // Регистратор сам добавляет приём — иначе привязывать пациента не к чему.
    const add = addBtnFor(box, 'Приём терапевта');
    assert.ok(add, 'каталог не нарисовал услугу');
    add.click();
    await settle();

    assert.equal(lineSelects().length, 0,
        'строки заявки спрошены ДО того, как пациент известен — спрашивать было не о ком');

    await attachPatientViaUi(box);

    const sel = lineSelects()[0];
    assert.ok(sel, 'после привязки пациента строки заявки колл-центра так и не спрошены: запись из календаря заявку не видит');
    assert.deepEqual(filterOf(sel, 'scheduled_date'), { col: 'scheduled_date', op: 'eq', val: DAY },
        'строки заявки спрошены не на день записи — мастер открыт без дня');
    assert.deepEqual(filterOf(sel, 'status'), { col: 'status', op: 'eq', val: 'pending' },
        'спрошены и уже закрытые строки заявки');

    const rail = topOverlay();
    assert.ok(byClass(rail, 'wzc-ln').some((l) => textOf(l).includes('УЗИ почек')),
        'услуга из заявки колл-центра не встала в смету: ' + textOf(rail).replace(/\s+/g, ' ').slice(0, 300));
});

test('день записи не назначен — заявку не подставляем: чужой день это не «сегодня»', async () => {
    const box = await openFromCalendar({ initialDateIso: null, scheduledISO: null });
    addBtnFor(box, 'Приём терапевта').click();
    await settle();
    await attachPatientViaUi(box);
    assert.equal(lineSelects().length, 0,
        'без дня записи подстановка сверять дату не с чем — она обязана промолчать, а не взять что попало');
});

test('после записи строки заявки закрываются — пришедшего не унесёт в «Не пришёл»', async () => {
    const box = await openFromCalendar();
    addBtnFor(box, 'Приём терапевта').click();
    await settle();
    await attachPatientViaUi(box);
    assert.ok(lineSelects().length, 'подстановка не отработала — закрывать нечего');

    const create = btnWith(topOverlay(), 'Создать визит') || byClass(topOverlay(), 'wzc-cta')[0];
    assert.ok(create, 'в мастере нет кнопки создания визита');
    create.click();
    await settle(120);

    const done = lineUpdates().find((c) => c.values && c.values.status === 'done');
    assert.ok(done, 'строки заявки остались «pending» после записи: ночная автоматика унесёт пришедшего пациента в «Не пришёл»');
    assert.deepEqual(filterOf(done, 'id'), { col: 'id', op: 'in', val: [901] },
        'закрыты не те строки, что подставились');
});

// CRM_LINKS_V1 — ЗАКРЫВАЕТСЯ ТО, ЧТО ЗАПИСАЛИ, А НЕ ТО, ЧТО ПОДСТАВИЛОСЬ.
//
// Подстановка кладёт услуги заявки в смету, но смета — это предложение, а не
// решение: регистратор вправе убрать услугу (пациент передумал, пришёл только
// за анализом). Закрывались же ВСЕ подставленные строки, потому что помнили
// их с момента подстановки. Услуга, за которую не взяли денег, объявлялась
// оказанной: в следующий приход её уже никто не подставит, а заявка уйдёт в
// «Пришёл» целиком.
test('убранная из сметы услуга остаётся ждать: закрываются только записанные строки', async () => {
    const box = await openFromCalendar();
    addBtnFor(box, 'Приём терапевта').click();
    await settle();
    await attachPatientViaUi(box);
    assert.ok(cartLines().some((l) => textOf(l).includes('УЗИ почек')), 'услуга заявки не подставилась — убирать нечего');

    await removeFromCart('УЗИ почек');
    assert.ok(!cartLines().some((l) => textOf(l).includes('УЗИ почек')), 'услуга не убралась из сметы');

    const create = btnWith(topOverlay(), 'Создать визит') || byClass(topOverlay(), 'wzc-cta')[0];
    assert.ok(create, 'в мастере нет кнопки создания визита');
    create.click();
    await settle(120);

    const done = lineUpdates().find((c) => c.values && c.values.status === 'done');
    assert.equal(done, undefined,
        'закрыта строка услуги, которую не записали и за которую не взяли денег: ' + JSON.stringify(done && done.filters));
});

// CRM_LINKS_V1 — ЧУЖАЯ ЗАЯВКА НЕ ПЕРЕЕЗЖАЕТ НА ДРУГОГО ПАЦИЕНТА.
//
// Регистратор привязал не того человека (однофамильцы, промах в списке) и
// перепривязал. Подставленные услуги ПЕРВОГО оставались в смете, а вместе с
// ними — память о его строках заявки. Второй пациент получал в счёт чужие
// услуги, а заявка первого закрывалась визитом, на который он не приходил.
test('перепривязка к другому пациенту убирает подставленное первому', async () => {
    const box = await openFromCalendar();
    addBtnFor(box, 'Приём терапевта').click();
    await settle();
    await attachPatientViaUi(box, 0);
    assert.ok(cartLines().some((l) => textOf(l).includes('УЗИ почек')), 'услуга заявки не подставилась — проверять нечего');

    await detachPatientViaUi();
    await attachPatientViaUi(box, 1);

    assert.ok(!cartLines().some((l) => textOf(l).includes('УЗИ почек')),
        'услуга из заявки ПЕРВОГО пациента осталась в смете второго — он заплатит за чужую запись: '
        + cartLines().map((l) => textOf(l)).join(' | '));

    const create = btnWith(topOverlay(), 'Создать визит') || byClass(topOverlay(), 'wzc-cta')[0];
    create.click();
    await settle(120);

    const done = lineUpdates().find((c) => c.values && c.values.status === 'done');
    assert.equal(done, undefined,
        'заявка первого пациента закрыта визитом второго: он на этот приём не приходил');
});

// CRM_LINKS_V1 — ОДНО ЧТЕНИЕ «ЧТО ЖДЁТ ЭТОГО ПАЦИЕНТА В ЭТОТ ДЕНЬ».
//
// Двухшаговое чтение (заявки пациента → их строки на день) стояло КОПИЕЙ в
// мастере записи и в каталоге услуг. Копии уже расходились: одна молча
// возвращала пустоту при отказе сервера, вторая — нет; у одной в выборке не
// было doctor_id. Два ответа на один вопрос — это два разных поведения одной
// кнопки в соседних окнах.
test('оба мастера читают строки заявки одним кодом, а не копией на каждое окно', () => {
    const views = path.join(HERE, '..', 'views');
    for (const f of ['service-picker-modal.js', 'visit-wizard.js']) {
        const src = fs.readFileSync(path.join(views, f), 'utf8');
        assert.ok(!/from\(['"]crm_request_services['"]\)/.test(src),
            f + ' снова читает crm_request_services сам: правило «что ждёт пациента в этот день» живёт в crm-lines.js');
        assert.match(src, /pendingCrmLines/,
            f + ' не зовёт общее чтение строк заявки (pendingCrmLines)');
    }
});
