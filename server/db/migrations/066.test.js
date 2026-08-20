// QUEUE_IMG_DOCTOR_V1 (mig 066) — перенос уже выданных талонов диагностики
// с «очереди аппарата» на «очередь врача».
//
// Миграция уже отработала к моменту теста (migrate() накатывает всё), поэтому
// проверяем её ТЕКСТОМ: заводим строки в старом виде и выполняем тот же SQL
// ещё раз. Это заодно проверяет, что миграция повторяема — она отбирает только
// ключи без 'img:doc:', так что второй прогон уже перенесённое не трогает.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SQL = fs.readFileSync(path.join(HERE, '066_queue_imaging_by_doctor.sql'), 'utf8');

function freshDb() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_active, is_doctor) VALUES (2,'d1','x','Др. Азиза','doctor',1,1)").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_active, is_doctor) VALUES (3,'d2','x','Др. Борис','doctor',1,1)").run();
  db.prepare("INSERT INTO services (id, name, price, type) VALUES (5,'Рентген',80000,'imaging')").run();
  db.prepare("INSERT INTO services (id, name, price, type) VALUES (6,'УЗИ',90000,'imaging')").run();
  db.prepare("INSERT INTO services (id, name, price, type) VALUES (7,'МРТ',95000,'imaging')").run();
  for (let i = 1; i <= 4; i++) db.prepare('INSERT INTO patients (id, full_name) VALUES (?,?)').run(i, 'П' + i);
  return db;
}

const today = (db) => db.prepare("SELECT date('now','localtime') d").get().d;
const shift = (db, days) => db.prepare("SELECT date('now','localtime',?) d").get(days + ' days').d;

// Строка «как раньше»: ключ по услуге, номер уже выдан.
function oldLine(db, { patient, svc, doctor, day, no }) {
  const visit = db.prepare('INSERT INTO visits (patient_id, visit_date, status) VALUES (?,?,?) RETURNING id')
    .get(patient, day + 'T09:00:00Z', 'scheduled').id;
  return db.prepare(
    `INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, queue_key, queue_no)
     VALUES (?,?,?,1,0,0,'queued',?,?) RETURNING id`)
    .get(visit, svc, doctor, `img:${svc}:${day}`, no).id;
}
const keyOf = (db, id) => db.prepare('SELECT queue_key, queue_no FROM visit_services WHERE id=?').get(id);

test('066 сводит сегодняшние линии одного врача в одну очередь', () => {
  const db = freshDb();
  const d = today(db);
  // Один врач, три разные услуги — три «очереди», в каждой свой №1.
  const a = oldLine(db, { patient: 1, svc: 5, doctor: 2, day: d, no: 1 });
  const b = oldLine(db, { patient: 2, svc: 6, doctor: 2, day: d, no: 1 });
  const c = oldLine(db, { patient: 3, svc: 7, doctor: 2, day: d, no: 1 });

  db.exec(SQL);

  for (const id of [a, b, c]) {
    assert.equal(keyOf(db, id).queue_key, `img:doc:2:${d}`, 'все три — одна линия врача');
  }
  const nos = [a, b, c].map((id) => keyOf(db, id).queue_no).sort();
  assert.deepEqual(nos, [1, 2, 3], 'номера пересчитаны сквозной очередью, без дублей');
  db.close();
});

test('066 сохраняет порядок записи: кто раньше завёлся, тот раньше в очереди', () => {
  const db = freshDb();
  const d = today(db);
  const first  = oldLine(db, { patient: 1, svc: 5, doctor: 2, day: d, no: 1 });
  const second = oldLine(db, { patient: 2, svc: 6, doctor: 2, day: d, no: 1 });
  const third  = oldLine(db, { patient: 3, svc: 7, doctor: 2, day: d, no: 1 });

  db.exec(SQL);

  assert.equal(keyOf(db, first).queue_no, 1);
  assert.equal(keyOf(db, second).queue_no, 2);
  assert.equal(keyOf(db, third).queue_no, 3);
  db.close();
});

test('066 даёт пациенту с двумя исследованиями ОДИН номер', () => {
  const db = freshDb();
  const d = today(db);
  // Одному пациенту завели два исследования у одного врача — в старой схеме это
  // были два разных номера в двух разных линиях.
  const visit = db.prepare('INSERT INTO visits (patient_id, visit_date, status) VALUES (1,?,?) RETURNING id')
    .get(d + 'T09:00:00Z', 'scheduled').id;
  const mk = (svc, no) => db.prepare(
    `INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, queue_key, queue_no)
     VALUES (?,?,2,1,0,0,'queued',?,?) RETURNING id`).get(visit, svc, `img:${svc}:${d}`, no).id;
  const x = mk(5, 1);
  const y = mk(6, 1);
  const other = oldLine(db, { patient: 2, svc: 7, doctor: 2, day: d, no: 1 });

  db.exec(SQL);

  assert.equal(keyOf(db, x).queue_no, 1);
  assert.equal(keyOf(db, y).queue_no, 1, 'в одну дверь человек стоит один раз');
  assert.equal(keyOf(db, other).queue_no, 2, 'следующий пациент — №2, а не №3');
  db.close();
});

test('066 не трогает прошлое', () => {
  const db = freshDb();
  const past = shift(db, -3);
  const old = oldLine(db, { patient: 1, svc: 5, doctor: 2, day: past, no: 7 });

  db.exec(SQL);

  const row = keyOf(db, old);
  assert.equal(row.queue_key, `img:5:${past}`, 'завершённые визиты остаются как были');
  assert.equal(row.queue_no, 7);
  db.close();
});

test('066 переносит и будущие записи', () => {
  const db = freshDb();
  const soon = shift(db, 3);
  const a = oldLine(db, { patient: 1, svc: 5, doctor: 2, day: soon, no: 1 });
  const b = oldLine(db, { patient: 2, svc: 6, doctor: 2, day: soon, no: 1 });

  db.exec(SQL);

  assert.equal(keyOf(db, a).queue_key, `img:doc:2:${soon}`);
  assert.equal(keyOf(db, b).queue_no, 2, 'приём ещё не состоялся — переномеровать безопасно');
  db.close();
});

test('066 не трогает аппарат без врача', () => {
  const db = freshDb();
  const d = today(db);
  const xr = oldLine(db, { patient: 1, svc: 5, doctor: null, day: d, no: 4 });

  db.exec(SQL);

  const row = keyOf(db, xr);
  assert.equal(row.queue_key, `img:5:${d}`, 'рентген без врача остаётся очередью аппарата');
  assert.equal(row.queue_no, 4);
  db.close();
});

test('066 разводит разных врачей по разным линиям', () => {
  const db = freshDb();
  const d = today(db);
  const a = oldLine(db, { patient: 1, svc: 6, doctor: 2, day: d, no: 1 });
  const b = oldLine(db, { patient: 2, svc: 6, doctor: 3, day: d, no: 2 });

  db.exec(SQL);

  assert.equal(keyOf(db, a).queue_key, `img:doc:2:${d}`);
  assert.equal(keyOf(db, b).queue_key, `img:doc:3:${d}`);
  assert.equal(keyOf(db, a).queue_no, 1);
  assert.equal(keyOf(db, b).queue_no, 1, 'у каждого врача своя нумерация с №1');
  db.close();
});

test('066 повторяема — второй прогон ничего не меняет', () => {
  const db = freshDb();
  const d = today(db);
  const a = oldLine(db, { patient: 1, svc: 5, doctor: 2, day: d, no: 1 });
  const b = oldLine(db, { patient: 2, svc: 6, doctor: 2, day: d, no: 1 });

  db.exec(SQL);
  const after = [keyOf(db, a), keyOf(db, b)];
  db.exec(SQL);
  assert.deepEqual([keyOf(db, a), keyOf(db, b)], after);
  db.close();
});
