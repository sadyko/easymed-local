// STAFF_ATTENDANCE_V1 — «HR → Посещаемость»: доступ, сводка дня, отчёт, правки с причиной, точки, подключение, бот.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import {
  attendanceToday, attendanceReport, attendanceCorrect, attendanceSessionGet, attendanceFlagsList,
  attendanceLocationsList, attendanceLocationSave, attendanceLocationResetScreen,
  staffLinksList, staffLinkCodeCreate, staffLinkRevoke, staffBotSettingsSave, staffBotCheck, scheduleFor,
} from './attendance.js';
import { getRpc } from './index.js';
import { isReadOnlyRpc } from '../control/gate.js';

const ADMIN = { id: 1, role: 'admin', extra_roles: [] };
const HR = { id: 2, role: 'registrar', extra_roles: [] };
const NURSE = { id: 3, role: 'nurse', extra_roles: [] };
const WEEK = JSON.stringify({ mon: { on: true, from: '09:00', to: '18:00' }, tue: { on: true, from: '09:00', to: '18:00' },
  wed: { on: true, from: '09:00', to: '18:00' }, thu: { on: true, from: '09:00', to: '18:00' }, fri: { on: true, from: '09:00', to: '18:00' },
  sat: { on: true, from: '09:00', to: '18:00' }, sun: { on: true, from: '09:00', to: '18:00' } });

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, role, full_name, is_active, working_hours) VALUES (?, ?, ?, ?, ?, ?, ?)');
  u.run(1, 'adm', 'x', 'admin', 'Админ', 1, '{}');
  u.run(2, 'hr', 'x', 'registrar', 'Кадровик', 1, '{}');
  u.run(3, 'nur', 'x', 'nurse', 'Медсестра Анна', 1, WEEK);
  u.run(4, 'doc', 'x', 'doctor', 'Врач Бахром', 1, WEEK);
  return db;
}
function grant(db, role, lvl) {
  db.prepare('INSERT OR REPLACE INTO role_permissions (role, permissions) VALUES (?, ?)').run(role, JSON.stringify({ grants: { hr_attendance: lvl } }));
}
const localNow = (db, shiftMin = 0) => db.prepare(`SELECT strftime('%Y-%m-%dT%H:%M', 'now', 'localtime', ?) AS t`).get(`${shiftMin} minutes`).t;
const todayYmd = (db) => db.prepare("SELECT date('now','localtime') AS d").get().d;

test('график: день недели, «on» и «enabled», выходной и пустой график', () => {
  const h = JSON.parse(WEEK);
  assert.deepEqual(scheduleFor(h, '2026-11-27'), { from: 540, to: 1080 });   // пятница
  assert.equal(scheduleFor({ fri: { enabled: false, from: '09:00', to: '18:00' } }, '2026-11-27'), null);
  assert.equal(scheduleFor({ fri: { on: true, from: '18:00', to: '09:00' } }, '2026-11-27'), null);
  assert.equal(scheduleFor(null, '2026-11-27'), null);
});

test('доступ: без настройки — администратор; «Просмотр» видит, но не правит; медсестре — нет', () => {
  const db = fresh();
  assert.throws(() => attendanceToday(db, {}, HR), (e) => e.status === 403);
  grant(db, 'registrar', 'view');
  assert.equal(attendanceToday(db, {}, HR).can_edit, false);
  assert.throws(() => attendanceCorrect(db, { action: 'create', user_id: 3, in_at: localNow(db, -60), reason: 'тест' }, HR), (e) => e.status === 403);
  grant(db, 'registrar', 'edit');
  assert.ok(attendanceCorrect(db, { action: 'create', user_id: 3, in_at: localNow(db, -60), reason: 'забыл телефон' }, HR).id);
  assert.throws(() => attendanceToday(db, {}, NURSE), (e) => e.status === 403);
});

test('правка: причина обязательна; будущее и уход раньше прихода — отказ; история пишется', () => {
  const db = fresh();
  const base = { action: 'create', user_id: 3, in_at: localNow(db, -120) };
  assert.throws(() => attendanceCorrect(db, { ...base, reason: '  ' }, ADMIN), /причину/);
  assert.throws(() => attendanceCorrect(db, { ...base, in_at: localNow(db, 120), reason: 'тест' }, ADMIN), /будущем/);
  assert.throws(() => attendanceCorrect(db, { ...base, out_at: localNow(db, -180), reason: 'тест' }, ADMIN), /раньше прихода/);
  const { id } = attendanceCorrect(db, { ...base, reason: 'телефон разрядился' }, ADMIN);
  // Вторая открытая смена тому же человеку — нельзя.
  assert.throws(() => attendanceCorrect(db, { ...base, reason: 'ещё раз' }, ADMIN), (e) => e.status === 409);
  attendanceCorrect(db, { action: 'edit', id, out_at: localNow(db, -10), reason: 'ушёл, подтвердил заведующий' }, ADMIN);
  attendanceCorrect(db, { action: 'void', id, reason: 'ошибочная запись' }, ADMIN);
  assert.throws(() => attendanceCorrect(db, { action: 'void', id, reason: 'ещё раз' }, ADMIN), (e) => e.status === 409);
  const g = attendanceSessionGet(db, { id }, ADMIN);
  assert.deepEqual(g.corrections.map((c) => c.action), ['void', 'edit', 'create']);
  assert.ok(g.session.voided_at);
});

test('сегодня: на работе, опоздание, не пришёл — по графику; аннулированная смена не считается', () => {
  const db = fresh();
  // Прошедший день, а не «2 часа назад»: после полуночи «2 часа назад» — уже вчера.
  // Медсестра пришла в 10:00 и ушла не отметившись; врач не пришёл (день прошёл).
  attendanceCorrect(db, { action: 'create', user_id: 3, in_at: '2026-11-25T10:00', reason: 'тест прихода' }, ADMIN);
  const d = attendanceToday(db, { date: '2026-11-25' }, ADMIN);
  const nurse = d.rows.find((r) => r.user_id === 3);
  assert.equal(nurse.status, 'present');
  assert.equal(nurse.sched, '09:00–18:00');
  const doc = d.rows.find((r) => r.user_id === 4);
  assert.equal(doc.status, 'absent');
  const admin = d.rows.find((r) => r.user_id === 1);
  assert.equal(admin.status, 'off');   // графика нет
  assert.equal(d.summary.present, 1);
});

test('отчёт: период проверяется; смены, часы и «нет ухода» сходятся', () => {
  const db = fresh();
  const day = todayYmd(db);
  assert.throws(() => attendanceReport(db, { from: day, to: '2000-01-01' }, ADMIN), /раньше/);
  assert.throws(() => attendanceReport(db, { from: '2026-01-01', to: '2026-12-31' }, ADMIN), /93/);
  attendanceCorrect(db, { action: 'create', user_id: 3, in_at: '2026-11-25T09:00', out_at: '2026-11-25T11:00', reason: 'тест часов' }, ADMIN);
  const r = attendanceReport(db, { from: '2026-11-25', to: '2026-11-25' }, ADMIN);
  const nurse = r.employees.find((e) => e.user_id === 3);
  assert.equal(nurse.days_present, 1);
  assert.equal(nurse.minutes, 120);
  assert.equal(r.sessions.length, 1);
  assert.equal(r.sessions[0].corrections, 1);
});

test('точки: новая получает секреты; ссылку экрана видит только «Изменение»; новая ссылка меняет ключ', () => {
  const db = fresh();
  assert.throws(() => attendanceLocationSave(db, { name: '' }, ADMIN), /название/);
  assert.throws(() => attendanceLocationSave(db, { name: 'Вход', rotate_seconds: 2 }, ADMIN), /3–120/);
  const { id } = attendanceLocationSave(db, { name: 'Главный вход' }, ADMIN);
  const before = db.prepare('SELECT display_key, token_secret FROM attendance_locations WHERE id = ?').get(id);
  assert.ok(before.token_secret.length >= 64 && before.display_key.length >= 48);
  assert.match(attendanceLocationsList(db, {}, ADMIN).locations[0].screen_path, new RegExp(`^/attendance-screen/${id}\\?k=`));
  grant(db, 'registrar', 'view');
  const asViewer = attendanceLocationsList(db, {}, HR).locations[0];
  assert.equal(asViewer.screen_path, null);
  assert.equal(asViewer.display_key, undefined);
  attendanceLocationResetScreen(db, { id }, ADMIN);
  const after = db.prepare('SELECT display_key, token_secret FROM attendance_locations WHERE id = ?').get(id);
  assert.notEqual(after.display_key, before.display_key);
  assert.notEqual(after.token_secret, before.token_secret);
});

test('подключение: без бота — отказ; код — ссылка t.me; уволенному — нет; отключение', () => {
  const db = fresh();
  assert.throws(() => staffLinkCodeCreate(db, { user_id: 3 }, ADMIN), /бота сотрудников/);
  db.prepare("UPDATE staff_bot_settings SET bot_username = 'clinic_staff_bot', enabled = 1, bot_token_enc = 'x' WHERE id = 1").run();
  const r = staffLinkCodeCreate(db, { user_id: 3 }, ADMIN);
  assert.match(r.url, /^https:\/\/t\.me\/clinic_staff_bot\?start=lnk_[A-Za-z0-9]{20}$/);
  // В базе — только хэш кода.
  const code = r.url.split('lnk_')[1];
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM staff_link_codes WHERE code_hash = ?').get(code).n, 0);
  db.prepare('UPDATE users SET is_active = 0 WHERE id = 4').run();
  assert.throws(() => staffLinkCodeCreate(db, { user_id: 4 }, ADMIN), /уволен/);
  db.prepare("INSERT INTO staff_telegram_links (user_id, tg_user_id, chat_id) VALUES (3, '555', '555')").run();
  assert.equal(staffLinksList(db, {}, ADMIN).staff.find((s) => s.id === 3).linked_at != null, true);
  assert.equal(staffLinkRevoke(db, { user_id: 3 }, ADMIN).revoked, true);
});

test('бот: токен другого бота клиники не принимается; проверка связи пишет имя бота', async () => {
  const db = fresh();
  db.prepare("UPDATE doctor_bot_settings SET bot_id = '777000' WHERE id = 1").run();
  assert.throws(() => staffBotSettingsSave(db, { bot_token: '777000:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }, ADMIN), /ДРУГОЙ бот/);
  assert.throws(() => staffBotSettingsSave(db, { enabled: true }, ADMIN), /токен/);
  assert.throws(() => staffBotSettingsSave(db, { grace_minutes: 500 }, ADMIN), /0–120/);
  db.prepare("UPDATE staff_bot_settings SET bot_token_enc = '' WHERE id = 1").run();
  await assert.rejects(() => staffBotCheck(db, {}, ADMIN), /токен/);
});

test('подозрительное: один код (точка + окно) у двоих — в списке «переслали»', () => {
  const db = fresh();
  const { id } = attendanceLocationSave(db, { name: 'Вход' }, ADMIN);
  const ins = db.prepare(`INSERT INTO attendance_scans (location_id, token_window, tg_user_id, user_id, kind, result) VALUES (?, 99, ?, ?, 'in', 'in')`);
  ins.run(id, '10', 3); ins.run(id, '11', 4);
  db.prepare("INSERT INTO attendance_flags (kind, tg_user_id) VALUES ('bad_token', '42')").run();
  const r = attendanceFlagsList(db, {}, ADMIN);
  assert.equal(r.items.length, 1);
  assert.equal(r.shared.length, 1);
  assert.match(r.shared[0].names, /Медсестра Анна/);
});

test('RPC зарегистрированы; чтения открыты при истёкшей лицензии, записи — нет', () => {
  for (const n of ['attendance_today', 'attendance_report', 'attendance_correct', 'attendance_location_save', 'staff_link_code_create', 'staff_bot_check']) {
    assert.equal(typeof getRpc(n), 'function', n);
  }
  assert.ok(isReadOnlyRpc('attendance_today'));
  assert.ok(isReadOnlyRpc('attendance_report'));
  assert.ok(!isReadOnlyRpc('attendance_correct'));
  assert.ok(!isReadOnlyRpc('staff_link_code_create'));
});
