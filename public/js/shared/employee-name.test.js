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
import { splitFullName, employeeNameParts, employeeSaveGaps, namesRoundTrip, NAME_KEYS } from './employee-name.js';

const EMPTY = { last_name: '', first_name: '', middle_name: '' };

test('splitFullName: первое слово — фамилия, второе — имя, остальное — отчество', () => {
    assert.deepEqual(splitFullName('Абдуллаев Шерзод'), { last_name: 'Абдуллаев', first_name: 'Шерзод', middle_name: '' });
    assert.deepEqual(splitFullName('Каюмов Араббек Акмалович'), { last_name: 'Каюмов', first_name: 'Араббек', middle_name: 'Акмалович' });
    // Узбекское отчество — два слова; латиница с апострофом остаётся целой.
    assert.deepEqual(splitFullName("Karimov Anvar Akmal o'g'li"), { last_name: 'Karimov', first_name: 'Anvar', middle_name: "Akmal o'g'li" });
    assert.deepEqual(splitFullName('Ғуломова Ўғилой Тошпўлат қизи'), { last_name: 'Ғуломова', first_name: 'Ўғилой', middle_name: 'Тошпўлат қизи' });
    // Лишние пробелы, табуляция и неразрывный пробел — не слова.
    assert.deepEqual(splitFullName('  Абдуллаев \t Шерзод\u00a0  Рустамович  '), { last_name: 'Абдуллаев', first_name: 'Шерзод', middle_name: 'Рустамович' });
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
    const was = { last_name: 'Абдуллаев', first_name: 'Шерзод', middle_name: '', staff_type: 'doctor', phone: '' };
    const stored = { full_name: 'Абдуллаев Шерзод', last_name: null, first_name: null, middle_name: null };
    assert.deepEqual(employeeSaveGaps({ isEdit: true, now: { ...was, username: 'demo' }, was, stored }), { refuse: null, sendNames: true });
});

// EMPLOYEE_CARD_SAVE_V1, ревью — ФИО, которое не правили, не меняется НИ НА БАЙТ.
// Сервер пересобирает full_name из присланных частей: схлопывает пробелы (двойной,
// по краям, неразрывный, табуляция), режет часть длиннее 120 знаков, а разобранная
// строка без отчества стирает отчество, лежавшее в своей колонке. Поэтому
// нетронутые части уходят, только если сервер соберёт из них РОВНО тот же
// full_name и ни одна заполненная колонка не потеряется.
test('namesRoundTrip: нетронутые части уходят, только если full_name останется побайтно тем же', () => {
    const split = (full, extra = {}) => ({ full_name: full, last_name: null, first_name: null, middle_name: null, ...extra });
    const send = (row) => namesRoundTrip(row, employeeNameParts(row));
    assert.equal(send(split('Абдуллаев Шерзод')), true);
    assert.equal(send(split('Каюмов Араббек Акмалович')), true);
    assert.equal(send(split('Абдуллаев  Шерзод')), false, 'двойной пробел');
    assert.equal(send(split('Абдуллаев\u00a0Шерзод')), false, 'неразрывный пробел');
    assert.equal(send(split('Абдуллаев\tШерзод')), false, 'табуляция');
    assert.equal(send(split(' Абдуллаев Шерзод')), false, 'пробел в начале');
    assert.equal(send(split('Абдуллаев Шерзод ')), false, 'пробел в конце');
    assert.equal(send(split('Абдуллаев ' + 'Ш'.repeat(121))), false, 'часть длиннее 120 знаков');
    assert.equal(send(split('Абдуллаев ' + 'Ш'.repeat(120))), true, '120 знаков — как есть');
    assert.equal(send(split('Абдуллаев Шерзод', { middle_name: 'Рустамович' })), false, 'отчество в своей колонке стёрлось бы');
    // Колонки заполнены и сходятся с full_name — отправка ничего не меняет.
    assert.equal(send({ full_name: 'Хирургов Хасан', last_name: 'Хирургов', first_name: 'Хасан', middle_name: '' }), true);
    // Колонки и full_name разошлись — нетронутое имя full_name не переписывает.
    assert.equal(send({ full_name: 'Хирургов Хасан Ака', last_name: 'Хирургов', first_name: 'Хасан', middle_name: '' }), false);
});

test('существующий: нетронутое имя, которое не вернётся тем же full_name, не отправляется — сохранение не держит', () => {
    for (const full of ['Абдуллаев  Шерзод', 'Абдуллаев\u00a0Шерзод', 'Абдуллаев ' + 'Ш'.repeat(121)]) {
        const stored = { full_name: full, last_name: null, first_name: null, middle_name: null };
        const was = { ...employeeNameParts(stored), staff_type: 'doctor', phone: '' };
        assert.deepEqual(employeeSaveGaps({ isEdit: true, now: { ...was, username: 'demo' }, was, stored }), { refuse: null, sendNames: false }, JSON.stringify(full));
    }
    const stored = { full_name: 'Абдуллаев Шерзод', last_name: null, first_name: null, middle_name: 'Рустамович' };
    const was = { ...employeeNameParts(stored), staff_type: 'doctor', phone: '' };
    assert.deepEqual(employeeSaveGaps({ isEdit: true, now: { ...was, username: 'demo' }, was, stored }), { refuse: null, sendNames: false });
    // ФИО ПРАВИЛИ — части уходят: человек сам написал, каким быть имени.
    assert.deepEqual(employeeSaveGaps({ isEdit: true, now: { ...was, middle_name: 'Рустамович', username: 'demo' }, was, stored }), { refuse: null, sendNames: true });
});

test('существующий: телефон стёрли сейчас — «Не заполнено: Телефон»; пустой с самого начала — не держит', () => {
    const was = { last_name: 'A', first_name: 'B', middle_name: '', staff_type: 'doctor', phone: '+998 90 123 45 67' };
    assert.deepEqual(employeeSaveGaps({ isEdit: true, now: { ...was, phone: '', username: 'a' }, was }).refuse, { section: 'personal', keys: ['phone'] });
    assert.deepEqual(employeeSaveGaps({ isEdit: true, now: { ...was, phone: '  ', username: 'a' }, was }).refuse, { section: 'personal', keys: ['phone'] });
    // Стёрли и фамилию, и телефон — отказ называет оба.
    assert.deepEqual(employeeSaveGaps({ isEdit: true, now: { ...was, last_name: '', phone: '', username: 'a' }, was }).refuse,
        { section: 'personal', keys: ['last_name', 'phone'] });
    // Телефон поменяли — не пусто, не держит.
    assert.equal(employeeSaveGaps({ isEdit: true, now: { ...was, phone: '+998 91 000 00 00', username: 'a' }, was }).refuse, null);
    // Телефона не было — и нет: не держит.
    const none = { ...was, phone: '' };
    assert.equal(employeeSaveGaps({ isEdit: true, now: { ...none, username: 'a' }, was: none }).refuse, null);
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
