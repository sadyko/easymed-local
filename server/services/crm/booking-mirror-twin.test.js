// CRM_UNIFY_V1 / PUBLIC_API_V1 — повторная проверка 8a, п. 4: ЗЕРКАЛО ЗАПИСИ НЕ
// ВВОЗИТ В ВИЗИТ ВТОРУЮ СТРОКУ ТОЙ ЖЕ УСЛУГИ.
//
// Две карточки одного пациента ждут одну и ту же консультацию в один день.
// Запись по второй (15:00) отменили, пациента записали на 10:00: связь визита с
// CRM берёт обе ждущие строки. Первая заводит в визит строку консультации, а
// вторая прежде ПЕРЕНОСИЛА из отменённого визита свою — две консультации в
// одном визите, двойной счёт. Теперь та же услуга в визите уже есть — строка
// второй карточки берёт её, а не ввозит вторую.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { ensureVisit } from '../rpc/visits.js';
import { calendarBook } from '../rpc/calendar.js';

const at = (day, hhmm) => { const [y, m, d] = day.split('-').map(Number); const [h, mi] = hhmm.split(':').map(Number); return new Date(y, m - 1, d, h, mi).getTime(); };
const CC = { id: 3, role: 'callcenter' };
const REG = { id: 2, role: 'registrar' };

function clinic() {
  const db = openDb(':memory:');
  migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (?, ?, ?, ?, ?, ?)');
  u.run(2, 'reg', 'x', 'Регистратор', 'registrar', 0);
  u.run(3, 'cc', 'x', 'Оператор', 'callcenter', 0);
  u.run(7, 'doc', 'x', 'Петров П.П.', 'doctor', 1);
  db.prepare("INSERT INTO consultation_types (id, name, price, active, duration_minutes) VALUES (1, 'Первичный приём', 150000, 1, 30)").run();
  db.prepare("INSERT INTO patients (id, mrn, full_name, phone) VALUES (1, 'P-1', 'Каримов Азиз', '+998901234567')").run();
  return db;
}
const lines = (db, visitId) => db.prepare("SELECT consultation_type_id, unit_price FROM visit_services WHERE visit_id = ? AND status <> 'cancelled'")
  .all(visitId).map((x) => ({ ...x }));

test('две карточки ждут ту же консультацию в один день; запись по второй отменили, пациента записали снова — в визите одна консультация', async () => {
  const db = clinic();
  // Первая карточка (раньше): сайт, другой номер — номер её с картой не свяжет.
  const first = Number(db.prepare("INSERT INTO crm_requests (full_name, phone, source, status, scheduled_date) VALUES ('Каримов Азиз', '+998935550000', 'website', 'in_process', '2030-03-12')").run().lastInsertRowid);
  db.prepare("INSERT INTO crm_request_services (request_id, consultation_type_id, doctor_id, scheduled_date, status) VALUES (?, 1, 7, '2030-03-12', 'pending')").run(first);
  // Вторая (позже): звонок, карта пациента выбрана; запись на 15:00.
  const second = Number(db.prepare("INSERT INTO crm_requests (full_name, phone, source, status, patient_id, scheduled_date) VALUES ('Каримов Азиз', '+998901234567', 'call', 'in_process', 1, '2030-03-12')").run().lastInsertRowid);
  db.prepare("INSERT INTO crm_request_services (request_id, consultation_type_id, doctor_id, scheduled_date, status) VALUES (?, 1, 7, '2030-03-12', 'pending')").run(second);
  const ph = await ensureVisit(db, { patient_id: 1, date: new Date(at('2030-03-12', '15:00')).toISOString(), doctor_id: 7,
    book: { doctor_id: 7, start: new Date(at('2030-03-12', '15:00')).toISOString(), duration_minutes: 30 } }, CC);
  assert.equal(lines(db, ph.visit.id).length, 1);
  // Запись на 15:00 отменили; первая карточка получила карту пациента.
  await calendarBook(db, { visit_id: ph.visit.id, start: new Date(at('2030-03-12', '15:00')).toISOString(), status: 'cancelled' }, REG);
  db.prepare('UPDATE crm_requests SET patient_id = 1 WHERE id = ?').run(first);
  const v = await ensureVisit(db, { patient_id: 1, date: new Date(at('2030-03-12', '10:00')).toISOString(), doctor_id: 7,
    book: { doctor_id: 7, start: new Date(at('2030-03-12', '10:00')).toISOString(), duration_minutes: 30 } }, REG);
  assert.deepEqual(lines(db, v.visit.id), [{ consultation_type_id: 1, unit_price: 150000 }], 'одна консультация, а не две');
});
