// STAFF_ATTENDANCE_V1 — правила отметки: коды, личность, филиал, повторы, частота, забытый уход.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { startParam, currentWindow, parseStart, verify, sign, qrSvg, secondsLeft, acceptedPastWindows } from './tokens.js';
import { registerScan, confirmScan, nextKind, myAttendance, CONFIRM_SECONDS, MAX_SHIFT_HOURS, RATE_MAX_SCANS } from './core.js';

const T0 = Date.parse('2026-11-27T04:00:00Z');   // 09:00 в Ташкенте
const SECRET = 'a'.repeat(64);

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT OR REPLACE INTO branches (id, name) VALUES (1, 'Главный'), (2, 'Лабзак')").run();
  const u = db.prepare('INSERT INTO users (id, username, password_hash, role, full_name, is_active, branch_id) VALUES (?, ?, ?, ?, ?, ?, ?)');
  u.run(10, 'nurse', 'x', 'nurse', 'Медсестра Анна', 1, null);
  u.run(11, 'lab', 'x', 'lab', 'Лаборант Бахром', 1, 2);
  u.run(12, 'gone', 'x', 'nurse', 'Уволенная Мария', 0, null);
  const l = db.prepare('INSERT INTO staff_telegram_links (user_id, tg_user_id, chat_id) VALUES (?, ?, ?)');
  l.run(10, '1001', '1001'); l.run(11, '1002', '1002'); l.run(12, '1003', '1003');
  db.prepare(`INSERT INTO attendance_locations (id, branch_id, name, token_secret, display_key, rotate_secs)
              VALUES (1, 1, 'Главный вход', ?, ?, 20), (2, NULL, 'Служебный вход', ?, ?, 20)`)
    .run(SECRET, 'k'.repeat(32), 'b'.repeat(64), 'j'.repeat(32));
  return db;
}
const loc = (db, id = 1) => db.prepare('SELECT * FROM attendance_locations WHERE id = ?').get(id);
const code = (db, id = 1, nowMs = T0, shift = 0) => { const l = loc(db, id); return startParam(l, currentWindow(l.rotate_secs, nowMs) + shift); };
const scan = (db, tg, nowMs = T0, id = 1, param = code(db, id, nowMs)) => registerScan(db, { tgUserId: tg, param, nowMs });
const flags = (db) => db.prepare('SELECT kind FROM attendance_flags ORDER BY id').all().map((r) => r.kind);

test('коды: подпись проверяется, окно — текущее или предыдущее, будущее и позапрошлое — отказ', () => {
  const l = { id: 1, token_secret: SECRET, rotate_secs: 20 };
  const w = currentWindow(20, T0);
  assert.equal(verify(l, parseStart(startParam(l, w)), T0), null);
  assert.equal(verify(l, parseStart(startParam(l, w - 1)), T0), null);
  assert.equal(verify(l, parseStart(startParam(l, w - 2)), T0), 'expired_token');
  assert.equal(verify(l, parseStart(startParam(l, w + 1)), T0), 'expired_token');
  const forged = `a_1_${w}_${sign('c'.repeat(64), 1, w)}`;
  assert.equal(verify(l, parseStart(forged), T0), 'bad_token');
  // Код другой точки к этой не подходит.
  assert.equal(verify({ ...l, id: 2 }, { ...parseStart(startParam(l, w)), locationId: 2 }, T0), 'bad_token');
  assert.equal(parseStart('lnk_abc'), null);
  assert.ok(startParam(l, w).length <= 64);
  assert.ok(secondsLeft(20, T0 + 5000) <= 20);
  assert.match(qrSvg('https://t.me/x?start=' + startParam(l, w)), /^<svg[^>]+viewBox/);
});

test('приход и уход: два шага, время — сервера, смена закрывается', () => {
  const db = fresh();
  const s1 = scan(db, '1001');
  assert.equal(s1.ok, true);
  assert.equal(s1.kind, 'in');
  const c1 = confirmScan(db, { tgUserId: '1001', scanId: s1.scanId, nowMs: T0 + 5000 });
  assert.deepEqual([c1.ok, c1.kind, c1.at], [true, 'in', '2026-11-27T04:00:05Z']);

  const later = T0 + 9 * 3600 * 1000;
  const s2 = scan(db, '1001', later);
  assert.equal(s2.kind, 'out');
  const c2 = confirmScan(db, { tgUserId: '1001', scanId: s2.scanId, nowMs: later + 3000 });
  assert.equal(c2.kind, 'out');
  assert.equal(c2.minutes, 540);
  const sess = db.prepare('SELECT * FROM attendance_sessions').all();
  assert.equal(sess.length, 1);
  assert.equal(sess[0].out_at, '2026-11-27T13:00:03Z');
  assert.deepEqual(db.prepare('SELECT kind FROM attendance_events ORDER BY id').all().map((r) => r.kind), ['in', 'out']);
});

test('без QR не отметиться: чужой Telegram, поддельный, просроченный код, выключенная точка, уволенный — отказ и флаг', () => {
  const db = fresh();
  assert.equal(scan(db, '9999').reason, 'unknown_telegram');
  const w = currentWindow(20, T0);
  assert.equal(registerScan(db, { tgUserId: '1001', param: `a_1_${w}_${'A'.repeat(16)}`, nowMs: T0 }).reason, 'bad_token');
  assert.equal(scan(db, '1001', T0, 1, code(db, 1, T0, -2)).reason, 'expired_token');
  assert.equal(scan(db, '1003').reason, 'inactive_employee');
  db.prepare('UPDATE attendance_locations SET active = 0 WHERE id = 1').run();
  assert.equal(scan(db, '1001').reason, 'inactive_location');
  assert.equal(registerScan(db, { tgUserId: '1001', chatType: 'group', param: code(db, 2), nowMs: T0 }).reason, 'not_private');
  assert.equal(registerScan(db, { tgUserId: '1001', param: 'hello', nowMs: T0 }).reason, 'not_a_code');
  assert.deepEqual(flags(db), ['unknown_telegram', 'bad_token', 'expired_token', 'inactive_employee', 'inactive_location', 'not_private']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM attendance_sessions').get().n, 0);
});

test('тот же код тем же человеком второй раз — повтор; другой сотрудник тем же кодом — может (очередь у входа)', () => {
  const db = fresh();
  const p = code(db);
  assert.equal(scan(db, '1001', T0, 1, p).ok, true);
  assert.equal(scan(db, '1001', T0 + 1000, 1, p).reason, 'replay');
  assert.equal(scan(db, '1002', T0 + 1000, 2, code(db, 2)).ok, true);
});

test('филиал: сотрудник Лабзака у входа главного здания — отказ; точка без филиала — можно; без филиалов — везде', () => {
  const db = fresh();
  assert.equal(scan(db, '1002').reason, 'branch_not_allowed');
  assert.equal(scan(db, '1002', T0, 2).ok, true);
  assert.equal(scan(db, '1001').ok, true);   // у медсестры филиал не назначен
});

test('подтверждение: чужое, просроченное, повторное — отказ', () => {
  const db = fresh();
  const s = scan(db, '1001');
  assert.equal(confirmScan(db, { tgUserId: '1002', scanId: s.scanId, nowMs: T0 }).reason, 'confirm_expired');
  assert.equal(confirmScan(db, { tgUserId: '1001', scanId: s.scanId, nowMs: T0 + (CONFIRM_SECONDS + 1) * 1000 }).reason, 'confirm_expired');
  const s2 = scan(db, '1001', T0 + 21000);
  assert.equal(confirmScan(db, { tgUserId: '1001', scanId: s2.scanId, nowMs: T0 + 22000 }).ok, true);
  assert.equal(confirmScan(db, { tgUserId: '1001', scanId: s2.scanId, nowMs: T0 + 23000 }).reason, 'confirm_expired');
});

test('двойной скан: уход через минуту после прихода — отказ, смена остаётся открытой', () => {
  const db = fresh();
  confirmScan(db, { tgUserId: '1001', scanId: scan(db, '1001').scanId, nowMs: T0 });
  const s = scan(db, '1001', T0 + 25000);
  assert.equal(s.kind, 'out');
  assert.equal(confirmScan(db, { tgUserId: '1001', scanId: s.scanId, nowMs: T0 + 26000 }).reason, 'too_soon');
  assert.equal(db.prepare('SELECT out_at FROM attendance_sessions').get().out_at, null);
});

test('забытый уход: через сутки скан — это приход, старая смена помечена «нет ухода», часы не выдуманы', () => {
  const db = fresh();
  confirmScan(db, { tgUserId: '1001', scanId: scan(db, '1001').scanId, nowMs: T0 });
  const next = T0 + (MAX_SHIFT_HOURS + 4) * 3600 * 1000;
  assert.equal(nextKind(db, 10, next), 'in');
  const s = scan(db, '1001', next);
  assert.equal(s.kind, 'in');
  assert.equal(confirmScan(db, { tgUserId: '1001', scanId: s.scanId, nowMs: next }).kind, 'in');
  const rows = db.prepare('SELECT out_at, missing_out FROM attendance_sessions ORDER BY id').all();
  assert.deepEqual(rows, [{ out_at: null, missing_out: 1 }, { out_at: null, missing_out: 0 }]);
  assert.ok(flags(db).includes('missing_out'));
});

test('частота: после лимита сканов за 10 минут — отказ rate_limited', () => {
  const db = fresh();
  for (let i = 0; i < RATE_MAX_SCANS; i++) scan(db, '1001', T0 + i * 21000);
  assert.equal(scan(db, '1001', T0 + RATE_MAX_SCANS * 21000).reason, 'rate_limited');
});

test('снятая за время подтверждения привязка — отметка не пишется', () => {
  const db = fresh();
  const s = scan(db, '1001');
  db.prepare("UPDATE staff_telegram_links SET revoked_at = '2026-11-27T04:00:01Z' WHERE user_id = 10").run();
  assert.equal(confirmScan(db, { tgUserId: '1001', scanId: s.scanId, nowMs: T0 + 2000 }).reason, 'unknown_telegram');
});

test('«Моя посещаемость»: открытая смена и часы за месяц', () => {
  const db = fresh();
  confirmScan(db, { tgUserId: '1001', scanId: scan(db, '1001').scanId, nowMs: T0 });
  const s = scan(db, '1001', T0 + 3600000);
  confirmScan(db, { tgUserId: '1001', scanId: s.scanId, nowMs: T0 + 3600000 });
  const m = myAttendance(db, 10, { days: 3650 });
  assert.equal(m.open, false);
  assert.equal(m.sessions.length, 1);
  assert.equal(m.sessions[0].in_location, 'Главный вход');
});

test('3-секундный код (мигр. 305): меняется каждые 3 с, принимается ~9–12 с, старше — отказ', () => {
  assert.equal(acceptedPastWindows(20), 1);
  assert.equal(acceptedPastWindows(3), 3);
  const l = { id: 1, token_secret: SECRET, rotate_secs: 3 };
  const w = currentWindow(3, T0);
  assert.equal(verify(l, parseStart(startParam(l, w)), T0), null);
  assert.equal(verify(l, parseStart(startParam(l, w - 3)), T0), null);   // 9 с назад — ещё принимается
  assert.equal(verify(l, parseStart(startParam(l, w - 4)), T0), 'expired_token');
  assert.equal(verify(l, parseStart(startParam(l, w + 1)), T0), 'expired_token');
});

test('новая точка по умолчанию — 3 секунды; меньше 3 база не примет', () => {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare(`INSERT INTO attendance_locations (id, name, token_secret, display_key) VALUES (9, 'Вход', ?, ?)`).run(SECRET, 'k'.repeat(32));
  assert.equal(db.prepare('SELECT rotate_secs FROM attendance_locations WHERE id = 9').get().rotate_secs, 3);
  assert.throws(() => db.prepare('UPDATE attendance_locations SET rotate_secs = 2 WHERE id = 9').run(), /CHECK/);
});
