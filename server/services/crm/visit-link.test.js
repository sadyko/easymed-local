// CRM_UNIFY_V1 — шаг связи визита с CRM как функция: то, что двери не покажут.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { crmLinkVisit, patientIdsWithPhoneKey } from './visit-link.js';

const REG = { id: 1, role: 'registrar', extra_roles: [] };
function freshDb() {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (1,'reg','x','Рег','registrar')").run();
  db.prepare("INSERT INTO patients (id, full_name, phone) VALUES (77,'Пациент','+998 90 909 26 38')").run();
  return db;
}
const addVisit = (db, { day = '2026-12-01', origin = null } = {}) =>
  Number(db.prepare("INSERT INTO visits (patient_id, visit_date, status, sync_origin) VALUES (77, ?, 'scheduled', ?)").run(day + 'T05:00:00Z', origin).lastInsertRowid);
const addReq = (db, status = 'in_process') =>
  Number(db.prepare("INSERT INTO crm_requests (full_name, phone, status, patient_id) VALUES ('Лид','x',?,77)").run(status).lastInsertRowid);

test('визит, приехавший из другого здания, шаг не трогает: связь — в здании записи', () => {
  const db = freshDb();
  const rid = addReq(db);
  crmLinkVisit(db, addVisit(db, { origin: 'B' }), REG);
  assert.equal(db.prepare('SELECT status FROM crm_requests WHERE id = ?').get(rid).status, 'in_process');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM crm_booking_links').get().n, 0);
  db.close();
});

test('шаг не бросается: мусор, несуществующий визит, пустая воронка', () => {
  const db = freshDb();
  assert.doesNotThrow(() => crmLinkVisit(db, 'x', REG));
  assert.doesNotThrow(() => crmLinkVisit(db, 999, REG));
  db.pragma('foreign_keys = OFF');
  db.prepare('DELETE FROM crm_stages').run();
  assert.doesNotThrow(() => crmLinkVisit(db, addVisit(db), REG));
  db.close();
});

test('номер короче 7 цифр — не личность: совпадений нет', () => {
  const db = freshDb();
  assert.deepEqual(patientIdsWithPhoneKey(db, '638'), []);
  assert.deepEqual(patientIdsWithPhoneKey(db, '909092638'), [77]);
  db.close();
});

// CRM_UNIFY_V1 (ревью задачи 1) — владельцы номера считаются С ЗАПАСОМ: карта,
// в поле которой номер лежит вторым («…, +998 90 909 26 38») или вторым номером
// карты, — тоже владелец. Лишний владелец только делает совпадение реже.
test('владельцы номера: два номера в одном поле и второй номер карты считаются', () => {
  const db = freshDb();
  db.prepare("INSERT INTO patients (id, full_name, phone) VALUES (78,'Брат','+998 91 111 11 11, +998 90 909 26 38')").run();
  db.prepare("INSERT INTO patients (id, full_name, phone, phone_secondary) VALUES (79,'Мама','+998 91 000 00 00','0909092638')").run();
  db.prepare("INSERT INTO patients (id, full_name, phone) VALUES (80,'Чужой','+998 90 909 26 39')").run();
  assert.deepEqual(patientIdsWithPhoneKey(db, '909092638').sort(), [77, 78, 79]);
  db.close();
});

test('отменённый и неявочный визит шаг не трогает: строки дня ждут живой записи', () => {
  const db = freshDb();
  for (const status of ['cancelled', 'no_show']) {
    const rid = addReq(db);
    db.prepare("INSERT INTO crm_request_services (request_id, service_id, scheduled_date, status) VALUES (?, NULL, '2026-12-01', 'pending')").run(rid);
    const vid = addVisit(db);
    db.prepare('UPDATE visits SET status = ? WHERE id = ?').run(status, vid);
    crmLinkVisit(db, vid, REG, { undated: true });
    assert.equal(db.prepare('SELECT COUNT(*) n FROM crm_request_services WHERE visit_id = ?').get(vid).n, 0, status);
    assert.equal(db.prepare('SELECT status FROM crm_requests WHERE id = ?').get(rid).status, 'in_process', status);
  }
  db.close();
});
