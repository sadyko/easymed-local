// INPATIENT_ROUTE_V1 — ВЕСЬ МАРШРУТ СТАЦИОНАРА, ПРОЙДЕННЫЙ ПО ЭКРАНАМ.
//
// Каждая задача плана «Стационар» (docs/plans/2026-09-04-inpatient-workflow.md)
// проверена своим тестом: сервер — на своих RPC, экраны — поодиночке. Чего до
// этого файла не проверял НИКТО — что из них складывается путь. Ровно так и
// вышло, что два готовых экрана («Порционник», «Выписки к оформлению») месяцами
// стояли без единого входа: каждый по отдельности работал, а нажать на них было
// негде. Тест поэлементно правильных частей не ловит отсутствующее целое.
//
// Здесь один пациент проходит его целиком, и КАЖДЫЙ шаг делается нажатием на
// то, на что нажал бы человек:
//
//   регистратура  → заявка на госпитализацию
//   медсестра     → положить на койку        (окно «Стационар»)
//   главный врач  → первичный осмотр         → и сразу лечащий врач
//   лечащий врач  → назначение               (лист назначений)
//   лечащий врач  → ЛЕЧЕБНЫЙ СТОЛ            (карта госпитализации)
//   медсестра     → отметка дозы «5 прав»    (задачи медсестры)
//                 → и отметка приёма пищи    (там же, полосой ниже)
//   кухня         → порционник видит пациента НА НАЗНАЧЕННОМ СТОЛЕ
//   лечащий врач  → ЗАЯВКА НА ВЫПИСКУ        (карта госпитализации)
//   ст. медсестра → оформление выписки       (экран «Выписки к оформлению»)
//
// ЧТО ЗДЕСЬ НАСТОЯЩЕЕ, А ЧТО ПОДДЕЛКА. Подделан транспорт: `fetch` отвечает из
// маленького состояния в памяти. НЕ подделана матрица прав — `inpatient_
// capabilities` и flow-state считает ТОТ ЖЕ модуль сервера
// (rpc/inpatient-flow.js), который отвечает в бою. Поэтому «врач видит заявку
// на выписку, а медсестра — нет» здесь не утверждение теста, а следствие
// серверной таблицы: поправят её — тест поедет вместе с ней, а не мимо.
//
// И отдельно — ВХОД В ЭКРАН ВЫПИСОК. Экран discharge.js был написан без
// маршрута; тест читает admin.js и permissions.js и падает, если пункт меню,
// ветка маршрута, хлебная крошка или право снова исчезнут.

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── минимальный DOM (тот же стенд, что у mar-nurse / admissions-window) ────
class FakeNode {
    constructor(tag) {
        this.tagName = String(tag).toUpperCase();
        this.style = {}; this.children = []; this.attrs = {};
        this.className = ''; this._text = ''; this._l = {}; this.dataset = {};
        this.value = '';
    }
    appendChild(c) { this.children.push(c); return c; }
    removeChild(c) { const i = this.children.indexOf(c); if (i > -1) this.children.splice(i, 1); return c; }
    get firstChild() { return this.children.length ? this.children[0] : null; }
    replaceChildren() { this.children.length = 0; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); }
    addEventListener(t, fn) { (this._l[t] || (this._l[t] = [])).push(fn); }
    removeEventListener() {}
    dispatchEvent(e) { for (const fn of this._l[e.type] || []) fn(e); return true; }
    click() { this.dispatchEvent({ type: 'click', currentTarget: this, preventDefault() {}, stopPropagation() {} }); }
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
// Окна закрываются через overlay.remove(); в настоящем DOM узел знает родителя,
// и без этого «закрыть» ничего бы не закрывало — а маршрут из восьми шагов
// оставил бы восемь наложенных окон и находил бы кнопки не того шага.
const realAppend = FakeNode.prototype.appendChild;
FakeNode.prototype.appendChild = function (c) { if (c && typeof c === 'object') c._parent = this; return realAppend.call(this, c); };
globalThis.document = {
    createElement: mkEl, createElementNS: (_n, t) => mkEl(t), createTextNode: (t) => new FakeText(t),
    head: mkEl('head'), body: BODY, documentElement: mkEl('html'),
    addEventListener() {}, removeEventListener() {},
    getElementById(id) { return BODY.children.find((c) => c.attrs && c.attrs.id === id) || null; },
};
// I18N_LOCALE_PIN_V1 — экраны рисуются по-русски независимо от локали машины.
globalThis.localStorage = { getItem: (k) => (k === 'admin.lang' ? 'ru' : null), setItem() {}, removeItem() {}, clear() {} };
globalThis.window = { location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, addEventListener() {}, open: () => null };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();

const walk = (e, out = []) => { if (!e || typeof e !== 'object') return out; out.push(e); for (const c of e.children || []) walk(c, out); return out; };
const textOf = (e) => walk(e).map((x) => x._text || '').join(' ');
const findBtn = (root, label) => walk(root).find((e) => e.tagName === 'BUTTON' && textOf(e).includes(label));
const topOverlay = () => BODY.children.filter((c) => c.className === 'modal').pop() || null;
const lastToast = () => {
    const t = BODY.children.filter((c) => c.attrs && c.attrs.id === 'toast').pop();
    return t ? t.textContent : '';
};
const settle = () => new Promise((r) => setTimeout(r, 30));

// ─── правá берём у СЕРВЕРА, а не переписываем ──────────────────────────────
const { TRANSITION_ROLES, inpatientCapabilities } = await import('../../../../server/services/rpc/inpatient-flow.js');
// DIET_TABLES_V1 — список ролей, которым можно менять стол, и правило «какие
// приёмы входят в N-разовое питание» тоже берутся у сервера: переписанные
// здесь, они перестали бы падать в тот день, когда их поправят там.
const { SET_ROLES: DIET_SET_ROLES, mealsForFrequency } = await import('../../../../server/services/rpc/diet.js');

function flowCan(status, roles) {
    const can = {};
    for (const [key, allowed] of Object.entries(TRANSITION_ROLES)) {
        const [from, to] = key.split('→');
        if (from !== status) continue;
        can[to] = roles.some((r) => allowed.includes(r));
    }
    return can;
}

// ─── маленький «сервер» в памяти ────────────────────────────────────────────
const TODAY = (() => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
})();
const HOUR = new Date().getHours();

// Кто сейчас за экраном. Маршрут проходят шестеро, и каждый видит своё.
const ACTORS = {
    registrar:    { id: 1, role: 'registrar',    full_name: 'Регистратура' },
    nurse:        { id: 2, role: 'nurse',        full_name: 'Медсестра поста' },
    senior_nurse: { id: 3, role: 'senior_nurse', full_name: 'Старшая медсестра' },
    head_doctor:  { id: 4, role: 'head_doctor',  full_name: 'Главный врач' },
    doctor:       { id: 77, role: 'doctor',      full_name: 'Юсупов А.' },
};
let actor = ACTORS.registrar;
const beActor = (name) => { actor = ACTORS[name]; };

const WORLD = {
    patients: [{ id: 101, mrn: 'M-101', full_name: 'Иванов Иван Иванович', phone: '', allergies: 'Пенициллин' }],
    wards: [{ id: 1, name: 'Терапия', active: 1 }],
    beds: [
        { id: 5, code: 'T-1', status: 'free', ward_id: 1, type: 'standard', active: 1 },
        { id: 6, code: 'T-2', status: 'free', ward_id: 1, type: 'standard', active: 1 },
    ],
    users: [
        { id: 2, full_name: 'Медсестра поста', role: 'nurse', specialty: '', is_doctor: false, license_number: '', active: true },
        { id: 77, full_name: 'Юсупов А.', role: 'doctor', specialty: 'Терапия', is_doctor: true, license_number: '', active: true },
    ],
    admissions: [],
    reviews: [],
    orders: [],
    marks: [],
    diets: [],
    meals: [],
    nextId: { admission: 500, review: 600, order: 700, mark: 800, diet: 900 },
};

// Четыре стола из настоящего справочника (миграция 094) — маршруту хватает
// четырёх. Что справочник Певзнера полон и что №12 в нём нет, проверяет
// admission-diet.test.mjs на настоящей базе, а не этот файл.
const DIET_TABLES = [
    { code: '0', name: 'Стол №0 — хирургический (зондовый)', indication: 'Первые дни после операций на ЖКТ', active: 1, sort_order: 0 },
    { code: '5', name: 'Стол №5', indication: 'Болезни печени и желчевыводящих путей', active: 1, sort_order: 5 },
    { code: '9', name: 'Стол №9', indication: 'Сахарный диабет; контроль углеводов', active: 1, sort_order: 9 },
    { code: '15', name: 'Стол №15 — общий', indication: 'Общий стол без ограничений', active: 1, sort_order: 15 },
];

/** Действующий стол госпитализации — строка с ended_at === null, или null. */
const currentDiet = (admissionId) =>
    WORLD.diets.find((d) => d.admission_id === admissionId && d.ended_at === null) || null;
let rpcCalls = [];

const adm = () => WORLD.admissions[0];

/** Строка госпитализации в том виде, в каком её ждут экраны (embed'ы реестра). */
function embed(a) {
    const p = WORLD.patients.find((x) => x.id === a.patient_id) || {};
    const w = WORLD.wards.find((x) => x.id === a.ward_id) || null;
    const b = WORLD.beds.find((x) => x.id === a.bed_id) || null;
    const doc = WORLD.users.find((x) => x.id === a.attending_doctor_id) || null;
    const exam = WORLD.users.find((x) => x.id === a.examined_by) || null;
    return {
        ...a,
        patients: { mrn: p.mrn, full_name: p.full_name, phone: p.phone },
        wards: w ? { name: w.name } : null,
        beds: b ? { code: b.code } : null,
        users: null,
        attending: doc ? { full_name: doc.full_name, specialty: doc.specialty } : null,
        examined: exam ? { full_name: exam.full_name } : null,
    };
}

const ZERO_BALANCE = {
    balance: 0, unbilled: 0, unbilled_lines: 0, invoiced: 0, paid: 0, invoice_count: 0,
    excludes: { internal_lines: 0, internal_amount: 0, void_invoices: 0 },
};

function dbRead(desc) {
    const t = desc.table;
    let rows;
    if (t === 'admissions') rows = WORLD.admissions.map(embed);
    else if (t === 'beds') rows = WORLD.beds.map((b) => ({ ...b, wards: { name: (WORLD.wards.find((w) => w.id === b.ward_id) || {}).name } }));
    else if (t === 'wards') rows = WORLD.wards.slice();
    else if (t === 'users') rows = WORLD.users.slice();
    else if (t === 'patients') rows = WORLD.patients.slice();
    else rows = [];
    for (const f of desc.filters || []) {
        if (f.op === 'eq') rows = rows.filter((r) => String(r[f.col]) === String(f.val));
        else if (f.op === 'in') rows = rows.filter((r) => (f.val || []).map(String).includes(String(r[f.col])));
    }
    return desc.single ? (rows[0] || null) : rows;
}

// Отказы сервера — ДОСЛОВНО из rpc/inpatient.js. Экран обязан доносить их
// такими, какие они есть; тест ниже сверяет эти строки с самим модулем сервера.
const REFUSE_NO_EPICRISIS = 'Выписной эпикриз не написан — заявку на выписку принять нельзя.';
const REFUSE_DRAFT_EPICRISIS = 'Выписной эпикриз сохранён черновиком — опубликуйте его, затем подайте заявку.';

function rpcAnswer(name, a) {
    const roles = [actor.role];
    switch (name) {
        case 'inpatient_capabilities':
            return { ok: true, data: inpatientCapabilities(null, {}, actor) };

        case 'admission_flow_state': {
            const row = adm();
            return { ok: true, data: { admission_id: row.id, status: row.status, can: flowCan(row.status, roles) } };
        }

        case 'admission_order_create': {
            const row = {
                id: ++WORLD.nextId.admission, admission_no: 'ADM-00501', status: 'ordered',
                patient_id: a.patient_id, ward_id: a.ward_id, bed_id: null,
                department: a.department || '', admission_type: a.admission_type, stay_mode: a.stay_mode,
                planned_at: a.planned_at || null, chief_complaint: a.note || '',
                ordered_at: `${TODAY}T08:00:00Z`, admitted_at: null, admitted_by: null,
                examined_at: null, examined_by: null, attending_doctor_id: null,
                discharge_outcome: null, discharge_destination: '', discharge_recommendations: '',
                discharge_requested_at: null, discharge_requested_by: null, discharged_at: null,
            };
            WORLD.admissions.push(row);
            return { ok: true, data: { admission: row } };
        }

        case 'admission_admit': {
            const row = adm();
            row.status = 'admitted'; row.bed_id = a.bed_id; row.admitted_at = `${TODAY}T09:00:00Z`;
            row.admitted_by = actor.id;
            const bed = WORLD.beds.find((b) => b.id === a.bed_id);
            if (bed) bed.status = 'occupied';
            row.ward_id = bed ? bed.ward_id : row.ward_id;
            return { ok: true, data: { admission: row } };
        }

        case 'admission_reviews_list':
            return { ok: true, data: { admission_id: a.admission_id, reviews: WORLD.reviews.slice() } };

        case 'admission_review_save': {
            const row = adm();
            let rev = WORLD.reviews.find((r) => r.id === a.review_id);
            if (!rev) { rev = { id: ++WORLD.nextId.review, kind: a.kind, published_at: null }; WORLD.reviews.push(rev); }
            rev.kind = a.kind;
            rev.diagnosis = a.diagnosis;
            if (a.publish) rev.published_at = `${TODAY}T11:00:00Z`;
            if (a.publish && a.kind === 'primary') {
                row.status = 'examined'; row.examined_at = `${TODAY}T11:00:00Z`; row.examined_by = actor.id;
            }
            return { ok: true, data: { review: rev, admission: row, published: !!a.publish } };
        }

        case 'admission_set_attending': {
            const row = adm();
            row.status = 'active'; row.attending_doctor_id = a.doctor_id;
            return { ok: true, data: { admission: row } };
        }

        case 'treatment_order_create': {
            const o = {
                id: ++WORLD.nextId.order, admission_id: a.admission_id, kind: a.kind, name: a.name,
                dose: a.dose, route: a.route, freq_code: a.freq_code, source: a.source,
                prn: a.freq_code === 'prn' ? 1 : 0, status: 'active', stock_item_id: 55,
                // Плановая точка — текущий час: маршрут проверяет, что доза
                // ДОХОДИТ до медсестры, а расписание частот проверено отдельно
                // (mar-sheet.test.mjs читает серверный модуль).
                due: [{ date: TODAY, slot: HOUR }], marks: [], voided_marks: [],
            };
            WORLD.orders.push(o);
            return { ok: true, data: { order: o } };
        }

        case 'treatment_orders_list':
            return { ok: true, data: { admission_id: a.admission_id, orders: WORLD.orders.slice(), stock_issues: { count: 0, items: [] } } };

        case 'treatment_tasks_due': {
            const row = adm();
            const p = WORLD.patients.find((x) => x.id === row.patient_id) || {};
            const bed = WORLD.beds.find((b) => b.id === row.bed_id) || {};
            const ward = WORLD.wards.find((w) => w.id === row.ward_id) || {};
            const open = WORLD.orders.filter((o) => o.status === 'active' && !o.marks.length);
            const tasks = open.map((o) => ({
                admission_id: row.id, patient_id: row.patient_id, patient_name: p.full_name,
                ward_id: ward.id, ward_name: ward.name, bed_id: bed.id, bed_code: bed.code,
                order_id: o.id, kind: o.kind, name: o.name, dose: o.dose, route: o.route,
                source: o.source, freq_code: o.freq_code, prn: o.prn, stock_item_id: o.stock_item_id,
                date: TODAY, slot: HOUR, due_at: `${TODAY} ${String(HOUR).padStart(2, '0')}:00`,
                state: 'delayed', late_min: 20,
            }));
            return {
                ok: true,
                data: {
                    date: TODAY, now: new Date().toISOString(), ward_id: null,
                    counts: { overdue: 0, now: tasks.length, later: 0, prn: 0, done: 0 },
                    groups: { overdue: [], now: tasks, later: [], prn: [], done: [] },
                },
            };
        }

        case 'treatment_admin_mark': {
            const o = WORLD.orders.find((x) => x.id === a.order_id);
            if (!o) return { ok: false, message: 'Назначение не найдено.' };
            const mark = {
                id: ++WORLD.nextId.mark, due_date: a.date, due_slot: a.slot, status: a.status,
                given_at: new Date().toISOString(), given_by: actor.id, voided_at: null,
            };
            o.marks.push(mark);
            WORLD.marks.push(mark);
            return { ok: true, data: { administration: mark, already: false, warnings: [] } };
        }

        // ── Лечебный стол (Задача 7) ─────────────────────────────────────────
        case 'diet_tables_list':
            return { ok: true, data: { diets: DIET_TABLES.filter((d) => d.active) } };

        case 'admission_diet_set': {
            const row = adm();
            // ПРАВО — по серверному списку ролей, а не по названию экрана.
            if (!DIET_SET_ROLES.includes(actor.role)) {
                return { ok: false, message: 'Назначение стола — недоступно вашей роли.' };
            }
            if (!['active', 'discharging'].includes(row.status)) {
                return { ok: false, message: 'Лечащий врач ещё не назначен.' };
            }
            const table = DIET_TABLES.find((t) => t.code === a.diet_code);
            if (!table) return { ok: false, message: `Стол не найден: ${a.diet_code}.` };
            // Смена НЕ ПРАВИТ строку: закрывает период и открывает новый.
            const prev = currentDiet(row.id);
            const at = new Date().toISOString();
            if (prev) prev.ended_at = at;
            const d = {
                id: ++WORLD.nextId.diet, admission_id: row.id, diet_code: table.code,
                since: at, ended_at: null,
                assigned_by: actor.id, assigned_by_name: actor.full_name,
                note: a.note || '', meals_per_day: Number(a.meals_per_day) || 4,
                diet_name: table.name, diet_indication: table.indication,
            };
            WORLD.diets.push(d);
            return { ok: true, data: { diet: d, previous: prev, changed: true } };
        }

        case 'admission_diet_history': {
            const row = adm();
            const rows = WORLD.diets.filter((d) => d.admission_id === row.id).slice().reverse();
            return {
                ok: true,
                data: {
                    admission_id: row.id,
                    current: rows.find((d) => d.ended_at === null) || null,
                    history: rows,
                    can_set: DIET_SET_ROLES.includes(actor.role) && ['active', 'discharging'].includes(row.status),
                },
            };
        }

        case 'admission_meals_list': {
            const row = adm();
            const cur = currentDiet(row.id);
            const marks = WORLD.meals.filter((m) => m.admission_id === row.id);
            return {
                ok: true,
                data: {
                    admission_id: row.id, meal_date: a.meal_date || TODAY,
                    diet_code: cur ? cur.diet_code : null,
                    meals_per_day: cur ? cur.meals_per_day : null,
                    meals: mealsForFrequency(cur ? cur.meals_per_day : 4)
                        .map((key) => ({ meal_key: key, mark: marks.find((m) => m.meal_key === key) || null })),
                },
            };
        }

        case 'admission_meal_mark': {
            const row = adm();
            let m = WORLD.meals.find((x) => x.admission_id === row.id && x.meal_key === a.meal_key);
            if (!m) { m = { admission_id: row.id, meal_date: a.meal_date, meal_key: a.meal_key }; WORLD.meals.push(m); }
            m.status = a.status; m.marked_by = actor.id;
            return { ok: true, data: { meal: m } };
        }

        case 'kitchen_sheet': {
            const rows = WORLD.admissions
                .filter((r) => ['admitted', 'examined', 'active', 'discharging'].includes(r.status))
                .map((r) => {
                    const p = WORLD.patients.find((x) => x.id === r.patient_id) || {};
                    const bed = WORLD.beds.find((b) => b.id === r.bed_id) || {};
                    const ward = WORLD.wards.find((w) => w.id === r.ward_id) || {};
                    const d = currentDiet(r.id);
                    return {
                        admission_id: r.id, ward_id: ward.id, ward_name: ward.name, bed_code: bed.code,
                        patient_name: p.full_name,
                        diet_code: d ? d.diet_code : null,
                        diet_name: d ? d.diet_name : null,
                        meals_per_day: d ? d.meals_per_day : null,
                        diet_note: d ? d.note : '',
                    };
                });
            const totals = rows.map((r) => ({ diet_code: r.diet_code, diet_name: r.diet_name, portions: 1 }));
            return { ok: true, data: { date: a.date || TODAY, rows, totals, total_portions: rows.length } };
        }

        // ── ШАГ 1 выписки: заявка врача ──────────────────────────────────────
        case 'admission_discharge_request': {
            const row = adm();
            if (row.status === 'discharging') return { ok: false, message: 'Заявка на выписку уже подана.' };
            if (!flowCan(row.status, roles).discharging) {
                return { ok: false, message: 'Заявку на выписку подаёт лечащий врач этого пациента или главный врач.' };
            }
            // ЭПИКРИЗ — И ТОЛЬКО ОПУБЛИКОВАННЫЙ. Черновик и пустое место —
            // разные беды человека у экрана, и сервер их различает.
            const pub = WORLD.reviews.find((r) => r.kind === 'discharge' && r.published_at);
            if (!pub) {
                const draft = WORLD.reviews.find((r) => r.kind === 'discharge' && !r.published_at);
                return { ok: false, message: draft ? REFUSE_DRAFT_EPICRISIS : REFUSE_NO_EPICRISIS };
            }
            if (a.outcome === 'transfer' && !String(a.destination || '').trim()) {
                return { ok: false, message: 'Укажите, в какое учреждение переведён пациент.' };
            }
            row.status = 'discharging';
            row.discharge_outcome = a.outcome;
            row.discharge_destination = a.destination || '';
            row.discharge_recommendations = a.recommendations || '';
            row.planned_discharge_at = a.planned_discharge_at || null;
            row.discharge_requested_at = new Date().toISOString();
            row.discharge_requested_by = actor.id;
            return { ok: true, data: { admission: row, epicrisis_id: pub.id, active_orders: 1, balance: ZERO_BALANCE } };
        }

        case 'admission_discharge_cancel_request': {
            const row = adm();
            if (row.status !== 'discharging') return { ok: false, message: 'Заявка на выписку не подана — отзывать нечего.' };
            if (!flowCan(row.status, roles).active) {
                return { ok: false, message: 'Отозвать заявку может лечащий врач этого пациента или главный врач.' };
            }
            row.status = 'active';
            row.discharge_outcome = null; row.discharge_destination = '';
            row.discharge_requested_at = null; row.discharge_requested_by = null;
            return { ok: true, data: { admission: row } };
        }

        case 'admission_discharge_queue': {
            const rows = WORLD.admissions.filter((r) => r.status === 'discharging').map((r) => {
                const p = WORLD.patients.find((x) => x.id === r.patient_id) || {};
                const bed = WORLD.beds.find((b) => b.id === r.bed_id) || {};
                const ward = WORLD.wards.find((w) => w.id === r.ward_id) || {};
                const doc = WORLD.users.find((u) => u.id === r.attending_doctor_id) || {};
                const req = Object.values(ACTORS).find((u) => u.id === r.discharge_requested_by) || {};
                return {
                    admission_id: r.id, admission_no: r.admission_no, status: r.status,
                    discharge_outcome: r.discharge_outcome, discharge_destination: r.discharge_destination,
                    discharge_recommendations: r.discharge_recommendations,
                    discharge_requested_at: r.discharge_requested_at, requested_by_name: req.full_name || '',
                    patient_id: r.patient_id, patient_name: p.full_name,
                    ward_id: ward.id, ward_name: ward.name, bed_id: bed.id, bed_code: bed.code,
                    attending_name: doc.full_name || '',
                    balance: ZERO_BALANCE,
                    active_orders: WORLD.orders.filter((o) => o.status === 'active').length,
                };
            });
            return { ok: true, data: { ward_id: null, outcomes: ['home', 'transfer', 'refuse', 'death'], rows } };
        }

        // ── ШАГ 2 выписки: оформление старшей медсестрой ─────────────────────
        case 'admission_discharge_finalize': {
            const row = adm();
            if (row.status !== 'discharging') return { ok: false, message: 'Заявка на выписку не подана — её подаёт лечащий врач.' };
            if (!flowCan(row.status, roles).discharged) return { ok: false, message: 'Оформляет выписку старшая медсестра.' };
            row.status = 'discharged';
            row.discharged_at = a.at || new Date().toISOString();
            if (a.close_orders) for (const o of WORLD.orders) if (o.status === 'active') { o.status = 'cancelled'; o.cancel_reason = 'Выписка'; }
            const bed = WORLD.beds.find((b) => b.id === row.bed_id);
            // КОЙКА НЕ СТАНОВИТСЯ СВОБОДНОЙ — она уходит на уборку.
            if (bed) bed.status = 'cleaning';
            return { ok: true, data: { admission: row, bed, orders_closed: 1, orders_left: 0, balance: ZERO_BALANCE } };
        }

        default:
            return { ok: true, data: {} };
    }
}

globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    let body = {}; try { body = JSON.parse(opts.body || '{}'); } catch { /* not ours */ }
    const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }), headers: { getSetCookie: () => [] } });
    const fail = (message) => ({ ok: false, status: 400, json: async () => ({ error: { message } }), headers: { getSetCookie: () => [] } });

    if (u.startsWith('/api/rpc/')) {
        const name = decodeURIComponent(u.slice('/api/rpc/'.length));
        rpcCalls.push({ name, args: body, actor: actor.role });
        const a = rpcAnswer(name, body);
        return a.ok ? ok(a.data) : fail(a.message);
    }
    if (u === '/api/db') return ok(dbRead(body));
    return ok([]);
};

// ─── экраны ────────────────────────────────────────────────────────────────
const modals = await import('../views/admission-modal.js');
const admissionsView = await import('../views/admissions.js');
const marSheet = await import('../views/mar-sheet.js');
const marNurse = await import('../views/mar-nurse.js');
const kitchen = await import('../views/kitchen-sheet.js');
const dischargeView = await import('../views/discharge.js');
const perms = await import('../permissions.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

async function screen(render, ctx = {}) {
    const container = mkEl('div');
    BODY.appendChild(container);
    await render(container, ctx);
    await settle();
    return container;
}

// ===========================================================================
// 1. ВХОД В ЭКРАН ВЫПИСОК — то, чего у него не было
// ===========================================================================

test('«Выписки к оформлению» — пункт меню, маршрут, крошка и право', () => {
    const src = read('public/js/admin.js');

    const nav = src.slice(src.indexOf('const NAV = ['), src.indexOf('];', src.indexOf('const NAV = [')));
    assert.ok(/\{\s*id:\s*'discharge'/.test(nav), 'в сайдбаре нет пункта «Выписки»: экран снова недостижим');
    assert.ok(/case 'discharge':\s*return void await renderDischarge\(/.test(src),
        'нет ветки маршрута — по #discharge откроется пустой экран');
    assert.ok(/renderDischarge\s*\}\s*from '\.\/admin\/views\/discharge\.js/.test(src), 'экран не импортирован');
    assert.ok(/\bdischarge:\s*\['Clinical', 'Discharges'\]/.test(src), 'нет хлебной крошки');
    // CRUMBS — это ещё и список известных маршрутов при загрузке (isKnownView).
    assert.ok(/'Discharges':\s*t\('sidebar\.nav\.discharge'/.test(src), 'крошка не переводится');

    // Право — то же, что у остальных экранов раздела: ключ `beds`.
    const nurseRole = { name: 'Медсестра', permissions: { sections: ['patients', 'procedures', 'beds'], levels: { beds: 'editor' } } };
    const cashier = { name: 'Кассир', permissions: { sections: ['cashier', 'patients'], levels: { cashier: 'admin' } } };
    perms.setEffectiveFromRole(nurseRole);
    assert.equal(perms.isModuleAllowed('discharge'), true, 'клиника со стационаром обязана увидеть экран без похода в настройки ролей');
    assert.equal(perms.isRouteAllowed('discharge'), true);
    perms.setEffectiveFromRole(cashier);
    assert.equal(perms.isModuleAllowed('discharge'), false, 'касса в очереди выписок не стоит');
    assert.equal(perms.isRouteAllowed('discharge'), false);
    perms.setFullAccess('Admin');
});

test('отказы сервера, на которые опирается экран, — дословно те же строки', () => {
    const server = read('server/services/rpc/inpatient.js');
    for (const msg of modals.EPICRISIS_REFUSALS) {
        assert.ok(server.includes(msg),
            'браузер ждёт от сервера строку, которой на сервере нет:\n' + msg
            + '\nПерепишут её на сервере — и «напишите эпикриз» перестанет открывать бланк эпикриза.');
    }
    assert.equal(modals.needsEpicrisis(REFUSE_NO_EPICRISIS), true);
    assert.equal(modals.needsEpicrisis(REFUSE_DRAFT_EPICRISIS), true);
    assert.equal(modals.needsEpicrisis('Заявка на выписку уже подана.'), false,
        'к бланку эпикриза ведёт не всякий отказ — только тот, который им лечится');
});

// ===========================================================================
// 2. ВЕСЬ МАРШРУТ — одним пациентом, по экранам
// ===========================================================================

test('маршрут стационара проходится целиком: заявка → койка → осмотр → лечащий врач → назначение → доза → стол → заявка на выписку → оформление', async (t) => {

    await t.test('регистратура оформляет заявку на госпитализацию', async () => {
        beActor('registrar');
        BODY.children.length = 0; rpcCalls = [];
        modals.openAdmissionOrderModal({ patientId: 101, patientName: 'Иванов Иван Иванович', patientMrn: 'M-101' });
        await settle();
        const overlay = topOverlay();
        assert.ok(overlay, 'окно заявки не открылось');
        walk(overlay).find((e) => e.tagName === 'SELECT' && walk(e).some((o) => (o._text || '') === 'Палату выберет медсестра')).value = '1';
        findBtn(overlay, 'Оформить заявку').click();
        await settle();

        const call = rpcCalls.find((c) => c.name === 'admission_order_create');
        assert.ok(call, 'заявка не ушла на сервер');
        assert.equal(call.args.patient_id, 101);
        assert.equal(WORLD.admissions.length, 1);
        assert.equal(adm().status, 'ordered');
    });

    await t.test('медсестра кладёт пациента на койку из окна «Стационар»', async () => {
        beActor('nurse');
        BODY.children.length = 0; rpcCalls = [];
        const root = await screen(admissionsView.renderAdmissions);
        assert.ok(textOf(root).includes('Иванов Иван Иванович'), 'заявка не видна медсестре');

        findBtn(root, 'Положить на койку').click();
        await settle();
        const picker = topOverlay();
        const bedBtn = walk(picker).find((e) => e.tagName === 'BUTTON' && textOf(e).includes('T-2'));
        assert.ok(bedBtn, 'свободной койки в выборе нет');
        bedBtn.click();
        findBtn(picker, 'Положить').click();
        await settle();

        const call = rpcCalls.find((c) => c.name === 'admission_admit');
        assert.ok(call, 'размещение не ушло на сервер');
        assert.equal(call.args.bed_id, 6);
        assert.equal(adm().status, 'admitted');
    });

    await t.test('первичный осмотр проводит главный врач — и тут же назначает лечащего', async () => {
        beActor('head_doctor');
        BODY.children.length = 0; rpcCalls = [];
        const root = await screen(admissionsView.renderAdmissions);
        assert.ok(textOf(root).includes('Ждут первичного осмотра'));

        findBtn(root, 'Провести первичный осмотр').click();
        await settle();
        const review = topOverlay();
        walk(review).find((e) => e.tagName === 'INPUT' && (e.attrs.placeholder || '').includes('Диагноз при поступлении')).value = 'J18.9';
        findBtn(review, 'Опубликовать осмотр').click();
        await settle();

        const saved = rpcCalls.find((c) => c.name === 'admission_review_save');
        assert.ok(saved && saved.args.publish === true && saved.args.kind === 'primary');
        assert.equal(adm().status, 'examined');

        // Осмотр опубликован — окно лечащего врача открывается САМО: искать
        // того же пациента заново в другом списке никто не пойдёт.
        const attending = topOverlay();
        assert.ok(textOf(attending).includes('Назначить лечащего врача'), 'после осмотра лечащего врача не спросили');
        const sel = walk(attending).find((e) => e.tagName === 'SELECT');
        sel.value = '77';
        findBtn(attending, 'Назначить').click();
        await settle();

        const set = rpcCalls.find((c) => c.name === 'admission_set_attending');
        assert.ok(set && set.args.doctor_id === 77, 'лечащий врач не назначен');
        assert.equal(adm().status, 'active', 'лечение открыто');
    });

    await t.test('лечащий врач назначает препарат на листе назначений', async () => {
        beActor('doctor');
        BODY.children.length = 0; rpcCalls = [];
        const root = await screen(marSheet.renderMarSheet, { payload: { sub: String(adm().id) } });
        assert.ok(textOf(root).includes('Лист назначений'));
        assert.ok(textOf(root).includes('Иванов Иван Иванович'), 'лист открыт не на том пациенте');

        findBtn(root, 'Назначение').click();
        await settle();
        const form = topOverlay();
        walk(form).find((e) => e.tagName === 'INPUT' && (e.attrs.placeholder || '').includes('Название препарата')).value = 'Цефтриаксон';
        walk(form).find((e) => e.tagName === 'INPUT' && (e.attrs.placeholder || '').includes('500 мг')).value = '1 г';
        const routeSel = walk(form).find((e) => e.tagName === 'SELECT' && walk(e).some((o) => (o._text || '') === 'в/в'));
        routeSel.value = 'в/в';
        findBtn(form, 'Назначить').click();
        await settle();

        const call = rpcCalls.find((c) => c.name === 'treatment_order_create');
        assert.ok(call, 'назначение не ушло на сервер');
        assert.equal(call.args.name, 'Цефтриаксон');
        assert.equal(call.args.route, 'в/в');
        assert.equal(call.args.admission_id, adm().id);
        assert.equal(WORLD.orders.length, 1);
    });

    await t.test('лечащий врач назначает стол в карте своего пациента', async () => {
        // ЭТОГО ШАГА В ПРОГРАММЕ НЕ БЫЛО. Пять RPC стола были написаны и покрыты
        // тестами, порционник печатался — и ни у одного из них не было
        // вызывающего: кухня получала «Стол не назначен» на каждого пациента
        // навсегда. Здесь шаг делается ровно тем нажатием, каким его делает врач.
        beActor('doctor');
        BODY.children.length = 0; rpcCalls = [];
        modals.openAdmissionCard({ admissionId: adm().id });
        await settle();
        const card = topOverlay();
        assert.ok(textOf(card).includes('Стол не назначен'),
            'до назначения стол назван словом, а не пустой строкой');

        findBtn(card, 'Сменить стол').click();
        await settle();
        const picker = topOverlay();
        assert.ok(textOf(picker).includes('Сахарный диабет'),
            'столы предлагают без показаний — врач выбирал бы по памяти');
        findBtn(picker, 'Стол №9').click();
        walk(picker).find((e) => e.tagName === 'SELECT').value = '5';
        findBtn(picker, 'Назначить стол').click();
        await settle();

        const call = rpcCalls.find((c) => c.name === 'admission_diet_set');
        assert.ok(call, 'назначение стола не ушло на сервер');
        assert.equal(call.args.diet_code, '9');
        assert.equal(call.args.meals_per_day, 5);
        assert.equal(WORLD.diets.length, 1);
        assert.equal(WORLD.diets[0].assigned_by, ACTORS.doctor.id, 'автором пишется ТОТ, КТО НАЖАЛ');
        assert.ok(textOf(topOverlay()).includes('Стол №9'), 'назначенный стол не вернулся в карточку');
    });

    await t.test('медсестра вводит дозу через сверку «5 прав»', async () => {
        beActor('nurse');
        BODY.children.length = 0; rpcCalls = [];
        const root = await screen(marNurse.renderMarNurse);
        assert.ok(textOf(root).includes('Иванов Иван Иванович'), 'пациента нет в задачах смены');
        assert.ok(textOf(root).includes('Цефтриаксон'), 'назначение врача не дошло до медсестры');
        assert.ok(textOf(root).includes('Аллергия') && textOf(root).includes('Пенициллин'),
            'аллергия из карты пациента обязана быть на экране ДО открытия окна');

        // И ТУТ ЖЕ ПИТАНИЕ — на том же экране, полосой НИЖЕ назначений. Стол,
        // назначенный врачом шагом выше, доехал до того, кто носит еду; отмечает
        // она приём пищи здесь же, а не на третьем экране, куда зайдёт вечером и
        // заполнит по памяти.
        const meals = walk(root).find((e) => e.className === 'card' && textOf(e).includes('Питание сегодня'));
        assert.ok(meals, 'полосы питания на рабочем месте медсестры нет');
        assert.ok(textOf(meals).includes('Стол №9'), 'стол врача не доехал до медсестры: ' + textOf(meals));
        const lunch = meals.children.find((c) => textOf(c).includes('Обед'));
        const mealSel = walk(lunch).find((e) => e.tagName === 'SELECT');
        rpcCalls = [];
        mealSel.value = 'refused';
        mealSel.dispatchEvent({ type: 'change', currentTarget: mealSel });
        await settle();
        const fed = rpcCalls.find((c) => c.name === 'admission_meal_mark');
        assert.ok(fed, 'отметка приёма пищи не ушла на сервер');
        assert.equal(fed.args.meal_key, 'lunch');
        assert.equal(fed.args.status, 'refused');
        assert.equal(WORLD.meals.length, 1);

        rpcCalls = [];

        findBtn(root, 'Выполнить').click();
        await settle();
        const confirm = topOverlay();
        const txt = textOf(confirm);
        for (const right of ['Пациент', 'Препарат', 'Доза', 'Путь введения', 'Время']) {
            assert.ok(txt.includes(right), 'в сверке нет права «' + right + '»');
        }
        assert.ok(txt.includes('T-2'), 'пациент назван койкой, а не только именем');
        findBtn(confirm, 'Подтвердить введение').click();
        await settle();

        const call = rpcCalls.find((c) => c.name === 'treatment_admin_mark');
        assert.ok(call, 'отметка не ушла на сервер');
        assert.equal(call.args.status, 'given');
        assert.equal(call.args.order_id, WORLD.orders[0].id);
        assert.equal(WORLD.marks.length, 1);

    });

    await t.test('порционник видит лежащего пациента', async () => {
        beActor('nurse');
        BODY.children.length = 0; rpcCalls = [];
        const root = await screen(kitchen.renderKitchenSheet);
        assert.ok(textOf(root).includes('Порционник'));
        assert.ok(textOf(root).includes('Иванов Иван Иванович'), 'пациента на койке нет в заказе на кухню');
        assert.ok(textOf(root).includes('T-2'), 'койка в порционнике не названа');
        // И СТОЛ, НАЗНАЧЕННЫЙ ВРАЧОМ, — ЗДЕСЬ. Это и есть замкнувшийся круг:
        // раньше в этой строке стояло «Стол не назначен» навсегда, потому что
        // назначить его было негде.
        assert.ok(textOf(root).includes('Стол №9'), 'стол врача не доехал до кухни');
        assert.ok(textOf(root).includes('5-разовое'), 'разовость питания на кухню не доехала');
    });

    await t.test('медсестре заявку на выписку не показывают — исход объявляет врач', async () => {
        beActor('nurse');
        BODY.children.length = 0; rpcCalls = [];
        modals.openAdmissionCard({ admissionId: adm().id });
        await settle();
        const card = topOverlay();
        assert.ok(textOf(card).includes('Иванов Иван Иванович'));
        assert.equal(findBtn(card, 'Заявка на выписку'), undefined,
            'кнопку рисует ответ сервера (inpatient_capabilities), а не название экрана');
    });

    await t.test('врач подаёт заявку на выписку — и отказ ведёт в бланк эпикриза', async () => {
        beActor('doctor');
        BODY.children.length = 0; rpcCalls = [];
        modals.openAdmissionCard({ admissionId: adm().id });
        await settle();
        const card = topOverlay();
        const btn = findBtn(card, 'Заявка на выписку');
        assert.ok(btn, 'лечащий врач не видит первого шага выписки в карте своего пациента');
        btn.click();
        await settle();

        const form = topOverlay();
        assert.ok(textOf(form).includes('Исход госпитализации'), 'исход не спрашивают');
        for (const outcome of ['Выписан домой', 'Переведён в другое учреждение', 'Отказ от лечения', 'Летальный исход']) {
            assert.ok(textOf(form).includes(outcome), 'нет исхода «' + outcome + '»');
        }
        // В настоящем <select> первый вариант выбран сам; здешний DOM этого не
        // умеет, поэтому исход выбирается вслух — как и в остальных тестах.
        walk(form).find((e) => e.tagName === 'SELECT').value = 'home';
        walk(form).find((e) => e.tagName === 'TEXTAREA').value = 'Амоксициллин 7 дней, явка через неделю';

        // ПЕРВАЯ ПОПЫТКА — БЕЗ ЭПИКРИЗА. Сервер отказывает, и человек обязан
        // увидеть ЕГО слова, а не пересказ, и попасть туда, где отказ снимают.
        findBtn(form, 'Подать заявку').click();
        await settle();
        assert.equal(lastToast(), REFUSE_NO_EPICRISIS, 'отказ сервера пересказан своими словами');
        assert.equal(adm().status, 'active', 'выписка по ненаписанному эпикризу не проходит');

        const epicrisis = topOverlay();
        assert.ok(textOf(epicrisis).includes('Выписной эпикриз'),
            'после отказа «напишите эпикриз» бланк эпикриза должен открыться сам — иначе это тупик');
        findBtn(epicrisis, 'Опубликовать эпикриз').click();
        await settle();
        const saved = rpcCalls.filter((c) => c.name === 'admission_review_save').pop();
        assert.equal(saved.args.kind, 'discharge');
        assert.equal(saved.args.publish, true);

        // ВТОРАЯ ПОПЫТКА — форма заявки никуда не делась, она под эпикризом.
        rpcCalls = [];
        const again = topOverlay();
        assert.ok(textOf(again).includes('Исход госпитализации'), 'форма заявки закрылась вместе с отказом');
        walk(again).find((e) => e.tagName === 'SELECT').value = 'home';
        findBtn(again, 'Подать заявку').click();
        await settle();

        const call = rpcCalls.find((c) => c.name === 'admission_discharge_request');
        assert.ok(call, 'заявка не ушла на сервер');
        assert.equal(call.args.outcome, 'home');
        assert.equal(call.args.recommendations, 'Амоксициллин 7 дней, явка через неделю');
        assert.equal(adm().status, 'discharging', 'заявка подана');
        // ВРАЧ КОЙКУ НЕ ОСВОБОЖДАЕТ.
        assert.equal(WORLD.beds.find((b) => b.id === 6).status, 'occupied');
    });

    await t.test('заявку можно отозвать — единственная стрелка назад — и подать снова', async () => {
        beActor('doctor');
        BODY.children.length = 0; rpcCalls = [];
        modals.openAdmissionCard({ admissionId: adm().id });
        await settle();
        findBtn(topOverlay(), 'Отозвать заявку').click();
        await settle();
        const form = topOverlay();
        walk(form).find((e) => e.tagName === 'INPUT' && (e.attrs.placeholder || '').includes('поднялась температура')).value = 'Поднялась температура';
        findBtn(form, 'Отозвать заявку').click();
        await settle();
        assert.equal(adm().status, 'active', 'отзыв не вернул пациента в лечение');
        assert.equal(adm().discharge_outcome, null, 'исход у лежащего пациента — ложь на карточке');

        // И тем же движением обратно: эпикриз опубликован, второй раз его не просят.
        BODY.children.length = 0; rpcCalls = [];
        modals.openAdmissionCard({ admissionId: adm().id });
        await settle();
        findBtn(topOverlay(), 'Заявка на выписку').click();
        await settle();
        walk(topOverlay()).find((e) => e.tagName === 'SELECT').value = 'home';
        findBtn(topOverlay(), 'Подать заявку').click();
        await settle();
        assert.equal(adm().status, 'discharging');
    });

    await t.test('старшая медсестра оформляет выписку на своём экране', async () => {
        beActor('senior_nurse');
        BODY.children.length = 0; rpcCalls = [];
        const root = await screen(dischargeView.renderDischarge);
        assert.ok(textOf(root).includes('Выписки к оформлению'));
        assert.ok(textOf(root).includes('Иванов Иван Иванович'), 'пациента с поданной заявкой нет в очереди оформления');
        assert.ok(textOf(root).includes('Выписан домой'), 'исход, объявленный врачом, до оформляющего не доехал');
        assert.ok(textOf(root).includes('Юсупов А.'), 'очередь не называет лечащего врача');

        findBtn(root, 'Оформить выписку').click();
        await settle();
        const form = topOverlay();
        assert.ok(textOf(form).includes('Фактическое время выписки'), 'время выписки — факт, а не «когда нажали»');
        assert.ok(textOf(form).includes('Амоксициллин 7 дней'), 'рекомендации врача не показаны тому, кто выдаёт документы');
        findBtn(form, 'Оформить выписку').click();
        await settle();

        const call = rpcCalls.find((c) => c.name === 'admission_discharge_finalize');
        assert.ok(call, 'оформление не ушло на сервер');
        assert.equal(adm().status, 'discharged');
        // КОЙКА НЕ СТАНОВИТСЯ СВОБОДНОЙ — она уходит на уборку (ловушка плана).
        assert.equal(WORLD.beds.find((b) => b.id === 6).status, 'cleaning');
    });

    await t.test('и очередь оформления после этого пуста', async () => {
        beActor('senior_nurse');
        BODY.children.length = 0;
        const root = await screen(dischargeView.renderDischarge);
        assert.ok(textOf(root).includes('Заявок на выписку нет'), 'выписанный остался в очереди оформления');
    });
});
