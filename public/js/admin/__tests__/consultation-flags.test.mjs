// CLINIC_API_FIX_V1 — «ВЕДЁТ» И «БЕСПЛАТНО» ЧИТАЮТСЯ ВЕРНО.
//
// База отдаёт флаги doctor_consultation_prices числами: available 0/1,
// is_free 0/1 (SQLite не знает «да/нет», а сервер при чтении их не переводит —
// проверено здесь же, первым тестом, через настоящую дверь /api/db). Три экрана
// сравнивали их с false/true:
//
//   * «Консультации врачей» (consultation-types.js): снятая галочка «Ведёт»
//     после повторного открытия стояла снова, а «Бесплатно» — пропадала; и
//     «Сохранить» без единой правки записывало врачу приём, который он не ведёт,
//     и делало бесплатный приём платным;
//   * окно записи (service-picker-modal.js) предлагало консультацию у врача,
//     который её не ведёт;
//   * кабинет врача (service-workspace.js, «Повторный визит») — так же.
//
// Стенд: настоящий сервер (createApp) с базой в памяти за фальшивым fetch —
// экран получает ровно то, что получил бы в браузере. DOM — cabinet-harness.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom, El } from './cabinet-harness.mjs';

installFakeDom();
// Окно записи пользуется ещё парой методов узла, которых стенду кабинета не надо.
for (const [k, fn] of Object.entries({
    click() { this.dispatch('click'); },
    dispatchEvent(e) { this.dispatch(e.type, e); return true; },
    replaceChildren(...cs) { this.children = []; cs.forEach((c) => this.appendChild(c)); },
    contains() { return false; }, scrollTo() {}, select() {},
})) if (!(k in El.prototype)) El.prototype[k] = fn;
globalThis.window.CLINIC = { id: 1, name: 'Клиника' };

// ─── настоящий сервер ───────────────────────────────────────────────────────
const { openDb } = await import('../../../../server/db/connection.js');
const { migrate } = await import('../../../../server/db/migrate.js');
const { hashPassword } = await import('../../../../server/services/auth.js');
const { createApp } = await import('../../../../server/app.js');
const { licensedDataDir } = await import('../../../../server/services/control/licensed-fixture.js');
const { listen } = await import('../../../../control-plane/server/test-helpers/listen.js');

const DB = openDb(':memory:');
migrate(DB);
const addUser = DB.prepare('INSERT INTO users (id, username, password_hash, full_name, role) VALUES (?,?,?,?,?)');
addUser.run(1, 'boss', hashPassword('password1'), 'Админ Клиники', 'admin');
addUser.run(10, 'doc', hashPassword('password1'), 'Иванов Иван', 'doctor');
addUser.run(11, 'doc2', hashPassword('password1'), 'Петров Пётр', 'doctor');
DB.prepare("INSERT INTO consultation_types (id, name, name_ru, price, sort_order, active) VALUES (5,'Первичный','Первичный приём',80000,1,1)").run();
DB.prepare("INSERT INTO consultation_types (id, name, name_ru, price, sort_order, active) VALUES (6,'Повторный','Повторный приём',60000,2,1)").run();
DB.prepare("INSERT INTO patients (id, full_name) VALUES (77,'Пациент Тест')").run();

const DOCTOR = 10;
const PETROV = 11;    // второй врач: ведёт тот вид, который DOCTOR не ведёт
const NOT_LED = 5;   // { available: 0, is_free: 1 } — не ведёт; если бы вёл — бесплатно
const LED = 6;       // { available: 1, is_free: 0 } — ведёт, платно
function seedPrices() {
    DB.prepare('DELETE FROM doctor_consultation_prices').run();
    const ins = DB.prepare('INSERT INTO doctor_consultation_prices (doctor_id, consultation_type_id, price, available, is_free) VALUES (?,?,?,?,?)');
    ins.run(DOCTOR, NOT_LED, null, 0, 1);
    ins.run(DOCTOR, LED, 120000, 1, 0);
}
const stored = () => DB.prepare('SELECT consultation_type_id AS t, price, available, is_free FROM doctor_consultation_prices WHERE doctor_id = ? ORDER BY consultation_type_id').all(DOCTOR);

const realFetch = globalThis.fetch;
const server = await listen(createApp(DB, { dataDir: licensedDataDir() }));
const BASE = `http://127.0.0.1:${server.address().port}`;
const login = await realFetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'boss', password: 'password1' }),
});
assert.equal(login.status, 200, 'вход администратора');
const COOKIE = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
globalThis.fetch = (url, opts = {}) => {
    const u = String(url);
    if (!u.startsWith('/')) return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    return realFetch(BASE + u, { ...opts, headers: { ...(opts.headers || {}), Cookie: COOKIE } });
};
test.after(() => { globalThis.fetch = realFetch; server.closeAllConnections?.(); server.close(); });

const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));
// Окна грузятся несколькими запросами к серверу: ждём условие, а не угаданный срок.
async function until(fn, ms = 5000) {
    const end = Date.now() + ms;
    for (;;) { const v = fn(); if (v || Date.now() > end) return v; await settle(20); }
}
const modals = () => document.body.children.filter((c) => c.classList && c.classList.contains('modal'));
const ticked = (cb) => cb.hasAttribute('checked');

const { isOn } = await import('../../shared/flags.js');
const { renderConsultationTypes } = await import('../views/consultation-types.js');
const { openServicePickerModal } = await import('../views/service-picker-modal.js');
const WS = await import('../views/service-workspace.js');

// ─── 0. Посылка: сервер отдаёт флаги числами ────────────────────────────────
test('сервер отдаёт available / is_free числами 0/1 — экран обязан читать и их', async () => {
    seedPrices();
    const { supabase } = await import('../../supabase.js');
    const { data, error } = await supabase.from('doctor_consultation_prices')
        .select('doctor_id, consultation_type_id, available, is_free').eq('doctor_id', DOCTOR);
    assert.equal(error, null);
    const byType = Object.fromEntries(data.map((r) => [r.consultation_type_id, r]));
    assert.strictEqual(byType[NOT_LED].available, 0);
    assert.strictEqual(byType[NOT_LED].is_free, 1);
    assert.strictEqual(byType[LED].available, 1);
    assert.strictEqual(byType[LED].is_free, 0);
});

test('isOn: да — true, 1, «1»; всё прочее — нет', () => {
    for (const v of [true, 1, '1']) assert.equal(isOn(v), true, 'isOn(' + JSON.stringify(v) + ')');
    for (const v of [false, 0, '0', null, undefined, '', 'true', 2]) assert.equal(isOn(v), false, 'isOn(' + JSON.stringify(v) + ')');
});

// ─── 1. «Консультации врачей» ───────────────────────────────────────────────
async function openDoctorDialog() {
    document.body.children = [];
    const container = new El('div');
    await renderConsultationTypes(container);
    const card = container.querySelectorAll('.card').find((c) => c.textContent.includes('Иванов Иван'));
    const edit = card && card.querySelectorAll('button').find((b) => /Edit|Редактировать/.test(b.textContent));
    assert.ok(edit, 'у врача нет кнопки «Edit»');
    edit.onclick();
    const dlg = modals().pop();
    assert.ok(dlg, 'окно цен врача не открылось');
    const row = (name) => {
        const tr = dlg.querySelectorAll('tr').find((r) => r.textContent.includes(name) && r.querySelectorAll('input[type="checkbox"]').length === 2);
        assert.ok(tr, 'строки «' + name + '» в окне нет');
        const [led, free] = tr.querySelectorAll('input[type="checkbox"]');
        const price = tr.querySelectorAll('input').find((i) => i.getAttribute('type') === 'number');
        return { led, free, price };
    };
    const save = dlg.querySelectorAll('button').find((b) => /Save|Сохранить/.test(b.textContent));
    return { dlg, row, save };
}

test('«Консультации врачей»: { available: 0, is_free: 1 } — «Ведёт» снята, «Бесплатно» стоит, цена заперта', async () => {
    seedPrices();
    const { row } = await openDoctorDialog();
    const r = row('Первичный приём');
    assert.equal(ticked(r.led), false, '«Ведёт» стоит у приёма, который врач не ведёт (available = 0)');
    assert.equal(ticked(r.free), true, '«Бесплатно» снята у бесплатного приёма (is_free = 1)');
    assert.equal(r.price.disabled, true, 'цена бесплатного приёма открыта для ввода');
});

test('«Консультации врачей»: { available: 1, is_free: 0 } — «Ведёт» стоит, «Бесплатно» снята, цена видна', async () => {
    seedPrices();
    const { row } = await openDoctorDialog();
    const r = row('Повторный приём');
    assert.equal(ticked(r.led), true, '«Ведёт» снята у приёма, который врач ведёт (available = 1)');
    assert.equal(ticked(r.free), false, '«Бесплатно» стоит у платного приёма (is_free = 0)');
    assert.equal(r.price.getAttribute('value'), '120000');
    assert.ok(!r.price.disabled, 'цена платного приёма заперта');
});

test('«Консультации врачей»: открыть и «Сохранить» без правок — флаги в базе те же', async () => {
    seedPrices();
    const before = stored();
    const ids = () => DB.prepare('SELECT id FROM doctor_consultation_prices WHERE doctor_id = ? ORDER BY id').all(DOCTOR).map((r) => r.id);
    const idsBefore = ids();
    const { dlg, save } = await openDoctorDialog();
    assert.ok(save, 'кнопки «Save» нет');
    await save.onclick();
    // Сохранение на самом деле прошло (окно переписывает строки врача заново и
    // закрывается), иначе «флаги те же» доказывали бы только отказ записи.
    assert.ok(!modals().includes(dlg), 'окно не закрылось — сохранение не прошло');
    const idsAfter = ids();
    assert.ok(idsAfter.every((id) => !idsBefore.includes(id)), 'строки врача не переписаны — сохранение не дошло до базы');
    assert.deepEqual(stored(), before, 'сохранение без правок переписало флаги врача');
    assert.deepEqual(stored(), [
        { t: NOT_LED, price: null, available: 0, is_free: 1 },
        { t: LED, price: 120000, available: 1, is_free: 0 },
    ]);
});

// ─── 2. Окно записи ─────────────────────────────────────────────────────────
test('окно записи: консультацию, которую врач не ведёт, не предлагает; ту, что ведёт, — предлагает', async () => {
    seedPrices();
    document.body.children = [];
    openServicePickerModal({ onPick: () => {} });
    const box = await until(() => modals().find((m) => m.textContent.includes('Повторный приём')));
    assert.ok(box, 'окно записи не открылось или не предлагает консультацию, которую врач ведёт');
    await settle();
    const text = box.textContent;
    assert.ok(text.includes('Повторный приём'), 'консультации, которую врач ведёт, в окне нет: ' + text.slice(0, 300));
    assert.ok(!text.includes('Первичный приём'), 'окно предлагает консультацию, которую врач не ведёт (available = 0)');
});

// CLINIC_API_FIX_V1 (ревью) — врач выбран ДО услуги (visitDoctorId). Строки
// консультаций свои у каждого врача, и строку вида NOT_LED даёт только PETROV.
// Выбрав её, окно спрашивает consultAvailableFor(DOCTOR, NOT_LED): 0 из базы
// при сравнении с false оставлял DOCTOR исполнителем — консультация уходила
// врачу, который её не ведёт, по его «цене».
test('окно записи, врач выбран заранее: вид, который он не ведёт, на него не записывается; тот, что ведёт, — записывается', async () => {
    seedPrices();
    DB.prepare('INSERT INTO doctor_consultation_prices (doctor_id, consultation_type_id, price, available, is_free, name_ru) VALUES (?,?,?,?,?,?)')
        .run(PETROV, NOT_LED, 90000, 1, 0, 'Осмотр у Петрова');
    const pickWith = async (rowName) => {
        document.body.children = [];
        const picks = [];
        openServicePickerModal({ visitDoctorId: DOCTOR, onPick: (p) => picks.push(p) });
        const box = await until(() => modals().find((m) => m.textContent.includes(rowName)));
        assert.ok(box, 'в окне записи нет строки «' + rowName + '»');
        const rows = box.querySelectorAll('button.sched-col-row');
        assert.ok(!rows.some((r) => r.textContent.startsWith('Первичный приём')),
            'окно предлагает строку вида, который выбранный врач не ведёт (available = 0)');
        rows.find((r) => r.textContent.includes(rowName)).dispatch('click');
        const done = box.querySelectorAll('button').find((b) => /Готово/.test(b.textContent));
        assert.ok(done, 'кнопки «Готово» нет');
        done.dispatch('click');
        await until(() => picks.length);
        assert.equal(picks.length, 1, 'выбор не дошёл до экрана');
        return picks[0];
    };
    const led = await pickWith('Повторный приём');
    assert.equal(led.service.consultation_type_id, LED);
    assert.equal(led.doctor && led.doctor.id, DOCTOR, 'вид, который врач ведёт, ушёл без него');
    assert.equal(led.service.price, 120000);
    const notLed = await pickWith('Осмотр у Петрова');
    assert.equal(notLed.service.consultation_type_id, NOT_LED);
    assert.notEqual(notLed.doctor && notLed.doctor.id, DOCTOR,
        'окно записало на врача консультацию, которую он не ведёт (available = 0)');
});

// ─── 3. Кабинет врача: «Повторный визит» ────────────────────────────────────
test('кабинет врача, «Повторный визит»: в списке только консультации, которые врач ведёт', async () => {
    seedPrices();
    document.body.children = [];
    const container = new El('div');
    const ctx = { container, visitServiceId: 901, visitId: 1901, patient: { id: 77, lastName: 'Пациент', firstName: 'Тест', mrn: 'P-77', __service: { id: 901, name: 'Приём', doctorId: DOCTOR, doctorName: 'Иванов Иван' } } };
    WS.activateWorkspace(ctx);
    container.appendChild(WS.soapForm(ctx));
    const btn = container.querySelector('[data-revisit-btn]');
    assert.ok(btn, 'кнопки «Повторный визит» нет');
    btn.dispatch('click');
    await btn._pending;
    const dlg = await until(() => modals().pop());
    assert.ok(dlg, 'окно повторного визита не открылось');
    const values = dlg.querySelectorAll('option').map((o) => o.getAttribute('value'));
    assert.ok(values.includes(String(LED)), 'консультации, которую врач ведёт, в списке нет: ' + values.join(','));
    assert.ok(!values.includes(String(NOT_LED)), 'список предлагает консультацию, которую врач не ведёт (available = 0)');
});
