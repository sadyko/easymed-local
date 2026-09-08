// ADMITTING_DOCTOR_V1 / CONSENT_OUT_V1 — приёмный врач госпитализации.
//
// Владелец (2026-09-08): «the consent shouldn't be there and, osmotr priemnogo
// vracha should be filled by the another doctor in the cabinet, which means
// the nurse should select the admitting doctor, and admitting doctor should
// fill the blank, then head doctor or selected doctor should fill the
// treating doctor».
//
// Что проверяется — по одному предложению на решение:
//   • медсестра называет приёмного врача при размещении, и это врач (не
//     лаборант, не уволенный); без поля — как раньше;
//   • «Осмотр приёмного врача» публикует ПРИЁМНЫЙ врач (и это закрывает шаг
//     «осмотрен»), главный врач — как прежде; чужой врач получает отказ,
//     называющий, кого ждут;
//   • лечащего врача назначает главный врач ИЛИ приёмный врач этого пациента,
//     чужой врач — нет; клиентский admission_transition матрицу не обходит;
//   • «Согласие» в наборе документов больше не значится: первый шаг — осмотр
//     приёмного врача; старые записи согласия читаются и печатаются первыми;
//   • список врачей открыт медсестре и врачу; «мои пациенты» приёмного врача
//     включают тех, кого он ещё только осматривает.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { admissionOrderCreate, admissionAdmit } from './inpatient.js';
import {
  admissionReviewSave, admissionSetAttending, admissionCaseDocs, admissionCaseFile,
  admissionAttendingCandidates, CASE_DOC_SET, LEGACY_KINDS,
} from './inpatient-reviews.js';
import { admissionTransition, RpcError } from './inpatient-flow.js';
import { wardNeighbours } from './case-overview.js';

const registrar  = { id: 2, role: 'registrar' };
const nurse      = { id: 3, role: 'nurse' };
const headDoctor = { id: 4, role: 'doctor', extra_roles: ['head_doctor'] };
const admitting  = { id: 5, role: 'doctor' };   // приёмный врач
const other      = { id: 6, role: 'doctor' };   // чужой врач
const lab        = { id: 7, role: 'lab' };

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  const users = [
    [1, 'adm', 'admin', 0], [2, 'reg', 'registrar', 0], [3, 'nur', 'nurse', 0],
    [4, 'head', 'doctor', 1], [5, 'doc5', 'doctor', 1], [6, 'doc6', 'doctor', 1], [7, 'lab7', 'lab', 0],
    [8, 'gone', 'doctor', 1],
  ];
  for (const [id, u, role, isDoctor] of users) {
    db.prepare('INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (?,?,?,?,?,?)')
      .run(id, u, 'x', 'Сотрудник ' + u, role, isDoctor);
  }
  db.prepare('UPDATE users SET is_active = 0 WHERE id = 8').run();   // `active` — вычисляемое зеркало is_active (мигр. 032)
  const p1 = db.prepare("INSERT INTO patients (full_name, mrn) VALUES ('Каримов Т.','31002')").run().lastInsertRowid;
  const p2 = db.prepare("INSERT INTO patients (full_name, mrn) VALUES ('Юлдашев С.','27431')").run().lastInsertRowid;
  const ward = db.prepare("INSERT INTO wards (name) VALUES ('Терапия')").run().lastInsertRowid;
  const bed1 = db.prepare("INSERT INTO beds (code, ward_id, status) VALUES ('T-1', ?, 'free')").run(ward).lastInsertRowid;
  const bed2 = db.prepare("INSERT INTO beds (code, ward_id, status) VALUES ('T-2', ?, 'free')").run(ward).lastInsertRowid;
  return { db, p1, p2, bed1, bed2 };
}

function placed(ctx, patientId, bedId, extra = {}) {
  const { admission } = admissionOrderCreate(ctx.db, { patient_id: patientId, department: 'Терапия' }, registrar);
  return admissionAdmit(ctx.db, Object.assign({ admission_id: admission.id, bed_id: bedId }, extra), nurse).admission;
}

test('медсестра называет приёмного врача при размещении; не-врач и уволенный — отказ; без поля — как раньше', () => {
  const ctx = seed();
  const a = placed(ctx, ctx.p1, ctx.bed1, { admitting_doctor_id: 5 });
  assert.equal(a.status, 'admitted');
  assert.equal(a.admitting_doctor_id, 5);

  const { admission: o2 } = admissionOrderCreate(ctx.db, { patient_id: ctx.p2, department: 'Терапия' }, registrar);
  // inpatient.js бросает свой RpcError (не тот класс, что inpatient-flow.js) — проверяем статус и слова.
  assert.throws(() => admissionAdmit(ctx.db, { admission_id: o2.id, bed_id: ctx.bed2, admitting_doctor_id: 7 }, nurse),
    (e) => e.status === 400 && /признака врача/.test(e.message));
  assert.throws(() => admissionAdmit(ctx.db, { admission_id: o2.id, bed_id: ctx.bed2, admitting_doctor_id: 8 }, nurse),
    (e) => e.status === 400 && /уволен/.test(e.message));
  assert.throws(() => admissionAdmit(ctx.db, { admission_id: o2.id, bed_id: ctx.bed2, admitting_doctor_id: 'x' }, nurse), /positive integer/);
  const b = admissionAdmit(ctx.db, { admission_id: o2.id, bed_id: ctx.bed2 }, nurse).admission;
  assert.equal(b.admitting_doctor_id, null, 'без поля приёмный врач не назначен — осмотр за главным врачом');
  ctx.db.close();
});

test('осмотр приёмного врача публикует приёмный врач — и пациент становится «осмотрен»; чужой врач получает отказ с именем', () => {
  const ctx = seed();
  const a = placed(ctx, ctx.p1, ctx.bed1, { admitting_doctor_id: 5 });

  const refusal = assert.throws(() => admissionReviewSave(ctx.db, { admission_id: a.id, kind: 'intake', body: 'Осмотр', publish: true }, other),
    (e) => e instanceof RpcError && e.status === 403 && /Сотрудник doc5/.test(e.message)) || null;
  assert.equal(ctx.db.prepare('SELECT status FROM admissions WHERE id = ?').get(a.id).status, 'admitted');

  // Черновик — без права публикации: любой врач может начать писать.
  admissionReviewSave(ctx.db, { admission_id: a.id, kind: 'intake', body: 'черновик', publish: false }, other);

  const res = admissionReviewSave(ctx.db, { admission_id: a.id, kind: 'intake', body: 'Состояние средней тяжести', publish: true }, admitting);
  assert.equal(res.review.published_at !== null, true);
  assert.equal(res.review.author_role, 'doctor');
  assert.equal(res.admission.status, 'examined', 'осмотр приёмного врача закрывает шаг «осмотрен»');
  assert.equal(res.admission.examined_by, 5, 'подпись шага — приёмного врача');

  // Пункт чек-листа знает адресата, пока осмотра нет, и автора — когда есть.
  const st = admissionCaseDocs(ctx.db, { admission_id: a.id }, headDoctor);
  const intake = st.items.find((i) => i.kind === 'intake');
  assert.equal(intake.state, 'published');
  assert.equal(intake.assignee_name, 'Сотрудник doc5');
  void refusal;
  ctx.db.close();
});

test('без приёмного врача осмотр при поступлении — за главным врачом, и отказ чужому врачу говорит именно это', () => {
  const ctx = seed();
  const a = placed(ctx, ctx.p1, ctx.bed1);
  assert.throws(() => admissionReviewSave(ctx.db, { admission_id: a.id, kind: 'intake', body: 'Осмотр', publish: true }, other),
    (e) => e instanceof RpcError && e.status === 403 && /не назначен/.test(e.message));
  const res = admissionReviewSave(ctx.db, { admission_id: a.id, kind: 'intake', body: 'Осмотр', publish: true }, headDoctor);
  assert.equal(res.admission.status, 'examined');
  assert.equal(res.review.author_role, 'head_doctor');
  ctx.db.close();
});

test('лечащего врача назначает главный врач ИЛИ приёмный врач этого пациента; чужой врач и клиентский переход — нет', () => {
  const ctx = seed();
  const a = placed(ctx, ctx.p1, ctx.bed1, { admitting_doctor_id: 5 });
  admissionReviewSave(ctx.db, { admission_id: a.id, kind: 'intake', body: 'Осмотр', publish: true }, admitting);

  assert.throws(() => admissionSetAttending(ctx.db, { admission_id: a.id, doctor_id: 6 }, other),
    (e) => e instanceof RpcError && e.status === 403);
  // Матрица ролей для прямого перехода не расширилась: приёмный врач через
  // admission_transition шаг не двигает — только через назначение.
  assert.throws(() => admissionTransition(ctx.db, { admission_id: a.id, to: 'active' }, admitting),
    (e) => e instanceof RpcError && e.status === 403);

  const res = admissionSetAttending(ctx.db, { admission_id: a.id, doctor_id: 6 }, admitting);
  assert.equal(res.admission.status, 'active');
  assert.equal(res.admission.attending_doctor_id, 6, 'приёмный врач может назначить лечащим другого врача');

  // Второй пациент — назначает главный врач, как и раньше.
  const b = placed(ctx, ctx.p2, ctx.bed2, { admitting_doctor_id: 5 });
  admissionReviewSave(ctx.db, { admission_id: b.id, kind: 'intake', body: 'Осмотр', publish: true }, headDoctor);
  assert.equal(admissionSetAttending(ctx.db, { admission_id: b.id, doctor_id: 5 }, headDoctor).admission.status, 'active');
  ctx.db.close();
});

test('CONSENT_OUT_V1: согласия в наборе нет — первый шаг врача осмотр приёмного врача; старая запись согласия печатается первой', () => {
  const ctx = seed();
  assert.ok(!CASE_DOC_SET.some((d) => d.kind === 'consent'), 'согласие не в наборе');
  assert.deepEqual([...LEGACY_KINDS], ['consent']);
  const a = placed(ctx, ctx.p1, ctx.bed1, { admitting_doctor_id: 5 });
  let st = admissionCaseDocs(ctx.db, { admission_id: a.id }, headDoctor);
  assert.equal(st.next_kind, 'intake', 'следующий шаг — осмотр приёмного врача');
  assert.ok(!st.items.some((i) => i.kind === 'consent'));

  // Старая запись согласия (клиника писала её до обновления) — читается и идёт первой.
  ctx.db.prepare(`INSERT INTO admission_reviews (admission_id, kind, body, author_id, author_role, published_at)
                  VALUES (?, 'consent', 'Согласие получено', 5, 'doctor', '2026-09-08T09:00:00Z')`).run(a.id);
  admissionReviewSave(ctx.db, { admission_id: a.id, kind: 'intake', body: 'Осмотр', publish: true }, admitting);
  const file = admissionCaseFile(ctx.db, { admission_id: a.id }, headDoctor);
  assert.deepEqual(file.documents.map((d) => d.kind), ['consent', 'intake']);
  assert.ok(!file.gaps.includes('consent'), 'согласие не пробел');
  st = admissionCaseDocs(ctx.db, { admission_id: a.id }, headDoctor);
  assert.ok(!st.discharge_gate.incomplete.includes('consent'));
  ctx.db.close();
});

test('список врачей открыт медсестре и врачу (им называть приёмного и лечащего); лаборанту — нет', () => {
  const ctx = seed();
  const forNurse = admissionAttendingCandidates(ctx.db, {}, nurse);
  assert.ok(forNurse.doctors.some((d) => d.id === 5) && !forNurse.doctors.some((d) => d.id === 8), 'действующие врачи, без уволенных');
  assert.ok(admissionAttendingCandidates(ctx.db, {}, admitting).doctors.length >= 3);
  assert.throws(() => admissionAttendingCandidates(ctx.db, {}, lab), (e) => e instanceof RpcError && e.status === 403);
  ctx.db.close();
});

test('«мои пациенты» приёмного врача включают тех, кого он ещё только осматривает', () => {
  const ctx = seed();
  const a = placed(ctx, ctx.p1, ctx.bed1, { admitting_doctor_id: 5 });
  const b = placed(ctx, ctx.p2, ctx.bed2, { admitting_doctor_id: 6 });
  const n = wardNeighbours(ctx.db, ctx.db.prepare('SELECT * FROM admissions WHERE id = ?').get(a.id), admitting);
  assert.equal(n.mine, true);
  assert.equal(n.total, 1, 'чужого (приёмный — другой врач) в «моих» нет');
  assert.equal(n.index, 0);
  void b;
  ctx.db.close();
});
