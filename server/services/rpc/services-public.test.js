// SERVICES_PACKAGES_V1 — «Услуги для сайта и партнёров»: обзор (услуги по пяти
// группам, врачи с консультациями, услуги-консультации у врачей — решение
// владельца 12) и показ услуг (только администратор, без узбекского названия —
// пропуск, в филиале — 409).
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { getRpc } from './index.js';
import { isReadOnlyRpc } from '../control/gate.js';
import { SERVICE_PUBLIC_MESSAGES } from '../../../public/js/shared/service-public.js';

const admin = { id: 9, role: 'admin' };
const registrar = { id: 7, role: 'registrar' };

function clinic() {
  const db = openDb(':memory:');
  migrate(db);
  const u = db.prepare(`INSERT INTO users (id, username, password_hash, role, full_name, full_name_ru, is_doctor, is_public, branch_id, scheduling_mode, service_rates)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  u.run(1, 'abd', 'x', 'doctor', 'Абдуллаев Ш.', 'Абдуллаев Шерзод', 1, 1, null, 'schedulable', JSON.stringify([{ service_id: 10, pct: 30 }]));
  u.run(2, 'kar', 'x', 'doctor', 'Каримов А.', '', 1, 0, null, 'live_queue', JSON.stringify([{ service_id: 11, pct: 30 }]));
  u.run(7, 'reg', 'x', 'registrar', 'Регистратор', '', 0, 0, null, 'schedulable', '');
  u.run(9, 'adm', 'x', 'admin', 'Администратор', '', 0, 0, null, 'schedulable', '');
  db.prepare('UPDATE services SET active = 0 WHERE id < 0').run();   // посев миграций (ОАК, id −41) — не в счёт
  db.prepare("INSERT INTO user_specialties (user_id, specialty_slug, name_ru, is_primary) VALUES (1, 'pediatr', 'Педиатр', 1)").run();
  const s = db.prepare('INSERT INTO services (id, name, name_uz, name_en, price, type, is_lab, online_booking, active) VALUES (?,?,?,?,?,?,?,?,?)');
  s.run(1, 'Общий анализ крови', 'Umumiy qon tahlili', 'Complete blood count', 45000, 'lab', 1, 1, 1);
  s.run(2, 'Глюкоза', 'Glyukoza', '', 25000, 'lab', 1, 0, 1);
  s.run(3, 'Липидный профиль', '', '', 120000, 'lab', 1, 0, 1);
  s.run(4, 'Рентген', 'Rentgen', '', 110000, 'radiology', 0, 1, 1);
  s.run(5, 'Старая', 'Eski', '', 1, 'lab', 1, 1, 0);
  s.run(10, 'Консультация невролога', 'Nevrolog konsultatsiyasi', '', 150000, 'consultation', 0, 1, 1);
  s.run(11, 'Консультация эндокринолога', 'Endokrinolog konsultatsiyasi', '', 170000, 'consultation', 0, 0, 1);
  s.run(12, 'Консультация хирурга', 'Jarroh konsultatsiyasi', '', 160000, 'consultation', 0, 0, 1);
  db.prepare("INSERT INTO consultation_types (id, name, name_ru, price, active, api_kind) VALUES (1, 'Первичный', 'Первичный приём', 100000, 1, 'initial')").run();
  db.prepare('INSERT INTO doctor_consultation_prices (doctor_id, consultation_type_id, price, available, is_free) VALUES (1, 1, 150000, 1, 0)').run();
  return db;
}
const overview = (db, user = admin) => getRpc('services_public_overview')(db, {}, user);
const setOnline = (db, args, user = admin) => getRpc('services_set_online')(db, args, user);

test('обзор — только чтение; нужен только вход в систему; показ — запись', () => {
  assert.equal(isReadOnlyRpc('services_public_overview'), true);
  assert.equal(isReadOnlyRpc('services_set_online'), false);
  const db = clinic();
  assert.equal(overview(db, { id: 3, role: 'lab' }).can_edit, false, 'смотреть может любой сотрудник');
  assert.throws(() => overview(db, null), (e) => e.status === 401);
});

test('обзор: пять групп с числами (консультации — врачи), услуги с кодом группы для партнёров, цифры над вкладками', () => {
  const r = overview(clinic());
  assert.deepEqual(r.groups.map((g) => [g.key, g.api, g.count]),
    [['consultation', 'consultations', 2], ['lab', 'lab', 3], ['imaging', 'diagnostics', 1], ['procedure', 'procedures', 0], ['other', 'surgery', 0]]);
  const byId = new Map(r.services.map((s) => [s.id, s]));
  assert.equal(byId.has(5), false, 'отключённой в прайсе услуги нет');
  assert.deepEqual([byId.get(4).group, byId.get(4).api_group], ['imaging', 'diagnostics'], 'radiology — диагностика');
  assert.deepEqual(byId.get(1).name, { ru: 'Общий анализ крови', uz: 'Umumiy qon tahlili', en: 'Complete blood count' });
  assert.deepEqual([byId.get(2).state, byId.get(3).state], ['off', 'no_uz']);
  assert.deepEqual(r.facts, { services_shown: 3, services_total: 7, doctors_shown: 1, doctors_total: 2, no_en: 2 });
  assert.equal(r.can_edit, true);
  assert.equal(overview(clinic(), registrar).can_edit, false, 'регистратура смотрит, но не меняет');
});

test('решение 12: врачи с консультациями и услугами-консультациями из прайса; у услуги — кто оказывает и предупреждение', () => {
  const r = overview(clinic());
  const abd = r.doctors.find((d) => d.id === 1);
  assert.deepEqual([abd.name, abd.specialty, abd.specialty_slug, abd.mode, abd.state], ['Абдуллаев Шерзод', 'Педиатр', 'pediatr', 'schedulable', 'shown']);
  assert.deepEqual(abd.consultations.map((c) => [c.consultation_type_id, c.price, c.own]), [[1, 150000, true]]);
  assert.deepEqual(abd.services.map((s) => [s.service_id, s.price, s.online]), [[10, 150000, true]]);
  const kar = r.doctors.find((d) => d.id === 2);
  assert.deepEqual([kar.name, kar.mode, kar.state], ['Каримов А.', 'live_queue', 'off'], 'без ФИО RU — прежнее ФИО');
  assert.deepEqual(kar.consultations.map((c) => c.price), [100000], 'строки нет — общая цена вида (решение 8)');
  const svc = new Map(r.services.map((s) => [s.id, s]));
  assert.deepEqual([svc.get(10).performers.map((p) => [p.id, p.shown]), svc.get(10).warning], [[[1, true]], null]);
  assert.equal(svc.get(11).warning, 'performersHidden', 'единственный врач скрыт');
  assert.equal(svc.get(12).warning, 'noPerformer');
  assert.equal(svc.get(1).performers, undefined, 'у анализа исполнителей не спрашиваем');
});

test('показ услуг: администратор включает; без узбекского названия — пропуск списком; выключенные и уже показанные не трогаются', () => {
  const db = clinic();
  const out = setOnline(db, { ids: [2, 3, 1, 5], on: true });
  assert.deepEqual(out, { changed: [2], skipped: [{ id: 3, name: 'Липидный профиль' }] });
  assert.equal(db.prepare('SELECT online_booking FROM services WHERE id = 5').get().online_booking, 1, 'отключённую в прайсе не трогаем');
  assert.deepEqual(setOnline(db, { ids: [1, 2], on: false }), { changed: [1, 2], skipped: [] });
  assert.deepEqual(db.prepare('SELECT id, online_booking FROM services WHERE id IN (1,2,3) ORDER BY id').all().map((r) => r.online_booking), [0, 0, 0]);
});

test('показ услуг: не администратор — 403; филиал — 409; пустой список и не «да/нет» — 400', () => {
  const db = clinic();
  assert.throws(() => setOnline(db, { ids: [2], on: true }, registrar), (e) => e.status === 403 && e.message === SERVICE_PUBLIC_MESSAGES.adminOnly);
  assert.throws(() => setOnline(db, { ids: [], on: true }), (e) => e.status === 400 && e.message === SERVICE_PUBLIC_MESSAGES.ids);
  assert.throws(() => setOnline(db, { ids: ['x'], on: true }), (e) => e.status === 400);
  assert.throws(() => setOnline(db, { ids: [2], on: 'yes' }), (e) => e.status === 400 && e.message === SERVICE_PUBLIC_MESSAGES.flag);
  db.prepare("UPDATE branch_identity SET role = 'secondary' WHERE id = 1").run();
  assert.throws(() => setOnline(db, { ids: [2], on: true }), (e) => e.status === 409 && e.message === SERVICE_PUBLIC_MESSAGES.mainOnly);
  assert.equal(overview(db).can_edit, false);
  assert.equal(overview(db).secondary, true);
});
