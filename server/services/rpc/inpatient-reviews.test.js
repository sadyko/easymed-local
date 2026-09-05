// INPATIENT_REVIEW_V1 — первичный осмотр главного врача и лечащий врач.
//
// Здесь проверяется середина маршрута владельца: «медсестра кладёт на койку →
// ПЕРВИЧНЫЙ ОСМОТР ГЛАВНОГО ВРАЧА → НАЗНАЧЕНИЕ ЛЕЧАЩЕГО ВРАЧА → лист
// назначений». Пять вопросов, и первый из них — заголовочное требование
// владельца целиком, от койки до назначения:
//
//   1. НАЗНАЧЕНИЕ НЕВОЗМОЖНО ДО ОСМОТРА И ВОЗМОЖНО ПОСЛЕ. Не «сервер вернул
//      403», а весь путь: заявка → койка → осмотр → лечащий врач → назначение.
//      Порознь каждый шаг может быть верен, а маршрут — разорван.
//   2. ОСМОТР ПУБЛИКУЕТ ГЛАВНЫЙ ВРАЧ. Обычному врачу отказ называет, КТО это
//      делает: человек у экрана должен понять, кого позвать.
//   3. ЧЕРНОВИК — НЕ ПУБЛИКАЦИЯ. Сохранённый, но не опубликованный осмотр не
//      двигает маршрут ни на шаг.
//   4. ИСПРАВЛЕНИЕ НЕ СТИРАЕТ ИСХОДНИК: прежняя запись остаётся целиком, новая
//      её закрывает.
//   5. ЛЕЧАЩИМ МОЖНО НАЗНАЧИТЬ ТОЛЬКО ВРАЧА — и признак врача берётся не из
//      текста роли (ADMIN_DOCTOR_LIST_V1: администратор клиники бывает врачом,
//      а его role='admin').
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { admissionOrderCreate, admissionAdmit, dischargePatient } from './inpatient.js';
import {
  admissionReviewSave, admissionSetAttending, admissionChangeAttending,
  admissionReviewsList, isDoctorRow, admissionAttendingCandidates,
} from './inpatient-reviews.js';
import { treatmentOrderCreate } from './treatment-orders.js';
import { assertCanPrescribe, RpcError } from './inpatient-flow.js';

// Надстроечные роли человек носит ТОЛЬКО в extra_roles: главный врач остаётся
// врачом (миграция 091).
const admin       = { id: 1, role: 'admin' };
const registrar   = { id: 2, role: 'registrar' };
const nurse       = { id: 3, role: 'nurse' };
const headDoctor  = { id: 4, role: 'doctor', extra_roles: ['head_doctor'] };
const doctor      = { id: 5, role: 'doctor' };
const doctor2     = { id: 6, role: 'doctor' };
const cashier     = { id: 7, role: 'cashier' };
// Администратор клиники, который ВРАЧ: role='admin', specialty пустая, и
// узнать в нём врача можно только по is_doctor.
const adminDoctor = { id: 8, role: 'admin' };

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  const users = [
    [1, 'admin1', 'admin', 0, ''],
    [2, 'reg1', 'registrar', 0, ''],
    [3, 'nurse1', 'nurse', 0, ''],
    [4, 'hdoc1', 'doctor', 1, 'Терапия'],
    [5, 'doc1', 'doctor', 1, 'Хирургия'],
    [6, 'doc2', 'doctor', 1, 'Неврология'],
    [7, 'cash1', 'cashier', 0, ''],
    [8, 'admdoc', 'admin', 1, ''],
  ];
  for (const [id, username, role, isDoctor, specialty] of users) {
    db.prepare('INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, specialty) VALUES (?,?,?,?,?,?,?)')
      .run(id, username, 'x', username, role, isDoctor, specialty);
  }
  const patientId = db.prepare("INSERT INTO patients (full_name) VALUES ('Иванов Иван')").run().lastInsertRowid;
  const wardId = db.prepare("INSERT INTO wards (name) VALUES ('Терапия')").run().lastInsertRowid;
  const bedId = db.prepare("INSERT INTO beds (code, ward_id, status) VALUES ('T-1', ?, 'free')").run(wardId).lastInsertRowid;
  return { db, patientId, wardId, bedId };
}

/** Пациент на койке ровно так, как его туда кладёт окно медсестры (Задача 2). */
function inBed(ctx) {
  const { admission } = admissionOrderCreate(ctx.db, { patient_id: ctx.patientId, department: 'Терапия' }, registrar);
  const res = admissionAdmit(ctx.db, { admission_id: admission.id, bed_id: ctx.bedId }, nurse);
  return res.admission;
}

const EXAM = {
  complaints: 'Боли в правой подвздошной области',
  objective: 'Состояние средней тяжести, живот напряжён',
  diagnosis: 'Острый аппендицит',
  plan: 'Стол №0, инфузионная терапия, консультация хирурга',
};

const ORDER = { kind: 'med', name: 'Цефтриаксон', dose: '1 г', route: 'в/м', freq_code: '2x' };

// ─── 1. Заголовочное требование владельца, целиком ──────────────────────────

test('СКВОЗЬ ВЕСЬ МАРШРУТ: назначения невозможны до осмотра и возможны после лечащего врача', () => {
  const ctx = seed();
  const adm = inBed(ctx);
  assert.equal(adm.status, 'admitted');

  // Койка есть, осмотра нет — назначать нечего и некому, и отказ называет,
  // кого ждут (решение владельца дословно).
  assert.throws(() => treatmentOrderCreate(ctx.db, { admission_id: adm.id, ...ORDER }, doctor),
    (e) => e instanceof RpcError && /не осмотрен главным врачом/.test(e.message),
    'назначение до первичного осмотра обязано быть отвергнуто');

  // Осмотр главного врача.
  const exam = admissionReviewSave(ctx.db, { admission_id: adm.id, kind: 'primary', ...EXAM, publish: true }, headDoctor);
  assert.equal(exam.admission.status, 'examined');

  // Осмотр есть, лечащего врача нет — по-прежнему нельзя, но отказ ДРУГОЙ:
  // экран обязан сказать, какого шага не хватает СЕЙЧАС.
  assert.throws(() => treatmentOrderCreate(ctx.db, { admission_id: adm.id, ...ORDER }, doctor),
    (e) => e instanceof RpcError && /Лечащий врач ещё не назначен/.test(e.message));

  // Лечащий врач — и лечение открыто.
  const set = admissionSetAttending(ctx.db, { admission_id: adm.id, doctor_id: doctor.id }, headDoctor);
  assert.equal(set.admission.status, 'active');
  assert.equal(set.admission.attending_doctor_id, doctor.id);

  const { order } = treatmentOrderCreate(ctx.db, { admission_id: adm.id, ...ORDER }, doctor);
  assert.equal(order.name, 'Цефтриаксон');
  assert.equal(order.prescribed_by, doctor.id);

  // …и только СВОЙ лечащий врач: чужой по-прежнему получает отказ.
  assert.throws(() => treatmentOrderCreate(ctx.db, { admission_id: adm.id, ...ORDER }, doctor2),
    (e) => e instanceof RpcError && e.status === 403 && /лечащий врач этого пациента/.test(e.message));
  ctx.db.close();
});

// ─── 2. Кто публикует первичный осмотр ──────────────────────────────────────

test('первичный осмотр публикует главный врач: admitted → examined, с подписью шага', () => {
  const ctx = seed();
  const adm = inBed(ctx);
  const res = admissionReviewSave(ctx.db, { admission_id: adm.id, kind: 'primary', ...EXAM, publish: true }, headDoctor);

  assert.equal(res.published, true);
  assert.equal(res.admission.status, 'examined');
  assert.equal(res.admission.examined_by, headDoctor.id, 'шаг подписан тем, кто его сделал');
  assert.ok(res.admission.examined_at);

  const r = res.review;
  assert.equal(r.kind, 'primary');
  assert.equal(r.diagnosis, 'Острый аппендицит');
  assert.equal(r.plan, EXAM.plan);
  assert.ok(r.published_at);
  // РОЛЬ, КОТОРОЙ ВОСПОЛЬЗОВАЛИСЬ, а не основная роль человека: главный врач
  // остаётся врачом, и через год по extra_roles этого уже не восстановить.
  assert.equal(r.author_role, 'head_doctor');
  assert.equal(r.author_id, headDoctor.id);
  ctx.db.close();
});

test('обычный врач опубликовать первичный осмотр не может — и отказ называет, кто может', () => {
  const ctx = seed();
  const adm = inBed(ctx);
  assert.throws(() => admissionReviewSave(ctx.db, { admission_id: adm.id, kind: 'primary', ...EXAM, publish: true }, doctor),
    (e) => e instanceof RpcError && e.status === 403
        && /Первичный осмотр/.test(e.message)
        && /главный врач/.test(e.message) && /администратор/.test(e.message),
    'отказ обязан назвать действие и тех, кто его делает');

  // И маршрут не сдвинулся ни на шаг.
  assert.equal(ctx.db.prepare('SELECT status FROM admissions WHERE id=?').get(adm.id).status, 'admitted');
  assert.equal(ctx.db.prepare('SELECT COUNT(*) n FROM admission_reviews').get().n, 0,
    'отказанная публикация не оставляет за собой записи');

  // Медсестре и кассиру запись недоступна вовсе — это врачебный документ.
  for (const who of [nurse, cashier]) {
    assert.throws(() => admissionReviewSave(ctx.db, { admission_id: adm.id, kind: 'primary', ...EXAM }, who),
      (e) => e instanceof RpcError && e.status === 403);
  }
  ctx.db.close();
});

test('администратор проводит первичный осмотр, когда главного врача нет на месте', () => {
  const ctx = seed();
  const adm = inBed(ctx);
  const res = admissionReviewSave(ctx.db, { admission_id: adm.id, kind: 'primary', ...EXAM, publish: true }, admin);
  assert.equal(res.admission.status, 'examined');
  assert.equal(res.review.author_role, 'admin');
  ctx.db.close();
});

test('осматривают ЛЕЖАЩЕГО: у заявки без койки осмотр не публикуется', () => {
  const ctx = seed();
  const { admission } = admissionOrderCreate(ctx.db, { patient_id: ctx.patientId }, registrar);
  assert.throws(() => admissionReviewSave(ctx.db, { admission_id: admission.id, kind: 'primary', ...EXAM, publish: true }, headDoctor),
    (e) => e instanceof RpcError && /не размещён на койке/.test(e.message));
  assert.equal(ctx.db.prepare('SELECT status FROM admissions WHERE id=?').get(admission.id).status, 'ordered');
  ctx.db.close();
});

// ─── 3. Черновик — не публикация ────────────────────────────────────────────

test('ЧЕРНОВИК не двигает маршрут, правится автором и дописывается до публикации', () => {
  const ctx = seed();
  const adm = inBed(ctx);

  const draft = admissionReviewSave(ctx.db, { admission_id: adm.id, kind: 'primary', complaints: EXAM.complaints }, headDoctor);
  assert.equal(draft.published, false);
  assert.equal(draft.review.published_at, null);
  assert.equal(draft.admission.status, 'admitted', 'черновик — ещё не осмотр: маршрут стоит');
  assert.equal(ctx.db.prepare('SELECT examined_at FROM admissions WHERE id=?').get(adm.id).examined_at, null);

  // Дописали — та же строка, а не вторая.
  const again = admissionReviewSave(ctx.db, {
    admission_id: adm.id, review_id: draft.review.id, kind: 'primary', ...EXAM,
  }, headDoctor);
  assert.equal(again.review.id, draft.review.id);
  assert.equal(again.review.objective, EXAM.objective);
  assert.equal(again.admission.status, 'admitted');
  assert.equal(ctx.db.prepare('SELECT COUNT(*) n FROM admission_reviews').get().n, 1);

  // Опубликовали — вот теперь шаг.
  const pub = admissionReviewSave(ctx.db, {
    admission_id: adm.id, review_id: draft.review.id, kind: 'primary', ...EXAM, publish: true,
  }, headDoctor);
  assert.equal(pub.admission.status, 'examined');
  assert.ok(pub.review.published_at);
  ctx.db.close();
});

test('чужой черновик правит только его автор (и администратор), опубликованный — никто', () => {
  const ctx = seed();
  const adm = inBed(ctx);
  const draft = admissionReviewSave(ctx.db, { admission_id: adm.id, complaints: 'Мой черновик' }, doctor);

  assert.throws(() => admissionReviewSave(ctx.db, { admission_id: adm.id, review_id: draft.review.id, complaints: 'Правка' }, doctor2),
    (e) => e instanceof RpcError && e.status === 403 && /автор/.test(e.message));

  const pub = admissionReviewSave(ctx.db, { admission_id: adm.id, kind: 'primary', ...EXAM, publish: true }, headDoctor);
  assert.throws(() => admissionReviewSave(ctx.db, { admission_id: adm.id, review_id: pub.review.id, diagnosis: 'Другое' }, headDoctor),
    (e) => e instanceof RpcError && /не переписывают/.test(e.message));
  ctx.db.close();
});

// ─── 4. Исправление ─────────────────────────────────────────────────────────

test('ИСПРАВЛЕНИЕ создаёт новую запись и закрывает прежнюю, не трогая её текст', () => {
  const ctx = seed();
  const adm = inBed(ctx);
  const first = admissionReviewSave(ctx.db, { admission_id: adm.id, kind: 'primary', ...EXAM, publish: true }, headDoctor);
  assert.equal(first.admission.status, 'examined');

  const fixed = admissionReviewSave(ctx.db, {
    admission_id: adm.id, kind: 'primary', ...EXAM, diagnosis: 'Острый холецистит', publish: true,
  }, headDoctor);

  assert.notEqual(fixed.review.id, first.review.id, 'исправление — новая запись, а не UPDATE');
  assert.equal(fixed.admission.status, 'examined', 'пациент уже осмотрен — второй раз маршрут не двигается');

  const old = ctx.db.prepare('SELECT * FROM admission_reviews WHERE id=?').get(first.review.id);
  assert.equal(old.diagnosis, 'Острый аппендицит', 'прежний диагноз остался в истории болезни');
  assert.equal(old.superseded_by, fixed.review.id, 'и закрыт ссылкой на исправление');
  assert.ok(old.published_at, 'прежняя публикация не отменяется задним числом');

  const current = ctx.db.prepare(
    "SELECT id FROM admission_reviews WHERE admission_id=? AND kind='primary' AND published_at IS NOT NULL AND superseded_by IS NULL"
  ).all(adm.id);
  assert.deepEqual(current.map((r) => r.id), [fixed.review.id], 'действующий первичный осмотр ровно один');
  ctx.db.close();
});

test('после назначения лечащего врача первичный осмотр правят обходом, а не переписыванием', () => {
  const ctx = seed();
  const adm = inBed(ctx);
  admissionReviewSave(ctx.db, { admission_id: adm.id, kind: 'primary', ...EXAM, publish: true }, headDoctor);
  admissionSetAttending(ctx.db, { admission_id: adm.id, doctor_id: doctor.id }, headDoctor);

  assert.throws(() => admissionReviewSave(ctx.db, { admission_id: adm.id, kind: 'primary', ...EXAM, publish: true }, headDoctor),
    (e) => e instanceof RpcError && /записью обхода/.test(e.message));
  ctx.db.close();
});

// ─── 5. Лечащий врач ────────────────────────────────────────────────────────

test('лечащего врача назначает главный врач: examined → active', () => {
  const ctx = seed();
  const adm = inBed(ctx);
  admissionReviewSave(ctx.db, { admission_id: adm.id, kind: 'primary', ...EXAM, publish: true }, headDoctor);

  assert.throws(() => admissionSetAttending(ctx.db, { admission_id: adm.id, doctor_id: doctor.id }, doctor),
    (e) => e instanceof RpcError && e.status === 403
        && /Назначение лечащего врача/.test(e.message) && /главный врач/.test(e.message));
  assert.throws(() => admissionSetAttending(ctx.db, { admission_id: adm.id, doctor_id: doctor.id }, nurse),
    (e) => e instanceof RpcError && e.status === 403);

  const res = admissionSetAttending(ctx.db, { admission_id: adm.id, doctor_id: doctor.id }, headDoctor);
  assert.equal(res.admission.status, 'active');
  assert.equal(res.admission.attending_doctor_id, doctor.id);
  assert.equal(res.attending.full_name, 'doc1');
  // doctor_id (НАПРАВИВШИЙ) и attending_doctor_id (ЛЕЧАЩИЙ) — два разных вопроса
  // к строке, и путать их дорого: консоль койки ставила направившего в услуги и
  // выдачи, и деньги за работу лечащего доставались ему (I4). Правило теперь
  // такое: пустое ЗАПОЛНЯЕТСЯ, заполненное НЕ ТРОГАЕТСЯ. У этой заявки
  // направившего не было — прочерк в старых отчётах хуже, чем лечащий врач.
  assert.equal(res.admission.doctor_id, doctor.id, 'пустой doctor_id заполняется лечащим');
  ctx.db.close();
});

test('направивший врач НЕ затирается лечащим, когда он есть', () => {
  const ctx = seed();
  const adm = inBed(ctx);
  // Заявку прислал doctor2 — он направивший, и таким должен остаться.
  ctx.db.prepare('UPDATE admissions SET doctor_id = ? WHERE id = ?').run(doctor2.id, adm.id);
  admissionReviewSave(ctx.db, { admission_id: adm.id, kind: 'primary', ...EXAM, publish: true }, headDoctor);

  const res = admissionSetAttending(ctx.db, { admission_id: adm.id, doctor_id: doctor.id }, headDoctor);
  assert.equal(res.admission.attending_doctor_id, doctor.id);
  assert.equal(res.admission.doctor_id, doctor2.id, 'кто прислал пациента — не должно потеряться');
  ctx.db.close();
});

test('лечащим врачом можно назначить только ВРАЧА — и признак берётся не из текста роли', () => {
  const ctx = seed();
  const adm = inBed(ctx);
  admissionReviewSave(ctx.db, { admission_id: adm.id, kind: 'primary', ...EXAM, publish: true }, headDoctor);

  // Медсестра, кассир, регистратура — не врачи.
  for (const id of [nurse.id, cashier.id, registrar.id]) {
    assert.throws(() => admissionSetAttending(ctx.db, { admission_id: adm.id, doctor_id: id }, headDoctor),
      (e) => e instanceof RpcError && /только врача/.test(e.message), `user ${id}`);
  }
  assert.throws(() => admissionSetAttending(ctx.db, { admission_id: adm.id, doctor_id: 999 }, headDoctor),
    /Врач не найден/);
  assert.equal(ctx.db.prepare('SELECT status FROM admissions WHERE id=?').get(adm.id).status, 'examined');

  // ADMIN_DOCTOR_LIST_V1 — администратор клиники, который ВРАЧ: role='admin',
  // специальности нет, и только is_doctor говорит правду. Отфильтруй мы по
  // тексту роли — этого человека нельзя было бы назначить лечащим врачом
  // собственного пациента.
  assert.equal(isDoctorRow({ role: 'admin', is_doctor: 1, specialty: '' }), true);
  assert.equal(isDoctorRow({ role: 'nurse', is_doctor: 0, specialty: '' }), false);
  const res = admissionSetAttending(ctx.db, { admission_id: adm.id, doctor_id: adminDoctor.id }, headDoctor);
  assert.equal(res.admission.status, 'active');
  assert.equal(res.admission.attending_doctor_id, adminDoctor.id);
  ctx.db.close();
});

test('лечащего врача не назначают до осмотра и не переназначают походя', () => {
  const ctx = seed();
  const adm = inBed(ctx);
  assert.throws(() => admissionSetAttending(ctx.db, { admission_id: adm.id, doctor_id: doctor.id }, headDoctor),
    (e) => e instanceof RpcError && /не осмотрен главным врачом/.test(e.message));

  admissionReviewSave(ctx.db, { admission_id: adm.id, kind: 'primary', ...EXAM, publish: true }, headDoctor);
  admissionSetAttending(ctx.db, { admission_id: adm.id, doctor_id: doctor.id }, headDoctor);
  assert.throws(() => admissionSetAttending(ctx.db, { admission_id: adm.id, doctor_id: doctor2.id }, headDoctor),
    (e) => e instanceof RpcError && /уже назначен/.test(e.message));
  ctx.db.close();
});

// ─── 6. Обходы ──────────────────────────────────────────────────────────────

test('обход пишет лечащий врач или главный — и только по начатому лечению', () => {
  const ctx = seed();
  const adm = inBed(ctx);
  admissionReviewSave(ctx.db, { admission_id: adm.id, kind: 'primary', ...EXAM, publish: true }, headDoctor);

  // До лечащего врача обход публиковать не по чему.
  assert.throws(() => admissionReviewSave(ctx.db, { admission_id: adm.id, kind: 'round', body: 'Осмотрен', publish: true }, headDoctor),
    (e) => e instanceof RpcError && /Лечащий врач ещё не назначен/.test(e.message));

  admissionSetAttending(ctx.db, { admission_id: adm.id, doctor_id: doctor.id }, headDoctor);

  const round = admissionReviewSave(ctx.db, {
    admission_id: adm.id, kind: 'round', objective: 'Динамика положительная', plan: 'Продолжить', publish: true,
  }, doctor);
  assert.equal(round.review.kind, 'round');
  assert.equal(round.review.author_role, 'doctor');
  assert.equal(round.admission.status, 'active', 'обход маршрут не двигает');

  // Главный врач обходит всё отделение; чужой врач — нет.
  assert.ok(admissionReviewSave(ctx.db, { admission_id: adm.id, kind: 'round', body: 'Консультация', publish: true }, headDoctor).review.id);
  assert.throws(() => admissionReviewSave(ctx.db, { admission_id: adm.id, kind: 'round', body: 'Чужой', publish: true }, doctor2),
    (e) => e instanceof RpcError && e.status === 403);
  ctx.db.close();
});

// ─── 7. Чтение ──────────────────────────────────────────────────────────────

test('список записей: опубликованные видят все, кто ведёт пациента; черновик — автор', () => {
  const ctx = seed();
  const adm = inBed(ctx);
  const draft = admissionReviewSave(ctx.db, { admission_id: adm.id, complaints: 'Черновик врача' }, doctor);
  admissionReviewSave(ctx.db, { admission_id: adm.id, kind: 'primary', ...EXAM, publish: true }, headDoctor);

  const forNurse = admissionReviewsList(ctx.db, { admission_id: adm.id }, nurse);
  assert.equal(forNurse.reviews.length, 1, 'медсестра видит документ, но не чужой черновик');
  assert.equal(forNurse.status, 'examined');
  assert.equal(forNurse.reviews[0].author_name, 'hdoc1');

  const forAuthor = admissionReviewsList(ctx.db, { admission_id: adm.id }, doctor);
  assert.equal(forAuthor.reviews.length, 2);
  assert.ok(forAuthor.reviews.some((r) => r.id === draft.review.id));

  // Главный врач видит и черновики: ему их дописывать.
  assert.equal(admissionReviewsList(ctx.db, { admission_id: adm.id }, headDoctor).reviews.length, 2);

  // Касса в историю болезни не ходит.
  assert.throws(() => admissionReviewsList(ctx.db, { admission_id: adm.id }, cashier),
    (e) => e instanceof RpcError && e.status === 403);
  ctx.db.close();
});

// ─── 8. Никто не заперт в койке ─────────────────────────────────────────────

test('осмотренного пациента без лечащего врача всё равно можно выписать', () => {
  const ctx = seed();
  const adm = inBed(ctx);
  admissionReviewSave(ctx.db, { admission_id: adm.id, kind: 'primary', ...EXAM, publish: true }, headDoctor);

  // Прямая выписка осталась только для тех, кого положили ДО обновления
  // (isLegacyAdmission, rpc/inpatient.js) — а именно у них и не бывает ни
  // осмотра, ни лечащего врача, ни эпикриза.
  ctx.db.prepare("UPDATE admissions SET created_at = '2000-01-01T00:00:00Z' WHERE id = ?").run(adm.id);
  const res = dischargePatient(ctx.db, { admission_id: adm.id }, admin);
  assert.equal(res.admission.status, 'discharged');
  // …и после выписки маршрут закрыт для всего остального.
  assert.throws(() => assertCanPrescribe(ctx.db, adm.id, doctor), /уже выписан/);
  assert.throws(() => admissionSetAttending(ctx.db, { admission_id: adm.id, doctor_id: doctor.id }, headDoctor),
    /уже выписан/);
  ctx.db.close();
});


// ═══ 9. СМЕНА ЛЕЧАЩЕГО ВРАЧА (must-fix 3 + I3) ══════════════════════════════
//
// `admission_set_attending` отказывал словами «смена лечащего врача делается
// отдельно», и НИЧЕГО ОТДЕЛЬНОГО НЕ СУЩЕСТВОВАЛО. Стоило это дорого дважды:
// врач ушёл в отпуск — пациента некому вести; и, что хуже, миграция 091
// переносит attending_doctor_id := doctor_id, а старый admit_patient разрешал
// класть пациента БЕЗ ВРАЧА. На живом отделении это десятки открытых
// госпитализаций с пустым лечащим: назначения им отвечают 403 всем без
// исключения, а set_attending отказывает, потому что смотрит на СТАТУС.
// Пациент лежит, лечить его нельзя, и починить нечем.

/** Госпитализация в лечении, с лечащим врачом. */
function inTreatment(ctx, attending = doctor) {
  const adm = inBed(ctx);
  admissionReviewSave(ctx.db, { admission_id: adm.id, kind: 'primary', ...EXAM, publish: true }, headDoctor);
  return admissionSetAttending(ctx.db, { admission_id: adm.id, doctor_id: attending.id }, headDoctor).admission;
}

test('смену лечащего врача делает главный врач; рядовому врачу и медсестре — отказ', () => {
  const ctx = seed();
  const adm = inTreatment(ctx);

  for (const who of [doctor, doctor2, nurse, cashier, registrar]) {
    assert.throws(() => admissionChangeAttending(ctx.db, { admission_id: adm.id, doctor_id: doctor2.id, reason: 'отпуск' }, who),
      (e) => e instanceof RpcError && e.status === 403 && /Смена лечащего врача/.test(e.message),
      'роль ' + who.role + ' не должна менять лечащего врача');
  }
  // Подпись под лечением не переписана ни одной из отвергнутых попыток.
  assert.equal(ctx.db.prepare('SELECT attending_doctor_id a FROM admissions WHERE id=?').get(adm.id).a, doctor.id);

  const res = admissionChangeAttending(ctx.db, { admission_id: adm.id, doctor_id: doctor2.id, reason: 'врач в отпуске' }, headDoctor);
  assert.equal(res.changed, true);
  assert.equal(res.admission.attending_doctor_id, doctor2.id);
  assert.equal(res.previous_attending_doctor_id, doctor.id);
  assert.equal(res.admission.status, 'active', 'смена врача не двигает маршрут');

  // Событие записано туда же, где живут заявка, поступление и переводы, — с
  // именами, чтобы разбор через полгода не ходил в users за каждой строкой.
  const log = ctx.db.prepare("SELECT * FROM admission_transfers WHERE admission_id=? AND kind='attending'").get(adm.id);
  assert.ok(log, 'смена лечащего врача обязана остаться в журнале движений');
  assert.equal(log.transferred_by, headDoctor.id);
  assert.match(log.reason, /doc1/);
  assert.match(log.reason, /doc2/);
  assert.match(log.reason, /врач в отпуске/);
  ctx.db.close();
});

test('лечащим можно поставить только врача, и только пока идёт лечение', () => {
  const ctx = seed();
  const adm = inTreatment(ctx);

  // Не врач — тем же признаком, что и при назначении (is_doctor, а не текст роли).
  for (const id of [nurse.id, cashier.id, registrar.id]) {
    assert.throws(() => admissionChangeAttending(ctx.db, { admission_id: adm.id, doctor_id: id, reason: 'причина' }, headDoctor),
      (e) => e instanceof RpcError && /только врача/.test(e.message), 'user ' + id);
  }
  // Уволенного — нельзя.
  ctx.db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(doctor2.id);   // active — генерируемая колонка (032)
  assert.throws(() => admissionChangeAttending(ctx.db, { admission_id: adm.id, doctor_id: doctor2.id, reason: 'причина' }, headDoctor),
    (e) => /уволен/.test(e.message));
  ctx.db.prepare('UPDATE users SET is_active = 1 WHERE id = ?').run(doctor2.id);

  // Смена БЕЗ причины — отказ: за заменой врача посреди лечения завтра придут.
  assert.throws(() => admissionChangeAttending(ctx.db, { admission_id: adm.id, doctor_id: doctor2.id }, headDoctor),
    (e) => /причину смены/.test(e.message));

  // Администратор клиники, который врач (role='admin', is_doctor=1), — годится.
  assert.equal(
    admissionChangeAttending(ctx.db, { admission_id: adm.id, doctor_id: adminDoctor.id, reason: 'передан' }, admin)
      .admission.attending_doctor_id, adminDoctor.id);

  // До лечения лечащего НАЗНАЧАЮТ, а не меняют; после выписки — некому.
  const ctx2 = seed();
  const early = inBed(ctx2);
  assert.throws(() => admissionChangeAttending(ctx2.db, { admission_id: early.id, doctor_id: doctor.id }, headDoctor),
    (e) => /ещё не назначали/.test(e.message));
  ctx2.db.prepare("UPDATE admissions SET status='discharged' WHERE id=?").run(early.id);
  assert.throws(() => admissionChangeAttending(ctx2.db, { admission_id: early.id, doctor_id: doctor.id }, headDoctor),
    (e) => /уже выписан/.test(e.message));
  ctx.db.close(); ctx2.db.close();
});

// I3 — ГЛАВНОЕ. Мигрировавшая госпитализация с пустым лечащим врачом: до этого
// RPC её нельзя было ни лечить, ни починить.
test('I3: госпитализация без лечащего врача СПАСАЕТСЯ — и после этого по ней можно назначать', () => {
  const ctx = seed();
  const adm = inTreatment(ctx);
  // Ровно то, что делает миграция 091 со строкой, положенной старым
  // admit_patient без врача: attending_doctor_id := doctor_id := NULL.
  ctx.db.prepare('UPDATE admissions SET attending_doctor_id = NULL, doctor_id = NULL WHERE id = ?').run(adm.id);

  // Тупик, каким он был: лечить нельзя…
  assert.throws(() => assertCanPrescribe(ctx.db, adm.id, doctor),
    (e) => e.status === 403 && /лечащий врач/.test(e.message));
  assert.throws(() => treatmentOrderCreate(ctx.db, { admission_id: adm.id, ...ORDER }, doctor),
    (e) => e.status === 403);
  // …и назначить врача старым способом тоже нельзя: он смотрит на статус.
  assert.throws(() => admissionSetAttending(ctx.db, { admission_id: adm.id, doctor_id: doctor.id }, headDoctor),
    (e) => /уже назначен/.test(e.message) && /отдельно/.test(e.message));

  // Спасение. Причина здесь НЕ обязательна: это не смена, а назначение —
  // требовать объяснения за починку данных значит мешать чинить.
  const res = admissionChangeAttending(ctx.db, { admission_id: adm.id, doctor_id: doctor.id }, headDoctor);
  assert.equal(res.changed, true);
  assert.equal(res.previous_attending_doctor_id, null);
  assert.equal(res.admission.attending_doctor_id, doctor.id);
  assert.equal(res.admission.doctor_id, doctor.id, 'пустой doctor_id заполняется — прочерк в отчётах не ответ');

  // И ГЛАВНОЕ: назначение теперь ПРОХОДИТ. Без этой строки тест доказывал бы
  // только то, что колонка записалась.
  const order = treatmentOrderCreate(ctx.db, { admission_id: adm.id, ...ORDER }, doctor);
  assert.ok(order.order && order.order.id, 'лечащий врач обязан суметь назначить лечение');
  ctx.db.close();
});

test('повторная смена на того же врача ничего не меняет и не плодит записей в журнале', () => {
  const ctx = seed();
  const adm = inTreatment(ctx);
  const res = admissionChangeAttending(ctx.db, { admission_id: adm.id, doctor_id: doctor.id, reason: 'повтор' }, headDoctor);
  assert.equal(res.changed, false);
  assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM admission_transfers WHERE admission_id=? AND kind='attending'").get(adm.id).n, 0);
  ctx.db.close();
});

test('лечащего врача можно сменить и когда заявка на выписку уже подана', () => {
  const ctx = seed();
  const adm = inTreatment(ctx);
  ctx.db.prepare("UPDATE admissions SET status='discharging' WHERE id=?").run(adm.id);
  const res = admissionChangeAttending(ctx.db, { admission_id: adm.id, doctor_id: doctor2.id, reason: 'смена дежурного' }, headDoctor);
  assert.equal(res.admission.attending_doctor_id, doctor2.id);
  assert.equal(res.admission.status, 'discharging', 'смена врача не двигает маршрут');
  ctx.db.close();
});

// ─── 10. КОГО МОЖНО НАЗНАЧИТЬ ЛЕЧАЩИМ — ОДИН СПИСОК НА ЭКРАН И НА СЕРВЕР ────
//
// Окно «Назначить лечащего врача» показывало пустой выпадающий список при
// полной клинике врачей: оно спрашивало у таблицы users колонку, которой реестр
// не отдаёт, и получало отказ ВСЕМУ запросу. Причина класса — в том, что список
// строился ОТДЕЛЬНО от правила, которым сервер потом проверяет выбранного.
// Здесь эти двое сведены в одну функцию, и тесты держат их вместе: список
// сверяется не с переписанным от руки перечнем, а с САМИМ предикатом
// isDoctorRow, которым назначение и отказывает.

test('список кандидатов = ровно те, кого примет isDoctorRow (и админ-врач в нём есть)', () => {
  const ctx = seed();
  const { doctors } = admissionAttendingCandidates(ctx.db, {}, headDoctor);
  const ids = doctors.map((d) => d.id).sort((a, b) => a - b);

  // Ожидание считается ТЕМ ЖЕ предикатом по ТОЙ ЖЕ базе: разойтись экрану и
  // серверу тут физически нечем — переписанный от руки список разошёлся бы.
  const expected = ctx.db.prepare('SELECT * FROM users').all()
    .filter((u) => isDoctorRow(u) && u.active !== 0)
    .map((u) => u.id).sort((a, b) => a - b);
  assert.deepEqual(ids, expected);

  // …и по именам: врач с role='doctor' — есть; администратор-врач (role='admin',
  // специальности нет, только is_doctor) — ЕСТЬ; касса, регистратура и
  // медсестра — нет.
  assert.ok(ids.includes(doctor.id), 'врача в списке нет');
  assert.ok(ids.includes(headDoctor.id), 'главного врача в списке нет');
  assert.ok(ids.includes(adminDoctor.id),
    'ADMIN_DOCTOR_LIST_V1: администратор-врач обязан быть в списке — сервер его принимает');
  for (const id of [cashier.id, registrar.id, nurse.id, admin.id]) {
    assert.ok(!ids.includes(id), 'в списке врачей оказался не врач: ' + id);
  }
  ctx.db.close();
});

test('СПИСОК И ПРОВЕРКА НЕ РАСХОДЯТСЯ: каждого из списка сервер принимает, никого вне списка — нет', () => {
  const ctx = seed();
  const { doctors } = admissionAttendingCandidates(ctx.db, {}, headDoctor);
  const offered = new Set(doctors.map((d) => d.id));

  for (const u of ctx.db.prepare('SELECT id FROM users').all()) {
    // Каждому кандидату — своя госпитализация, чтобы проверка была про ЧЕЛОВЕКА,
    // а не про состояние одной строки.
    const c = seed();
    const adm = inBed(c);
    admissionReviewSave(c.db, { admission_id: adm.id, kind: 'primary', ...EXAM, publish: true }, headDoctor);
    if (offered.has(u.id)) {
      const res = admissionSetAttending(c.db, { admission_id: adm.id, doctor_id: u.id }, headDoctor);
      assert.equal(res.admission.status, 'active',
        'экран предлагает ' + u.id + ', а сервер его не принимает');
    } else {
      assert.throws(() => admissionSetAttending(c.db, { admission_id: adm.id, doctor_id: u.id }, headDoctor),
        (e) => e instanceof RpcError,
        'сервер принимает ' + u.id + ', которого экран не показывает');
    }
    c.db.close();
  }
  ctx.db.close();
});

test('уволенный врач: из списка убран, посчитан отдельно, и сервер его тоже не принимает', () => {
  const ctx = seed();
  ctx.db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(doctor2.id);

  const res = admissionAttendingCandidates(ctx.db, {}, headDoctor);
  assert.ok(!res.doctors.some((d) => d.id === doctor2.id), 'уволенный врач остался в списке');
  assert.equal(res.dismissed, 1,
    'уволенных надо СЧИТАТЬ: «врачей нет» и «все врачи уволены» — разные беды с разными починками');

  const adm = inBed(ctx);
  admissionReviewSave(ctx.db, { admission_id: adm.id, kind: 'primary', ...EXAM, publish: true }, headDoctor);
  assert.throws(() => admissionSetAttending(ctx.db, { admission_id: adm.id, doctor_id: doctor2.id }, headDoctor),
    (e) => e instanceof RpcError && /уволен/.test(e.message));
  ctx.db.close();
});

test('клиника без врачей отвечает пустым списком и НУЛЁМ уволенных — это не то же, что «все уволены»', () => {
  const ctx = seed();
  ctx.db.prepare('DELETE FROM users WHERE id NOT IN (?, ?, ?)').run(admin.id, nurse.id, cashier.id);
  ctx.db.prepare('UPDATE users SET is_doctor = 0, specialty = ?, license_number = ? WHERE id = ?').run('', '', admin.id);

  const res = admissionAttendingCandidates(ctx.db, {}, headDoctor);
  assert.equal(res.doctors.length, 0);
  assert.equal(res.dismissed, 0, 'врачей нет вовсе — уволенных считать не из кого');
  ctx.db.close();
});

test('список врачей спрашивают те же, кто вправе назначить: касса и медсестра получают отказ ролью', () => {
  const ctx = seed();
  assert.ok(admissionAttendingCandidates(ctx.db, {}, admin).doctors.length > 0);
  for (const who of [nurse, cashier, registrar, doctor]) {
    assert.throws(() => admissionAttendingCandidates(ctx.db, {}, who),
      (e) => e instanceof RpcError && e.status === 403,
      'список врачей шире права его применить: ' + who.role);
  }
  ctx.db.close();
});
