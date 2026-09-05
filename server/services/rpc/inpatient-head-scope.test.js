// HEAD_DOCTOR_WARD_VIEW_V1 (2026-09-05) — КОГО ГЛАВНЫЙ ВРАЧ ВИДИТ В СТАЦИОНАРЕ.
//
// Владелец: «главный врач cannot see the admission of the patients of the
// departments. in their cabinet».
//
// Диагноз, который этот файл закрепляет тестом, а не комментарием: кабинет
// сужал список госпитализаций на «я — лечащий врач», а работа главного врача —
// это ровно те пациенты, которых он НЕ ведёт. Он проводит первичный осмотр,
// когда лечащего ещё нет ('admitted'), и назначает лечащего следом
// ('examined'); у обеих строк attending_doctor_id пуст, и «свои» вычёркивало их
// все.
//
// Что проверяется здесь — на СЕРВЕРЕ, потому что решает область видимости он:
//   1. область называется одним словом и одним списком ролей: 'all' у главного
//      врача и администратора, 'own' у всех остальных, включая палатного врача;
//   2. это ОДНА копия правила: назначения пускают ровно тех, кому область
//      сказала 'all' (assertCanPrescribe зовёт ту же функцию);
//   3. широкий взгляд НЕ РАСШИРЯЕТ ПРАВ: главный врач по-прежнему может ровно
//      первичный осмотр и назначение лечащего — и ничего сверх того;
//   4. надстройка работает так, как её выдаёт клиника: 'head_doctor' лежит в
//      extra_roles поверх role='doctor'.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import {
  inpatientScope, WIDE_INPATIENT_ROLES, inpatientCapabilities,
  assertCanPrescribe, TRANSITION_ROLES,
} from './inpatient-flow.js';

const EVERY_ROLE = ['admin', 'registrar', 'doctor', 'cashier', 'lab', 'nurse',
  'inventory', 'callcenter', 'head_doctor', 'senior_nurse'];

// Надстроечные роли человек носит ТОЛЬКО в extra_roles — как их выдаёт клиника.
function actor(role, id = 1) {
  return ['head_doctor', 'senior_nurse'].includes(role)
    ? { id, role: role === 'head_doctor' ? 'doctor' : 'nurse', extra_roles: [role] }
    : { id, role };
}

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (1,'adm','x','Админ','admin')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (2,'doc','x','Лечащий','doctor')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (3,'doc2','x','Чужой','doctor')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (9,'head','x','Главный','doctor')").run();
  db.prepare("INSERT INTO patients (id, full_name) VALUES (1,'Иванов Иван')").run();
  db.prepare("INSERT INTO wards (id, name, billing_mode, price_per_day) VALUES (1,'Терапия','daily',150000)").run();
  db.prepare("INSERT INTO beds (id, code, ward_id, status) VALUES (1,'K-1',1,'free')").run();
  return db;
}

/** Госпитализация ровно в состоянии `status` (мимо машины — это фикстура). */
function admission(db, status, extra = {}) {
  const cols = { patient_id: 1, ward_id: 1, status, ...extra };
  const keys = Object.keys(cols);
  return db.prepare(`INSERT INTO admissions (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
    .run(...keys.map((k) => cols[k])).lastInsertRowid;
}

// ─── 1. Область видимости ───────────────────────────────────────────────────

test('область стационара: главный врач и администратор видят всех, остальные — своих', () => {
  for (const role of EVERY_ROLE) {
    const want = WIDE_INPATIENT_ROLES.includes(role) ? 'all' : 'own';
    assert.equal(inpatientScope(actor(role, 7)), want, `${role}: ожидалась область «${want}»`);
  }
  // Палатный врач — именно тот, ради кого сужение и существует.
  assert.equal(inpatientScope(actor('doctor', 2)), 'own');
  // Главный врач носит надстройку поверх врача, и это его не сужает.
  assert.equal(inpatientScope({ id: 9, role: 'doctor', extra_roles: ['head_doctor'] }), 'all');
  // Ни роли, ни пользователя — самое узкое, а не падение.
  assert.equal(inpatientScope(null), 'own');
  assert.equal(inpatientScope({ id: 5 }), 'own');
});

test('inpatient_capabilities отдаёт область экрану — иначе кабинет считал бы её сам', () => {
  const db = seed();
  const head = inpatientCapabilities(db, {}, actor('head_doctor', 9));
  assert.equal(head.scope, 'all', 'главный врач обязан получить широкую область');
  // Ровно два действия кабинета — и они у него есть.
  assert.equal(head.can.examine, true);
  assert.equal(head.can.set_attending, true);

  const ward = inpatientCapabilities(db, {}, actor('doctor', 2));
  assert.equal(ward.scope, 'own', 'палатный врач видит только своих');
  assert.equal(ward.can.examine, false, 'первичный осмотр — не его работа');
  assert.equal(ward.can.set_attending, false, 'лечащего назначает главный врач');
  db.close();
});

// ─── 2. Одна копия правила: вижу ⇔ назначаю ────────────────────────────────

test('«кого вижу» и «кому назначаю» — одно правило: расхождения нет ни у одной роли', () => {
  for (const role of EVERY_ROLE) {
    const db = seed();
    // Пациент в лечении, лечащий — ВРАЧ №2, то есть НЕ проверяемый человек.
    const id = admission(db, 'active', { attending_doctor_id: 2 });
    const wide = inpatientScope(actor(role, 7)) === 'all';
    let allowed = true;
    try { assertCanPrescribe(db, id, actor(role, 7)); } catch { allowed = false; }
    assert.equal(allowed, wide,
      `${role}: право назначать по ЧУЖОМУ пациенту обязано совпадать с широкой областью`);
    db.close();
  }
});

test('лечащий врач ведёт СВОЕГО пациента, не имея широкой области', () => {
  const db = seed();
  const id = admission(db, 'active', { attending_doctor_id: 2 });
  assert.equal(inpatientScope(actor('doctor', 2)), 'own');
  assert.equal(assertCanPrescribe(db, id, actor('doctor', 2)).id, id);
  // А чужому — отказ, и он называет, кто ведёт.
  assert.throws(() => assertCanPrescribe(db, id, actor('doctor', 3)),
    (e) => e.status === 403 && /лечащий врач этого пациента или главный врач/.test(e.message));
  db.close();
});

// ─── 3. Шире видит — НЕ больше может ────────────────────────────────────────

test('широкая область не выдаёт главному врачу ни одного лишнего шага маршрута', () => {
  const db = seed();
  const { can } = inpatientCapabilities(db, {}, actor('head_doctor', 9));
  // Разрешено ровно то, что стоит в матрице переходов, — ни строкой больше.
  for (const [action, key] of Object.entries({
    admit: 'ordered→admitted', cancel_order: 'ordered→cancelled',
    examine: 'admitted→examined', set_attending: 'examined→active',
    request_discharge: 'active→discharging',
    cancel_discharge_request: 'discharging→active',
    discharge: 'discharging→discharged',
  })) {
    assert.equal(can[action], TRANSITION_ROLES[key].includes('head_doctor'),
      `${action}: право обязано приходить из матрицы, а не из широкой области`);
  }
  db.close();
});

test('главный врач не назначает по пациенту, который ещё не дошёл до лечения', () => {
  const db = seed();
  for (const [status, why] of [
    ['admitted', /не осмотрен главным врачом/],
    ['examined', /Лечащий врач ещё не назначен/],
  ]) {
    const id = admission(db, status);
    assert.throws(() => assertCanPrescribe(db, id, actor('head_doctor', 9)),
      (e) => e.status === 400 && why.test(e.message),
      `${status}: широкая область не отменяет порядка шагов`);
  }
  db.close();
});
