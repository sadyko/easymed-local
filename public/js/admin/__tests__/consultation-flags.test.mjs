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
// Выбрав её, окно не должно оставить исполнителем DOCTOR: до правки 3c (номер
// врача строки — строкой) это решал consultAvailableFor(DOCTOR, NOT_LED), и 0 из
// базы при сравнении с false оставлял консультацию врачу, который её не ведёт.
// Теперь строку сразу забирает её собственный врач (тест ниже).
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
    // CLINIC_API_FIX_V1 — строку Петрова забирает Петров (её собственный врач), а
    // не выбранный заранее врач, который этот вид не ведёт; и по цене Петрова.
    assert.strictEqual(notLed.doctor && notLed.doctor.id, PETROV,
        'консультация ушла не со своим врачом (выбранный заранее врач этот вид не ведёт, available = 0)');
    assert.equal(notLed.service.price, 90000, 'консультация ушла не по цене своего врача');
});

// ─── 2б. Врач строки консультации — тот же врач, что в базе ─────────────────
// CLINIC_API_FIX_V1 — строка консультации в окне записи привязана к своему
// врачу (__consultDoctorId). Номер врача вырезался из текстового ключа «10|6» и
// оставался строкой «10», а врачи из базы приходят числом 10: `'10' === 10` —
// ложь. Поэтому из колонки врача в календаре его консультаций не было вовсе,
// выбранная строка консультации уходила без врача, а поиск по фамилии врача
// его консультаций не находил.
function seedWithPetrov() {
    seedPrices();
    DB.prepare('INSERT INTO doctor_consultation_prices (doctor_id, consultation_type_id, price, available, is_free, name_ru) VALUES (?,?,?,?,?,?)')
        .run(PETROV, NOT_LED, 90000, 1, 0, 'Осмотр у Петрова');
}
const catRows = (box) => box.querySelectorAll('.wzc-svc');
// Окно из трёх колонок: строки ОДНОЙ колонки, найденной по заголовку («Услуги», «Врачи»).
const colRows = (box, title) => {
    const col = box.querySelectorAll('.sched-col').find((c) => { const hd = c.querySelector('.sched-col-head'); return hd && hd.textContent.includes(title); });
    assert.ok(col, 'колонки «' + title + '» нет');
    return col.querySelectorAll('button.sched-col-row');
};
const catRow = (box, name) => catRows(box).find((r) => r.textContent.includes(name));

test('календарь, колонка врача (lockedDoctor): видны консультации, которые он ведёт, по его цене, — и только они', async () => {
    seedWithPetrov();
    document.body.children = [];
    // Ровно как room-calendar.js открывает мастер по щелчку в колонке врача.
    openServicePickerModal({
        calculator: true, roomId: null,
        lockedDoctor: { id: DOCTOR, name: 'Иванов Иван', spec: '' },
        scheduledISO: new Date(Date.now() + 86400000).toISOString(),
        onPick: () => {}, onCreatePatient() {},
    });
    const box = await until(() => modals().find((m) => catRow(m, 'Повторный приём')), 3000);
    assert.ok(box, 'в колонке врача нет его консультации «Повторный приём»: ' + (modals().pop() || { textContent: '' }).textContent.slice(0, 300));
    assert.match(catRow(box, 'Повторный приём').textContent, /120\s000/, 'консультация показана не по цене врача');
    assert.ok(!catRow(box, 'Первичный приём'), 'в колонке врача вид, который он не ведёт (available = 0)');
    assert.ok(!catRow(box, 'Осмотр у Петрова'), 'в колонке врача консультация другого врача');
});

test('окно записи: строка консультации другого врача уходит с ЭТИМ врачом, и колонка врачей показывает его', async () => {
    seedWithPetrov();
    document.body.children = [];
    const picks = [];
    openServicePickerModal({ onPick: (p) => picks.push(p) });
    const box = await until(() => modals().find((m) => m.textContent.includes('Осмотр у Петрова')));
    assert.ok(box, 'в окне записи нет строки «Осмотр у Петрова»');
    box.querySelectorAll('button.sched-col-row').find((r) => r.textContent.includes('Осмотр у Петрова')).dispatch('click');
    const doctorRows = colRows(box, 'Врачи');
    assert.deepEqual(doctorRows.map((r) => r.textContent.includes('Петров Пётр')), [true],
        'колонка врачей для строки Петрова показывает не одного Петрова: ' + doctorRows.map((r) => r.textContent).join(' | '));
    assert.ok(doctorRows[0].classList.contains('on'), 'Петров в колонке врачей не выбран');
    box.querySelectorAll('button').find((b) => /Готово/.test(b.textContent)).dispatch('click');
    await until(() => picks.length);
    assert.equal(picks.length, 1, 'выбор не дошёл до экрана');
    assert.equal(picks[0].service.consultation_type_id, NOT_LED);
    assert.strictEqual(picks[0].doctor && picks[0].doctor.id, PETROV, 'консультация ушла без своего врача (или с чужим)');
    assert.equal(picks[0].service.price, 90000, 'консультация ушла не по цене своего врача');
});

test('мастер записи: поиск по фамилии врача находит его консультации', async () => {
    seedWithPetrov();
    document.body.children = [];
    openServicePickerModal({ calculator: true, onPick: () => {}, onCreatePatient() {} });
    const box = await until(() => modals().find((m) => catRow(m, 'Повторный приём') && catRow(m, 'Осмотр у Петрова')));
    assert.ok(box, 'мастер записи не показал консультаций');
    const search = box.querySelector('input.wzc-search');
    assert.ok(search, 'поля поиска нет');
    search.value = 'Иванов';
    search.dispatch('input');
    const found = await until(() => !catRow(box, 'Осмотр у Петрова') && catRow(box, 'Повторный приём'), 3000);
    assert.ok(found, 'поиск «Иванов» не нашёл консультацию Иванова: ' + catRows(box).map((r) => r.textContent.slice(0, 40)).join(' | '));
});

// CLINIC_API_FIX_V1 — окно из трёх колонок (им пользуется и «Направить» в
// кабинете врача): у двух врачей один вид приёма — две строки «Повторный
// приём». Без имени врача их не различить; мастер записи имя уже показывал.
test('окно из трёх колонок: у строки консультации — имя её врача, у услуги — нет', async () => {
    seedPrices();
    DB.prepare('INSERT INTO doctor_consultation_prices (doctor_id, consultation_type_id, price, available, is_free) VALUES (?,?,?,?,?)')
        .run(PETROV, LED, 100000, 1, 0);
    document.body.children = [];
    openServicePickerModal({ onPick: () => {} });
    const box = await until(() => modals().find((m) => m.textContent.includes('Повторный приём')));
    assert.ok(box, 'окно записи не показало консультаций');
    const svcRows = colRows(box, 'Услуги');
    const same = svcRows.filter((r) => r.textContent.includes('Повторный приём'));
    assert.equal(same.length, 2, 'строк вида «Повторный приём» не две: ' + same.map((r) => r.textContent).join(' | '));
    const ivanov = same.find((r) => r.textContent.includes('Иванов Иван'));
    const petrov = same.find((r) => r.textContent.includes('Петров Пётр'));
    assert.ok(ivanov && petrov, 'строки одного вида у двух врачей не различить: ' + same.map((r) => r.textContent).join(' | '));
    assert.match(ivanov.textContent, /120\s000/, 'у строки Иванова не его цена');
    assert.match(petrov.textContent, /100\s000/, 'у строки Петрова не его цена');
    const plain = svcRows.filter((r) => !r.textContent.includes('Повторный приём') && !/Все типы/.test(r.textContent));
    assert.ok(plain.length > 0, 'в колонке услуг нет ни одной обычной услуги');
    assert.ok(plain.every((r) => !/Иванов Иван|Петров Пётр/.test(r.textContent)), 'у обычной услуги появилось имя врача');
});

test('мастер записи: добавленная консультация сразу получает своего врача (с его ценой), а не «Врач не найден»', async () => {
    seedWithPetrov();
    document.body.children = [];
    openServicePickerModal({ calculator: true, onPick: () => {}, onCreatePatient() {} });
    const box = await until(() => modals().find((m) => catRow(m, 'Осмотр у Петрова')));
    assert.ok(box, 'мастер записи не показал консультацию Петрова');
    const addBtn = catRow(box, 'Осмотр у Петрова').querySelector('.wzc-add');
    assert.ok(addBtn, 'у строки нет кнопки «Добавить»');
    addBtn.dispatch('click');
    const chosen = await until(() => { const r = catRow(box, 'Осмотр у Петрова'); return r && r.querySelector('.wzc-doc.on'); }, 3000);
    assert.ok(chosen, 'врач консультации не назначен: ' + (catRow(box, 'Осмотр у Петрова') || { textContent: '' }).textContent.slice(0, 200));
    assert.match(chosen.textContent, /Петров Пётр/, 'консультации назначен не её врач');
    assert.match(chosen.textContent, /90\s000/, 'консультация не по цене своего врача');
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

// ─── DOCTOR_PROFILE_V1 — решение владельца 8: своей строки нет — общая цена ───
test('DOCTOR_PROFILE_V1: окно записи — врач (is_doctor) без своих строк получает оба вида по общей цене; «Ведёт» снятое по-прежнему прячет', async () => {
    seedPrices();
    DB.prepare("INSERT OR IGNORE INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (12, 'doc3', 'x', 'Сидоров Сидор', 'doctor', 1)").run();
    DB.prepare("UPDATE users SET role = 'doctor', is_doctor = 1 WHERE id = 12").run();
    try {
        document.body.children = [];
        const picks = [];
        openServicePickerModal({ onPick: (p) => picks.push(p) });
        const box = await until(() => modals().find((m) => m.textContent.includes('Сидоров Сидор') && m.textContent.includes('Повторный приём')));
        assert.ok(box, 'окно записи не открылось');
        const sidorovRows = () => colRows(box, 'Услуги').filter((r) => r.textContent.includes('Сидоров Сидор'));
        await until(() => sidorovRows().length >= 2, 3000);
        const rows = sidorovRows();
        assert.equal(rows.length, 2, 'у врача без строк — оба вида: ' + rows.map((r) => r.textContent).join(' | '));
        assert.match(rows.find((r) => r.textContent.includes('Первичный приём')).textContent, /80\s000/);
        assert.match(rows.find((r) => r.textContent.includes('Повторный приём')).textContent, /60\s000/);
        assert.ok(!colRows(box, 'Услуги').some((r) => r.textContent.includes('Иванов Иван') && r.textContent.includes('Первичный приём')),
            '«Ведёт» снято (available = 0) — вид не предлагается');
        rows.find((r) => r.textContent.includes('Первичный приём')).dispatch('click');
        box.querySelectorAll('button').find((b) => /Готово/.test(b.textContent)).dispatch('click');
        await until(() => picks.length);
        assert.equal(picks[0].service.price, 80000);
        assert.equal(picks[0].service.duration_minutes, 30, 'длительность вида (мигр. 243, по умолчанию 30)');
        assert.equal(picks[0].doctor && picks[0].doctor.id, 12);
    } finally {
        DB.prepare("UPDATE users SET role = 'registrar', is_doctor = 0 WHERE id = 12").run();
    }
});

// DOCTOR_PROFILE_V1 — решение владельца 13: строка врача с пустой ценой — 0, как в
// кассе; общая цена вида — только виду, по которому у врача строки нет.
test('DOCTOR_PROFILE_V1: окно записи — строка врача с пустой ценой — 0 (решение 13), вид без строки — общая цена', async () => {
    seedPrices();
    DB.prepare("INSERT OR IGNORE INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (12, 'doc3', 'x', 'Сидоров Сидор', 'doctor', 1)").run();
    DB.prepare("UPDATE users SET role = 'doctor', is_doctor = 1 WHERE id = 12").run();
    DB.prepare('INSERT INTO doctor_consultation_prices (doctor_id, consultation_type_id, price, available, is_free) VALUES (12, ?, NULL, 1, 0)').run(LED);
    try {
        document.body.children = [];
        const picks = [];
        openServicePickerModal({ onPick: (p) => picks.push(p) });
        const box = await until(() => modals().find((m) => m.textContent.includes('Сидоров Сидор') && m.textContent.includes('Повторный приём')));
        assert.ok(box, 'окно записи не открылось');
        const sidorovRows = () => colRows(box, 'Услуги').filter((r) => r.textContent.includes('Сидоров Сидор'));
        await until(() => sidorovRows().length >= 2, 3000);
        assert.match(sidorovRows().find((r) => r.textContent.includes('Первичный приём')).textContent, /80\s000/, 'вид без строки — общая цена');
        sidorovRows().find((r) => r.textContent.includes('Повторный приём')).dispatch('click');
        box.querySelectorAll('button').find((b) => /Готово/.test(b.textContent)).dispatch('click');
        await until(() => picks.length);
        assert.equal(picks[0].service.price, 0, 'пустая цена в строке врача — 0, а не общие 60 000');
    } finally {
        DB.prepare('DELETE FROM doctor_consultation_prices WHERE doctor_id = 12').run();
        DB.prepare("UPDATE users SET role = 'registrar', is_doctor = 0 WHERE id = 12").run();
    }
});

test('DOCTOR_PROFILE_V1: «Повторный визит» у врача без своих строк — оба вида', async () => {
    seedPrices();
    document.body.children = [];
    const container = new El('div');
    const ctx = { container, visitServiceId: 902, visitId: 1902, patient: { id: 77, lastName: 'Пациент', firstName: 'Тест', mrn: 'P-77', __service: { id: 902, name: 'Приём', doctorId: PETROV, doctorName: 'Петров Пётр' } } };
    WS.activateWorkspace(ctx);
    container.appendChild(WS.soapForm(ctx));
    const btn = container.querySelector('[data-revisit-btn]');
    btn.dispatch('click');
    await btn._pending;
    const dlg = await until(() => modals().pop());
    const values = dlg.querySelectorAll('option').map((o) => o.getAttribute('value'));
    assert.ok(values.includes(String(NOT_LED)) && values.includes(String(LED)), 'своей строки нет — виды ведутся по общей цене: ' + values.join(','));
});

// ─── DOCTOR_PROFILE_V1 — «Виды консультаций» и «Консультации врачей» ─────────
test('DOCTOR_PROFILE_V1: «Консультации врачей» — пустая цена подсказывает 0; подпись говорит, что пустая цена и «Бесплатно» — 0 (решение владельца 13)', async () => {
    seedPrices();
    const { row, dlg } = await openDoctorDialog();
    assert.equal(row('Повторный приём').price.getAttribute('placeholder'), '0', 'подсказка — то, что возьмёт касса, а не общая цена вида');
    assert.ok(dlg.textContent.includes('Пустая цена — 0, как и «Бесплатно»'), dlg.textContent.slice(-400));
    assert.ok(dlg.textContent.includes('Общая цена вида — только у врача, которого здесь ещё не сохраняли.'), dlg.textContent.slice(-400));
});

test('DOCTOR_PROFILE_V1: «Виды консультаций» правят названия RU/UZ/EN, длительность и вид для партнёров', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('../views/settings-hub.js', import.meta.url), 'utf8');
    const block = src.slice(src.indexOf('    consultation_types: {'), src.indexOf('    // ---- Управление персоналом'));
    for (const k of ["key: 'name_uz'", "key: 'name_en'", "key: 'duration_minutes'", "key: 'api_kind'"]) assert.ok(block.includes(k), k);
    assert.match(block, /beforeSave: \(p\) => prepareConsultTypeSave\(p\)/);
});

// DOCTOR_PROFILE_V1 (ревью шага 5, №1) — «Повторный визит»: свободное время и
// запись — на длительность выбранного вида консультации (consultMinutes), шаг
// сетки — прежние 20 минут; смена вида пересчитывает слоты. Раньше и слоты, и
// визит были на 20 минут при любом виде. Запись сервер здесь отклоняет —
// проверяется, с какой длительностью она ушла.
test('DOCTOR_PROFILE_V1: «Повторный визит» — слоты и запись на длительность выбранного вида; смена вида пересчитывает слоты', async () => {
    seedPrices();
    const WEEK = JSON.stringify(Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, { on: true, from: '09:00', to: '18:00' }])));
    const prevHours = DB.prepare('SELECT working_hours FROM users WHERE id = ?').get(PETROV).working_hours;
    DB.prepare('UPDATE users SET working_hours = ? WHERE id = ?').run(WEEK, PETROV);
    DB.prepare('UPDATE consultation_types SET duration_minutes = 45 WHERE id = ?').run(LED);
    const seen = [];
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (url, opts = {}) => {
        const u = String(url);
        if (u === '/api/rpc/calendar_slots' || u === '/api/rpc/calendar_book') {
            seen.push({ name: u.slice('/api/rpc/'.length), body: JSON.parse(opts.body || '{}') });
            if (u === '/api/rpc/calendar_book') {
                return Promise.resolve({ ok: false, status: 400, json: async () => ({ error: { message: 'Запись в тесте не нужна.' } }) });
            }
        }
        return prevFetch(url, opts);
    };
    try {
        document.body.children = [];
        const container = new El('div');
        const ctx = { container, visitServiceId: 904, visitId: 1904, patient: { id: 77, lastName: 'Пациент', firstName: 'Тест', mrn: 'P-77', __service: { id: 904, name: 'Приём', doctorId: PETROV, doctorName: 'Петров Пётр' } } };
        WS.activateWorkspace(ctx);
        container.appendChild(WS.soapForm(ctx));
        const btn = container.querySelector('[data-revisit-btn]');
        btn.dispatch('click');
        await btn._pending;
        const dlg = await until(() => modals().pop());
        const svcSel = dlg.querySelectorAll('select').find((s) => s.querySelectorAll('option').some((o) => o.getAttribute('value') === String(LED)));
        assert.ok(svcSel, 'нет выбора вида консультации');
        svcSel.value = String(LED);
        svcSel.dispatch('change');
        dlg.querySelectorAll('button').find((b) => b.textContent.includes('+1 мес')).dispatch('click');
        dlg.querySelectorAll('button').find((b) => b.classList.contains('rv-cell') && b.textContent === '10').dispatch('click');
        const slotsAsked = () => seen.filter((c) => c.name === 'calendar_slots');
        await until(() => slotsAsked().length);
        assert.deepEqual([slotsAsked().at(-1).body.duration_minutes, slotsAsked().at(-1).body.step_minutes], [45, 20],
            'вид на 45 минут: слоты спрошены не на его длительность (шаг — 20)');
        svcSel.value = String(NOT_LED);   // вид без своей длительности — 30
        svcSel.dispatch('change');
        await until(() => slotsAsked().at(-1).body.duration_minutes === 30);
        assert.equal(slotsAsked().at(-1).body.duration_minutes, 30, 'смена вида не пересчитала слоты');
        const slot = await until(() => dlg.querySelectorAll('button').find((b) => b.classList.contains('rv-slot') && !b.hasAttribute('disabled')));
        assert.ok(slot, 'нет свободного слота');
        slot.dispatch('click');
        dlg.querySelectorAll('button').find((b) => /Записать/.test(b.textContent)).dispatch('click');
        const book = await until(() => seen.find((c) => c.name === 'calendar_book'));
        assert.ok(book, 'запись не ушла на сервер');
        assert.equal(book.body.duration_minutes, 30, 'визит занят не на длительность выбранного вида');
    } finally {
        globalThis.fetch = prevFetch;
        DB.prepare('UPDATE users SET working_hours = ? WHERE id = ?').run(prevHours, PETROV);
        DB.prepare('UPDATE consultation_types SET duration_minutes = 30 WHERE id = ?').run(LED);
    }
});

// DOCTOR_PROFILE_V1 (ревью шага 5, №2) — администратор, который ведёт приём
// (is_doctor = 1 из базы числом, без специальности и лицензии), есть в
// «Консультациях врачей»: окно записи предлагает его консультации по общей
// цене (решение 8), и только здесь ему ставят свою цену, «Бесплатно» или
// снимают «Ведёт». Раньше отбор сравнивал is_doctor с true и его терял.
test('DOCTOR_PROFILE_V1: «Консультации врачей» — администратор с is_doctor = 1 без специальности в списке врачей', async () => {
    DB.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (13, 'admdoc', 'x', 'Алиева Алия', 'admin', 1)").run();
    try {
        document.body.children = [];
        const container = new El('div');
        await renderConsultationTypes(container);
        const card = container.querySelectorAll('.card').find((c) => c.textContent.includes('Алиева Алия'));
        assert.ok(card, 'администратора-врача нет в «Консультациях врачей»');
    } finally {
        DB.prepare('DELETE FROM users WHERE id = 13').run();
    }
});
