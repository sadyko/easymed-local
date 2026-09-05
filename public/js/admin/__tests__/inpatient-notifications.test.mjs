// INPATIENT_REQUEST_NOTIF_V1 (2026-09-05) — «заявку не видно, и о ней никто не
// сообщает».
//
// Владелец, вторым заходом: «also we cannot see the request admissions. also
// the request admission should have come as notifications.»
//
// ─── ЧТО ОКАЗАЛОСЬ ПРИЧИНОЙ НА ЭТОТ РАЗ ─────────────────────────────────────
// НЕ то же, что в прошлый. Прошлая причина — мёртвая колонка в embed'е
// (`patients(mrn, full_name, phone)`: реестр разрешает три поля, компилятор на
// четвёртое отвечает отказом ВСЕМУ запросу) — вылечена в fc22b3c, и первый тест
// ниже держит её мёртвой, потому что чинили её уже дважды.
//
// Сейчас же раздел ЖИВ. Заявка сохраняется, читается и рисуется у КАЖДОЙ роли,
// которой раздел положен, — это проверено живьём против настоящего сервера
// (медсестра, старшая медсестра, главный врач, регистратура, администратор:
// «Ждут размещения пациентов: 1», имя пациента, «Положить на койку»). Сломано
// было не «увидеть», а «УЗНАТЬ»:
//
//   * у раздела нет счётчика в боковой панели — navCounts (admin.js) считает
//     пациентов, непрочитанные чаты и неоплаченные счета, стационара там нет;
//   * колокол уведомлений (notifications.js) знал ровно одно условие —
//     незаполненный профиль клиники — и строился ОДИН раз, при входе;
//   * единственное сообщение, которое заявка вообще порождала, — тост в
//     кабинете ВРАЧА, то есть у того, кто её и подал.
//
// Пост медсестры узнавал о заявке, только если кто-то сам открывал «Стационар»
// и смотрел. Обе половины жалобы — одно и то же отсутствие сигнала, и тесты
// ниже держат его исправленным.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ---------------------------------------------------------------------------
// Поддельный DOM. textContent — ВЕСЬ текст поддерева, как в настоящем;
// innerHTML='' действительно чистит детей — на этом стоит paintBell, который
// перерисовывает колокол на месте.
// ---------------------------------------------------------------------------
class F {
    constructor(t) {
        this.tagName = String(t).toUpperCase();
        this.style = {}; this.children = []; this.attrs = {};
        this.className = ''; this._text = ''; this._l = {}; this.dataset = {}; this.value = '';
    }
    appendChild(c) { this.children.push(c); if (c) c._parent = this; return c; }
    removeChild(c) { const i = this.children.indexOf(c); if (i > -1) this.children.splice(i, 1); if (c) c._parent = null; return c; }
    insertBefore(node) { this.children.unshift(node); if (node) node._parent = this; return node; }
    get firstChild() { return this.children[0] || null; }
    replaceChildren() { this.children.length = 0; }
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'value') this.value = String(v); }
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); }
    removeAttribute(k) { delete this.attrs[k]; }
    addEventListener(t, fn) { (this._l[t] || (this._l[t] = [])).push(fn); }
    removeEventListener() {}
    dispatchEvent(e) { for (const fn of this._l[e.type] || []) fn(e); return true; }
    click() { this.dispatchEvent({ type: 'click', currentTarget: this, target: this, preventDefault() {}, stopPropagation() {} }); }
    focus() {} blur() {} scrollTo() {} scrollIntoView() {} select() {}
    remove() { const p = this._parent; if (p) p.removeChild(this); }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 }; }
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
    set textContent(v) { this._text = String(v); this.children.length = 0; }
    get classList() { const s = this; return { contains: (c) => String(s.className).split(/\s+/).includes(c), add() {}, remove() {}, toggle() {} }; }
    get isConnected() { return true; }
}
class TX extends F { constructor(t) { super('#text'); this.nodeType = 3; this._text = String(t); } }
function mk(t) {
    const el = new F(t);
    if (el.tagName === 'TEMPLATE') {
        el.content = { firstChild: null };
        Object.defineProperty(el, 'innerHTML', {
            set(v) { const s = new F('svg'); s._text = String(v); el.content.firstChild = s; }, get() { return ''; },
        });
    } else {
        Object.defineProperty(el, 'innerHTML', {
            set(v) { el.children.length = 0; el._text = String(v); }, get() { return ''; },
        });
    }
    return el;
}
globalThis.Node = F;
const BODY = mk('body');
// Колокол живёт в шапке (admin.html: <div class="topbar-bell" id="topbar-bell">).
const BELL = mk('div'); BELL.setAttribute('id', 'topbar-bell'); BODY.appendChild(BELL);
function byId(id) {
    const stack = [...BODY.children];
    while (stack.length) {
        const n = stack.shift();
        if (n && n.attrs && n.attrs.id === id) return n;
        if (n && n.children) stack.push(...n.children);
    }
    return null;
}
globalThis.document = {
    createElement: mk, createElementNS: (_n, t) => mk(t), createTextNode: (t) => new TX(t),
    head: mk('head'), body: BODY, documentElement: mk('html'),
    addEventListener() {}, removeEventListener() {},
    getElementById: byId,
    querySelector() { return null; }, querySelectorAll() { return []; },
};
const store = new Map([['admin.lang', 'ru']]);   // I18N_LOCALE_PIN_V1 — язык до импорта экранов
const fakeStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); }, clear: () => store.clear(),
};
globalThis.localStorage = fakeStorage;
let navigated = [];
globalThis.window = {
    location: { hostname: 'localhost', hash: '' }, localStorage: fakeStorage,
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    scrollTo() {}, scrollY: 0, confirm: () => true,
    easymed: { state: { user: null }, navigate: (v) => navigated.push(v) },
    easymedSetTabSub() {},
};
globalThis.location = globalThis.window.location;
globalThis.history = { state: null, replaceState() {}, pushState() {} };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();
globalThis.cancelAnimationFrame = () => {};

// ---------------------------------------------------------------------------
// «Сервер» в памяти: ровно те три запроса, которые делают колокол и экран.
// ---------------------------------------------------------------------------
const COMPANY = { id: 'c-1', name: 'Клиника', phone: '+998900000000', address: 'Ташкент' };
let CAPS = {};              // ответ inpatient_capabilities
let ROWS = [];              // строки admissions
let DB_CALLS = [];          // какие таблицы спрашивали
let DB_FAIL = null;         // строка — /api/db отвечает отказом с этими словами

const PATIENTS = {
    101: { mrn: 'M-101', full_name: 'Иванов Иван Иванович' },
    102: { mrn: 'M-102', full_name: 'Петрова Мария' },
};
function embed(a) {
    const p = PATIENTS[a.patient_id] || {};
    return { ...a, patients: { mrn: p.mrn, full_name: p.full_name },
             wards: a.ward_id ? { name: 'Терапия' } : null, beds: null,
             users: null, attending: null, examined: null };
}
function applyFilters(rows, filters) {
    let out = rows;
    for (const f of filters || []) {
        if (f.op === 'eq') out = out.filter((r) => String(r[f.col]) === String(f.val));
        else if (f.op === 'in') out = out.filter((r) => (f.val || []).map(String).includes(String(r[f.col])));
    }
    return out;
}
globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    let body = {}; try { body = JSON.parse(opts.body || '{}'); } catch { /* не наш */ }
    const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }), headers: { getSetCookie: () => [] } });
    const bad = (message, status = 400) => ({ ok: false, status, json: async () => ({ error: { message } }), headers: { getSetCookie: () => [] } });

    if (u.startsWith('/api/auth/me')) return ok({ user: globalThis.window.easymed.state.user });
    if (u.startsWith('/api/rpc/')) {
        const name = decodeURIComponent(u.slice('/api/rpc/'.length));
        if (name === 'inpatient_capabilities') return ok({ roles: [], can: CAPS });
        return ok({});
    }
    if (u.startsWith('/api/db')) {
        DB_CALLS.push(body.table);
        if (DB_FAIL && body.table === 'admissions') return bad(DB_FAIL);
        if (body.table === 'companies') return ok(applyFilters([COMPANY], body.filters));
        if (body.table === 'admissions') return ok(applyFilters(ROWS.map(embed), body.filters));
        return ok([]);
    }
    return ok([]);
};

const notif = await import('../notifications.js');
const { renderAdmissions } = await import('../views/admissions.js');
const perms = await import('../permissions.js');

const walk = (e, out = []) => { if (!e || typeof e !== 'object') return out; out.push(e); for (const c of e.children || []) walk(c, out); return out; };
const textOf = (e) => walk(e).map((x) => x._text || '').filter((t) => !String(t).startsWith('<svg')).join(' ');
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

const CLINIC = { id: 'c-1' };
const ORDER = (over = {}) => ({ id: 11, admission_no: 'ADM-00011', status: 'ordered', patient_id: 101,
    ward_id: 1, bed_id: null, department: 'Терапевтическое', admission_type: 'planned', stay_mode: 'round',
    planned_at: null, ordered_at: '2026-09-05T08:00:00Z', ordered_by: 7, created_by: 7, admitted_at: null,
    examined_at: null, examined_by: null, attending_doctor_id: null, ...over });

function resetWorld() {
    CAPS = {}; ROWS = []; DB_CALLS = []; DB_FAIL = null; navigated = [];
    BELL.children.length = 0; BELL._text = '';
    store.clear(); store.set('admin.lang', 'ru');
    globalThis.window.easymed.state.user = { id: 6, full_name: 'Медсестра поста', role: 'nurse' };
    notif.stopNotificationsPolling();
}
/** Что сейчас в колоколе: подписи + число на значке. */
async function bell(user) {
    if (user) globalThis.window.easymed.state.user = user;
    await notif.renderNotifications(CLINIC, { poll: false });
    await settle();
    const badge = walk(BELL).find((e) => e.className === 'em-bell-badge');
    const btn = walk(BELL).find((e) => e.className === 'em-bell');
    // Выпадающий список строится по нажатию — оттуда и берём подписи.
    if (btn) btn.click();
    const dd = byId('em-notif-dropdown');
    const items = dd ? walk(dd).filter((e) => String(e.className).startsWith('nd-item')) : [];
    const out = { count: badge ? badge.textContent : null, items: items.map((i) => ({ text: textOf(i), sev: String(i.className).replace('nd-item ', '') })) };
    if (dd) dd.remove();
    return out;
}

// ===========================================================================
// 1. ПРИЧИНА ПРОШЛОГО РАЗА — держим мёртвой, против НАСТОЯЩЕГО реестра
// ===========================================================================
// Тест ходит не в пересказ, а в тот самый компилятор (server/db/query-compiler.js)
// с тем самым реестром (server/db/schema-registry.js) и с той самой строкой
// `.select(...)`, ВЫЧИТАННОЙ ИЗ ИСХОДНИКА экрана. Появится в ней завтра лишнее
// слово — упадёт этот тест, а не раздел у медсестры.
const { compile, CompileError } = await import('../../../../server/db/query-compiler.js');

function admissionsSelect() {
    const src = read('public/js/admin/views/admissions.js');
    const from = src.indexOf("supabase.from('admissions')");
    assert.ok(from > 0, 'views/admissions.js больше не спрашивает admissions — тест устарел');
    const tail = src.slice(from);
    const s = tail.indexOf('.select(') + '.select('.length;
    const e = tail.indexOf(".in('status'");
    assert.ok(e > s, 'форма запроса очередей изменилась — обнови извлечение');
    return [...tail.slice(s, e).matchAll(/'([^']*)'/g)].map((m) => m[1]).join('');
}
const READERS = [
    ['медсестра',        { id: 6, role: 'nurse',     extra_roles: [] }],
    ['старшая медсестра',{ id: 5, role: 'nurse',     extra_roles: ['senior_nurse'] }],
    ['главный врач',     { id: 4, role: 'doctor',    extra_roles: ['head_doctor'] }],
    ['регистратура',     { id: 7, role: 'registrar', extra_roles: [] }],
    ['администратор',    { id: 1, role: 'admin',     extra_roles: [] }],
];

test('запрос очередей компилируется у каждой роли, которой раздел положен', () => {
    const columns = admissionsSelect();
    assert.match(columns, /patients\(mrn, full_name\)/);
    // Именно то слово, из-за которого раздел не открывался НИ У КОГО (fc22b3c).
    assert.ok(!/patients\([^)]*phone/.test(columns),
        'телефон снова в embed patients — реестр разрешает только id/mrn/full_name, и компилятор отказывает ВСЕМУ запросу');
    for (const [who, user] of READERS) {
        const desc = { table: 'admissions', op: 'select', columns,
            filters: [{ col: 'status', op: 'in', val: ['ordered', 'admitted', 'examined', 'active', 'discharging'] }],
            order: [{ col: 'id', asc: false }], limit: 500 };
        assert.doesNotThrow(() => compile(desc, user), `${who}: запрос очередей отвергнут сервером`);
    }
});

test('поле вне реестра валит ВЕСЬ запрос — механизм, а не догадка', () => {
    const desc = { table: 'admissions', op: 'select',
        columns: '*, patients(mrn, full_name, phone)', filters: [], order: [] };
    assert.throws(() => compile(desc, { id: 6, role: 'nurse', extra_roles: [] }), CompileError,
        'одно лишнее поле в embed обязано отвергать весь запрос — на этом и держится тест выше');
});

// ===========================================================================
// 2. ОЧЕРЕДИ РИСУЮТСЯ, И ПУСТО ≠ СЛОМАНО
// ===========================================================================
test('три очереди смены рисуются, и заявка в них видна', async () => {
    resetWorld();
    CAPS = { admit: true };
    ROWS = [ORDER(), ORDER({ id: 12, patient_id: 102, status: 'admitted', bed_id: 5 })];
    const host = mk('div');
    await renderAdmissions(host, {});
    await settle();
    const t = textOf(host);
    assert.match(t, /Ждут размещения/);
    assert.match(t, /В отделении/);
    assert.match(t, /Ждут первичного осмотра/);
    assert.match(t, /Иванов Иван Иванович/);
    assert.match(t, /Петрова Мария/);
});

test('раздел закрыт тому, кому он не положен, — и закрыт правилом, а не пустотой', () => {
    // Кассир: ключ `beds` ему не выдан ни одной миграцией, значит и раздела нет.
    perms.setEffectiveFromRole({ name: 'Кассир', permissions: { sections: ['cashier', 'patients', 'dashboard'] } });
    assert.equal(perms.isModuleAllowed('admissions'), false, 'кассир не должен видеть «Стационар»');
    assert.equal(perms.isRouteAllowed('admissions'), false, 'и по прямой ссылке тоже');
    // Медсестра: ключ есть — раздел есть.
    perms.setEffectiveFromRole({ name: 'Медсестра', permissions: { sections: ['patients', 'labs', 'dashboard', 'beds'] } });
    assert.equal(perms.isModuleAllowed('admissions'), true);
    perms.setFullAccess('Администратор клиники');
});

test('пустая очередь говорит «никого не ждут» и называет, откуда берётся заявка', async () => {
    resetWorld();
    CAPS = { admit: true };
    ROWS = [];
    const host = mk('div');
    await renderAdmissions(host, {});
    await settle();
    const t = textOf(host);
    assert.match(t, /Заявок нет — никого не ждут/);
    assert.match(t, /регистратура|врач из кабинета приёма/);
    assert.ok(!/не загрузился/.test(t), 'пустой отдел не должен выглядеть отказом');
});

test('отказ запроса говорит «не загрузился», называет причину и даёт повторить', async () => {
    resetWorld();
    CAPS = { admit: true };
    DB_FAIL = 'unknown embed column';
    const host = mk('div');
    await renderAdmissions(host, {});
    await settle();
    const t = textOf(host);
    assert.match(t, /Список госпитализаций не загрузился/);
    assert.match(t, /unknown embed column/, 'причина обязана быть на экране');
    assert.match(t, /Повторить загрузку/);
    assert.ok(!/Заявок нет/.test(t), 'сбой не должен выглядеть пустым отделом');
});

// ===========================================================================
// 3. КОЛОКОЛ: КОМУ ЗВОНИТ, КОМУ НЕТ
// ===========================================================================
test('заявка звонит тому, кто кладёт на койку', async () => {
    resetWorld();
    CAPS = { admit: true, examine: false };
    ROWS = [ORDER()];
    const b = await bell({ id: 6, role: 'nurse' });
    assert.equal(b.count, '1');
    assert.equal(b.items.length, 1);
    assert.match(b.items[0].text, /Заявки на госпитализацию/);
    assert.match(b.items[0].text, /Ждут размещения: 1/);
    assert.match(b.items[0].text, /Открыть стационар/);
});

test('нажатие в колоколе ведёт в «Стационар»', async () => {
    resetWorld();
    CAPS = { admit: true };
    ROWS = [ORDER()];
    await notif.renderNotifications(CLINIC, { poll: false });
    await settle();
    walk(BELL).find((e) => e.className === 'em-bell').click();
    const dd = byId('em-notif-dropdown');
    const cta = walk(dd).find((e) => e.tagName === 'BUTTON' && e.className === 'nd-cta');
    cta.click();
    assert.deepEqual(navigated, ['admissions']);
});

test('следующий шаг — главному врачу: осмотреть', async () => {
    resetWorld();
    CAPS = { admit: false, examine: true };
    ROWS = [ORDER({ status: 'admitted', bed_id: 5 })];
    const b = await bell({ id: 4, role: 'doctor', extra_roles: ['head_doctor'] });
    assert.equal(b.items.length, 1);
    assert.match(b.items[0].text, /Ждут первичного осмотра/);
    assert.match(b.items[0].text, /Пациентов без первичного осмотра: 1/);
});

test('кассиру не звонят — и в стационар за этим даже не ходят', async () => {
    resetWorld();
    CAPS = {};                      // сервер: ни класть, ни осматривать
    ROWS = [ORDER()];
    const b = await bell({ id: 9, role: 'cashier' });
    assert.equal(b.count, null, 'у кассира не должно быть значка');
    assert.equal(b.items.length, 0);
    assert.ok(!DB_CALLS.includes('admissions'),
        'без права на шаг колокол не обязан спрашивать стационар вовсе');
});

test('автору заявки о его же заявке не звонят', async () => {
    resetWorld();
    CAPS = { admit: true };
    // Старшая медсестра (id 5) вправе и оформить заявку, и положить на койку.
    ROWS = [ORDER({ ordered_by: 5, created_by: 5 })];
    const mine = await bell({ id: 5, role: 'nurse', extra_roles: ['senior_nurse'] });
    assert.equal(mine.items.length, 0, 'о собственной заявке ей уже сказал тост');
    // Тот же ряд — другому человеку с тем же правом: звонит.
    const hers = await bell({ id: 6, role: 'nurse' });
    assert.equal(hers.items.length, 1);
});

test('направление врача (только created_by) тоже не звонит своему автору', async () => {
    resetWorld();
    CAPS = { admit: true, examine: true };
    // request_admission из кабинета: ordered_by не ставится вовсе.
    ROWS = [ORDER({ ordered_by: null, created_by: 4 })];
    const his = await bell({ id: 4, role: 'doctor', extra_roles: ['head_doctor'] });
    assert.equal(his.items.length, 0);
});

// ===========================================================================
// 4. КОГДА ГАСНЕТ И ПОЧЕМУ НЕ ВОЗВРАЩАЕТСЯ
// ===========================================================================
test('уведомление гаснет, когда пациента ПОЛОЖИЛИ, и не возвращается', async () => {
    resetWorld();
    CAPS = { admit: true, examine: false };
    ROWS = [ORDER()];
    assert.equal((await bell({ id: 6, role: 'nurse' })).items.length, 1);

    ROWS = [ORDER({ status: 'admitted', bed_id: 5 })];   // положили на койку
    assert.equal((await bell()).items.length, 0, 'разместили — напоминать не о чем');

    // И не возвращается ни на следующем тике, ни на десятом.
    for (let i = 0; i < 3; i++) assert.equal((await bell()).items.length, 0);
});

test('отменённая заявка уносит уведомление с собой', async () => {
    resetWorld();
    CAPS = { admit: true };
    ROWS = [ORDER()];
    assert.equal((await bell({ id: 6, role: 'nurse' })).items.length, 1);
    ROWS = [ORDER({ status: 'cancelled' })];
    assert.equal((await bell()).items.length, 0);
});

test('прочтение НЕ гасит: посмотрел на колокол — пациент не размещён', async () => {
    resetWorld();
    CAPS = { admit: true };
    ROWS = [ORDER()];
    await bell({ id: 6, role: 'nurse' });          // открыли список и закрыли
    const again = await bell();
    assert.equal(again.items.length, 1, 'напоминание обязано пережить собственное прочтение');
});

test('очередь смены живёт в колоколе, а не полосой поперёк экрана', async () => {
    resetWorld();
    CAPS = { admit: true };
    ROWS = [ORDER()];
    await notif.renderNotifications(CLINIC, { poll: false });
    await settle();
    assert.equal(byId('em-notif-banners'), null,
        'баннер на всю ширину для работы, которая приходит и уходит по нескольку раз за смену, — шум');
});

// ===========================================================================
// 5. НИЧТО НЕ УВЕДОМЛЯЕТ ДВАЖДЫ ОБ ОДНОЙ ЗАЯВКЕ
// ===========================================================================
test('десять заявок — одна строка с числом; десять перерисовок — та же строка', async () => {
    resetWorld();
    CAPS = { admit: true, examine: true };
    ROWS = Array.from({ length: 10 }, (_, i) => ORDER({ id: 100 + i }));
    let b = await bell({ id: 6, role: 'nurse' });
    assert.equal(b.items.length, 1, 'одна очередь — один пункт, а не десять');
    assert.match(b.items[0].text, /Ждут размещения: 10/);
    assert.equal(b.count, '1', 'значок считает ПУНКТЫ, и их один');
    for (let i = 0; i < 5; i++) b = await bell();
    assert.equal(b.items.length, 1, 'перерисовка не размножает пункт');
    const ids = new Set();
    for (const it of b.items) ids.add(it.text);
    assert.equal(ids.size, b.items.length);
});

test('экстренная заявка называет себя и красит строку', async () => {
    resetWorld();
    CAPS = { admit: true };
    ROWS = [ORDER(), ORDER({ id: 12, patient_id: 102, admission_type: 'emergency' })];
    const b = await bell({ id: 6, role: 'nurse' });
    assert.equal(b.items.length, 1);
    assert.match(b.items[0].text, /Ждут размещения: 2/);
    assert.match(b.items[0].text, /экстренная/);
    assert.equal(b.items[0].sev, 'danger');
});

// ===========================================================================
// 6. КОЛОКОЛ ОБНОВЛЯЕТСЯ САМ
// ===========================================================================
test('колокол заводит самообновление и умеет его остановить', async () => {
    resetWorld();
    CAPS = { admit: true }; ROWS = [ORDER()];
    const realSet = globalThis.setInterval, realClear = globalThis.clearInterval;
    let armed = 0, cleared = 0;
    globalThis.setInterval = () => { armed++; return 'T'; };
    globalThis.clearInterval = () => { cleared++; };
    try {
        await notif.renderNotifications(CLINIC);          // как зовёт admin.js
        assert.equal(armed, 1, 'без повтора заявка появлялась бы в колоколе только после F5');
        await notif.renderNotifications(CLINIC);          // второй вход не плодит таймеров
        assert.equal(armed, 2); assert.equal(cleared, 1);
        notif.stopNotificationsPolling();
        assert.equal(cleared, 2);
    } finally {
        globalThis.setInterval = realSet; globalThis.clearInterval = realClear;
        notif.stopNotificationsPolling();
    }
});

// ===========================================================================
// 7. ЧУЖОЕ ЗДАНИЕ — ВОПРОСА НЕТ, И ЭТО ЗАКРЕПЛЕНО
// ===========================================================================
// Решение: чужие заявки НЕ уведомляют, потому что их не существует. `admissions`
// не входит в обмен между филиалами — у неё нет ни uid, ни sync_origin, ни
// журнальных триггеров (миграция 091 прямо на этом основывает безопасность
// пересборки таблицы). Заявка, оформленная в другом здании, в эту базу не
// приезжает вовсе, и фильтровать колокол по колонке, которой нет, нельзя.
// Начнут возить — этот тест упадёт, и решение примут заново, осознанно.
test('чужих заявок не существует: admissions не ездит между зданиями', async () => {
    const { SHIPPED } = await import('../../../../server/services/branch-sync/journal.js');
    assert.ok(!Object.prototype.hasOwnProperty.call(SHIPPED, 'admissions'),
        'admissions начали синхронизировать — реши заново, уведомляет ли заявка чужого здания');

    const { openDb } = await import('../../../../server/db/connection.js');
    const { migrate } = await import('../../../../server/db/migrate.js');
    const db = openDb(':memory:'); migrate(db);
    try {
        const cols = db.prepare('PRAGMA table_info(admissions)').all().map((c) => c.name);
        assert.ok(!cols.includes('sync_origin'), 'у admissions появился sync_origin — см. выше');
        assert.ok(!cols.includes('branch_id'), 'у admissions появился branch_id — см. выше');
        const trig = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='admissions'").all();
        assert.equal(trig.length, 0, 'на admissions повесили триггеры журнала — см. выше');
    } finally { db.close(); }
});
