// CUSTDEV_V1 — что видит доска и что считает отчёт.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { listCards, reportFor } from './board.js';

const dayOffset = (db, n) => db.prepare("SELECT date('now','localtime',? || ' days') d").get(String(n)).d;

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, full_name, role) VALUES (?,?,?,?,?)');
  u.run(10, 'reg', 'x', 'Регистратор Р.', 'registrar');
  u.run(11, 'cash', 'x', 'Кассир К.', 'cashier');
  u.run(12, 'doc', 'x', 'Врач В.', 'doctor');
  db.prepare("INSERT INTO patients (id, full_name, mrn, phone) VALUES (1, 'Иванов И.', 'MRN-1', '+998900000000')").run();
  return db;
}

// Карточка прямо в таблицу: board.js читает, а не создаёт.
function card(db, { id, day, status = 'new', reg = 'unrated', cash = 'unrated', doc = 'unrated' }) {
  db.prepare('INSERT INTO visits (id, patient_id, visit_date, status) VALUES (?,1,?,?)')
    .run(id, day + 'T09:00:00Z', 'arrived');
  db.prepare(`INSERT INTO custdev_cards
                (visit_id, patient_id, visit_date, paid_amount, registrar_id, cashier_id, doctor_id,
                 score_registrar, score_cashier, score_doctor, status)
              VALUES (?,1,?,50000,10,11,12,?,?,?,?)`)
    .run(id, day + 'T09:00:00Z', reg, cash, doc, status);
}

test('доска отдаёт карточку вместе с ЖИВЫМИ данными пациента и именами сотрудников', () => {
  const db = fresh();
  card(db, { id: 1, day: dayOffset(db, -1) });

  const rows = listCards(db, { from: dayOffset(db, -30), to: dayOffset(db, 0) });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].patient_name, 'Иванов И.');
  assert.equal(rows[0].mrn, 'MRN-1');
  assert.equal(rows[0].phone, '+998900000000');
  assert.equal(rows[0].registrar_name, 'Регистратор Р.');
  assert.equal(rows[0].cashier_name, 'Кассир К.');
  assert.equal(rows[0].doctor_name, 'Врач В.');
});

test('исправленный телефон подхватывается — он не снимок', () => {
  const db = fresh();
  card(db, { id: 1, day: dayOffset(db, -1) });
  db.prepare("UPDATE patients SET phone = '+998911111111' WHERE id = 1").run();
  const rows = listCards(db, { from: dayOffset(db, -30), to: dayOffset(db, 0) });
  assert.equal(rows[0].phone, '+998911111111', 'звонить надо по новому номеру');
});

test('период режет по дате визита', () => {
  const db = fresh();
  card(db, { id: 1, day: dayOffset(db, -1) });
  card(db, { id: 2, day: dayOffset(db, -40) });
  const rows = listCards(db, { from: dayOffset(db, -7), to: dayOffset(db, 0) });
  assert.deepEqual(rows.map((r) => r.visit_id), [1]);
});

test('отчёт считает воронку и долю обзвона', () => {
  const db = fresh();
  const d = dayOffset(db, -1);
  card(db, { id: 1, day: d, status: 'satisfied',   reg: 'good', cash: 'good', doc: 'good' });
  card(db, { id: 2, day: d, status: 'partial',     reg: 'good', cash: 'good', doc: 'bad'  });
  card(db, { id: 3, day: d, status: 'unsatisfied', reg: 'bad',  cash: 'bad',  doc: 'good' });
  card(db, { id: 4, day: d, status: 'unreachable' });
  card(db, { id: 5, day: d });   // не обзвонён

  const rep = reportFor(db, { from: dayOffset(db, -30), to: dayOffset(db, 0) });
  assert.equal(rep.total, 5);
  assert.equal(rep.satisfied, 1);
  assert.equal(rep.partial, 1);
  assert.equal(rep.unsatisfied, 1);
  assert.equal(rep.unreachable, 1);
  // Обзвонено = всё, кроме «Не обзвонён»; недозвон — тоже попытка.
  assert.equal(rep.called, 4);
});

test('в разрезе по сотруднику «Не применимо» и «Не оценено» не считаются', () => {
  const db = fresh();
  const d = dayOffset(db, -1);
  card(db, { id: 1, day: d, status: 'satisfied', reg: 'good', cash: 'good', doc: 'good' });
  card(db, { id: 2, day: d, status: 'partial',   reg: 'good', cash: 'good', doc: 'bad'  });
  card(db, { id: 3, day: d, status: 'satisfied', reg: 'good', cash: 'good', doc: 'na'   });
  card(db, { id: 4, day: d });   // ничего не оценено

  const rep = reportFor(db, { from: dayOffset(db, -30), to: dayOffset(db, 0) });
  const doc = rep.byDoctor.find((r) => r.id === 12);
  assert.equal(doc.good, 1);
  assert.equal(doc.bad, 1);
  assert.equal(doc.pct, 50, 'na и unrated не входят ни в числитель, ни в знаменатель');

  const reg = rep.byRegistrar.find((r) => r.id === 10);
  assert.equal(reg.good, 3);
  assert.equal(reg.bad, 0);
  assert.equal(reg.pct, 100);
});

test('пустой период не делит на ноль', () => {
  const db = fresh();
  const rep = reportFor(db, { from: dayOffset(db, -30), to: dayOffset(db, 0) });
  assert.equal(rep.total, 0);
  assert.equal(rep.calledPct, 0);
  assert.deepEqual(rep.byDoctor, []);
});
