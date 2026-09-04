// ADMISSION_ORDER_V1 — заявка на госпитализацию и размещение на койке.
//
// Проверяется первый отрезок маршрута владельца: «регистрация пациента →
// ЗАЯВКА → медсестра КЛАДЁТ НА КОЙКУ». Три вопроса, и каждый — про сервер:
//   • заявка рождается там, где её увидит медсестра (и заявка ВРАЧА тоже);
//   • размещение занимает койку и подписывает шаг;
//   • каждый отказ имеет СВОЙ текст: «на уборке», «в ремонте», «из другой
//     палаты», «уже на койке» — человек у экрана должен понять, что делать,
//     а не что «нельзя».
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { admissionOrderCreate, admissionOrderCancel, admissionAdmit, requestAdmission, admitPatient } from './inpatient.js';
import { OPEN_STATUSES, IN_BED_STATUSES } from './inpatient-flow.js';

// Носитель роли. Надстроечные (head_doctor / senior_nurse) человек носит ТОЛЬКО
// в extra_roles — врач остаётся врачом, медсестра медсестрой (миграция 091).
function actor(role, id) {
  return ['head_doctor', 'senior_nurse'].includes(role)
    ? { id, role: role === 'head_doctor' ? 'doctor' : 'nurse', extra_roles: [role] }
    : { id, role };
}

const admin       = actor('admin', 1);
const registrar   = actor('registrar', 2);
const nurse       = actor('nurse', 3);
const doctor      = actor('doctor', 4);
const cashier     = actor('cashier', 5);
const lab         = actor('lab', 6);
const seniorNurse = actor('senior_nurse', 7);
const headDoctor  = actor('head_doctor', 8);

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  for (const [id, username, role] of [
    [1, 'admin1', 'admin'], [2, 'reg1', 'registrar'], [3, 'nurse1', 'nurse'],
    [4, 'doc1', 'doctor'], [5, 'cash1', 'cashier'], [6, 'lab1', 'lab'],
    [7, 'snurse1', 'nurse'], [8, 'hdoc1', 'doctor'], [9, 'inv1', 'inventory'],
  ]) {
    db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?,?,?,?)').run(id, username, 'x', role);
  }
  const p1 = db.prepare("INSERT INTO patients (full_name) VALUES ('Иванов Иван')").run().lastInsertRowid;
  const p2 = db.prepare("INSERT INTO patients (full_name) VALUES ('Петров Пётр')").run().lastInsertRowid;

  const wardA = db.prepare("INSERT INTO wards (name) VALUES ('Терапия')").run().lastInsertRowid;
  const wardB = db.prepare("INSERT INTO wards (name) VALUES ('Хирургия')").run().lastInsertRowid;

  const bedA1 = db.prepare("INSERT INTO beds (code, ward_id, status) VALUES ('A-1', ?, 'free')").run(wardA).lastInsertRowid;
  const bedA2 = db.prepare("INSERT INTO beds (code, ward_id, status) VALUES ('A-2', ?, 'free')").run(wardA).lastInsertRowid;
  const bedB1 = db.prepare("INSERT INTO beds (code, ward_id, status) VALUES ('B-1', ?, 'free')").run(wardB).lastInsertRowid;
  const bedClean = db.prepare("INSERT INTO beds (code, ward_id, status) VALUES ('A-9', ?, 'cleaning')").run(wardA).lastInsertRowid;
  const bedFix = db.prepare("INSERT INTO beds (code, ward_id, status) VALUES ('A-8', ?, 'maintenance')").run(wardA).lastInsertRowid;
  const bedOff = db.prepare("INSERT INTO beds (code, ward_id, status, active) VALUES ('A-7', ?, 'free', 0)").run(wardA).lastInsertRowid;

  return { db, p1, p2, wardA, wardB, bedA1, bedA2, bedB1, bedClean, bedFix, bedOff };
}

// Ровно тот запрос, которым живёт окно медсестры (views/admissions.js):
// открытые госпитализации, разложенные по состояниям.
function nurseWindow(db) {
  const rows = db.prepare(
    `SELECT * FROM admissions WHERE status IN (${OPEN_STATUSES.map((s) => `'${s}'`).join(',')}) ORDER BY id`
  ).all();
  return {
    waitingBed: rows.filter((r) => r.status === 'ordered'),
    inWard:     rows.filter((r) => IN_BED_STATUSES.includes(r.status)),
    waitingExam: rows.filter((r) => r.status === 'admitted'),
  };
}

// ─── 1. Заявка ───────────────────────────────────────────────────────────────

test('заявка регистратуры появляется в окне медсестры: «Ждут размещения», без койки, с подписью', () => {
  const { db, p1, wardA } = seed();
  const { admission } = admissionOrderCreate(db, {
    patient_id: p1, ward_id: wardA, department: 'Терапевтическое',
    admission_type: 'emergency', stay_mode: 'day',
    planned_at: '2026-09-05T08:00:00Z', note: 'Боли в животе',
  }, registrar);

  assert.equal(admission.status, 'ordered');
  assert.equal(admission.bed_id, null, 'заявка НЕ занимает койку');
  assert.equal(admission.ward_id, wardA);
  assert.equal(admission.department, 'Терапевтическое');
  assert.equal(admission.admission_type, 'emergency');
  assert.equal(admission.stay_mode, 'day');
  assert.equal(admission.planned_at, '2026-09-05T08:00:00Z');
  assert.equal(admission.chief_complaint, 'Боли в животе');
  assert.equal(admission.ordered_by, registrar.id);
  assert.ok(admission.ordered_at, 'шаг подписан временем');
  assert.match(admission.admission_no, /^ADM-\d{5}$/);

  const win = nurseWindow(db);
  assert.equal(win.waitingBed.length, 1, 'заявка видна медсестре');
  assert.equal(win.waitingBed[0].id, admission.id);
  assert.equal(win.inWard.length, 0);

  // Журнал движений знает и о заявке — «когда это началось» читается из
  // одного места вместе с поступлением.
  const log = db.prepare("SELECT kind, reason FROM admission_transfers WHERE admission_id=?").get(admission.id);
  assert.equal(log.kind, 'order');
  assert.equal(log.reason, 'Боли в животе');
});

test('заявка ВРАЧА из кабинета (request_admission) попадает в тот же список', () => {
  const { db, p1 } = seed();
  const { admission } = requestAdmission(db, { patient_id: p1, doctor_id: doctor.id, pathway: 'surgical' }, doctor);
  assert.equal(admission.status, 'ordered');
  const win = nurseWindow(db);
  assert.equal(win.waitingBed.length, 1);
  assert.equal(win.waitingBed[0].id, admission.id);
});

test('заявку оформляют регистратура, ст. медсестра, врач, главный врач и администратор — и никто больше', () => {
  for (const who of [registrar, seniorNurse, doctor, headDoctor, admin]) {
    const { db, p1 } = seed();
    assert.equal(admissionOrderCreate(db, { patient_id: p1 }, who).admission.status, 'ordered',
      `${who.role}/${(who.extra_roles || []).join()} должен мочь оформить заявку`);
  }
  for (const who of [nurse, cashier, lab, actor('inventory', 9)]) {
    const { db, p1 } = seed();
    assert.throws(() => admissionOrderCreate(db, { patient_id: p1 }, who),
      (e) => e.status === 403 && /Оформить заявку/.test(e.message),
      `${who.role} не должен оформлять заявку`);
  }
});

test('вторая заявка тому же пациенту отказывает — и пока он лежит, тоже', () => {
  const { db, p1, bedA1 } = seed();
  const a = admissionOrderCreate(db, { patient_id: p1 }, registrar).admission;
  assert.throws(() => admissionOrderCreate(db, { patient_id: p1 }, registrar), /незакрытая заявка/);

  admissionAdmit(db, { admission_id: a.id, bed_id: bedA1 }, nurse);
  assert.throws(() => admissionOrderCreate(db, { patient_id: p1 }, registrar), /уже госпитализирован/);
});

test('заявка отказывает по несуществующему пациенту, палате и неизвестному типу', () => {
  const { db, p1 } = seed();
  assert.throws(() => admissionOrderCreate(db, { patient_id: 9999 }, registrar), /Пациент не найден/);
  assert.throws(() => admissionOrderCreate(db, { patient_id: p1, ward_id: 9999 }, registrar), /Палата не найдена/);
  assert.throws(() => admissionOrderCreate(db, { patient_id: p1, admission_type: 'urgent' }, registrar), /Тип госпитализации/);
  assert.throws(() => admissionOrderCreate(db, { patient_id: p1, stay_mode: 'night' }, registrar), /Режим пребывания/);
});

// ─── 2. Размещение ───────────────────────────────────────────────────────────

test('размещение кладёт пациента на койку: состояние, койка, подпись шага', () => {
  const { db, p1, wardA, bedA1 } = seed();
  const order = admissionOrderCreate(db, { patient_id: p1, ward_id: wardA }, registrar).admission;

  const res = admissionAdmit(db, { admission_id: order.id, bed_id: bedA1 }, nurse);
  assert.equal(res.admission.status, 'admitted');
  assert.equal(res.admission.bed_id, bedA1);
  assert.equal(res.admission.ward_id, wardA);
  assert.equal(res.admission.admitted_by, nurse.id);
  assert.ok(res.admission.admitted_at);
  assert.equal(res.bed.status, 'occupied', 'койка занята');

  const win = nurseWindow(db);
  assert.equal(win.waitingBed.length, 0, 'из «Ждут размещения» ушёл');
  assert.equal(win.inWard.length, 1, 'появился «В отделении»');
  assert.equal(win.waitingExam.length, 1, 'и ждёт первичного осмотра');

  const log = db.prepare("SELECT kind, to_bed_id FROM admission_transfers WHERE admission_id=? AND kind='admit'").get(order.id);
  assert.equal(log.to_bed_id, bedA1);
});

test('кладут медсестра, старшая медсестра, главный врач и администратор — регистратуре и кассиру отказ', () => {
  for (const who of [nurse, seniorNurse, headDoctor, admin]) {
    const { db, p1, bedA1 } = seed();
    const order = admissionOrderCreate(db, { patient_id: p1 }, registrar).admission;
    assert.equal(admissionAdmit(db, { admission_id: order.id, bed_id: bedA1 }, who).admission.status, 'admitted');
  }
  for (const who of [registrar, doctor, cashier, lab]) {
    const { db, p1, bedA1 } = seed();
    const order = admissionOrderCreate(db, { patient_id: p1 }, registrar).admission;
    assert.throws(() => admissionAdmit(db, { admission_id: order.id, bed_id: bedA1 }, who),
      (e) => e.status === 403 && /Размещение на койке — недоступно вашей роли/.test(e.message),
      `${who.role} не должен класть на койку`);
  }
});

// Каждый отказ — СВОИМ текстом. «Койка недоступна» на все случаи означало бы,
// что медсестра не знает, звать ли уборщицу, техника или искать другую палату.
test('отказ: койка на уборке — говорит про уборку', () => {
  const { db, p1, bedClean } = seed();
  const order = admissionOrderCreate(db, { patient_id: p1 }, registrar).admission;
  assert.throws(() => admissionAdmit(db, { admission_id: order.id, bed_id: bedClean }, nurse), /Койка на уборке/);
  assert.equal(db.prepare('SELECT status FROM admissions WHERE id=?').get(order.id).status, 'ordered');
});

test('отказ: койка в ремонте — говорит про ремонт', () => {
  const { db, p1, bedFix } = seed();
  const order = admissionOrderCreate(db, { patient_id: p1 }, registrar).admission;
  assert.throws(() => admissionAdmit(db, { admission_id: order.id, bed_id: bedFix }, nurse), /Койка в ремонте/);
});

test('отказ: койка выведена из фонда', () => {
  const { db, p1, bedOff } = seed();
  const order = admissionOrderCreate(db, { patient_id: p1 }, registrar).admission;
  assert.throws(() => admissionAdmit(db, { admission_id: order.id, bed_id: bedOff }, nurse), /выведена из коечного фонда/);
});

test('отказ: койка не найдена', () => {
  const { db, p1 } = seed();
  const order = admissionOrderCreate(db, { patient_id: p1 }, registrar).admission;
  assert.throws(() => admissionAdmit(db, { admission_id: order.id, bed_id: 9999 }, nurse), /Койка не найдена/);
});

test('отказ: койка уже занята другим пациентом', () => {
  const { db, p1, p2, bedA1 } = seed();
  const first = admissionOrderCreate(db, { patient_id: p1 }, registrar).admission;
  admissionAdmit(db, { admission_id: first.id, bed_id: bedA1 }, nurse);

  const second = admissionOrderCreate(db, { patient_id: p2 }, registrar).admission;
  assert.throws(() => admissionAdmit(db, { admission_id: second.id, bed_id: bedA1 }, nurse), /Койка занята/);

  // …и даже если статус койки кто-то руками вернул в 'free': занятость
  // считается по госпитализациям, а не по колонке.
  db.prepare("UPDATE beds SET status='free' WHERE id=?").run(bedA1);
  assert.throws(() => admissionAdmit(db, { admission_id: second.id, bed_id: bedA1 }, nurse), /Койка занята другим пациентом/);
});

test('отказ: койка из другой палаты, чем названа в заявке', () => {
  const { db, p1, wardA, bedB1 } = seed();
  const order = admissionOrderCreate(db, { patient_id: p1, ward_id: wardA }, registrar).admission;
  assert.throws(() => admissionAdmit(db, { admission_id: order.id, bed_id: bedB1 }, nurse),
    /Койка из другой палаты: заявка оформлена в «Терапия»/);
});

test('заявка БЕЗ палаты кладётся в любую — палату выбирает медсестра', () => {
  const { db, p1, wardB, bedB1 } = seed();
  const order = admissionOrderCreate(db, { patient_id: p1 }, registrar).admission;
  const res = admissionAdmit(db, { admission_id: order.id, bed_id: bedB1 }, nurse);
  assert.equal(res.admission.ward_id, wardB, 'палата берётся у койки');
});

test('отказ: вторая госпитализация одного пациента', () => {
  const { db, p1, bedA1, bedA2 } = seed();
  // Первая — обычным маршрутом.
  const first = admissionOrderCreate(db, { patient_id: p1 }, registrar).admission;
  admissionAdmit(db, { admission_id: first.id, bed_id: bedA1 }, nurse);

  // Вторая заявка тому же пациенту вообще не оформляется…
  assert.throws(() => admissionOrderCreate(db, { patient_id: p1 }, registrar), /уже госпитализирован/);

  // …а если строка-заявка всё-таки существует (заведена до того, как пациент
  // лёг по другой), размещение её отвергает: один пациент — одна койка.
  const stray = db.prepare("INSERT INTO admissions (patient_id, status, ordered_at, ordered_by) VALUES (?, 'ordered', '2026-09-01T00:00:00Z', ?)")
    .run(p1, registrar.id).lastInsertRowid;
  assert.throws(() => admissionAdmit(db, { admission_id: stray, bed_id: bedA2 }, nurse),
    /У пациента уже есть открытая госпитализация на койке/);
  assert.equal(db.prepare('SELECT status FROM beds WHERE id=?').get(bedA2).status, 'free', 'вторая койка не тронута');
});

test('отказ: заявки нет — пациент уже на койке, отменён или выписан', () => {
  const { db, p1, bedA1, bedA2 } = seed();
  const order = admissionOrderCreate(db, { patient_id: p1 }, registrar).admission;
  admissionAdmit(db, { admission_id: order.id, bed_id: bedA1 }, nurse);
  assert.throws(() => admissionAdmit(db, { admission_id: order.id, bed_id: bedA2 }, nurse), /уже размещён на койке/);

  const { db: db2, p1: q1, bedA1: b1 } = seed();
  const cancelled = admissionOrderCreate(db2, { patient_id: q1 }, registrar).admission;
  admissionOrderCancel(db2, { admission_id: cancelled.id, reason: 'передумали' }, registrar);
  assert.throws(() => admissionAdmit(db2, { admission_id: cancelled.id, bed_id: b1 }, nurse), /отменена/);

  const { db: db3, p1: r1, bedA1: c1, bedA2: c2 } = seed();
  const stay = admitPatient(db3, { patient_id: r1, bed_id: c1 }, nurse).admission;   // путь v0.8.0 → 'active'
  assert.throws(() => admissionAdmit(db3, { admission_id: stay.id, bed_id: c2 }, nurse), /уже размещён на койке/);
});

test('отказ по роли звучит РАНЬШЕ отказа по койке', () => {
  // Кассиру нужно услышать «это делает медсестра», а не «койка на уборке»:
  // второй ответ отправляет искать другую койку там, где дело не в койке.
  const { db, p1, bedClean } = seed();
  const order = admissionOrderCreate(db, { patient_id: p1 }, registrar).admission;
  assert.throws(() => admissionAdmit(db, { admission_id: order.id, bed_id: bedClean }, cashier),
    (e) => e.status === 403 && /недоступно вашей роли/.test(e.message));
});

// ─── 3. Отмена заявки ────────────────────────────────────────────────────────

test('отмена заявки требует причину и записывает её', () => {
  const { db, p1 } = seed();
  const order = admissionOrderCreate(db, { patient_id: p1 }, registrar).admission;
  assert.throws(() => admissionOrderCancel(db, { admission_id: order.id }, registrar), /Укажите причину отмены заявки/);

  const res = admissionOrderCancel(db, { admission_id: order.id, reason: 'госпитализирован в другую клинику' }, registrar);
  assert.equal(res.admission.status, 'cancelled');
  assert.equal(res.admission.cancel_reason, 'госпитализирован в другую клинику');
  assert.equal(nurseWindow(db).waitingBed.length, 0);

  // Пациент снова свободен — новую заявку оформить можно.
  assert.equal(admissionOrderCreate(db, { patient_id: p1 }, registrar).admission.status, 'ordered');
});

test('отменяет заявку регистратура, ст. медсестра, главный врач, администратор — медсестре и врачу отказ', () => {
  for (const who of [registrar, seniorNurse, headDoctor, admin]) {
    const { db, p1 } = seed();
    const order = admissionOrderCreate(db, { patient_id: p1 }, registrar).admission;
    assert.equal(admissionOrderCancel(db, { admission_id: order.id, reason: 'причина' }, who).admission.status, 'cancelled');
  }
  for (const who of [nurse, doctor, cashier]) {
    const { db, p1 } = seed();
    const order = admissionOrderCreate(db, { patient_id: p1 }, registrar).admission;
    assert.throws(() => admissionOrderCancel(db, { admission_id: order.id, reason: 'причина' }, who),
      (e) => e.status === 403 && /недоступно вашей роли/.test(e.message));
  }
});

test('отмена уже размещённого пациента отпускает койку в «уборку», а не в «свободна»', () => {
  const { db, p1, bedA1 } = seed();
  const order = admissionOrderCreate(db, { patient_id: p1 }, registrar).admission;
  admissionAdmit(db, { admission_id: order.id, bed_id: bedA1 }, nurse);

  admissionOrderCancel(db, { admission_id: order.id, reason: 'ошибка оформления' }, seniorNurse);
  assert.equal(db.prepare('SELECT status FROM beds WHERE id=?').get(bedA1).status, 'cleaning');
});

test('начатое лечение отменить нельзя — его выписывают', () => {
  const { db, p1, bedA1 } = seed();
  const stay = admitPatient(db, { patient_id: p1, bed_id: bedA1 }, nurse).admission;   // 'active'
  assert.throws(() => admissionOrderCancel(db, { admission_id: stay.id, reason: 'причина' }, registrar),
    /Отменить можно только госпитализацию, которая ещё не дошла до лечения/);
  assert.equal(db.prepare('SELECT status FROM admissions WHERE id=?').get(stay.id).status, 'active');
});

// ─── 4. Раздел «Стационар» есть у тех, кто в нём работает (миграция 092) ─────

test('миграция 092 выдаёт раздел стационара медсестре, ст. медсестре, главному врачу и регистратуре', () => {
  const { db } = seed();
  const sections = (role) => JSON.parse(db.prepare('SELECT permissions FROM role_permissions WHERE role=?').get(role).permissions).sections;

  for (const role of ['nurse', 'senior_nurse', 'head_doctor', 'registrar', 'admin']) {
    assert.ok(sections(role).includes('beds'), `${role} должен видеть раздел стационара`);
  }
  // Кассиру и лаборанту стационар не выдаётся — они в нём не работают.
  for (const role of ['cashier', 'lab']) {
    assert.ok(!sections(role).includes('beds'), `${role} не должен видеть раздел стационара`);
  }
  // Уровень — «редактор»: заводить и двигать, но не удалять.
  const levels = JSON.parse(db.prepare("SELECT permissions FROM role_permissions WHERE role='nurse'").get().permissions).levels;
  assert.equal(levels.beds, 'editor');
});

test('миграция 092 не выдаёт раздел дважды при повторном прогоне', () => {
  const { db } = seed();
  migrate(db);   // идемпотентность: schema_migrations не пускает файл второй раз
  const sections = JSON.parse(db.prepare("SELECT permissions FROM role_permissions WHERE role='nurse'").get().permissions).sections;
  assert.equal(sections.filter((s) => s === 'beds').length, 1);
});
