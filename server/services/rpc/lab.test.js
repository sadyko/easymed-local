// LAB_SAVE_BATCH_V1 — сохранение панели одним вызовом и одной транзакцией.
//
// Главное здесь не скорость, а целостность: половина сохранённого бланка
// выглядит как полный бланк, и отличить их потом нельзя.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { saveLabResults } from './lab.js';

const lab   = { id: 2, role: 'lab' };
const admin = { id: 1, role: 'admin' };
const nurse = { id: 3, role: 'nurse' };

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  const u = db.prepare('INSERT INTO users (id,username,password_hash,full_name,role) VALUES (?,?,?,?,?)');
  u.run(1, 'boss', 'x', 'Админ', 'admin');
  u.run(2, 'lab1', 'x', 'Лаборант', 'lab');
  u.run(3, 'nur', 'x', 'Медсестра', 'nurse');
  const p = db.prepare("INSERT INTO patients (full_name) VALUES ('Пациент')").run().lastInsertRowid;
  const v = db.prepare("INSERT INTO visits (patient_id, visit_date) VALUES (?, date('now'))").run(p).lastInsertRowid;
  const s = db.prepare("INSERT INTO services (name, price, is_lab) VALUES ('ОАК', 50000, 1)").run().lastInsertRowid;
  const vs = db.prepare("INSERT INTO visit_services (visit_id, service_id, status) VALUES (?,?,'in_progress')").run(v, s).lastInsertRowid;
  return { db, vs };
}

const row = (n, extra = {}) => ({ parameter: n, value: '1', flag: 'normal', ...extra });

test('вся панель сохраняется одним вызовом и переводит услугу в «resulted»', () => {
  const { db, vs } = seed();
  const rows = Array.from({ length: 28 }, (_, i) => row('Показатель ' + i));

  const res = saveLabResults(db, { visit_service_id: vs, rows, notes: 'Заключение' }, lab);

  assert.equal(res.inserted, 28);
  assert.equal(res.updated, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM lab_results WHERE visit_service_id=?').get(vs).c, 28);
  assert.equal(db.prepare('SELECT status FROM visit_services WHERE id=?').get(vs).status, 'resulted');
  // notes и entered_by проставляются всем строкам разом.
  assert.equal(db.prepare('SELECT COUNT(*) c FROM lab_results WHERE notes=? AND entered_by=2').get('Заключение').c, 28);
});

test('повторное сохранение правит те же строки, а не плодит дубли', () => {
  const { db, vs } = seed();
  saveLabResults(db, { visit_service_id: vs, rows: [row('HGB'), row('WBC')] }, lab);
  const saved = db.prepare('SELECT id, parameter FROM lab_results WHERE visit_service_id=? ORDER BY id').all(vs);

  const res = saveLabResults(db, {
    visit_service_id: vs,
    rows: [{ id: saved[0].id, parameter: 'HGB', value: '148', flag: 'high' },
           { id: saved[1].id, parameter: 'WBC', value: '6.8', flag: 'normal' }],
  }, lab);

  assert.equal(res.updated, 2);
  assert.equal(res.inserted, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM lab_results WHERE visit_service_id=?').get(vs).c, 2);
  assert.equal(db.prepare('SELECT value FROM lab_results WHERE id=?').get(saved[0].id).value, '148');
});

test('битая строка отменяет ВЕСЬ бланк, а не сохраняет половину', () => {
  const { db, vs } = seed();
  // Половина панели введена, в середине — показатель без названия.
  const rows = [row('HGB'), { parameter: '   ', value: '5' }, row('WBC')];

  assert.throws(() => saveLabResults(db, { visit_service_id: vs, rows }, lab), /пустое название/);

  // Ни одной строки и статус не тронут: половина бланка выглядит как целый,
  // и отличить их потом невозможно.
  assert.equal(db.prepare('SELECT COUNT(*) c FROM lab_results WHERE visit_service_id=?').get(vs).c, 0);
  assert.equal(db.prepare('SELECT status FROM visit_services WHERE id=?').get(vs).status, 'in_progress');
});

test('чужую строку результата переписать нельзя', () => {
  const { db, vs } = seed();
  // Второй заказ с собственным результатом.
  const v2 = db.prepare("INSERT INTO visits (patient_id, visit_date) VALUES (1, date('now'))").run().lastInsertRowid;
  const vs2 = db.prepare("INSERT INTO visit_services (visit_id, service_id, status) VALUES (?,1,'in_progress')").run(v2).lastInsertRowid;
  saveLabResults(db, { visit_service_id: vs2, rows: [row('Чужой', { value: 'оригинал' })] }, lab);
  const foreign = db.prepare('SELECT id FROM lab_results WHERE visit_service_id=?').get(vs2);

  // id приходит от клиента — подставляем чужой.
  saveLabResults(db, { visit_service_id: vs, rows: [{ id: foreign.id, parameter: 'Подмена', value: 'взломано', flag: 'normal' }] }, lab);

  assert.equal(db.prepare('SELECT value FROM lab_results WHERE id=?').get(foreign.id).value, 'оригинал',
    'результат другой услуги должен остаться нетронутым');
  // Значение не потерялось — оно записано новой строкой в СВОЮ услугу.
  assert.equal(db.prepare('SELECT COUNT(*) c FROM lab_results WHERE visit_service_id=?').get(vs).c, 1);
});

test('flag и notes нормализуются: NOT NULL не роняет сохранение', () => {
  const { db, vs } = seed();
  saveLabResults(db, { visit_service_id: vs, rows: [
    { parameter: 'X', value: '1' },                       // флага нет вовсе
    { parameter: 'Y', value: '2', flag: 'выдуманный' },   // флаг вне списка
  ] }, lab);

  const all = db.prepare('SELECT flag, notes FROM lab_results WHERE visit_service_id=? ORDER BY id').all(vs);
  assert.deepEqual(all.map((x) => x.flag), ['normal', 'normal']);
  assert.deepEqual(all.map((x) => x.notes), ['', '']);
});

test('сохранять результаты может только лаборатория или администратор', () => {
  const { db, vs } = seed();
  assert.throws(() => saveLabResults(db, { visit_service_id: vs, rows: [row('X')] }, nurse), (e) => e.status === 403);
  assert.throws(() => saveLabResults(db, { visit_service_id: vs, rows: [row('X')] }, null), (e) => e.status === 403);
  assert.ok(saveLabResults(db, { visit_service_id: vs, rows: [row('X')] }, admin).saved === 1);
});

test('пустой список и несуществующая услуга отклоняются', () => {
  const { db, vs } = seed();
  assert.throws(() => saveLabResults(db, { visit_service_id: vs, rows: [] }, lab), /Нет ни одного показателя/);
  assert.throws(() => saveLabResults(db, { visit_service_id: 999999, rows: [row('X')] }, lab), /не найдена/);
});
