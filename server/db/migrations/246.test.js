// CRM_LINK_ALL_V1 (мигр. 246, повторное ревью приватности PRIV-3) — только CREATE TRIGGER:
// смена пациента карточки снимает её привязки «только для воронки» ('patient', 'phone') к
// визитам другого пациента. Привязки колл-центра и шага C, привязки к визитам нового
// пациента и правка карточки без смены пациента — не трогаются; объединение пациентов
// (визиты переезжают раньше карточек) привязок не теряет.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (2, 'reg', 'x', 'Регистратура', 'registrar')").run();
  for (const id of [77, 78]) db.prepare('INSERT INTO patients (id, full_name, phone) VALUES (?, ?, ?)').run(id, 'Пациент ' + id, '+99890000' + id);
  return db;
}
const visit = (db, pid) => Number(db.prepare("INSERT INTO visits (patient_id, visit_date, status, created_by) VALUES (?, '2026-11-01T10:00:00Z', 'scheduled', 2)").run(pid).lastInsertRowid);
const card = (db, pid) => Number(db.prepare("INSERT INTO crm_requests (full_name, phone, status, patient_id) VALUES ('Лид', '+998900000077', 'in_process', ?)").run(pid).lastInsertRowid);
const linkTo = (db, vid, rid, source) => db.prepare('INSERT INTO crm_booking_links (visit_id, request_id, source) VALUES (?, ?, ?)').run(vid, rid, source);
const linksOf = (db, rid) => db.prepare('SELECT visit_id, source FROM crm_booking_links WHERE request_id = ? ORDER BY visit_id').all(rid).map((r) => [r.visit_id, r.source]);

test('мигр. 246: смена пациента карточки снимает привязки для воронки к визитам другого пациента, остальное — нет', () => {
  const db = fresh();
  const rid = card(db, 77);
  const a = visit(db, 77); const b = visit(db, 77); const c = visit(db, 77); const d = visit(db, 78);
  linkTo(db, a, rid, 'patient'); linkTo(db, b, rid, 'phone'); linkTo(db, c, rid, 'callcenter'); linkTo(db, d, rid, 'patient');
  db.prepare("UPDATE crm_requests SET note = 'перезвонить' WHERE id = ?").run(rid);
  assert.equal(linksOf(db, rid).length, 4, 'правка без смены пациента сняла привязки');
  db.prepare('UPDATE crm_requests SET patient_id = 77 WHERE id = ?').run(rid);
  assert.equal(linksOf(db, rid).length, 4, 'тот же пациент — привязки сняты');
  db.prepare('UPDATE crm_requests SET patient_id = 78 WHERE id = ?').run(rid);
  assert.deepEqual(linksOf(db, rid), [[c, 'callcenter'], [d, 'patient']]);
  db.prepare('UPDATE crm_requests SET patient_id = NULL WHERE id = ?').run(rid);
  assert.deepEqual(linksOf(db, rid), [[c, 'callcenter']], 'у карточки без пациента осталась привязка для воронки');
});

test('мигр. 246: объединение пациентов (визиты, потом карточки) привязок не теряет; чужие карточки не трогаются', () => {
  const db = fresh();
  const rid = card(db, 78);
  const other = card(db, 77);
  const v = visit(db, 78);
  const w = visit(db, 77);
  linkTo(db, v, rid, 'patient');
  linkTo(db, w, other, 'phone');
  db.prepare('UPDATE visits SET patient_id = 77 WHERE patient_id = 78').run();
  db.prepare('UPDATE crm_requests SET patient_id = 77 WHERE patient_id = 78').run();
  assert.deepEqual(linksOf(db, rid), [[v, 'patient']]);
  assert.deepEqual(linksOf(db, other), [[w, 'phone']]);
});
