// HR_STAFF_V1 — раздел «HR»: список с фильтрами, документы, выданная техника.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { hrStaffList, hrStaffCard, hrDocumentAdd, hrDocumentRemove, hrAssetIssue, hrAssetReturn } from './hr.js';
import { getRpc } from './index.js';
import { isReadOnlyRpc } from '../control/gate.js';

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO departments (id, name, kind) VALUES (91, 'Кардиология', 'clinical'), (92, 'Бухгалтерия', 'administrative')").run();
  const ins = db.prepare(`INSERT INTO users (id, username, password_hash, role, full_name, staff_type, is_doctor, specialty, position,
                          department_id, hire_date, is_active, phone) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  ins.run(1, 'adm', 'x', 'admin', 'Администратор Главный', 'admin_staff', 0, '', 'Директор', 92, '2020-01-10', 1, '+998900000001');
  ins.run(2, 'doc', 'x', 'doctor', 'Врачев Иван', 'doctor', 1, 'Кардиолог', '', 91, '2023-05-01', 1, '+998900000002');
  // Врач, заведённый до появления категории: staff_type пуст, is_doctor = 1.
  ins.run(3, 'old', 'x', 'doctor', 'Старый Доктор', '', 1, 'Терапевт', '', 91, '2019-03-15', 1, '');
  ins.run(4, 'nur', 'x', 'nurse', 'Медсестра Анна', 'mid_low', 0, '', 'Медсестра', 91, '2024-02-20', 1, '');
  ins.run(5, 'gone', 'x', 'nurse', 'Уволенная Мария', 'mid_low', 0, '', 'Санитарка', null, '2021-07-01', 0, '');
  ins.run(6, 'unk', 'x', 'cashier', 'Без Категории', '', 0, '', '', null, null, 1, '');
  return db;
}
const admin = { id: 1, role: 'admin' };
const adminDoctor = { id: 2, role: 'doctor', extra_roles: ['admin'] };
const nurse = { id: 4, role: 'nurse' };
const names = (r) => r.items.map((u) => u.full_name);

test('HR открыт только администратору — и основной, и дополнительной ролью', () => {
  const db = fresh();
  assert.throws(() => hrStaffList(db, {}, nurse), (e) => e.status === 403);
  assert.throws(() => hrStaffList(db, {}, null), (e) => e.status === 401);
  assert.throws(() => hrStaffCard(db, { user_id: 2 }, nurse), (e) => e.status === 403);
  assert.throws(() => hrAssetIssue(db, { user_id: 2, name: 'x' }, nurse), (e) => e.status === 403);
  assert.ok(hrStaffList(db, {}, admin).items.length);
  assert.ok(hrStaffList(db, {}, adminDoctor).items.length);
});

test('список: уволенные скрыты по умолчанию; категория врача выводится из is_doctor', () => {
  const db = fresh();
  const r = hrStaffList(db, {}, admin);
  assert.ok(!names(r).includes('Уволенная Мария'));
  assert.equal(r.items.find((u) => u.id === 3).category, 'doctor');
  assert.equal(r.items.find((u) => u.id === 6).category, '');
  assert.ok(names(hrStaffList(db, { inactive: true }, admin)).includes('Уволенная Мария'));
});

test('фильтры: категория, отдел, специальность, должность, даты приёма, поиск', () => {
  const db = fresh();
  assert.deepEqual(names(hrStaffList(db, { category: 'doctor' }, admin)).sort(), ['Врачев Иван', 'Старый Доктор']);
  assert.deepEqual(names(hrStaffList(db, { category: 'admin_staff' }, admin)), ['Администратор Главный']);
  assert.deepEqual(names(hrStaffList(db, { category: 'mid_low' }, admin)), ['Медсестра Анна']);
  assert.deepEqual(names(hrStaffList(db, { category: 'none' }, admin)), ['Без Категории']);
  assert.deepEqual(names(hrStaffList(db, { department_id: 92 }, admin)), ['Администратор Главный']);
  assert.deepEqual(names(hrStaffList(db, { specialty: 'Кардиолог' }, admin)), ['Врачев Иван']);
  assert.deepEqual(names(hrStaffList(db, { position: 'Медсестра' }, admin)), ['Медсестра Анна']);
  assert.deepEqual(names(hrStaffList(db, { hired_from: '2023-01-01' }, admin)).sort(), ['Врачев Иван', 'Медсестра Анна']);
  assert.deepEqual(names(hrStaffList(db, { hired_from: '2019-01-01', hired_to: '2020-12-31' }, admin)).sort(), ['Администратор Главный', 'Старый Доктор']);
  assert.deepEqual(names(hrStaffList(db, { q: 'врачев' }, admin)), ['Врачев Иван']);
  assert.deepEqual(names(hrStaffList(db, { q: '0000002' }, admin)), ['Врачев Иван']);
  assert.throws(() => hrStaffList(db, { category: 'boss' }, admin), (e) => e.status === 400);
  assert.throws(() => hrStaffList(db, { hired_from: '15.01.2020' }, admin), (e) => e.status === 400);
});

test('варианты фильтров берутся из данных', () => {
  const db = fresh();
  const { options } = hrStaffList(db, {}, admin);
  assert.deepEqual(options.departments.map((d) => d.name), ['Бухгалтерия', 'Кардиология']);
  assert.deepEqual(options.specialties, ['Кардиолог', 'Терапевт']);
  assert.ok(options.positions.includes('Директор'));
});

test('документы: путь только в папке этого сотрудника; «убрать» оставляет историю', () => {
  const db = fresh();
  const { id } = hrDocumentAdd(db, { user_id: 4, kind: 'passport', title: 'Паспорт', file_path: 'staff/4/1-a.pdf', file_name: 'a.pdf', file_size: 1200 }, admin);
  assert.throws(() => hrDocumentAdd(db, { user_id: 4, title: 'x', file_path: 'staff/2/1-a.pdf' }, admin), (e) => e.status === 400);
  assert.throws(() => hrDocumentAdd(db, { user_id: 4, title: 'x', file_path: 'staff/4/../2/a.pdf' }, admin), (e) => e.status === 400);
  assert.throws(() => hrDocumentAdd(db, { user_id: 4, title: 'x', file_path: 'patients/4/docs/a.pdf' }, admin), (e) => e.status === 400);
  assert.throws(() => hrDocumentAdd(db, { user_id: 4, title: 'x', kind: 'selfie', file_path: 'staff/4/b.pdf' }, admin), (e) => e.status === 400);
  assert.throws(() => hrDocumentAdd(db, { user_id: 999, title: 'x', file_path: 'staff/999/b.pdf' }, admin), (e) => e.status === 404);
  let card = hrStaffCard(db, { user_id: 4 }, admin);
  assert.equal(card.documents.length, 1);
  assert.equal(card.documents[0].uploaded_by_name, 'Администратор Главный');
  assert.equal(hrStaffList(db, {}, admin).items.find((u) => u.id === 4).documents, 1);
  assert.equal(hrDocumentRemove(db, { id }, admin).removed, true);
  assert.equal(hrDocumentRemove(db, { id }, admin).removed, false);
  card = hrStaffCard(db, { user_id: 4 }, admin);
  assert.equal(card.documents.length, 0);
  const row = db.prepare('SELECT removed_at, removed_by FROM hr_staff_documents WHERE id = ?').get(id);
  assert.ok(row.removed_at);
  assert.equal(row.removed_by, 1);
});

test('техника: выдача, возврат один раз, дата возврата не раньше выдачи', () => {
  const db = fresh();
  const { id } = hrAssetIssue(db, { user_id: 2, kind: 'laptop', name: 'Lenovo T14', serial_no: 'SN1', issued_on: '2026-11-01' }, admin);
  assert.throws(() => hrAssetIssue(db, { user_id: 2, kind: 'laptop', name: '  ' }, admin), (e) => e.status === 400);
  assert.throws(() => hrAssetIssue(db, { user_id: 2, kind: 'car', name: 'x' }, admin), (e) => e.status === 400);
  const phone = hrAssetIssue(db, { user_id: 2, kind: 'phone', name: 'iPhone' }, admin);   // дата по умолчанию — сегодня
  assert.ok(db.prepare('SELECT issued_on FROM hr_assets WHERE id = ?').get(phone.id).issued_on);
  assert.equal(hrStaffList(db, {}, admin).items.find((u) => u.id === 2).assets, 2);

  assert.throws(() => hrAssetReturn(db, { id, returned_on: '2026-10-01' }, admin), (e) => e.status === 400);
  assert.equal(hrAssetReturn(db, { id, returned_on: '2026-11-20', return_note: 'Царапина' }, admin).returned_on, '2026-11-20');
  assert.throws(() => hrAssetReturn(db, { id }, admin), (e) => e.status === 409);
  const card = hrStaffCard(db, { user_id: 2 }, admin);
  assert.equal(card.assets.length, 2, 'возвращённое остаётся в журнале');
  assert.equal(card.assets[0].returned_on, null, 'сначала то, что на руках');
  assert.equal(card.assets[1].return_note, 'Царапина');
  assert.equal(hrStaffList(db, {}, admin).items.find((u) => u.id === 2).assets, 1);
});

test('RPC зарегистрированы; читать список и карточку может и клиника с истёкшей лицензией', () => {
  for (const n of ['hr_staff_list', 'hr_staff_card', 'hr_document_add', 'hr_document_remove', 'hr_asset_issue', 'hr_asset_return']) {
    assert.equal(typeof getRpc(n), 'function', n);
  }
  assert.ok(isReadOnlyRpc('hr_staff_list'));
  assert.ok(isReadOnlyRpc('hr_staff_card'));
  assert.ok(!isReadOnlyRpc('hr_asset_issue'));
});
