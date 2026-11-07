// DIAG_ROUTE_V1 (3.22.0, ревью L-4) — календарь «Добавить» (booking_lines_add): исполнитель строки
// записи — тот же круг, что у записи (doctor-pool.js): врач (is_doctor или роль «Врач») ИЛИ
// сотрудник, которому эта услуга отмечена в «Услугах и ставках». Прежде сервер принимал только
// врача, и ЭКГ группы «Диагностика», отмеченное одной медсестре, календарь отдавал какому-нибудь
// врачу — строка уходила не в тот кабинет (класс #4 расследования).
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { bookingLinesAdd } from './booking-lines.js';

process.env.TZ = 'Asia/Tashkent';
const REG = { id: 5, role: 'registrar' };

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, service_rates, is_active) VALUES (?,?,?,?,?,?,?,?)');
  u.run(5, 'reg', 'x', 'Регистратура', 'registrar', 0, '', 1);
  u.run(10, 'doc', 'x', 'Врач', 'doctor', 1, '', 1);
  u.run(11, 'admdoc', 'x', 'Админ-врач', 'admin', 1, '', 1);
  u.run(20, 'ecg', 'x', 'Медсестра ЭКГ', 'nurse', 0, JSON.stringify([{ service_id: 30, pct: 10 }]), 1);
  u.run(21, 'nurse', 'x', 'Медсестра', 'nurse', 0, '', 1);
  u.run(22, 'gone', 'x', 'Уволенная ЭКГ', 'nurse', 0, JSON.stringify([{ service_id: 30, pct: 10 }]), 0);
  u.run(23, 'cash', 'x', 'Кассир', 'cashier', 0, JSON.stringify([{ service_id: 31, pct: 5 }]), 1);
  db.prepare("INSERT INTO patients (id, mrn, full_name) VALUES (1, 'P-1', 'Пациент')").run();
  db.prepare("INSERT INTO services (id, name, price, type) VALUES (30, 'ЭКГ', 50000, 'imaging')").run();
  db.prepare("INSERT INTO services (id, name, price, type) VALUES (31, 'УЗИ', 90000, 'imaging')").run();
  const later = new Date(Date.now() + 3 * 3600000).toISOString();
  db.prepare("INSERT INTO visits (id, patient_id, doctor_id, visit_date, status) VALUES (1, 1, 10, ?, 'scheduled')").run(later);
  return db;
}
const add = (db, line) => bookingLinesAdd(db, { visit_id: 1, lines: [line] }, REG);
const perf = (db, svc) => db.prepare('SELECT doctor_id FROM visit_services WHERE visit_id = 1 AND service_id = ?').get(svc).doctor_id;

test('ревью L-4: медсестра, отмеченная услуге, — исполнитель строки записи', () => {
  const db = seed();
  add(db, { service_id: 30, doctor_id: 20 });
  assert.equal(perf(db, 30), 20);
});

test('ревью L-4: врач (по флагу и по роли) — как прежде', () => {
  const db = seed();
  add(db, { service_id: 30, doctor_id: 10 });
  add(db, { service_id: 31, doctor_id: 11 });
  assert.equal(perf(db, 30), 10);
  assert.equal(perf(db, 31), 11);
});

test('ревью L-4: не отмеченная медсестра, уволенная и не та услуга — отказ словами', () => {
  const db = seed();
  for (const [svc, who] of [[30, 21], [30, 22], [31, 20]]) {
    assert.throws(() => add(db, { service_id: svc, doctor_id: who }),
      (e) => e.status === 400 && /не отмечен на эту услугу/.test(e.message), svc + '/' + who);
  }
  // кассир с отметкой услуги — тоже исполнитель по отметке (тот же круг, что у мастера записи)
  add(db, { service_id: 31, doctor_id: 23 });
  assert.equal(perf(db, 31), 23);
});
