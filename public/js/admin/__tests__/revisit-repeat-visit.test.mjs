// REPEAT_VISIT_V1 (2026-11-02) — «ПОВТОРНЫЙ ВИЗИТ» КАБИНЕТА ЗАНИМАЕТ ВРЕМЯ.
//
// Окно повторного визита писало визит тремя запросами браузера, а в день, где
// у пациента уже был приём, предлагало «Добавить в этот визит» — визит не
// менялся, время не занималось, а окно говорило «Пациент записан» и вставляло
// время в документ. Здесь окно проходит весь путь через НАСТОЯЩИЙ сервер
// (createApp, база в памяти — тот же стенд, что consultation-flags.test.mjs):
//   • свободный день — один calendar_book: визит 'repeat' и строка
//     консультации со временем приёма, окно закрыто, «записан» — правда;
//   • день, где у пациента уже есть приём, — отказ словами В ОКНЕ, окно
//     открыто, «записан» не сказано, «Добавить в этот визит» не спрошено,
//     в базе ничего нового.
// Дни — 10-е число следующего месяца (кнопка «+1 мес»): «сегодня» не участвует.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom, El, TOASTS } from './cabinet-harness.mjs';

installFakeDom();
for (const [k, fn] of Object.entries({
    click() { this.dispatch('click'); },
    dispatchEvent(e) { this.dispatch(e.type, e); return true; },
    replaceChildren(...cs) { this.children = []; cs.forEach((c) => this.appendChild(c)); },
    contains() { return false; }, scrollTo() {}, select() {},
})) if (!(k in El.prototype)) El.prototype[k] = fn;
globalThis.window.CLINIC = { id: 1, name: 'Клиника' };

const { openDb } = await import('../../../../server/db/connection.js');
const { migrate } = await import('../../../../server/db/migrate.js');
const { hashPassword } = await import('../../../../server/services/auth.js');
const { createApp } = await import('../../../../server/app.js');
const { licensedDataDir } = await import('../../../../server/services/control/licensed-fixture.js');
const { listen } = await import('../../../../control-plane/server/test-helpers/listen.js');

const DB = openDb(':memory:');
migrate(DB);
const WEEK = JSON.stringify(Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, { on: true, from: '09:00', to: '18:00' }])));
const addUser = DB.prepare('INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, working_hours) VALUES (?,?,?,?,?,?,?)');
addUser.run(1, 'boss', hashPassword('password1'), 'Админ Клиники', 'admin', 0, '');
addUser.run(10, 'doc', hashPassword('password1'), 'Иванов Иван', 'doctor', 1, WEEK);
addUser.run(11, 'doc2', hashPassword('password1'), 'Петров Пётр', 'doctor', 1, WEEK);
DB.prepare("INSERT INTO consultation_types (id, name, name_ru, price, sort_order, active) VALUES (6,'Повторный','Повторный приём',60000,1,1)").run();
DB.prepare("INSERT INTO patients (id, full_name) VALUES (77,'Пациент Свободный')").run();
DB.prepare("INSERT INTO patients (id, full_name) VALUES (78,'Пациент Занятый')").run();
const PETROV = 11;

const realFetch = globalThis.fetch;
const server = await listen(createApp(DB, { dataDir: licensedDataDir() }));
const BASE = `http://127.0.0.1:${server.address().port}`;
const login = await realFetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'boss', password: 'password1' }),
});
assert.equal(login.status, 200, 'вход администратора');
const COOKIE = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
const bookCalls = [];
const dbErrors = [];   // REPEAT_VISIT_V1 (поправка 2) — отказы /api/db (журнал действий окна)
globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (!u.startsWith('/')) return { ok: false, status: 404, json: async () => ({}) };
    if (u === '/api/rpc/calendar_book') bookCalls.push(JSON.parse(opts.body || '{}'));
    const res = await realFetch(BASE + u, { ...opts, headers: { ...(opts.headers || {}), Cookie: COOKIE } });
    if (u === '/api/db' && !res.ok) dbErrors.push({ status: res.status, body: opts.body || '' });
    return res;
};
test.after(() => { globalThis.fetch = realFetch; server.closeAllConnections?.(); server.close(); });

const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000) {
    const end = Date.now() + ms;
    for (;;) { const v = fn(); if (v || Date.now() > end) return v; await settle(); }
}
const modals = () => document.body.children.filter((c) => c.classList && c.classList.contains('modal'));
const WS = await import('../views/service-workspace.js');

/** Кабинет пациента `pid` у врача (Петров) → «Повторный визит» → 10-е след. месяца, 10:00 → «Записать». */
async function bookRevisit(pid, doc = { id: PETROV, name: 'Петров Пётр' }, { beforeBook = null } = {}) {
    document.body.children = [];
    const container = new El('div');
    const ctx = { container, visitServiceId: 900 + pid, visitId: 1900 + pid, patient: { id: pid, lastName: 'Пациент', firstName: 'Тест', mrn: 'P-' + pid, __service: { id: 900 + pid, name: 'Приём', doctorId: doc.id, doctorName: doc.name } } };
    WS.activateWorkspace(ctx);
    container.appendChild(WS.soapForm(ctx));
    const btn = container.querySelector('[data-revisit-btn]');
    btn.dispatch('click');
    await btn._pending;
    const dlg = await until(() => modals().pop());
    assert.ok(dlg, 'окно повторного визита не открылось');
    if (beforeBook) beforeBook(dlg);   // REPEAT_VISIT_V1 (ревью) — что окно предлагает до записи
    dlg.querySelectorAll('button').find((b) => b.textContent.includes('+1 мес')).dispatch('click');
    dlg.querySelectorAll('button').find((b) => b.classList.contains('rv-cell') && b.textContent === '10').dispatch('click');
    const slot = await until(() => dlg.querySelectorAll('button').find((b) => b.classList.contains('rv-slot') && !b.hasAttribute('disabled') && b.textContent === '10:00'));
    assert.ok(slot, 'нет свободного 10:00');
    slot.dispatch('click');
    const bookBtn = dlg.querySelectorAll('button').find((b) => /Записать/.test(b.textContent));
    bookBtn.dispatch('click');
    await bookBtn._pending;
    // REPEAT_VISIT_V1 (ревью) — лист кабинета догружается своими запросами; тест не
    // кончается раньше: иначе чтение после test.after (fetch уже настоящий) падает,
    // и повтор загрузки (scheduleHydrateRetry) держит процесс живым.
    await until(() => !ctx.__hydrating);   // загрузка начата синхронно в activateWorkspace
    return { ctx, container, dlg };
}
const tenthNextMonth = (hh) => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth() + 1, 10, hh, 0, 0, 0); };

test('REPEAT_VISIT_V1: свободный день — один calendar_book: визит «повторный» и консультация со временем; «записан» — правда', { timeout: 30000 }, async () => {
    TOASTS.length = 0; bookCalls.length = 0;
    const { container, dlg } = await bookRevisit(77);
    assert.equal(bookCalls.length, 1, 'запись ушла не одним вызовом');
    assert.equal(bookCalls[0].visit_kind, 'repeat');
    assert.deepEqual(bookCalls[0].line, { consultation_type_id: 6 });
    const v = DB.prepare('SELECT * FROM visits WHERE patient_id = 77').all();
    assert.equal(v.length, 1);
    assert.equal(v[0].visit_kind, 'repeat', 'визит записан «первичным»');
    assert.equal(Date.parse(v[0].visit_date), tenthNextMonth(10).getTime());
    const lines = DB.prepare('SELECT * FROM visit_services WHERE visit_id = ?').all(v[0].id);
    assert.deepEqual(lines.map((l) => [l.consultation_type_id, l.doctor_id]), [[6, PETROV]], 'нет строки консультации');
    assert.equal(Date.parse(lines[0].scheduled_at), Date.parse(v[0].visit_date), 'у строки нет времени приёма');
    assert.ok(TOASTS.some((t) => t.includes('Пациент записан на повторный визит')));
    assert.ok(!modals().includes(dlg), 'окно не закрылось после записи');
    assert.ok(container.querySelector('[data-revisit-btn]').classList.contains('booked'));
});

// REPEAT_VISIT_V1 (поправка 2) — журнал действий окна: detail уходил объектом, и
// /api/db отвечал 400 «unsupported value type» — запись журнала терялась молча.
test('REPEAT_VISIT_V1 (поправка 2): запись журнала действий окна доходит — detail строкой JSON', { timeout: 30000 }, async () => {
    const rows = DB.prepare("SELECT detail FROM patient_activity_log WHERE patient_id = 77 AND entity_label = 'Повторный визит'").all();
    assert.equal(rows.length, 1, 'журнал действий не записан: ' + JSON.stringify(dbErrors.map((e) => e.status)));
    const detail = JSON.parse(rows[0].detail);
    assert.equal(detail.consultation_type_id, 6);
    assert.ok(!dbErrors.some((e) => e.body.includes('patient_activity_log')), '/api/db отказал журналу действий');
});

// REPEAT_VISIT_V1 — у врача нет видов консультаций (все сняты): строкой визита идёт
// услуга каталога типа «Консультация» — прежнее окно писало визит без строки.
// REPEAT_VISIT_V1 (ревью, M1) — только услуга, которую ЭТОТ врач оказывает
// (users.service_rates — та же привязка исполнителя, что у каталога записи). Прежде
// окно брало первую по алфавиту консультацию всей клиники: «Аа приём (чужой)» ниже
// уходил бы строкой с ценой в каждый повторный визит. Ровно одна своя — она и выбрана.
test('REPEAT_VISIT_V1: врач без видов консультаций — строка визита — его услуга каталога «Консультация», цена сервера', { timeout: 30000 }, async () => {
    TOASTS.length = 0; bookCalls.length = 0;
    DB.prepare("INSERT INTO patients (id, full_name) VALUES (79,'Пациент Каталог')").run();
    DB.prepare("INSERT INTO services (id, name, price, type, duration_minutes, active) VALUES (40,'Аа приём (чужой)',90000,'consultation',15,1)").run();
    DB.prepare("INSERT INTO services (id, name, price, type, duration_minutes, active) VALUES (41,'Осмотр терапевта',70000,'consultation',40,1)").run();
    DB.prepare('UPDATE users SET service_rates = ? WHERE id = 10').run(JSON.stringify([{ service_id: 41, percentage: 30 }]));
    DB.prepare('INSERT INTO doctor_consultation_prices (doctor_id, consultation_type_id, price, available, is_free) VALUES (?, 6, 0, 0, 0)').run(10);
    try {
        let offered = null;
        await bookRevisit(79, { id: 10, name: 'Иванов Иван' }, {   // у Петрова 10:00 уже занят первым тестом
            beforeBook: (dlg) => { const sel = dlg.querySelector('select[data-rv-service]'); offered = sel && [sel.value, sel.querySelectorAll('option').map((o) => o.getAttribute('value'))]; },
        });
        assert.deepEqual(offered, ['s:41', ['s:41']], 'окно предлагает не только услугу этого врача');
        assert.equal(bookCalls.length, 1);
        assert.deepEqual([bookCalls[0].visit_kind, bookCalls[0].line, bookCalls[0].duration_minutes], ['repeat', { service_id: 41 }, 40],
            'окно не взяло услугу каталога и её длительность');
        const v = DB.prepare('SELECT id FROM visits WHERE patient_id = 79').get();
        const l = DB.prepare('SELECT service_id, consultation_type_id, doctor_id, unit_price FROM visit_services WHERE visit_id = ?').all(v.id);
        assert.deepEqual(l.map((r) => [r.service_id, r.consultation_type_id, r.doctor_id, r.unit_price]), [[41, null, 10, 70000]]);
        assert.ok(TOASTS.some((t) => t.includes('Пациент записан на повторный визит')));
    } finally {
        DB.prepare('DELETE FROM doctor_consultation_prices WHERE doctor_id = ?').run(10);
    }
});

test('REPEAT_VISIT_V1: у пациента в этот день уже есть приём — отказ в окне, «записан» не сказано, в базе ничего нового', { timeout: 30000 }, async () => {
    TOASTS.length = 0; bookCalls.length = 0;
    DB.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date, status) VALUES (78, 10, ?, 'scheduled')").run(tenthNextMonth(9).toISOString());
    const visitsBefore = DB.prepare('SELECT COUNT(*) n FROM visits WHERE patient_id = 78').get().n;
    const { container, dlg } = await bookRevisit(78);
    const err = await until(() => { const e = dlg.querySelector('.rv-err'); return e && e.textContent ? e : null; });
    assert.ok(err, 'отказ не показан в окне');
    assert.equal(err.textContent, 'У пациента в этот день уже есть приём в 09:00 у Иванов Иван — выберите другой день или время.');
    assert.ok(modals().includes(dlg), 'окно закрылось после отказа');
    assert.ok(!TOASTS.some((t) => t.includes('Пациент записан')), 'окно сказало «записан» без занятого времени');
    assert.ok(!container.querySelector('[data-revisit-btn]').classList.contains('booked'), 'кнопка отмечена записанной');
    assert.ok(!bookCalls.some((b) => b.add_to_day_visit), 'окно попробовало «Добавить в этот визит»');
    assert.ok(!modals().some((m) => m.textContent.includes('Добавить в этот визит')), 'окно спросило «Добавить в этот визит»');
    assert.equal(DB.prepare('SELECT COUNT(*) n FROM visits WHERE patient_id = 78').get().n, visitsBefore, 'появился второй визит');
    assert.equal(DB.prepare('SELECT COUNT(*) n FROM visit_services vs JOIN visits v ON v.id = vs.visit_id WHERE v.patient_id = 78').get().n, 0);
});

// REPEAT_VISIT_V1 (ревью, M1) — СВОИХ УСЛУГ НЕСКОЛЬКО ИЛИ НИ ОДНОЙ: строку выбирает врач.
// Выбрано «— без услуги —», и визит записывается без строки, как до 3.21: окно не
// угадывает, какую из услуг поставить в счёт. Неактивная услуга врача и чужие
// консультации клиники не предлагаются вовсе.
const addDoctor = (id, login, name) => {
    addUser.run(id, login, hashPassword('password1'), name, 'doctor', 1, WEEK);
    DB.prepare('INSERT INTO doctor_consultation_prices (doctor_id, consultation_type_id, price, available, is_free) VALUES (?, 6, 0, 0, 0)').run(id);   // видов консультаций нет
};
const serviceOptions = (dlg) => {
    const sel = dlg.querySelector('select[data-rv-service]');
    return sel && [sel.value, sel.querySelectorAll('option').map((o) => [o.getAttribute('value'), o.textContent])];
};

test('REPEAT_VISIT_V1 (ревью, M1): своих услуг две — выбрано «без услуги», чужих и неактивных нет; запись — без строки', { timeout: 30000 }, async () => {
    TOASTS.length = 0; bookCalls.length = 0;
    addDoctor(12, 'doc3', 'Сидоров Сидор');
    DB.prepare("INSERT INTO patients (id, full_name) VALUES (80,'Пациент Две Услуги')").run();
    DB.prepare("INSERT INTO services (id, name, price, type, duration_minutes, active) VALUES (51,'Приём кардиолога',120000,'consultation',30,1)").run();
    DB.prepare("INSERT INTO services (id, name, price, type, duration_minutes, active) VALUES (52,'Эхо-разбор',80000,'consultation',20,1)").run();
    DB.prepare("INSERT INTO services (id, name, price, type, duration_minutes, active) VALUES (53,'Старый приём',50000,'consultation',20,0)").run();
    DB.prepare('UPDATE users SET service_rates = ? WHERE id = 12').run(JSON.stringify([{ service_id: 52 }, { service_id: 51 }, { service_id: 53 }]));
    let offered = null;
    await bookRevisit(80, { id: 12, name: 'Сидоров Сидор' }, { beforeBook: (dlg) => { offered = serviceOptions(dlg); } });
    assert.deepEqual(offered, ['', [['', '— без услуги —'], ['s:51', 'Приём кардиолога'], ['s:52', 'Эхо-разбор']]],
        'окно предлагает не свои услуги врача или выбрало услугу само');
    assert.equal(bookCalls.length, 1);
    assert.equal(bookCalls[0].line, undefined, 'строка ушла без выбора врача');
    assert.equal(bookCalls[0].visit_kind, 'repeat');
    const v = DB.prepare('SELECT id, visit_kind FROM visits WHERE patient_id = 80').all();
    assert.deepEqual(v.map((r) => r.visit_kind), ['repeat']);
    assert.equal(DB.prepare('SELECT COUNT(*) n FROM visit_services WHERE visit_id = ?').get(v[0].id).n, 0, 'в визит попала строка с ценой');
    assert.ok(TOASTS.some((t) => t.includes('Пациент записан на повторный визит')));
});

test('REPEAT_VISIT_V1 (ревью, M1): врач не оказывает ни одной услуги — только «без услуги», хотя консультаций в клинике много; запись — без строки', { timeout: 30000 }, async () => {
    TOASTS.length = 0; bookCalls.length = 0;
    addDoctor(13, 'doc4', 'Каримов Карим');
    DB.prepare("INSERT INTO patients (id, full_name) VALUES (81,'Пациент Без Услуг')").run();
    let offered = null;
    await bookRevisit(81, { id: 13, name: 'Каримов Карим' }, { beforeBook: (dlg) => { offered = serviceOptions(dlg); } });
    assert.deepEqual(offered, ['', [['', '— без услуги —']]], 'окно предлагает чужие консультации клиники');
    assert.equal(bookCalls.length, 1);
    assert.equal(bookCalls[0].line, undefined);
    const v = DB.prepare('SELECT id FROM visits WHERE patient_id = 81').get();
    assert.ok(v, 'визит не записан');
    assert.equal(DB.prepare('SELECT COUNT(*) n FROM visit_services WHERE visit_id = ?').get(v.id).n, 0);
});

// REPEAT_VISIT_V1 (ревью, minor-7) — ИСПОЛНИТЕЛЬ СТРОКИ — МЕДСЕСТРА. Врач окна
// берётся из строки кабинета (resolveWsDoctorId), а строку записи сервер пишет только
// врачу (calendar_book: «Врач строки не найден среди врачей клиники») — запись падала
// целиком, хотя до 3.21 проходила. Теперь: вошёл врач — запись к нему со строкой;
// вошёл не врач — запись к исполнителю без строки, и окно говорит это словами.
// Строка с не-врачом не уходит никогда.
const NURSE = 14;
addUser.run(NURSE, 'nurse', hashPassword('password1'), 'Сестра Мария', 'nurse', 0, WEEK);
addUser.run(15, 'doc5', hashPassword('password1'), 'Назаров Назар', 'doctor', 1, WEEK);

test('REPEAT_VISIT_V1 (ревью, minor-7): исполнитель строки — медсестра, вошёл врач — запись к вошедшему врачу со строкой', { timeout: 30000 }, async () => {
    TOASTS.length = 0; bookCalls.length = 0;
    DB.prepare("INSERT INTO patients (id, full_name) VALUES (82,'Пациент Процедуры')").run();
    window.easymed = { state: { user: { id: 15, role: 'doctor', is_doctor: true, extra_roles: [] } } };
    try {
        await bookRevisit(82, { id: NURSE, name: 'Сестра Мария' });
        assert.equal(bookCalls.length, 1);
        assert.deepEqual([bookCalls[0].doctor_id, bookCalls[0].line], [15, { consultation_type_id: 6 }], 'запись ушла не к вошедшему врачу');
        const v = DB.prepare('SELECT id, doctor_id FROM visits WHERE patient_id = 82').get();
        assert.ok(v, 'визит не записан: ' + JSON.stringify(TOASTS));
        assert.equal(v.doctor_id, 15);
        assert.deepEqual(DB.prepare('SELECT consultation_type_id, doctor_id FROM visit_services WHERE visit_id = ?').all(v.id)
            .map((r) => [r.consultation_type_id, r.doctor_id]), [[6, 15]]);
        assert.ok(TOASTS.some((t) => t.includes('Пациент записан на повторный визит')));
    } finally { delete window.easymed; }
});

test('REPEAT_VISIT_V1 (ревью, minor-7): исполнитель строки — медсестра, вошёл не врач — запись к исполнителю без строки, окно это говорит', { timeout: 30000 }, async () => {
    TOASTS.length = 0; bookCalls.length = 0;
    DB.prepare("INSERT INTO patients (id, full_name) VALUES (83,'Пациент Сестры')").run();
    window.easymed = { state: { user: { id: 1, role: 'admin', is_doctor: false, extra_roles: [] } } };
    try {
        let note = null, offered = null;
        await bookRevisit(83, { id: NURSE, name: 'Сестра Мария' }, { beforeBook: (dlg) => {
            note = (dlg.querySelector('.rv-noline') || {}).textContent || null;
            offered = serviceOptions(dlg);
        } });
        assert.equal(note, 'Исполнитель — не врач: повторный визит запишется без услуги.', 'окно не сказало, что строки не будет');
        assert.deepEqual(offered, ['', [['', '— без услуги —']]]);
        assert.equal(bookCalls.length, 1);
        assert.deepEqual([bookCalls[0].doctor_id, bookCalls[0].line], [NURSE, undefined], 'строка ушла с не-врачом');
        const v = DB.prepare('SELECT id, doctor_id, visit_kind FROM visits WHERE patient_id = 83').get();
        assert.ok(v, 'визит не записан: ' + JSON.stringify(TOASTS));
        assert.deepEqual([v.doctor_id, v.visit_kind], [NURSE, 'repeat']);
        assert.equal(DB.prepare('SELECT COUNT(*) n FROM visit_services WHERE visit_id = ?').get(v.id).n, 0);
        assert.ok(TOASTS.some((t) => t.includes('Пациент записан на повторный визит')));
    } finally { delete window.easymed; }
});
