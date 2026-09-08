// VITALS_NEWS_V1 — измерения показателей: роли, только на койке, диапазоны,
// сводка для обзора (ряд, последнее/предыдущее, точка «при поступлении», тренд).
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { admissionVitalsAdd, admissionVitalsList, vitalsSummary } from './vitals.js';
import { admissionOverview } from './case-overview.js';

const nurse   = { id: 3, role: 'nurse' };
const doctor  = { id: 5, role: 'doctor' };
const cashier = { id: 7, role: 'cashier' };

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  for (const [id, u, role, isDoctor] of [[3, 'nur', 'nurse', 0], [5, 'doc', 'doctor', 1], [7, 'cash', 'cashier', 0]]) {
    db.prepare('INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (?,?,?,?,?,?)').run(id, u, 'x', 'Сотрудник ' + u, role, isDoctor);
  }
  db.prepare("INSERT INTO patients (id, full_name) VALUES (1,'Иванов Иван')").run();
  db.prepare("INSERT INTO wards (id, name) VALUES (1,'Терапия')").run();
  db.prepare("INSERT INTO beds (id, code, ward_id, status) VALUES (1,'T-1',1,'occupied')").run();
  db.prepare("INSERT INTO admissions (id, patient_id, ward_id, bed_id, status, admitted_at, attending_doctor_id) VALUES (10, 1, 1, 1, 'active', '2026-09-08T06:00:00Z', 5)").run();
  db.prepare("INSERT INTO admissions (id, patient_id, status) VALUES (11, 1, 'ordered')").run();
  return db;
}
const adm = (db, id = 10) => db.prepare('SELECT * FROM admissions WHERE id = ?').get(id);

test('медсестра вносит измерение — пример владельца даёт 5 баллов NEWS, средний риск; касса — отказ', () => {
  const db = seed();
  const res = admissionVitalsAdd(db, {
    admission_id: 10, measured_at: '2026-06-08T08:00:00Z',
    temp_c: '38,1', bp_sys: 138, bp_dia: 88, pulse_bpm: 104, resp_rate: 21, spo2: 94, consciousness: 'alert', note: 'после обхода',
  }, nurse);
  assert.equal(res.vital.temp_c, 38.1);
  assert.equal(res.vital.measured_by_name, 'Сотрудник nur');
  assert.equal(res.vital.news.total, 5);
  assert.equal(res.vital.news.band, 'medium');
  assert.deepEqual([res.vital.news.parts.resp_rate, res.vital.news.parts.spo2, res.vital.news.parts.temp_c, res.vital.news.parts.bp_sys, res.vital.news.parts.pulse_bpm], [2, 1, 1, 0, 1]);
  assert.equal(res.summary.last.id, res.vital.id);
  assert.throws(() => admissionVitalsAdd(db, { admission_id: 10, temp_c: 37 }, cashier), (e) => e.status === 403);
  db.close();
});

test('только на койке: заявке и выписанному измерения не вносят', () => {
  const db = seed();
  assert.throws(() => admissionVitalsAdd(db, { admission_id: 11, temp_c: 37 }, nurse), (e) => e.status === 400 && /не размещён/.test(e.message));
  db.prepare("UPDATE admissions SET status = 'discharged', discharged_at = '2026-09-08T12:00:00Z' WHERE id = 10").run();
  assert.throws(() => admissionVitalsAdd(db, { admission_id: 10, temp_c: 37 }, nurse), (e) => e.status === 400 && /закрыта/.test(e.message));
  db.close();
});

test('диапазоны и полнота: опечатка отвергается словами, АД — обе цифры, пустое измерение не пишется', () => {
  const db = seed();
  assert.throws(() => admissionVitalsAdd(db, { admission_id: 10, spo2: 101 }, nurse), /SpO₂: от 50 до 100/);
  assert.throws(() => admissionVitalsAdd(db, { admission_id: 10, temp_c: 'abc' }, nurse), /Температура: не число/);
  assert.throws(() => admissionVitalsAdd(db, { admission_id: 10, bp_sys: 120 }, nurse), /обе цифры/);
  assert.throws(() => admissionVitalsAdd(db, { admission_id: 10, bp_sys: 80, bp_dia: 120 }, nurse), /меньше систолического/);
  assert.throws(() => admissionVitalsAdd(db, { admission_id: 10, consciousness: 'sleepy', temp_c: 37 }, nurse), /Сознание/);
  assert.throws(() => admissionVitalsAdd(db, { admission_id: 10, note: 'только слова' }, nurse), /Пустое измерение/);
  assert.throws(() => admissionVitalsAdd(db, { admission_id: 10, temp_c: 37, measured_at: 'вчера' }, nurse), /ISO/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM admission_vitals').get().n, 0, 'ни одна ошибка не оставила строки');
  // Частичное измерение — нормально: пульс и температура у поста.
  const res = admissionVitalsAdd(db, { admission_id: 10, temp_c: 36.6, pulse_bpm: 72 }, doctor);
  assert.equal(res.vital.spo2, null);
  assert.equal(res.vital.news.complete, false);
  assert.equal(res.vital.news.total, 0);
  db.close();
});

test('сводка: ряд по возрастанию, последнее/предыдущее, тренд; титульный лист — первая точка «при поступлении»', () => {
  const db = seed();
  const a = adm(db);
  let s = vitalsSummary(db, a);
  assert.equal(s.count, 0);
  assert.equal(s.last, null);
  assert.equal(s.news.band, 'none');
  assert.equal(s.can_add, true);

  // Лист медсестры при поступлении: температура и пульс.
  db.prepare("INSERT INTO admission_title_sheets (admission_id, temp_c, bp_sys, bp_dia, pulse_bpm, filled_at) VALUES (10, 36.6, 120, 80, 72, '2026-09-08T06:10:00Z')").run();
  s = vitalsSummary(db, a);
  assert.equal(s.series.length, 1);
  assert.equal(s.series[0].source, 'title');
  assert.equal(s.series[0].measured_at, '2026-09-08T06:00:00Z', 'время точки — размещение на койке');
  assert.equal(s.last.news.total, 0);

  admissionVitalsAdd(db, { admission_id: 10, measured_at: '2026-09-08T12:00:00Z', temp_c: 37.8, pulse_bpm: 96, resp_rate: 18, spo2: 96, bp_sys: 130, bp_dia: 85 }, nurse);
  admissionVitalsAdd(db, { admission_id: 10, measured_at: '2026-09-08T18:00:00Z', temp_c: 38.6, pulse_bpm: 112, resp_rate: 22, spo2: 93, bp_sys: 98, bp_dia: 60, on_oxygen: 1 }, nurse);
  s = vitalsSummary(db, a);
  assert.equal(s.count, 2);
  assert.deepEqual(s.series.map((r) => r.measured_at), ['2026-09-08T06:00:00Z', '2026-09-08T12:00:00Z', '2026-09-08T18:00:00Z']);
  assert.equal(s.last.temp_c, 38.6);
  assert.equal(s.prev.temp_c, 37.8);
  // 18:00: ЧДД 22 → 2, SpO₂ 93 → 2, O₂ → 2, АД 98 → 2, пульс 112 → 2, темп 38,6 → 1, сознание ясное → 0 = 11
  assert.equal(s.news.total, 11);
  assert.equal(s.news.band, 'high');
  assert.equal(s.trend, 11, 'от 0 при поступлении до 11 — ухудшение');

  const list = admissionVitalsList(db, { admission_id: 10 }, doctor).rows;
  assert.deepEqual(list.map((r) => r.measured_at), ['2026-09-08T18:00:00Z', '2026-09-08T12:00:00Z'], 'список — новые первыми, без точки листа');
  assert.throws(() => admissionVitalsList(db, { admission_id: 10 }, cashier), (e) => e.status === 403);

  // Обзор госпитализации несёт ту же сводку.
  const ov = admissionOverview(db, { admission_id: 10 }, doctor);
  assert.equal(ov.vitals.news.total, 11);
  assert.equal(ov.vitals.series.length, 3);
  db.close();
});
