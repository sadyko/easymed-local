// INPATIENT_REQUIRED_V1 — четыре переключателя на сервере: включены — как раньше; выключены — шаг не держит.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { admissionOrderCreate, admissionAdmit, admissionDischargeRequest } from './inpatient.js';
import { admissionReviewSave, admissionSetAttending } from './inpatient-reviews.js';
import { admissionTransition, assertCanPrescribe, admissionFlowState, inpatientCapabilities, assertAdmissionAtLeast } from './inpatient-flow.js';
import { inpatientSettingsSave } from './inpatient-settings.js';

const admin     = { id: 1, role: 'admin' };
const registrar = { id: 2, role: 'registrar' };
const nurse     = { id: 3, role: 'nurse' };
const head      = { id: 4, role: 'doctor', extra_roles: ['head_doctor'] };
const admitting = { id: 5, role: 'doctor' };
const other     = { id: 6, role: 'doctor' };
const senior    = { id: 7, role: 'senior_nurse' };

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  for (const [id, u, role, isDoc] of [[1, 'adm', 'admin', 0], [2, 'reg', 'registrar', 0], [3, 'nur', 'nurse', 0], [4, 'head', 'doctor', 1], [5, 'doc5', 'doctor', 1], [6, 'doc6', 'doctor', 1], [7, 'snur', 'senior_nurse', 0]]) {
    db.prepare('INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (?,?,?,?,?,?)').run(id, u, 'x', 'Сотрудник ' + u, role, isDoc);
  }
  const pid = db.prepare("INSERT INTO patients (full_name, mrn) VALUES ('Тестов Пациент','T-0001')").run().lastInsertRowid;
  const ward = db.prepare("INSERT INTO wards (name) VALUES ('Терапия')").run().lastInsertRowid;
  const bed = db.prepare("INSERT INTO beds (code, ward_id, status) VALUES ('T-1', ?, 'free')").run(ward).lastInsertRowid;
  return { db, pid, bed };
}
function placed(ctx, extra = {}) {
  const { admission } = admissionOrderCreate(ctx.db, { patient_id: ctx.pid, department: 'Терапия' }, registrar);
  return admissionAdmit(ctx.db, Object.assign({ admission_id: admission.id, bed_id: ctx.bed }, extra), nurse).admission;
}
const off = (db, key) => inpatientSettingsSave(db, { [key]: 0 }, admin);
const status = (db, id) => db.prepare('SELECT status, attending_doctor_id, examined_at, examined_by FROM admissions WHERE id = ?').get(id);
// База клиники, которая не дошла до 298: ни строки настроек, ни журнала, ни колонок набора.
function dropTo297(db) {
  db.exec('DROP TABLE inpatient_settings_log; DROP TABLE inpatient_settings;');
  db.exec('ALTER TABLE case_doc_types DROP COLUMN required_sections; ALTER TABLE case_doc_types DROP COLUMN required;');
}

test('лечащий врач, переключатель включён (умолчание): с койки — отказ, как раньше', () => {
  const ctx = seed();
  const a = placed(ctx);
  assert.throws(() => admissionSetAttending(ctx.db, { admission_id: a.id, doctor_id: 5 }, head), /не осмотрен/);
  assert.equal(status(ctx.db, a.id).status, 'admitted');
  assert.throws(() => assertCanPrescribe(ctx.db, a.id, head), /не осмотрен главным врачом/);
  assert.equal(inpatientCapabilities(ctx.db, {}, head).required.intake_before_attending, true);
  assert.notEqual(admissionFlowState(ctx.db, { admission_id: a.id }, head).can.active, true);
  ctx.db.close();
});

test('лечащий врач, переключатель выключен: назначают прямо с койки; осмотр никем не записан', () => {
  const ctx = seed();
  off(ctx.db, 'intake_before_attending');
  const a = placed(ctx, { admitting_doctor_id: 5 });
  assert.throws(() => assertCanPrescribe(ctx.db, a.id, head), /Лечащий врач ещё не назначен/);
  assert.equal(admissionFlowState(ctx.db, { admission_id: a.id }, head).can.active, true);
  assert.equal(admissionFlowState(ctx.db, { admission_id: a.id }, head).required.intake_before_attending, false);
  // Чужой врач — нельзя; приёмный врач этого пациента — можно.
  assert.throws(() => admissionSetAttending(ctx.db, { admission_id: a.id, doctor_id: 6 }, other), (e) => e.status === 403);
  const res = admissionSetAttending(ctx.db, { admission_id: a.id, doctor_id: 6 }, admitting);
  assert.equal(res.admission.status, 'active');
  assert.deepEqual({ ...status(ctx.db, a.id) }, { status: 'active', attending_doctor_id: 6, examined_at: null, examined_by: null });
  assert.ok(assertCanPrescribe(ctx.db, a.id, other), 'лечащий врач ведёт назначения');
  assert.throws(() => admissionSetAttending(ctx.db, { admission_id: a.id, doctor_id: 5 }, head), /уже назначен/);
  ctx.db.close();
});

test('машина маршрута сама «койка → лечение» не предлагает — и при выключенном переключателе', () => {
  const ctx = seed();
  off(ctx.db, 'intake_before_attending');
  const a = placed(ctx);
  assert.throws(() => admissionTransition(ctx.db, { admission_id: a.id, to: 'active' }, admin), /Нельзя пропустить шаг/);
  assert.equal(status(ctx.db, a.id).status, 'admitted');
  ctx.db.close();
});

test('первичный осмотр во время лечения: выключено — документ (маршрут на месте, осмотр записан); включено — отказ', () => {
  const ctx = seed();
  off(ctx.db, 'intake_before_attending');
  const a = placed(ctx);
  admissionSetAttending(ctx.db, { admission_id: a.id, doctor_id: 5 }, head);
  const r = admissionReviewSave(ctx.db, { admission_id: a.id, kind: 'primary', diagnosis: 'J18.9', publish: true }, head);
  assert.ok(r.review.published_at);
  const s = status(ctx.db, a.id);
  assert.equal(s.status, 'active');
  assert.equal(s.examined_by, 4);
  assert.ok(s.examined_at);
  // Включили обратно: уже лечащиеся не двигаются, а новый первичный во время лечения — отказ, как раньше.
  inpatientSettingsSave(ctx.db, { intake_before_attending: 1 }, admin);
  assert.equal(status(ctx.db, a.id).status, 'active');
  assert.throws(() => admissionReviewSave(ctx.db, { admission_id: a.id, kind: 'primary', diagnosis: 'J18.0', publish: true }, head),
    /закрыт назначением лечащего врача/);
  ctx.db.close();
});

test('выписка: включено — без эпикриза отказ; выключено — заявку принимают', () => {
  const ctx = seed();
  off(ctx.db, 'intake_before_attending');
  const a = placed(ctx);
  admissionSetAttending(ctx.db, { admission_id: a.id, doctor_id: 5 }, head);
  assert.throws(() => admissionDischargeRequest(ctx.db, { admission_id: a.id, outcome: 'home' }, head),
    (e) => e.status === 400 && /Выписной эпикриз не написан/.test(e.message));
  off(ctx.db, 'discharge_needs_epicrisis');
  const res = admissionDischargeRequest(ctx.db, { admission_id: a.id, outcome: 'home' }, head);
  assert.equal(res.admission.status, 'discharging');
  ctx.db.close();
});

test('приёмный врач при размещении: сервер, как и раньше, кладёт без него при любом положении', () => {
  const ctx = seed();
  assert.equal(placed(ctx).admitting_doctor_id, null);
  ctx.db.close();
});

// ─── Добавлено при исполнении: края, которых план не назвал ──────────────────

test('с койки назначают те же, кто после осмотра: главный врач, администратор, приёмный врач; медсёстры и регистратура — нет', () => {
  const ctx = seed();
  off(ctx.db, 'intake_before_attending');
  for (const u of [nurse, senior, registrar, other]) {
    const a = placed(ctx, { admitting_doctor_id: 5 });
    assert.throws(() => admissionSetAttending(ctx.db, { admission_id: a.id, doctor_id: 6 }, u), (e) => e.status === 403, u.role);
    assert.equal(status(ctx.db, a.id).status, 'admitted', u.role);
    assert.equal(admissionFlowState(ctx.db, { admission_id: a.id }, u).can.active, false, u.role);
    ctx.db.prepare("UPDATE admissions SET status = 'cancelled', bed_id = NULL WHERE id = ?").run(a.id);
    ctx.db.prepare("UPDATE beds SET status = 'free' WHERE id = ?").run(ctx.bed);
  }
  const a = placed(ctx);
  assert.equal(admissionSetAttending(ctx.db, { admission_id: a.id, doctor_id: 6 }, admin).admission.status, 'active');
  assert.equal(status(ctx.db, a.id).examined_at, null);
  ctx.db.close();
});

test('выключено, но пациент уже осмотрен — назначение как раньше, подпись осмотра остаётся', () => {
  const ctx = seed();
  const a = placed(ctx);
  admissionReviewSave(ctx.db, { admission_id: a.id, kind: 'primary', diagnosis: 'J18.9', publish: true }, head);
  const before = status(ctx.db, a.id);
  assert.equal(before.status, 'examined');
  off(ctx.db, 'intake_before_attending');
  admissionSetAttending(ctx.db, { admission_id: a.id, doctor_id: 5 }, head);
  const s = status(ctx.db, a.id);
  assert.equal(s.status, 'active');
  assert.equal(s.examined_at, before.examined_at);
  assert.equal(s.examined_by, 4);
  ctx.db.close();
});

test('выключено: первичный осмотр на койке по-прежнему ведёт admitted → examined', () => {
  const ctx = seed();
  off(ctx.db, 'intake_before_attending');
  const a = placed(ctx);
  admissionReviewSave(ctx.db, { admission_id: a.id, kind: 'primary', diagnosis: 'J18.9', publish: true }, head);
  const s = status(ctx.db, a.id);
  assert.equal(s.status, 'examined');
  assert.equal(s.examined_by, 4);
  ctx.db.close();
});

test('осмотр приёмного врача во время лечения: выключено — подпись осмотра ставится один раз (COALESCE); включено — как раньше, не ставится', () => {
  const ctx = seed();
  off(ctx.db, 'intake_before_attending');
  const a = placed(ctx, { admitting_doctor_id: 5 });
  admissionSetAttending(ctx.db, { admission_id: a.id, doctor_id: 6 }, head);
  admissionReviewSave(ctx.db, { admission_id: a.id, kind: 'intake', objective: '<p>ясно</p>', publish: true }, admitting);
  const s1 = status(ctx.db, a.id);
  assert.equal(s1.status, 'active');
  assert.equal(s1.examined_by, 5);
  assert.ok(s1.examined_at);
  // Второй осмотр (исправление) первую подпись не переписывает.
  ctx.db.prepare("UPDATE admissions SET examined_at = '2026-01-01T00:00:00Z' WHERE id = ?").run(a.id);
  admissionReviewSave(ctx.db, { admission_id: a.id, kind: 'primary', diagnosis: 'J18.9', publish: true }, head);
  assert.deepEqual({ ...status(ctx.db, a.id) }, { status: 'active', attending_doctor_id: 6, examined_at: '2026-01-01T00:00:00Z', examined_by: 5 });

  // Переключатель включён: осмотр приёмного врача у лечащегося без осмотра — документ, подписи шага нет (как до правки).
  const ctx2 = seed();
  off(ctx2.db, 'intake_before_attending');
  const b = placed(ctx2, { admitting_doctor_id: 5 });
  admissionSetAttending(ctx2.db, { admission_id: b.id, doctor_id: 6 }, head);
  inpatientSettingsSave(ctx2.db, { intake_before_attending: 1 }, admin);
  admissionReviewSave(ctx2.db, { admission_id: b.id, kind: 'intake', objective: '<p>ясно</p>', publish: true }, admitting);
  assert.deepEqual({ ...status(ctx2.db, b.id) }, { status: 'active', attending_doctor_id: 6, examined_at: null, examined_by: null });
  ctx.db.close();
  ctx2.db.close();
});

test('выключено: осмотр приёмного врача во время заявки на выписку — тоже записывает, кто осмотрел', () => {
  const ctx = seed();
  off(ctx.db, 'intake_before_attending');
  off(ctx.db, 'discharge_needs_epicrisis');
  const a = placed(ctx, { admitting_doctor_id: 5 });
  admissionSetAttending(ctx.db, { admission_id: a.id, doctor_id: 6 }, head);
  admissionDischargeRequest(ctx.db, { admission_id: a.id, outcome: 'home' }, head);
  admissionReviewSave(ctx.db, { admission_id: a.id, kind: 'intake', objective: '<p>ясно</p>', publish: true }, admitting);
  const s = status(ctx.db, a.id);
  assert.equal(s.status, 'discharging');
  assert.equal(s.examined_by, 5);
  ctx.db.close();
});

test('выключено: заявку ещё не разместили — назначать некого лечить, отказ называет шаг', () => {
  const ctx = seed();
  off(ctx.db, 'intake_before_attending');
  const { admission } = admissionOrderCreate(ctx.db, { patient_id: ctx.pid, department: 'Терапия' }, registrar);
  assert.throws(() => admissionSetAttending(ctx.db, { admission_id: admission.id, doctor_id: 5 }, head), /не размещён на койке/);
  assert.equal(status(ctx.db, admission.id).status, 'ordered');
  ctx.db.close();
});

test('флаги для экранов: inpatient_capabilities и admission_flow_state несут все пять переключателей', () => {
  const ctx = seed();
  const all = { intake_before_attending: true, admitting_at_placement: true, primary_needs_diagnosis: true, discharge_needs_epicrisis: true, title_required: true };
  assert.deepEqual(inpatientCapabilities(ctx.db, {}, nurse).required, all);
  assert.deepEqual(inpatientCapabilities(null, {}, nurse).required, all, 'без базы — умолчания');
  const a = placed(ctx);
  assert.deepEqual(admissionFlowState(ctx.db, { admission_id: a.id }, nurse).required, all);
  inpatientSettingsSave(ctx.db, { admitting_at_placement: 0, primary_needs_diagnosis: 0 }, admin);
  assert.deepEqual(inpatientCapabilities(ctx.db, {}, nurse).required,
    Object.assign({}, all, { admitting_at_placement: false, primary_needs_diagnosis: false }));
  ctx.db.close();
});

test('база старше 298 — всё как сегодня: с койки отказ, выписка без эпикриза — отказ, флаги — умолчания', () => {
  const ctx = seed();
  const a = placed(ctx);
  dropTo297(ctx.db);
  assert.throws(() => admissionSetAttending(ctx.db, { admission_id: a.id, doctor_id: 5 }, head), /не осмотрен/);
  assert.notEqual(admissionFlowState(ctx.db, { admission_id: a.id }, head).can.active, true);
  assert.equal(inpatientCapabilities(ctx.db, {}, head).required.intake_before_attending, true);
  admissionReviewSave(ctx.db, { admission_id: a.id, kind: 'primary', diagnosis: 'J18.9', publish: true }, head);
  admissionSetAttending(ctx.db, { admission_id: a.id, doctor_id: 5 }, head);
  assert.throws(() => admissionDischargeRequest(ctx.db, { admission_id: a.id, outcome: 'home' }, head), /Выписной эпикриз не написан/);
  ctx.db.close();
});

// ─── INPATIENT_REQUIRED_V1 (ревью) ───────────────────────────────────────────

test('(ревью) «дошёл ли до лечения»: выключено — лежащий на койке ждёт лечащего врача, а не осмотра; включено — как раньше', () => {
  const ctx = seed();
  const a = placed(ctx);
  // Умолчание: отказ называет осмотр (стол, склад, назначения — тот же вопрос).
  assert.throws(() => assertAdmissionAtLeast(ctx.db, a.id, 'active'), (e) => e.message === 'Пациент ещё не осмотрен главным врачом.');
  assert.throws(() => assertAdmissionAtLeast(ctx.db, a.id, 'discharging'), (e) => e.message === 'Пациент ещё не осмотрен главным врачом.');
  off(ctx.db, 'intake_before_attending');
  assert.throws(() => assertAdmissionAtLeast(ctx.db, a.id, 'active'),
    (e) => e.status === 400 && e.message === 'Лечащий врач ещё не назначен — назначения недоступны.');
  assert.throws(() => assertAdmissionAtLeast(ctx.db, a.id, 'discharging'), /Лечащий врач ещё не назначен/);
  // Об осмотре спросили прямо — осмотра действительно нет, ответ прежний.
  assert.throws(() => assertAdmissionAtLeast(ctx.db, a.id, 'examined'), (e) => e.message === 'Пациент ещё не осмотрен главным врачом.');
  assert.equal(assertAdmissionAtLeast(ctx.db, a.id, 'admitted').id, a.id);
  // Заявка, ещё не размещённая, — по-прежнему «позовите медсестру» (второй пациент: первый уже лежит).
  const pid2 = ctx.db.prepare("INSERT INTO patients (full_name, mrn) VALUES ('Тестова Пациентка','T-0003')").run().lastInsertRowid;
  const { admission } = admissionOrderCreate(ctx.db, { patient_id: pid2, department: 'Терапия' }, registrar);
  assert.throws(() => assertAdmissionAtLeast(ctx.db, admission.id, 'active'), /не размещён на койке/);
  ctx.db.close();
});

test('(ревью) выключено: второй первичный осмотр у обычно осмотренного и уже лечащегося — отказ, как сегодня', () => {
  const ctx = seed();
  const a = placed(ctx);
  const first = admissionReviewSave(ctx.db, { admission_id: a.id, kind: 'primary', diagnosis: 'J18.9', publish: true }, head).review;
  admissionSetAttending(ctx.db, { admission_id: a.id, doctor_id: 5 }, head);
  off(ctx.db, 'intake_before_attending');
  assert.throws(() => admissionReviewSave(ctx.db, { admission_id: a.id, kind: 'primary', diagnosis: 'J18.0', publish: true }, head),
    (e) => e.status === 400 && /закрыт назначением лечащего врача/.test(e.message));
  const rows = ctx.db.prepare("SELECT id, superseded_by FROM admission_reviews WHERE admission_id = ? AND kind = 'primary' AND published_at IS NOT NULL").all(a.id);
  assert.deepEqual(rows.map((r) => ({ ...r })), [{ id: first.id, superseded_by: null }], 'осмотр, закрывший маршрут, остаётся действующим');
  ctx.db.close();
});

test('(ревью) выключено: лечащего назначили с койки — первичный во время лечения принимается один раз, второй — отказ', () => {
  const ctx = seed();
  off(ctx.db, 'intake_before_attending');
  const a = placed(ctx);
  admissionSetAttending(ctx.db, { admission_id: a.id, doctor_id: 5 }, head);
  // Черновик первичного осмотра ничего не закрывает: публикация после него принимается.
  const draft = admissionReviewSave(ctx.db, { admission_id: a.id, kind: 'primary', diagnosis: 'J18.9' }, head).review;
  const r = admissionReviewSave(ctx.db, { admission_id: a.id, review_id: draft.id, kind: 'primary', diagnosis: 'J18.9', publish: true }, head);
  assert.ok(r.review.published_at);
  assert.throws(() => admissionReviewSave(ctx.db, { admission_id: a.id, kind: 'primary', diagnosis: 'J18.0', publish: true }, head),
    /закрыт назначением лечащего врача/);
  ctx.db.close();
});
