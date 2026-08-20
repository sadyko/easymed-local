// QUEUE_ONE_DOCTOR_LINE_V1 — перенос уже выданных талонов в единую линию врача.
//
// Живой случай, который это чинит: у ЛОРа приём занимал номера 1..10, а его же
// «Кукушка» — отдельную линию 1..7. Два разных пациента ходили с талоном №7.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import fs from 'node:fs';

// Сегодняшний клинический день — миграция трогает только сегодня и будущее.
function today(db) { return db.prepare("SELECT date('now','localtime') d").get().d; }

function seeded() {
  const db = openDb(':memory:');
  migrate(db);
  const doc = db.prepare("INSERT INTO users (username, password_hash, full_name, role, is_doctor) VALUES ('lor','x','Набиев Ойбек','doctor',1)").run().lastInsertRowid;
  const cons = db.prepare("INSERT INTO services (name, price, type) VALUES ('Консультация ЛОРа',60000,'consultation')").run().lastInsertRowid;
  const proc = db.prepare("INSERT INTO services (name, price, type) VALUES ('Бурун чайиш',20000,'procedure')").run().lastInsertRowid;
  return { db, doc, cons, proc };
}

// Заводит пациента + визит + строку услуги с уже выданным талоном.
function ticket(db, { name, svc, doctor, key, no }) {
  const p = db.prepare('INSERT INTO patients (full_name) VALUES (?)').run(name).lastInsertRowid;
  const v = db.prepare("INSERT INTO visits (patient_id, visit_date) VALUES (?, ?)").run(p, '2026-01-01T09:00:00Z').lastInsertRowid;
  const id = db.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, queue_key, queue_no) VALUES (?,?,?,1,0,0,'queued',?,?)")
    .run(v, svc, doctor, key, no).lastInsertRowid;
  return { patient: p, visit: v, id };
}

function rekey(db) {
  // Повторный прогон миграции 067 поверх засеянных данных.
  const url = new URL('./067_queue_one_doctor_line.sql', import.meta.url);
  db.exec(fs.readFileSync(url, 'utf8'));
}

test('процедура врача переезжает в его линию и дописывается ПОСЛЕ приёмов', () => {
  const { db, doc, cons, proc } = seeded();
  const d = today(db);
  ticket(db, { name: 'Приём 1', svc: cons, doctor: doc, key: `doc:${doc}:${d}`, no: 1 });
  ticket(db, { name: 'Приём 2', svc: cons, doctor: doc, key: `doc:${doc}:${d}`, no: 2 });
  const moved = ticket(db, { name: 'Кукушка 1', svc: proc, doctor: doc, key: `proc:doc:${doc}:${d}`, no: 1 });
  const moved2 = ticket(db, { name: 'Кукушка 2', svc: proc, doctor: doc, key: `proc:doc:${doc}:${d}`, no: 2 });
  rekey(db);

  const row = (id) => db.prepare('SELECT queue_key, queue_no FROM visit_services WHERE id = ?').get(id);
  assert.equal(row(moved.id).queue_key, `doc:${doc}:${d}`, 'ключ — линия врача');
  assert.equal(row(moved.id).queue_no, 3, 'дописан после занятых 1 и 2');
  assert.equal(row(moved2.id).queue_no, 4, 'порядок между собой сохранён');

  // Главная проверка: одинаковых номеров у разных пациентов не осталось.
  const dups = db.prepare(`
    SELECT vs.queue_key, vs.queue_no FROM visit_services vs JOIN visits v ON v.id = vs.visit_id
     WHERE vs.queue_no IS NOT NULL
     GROUP BY vs.queue_key, vs.queue_no HAVING COUNT(DISTINCT v.patient_id) > 1`).all();
  assert.deepEqual(dups, [], 'ни одного номера на двоих');
});

test('пациент, уже стоящий в линии врача, второго номера не получает', () => {
  const { db, doc, cons, proc } = seeded();
  const d = today(db);
  const a = ticket(db, { name: 'Двойной', svc: cons, doctor: doc, key: `doc:${doc}:${d}`, no: 1 });
  // тому же пациенту завели процедуру у того же врача — отдельным талоном
  const b = db.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, queue_key, queue_no) VALUES (?,?,?,1,0,0,'queued',?,?)")
    .run(a.visit, proc, doc, `proc:doc:${doc}:${d}`, 1).lastInsertRowid;
  rekey(db);
  const row = db.prepare('SELECT queue_key, queue_no FROM visit_services WHERE id = ?').get(b);
  assert.equal(row.queue_key, `doc:${doc}:${d}`);
  assert.equal(row.queue_no, 1, 'в одну дверь человек стоит один раз');
});

test('прошлое не переписывается', () => {
  const { db, doc, proc } = seeded();
  const old = ticket(db, { name: 'Вчерашний', svc: proc, doctor: doc, key: 'proc:doc:' + doc + ':2020-01-01', no: 1 });
  rekey(db);
  const row = db.prepare('SELECT queue_key, queue_no FROM visit_services WHERE id = ?').get(old.id);
  assert.equal(row.queue_key, `proc:doc:${doc}:2020-01-01`, 'история остаётся историей');
  assert.equal(row.queue_no, 1);
});

test('процедура без врача (кабинет) не трогается', () => {
  const { db, proc } = seeded();
  const d = today(db);
  const p = db.prepare("INSERT INTO patients (full_name) VALUES ('Кабинет')").run().lastInsertRowid;
  const v = db.prepare("INSERT INTO visits (patient_id, visit_date) VALUES (?,?)").run(p, '2026-01-01T09:00:00Z').lastInsertRowid;
  const id = db.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, queue_key, queue_no) VALUES (?,?,NULL,1,0,0,'queued',?,1)")
    .run(v, proc, `proc:room:${d}`).lastInsertRowid;
  rekey(db);
  assert.equal(db.prepare('SELECT queue_key FROM visit_services WHERE id = ?').get(id).queue_key, `proc:room:${d}`);
});
