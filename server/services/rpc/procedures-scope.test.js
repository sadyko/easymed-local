// PROC_SCOPE_V1 (3.22.0, решение владельца 2026-11-07, п. 12) — «каждая медсестра и врач видят
// только назначенные им процедуры; ничьи видны всему процедурному персоналу (их берут);
// администратор и старшая медсестра видят всё».
//
// Что закреплено:
//   • старшая медсестра (надстройка senior_nurse) видит очередь целиком, как администратор;
//   • правило «своё + ничьё» стоит в SQL ДО предела: 300 чужих свежих строк не вытесняют
//     свою старую (прежде фильтр шёл в JS после LIMIT — медсестра видела пустую очередь);
//   • администратор и старшая медсестра фильтруют очередь по исполнителю (performer_id —
//     сотрудник, 'none' — не назначен), и сервер отдаёт им список исполнителей для фильтра;
//   • фильтр исполнителя медсестре чужую очередь не открывает — его сервер у неё не читает.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { proceduresList, scopeOf } from './procedures.js';

const ACTOR = {
  admin:   { id: 9, role: 'admin' },
  nurse:   { id: 2, role: 'nurse' },
  nurse2:  { id: 3, role: 'nurse' },
  head:    { id: 7, role: 'nurse', extra_roles: ['senior_nurse'] },
  doctor:  { id: 1, role: 'doctor', is_doctor: true },
  headDoc: { id: 8, role: 'doctor', extra_roles: ['head_doctor'], is_doctor: true },
};

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, extra_roles, is_active) VALUES (?,?,?,?,?,?,?,?)');
  u.run(1, 'doc', 'x', 'Иванов И.И.', 'doctor', 1, '', 1);
  u.run(2, 'nur', 'x', 'Сестрина А.А.', 'nurse', 0, '', 1);
  u.run(3, 'nur2', 'x', 'Петрова В.В.', 'nurse', 0, '', 1);
  u.run(4, 'reg', 'x', 'Регистратура', 'registrar', 0, '', 1);
  u.run(5, 'old', 'x', 'Уволенная Н.Н.', 'nurse', 0, '', 0);
  u.run(7, 'head', 'x', 'Старшая С.С.', 'nurse', 0, '["senior_nurse"]', 1);
  u.run(8, 'hd', 'x', 'Главный Г.Г.', 'doctor', 1, '["head_doctor"]', 1);
  u.run(9, 'adm', 'x', 'Администратор', 'admin', 0, '', 1);
  db.prepare("INSERT INTO patients (id, mrn, full_name) VALUES (1,'P-1','Пациент Один')").run();
  db.prepare("INSERT INTO departments (id, name, kind) VALUES (90,'Процедурный','procedure')").run();
  db.prepare("INSERT INTO services (id, name, price, type, department_id) VALUES (1,'Инъекция',100000,'procedure',90)").run();
  db.prepare("INSERT INTO visits (id, patient_id, visit_date) VALUES (1,1,'2026-09-04T09:00:00Z')").run();
  db.prepare("INSERT INTO wards (id, name) VALUES (1,'Терапия')").run();
  db.prepare("INSERT INTO beds (id, code, ward_id) VALUES (1,'Т-4',1)").run();
  db.prepare("INSERT INTO admissions (id, patient_id, bed_id, ward_id, doctor_id, attending_doctor_id, status) VALUES (1,1,1,1,1,1,'active')").run();
  return db;
}
const out = (db, id, doctorId, createdAt = '2026-09-04T09:00:00Z') => db.prepare(
  `INSERT INTO visit_services (id, visit_id, service_id, doctor_id, quantity, unit_price, total, status, created_at)
   VALUES (?,1,1,?,1,100000,100000,'queued',?)`).run(id, doctorId, createdAt);
const inp = (db, id, performerId) => db.prepare(
  `INSERT INTO admission_services (id, admission_id, service_id, doctor_id, performer_id, bed_id, ward_id, quantity, unit_price, total, status, billable)
   VALUES (?,1,1,1,?,1,1,1,100000,100000,'added',1)`).run(id, performerId);
const ids = (res) => res.rows.map((r) => r.kind + ':' + r.id).sort();

test('PROC_SCOPE_V1: старшая медсестра видит всё, как администратор; главный врач и медсестра — своё и ничьё', () => {
  const db = seed();
  out(db, 1, 2); out(db, 2, 3); out(db, 3, null);
  inp(db, 1, 3);
  assert.equal(scopeOf(ACTOR.head), 'all');
  assert.equal(scopeOf(ACTOR.admin), 'all');
  assert.equal(scopeOf(ACTOR.nurse), 'own');
  assert.equal(scopeOf(ACTOR.headDoc), 'own');
  assert.deepEqual(ids(proceduresList(db, {}, ACTOR.head)), ['inpatient:1', 'outpatient:1', 'outpatient:2', 'outpatient:3']);
  assert.equal(proceduresList(db, {}, ACTOR.head).scope, 'all');
  assert.deepEqual(ids(proceduresList(db, {}, ACTOR.nurse)), ['outpatient:1', 'outpatient:3']);
  assert.deepEqual(ids(proceduresList(db, {}, ACTOR.nurse2)), ['inpatient:1', 'outpatient:2', 'outpatient:3']);
  assert.deepEqual(ids(proceduresList(db, {}, ACTOR.headDoc)), ['outpatient:3']);
});

test('PROC_SCOPE_V1: своя старая процедура не вытесняется пределом чужих свежих строк', () => {
  const db = seed();
  out(db, 1, 2, '2026-01-01T09:00:00Z');   // своя, старая
  const ins = db.prepare(`INSERT INTO visit_services (id, visit_id, service_id, doctor_id, quantity, unit_price, total, status, created_at)
                          VALUES (?,1,1,3,1,100000,100000,'queued',?)`);
  db.transaction(() => { for (let i = 0; i < 40; i++) ins.run(100 + i, '2026-09-0' + (1 + (i % 9)) + 'T10:00:00Z'); })();
  const res = proceduresList(db, { limit: 10 }, ACTOR.nurse);
  assert.deepEqual(ids(res), ['outpatient:1'], 'своя строка на месте, чужие не пришли вовсе');
});

test('PROC_SCOPE_V1: фильтр исполнителя у администратора и старшей медсестры — сотрудник или «не назначен»', () => {
  const db = seed();
  out(db, 1, 2); out(db, 2, 3); out(db, 3, null);
  inp(db, 1, 3); inp(db, 2, null);
  assert.deepEqual(ids(proceduresList(db, { performer: 3 }, ACTOR.admin)), ['inpatient:1', 'outpatient:2']);
  assert.deepEqual(ids(proceduresList(db, { performer: 'none' }, ACTOR.head)), ['inpatient:2', 'outpatient:3']);
  assert.deepEqual(ids(proceduresList(db, { performer: '' }, ACTOR.head)).length, 5, 'пусто — все');
  assert.throws(() => proceduresList(db, { performer: 'abc' }, ACTOR.admin), (e) => e.status === 400);
});

test('PROC_SCOPE_V1: медсестре фильтр исполнителя чужую очередь не открывает', () => {
  const db = seed();
  out(db, 1, 2); out(db, 2, 3); out(db, 3, null);
  assert.deepEqual(ids(proceduresList(db, { performer: 3 }, ACTOR.nurse)), ['outpatient:1', 'outpatient:3']);
});

test('PROC_SCOPE_V1: список исполнителей для фильтра — живые врачи и медсёстры, только тому, кто видит всё', () => {
  const db = seed();
  const all = proceduresList(db, {}, ACTOR.head).performers;
  assert.deepEqual(all.map((p) => p.id), [8, 1, 3, 2, 7], 'по имени; регистратура, админ без флага врача и уволенная — нет');
  assert.equal(all[0].full_name, 'Главный Г.Г.');
  assert.deepEqual(proceduresList(db, {}, ACTOR.nurse).performers, []);
});
