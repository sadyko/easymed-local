// CASE_DOC_A4_V1 — источники для правой панели документа истории болезни.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { admissionDocSources } from './case-doc-sources.js';
import { admissionReviewSave } from './inpatient-reviews.js';

const headDoctor = { id: 4, role: 'doctor', extra_roles: ['head_doctor'] };
const doctor = { id: 5, role: 'doctor' };
const cashier = { id: 7, role: 'cashier' };

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  for (const [id, u, role, isDoctor] of [[4, 'head', 'doctor', 1], [5, 'doc', 'doctor', 1], [7, 'cash', 'cashier', 0]]) {
    db.prepare('INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (?,?,?,?,?,?)').run(id, u, 'x', 'Сотрудник ' + u, role, isDoctor);
  }
  const pid = db.prepare("INSERT INTO patients (id, full_name, mrn) VALUES (1,'Иванов Иван','ID-1')").run().lastInsertRowid;
  db.prepare("INSERT INTO admissions (id, patient_id, status, admission_diagnosis, admitted_at) VALUES (10, 1, 'admitted', 'K35.8 (направление)', '2026-09-08T06:00:00Z')").run();
  // Визит с заключением и три услуги: анализ, рентген, ЭКГ.
  const vid = db.prepare("INSERT INTO visits (id, patient_id, visit_date, conclusion, conclusion_type) VALUES (50, ?, '2026-09-07T09:00:00Z', 'Признаков патологии не выявлено', 'diagnostic')").run(pid).lastInsertRowid;
  db.prepare("INSERT INTO services (id, name, price, type, is_lab) VALUES (901,'Общий анализ крови',50000,'lab',1)").run();
  db.prepare("INSERT INTO services (id, name, price, type) VALUES (902,'Рентген грудной клетки',90000,'radiology')").run();
  db.prepare("INSERT INTO services (id, name, price, type) VALUES (903,'ЭКГ',40000,'procedure')").run();
  db.prepare("INSERT INTO services (id, name, price, type) VALUES (904,'Приём терапевта',70000,'consultation')").run();
  const vs = (id, sid) => db.prepare('INSERT INTO visit_services (id, visit_id, service_id, quantity, unit_price, total, status) VALUES (?,?,?,1,0,0,?)').run(id, vid, sid, 'completed');
  vs(61, 901); vs(62, 902); vs(63, 903); vs(64, 904);
  db.prepare("INSERT INTO lab_results (visit_service_id, parameter, value, unit, reference_range, flag, entered_by) VALUES (61,'HGB','96','г/л','120–160','low',5)").run();
  db.prepare("INSERT INTO lab_results (visit_service_id, parameter, value, unit, reference_range, flag, entered_by) VALUES (61,'WBC','14.2','10⁹/л','4–9','high',5)").run();
  // Повторный ввод того же показателя заменяет прежний.
  db.prepare("INSERT INTO lab_results (visit_service_id, parameter, value, unit, reference_range, flag, entered_by) VALUES (61,'HGB','101','г/л','120–160','low',5)").run();
  return db;
}

test('панель отдаёт диагнозы, анализы с показателями, лучевые и функциональные исследования', () => {
  const db = seed();
  admissionReviewSave(db, { admission_id: 10, kind: 'primary', diagnosis: 'Острый аппендицит K35.8', objective: '<p>Живот напряжён</p>', publish: true }, headDoctor);

  const src = admissionDocSources(db, { admission_id: 10 }, doctor);
  assert.equal(src.diagnosis.referral, 'K35.8 (направление)');
  assert.equal(src.diagnosis.clinical, 'Острый аппендицит K35.8', 'клинический — из опубликованного первичного осмотра');

  assert.equal(src.lab.length, 1);
  assert.equal(src.lab[0].name, 'Общий анализ крови');
  assert.deepEqual(src.lab[0].results.map((r) => [r.parameter, r.value, r.flag]),
    [['WBC', '14.2', 'high'], ['HGB', '101', 'low']], 'последний ввод показателя побеждает, порядок — по вводу');

  assert.deepEqual(src.imaging.map((r) => r.name), ['Рентген грудной клетки']);
  assert.equal(src.imaging[0].conclusion, 'Признаков патологии не выявлено');
  assert.deepEqual(src.functional.map((r) => r.name), ['ЭКГ']);
  assert.ok(!src.lab.concat(src.imaging, src.functional).some((r) => r.name === 'Приём терапевта'), 'приём — не исследование');
  db.close();
});

test('анализ без показателей вставлять нечем — его в панели нет; исследование без заключения показано пустым', () => {
  const db = seed();
  db.prepare('DELETE FROM lab_results').run();
  db.prepare("UPDATE visits SET conclusion = '' WHERE id = 50").run();
  const src = admissionDocSources(db, { admission_id: 10 }, doctor);
  assert.deepEqual(src.lab, []);
  assert.equal(src.imaging.length, 1);
  assert.equal(src.imaging[0].conclusion, '', 'заключения нет — экран скажет об этом словами');
  db.close();
});

test('роль: историю болезни ведут врачи и сёстры, кассе источники закрыты', () => {
  const db = seed();
  assert.ok(admissionDocSources(db, { admission_id: 10 }, { id: 3, role: 'nurse' }));
  assert.throws(() => admissionDocSources(db, { admission_id: 10 }, cashier), (e) => e.status === 403);
  db.close();
});

test('CASE_DOC_A4_V1: разделы сохраняются разметкой, диагноз — простым текстом', () => {
  const db = seed();
  // Дневник ведёт лечащий врач по НАЧАТОМУ лечению (assertCanPrescribe).
  db.prepare("UPDATE admissions SET status = 'active', attending_doctor_id = 5 WHERE id = 10").run();
  const res = admissionReviewSave(db, {
    admission_id: 10, kind: 'round',
    complaints: '<p>Боль <b>уменьшилась</b></p><script>alert(1)</script>',
    objective: '<div onclick="x()">Живот мягкий</div>',
    diagnosis: '<b>K35.8</b> аппендицит',
    plan: '<ul><li>Стол №1</li></ul>',
    publish: true,
  }, doctor);
  assert.equal(res.review.complaints, '<p>Боль <b>уменьшилась</b></p>', 'оформление осталось, скрипт вырезан');
  assert.equal(res.review.objective, '<div>Живот мягкий</div>', 'обработчик вырезан');
  assert.equal(res.review.plan, '<ul><li>Стол №1</li></ul>');
  assert.equal(res.review.diagnosis, 'K35.8 аппендицит', 'диагноз — простой текст: он едет в списки и в журнал');
  db.close();
});
