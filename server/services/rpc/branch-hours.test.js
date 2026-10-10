// BRANCH_PROFILE_V1 — «каким врачам какое время закроется»: ровно то, что
// календарь перестаёт предлагать (тот же движок slot-engine.js), и только врачам
// этого здания (users.branch_id, как resourceWindow).
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { calendarSlots, calendarBook } from './calendar.js';
import { becomeSecondary } from '../branch-sync/identity.js';
import { branchHoursImpact, lostHours, IMPACT_DENIED } from './branch-hours.js';
import { writeBranchHours, blankDays } from '../../../public/js/shared/branch-hours.js';
import { BRANCH_MESSAGES } from '../../../public/js/shared/branch-profile.js';
import { STRINGS } from '../../../public/js/admin/i18n-strings.js';

const ADMIN = { id: 1, role: 'admin', extra_roles: [] };
const REG = { id: 2, role: 'registrar', extra_roles: [] };
function nextMonday() {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  do { d.setDate(d.getDate() + 1); } while (d.getDay() !== 1);
  return d;
}
const MON = nextMonday();
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const DAY = iso(MON);
const at = (hh) => new Date(MON.getFullYear(), MON.getMonth(), MON.getDate(), hh, 0, 0, 0).toISOString();
const MON_FRI = () => writeBranchHours({ mode: 'week', days: blankDays() });   // Пн–Пт 09–18, Сб и Вс закрыты

function seed({ patient = true } = {}) {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO branches (id, name, working_hours) VALUES (5, 'Юнусабад', '{}'), (6, 'Чиланзар', '{}')").run();
  const add = db.prepare(`INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, working_hours, branch_id, specialty, is_active)
                          VALUES (?,?,?,?,?,?,?,?,?,?)`);
  add.run(1, 'boss', 'x', 'Админ', 'admin', 0, '', null, '', 1);
  add.run(2, 'reg', 'x', 'Регистратор', 'registrar', 0, '', 5, '', 1);
  add.run(7, 'petrov', 'x', 'Петров П. П.', 'doctor', 1, JSON.stringify({ mon: { on: true, from: '08:00', to: '20:00' } }), 5, '', 1);
  add.run(8, 'karimov', 'x', 'Каримов Р.', 'doctor', 1, '', 5, '', 1);     // графика нет — 09:00–18:00 каждый день
  add.run(9, 'aliev', 'x', 'Алиев А.', 'doctor', 1, '', 6, '', 1);         // другое здание
  add.run(10, 'old', 'x', 'Уволенный', 'doctor', 1, '', 5, '', 0);         // не работает
  add.run(11, 'uzi', 'x', 'Узистов У.', 'registrar', 0, '', 5, 'УЗИ', 1);  // специальность — в календаре он врач (room-calendar.js:283)
  if (patient) db.prepare("INSERT INTO patients (id, full_name) VALUES (3, 'Иванов Иван')").run();
  return db;
}
function addGrants(db, role, grants) {   // как server/db/write-grant.test.js
  const row = db.prepare('SELECT permissions FROM role_permissions WHERE role = ?').get(role);
  const perms = row ? JSON.parse(row.permissions) : { sections: [], levels: {} };
  perms.grants = { ...(perms.grants || {}), ...grants };
  if (row) db.prepare('UPDATE role_permissions SET permissions = ? WHERE role = ?').run(JSON.stringify(perms), role);
  else db.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?)').run(role, JSON.stringify(perms));
}

test('предупреждение называет ровно то время, которое календарь перестаёт предлагать', () => {
  const db = seed();
  try {
    assert.deepEqual(calendarSlots(db, { doctor_id: 7, date: DAY }, REG).window, { from: '08:00', to: '20:00', breaks: [] });
    const next = MON_FRI();
    const petrov = branchHoursImpact(db, { branch_id: 5, ...next }, ADMIN).doctors.find((d) => d.id === 7);
    assert.deepEqual(petrov, { id: 7, name: 'Петров П. П.', lost: [{ day: 'mon', from: '08:00', to: '09:00' }, { day: 'mon', from: '18:00', to: '20:00' }] });
    db.prepare('UPDATE branches SET working_hours = ?, is_24_7 = ? WHERE id = 5').run(next.working_hours, next.is_24_7);
    assert.deepEqual(calendarSlots(db, { doctor_id: 7, date: DAY }, REG).window, { from: '09:00', to: '18:00', breaks: [] });
  } finally { db.close(); }
});

test('врач без графика теряет выходные; другое здание, уволенный и не врачи — не в списке', () => {
  const db = seed();
  try {
    const { doctors } = branchHoursImpact(db, { branch_id: 5, ...MON_FRI() }, ADMIN);
    assert.deepEqual(doctors.map((d) => d.name), ['Каримов Р.', 'Петров П. П.', 'Узистов У.']);
    assert.deepEqual(doctors[0].lost, [{ day: 'sat', from: '09:00', to: '18:00' }, { day: 'sun', from: '09:00', to: '18:00' }]);
  } finally { db.close(); }
});

test('часы шире прежних, «Круглосуточно» и «Не ограничивать» — никто ничего не теряет', () => {
  const db = seed();
  try {
    db.prepare('UPDATE branches SET working_hours = ? WHERE id = 5').run(MON_FRI().working_hours);
    for (const next of [{ working_hours: '{}', is_24_7: 0 }, { working_hours: '{}', is_24_7: 1 }, MON_FRI()]) {
      assert.deepEqual(branchHoursImpact(db, { branch_id: 5, ...next }, ADMIN).doctors, [], JSON.stringify(next));
    }
  } finally { db.close(); }
});

test('обед врача не считается потерей: он и так не принимал', () => {
  const doc = JSON.stringify({ mon: { enabled: true, from: '09:00', to: '19:00', lunchEnabled: true, lunchFrom: '13:00', lunchTo: '14:00' } });
  const days = blankDays(); days.mon = { on: true, from: '12:00', to: '18:00' };
  assert.deepEqual(lostHours(doc, { working_hours: '{}', is_24_7: 0 }, writeBranchHours({ mode: 'week', days })),
    [{ day: 'mon', from: '09:00', to: '12:00' }, { day: 'mon', from: '18:00', to: '19:00' }]);
});

test('часы здания не запрещают запись — только перестают её предлагать (как сегодня; так и сказано в предупреждении)', async () => {
  const db = seed();
  try {
    db.prepare('UPDATE branches SET working_hours = ? WHERE id = 5').run(MON_FRI().working_hours);
    const starts = calendarSlots(db, { doctor_id: 7, date: DAY, duration_minutes: 30 }, REG).slots.map((s) => s.start);
    assert.ok(!starts.includes('19:00'), '19:00 не предлагается');
    const out = await calendarBook(db, { patient_id: 3, doctor_id: 7, start: at(19) }, REG);
    assert.equal(out.created, true, 'calendar_book проверяет только занятость (calendar.js:1044-1052)');
  } finally { db.close(); }
});

test('права: администратор и «Филиалы: Изменение»; остальным — 403; в филиале — 409', () => {
  const db = seed();
  try {
    assert.throws(() => branchHoursImpact(db, { branch_id: 5, ...MON_FRI() }, REG), (e) => e.status === 403 && e.message === IMPACT_DENIED);
    addGrants(db, 'registrar', { settings: 'view', 'settings.branches': 'edit' });
    assert.equal(branchHoursImpact(db, { branch_id: 5, ...MON_FRI() }, REG).doctors.length, 3);
  } finally { db.close(); }
  const sec = seed({ patient: false });   // филиалом становится установка без выданных номеров карт
  try {
    becomeSecondary(sec, { letter: 'C', name: 'Чиланзар' });
    assert.throws(() => branchHoursImpact(sec, { branch_id: 5, ...MON_FRI() }, ADMIN), (e) => e.status === 409 && e.message === BRANCH_MESSAGES.mainOnly);
  } finally { sec.close(); }
});

test('новое здание или неизвестный id — врачей нет; часы не в том виде — 400', () => {
  const db = seed();
  try {
    assert.deepEqual(branchHoursImpact(db, { working_hours: MON_FRI().working_hours }, ADMIN), { doctors: [] });
    assert.deepEqual(branchHoursImpact(db, { branch_id: 999, ...MON_FRI() }, ADMIN), { doctors: [] });
    assert.throws(() => branchHoursImpact(db, { branch_id: 5, working_hours: '{"mon":{"enabled":true}}', is_24_7: 0 }, ADMIN), (e) => e.status === 400);
  } finally { db.close(); }
});

test('отказ переведён на ru / uz / en', () => {
  const e = STRINGS[IMPACT_DENIED];
  assert.ok(e && e.ru && e.uz && e.en);
});
