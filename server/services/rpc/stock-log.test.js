// STOCK_LOG_V1 — ЖУРНАЛ ДВИЖЕНИЙ: КТО, КОМУ, ЧТО, КОГДА — И КОМУ ЭТО ВИДНО.
//
// Владелец (23.09): «каждый видит своё, заведующая — свой отдел, администратор
// и кладовщик — всю клинику»; и сам журнал чинится — кто, кому, партия, срок,
// фильтр по датам.
//
// Что закреплено здесь, по важности:
//   1. ОБЛАСТЬ ВИДИМОСТИ СЧИТАЕТ СЕРВЕР. Экран не фильтрует чужие строки —
//      он их не получает. Поэтому проверяется не «в таблице нет строки», а
//      «RPC её не отдал».
//   2. РОЛЬ, КОТОРОЙ НЕЧЕГО ПОКАЗАТЬ, ПОЛУЧАЕТ ПУСТОЙ СПИСОК, А НЕ ОТКАЗ.
//      403 на журнале — это «сломалось», и человек зовёт администратора;
//      пустой список — это «за вами движений не числится».
//   3. «КТО» И «КОМУ» — РАЗНЫЕ ЛЮДИ. До этой задачи «кто» был всегда «—»
//      (запрос просил встраивание users, а реестр регистрирует его под именем
//      created_by), а «кому» вообще не было колонкой: получатель вклеивался в
//      текст основания. Обоих проверяем на всех трёх видах держателя.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { stockMovementsList, journalScope } from './stock-log.js';
import { receiveStockLines, issueStockLines } from './procurement.js';
import { dispenseFromHolding } from './holdings.js';
import { departmentForm } from './departments.js';

const ADMIN = { id: 1, role: 'admin', extra_roles: [] };
const INV   = { id: 2, role: 'inventory', extra_roles: [] };
const HEAD  = { id: 3, role: 'doctor', extra_roles: [] };        // заведующая Кардиологией
const NURSE = { id: 4, role: 'nurse', extra_roles: [] };         // медсестра Кардиологии
const REG   = { id: 5, role: 'registrar', extra_roles: [] };     // движений за ней нет вовсе
const HEAD2 = { id: 6, role: 'doctor', extra_roles: [] };        // заведующий соседним отделом

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  const mk = db.prepare('INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (?,?,?,?,?,?)');
  mk.run(1, 'admin', 'x', 'Админ Админов', 'admin', 0);
  mk.run(2, 'inv', 'x', 'Кладовщик Каримов', 'inventory', 0);
  mk.run(3, 'head', 'x', 'Заведующая Юсупова', 'doctor', 1);
  mk.run(4, 'nurse', 'x', 'Медсестра Алиева', 'nurse', 0);
  mk.run(5, 'reg', 'x', 'Регистратор Рустамов', 'registrar', 0);
  mk.run(6, 'head2', 'x', 'Заведующий Тошматов', 'doctor', 1);
  db.prepare("INSERT INTO floors (id, name, level) VALUES (1, '1 этаж', 1)").run();
  db.prepare("INSERT INTO rooms (id, name, code, floor_id) VALUES (101, 'Кабинет 101', '101', 1), (102, 'Кабинет 102', '102', 1)").run();
  db.prepare("INSERT INTO suppliers (id, name) VALUES (9, 'Медснаб')").run();
  db.prepare("INSERT INTO products (id, name, unit, base_unit, consumption_unit, consumption_factor, sale_price, on_hand, avg_cost) VALUES (7, 'Перчатки', 'уп', 'уп', 'шт', 100, 500, 0, 0)").run();
  db.prepare("INSERT INTO products (id, name, unit, base_unit, sale_price, on_hand, avg_cost) VALUES (8, 'Бинт', 'шт', 'шт', 2000, 0, 0)").run();
  db.prepare("INSERT INTO patients (id, full_name) VALUES (50, 'Сидоров Сидор')").run();
  db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (300, 50, date('now','localtime'), 'arrived')").run();

  departmentForm(db, { name: 'Кардиология', kind: 'clinical', head_user_id: 3, member_ids: [4], places: [{ type: 'room', id: 101 }] }, ADMIN);
  departmentForm(db, { name: 'Терапия', kind: 'clinical', head_user_id: 6, member_ids: [], places: [] }, ADMIN);
  return db;
}

const deptId = (db, name) => db.prepare('SELECT id FROM departments WHERE name = ?').get(name).id;
const names = (r) => r.movements.map((m) => m.product_name);
const byKind = (r, k) => r.movements.filter((m) => m.view_kind === k);
const setWhen = (db, id, iso) => db.prepare('UPDATE stock_movements SET created_at = ? WHERE id = ?').run(iso, id);

/** Полный «день из жизни склада»: приход, три выдачи, расход на пациента. */
function busyDay(db) {
  const cardio = deptId(db, 'Кардиология');
  // Приход: партия и срок годности (миграция 037) — их-то журнал и не показывал.
  receiveStockLines(db, { lines: [
    { product_id: 7, qty: 40, unit: 'base', unit_cost: 20000, supplier_id: 9, batch_no: 'A-117', expiry_date: '2027-05-30' },
    { product_id: 8, qty: 30, unit: 'base', unit_cost: 1000 },
  ] }, ADMIN);
  // Три вида получателя — ровно те, что знает stock_holdings (миграция 128).
  issueStockLines(db, { holder: { type: 'department', id: cardio }, lines: [{ product_id: 7, qty: 500, unit: 'consumption' }], note: 'на неделю' }, INV);
  issueStockLines(db, { holder: { type: 'staff', id: 4 }, lines: [{ product_id: 8, qty: 5, unit: 'base' }] }, INV);
  issueStockLines(db, { holder: { type: 'room', id: 101 }, lines: [{ product_id: 8, qty: 3, unit: 'base' }] }, INV);
  // Расход на пациента из остатка отдела — медсестра, визит.
  dispenseFromHolding(db, { visit_id: 300, product_id: 7, quantity: 2, holder: { type: 'department', id: cardio } }, NURSE);
  return cardio;
}

// ───────────────────────────────────────────────────────────────────────────
// 1. Починенный журнал: кто, кому, партия, срок, пациент
// ───────────────────────────────────────────────────────────────────────────

test('«Кто» — имя сотрудника, а не прочерк: приход провёл администратор, выдачу — кладовщик', () => {
  const db = seed();
  try {
    busyDay(db);
    const r = stockMovementsList(db, {}, ADMIN);
    assert.ok(r.movements.length >= 6, 'журнал пуст: ' + JSON.stringify(r));
    assert.equal(r.movements.every((m) => m.actor_name), true,
        'у движения нет имени сотрудника — это тот самый прочерк «—» в колонке «Кто»');
    const receive = byKind(r, 'receive').find((m) => m.product_id === 7);
    assert.equal(receive.actor_name, 'Админ Админов');
    const issues = byKind(r, 'issue');
    assert.equal(issues.length, 3);
    assert.equal(issues.every((m) => m.actor_name === 'Кладовщик Каримов'), true);
  } finally { db.close(); }
});

test('«Кому» — разобранный получатель всех трёх видов: сотрудник, кабинет, отдел', () => {
  const db = seed();
  try {
    const cardio = busyDay(db);
    const r = stockMovementsList(db, { kind: 'issue' }, ADMIN);
    const got = r.movements.map((m) => [m.holder_type, m.holder_id, m.holder_name]).sort((a, b) => String(a).localeCompare(String(b)));
    assert.deepEqual(got, [
      ['department', cardio, 'Кардиология'],
      ['room', 101, 'Кабинет 101'],
      ['staff', 4, 'Медсестра Алиева'],
    ].sort((a, b) => String(a).localeCompare(String(b))));
  } finally { db.close(); }
});

test('получатель ушёл из «Основания» в свою колонку — в заметке осталась причина', () => {
  const db = seed();
  try {
    const cardio = busyDay(db);
    const r = stockMovementsList(db, { kind: 'issue' }, ADMIN);
    const toDept = r.movements.find((m) => m.holder_type === 'department' && m.holder_id === cardio);
    assert.equal(toDept.note, 'на неделю',
        'имя получателя всё ещё вклеено в основание — теперь оно колонка «Кому»');
    const toRoom = r.movements.find((m) => m.holder_type === 'room');
    assert.equal(toRoom.note, '', 'выдача без причины не должна показывать имя получателя как причину');
  } finally { db.close(); }
});

test('партия и срок годности доезжают до журнала, пациент — до строки расхода', () => {
  const db = seed();
  try {
    busyDay(db);
    const r = stockMovementsList(db, {}, ADMIN);
    const receive = byKind(r, 'receive').find((m) => m.product_id === 7);
    assert.equal(receive.batch_no, 'A-117');
    assert.equal(receive.expiry_date, '2027-05-30');
    const other = byKind(r, 'receive').find((m) => m.product_id === 8);
    assert.equal(other.batch_no, '');
    assert.equal(other.expiry_date, '');
    const toPatient = byKind(r, 'dispense');
    assert.equal(toPatient.length, 1);
    assert.equal(toPatient[0].patient_name, 'Сидоров Сидор');
    assert.equal(toPatient[0].actor_name, 'Медсестра Алиева');
    assert.equal(byKind(r, 'issue').every((m) => m.patient_name === ''), true,
        'выдача со склада — не расход на пациента');
  } finally { db.close(); }
});

test('единица измерения и количество — те же базовые, что на складе', () => {
  const db = seed();
  try {
    busyDay(db);
    const r = stockMovementsList(db, { q: 'Перчат' }, ADMIN);
    assert.equal(r.movements.every((m) => m.product_name === 'Перчатки'), true, 'поиск по товару не сработал');
    const receive = byKind(r, 'receive')[0];
    assert.equal(receive.qty, 40);
    assert.equal(receive.unit, 'уп');
    assert.equal(receive.unit_cost, 20000);
    const issue = byKind(r, 'issue')[0];
    assert.equal(issue.qty, -5, 'выдача 500 шт при факторе 100 — это минус 5 упаковок');
  } finally { db.close(); }
});

// ───────────────────────────────────────────────────────────────────────────
// 2. Фильтры: даты и вид движения
// ───────────────────────────────────────────────────────────────────────────

test('фильтр по датам отбирает период, а не обрезает список лимитом', () => {
  const db = seed();
  try {
    busyDay(db);
    const all = stockMovementsList(db, {}, ADMIN);
    const ids = all.movements.map((m) => m.id);
    setWhen(db, ids[ids.length - 1], '2026-01-15T09:00:00Z');
    setWhen(db, ids[ids.length - 2], '2026-03-20T09:00:00Z');

    const jan = stockMovementsList(db, { from: '2026-01-01', to: '2026-01-31' }, ADMIN);
    assert.equal(jan.movements.length, 1);
    assert.equal(jan.movements[0].id, ids[ids.length - 1]);

    const q1 = stockMovementsList(db, { from: '2026-01-01', to: '2026-03-31' }, ADMIN);
    assert.equal(q1.movements.length, 2);

    const openEnd = stockMovementsList(db, { from: '2026-01-01' }, ADMIN);
    assert.equal(openEnd.movements.length, all.movements.length, 'без «по» отбор не должен терять сегодняшние строки');

    const untilFeb = stockMovementsList(db, { to: '2026-02-01' }, ADMIN);
    assert.equal(untilFeb.movements.length, 1, 'без «с» отбор должен упираться в «по»');
  } finally { db.close(); }
});

test('дата не в формате ГГГГ-ММ-ДД — отказ словами, а не тихо пустой журнал', () => {
  const db = seed();
  try {
    assert.throws(() => stockMovementsList(db, { from: '15.01.2026' }, ADMIN), /ГГГГ-ММ-ДД/);
    assert.throws(() => stockMovementsList(db, { to: 'вчера' }, ADMIN), /ГГГГ-ММ-ДД/);
  } finally { db.close(); }
});

test('вид движения: «Выдача» и «Списание» — это один kind, разведённый основанием', () => {
  const db = seed();
  try {
    busyDay(db);
    assert.equal(stockMovementsList(db, { kind: 'receive' }, ADMIN).movements.length, 2);
    assert.equal(stockMovementsList(db, { kind: 'issue' }, ADMIN).movements.length, 3);
    const disp = stockMovementsList(db, { kind: 'dispense' }, ADMIN).movements;
    assert.equal(disp.length, 1);
    assert.equal(disp[0].patient_name, 'Сидоров Сидор');
    assert.equal(stockMovementsList(db, { kind: 'adjust' }, ADMIN).movements.length, 0);
    assert.throws(() => stockMovementsList(db, { kind: 'выдача' }, ADMIN), /вид движения/i);
  } finally { db.close(); }
});

test('список честен про обрезку: truncated и смещение', () => {
  const db = seed();
  try {
    busyDay(db);
    const page = stockMovementsList(db, { limit: 2 }, ADMIN);
    assert.equal(page.movements.length, 2);
    assert.equal(page.truncated, true, 'журнал обрезан лимитом и молчит об этом');
    const rest = stockMovementsList(db, { limit: 2, offset: 2 }, ADMIN);
    assert.equal(rest.movements.length, 2);
    assert.notDeepEqual(rest.movements.map((m) => m.id), page.movements.map((m) => m.id));
    const whole = stockMovementsList(db, { limit: 500 }, ADMIN);
    assert.equal(whole.truncated, false);
  } finally { db.close(); }
});

// ───────────────────────────────────────────────────────────────────────────
// 3. Область видимости — решение владельца, целиком
// ───────────────────────────────────────────────────────────────────────────

test('администратор и кладовщик видят всю клинику', () => {
  const db = seed();
  try {
    busyDay(db);
    const admin = stockMovementsList(db, {}, ADMIN);
    const inv = stockMovementsList(db, {}, INV);
    assert.equal(admin.scope, 'all');
    assert.equal(inv.scope, 'all');
    assert.deepEqual(inv.movements.map((m) => m.id), admin.movements.map((m) => m.id));
    assert.equal(admin.movements.length, 6);
  } finally { db.close(); }
});

test('заведующая видит свой отдел и своё — и ничего из чужого отдела', () => {
  const db = seed();
  try {
    const cardio = busyDay(db);
    const therapy = deptId(db, 'Терапия');
    issueStockLines(db, { holder: { type: 'department', id: therapy }, lines: [{ product_id: 8, qty: 4, unit: 'base' }] }, INV);

    const r = stockMovementsList(db, {}, HEAD);
    assert.equal(r.scope, 'department');
    assert.deepEqual(r.departments, [cardio]);
    // Своё: выдача в Кардиологию и расход Кардиологии на пациента.
    const holders = r.movements.map((m) => `${m.holder_type}:${m.holder_id}`).sort();
    assert.deepEqual(holders, [`department:${cardio}`, `department:${cardio}`]);
    assert.equal(r.movements.some((m) => m.holder_id === therapy), false,
        'заведующей видны движения чужого отдела');
    assert.equal(r.movements.some((m) => m.view_kind === 'receive'), false,
        'приход на склад — не движение отдела');

    const other = stockMovementsList(db, {}, HEAD2);
    assert.equal(other.scope, 'department');
    assert.deepEqual(other.movements.map((m) => `${m.holder_type}:${m.holder_id}`), [`department:${therapy}`]);
  } finally { db.close(); }
});

test('медсестра видит только своё: что выдали ей и что провела она сама', () => {
  const db = seed();
  try {
    const cardio = busyDay(db);
    const r = stockMovementsList(db, {}, NURSE);
    assert.equal(r.scope, 'own');
    const seen = r.movements.map((m) => `${m.view_kind}:${m.holder_type}:${m.holder_id}`).sort();
    assert.deepEqual(seen, [`dispense:department:${cardio}`, 'issue:staff:4'].sort(),
        'медсестре видно не ровно своё: ' + JSON.stringify(seen));
    assert.equal(r.movements.some((m) => m.holder_type === 'room'), false,
        'выдача в кабинет — не её движение');
  } finally { db.close(); }
});

test('роль, за которой движений нет, получает пустой список, а не отказ', () => {
  const db = seed();
  try {
    busyDay(db);
    let r;
    assert.doesNotThrow(() => { r = stockMovementsList(db, {}, REG); });
    assert.deepEqual(r.movements, []);
    assert.equal(r.scope, 'own');
    assert.equal(r.truncated, false);
    // И «никто вовсе» — тоже не исключение: журнал не место для 500-й.
    assert.doesNotThrow(() => stockMovementsList(db, {}, null));
    assert.deepEqual(stockMovementsList(db, {}, null).movements, []);
  } finally { db.close(); }
});

test('область видимости — настраиваемая: раздел «Закупки», выданный роли, открывает всю клинику', () => {
  const db = seed();
  try {
    busyDay(db);
    const row = db.prepare('SELECT permissions FROM role_permissions WHERE role = ?').get('nurse');
    const perms = row && row.permissions ? JSON.parse(row.permissions) : { sections: [], levels: {} };
    perms.sections = [...new Set([...(perms.sections || []), 'inventory'])];
    perms.levels = { ...(perms.levels || {}), inventory: 'viewer' };
    if (row) db.prepare('UPDATE role_permissions SET permissions = ? WHERE role = ?').run(JSON.stringify(perms), 'nurse');
    else db.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?)').run('nurse', JSON.stringify(perms));

    const r = stockMovementsList(db, {}, NURSE);
    assert.equal(r.scope, 'all', 'роль со складом должна видеть журнал склада');
    assert.equal(r.movements.length, 6);
  } finally { db.close(); }
});

test('journalScope отвечает тем же, что список: одно правило, а не два', () => {
  const db = seed();
  try {
    const cardio = busyDay(db);
    assert.equal(journalScope(db, ADMIN).kind, 'all');
    assert.equal(journalScope(db, INV).kind, 'all');
    const head = journalScope(db, HEAD);
    assert.equal(head.kind, 'department');
    assert.deepEqual(head.departments, [cardio]);
    assert.equal(journalScope(db, NURSE).kind, 'own');
    assert.equal(journalScope(db, REG).kind, 'own');
    assert.equal(journalScope(db, null).kind, 'none');
  } finally { db.close(); }
});

test('фильтры и область видимости складываются, а не подменяют друг друга', () => {
  const db = seed();
  try {
    busyDay(db);
    const r = stockMovementsList(db, { kind: 'issue' }, NURSE);
    assert.equal(r.movements.length, 1, 'медсестре и с фильтром видно только своё');
    assert.equal(r.movements[0].holder_type, 'staff');
    assert.equal(stockMovementsList(db, { kind: 'receive' }, NURSE).movements.length, 0);
  } finally { db.close(); }
});

// ───────────────────────────────────────────────────────────────────────────
// MY_STOCK_V1 — СУЖЕНИЕ «ТОЛЬКО МОЁ» ДЛЯ ЭКРАНА «МОИ ЗАПАСЫ».
//
// Экран задаёт журналу два разных вопроса — «что выдали МНЕ» и «что списал Я» —
// и оба обязаны считаться здесь же, а не отбором в браузере поверх обрезанной
// выборки: последние двести строк клиники могут не содержать ни одной моей.
// Аргумент только СУЖАЕТ: он приписывается к области видимости, а не заменяет
// её, поэтому им нельзя выпросить чужое.
// ───────────────────────────────────────────────────────────────────────────

test('only=to_me: «что выдали мне» — только там, где я держатель; выдачи в мой отдел это не то же самое', () => {
  const db = seed();
  try {
    const cardio = busyDay(db);
    const r = stockMovementsList(db, { kind: 'issue', only: 'to_me' }, NURSE);
    assert.deepEqual(r.movements.map((m) => [m.holder_type, m.holder_id, m.product_name]), [['staff', 4, 'Бинт']],
        'в «что выдали мне» попало не только выданное лично мне');
    assert.equal(r.movements[0].actor_name, 'Кладовщик Каримов', 'экран обязан назвать выдавшего');

    // Кладовщик раздал товар отделу и кабинету — в его собственном «выдали
    // мне» их нет: он их провёл, а не получил.
    assert.deepEqual(stockMovementsList(db, { kind: 'issue', only: 'to_me' }, INV).movements, []);
    // И отдельно: выдача В ОТДЕЛ медсестре видна в журнале, но это не её подотчёт.
    const wide = stockMovementsList(db, { kind: 'issue' }, NURSE);
    assert.equal(wide.movements.some((m) => m.holder_type === 'department' && m.holder_id === cardio), false,
        'подготовка: медсестре отдела чужие выдачи и так не видны');
  } finally { db.close(); }
});

test('only=by_me: «что я списал на пациентов» — движения, которые провёл я сам, с именем пациента', () => {
  const db = seed();
  try {
    busyDay(db);
    const r = stockMovementsList(db, { kind: 'dispense', only: 'by_me' }, NURSE);
    assert.equal(r.movements.length, 1);
    assert.equal(r.movements[0].patient_name, 'Сидоров Сидор');
    assert.equal(r.movements[0].actor_id, NURSE.id);
    // Заведующая отдела видит расход своего отдела в журнале — но не в «я списал».
    assert.equal(stockMovementsList(db, { kind: 'dispense' }, HEAD).movements.length, 1);
    assert.deepEqual(stockMovementsList(db, { kind: 'dispense', only: 'by_me' }, HEAD).movements, []);
  } finally { db.close(); }
});

test('сужение НИКОГДА не расширяет: администратор с only=to_me видит только своё, а неизвестное значение — отказ', () => {
  const db = seed();
  try {
    busyDay(db);
    assert.ok(stockMovementsList(db, {}, ADMIN).movements.length >= 6, 'подготовка: администратору видно всё');
    assert.deepEqual(stockMovementsList(db, { only: 'to_me' }, ADMIN).movements, [],
        'администратору ничего не выдавали — «моё» обязано остаться пустым, а не показать всю клинику');
    assert.equal(stockMovementsList(db, { only: 'by_me' }, ADMIN).movements.every((m) => m.actor_id === ADMIN.id), true);
    assert.throws(() => stockMovementsList(db, { only: 'everything' }, ADMIN), (e) => e.status === 400);
  } finally { db.close(); }
});
