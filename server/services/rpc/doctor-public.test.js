// DOCTOR_PROFILE_V1 — «Что увидят партнёры» карточки врача: окна по 15 минут
// тем же движком, что запись (график, часы здания, занятое), часы приёма по
// дням, очередь, консультации с ценой (решение 8) и услуги-консультации врача
// (решение 12). Ничего не пишет; ворота — «Сотрудники: Просмотр».
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { doctorPublicPreview, PREVIEW_DENIED } from './doctor-public.js';
import { doctorDayWindows } from './calendar.js';
import { getRpc } from './index.js';
import { isReadOnlyRpc } from '../control/gate.js';
import { today } from '../domain/day.js';

const admin = { id: 1, role: 'admin', extra_roles: [] };
const cashier = { id: 2, role: 'cashier', extra_roles: [] };
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (dayIso, n) => { const [y, m, d] = dayIso.split('-').map(Number); return iso(new Date(y, m - 1, d + n)); };
function nextMonday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  do { d.setDate(d.getDate() + 1); } while (d.getDay() !== 1);
  return d;
}
const WH = JSON.stringify({ mon: { on: true, from: '09:00', to: '10:00' }, tue: { on: true, from: '13:00', to: '14:00' } });

function seed() {
  const db = openDb(':memory:'); migrate(db);
  db.prepare(`INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, working_hours, scheduling_mode, booking_days, show_queue_count, service_rates)
              VALUES (7, 'doc', 'x', 'Петров П.П.', 'doctor', 1, ?, 'schedulable', 30, 1, ?)`)
    .run(WH, JSON.stringify([{ service_id: 501, pct: 10 }, { service_id: 502, pct: 10, price: 90000 }, { service_id: 503, pct: 5 }]));
  db.prepare("INSERT INTO patients (id, full_name) VALUES (3, 'Иванов Иван')").run();
  db.prepare("INSERT INTO services (id, name, name_uz, price, type, active, online_booking) VALUES (501, 'Консультация невролога', 'Nevrolog konsultatsiyasi', 120000, 'consultation', 1, 1)").run();
  db.prepare("INSERT INTO services (id, name, price, type, active, online_booking) VALUES (502, 'Повторная консультация невролога', 80000, 'consultation', 1, 0)").run();
  db.prepare("INSERT INTO services (id, name, price, type, active) VALUES (503, 'Общий анализ крови', 45000, 'lab', 1)").run();
  db.prepare("INSERT INTO consultation_types (id, name, name_ru, price, sort_order, active, duration_minutes, api_kind) VALUES (5, 'Первичный', 'Первичный приём', 100000, 1, 1, 30, 'initial')").run();
  db.prepare("INSERT INTO consultation_types (id, name, name_ru, price, sort_order, active, duration_minutes, api_kind) VALUES (6, 'Повторный', 'Повторный приём', 60000, 2, 1, 15, 'repeat')").run();
  db.prepare('INSERT INTO doctor_consultation_prices (doctor_id, consultation_type_id, price, available, is_free) VALUES (7, 5, 150000, 1, 0)').run();
  return db;
}

test('день врача сеткой по 15 минут: график и занятое; приём на 30 минут — только где свободны два окна подряд', () => {
  const db = seed();
  const MON = nextMonday();
  db.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date, duration_minutes, status) VALUES (3, 7, ?, 15, 'scheduled')")
    .run(new Date(MON.getFullYear(), MON.getMonth(), MON.getDate(), 9, 15).toISOString());
  const day = doctorDayWindows(db, { doctorId: 7, dayIso: iso(MON) });
  assert.equal(day.weekday, 'mon');
  assert.deepEqual(day.window, { from: '09:00', to: '10:00' });
  assert.deepEqual(day.windows, [{ start: '09:00', free: true }, { start: '09:15', free: false }, { start: '09:30', free: true }, { start: '09:45', free: true }]);
  const long = doctorDayWindows(db, { doctorId: 7, dayIso: iso(MON), durationMin: 30 });
  assert.deepEqual(long.windows.map((w) => w.free), [false, false, true, false], '09:00 — второе окно занято; 09:45 — выходит за конец дня');
  const wed = doctorDayWindows(db, { doctorId: 7, dayIso: addDays(iso(MON), 2) });
  assert.deepEqual([wed.window, wed.windows], [null, []], 'в среду врач не принимает');
});

test('превью: семь дней с завтрашнего, часы по дням, срок записи, очередь, консультации и услуги-консультации', () => {
  const db = seed();
  const out = doctorPublicPreview(db, { doctor_id: 7 }, admin);
  assert.equal(out.days.length, 7);
  assert.equal(out.days[0].date, addDays(today(db), 1));
  assert.deepEqual([out.scheduling_mode, out.booking_days, out.show_queue_count, out.slot_minutes, out.queue_now], ['schedulable', 30, true, 15, 0]);
  assert.deepEqual(out.hours.mon, ['09:00', '10:00']);
  assert.deepEqual(out.hours.tue, ['13:00', '14:00']);
  assert.equal(out.hours.wed, null);
  assert.deepEqual(out.consultations.map((c) => [c.consultation_type_id, c.price, c.own, c.minutes, c.api_kind]),
    [[5, 150000, true, 30, 'initial'], [6, 60000, false, 15, 'repeat']], 'без своей строки — общая цена (решение 8)');
  assert.equal(out.initial_minutes, 30);
  assert.deepEqual(out.services, [
    { service_id: 501, name: { ru: 'Консультация невролога', uz: 'Nevrolog konsultatsiyasi', en: '' }, price: 120000, own: false, online: true },
    { service_id: 502, name: { ru: 'Повторная консультация невролога', uz: '', en: '' }, price: 90000, own: true, online: false },
  ], 'только группа «Консультации»; своя цена — из «Услуг и ставок»');
});

test('ворота: «Сотрудники: Просмотр» или администратор; кассир — 403; неизвестный врач — 400', () => {
  const db = seed();
  assert.throws(() => doctorPublicPreview(db, { doctor_id: 7 }, cashier), (e) => e.status === 403 && e.message === PREVIEW_DENIED);
  const row = db.prepare("SELECT permissions FROM role_permissions WHERE role = 'cashier'").get();
  const perms = row ? JSON.parse(row.permissions) : { sections: [], levels: {} };
  perms.grants = { ...(perms.grants || {}), settings: 'view', 'settings.employees': 'view' };
  if (row) db.prepare("UPDATE role_permissions SET permissions = ? WHERE role = 'cashier'").run(JSON.stringify(perms));
  else db.prepare("INSERT INTO role_permissions (role, permissions) VALUES ('cashier', ?)").run(JSON.stringify(perms));
  assert.doesNotThrow(() => doctorPublicPreview(db, { doctor_id: 7 }, cashier));
  assert.throws(() => doctorPublicPreview(db, { doctor_id: 999 }, admin), (e) => e.status === 400);
});

test('зарегистрирован и только читает (идёт и при просроченной лицензии)', () => {
  assert.equal(typeof getRpc('doctor_public_preview'), 'function');
  assert.equal(isReadOnlyRpc('doctor_public_preview'), true);
});
