// V3120_FIX (M1) — ПОВТОРНАЯ ОТМЕНА ГОСПИТАЛИЗАЦИИ — ЧИСТЫЙ НОЛЬ.
//
// Инспекция: admission_order_cancel по уже отменённой заявке проходил
// идемпотентный возврат admissionTransition РАНЬШЕ проверки роли, а
// admissionOrderCancel после него всё равно писал: койку прежней
// госпитализации — в «уборку» (хотя на ней уже мог лежать другой пациент),
// строку «отмена» в журнал переводов и снятие невыставленных строк. И делал
// это кто угодно — кассир, лаборант.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { admissionOrderCreate, admissionOrderCancel, admissionAdmit } from './inpatient.js';

const registrar = { id: 2, role: 'registrar' };
const nurse = { id: 3, role: 'nurse' };
const cashier = { id: 5, role: 'cashier' };

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  for (const [id, username, role] of [[2, 'reg1', 'registrar'], [3, 'nurse1', 'nurse'], [5, 'cash1', 'cashier']]) {
    db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?,?,?,?)').run(id, username, 'x', role);
  }
  const p1 = db.prepare("INSERT INTO patients (full_name) VALUES ('Иванов Иван')").run().lastInsertRowid;
  const p2 = db.prepare("INSERT INTO patients (full_name) VALUES ('Петров Пётр')").run().lastInsertRowid;
  const ward = db.prepare("INSERT INTO wards (name) VALUES ('Терапия')").run().lastInsertRowid;
  const bed = db.prepare("INSERT INTO beds (code, ward_id, status) VALUES ('A-1', ?, 'free')").run(ward).lastInsertRowid;
  return { db, p1, p2, bed };
}

test('повторная отмена чужой ролью — 403, ничего не пишется', () => {
  const { db, p1, bed } = seed();
  const order = admissionOrderCreate(db, { patient_id: p1 }, registrar).admission;
  admissionAdmit(db, { admission_id: order.id, bed_id: bed }, nurse);
  admissionOrderCancel(db, { admission_id: order.id, reason: 'ошибка' }, registrar);
  const transfers = db.prepare('SELECT COUNT(*) n FROM admission_transfers WHERE admission_id = ?').get(order.id).n;
  assert.throws(() => admissionOrderCancel(db, { admission_id: order.id, reason: 'ещё раз' }, cashier),
    (e) => e.status === 403);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM admission_transfers WHERE admission_id = ?').get(order.id).n, transfers);
});

test('повторная отмена законной ролью не трогает койку, занятую уже другим пациентом', () => {
  const { db, p1, p2, bed } = seed();
  const first = admissionOrderCreate(db, { patient_id: p1 }, registrar).admission;
  admissionAdmit(db, { admission_id: first.id, bed_id: bed }, nurse);
  admissionOrderCancel(db, { admission_id: first.id, reason: 'ошибка' }, registrar);
  // Койку убрали и положили на неё другого.
  db.prepare("UPDATE beds SET status = 'free' WHERE id = ?").run(bed);
  const second = admissionOrderCreate(db, { patient_id: p2 }, registrar).admission;
  admissionAdmit(db, { admission_id: second.id, bed_id: bed }, nurse);
  assert.equal(db.prepare('SELECT status FROM beds WHERE id = ?').get(bed).status, 'occupied');
  const transfers = db.prepare('SELECT COUNT(*) n FROM admission_transfers').get().n;

  const res = admissionOrderCancel(db, { admission_id: first.id, reason: 'двойной клик' }, registrar);
  assert.equal(res.admission.status, 'cancelled');
  assert.equal(db.prepare('SELECT status FROM beds WHERE id = ?').get(bed).status, 'occupied', 'чужая койка не уходит в уборку');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM admission_transfers').get().n, transfers, 'фальшивой строки «отмена» нет');
  assert.equal(db.prepare('SELECT cancel_reason FROM admissions WHERE id = ?').get(first.id).cancel_reason, 'ошибка', 'причина первой отмены не переписана');
});
