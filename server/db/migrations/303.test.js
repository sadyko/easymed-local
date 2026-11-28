// HR_RECRUIT_V1 — миграция 303: вакансии, кандидаты и журнал воронки найма.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (500, 'emp.t', 'x', 'Сотрудник', 'nurse'), (501, 'emp.u', 'x', 'Второй', 'nurse')").run();
  return db;
}

test('hr_vacancies: по умолчанию открыта на одно место; категория и состояние — из списка', () => {
  const db = fresh();
  db.prepare("INSERT INTO hr_vacancies (title) VALUES ('Медсестра')").run();
  const v = db.prepare('SELECT * FROM hr_vacancies').get();
  assert.equal(v.status, 'open');
  assert.equal(v.headcount, 1);
  assert.equal(v.staff_type, '');
  assert.throws(() => db.prepare("INSERT INTO hr_vacancies (title) VALUES ('  ')").run(), /CHECK/);
  assert.throws(() => db.prepare("INSERT INTO hr_vacancies (title, staff_type) VALUES ('x', 'boss')").run(), /CHECK/);
  assert.throws(() => db.prepare("INSERT INTO hr_vacancies (title, status) VALUES ('x', 'deleted')").run(), /CHECK/);
  assert.throws(() => db.prepare("INSERT INTO hr_vacancies (title, headcount) VALUES ('x', 0)").run(), /CHECK/);
});

test('hr_candidates: новый — в «Отклике»; этап и источник из списка; удалённая вакансия оставляет кандидата в резерве', () => {
  const db = fresh();
  const vid = db.prepare("INSERT INTO hr_vacancies (title) VALUES ('Кардиолог')").run().lastInsertRowid;
  db.prepare("INSERT INTO hr_candidates (vacancy_id, full_name) VALUES (?, 'Иванов')").run(vid);
  const c = db.prepare('SELECT * FROM hr_candidates').get();
  assert.equal(c.stage, 'new');
  assert.equal(c.source, 'other');
  assert.throws(() => db.prepare("INSERT INTO hr_candidates (full_name, stage) VALUES ('x', 'archived')").run(), /CHECK/);
  assert.throws(() => db.prepare("INSERT INTO hr_candidates (full_name, source) VALUES ('x', 'tiktok')").run(), /CHECK/);
  db.prepare('DELETE FROM hr_vacancies WHERE id = ?').run(vid);
  assert.equal(db.prepare('SELECT vacancy_id FROM hr_candidates WHERE id = ?').get(c.id).vacancy_id, null);
});

test('один сотрудник — из одного кандидата (частичный уникальный индекс), пустых привязок — сколько угодно', () => {
  const db = fresh();
  db.prepare("INSERT INTO hr_candidates (full_name, stage, employee_id) VALUES ('А', 'hired', 500)").run();
  db.prepare("INSERT INTO hr_candidates (full_name) VALUES ('Б'), ('В')").run();
  assert.throws(() => db.prepare("INSERT INTO hr_candidates (full_name, stage, employee_id) VALUES ('Г', 'hired', 500)").run(), /UNIQUE/);
  db.prepare("INSERT INTO hr_candidates (full_name, stage, employee_id) VALUES ('Д', 'hired', 501)").run();
});

test('журнал уходит вместе с кандидатом; удалённая учётка сотрудника не стирает кандидата', () => {
  const db = fresh();
  const id = db.prepare("INSERT INTO hr_candidates (full_name, stage, employee_id) VALUES ('А', 'hired', 500)").run().lastInsertRowid;
  db.prepare("INSERT INTO hr_candidate_events (candidate_id, from_stage, to_stage) VALUES (?, NULL, 'new')").run(id);
  db.prepare('DELETE FROM users WHERE id = 500').run();
  assert.equal(db.prepare('SELECT employee_id FROM hr_candidates WHERE id = ?').get(id).employee_id, null);
  db.prepare('DELETE FROM hr_candidates WHERE id = ?').run(id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM hr_candidate_events').get().n, 0);
});
