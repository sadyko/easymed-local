// DEPARTMENTS_V1 — отдел формируется одной транзакцией; руководитель — врач
// или медсестра; чужие сотрудники и помещения переезжают только с
// подтверждением; снабжение видно в карточке; медсестра видит только своё.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import {
  departmentForm, departmentList, departmentCard, departmentHeadSet, departmentMemberSet, departmentPlaceSet,
  departmentStaffOptions, departmentPlaceOptions, eligibleHead,
} from './departments.js';
import { issueStockLines, createRequisition, approveRequisitionAndIssue } from './procurement.js';
import { dispenseFromHolding } from './holdings.js';

const ADMIN = { id: 1, role: 'admin', extra_roles: [] };
const INV   = { id: 2, role: 'inventory', extra_roles: [] };
const DOC   = { id: 3, role: 'doctor', extra_roles: [] };
const NURSE = { id: 4, role: 'nurse', extra_roles: [] };
const REG   = { id: 5, role: 'registrar', extra_roles: [] };

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  const mk = db.prepare('INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, department_id) VALUES (?,?,?,?,?,?,?)');
  mk.run(1, 'admin', 'x', 'Админ', 'admin', 0, null);
  mk.run(2, 'inv', 'x', 'Кладовщик', 'inventory', 0, null);
  mk.run(3, 'doc', 'x', 'Каримов Азиз', 'doctor', 1, null);
  mk.run(4, 'nurse', 'x', 'Алиева Мадина', 'nurse', 0, null);
  mk.run(5, 'reg', 'x', 'Регистратор', 'registrar', 0, null);
  mk.run(6, 'doc2', 'x', 'Рахимов Тимур', 'doctor', 1, null);
  db.prepare("INSERT INTO floors (id, name, level) VALUES (1, '1 этаж', 1), (2, '2 этаж', 2)").run();
  db.prepare("INSERT INTO rooms (id, name, code, floor_id) VALUES (101, 'Кабинет 101', '101', 1), (102, 'Кабинет 102', '102', 1), (201, 'ЭКГ', '201', 2)").run();
  db.prepare("INSERT INTO wards (id, name, code, floor_id) VALUES (11, 'Палата 1', 'П1', 2)").run();
  db.prepare("INSERT INTO products (id, name, unit, base_unit, consumption_unit, consumption_factor, sale_price, on_hand, avg_cost) VALUES (7, 'Перчатки', 'уп', 'уп', 'шт', 100, 500, 50, 20000)").run();
  return db;
}

const dept = (db, name) => db.prepare('SELECT * FROM departments WHERE name = ?').get(name);
// Роль уже может иметь строку прав (миграции сеют встроенные роли) — дописываем grants в неё.
function setGrants(db, role, grants) {
  const row = db.prepare('SELECT permissions FROM role_permissions WHERE role = ?').get(role);
  const perms = row && row.permissions ? JSON.parse(row.permissions) : { sections: [], levels: {} };
  perms.grants = { ...(perms.grants || {}), ...grants };
  if (row) db.prepare('UPDATE role_permissions SET permissions = ? WHERE role = ?').run(JSON.stringify(perms), role);
  else db.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?)').run(role, JSON.stringify(perms));
}
const roomDept = (db, id) => db.prepare('SELECT department_id FROM rooms WHERE id = ?').get(id).department_id;
const userDept = (db, id) => db.prepare('SELECT department_id FROM users WHERE id = ?').get(id).department_id;

test('сформировать: отдел, руководитель, команда, помещения — одной транзакцией, с журналом', () => {
  const db = seed();
  try {
    const r = departmentForm(db, {
      name: 'Кардиология', kind: 'clinical', head_user_id: 3, member_ids: [4],
      places: [{ type: 'room', id: 101 }, { type: 'room', id: 102 }, { type: 'ward', id: 11 }],
    }, ADMIN);
    assert.equal(r.created, true);
    const d = dept(db, 'Кардиология');
    assert.equal(d.head_user_id, 3);
    assert.equal(userDept(db, 3), d.id, 'руководитель — в команде');
    assert.equal(userDept(db, 4), d.id);
    assert.equal(roomDept(db, 101), d.id);
    assert.equal(db.prepare('SELECT department_id FROM wards WHERE id = 11').get().department_id, d.id, 'палата тоже');
    const kinds = db.prepare('SELECT kind FROM department_events WHERE department_id = ? ORDER BY id').all(d.id).map((e) => e.kind);
    assert.deepEqual(kinds, ['created', 'head_changed', 'member_added', 'member_added', 'room_assigned', 'room_assigned', 'room_assigned']);
    assert.equal(r.card.department.head.full_name, 'Каримов Азиз');
    assert.equal(r.card.places.length, 3);
    assert.equal(r.card.members.length, 2);
  } finally { db.close(); }
});

test('руководитель — только врач или медсестра; отключённый не подходит; имя отдела единственное', () => {
  const db = seed();
  try {
    assert.throws(() => departmentForm(db, { name: 'Регистратура', kind: 'administrative', head_user_id: 5 }, ADMIN),
      (e) => e.status === 400 && /не врач и не медсестра/.test(e.message));
    assert.equal(eligibleHead({ role: 'nurse', extra_roles: [] }), true);
    assert.equal(eligibleHead({ role: 'admin', extra_roles: [], is_doctor: true }), true, 'администратор-врач — врач');
    assert.equal(eligibleHead({ role: 'admin', extra_roles: ['senior_nurse'] }), true);
    assert.equal(eligibleHead({ role: 'cashier', extra_roles: [] }), false);
    departmentForm(db, { name: 'Кардиология', kind: 'clinical' }, ADMIN);
    assert.throws(() => departmentForm(db, { name: 'кардиология', kind: 'clinical' }, ADMIN), (e) => e.status === 409 && /уже есть/.test(e.message));
    db.prepare('UPDATE users SET is_active = 0 WHERE id = 6').run();
    assert.throws(() => departmentForm(db, { name: 'Урология', kind: 'clinical', head_user_id: 6 }, ADMIN), /отключён/);
  } finally { db.close(); }
});

test('чужое помещение и чужой сотрудник переезжают только с подтверждением, а ничего не переезжает молча', () => {
  const db = seed();
  try {
    departmentForm(db, { name: 'Кардиология', kind: 'clinical', head_user_id: 3, places: [{ type: 'room', id: 101 }] }, ADMIN);
    const cardio = dept(db, 'Кардиология');
    // Без подтверждения — отказ, называющий, где помещение сейчас; ничего не изменилось.
    assert.throws(() => departmentForm(db, { name: 'Урология', kind: 'clinical', places: [{ type: 'room', id: 101 }] }, ADMIN),
      (e) => e.status === 409 && /Кабинет «Кабинет 101» сейчас в отделе «Кардиология»/.test(e.message));
    assert.equal(dept(db, 'Урология'), undefined, 'отдел не создан — транзакция откатилась');
    assert.equal(roomDept(db, 101), cardio.id);
    // С подтверждением — переехал, и в журнале обоих сказано.
    const r = departmentForm(db, { name: 'Урология', kind: 'clinical', places: [{ type: 'room', id: 101 }], reassign_places: [{ type: 'room', id: 101 }] }, ADMIN);
    assert.equal(roomDept(db, 101), r.department_id);
    const ev = db.prepare("SELECT details FROM department_events WHERE department_id = ? AND kind = 'room_assigned'").get(r.department_id);
    assert.equal(JSON.parse(ev.details).from_department, 'Кардиология');
    // Сотрудник — то же правило.
    assert.throws(() => departmentMemberSet(db, { department_id: r.department_id, user_id: 3, on: true }, ADMIN),
      (e) => e.status === 409 && /Каримов Азиз сейчас в отделе «Кардиология»/.test(e.message));
    assert.equal(userDept(db, 3), cardio.id);
    departmentMemberSet(db, { department_id: r.department_id, user_id: 3, on: true, reassign: true }, ADMIN);
    assert.equal(userDept(db, 3), r.department_id);
  } finally { db.close(); }
});

test('правка: полный список команды и помещений — кого нет, тот выходит; руководителя нельзя убрать из команды', () => {
  const db = seed();
  try {
    const r = departmentForm(db, { name: 'Кардиология', kind: 'clinical', head_user_id: 3, member_ids: [4, 6], places: [{ type: 'room', id: 101 }, { type: 'room', id: 102 }] }, ADMIN);
    departmentForm(db, { id: r.department_id, name: 'Кардиология', kind: 'clinical', head_user_id: 3, member_ids: [4], places: [{ type: 'room', id: 102 }] }, ADMIN);
    assert.equal(userDept(db, 6), null, 'убранный из списка вышел');
    assert.equal(userDept(db, 4), r.department_id);
    assert.equal(roomDept(db, 101), null, 'снятое помещение освобождено');
    assert.equal(roomDept(db, 102), r.department_id);
    assert.throws(() => departmentMemberSet(db, { department_id: r.department_id, user_id: 3, on: false }, ADMIN), /руководит отделом/);
    departmentHeadSet(db, { department_id: r.department_id, user_id: 4 }, ADMIN);
    assert.equal(dept(db, 'Кардиология').head_user_id, 4);
    departmentMemberSet(db, { department_id: r.department_id, user_id: 3, on: false }, ADMIN);
    assert.equal(userDept(db, 3), null);
    departmentPlaceSet(db, { department_id: r.department_id, type: 'room', id: 102, on: false }, ADMIN);
    assert.equal(roomDept(db, 102), null);
  } finally { db.close(); }
});

test('снабжение в карточке: выдано со склада, на руках, израсходовано на пациента; квитанция не даёт выдать дважды', () => {
  const db = seed();
  try {
    const r = departmentForm(db, { name: 'Кардиология', kind: 'clinical', head_user_id: 3, member_ids: [4] }, ADMIN);
    const did = r.department_id;
    const key = 'form-abc123-xyz';
    const one = issueStockLines(db, { holder: { type: 'department', id: did }, lines: [{ product_id: 7, qty: 200, unit: 'consumption' }], note: 'на неделю', idempotency_key: key }, INV);
    const two = issueStockLines(db, { holder: { type: 'department', id: did }, lines: [{ product_id: 7, qty: 200, unit: 'consumption' }], note: 'на неделю', idempotency_key: key }, INV);
    assert.equal(two.repeated, true, 'повтор — та же квитанция');
    assert.deepEqual(two.issued, one.issued);
    assert.equal(db.prepare('SELECT on_hand FROM products WHERE id = 7').get().on_hand, 48, 'списано один раз: 200 шт = 2 уп');

    db.prepare("INSERT INTO patients (id, full_name, mrn) VALUES (1, 'Иванов Иван', 'EM-1')").run();
    const visit = db.prepare("INSERT INTO visits (patient_id, visit_date, status) VALUES (1, strftime('%Y-%m-%dT%H:%M:%SZ','now'), 'arrived')").run().lastInsertRowid;
    dispenseFromHolding(db, { holder: { type: 'department', id: did }, product_id: 7, quantity: 50, visit_id: visit }, NURSE);

    const card = departmentCard(db, { department_id: did }, ADMIN);
    assert.equal(card.issues.length, 1);
    assert.equal(card.issues[0].qty_units, 200);
    assert.equal(card.issues[0].issued_by, 'Кладовщик');
    assert.equal(card.holdings[0].qty_units, 150, 'на руках: 200 − 50');
    assert.equal(card.usage.length, 1);
    assert.equal(card.usage[0].patient_name, 'Иванов Иван');
    assert.equal(card.usage[0].qty_units, 50);
    assert.ok(card.events.some((e) => e.kind === 'issued' && e.details.lines[0].name === 'Перчатки'));
    // В списке — счётчики.
    const row = departmentList(db, {}, ADMIN).departments.find((d) => d.id === did);
    assert.equal(row.members, 2); assert.equal(row.held_products, 1); assert.equal(row.head.full_name, 'Каримов Азиз');
  } finally { db.close(); }
});

test('заявка отдела: создаётся с номером, а при выдаче отдел получает остаток', () => {
  const db = seed();
  try {
    const r = departmentForm(db, { name: 'Кардиология', kind: 'clinical', head_user_id: 3 }, ADMIN);
    const req = createRequisition(db, { p_department: r.department_id, p_notes: 'срочно', p_lines: [{ item_id: 7, qty: 3 }] }, DOC);
    assert.match(req.req_number, /^REQ-\d{8}-001$/);
    assert.equal(req.status, 'submitted');
    assert.throws(() => createRequisition(db, { p_department: r.department_id, p_lines: [] }, DOC), /хотя бы одну позицию/);
    assert.throws(() => createRequisition(db, { p_department: r.department_id, p_lines: [{ item_id: 7, qty: 1 }] }, REG), /not allowed/);
    approveRequisitionAndIssue(db, { req_id: req.req_id }, INV);
    const held = db.prepare("SELECT qty FROM stock_holdings WHERE holder_type = 'department' AND holder_id = ? AND product_id = 7").get(r.department_id);
    assert.equal(held.qty, 3, 'заявка выдана отделу, а не в пустоту');
    assert.equal(db.prepare('SELECT on_hand FROM products WHERE id = 7').get().on_hand, 47);
    const card = departmentCard(db, { department_id: r.department_id }, ADMIN);
    assert.equal(card.issues[0].source, 'requisition');
    assert.equal(card.requisitions[0].status, 'issued');
  } finally { db.close(); }
});

test('права: регистратор не формирует и не видит чужое; медсестра видит только свой отдел; матрица главнее', () => {
  const db = seed();
  try {
    const r = departmentForm(db, { name: 'Кардиология', kind: 'clinical', head_user_id: 3, member_ids: [4] }, ADMIN);
    departmentForm(db, { name: 'Урология', kind: 'clinical' }, ADMIN);
    assert.throws(() => departmentForm(db, { name: 'Х', kind: 'clinical' }, REG), (e) => e.status === 403 && /недоступно вашей роли/.test(e.message));
    assert.throws(() => departmentStaffOptions(db, {}, REG), (e) => e.status === 403);
    assert.throws(() => departmentPlaceOptions(db, {}, REG), (e) => e.status === 403);
    // Медсестра — только свой отдел.
    const mine = departmentList(db, {}, NURSE);
    assert.deepEqual(mine.departments.map((d) => d.name), ['Кардиология']);
    assert.equal(mine.can_form, false);
    assert.ok(departmentCard(db, { department_id: r.department_id }, NURSE).holdings);
    const uro = dept(db, 'Урология');
    assert.throws(() => departmentCard(db, { department_id: uro.id }, NURSE), (e) => e.status === 403);
    // Регистратору выдали окно «Отделы: изменение» — теперь формирует.
    setGrants(db, 'registrar', { 'settings.departments': 'edit' });
    assert.ok(departmentForm(db, { name: 'Регистратура', kind: 'administrative' }, REG).created);
    const seen = departmentList(db, {}, REG);
    assert.equal(seen.sees_all, true);
    assert.ok(seen.departments.some((d) => d.name === 'Урология'), 'с правом видит и чужие отделы');
    // Снабженцу закрыли выдачу — сервер отказывает словами.
    setGrants(db, 'inventory', { 'procurement.issue': 'none' });
    assert.throws(() => issueStockLines(db, { holder: { type: 'department', id: r.department_id }, lines: [{ product_id: 7, qty: 1, unit: 'base' }] }, INV),
      (e) => e.status === 403 && /Выдавать со склада — недоступно вашей роли/.test(e.message));
  } finally { db.close(); }
});
