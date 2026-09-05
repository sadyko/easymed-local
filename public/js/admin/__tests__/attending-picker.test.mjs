// ATTENDING_PICKER_V1 — «Назначить лечащего врача»: список тот же, что примет
// сервер.
//
// ─── ЧТО СЛОМАЛОСЬ У ВЛАДЕЛЬЦА ──────────────────────────────────────────────
//
// Главный врач открыл «Назначить лечащего врача» на госпитализации
// P-26-70125 · ADM-00005 и увидел в поле «Лечащий врач» один «Выберите врача».
// Врачи в клинике были. Пустым приходил ОТВЕТ: окно просило у таблицы users
// колонку `license_number`, а реестр (server/db/schema-registry.js) у users её
// не отдаёт — и компилятор (server/db/query-compiler.js) на неразрешённое поле
// не «пропускает лишнее», а отказывает ВСЕМУ запросу («unknown column», 400).
// Ошибку никто не читал (`.then(({ data }) => …)`), `data` был null, и
// `(data || [])` превращал сбой в пустой список. Тот же класс уже ронял раздел
// «Стационар» (patients(phone)) и «Календарь записи» (пять колонок).
//
// ─── ЧТО ЗДЕСЬ ПРОВЕРЯЕТСЯ ──────────────────────────────────────────────────
//
//   1. СПИСОК ЕДЕТ С СЕРВЕРА и совпадает с ним не «по договорённости», а
//      физически: ожидание считается ТЕМ ЖЕ предикатом isDoctorRow, которым
//      сервер потом отказывает выбранному. Переписанный от руки список — это
//      вторая копия правила, и именно она когда-то и разошлась.
//   2. АДМИНИСТРАТОР-ВРАЧ В СПИСКЕ ЕСТЬ (ADMIN_DOCTOR_LIST_V1: у него
//      role='admin', специальности нет, и только is_doctor говорит правду), а
//      кассир, регистратор и УВОЛЕННЫЙ врач — нет.
//   3. ОТКАЗ ЗАПРОСА ВЫГЛЯДИТ КАК ОТКАЗ, а не как пустая клиника, и несёт
//      причину: чинит его не тот, кто стоит у экрана.
//   4. ПУСТОТА РАЗЛИЧАЕТСЯ: «в клинике нет врачей», «все врачи уволены» и «не
//      удалось загрузить» — три разных предложения.
//   5. НАЗНАЧЕНИЕ РАБОТАЕТ НАСКВОЗЬ и по-прежнему двигает 'examined' → 'active'
//      в настоящей базе.
//   6. СТАРЫЙ ЗАПРОС ПО-ПРЕЖНЕМУ ОТВЕРГАЕТСЯ реестром (отрицательный контроль),
//      и в исходнике окна его больше нет.
//
// ЧТО ЗДЕСЬ НАСТОЯЩЕЕ: подделан только транспорт — `fetch` зовёт серверные
// модули напрямую. База настоящая (better-sqlite3 в памяти под настоящими
// миграциями), RPC настоящие, реестр и компилятор настоящие.

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── минимальный DOM (тот же стенд, что у admission-diet / inpatient-route) ──
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
    // value ЗЕРКАЛИТСЯ в свойство: <option value="7"> в настоящем DOM читается
    // и как атрибут, и как .value, а выбор в select — это именно .value.
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'value') this.value = String(v); }
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); }
    removeAttribute(k) { delete this.attrs[k]; }
    addEventListener(t, fn) { (this._l[t] || (this._l[t] = [])).push(fn); }
    removeEventListener() {}
    dispatchEvent(e) { for (const fn of this._l[e.type] || []) fn(e); return true; }
    click() { this.dispatchEvent({ type: 'click', currentTarget: this, target: this, preventDefault() {}, stopPropagation() {} }); }
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
// I18N_LOCALE_PIN_V1 — окно рисуется по-русски независимо от локали машины.
globalThis.localStorage = { getItem: (k) => (k === 'admin.lang' ? 'ru' : null), setItem() {}, removeItem() {}, clear() {} };
globalThis.window = { location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, addEventListener() {}, open: () => null };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();

const walk = (e, out = []) => { if (!e || typeof e !== 'object') return out; out.push(e); for (const c of e.children || []) walk(c, out); return out; };
const textOf = (e) => walk(e).map((x) => x._text || '').join(' ');
const findBtn = (root, label) => walk(root).find((e) => e.tagName === 'BUTTON' && textOf(e).includes(label));
const topOverlay = () => BODY.children.filter((c) => c.className === 'modal').pop() || null;
const settle = () => new Promise((r) => setTimeout(r, 30));
const toastText = () => {
    const el = BODY.children.find((c) => c.attrs && c.attrs.id === 'toast');
    return el ? el.textContent : '';
};

// ─── настоящая база, настоящие RPC, настоящий компилятор ────────────────────
const { openDb } = await import('../../../../server/db/connection.js');
const { migrate } = await import('../../../../server/db/migrate.js');
const { compile } = await import('../../../../server/db/query-compiler.js');
const inpatient = await import('../../../../server/services/rpc/inpatient.js');
const reviews = await import('../../../../server/services/rpc/inpatient-reviews.js');

const HEAD_DOCTOR = { id: 4, role: 'doctor', extra_roles: ['head_doctor'], full_name: 'Юсупова Д.' };
const REGISTRAR = { id: 2, role: 'registrar' };
const NURSE = { id: 3, role: 'nurse' };

// Штат клиники ровно тот, на котором ошибка и живёт: врач по роли, ГЛАВНЫЙ врач,
// АДМИНИСТРАТОР-ВРАЧ (role='admin', специальности нет), уволенный врач — и трое,
// кто врачом не является.
//         id  username   full_name                role         is_doctor specialty     active
const STAFF = [
    [1, 'admin1', 'Администратор клиники', 'admin', 0, '', 1],
    [2, 'reg1', 'Регистратор Азиза', 'registrar', 0, '', 1],
    [3, 'nurse1', 'Медсестра поста', 'nurse', 0, '', 1],
    [4, 'hdoc1', 'Юсупова Дилноза', 'doctor', 1, 'Терапия', 1],
    [5, 'doc1', 'Каримов Рустам', 'doctor', 1, 'Хирургия', 1],
    [6, 'cash1', 'Кассир Нигора', 'cashier', 0, '', 1],
    [7, 'admdoc', 'Собиров Ботир', 'admin', 1, '', 1],
    [8, 'fired1', 'Уволенный Врач', 'doctor', 1, 'Неврология', 0],
];

/** Строка штата — врач ли (тем же предикатом, что у сервера). */
function isDoctorStaffRow(row) {
    return reviews.isDoctorRow({ role: row[3], is_doctor: row[4], specialty: row[5] });
}

let db = null;
let actor = HEAD_DOCTOR;
let candidatesFail = null;   // строка — RPC списка отвечает отказом

function makeDb(staff) {
    const d = openDb(':memory:');
    migrate(d);
    const ins = d.prepare(
        'INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, specialty, is_active) VALUES (?,?,?,?,?,?,?,?)');
    for (const [id, username, full, role, isDoc, spec, active] of staff) {
        ins.run(id, username, 'x', full, role, isDoc, spec, active);
    }
    d.prepare("INSERT INTO patients (id, mrn, full_name) VALUES (1, 'P-26-70125', 'Шодибоева Замира')").run();
    d.prepare("INSERT INTO wards (id, name) VALUES (1, 'Терапия')").run();
    d.prepare("INSERT INTO beds (id, code, ward_id, status) VALUES (1, 'T-1', 1, 'free')").run();
    return d;
}

/** Пациент доведён до 'examined' настоящими шагами маршрута — как в жизни. */
function admissionAtExamined() {
    const { admission } = inpatient.admissionOrderCreate(db, { patient_id: 1, department: 'Терапия' }, REGISTRAR);
    inpatient.admissionAdmit(db, { admission_id: admission.id, bed_id: 1 }, NURSE);
    const r = reviews.admissionReviewSave(db, {
        admission_id: admission.id, kind: 'primary',
        complaints: 'Боли', objective: 'Состояние удовлетворительное',
        diagnosis: 'Гастрит', plan: 'Стол №1', publish: true,
    }, HEAD_DOCTOR);
    return r.admission;
}

const RPC = {
    admission_attending_candidates: (a, u) => {
        if (candidatesFail) { const e = new Error(candidatesFail); e.status = 400; throw e; }
        return reviews.admissionAttendingCandidates(db, a, u);
    },
    admission_set_attending: (a, u) => reviews.admissionSetAttending(db, a, u),
};

globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    let body = {}; try { body = JSON.parse(opts.body || '{}'); } catch { /* not ours */ }
    const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }), headers: { getSetCookie: () => [] } });
    const fail = (message) => ({ ok: false, status: 400, json: async () => ({ error: { message } }), headers: { getSetCookie: () => [] } });

    if (u.startsWith('/api/rpc/')) {
        const name = decodeURIComponent(u.slice('/api/rpc/'.length));
        const fn = RPC[name];
        if (!fn) return ok({});
        try { return ok(fn(body, actor)); } catch (e) { return fail(e && e.message ? e.message : String(e)); }
    }
    // /api/db идёт через НАСТОЯЩИЙ компилятор с НАСТОЯЩИМ реестром: вернись
    // окно к запросу таблицы users — отказ придёт здесь, а не у владельца.
    if (u === '/api/db') {
        try {
            const { sql, params } = compile(body, actor);
            return ok(db.prepare(sql).all(...params));
        } catch (e) { return fail(e && e.message ? e.message : String(e)); }
    }
    return ok([]);
};

const modals = await import('../views/admission-modal.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..', '..');
const MODAL_SRC = fs.readFileSync(path.join(REPO, 'public/js/admin/views/admission-modal.js'), 'utf8');

/** Открыть окно назначения на свежей базе и вернуть {overlay, select, admission}. */
async function openPicker({ staff = STAFF, fail = null } = {}) {
    if (db) db.close();
    db = makeDb(staff);
    candidatesFail = fail;
    BODY.children.length = 0;
    const admission = admissionAtExamined();
    modals.openAdmissionAttendingModal({
        admission: Object.assign({}, admission, { patients: { mrn: 'P-26-70125', full_name: 'Шодибоева Замира' } }),
    });
    await settle();
    const overlay = topOverlay();
    assert.ok(overlay, 'окно «Назначить лечащего врача» не открылось');
    const select = walk(overlay).find((e) => e.tagName === 'SELECT');
    assert.ok(select, 'в окне нет поля выбора врача');
    return { overlay, select, admission };
}

/** Что человек реально видит в списке — без строки-приглашения. */
const optionsOf = (select) => select.children
    .filter((o) => o.getAttribute('value'))
    .map((o) => ({ id: Number(o.getAttribute('value')), label: o.textContent }));

// ===========================================================================
// 1. Список есть — и он ровно тот, что примет сервер
// ===========================================================================

test('РЕГРЕССИЯ: в списке «Лечащий врач» есть врачи — не один «Выберите врача»', async () => {
    const { select } = await openPicker();
    assert.ok(optionsOf(select).length > 0,
        'список врачей пуст — ровно то, что видел владелец на ADM-00005');
    assert.equal(select.disabled, false, 'список пришёл, а выбирать по-прежнему нельзя');
});

test('список окна = ровно тот набор, который принимает isDoctorRow на сервере', async () => {
    const { select } = await openPicker();
    const shown = optionsOf(select).map((o) => o.id).sort((a, b) => a - b);

    // Ожидание считается ТЕМ ЖЕ предикатом, которым сервер отказывает
    // выбранному: разойтись экрану и серверу физически нечем.
    const expected = db.prepare('SELECT * FROM users').all()
        .filter((u) => reviews.isDoctorRow(u) && u.active !== 0)
        .map((u) => u.id).sort((a, b) => a - b);

    assert.deepEqual(shown, expected,
        'экран показывает не тех, кого примет сервер — две копии правила снова разошлись');
});

test('ADMIN_DOCTOR_LIST_V1: администратор-врач в списке ЕСТЬ; кассир, регистратор и уволенный — нет', async () => {
    const { select } = await openPicker();
    const opts = optionsOf(select);
    const labels = opts.map((o) => o.label).join(' | ');

    assert.ok(opts.some((o) => o.id === 5), 'врача с role=doctor нет в списке');
    assert.ok(opts.some((o) => o.id === 7),
        'администратора-врача (role=admin, специальности нет, is_doctor=1) нельзя назначить лечащим — а сервер его принимает');
    assert.ok(!opts.some((o) => o.id === 6), 'кассир попал в список врачей');
    assert.ok(!opts.some((o) => o.id === 2), 'регистратор попал в список врачей');
    assert.ok(!opts.some((o) => o.id === 3), 'медсестра попала в список врачей');
    assert.ok(!opts.some((o) => o.id === 8), 'уволенный врач предложен к назначению');
    assert.ok(!labels.includes('Уволенный Врач'), 'уволенный врач виден в списке');
    assert.ok(labels.includes('Хирургия'), 'специальность врача не показана — по одним фамилиям выбирают вслепую');
});

// ===========================================================================
// 2. Пустота объясняет себя — тремя разными предложениями
// ===========================================================================

test('ОТКАЗ ЗАПРОСА — это сбой, а не пустая клиника, и он называет причину', async () => {
    const { overlay, select } = await openPicker({ fail: 'unknown column' });
    const txt = textOf(overlay);

    assert.ok(txt.includes('сбой запроса'),
        'отказ сервера выглядит как «врачей нет» — владелец пойдёт заводить врачей, которые заведены');
    assert.ok(txt.includes('unknown column'), 'причина отказа спрятана от того, кто чинит');
    assert.ok(!txt.includes('нет ни одного врача'), 'сбой не смеет называться пустой клиникой');
    assert.equal(optionsOf(select).length, 0);

    // …и кнопка отвечает тем же словом, а не общим «выберите врача».
    findBtn(overlay, 'Назначить').click();
    await settle();
    assert.ok(toastText().includes('сбой запроса'),
        'нажатие отвечает «выберите врача» там, где выбирать не из чего по вине сервера');
});

test('КЛИНИКА БЕЗ ВРАЧЕЙ говорит об этом словами — и это не «не удалось загрузить»', async () => {
    // Врачей нет НИ ОДНОГО, но люди в клинике есть: те, кто был врачом, здесь
    // заведены обычными администраторами. Удалять их строки нельзя — на
    // авторе первичного осмотра стоит внешний ключ, и «пустая клиника» в этом
    // тесте означает «нет врачей», а не «нет базы».
    const noDoctors = STAFF.map((r) => (isDoctorStaffRow(r) ? [r[0], r[1], r[2], 'admin', 0, '', r[6]] : r));
    const { overlay, select } = await openPicker({ staff: noDoctors });
    const txt = textOf(overlay);

    assert.equal(optionsOf(select).length, 0);
    assert.ok(txt.includes('нет ни одного врача'), 'пустой список не объяснил себя');
    assert.ok(txt.includes('Сотрудники'), 'человеку не сказали, где эту пустоту чинят');
    assert.ok(!txt.includes('сбой запроса'), '«врачей нет» не должно выглядеть поломкой');
    assert.ok(!txt.includes('уволен'), 'врачей не было вовсе — увольнять было некого');
});

test('ВСЕ ВРАЧИ УВОЛЕНЫ — третье состояние, и оно отличается от первых двух', async () => {
    const allFired = STAFF.map((r) => (isDoctorStaffRow(r) ? [...r.slice(0, 6), 0] : r));
    const { overlay, select } = await openPicker({ staff: allFired });
    const txt = textOf(overlay);

    assert.equal(optionsOf(select).length, 0);
    assert.ok(txt.includes('уволен'), 'клиника с одними уволенными врачами молчит о причине');
    assert.ok(!txt.includes('нет ни одного врача'),
        '«все уволены» чинят восстановлением сотрудника, «врачей нет» — заведением нового: это разные подсказки');
    assert.ok(!txt.includes('сбой запроса'));
});

// ===========================================================================
// 3. Назначение работает насквозь
// ===========================================================================

test('НАСКВОЗЬ: выбрали врача — госпитализация ушла из «осмотрен» в «лечение»', async () => {
    const { overlay, select, admission } = await openPicker();
    assert.equal(db.prepare('SELECT status FROM admissions WHERE id=?').get(admission.id).status, 'examined');

    const chosen = optionsOf(select).find((o) => o.id === 5);
    assert.ok(chosen, 'врача Каримова нет в списке');
    select.value = String(chosen.id);

    findBtn(overlay, 'Назначить').click();
    await settle();

    const row = db.prepare('SELECT status, attending_doctor_id FROM admissions WHERE id=?').get(admission.id);
    assert.equal(row.status, 'active', 'назначение лечащего врача не открыло лечение');
    assert.equal(row.attending_doctor_id, 5);
    assert.ok(toastText().includes('лечение открыто'), 'человеку не сказали, что получилось');
    assert.equal(topOverlay(), null, 'окно осталось открытым после успешного назначения');
});

test('администратора-врача тоже можно назначить — до конца, а не только показать', async () => {
    const { overlay, select, admission } = await openPicker();
    select.value = '7';
    findBtn(overlay, 'Назначить').click();
    await settle();
    const row = db.prepare('SELECT status, attending_doctor_id FROM admissions WHERE id=?').get(admission.id);
    assert.equal(row.attending_doctor_id, 7, 'администратор-врач показан в списке, но назначить его не вышло');
    assert.equal(row.status, 'active');
});

// ===========================================================================
// 4. Отрицательный контроль: тот самый запрос по-прежнему отвергается
// ===========================================================================

test('РЕГРЕССИЯ: старый запрос окна реестр отвергает ОТКАЗОМ ВСЕМУ ЗАПРОСУ', () => {
    const asUsers = (columns) => compile({
        table: 'users', op: 'select', columns,
        filters: [{ col: 'active', op: 'eq', val: true }], order: [{ col: 'full_name', asc: true }],
    }, HEAD_DOCTOR);

    // Ровно та строка, что стояла в окне до этой правки.
    assert.throws(() => asUsers('id, full_name, specialty, role, is_doctor, license_number'), /unknown column/,
        'реестр перестал отвергать license_number — тогда и защищать больше нечего');
    // …и отличается она от разрешённой ровно этим полем: список ронял НЕ запрос
    // вообще, а одна лишняя колонка.
    assert.doesNotThrow(() => asUsers('id, full_name, specialty, role, is_doctor'));
});

test('окно больше не перечисляет колонки users — добавить туда лишнюю нечем', () => {
    const at = MODAL_SRC.indexOf('export function openAdmissionAttendingModal');
    assert.ok(at > -1, 'функция окна переименована — тест смотрит не туда');
    const body = MODAL_SRC.slice(at, at + 4000);
    assert.ok(!/supabase\s*\.\s*from\s*\(\s*'users'\s*\)/.test(body),
        'окно снова собирает список врачей само: следующая лишняя колонка снова опустошит его');
    assert.ok(body.includes('admission_attending_candidates'),
        'список врачей обязан ехать тем же правилом, которым сервер проверяет выбранного');
    // Признак врача больше не повторяется в браузере — одна копия правила.
    assert.ok(!/is_doctor\s*===\s*true/.test(body),
        'в окне снова заведена вторая копия признака «врач» — она разойдётся с серверной');
});
