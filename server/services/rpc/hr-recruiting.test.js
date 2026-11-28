// HR_RECRUIT_V1 — «HR → Подбор»: воронка найма, журнал этапов, «Нанят → Создать сотрудника».
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import {
  hrRecruitBoard, hrCandidateGet, hrVacancySave, hrCandidateSave, hrCandidateMove,
  hrCandidateHirePrefill, hrCandidateLinkEmployee,
} from './hr-recruiting.js';
import { getRpc } from './index.js';
import { isReadOnlyRpc } from '../control/gate.js';

const ADMIN = { id: 1, role: 'admin', extra_roles: [] };
const RECRUITER = { id: 2, role: 'registrar', extra_roles: [] };
const NURSE = { id: 3, role: 'nurse', extra_roles: [] };

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO departments (id, name, kind) VALUES (91, 'Кардиология', 'clinical')").run();
  const ins = db.prepare('INSERT INTO users (id, username, password_hash, role, full_name) VALUES (?, ?, ?, ?, ?)');
  ins.run(1, 'adm', 'x', 'admin', 'Админ');
  ins.run(2, 'rec', 'x', 'registrar', 'Рекрутер');
  ins.run(3, 'nur', 'x', 'nurse', 'Медсестра');
  ins.run(10, 'new.emp', 'x', 'nurse', 'Новая Сотрудница');
  ins.run(11, 'other.emp', 'x', 'nurse', 'Другой Сотрудник');
  return db;
}
function grant(db, role, lvl) {
  const row = db.prepare('SELECT permissions FROM role_permissions WHERE role = ?').get(role);
  const perms = row ? JSON.parse(row.permissions || '{}') : {};
  perms.grants = { ...(perms.grants || {}), hr_recruiting: lvl };
  if (row) db.prepare('UPDATE role_permissions SET permissions = ? WHERE role = ?').run(JSON.stringify(perms), role);
  else db.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?)').run(role, JSON.stringify(perms));
}
const addCandidate = (db, extra = {}, user = ADMIN) => hrCandidateSave(db, { full_name: 'Каримова Дилноза', phone: '+998901112233', ...extra }, user).id;

test('доступ: без настройки — только администратор; строка «HR · Подбор» открывает рекрутеру', () => {
  const db = fresh();
  assert.throws(() => hrRecruitBoard(db, {}, null), (e) => e.status === 401);
  assert.throws(() => hrRecruitBoard(db, {}, RECRUITER), (e) => e.status === 403);
  assert.ok(Array.isArray(hrRecruitBoard(db, {}, ADMIN).candidates));

  grant(db, 'registrar', 'view');
  const board = hrRecruitBoard(db, {}, RECRUITER);
  assert.equal(board.can_edit, false);
  assert.throws(() => addCandidate(db, {}, RECRUITER), (e) => e.status === 403 && /Просмотр/.test(e.message));

  grant(db, 'registrar', 'edit');
  assert.equal(hrRecruitBoard(db, {}, RECRUITER).can_edit, true);
  assert.ok(addCandidate(db, {}, RECRUITER) > 0);
  // Медсестре строку не выдавали — по-прежнему нет.
  assert.throws(() => hrRecruitBoard(db, {}, NURSE), (e) => e.status === 403);
});

test('новый кандидат встаёт в «Отклик» и сразу получает первую строку журнала', () => {
  const db = fresh();
  const id = addCandidate(db);
  const { candidate, events } = hrCandidateGet(db, { id }, ADMIN);
  assert.equal(candidate.stage, 'new');
  assert.equal(candidate.source, 'other');
  assert.equal(events.length, 1);
  assert.equal(events[0].from_stage, null);
  assert.equal(events[0].to_stage, 'new');
  assert.throws(() => hrCandidateSave(db, { full_name: '   ' }, ADMIN), /ФИО/);
  assert.throws(() => hrCandidateSave(db, { full_name: 'X', source: 'tiktok' }, ADMIN), /источник/);
  assert.throws(() => hrCandidateSave(db, { full_name: 'X', vacancy_id: 999 }, ADMIN), (e) => e.status === 404);
});

test('движение по воронке пишется в журнал; отказ — только с причиной', () => {
  const db = fresh();
  const id = addCandidate(db);
  hrCandidateMove(db, { id, stage: 'screening' }, ADMIN);
  hrCandidateMove(db, { id, stage: 'interview', note: 'Звонок прошёл хорошо' }, ADMIN);
  assert.deepEqual(hrCandidateMove(db, { id, stage: 'interview' }, ADMIN), { id, stage: 'interview', changed: false });
  assert.throws(() => hrCandidateMove(db, { id, stage: 'rejected' }, ADMIN), /причину отказа/);
  assert.throws(() => hrCandidateMove(db, { id, stage: 'archived' }, ADMIN), /этап/);
  hrCandidateMove(db, { id, stage: 'rejected', note: 'Нет сертификата' }, ADMIN);
  const { candidate, events } = hrCandidateGet(db, { id }, ADMIN);
  assert.equal(candidate.stage, 'rejected');
  assert.equal(candidate.reject_reason, 'Нет сертификата');
  assert.deepEqual(events.map((e) => e.to_stage), ['rejected', 'interview', 'screening', 'new']);
  // Вернули из отказа — причина стирается, журнал помнит.
  hrCandidateMove(db, { id, stage: 'interview' }, ADMIN);
  assert.equal(hrCandidateGet(db, { id }, ADMIN).candidate.reject_reason, '');
});

test('доска: вакансии с числами по этапам, фильтр по вакансии, «резерв» и поиск по кириллице', () => {
  const db = fresh();
  const v = hrVacancySave(db, { title: 'Медсестра', staff_type: 'mid_low', department_id: 91, headcount: 2 }, ADMIN).id;
  const a = addCandidate(db, { full_name: 'Алиева Нигора', vacancy_id: v });
  addCandidate(db, { full_name: 'Бобоев Шерзод', vacancy_id: v });
  addCandidate(db, { full_name: 'Резервов Резерв' });
  hrCandidateMove(db, { id: a, stage: 'hired' }, ADMIN);

  const all = hrRecruitBoard(db, {}, ADMIN);
  assert.equal(all.candidates.length, 3);
  assert.equal(all.unassigned, 1);
  const vac = all.vacancies.find((x) => x.id === v);
  assert.equal(vac.department, 'Кардиология');
  assert.equal(vac.hired, 1);
  assert.equal(vac.active, 1);
  assert.equal(vac.stages.new, 1);
  assert.equal(hrRecruitBoard(db, { vacancy_id: v }, ADMIN).candidates.length, 2);
  assert.deepEqual(hrRecruitBoard(db, { vacancy_id: 'none' }, ADMIN).candidates.map((c) => c.full_name), ['Резервов Резерв']);
  assert.deepEqual(hrRecruitBoard(db, { q: 'алиева' }, ADMIN).candidates.map((c) => c.full_name), ['Алиева Нигора']);
});

test('вакансия: проверки полей; закрытие ставит дату, повторное — не сдвигает, открытие — стирает', () => {
  const db = fresh();
  assert.throws(() => hrVacancySave(db, { title: '' }, ADMIN), /название/);
  assert.throws(() => hrVacancySave(db, { title: 'X', staff_type: 'boss' }, ADMIN), /категория/);
  assert.throws(() => hrVacancySave(db, { title: 'X', headcount: 0 }, ADMIN), /мест/);
  assert.throws(() => hrVacancySave(db, { title: 'X', department_id: 999 }, ADMIN), (e) => e.status === 404);
  const id = hrVacancySave(db, { title: 'Кардиолог', staff_type: 'doctor' }, ADMIN).id;
  hrVacancySave(db, { id, title: 'Кардиолог', staff_type: 'doctor', status: 'closed' }, ADMIN);
  const closedAt = db.prepare('SELECT closed_at FROM hr_vacancies WHERE id = ?').get(id).closed_at;
  assert.ok(closedAt);
  db.prepare("UPDATE hr_vacancies SET closed_at = '2026-01-01T00:00:00Z' WHERE id = ?").run(id);
  hrVacancySave(db, { id, title: 'Кардиолог (взрослый)', staff_type: 'doctor', status: 'closed' }, ADMIN);
  assert.equal(db.prepare('SELECT closed_at FROM hr_vacancies WHERE id = ?').get(id).closed_at, '2026-01-01T00:00:00Z');
  hrVacancySave(db, { id, title: 'Кардиолог', staff_type: 'doctor', status: 'open' }, ADMIN);
  assert.equal(db.prepare('SELECT closed_at FROM hr_vacancies WHERE id = ?').get(id).closed_at, null);
});

test('«Создать сотрудника»: данные анкеты берутся из кандидата и его вакансии — только у нанятого', () => {
  const db = fresh();
  const v = hrVacancySave(db, { title: 'Медсестра', staff_type: 'mid_low', department_id: 91 }, ADMIN).id;
  const id = addCandidate(db, { vacancy_id: v, email: 'd@example.uz' });
  assert.throws(() => hrCandidateHirePrefill(db, { id }, ADMIN), (e) => e.status === 409 && /Нанят/.test(e.message));
  hrCandidateMove(db, { id, stage: 'hired' }, ADMIN);
  assert.deepEqual(hrCandidateHirePrefill(db, { id }, ADMIN), {
    candidate_id: id, full_name: 'Каримова Дилноза', phone: '+998901112233', email: 'd@example.uz',
    staff_type: 'mid_low', department_id: 91, vacancy_title: 'Медсестра',
  });
});

test('привязка сотрудника: один раз, к нанятому; после неё этап не меняется и анкета второй раз не открывается', () => {
  const db = fresh();
  const id = addCandidate(db);
  assert.throws(() => hrCandidateLinkEmployee(db, { id, user_id: 10 }, ADMIN), (e) => e.status === 409);
  hrCandidateMove(db, { id, stage: 'hired' }, ADMIN);
  assert.throws(() => hrCandidateLinkEmployee(db, { id, user_id: 999 }, ADMIN), (e) => e.status === 404);
  assert.deepEqual(hrCandidateLinkEmployee(db, { id, user_id: 10 }, ADMIN), { id, employee_id: 10, changed: true });
  // Повтор тем же сотрудником (двойной щелчок) — спокойное «уже», не ошибка.
  assert.equal(hrCandidateLinkEmployee(db, { id, user_id: 10 }, ADMIN).changed, false);
  assert.throws(() => hrCandidateLinkEmployee(db, { id, user_id: 11 }, ADMIN), /другой сотрудник/);
  assert.throws(() => hrCandidateHirePrefill(db, { id }, ADMIN), /уже создан/);
  assert.throws(() => hrCandidateMove(db, { id, stage: 'offer' }, ADMIN), (e) => e.status === 409);

  const { candidate, events } = hrCandidateGet(db, { id }, ADMIN);
  assert.equal(candidate.employee_name, 'Новая Сотрудница');
  assert.equal(events[0].from_stage, 'hired');
  assert.equal(events[0].to_stage, 'hired');

  // Тот же сотрудник ко второму кандидату не привязывается.
  const other = addCandidate(db, { full_name: 'Второй Кандидат' });
  hrCandidateMove(db, { id: other, stage: 'hired' }, ADMIN);
  assert.throws(() => hrCandidateLinkEmployee(db, { id: other, user_id: 10 }, ADMIN), /другому кандидату/);
});

test('RPC зарегистрированы; чтения открыты клинике с истёкшей лицензией, записи — нет', () => {
  for (const n of ['hr_recruit_board', 'hr_candidate_get', 'hr_candidate_hire_prefill', 'hr_vacancy_save',
    'hr_candidate_save', 'hr_candidate_move', 'hr_candidate_link_employee']) {
    assert.equal(typeof getRpc(n), 'function', n);
  }
  assert.ok(isReadOnlyRpc('hr_recruit_board'));
  assert.ok(isReadOnlyRpc('hr_candidate_get'));
  assert.ok(isReadOnlyRpc('hr_candidate_hire_prefill'));
  assert.ok(!isReadOnlyRpc('hr_candidate_move'));
  assert.ok(!isReadOnlyRpc('hr_candidate_link_employee'));
});
