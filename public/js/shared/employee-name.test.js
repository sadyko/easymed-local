// EMPLOYEE_CARD_SAVE_V1 (2026-10-02) — имя сотрудника из full_name и правило,
// что останавливает «Сохранить сотрудника».
//
// Владелец: «in the doctors, the actual name and surname and other information
// not saving, also the shares to the services, referrals, and also the
// stationary services are not saving when edited». Причина была одна на всё:
// карточка читала только last_name / first_name, а у врачей, заведённых одной
// строкой full_name (демо-врачи, `admin` первого запуска), поля были пустыми — и
// проверка «Фамилия, Имя, Телефон» отказывала ВСЕЙ карточке, даже когда менялись
// одни ставки. Ни один запрос не уходил.
import test from 'node:test';
import assert from 'node:assert/strict';
import { splitFullName, employeeNameParts, employeeSaveGaps, NAME_KEYS } from './employee-name.js';

const EMPTY = { last_name: '', first_name: '', middle_name: '' };

test('splitFullName: первое слово — фамилия, второе — имя, остальное — отчество', () => {
    assert.deepEqual(splitFullName('Абдуллаев Шерзод'), { last_name: 'Абдуллаев', first_name: 'Шерзод', middle_name: '' });
    assert.deepEqual(splitFullName('Каюмов Араббек Акмалович'), { last_name: 'Каюмов', first_name: 'Араббек', middle_name: 'Акмалович' });
    // Узбекское отчество — два слова; латиница с апострофом остаётся целой.
    assert.deepEqual(splitFullName("Karimov Anvar Akmal o'g'li"), { last_name: 'Karimov', first_name: 'Anvar', middle_name: "Akmal o'g'li" });
    assert.deepEqual(splitFullName('Ғуломова Ўғилой Тошпўлат қизи'), { last_name: 'Ғуломова', first_name: 'Ўғилой', middle_name: 'Тошпўлат қизи' });
    // Лишние пробелы, табуляция и неразрывный пробел — не слова.
    assert.deepEqual(splitFullName('  Абдуллаев \t Шерзод   Рустамович  '), { last_name: 'Абдуллаев', first_name: 'Шерзод', middle_name: 'Рустамович' });
    // Одно слово — фамилия; имени нет, и оно не выдумывается.
    assert.deepEqual(splitFullName('Administrator'), { last_name: 'Administrator', first_name: '', middle_name: '' });
    assert.deepEqual(splitFullName('   '), EMPTY);
    assert.deepEqual(splitFullName(''), EMPTY);
    assert.deepEqual(splitFullName(null), EMPTY);
    assert.deepEqual(splitFullName(undefined), EMPTY);
});

test('employeeNameParts: свои поля важнее; full_name разбирается, только когда пусты и фамилия, и имя', () => {
    assert.deepEqual(employeeNameParts({ last_name: 'Хирургов', first_name: 'Хасан', middle_name: '', full_name: 'Другое Имя' }),
        { last_name: 'Хирургов', first_name: 'Хасан', middle_name: '' });
    // Есть хотя бы фамилия — карточка показывает поля как есть, без разбора.
    assert.deepEqual(employeeNameParts({ last_name: 'Хирургов', first_name: null, middle_name: null, full_name: 'Хирургов Хасан' }),
        { last_name: 'Хирургов', first_name: '', middle_name: '' });
    assert.deepEqual(employeeNameParts({ last_name: null, first_name: null, middle_name: null, full_name: 'Абдуллаев Шерзод' }),
        { last_name: 'Абдуллаев', first_name: 'Шерзод', middle_name: '' });
    // Пробелы вместо фамилии и имени — тоже «пусто».
    assert.deepEqual(employeeNameParts({ last_name: ' ', first_name: '', full_name: 'Мирза Улов Эломон' }),
        { last_name: 'Мирза', first_name: 'Улов', middle_name: 'Эломон' });
    assert.deepEqual(employeeNameParts({ full_name: 'Administrator' }), { last_name: 'Administrator', first_name: '', middle_name: '' });
    assert.deepEqual(employeeNameParts({}), EMPTY);
    assert.deepEqual(employeeNameParts(null), EMPTY);
});

test('разобранное имя возвращается тем же full_name: сервер склеивает части в том же порядке', () => {
    // routes/users.js deriveFullName: [last, first, middle] → trim → filter(Boolean) → join(' ').
    const derive = (p) => [p.last_name, p.first_name, p.middle_name].map((s) => (s || '').trim()).filter(Boolean).join(' ');
    for (const full of ['Абдуллаев Шерзод', 'Каюмов Араббек Акмалович', "Karimov Anvar Akmal o'g'li", 'Administrator', 'Ли Ван Тан Хо']) {
        assert.equal(derive(employeeNameParts({ full_name: full })), full, full);
    }
    // Лишние пробелы схлопываются — слова и их порядок те же.
    assert.equal(derive(employeeNameParts({ full_name: '  Абдуллаев   Шерзод ' })), 'Абдуллаев Шерзод');
});

const NEW_EMPTY = { last_name: '', first_name: '', middle_name: '', phone: '', staff_type: '', username: '', password: '' };

test('новый сотрудник: Фамилия, Имя и Телефон обязательны, затем категория, затем логин и пароль', () => {
    assert.deepEqual(employeeSaveGaps({ isEdit: false, now: NEW_EMPTY }).refuse, { section: 'personal', keys: ['last_name', 'first_name', 'phone'] });
    const named = { ...NEW_EMPTY, last_name: 'Каюмов', first_name: 'Араббек' };
    assert.deepEqual(employeeSaveGaps({ isEdit: false, now: named }).refuse, { section: 'personal', keys: ['phone'] });
    const withPhone = { ...named, phone: '+998 90 961 00 04' };
    assert.deepEqual(employeeSaveGaps({ isEdit: false, now: withPhone }).refuse, { section: 'job', keys: ['staff_type'] });
    const withJob = { ...withPhone, staff_type: 'doctor' };
    assert.deepEqual(employeeSaveGaps({ isEdit: false, now: withJob }).refuse, { section: 'access', keys: ['username', 'password'] });
    const all = { ...withJob, username: 'kayumov', password: '1' };
    assert.deepEqual(employeeSaveGaps({ isEdit: false, now: all }), { refuse: null, sendNames: true });
});

test('существующий: ФИО, которое не трогали, не держит сохранение — пустые части просто не отправляются', () => {
    // Одно слово в full_name: фамилия есть, имени нет; правили только ставки.
    const was = { last_name: 'Administrator', first_name: '', middle_name: '', staff_type: '' };
    const now = { ...was, phone: '', username: 'admin' };
    assert.deepEqual(employeeSaveGaps({ isEdit: true, now, was }), { refuse: null, sendNames: false });
    // Совсем без имени — так же.
    const none = { last_name: '', first_name: '', middle_name: '', staff_type: 'admin_staff' };
    assert.deepEqual(employeeSaveGaps({ isEdit: true, now: { ...none, phone: '', username: 'x' }, was: none }), { refuse: null, sendNames: false });
});

test('существующий: телефон не обязателен; заполненные Фамилия и Имя уходят', () => {
    const was = { last_name: 'Абдуллаев', first_name: 'Шерзод', middle_name: '', staff_type: 'doctor' };
    assert.deepEqual(employeeSaveGaps({ isEdit: true, now: { ...was, phone: '', username: 'demo' }, was }), { refuse: null, sendNames: true });
});

test('существующий: правят ФИО — Фамилия и Имя обязательны, в отказе названы именно пустые', () => {
    const was = { last_name: 'Абдуллаев', first_name: 'Шерзод', middle_name: '', staff_type: 'doctor' };
    const base = { ...was, phone: '', username: 'demo' };
    assert.deepEqual(employeeSaveGaps({ isEdit: true, now: { ...base, last_name: '  ' }, was }).refuse, { section: 'personal', keys: ['last_name'] });
    assert.deepEqual(employeeSaveGaps({ isEdit: true, now: { ...base, last_name: '', first_name: '' }, was }).refuse, { section: 'personal', keys: ['last_name', 'first_name'] });
    // Одно слово: дописали отчество — имя теперь нужно (ФИО собирается из частей заново).
    const one = { last_name: 'Мадина', first_name: '', middle_name: '', staff_type: 'doctor' };
    assert.deepEqual(employeeSaveGaps({ isEdit: true, now: { ...one, middle_name: 'Каримовна', phone: '', username: 'm' }, was: one }).refuse,
        { section: 'personal', keys: ['first_name'] });
    // Дописали имя — всё уходит.
    assert.deepEqual(employeeSaveGaps({ isEdit: true, now: { ...one, first_name: 'Алиева', phone: '', username: 'm' }, was: one }), { refuse: null, sendNames: true });
    // Пробелы вокруг — не правка.
    assert.deepEqual(employeeSaveGaps({ isEdit: true, now: { ...one, last_name: ' Мадина ', phone: '', username: 'm' }, was: one }), { refuse: null, sendNames: false });
});

test('существующий: пустая категория держит сохранение, только если её стёрли сейчас', () => {
    const was = { last_name: 'A', first_name: 'B', middle_name: '', staff_type: '' };
    assert.equal(employeeSaveGaps({ isEdit: true, now: { ...was, phone: '', username: 'admin' }, was }).refuse, null);
    const had = { ...was, staff_type: 'admin_staff' };
    assert.deepEqual(employeeSaveGaps({ isEdit: true, now: { ...had, staff_type: '', phone: '', username: 'admin' }, was: had }).refuse,
        { section: 'job', keys: ['staff_type'] });
});

test('NAME_KEYS — три части имени, которые карточка шлёт или не шлёт вместе', () => {
    assert.deepEqual(NAME_KEYS, ['last_name', 'first_name', 'middle_name']);
});
