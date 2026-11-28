// STAFF_ATTENDANCE_V1 — «HR → Посещаемость»: сервер экрана HR.
//
//   Сегодня   — кто на работе, кто ушёл, кто не пришёл, опоздания, ранние
//               уходы, незакрытые смены (attendance_today);
//   Отчёт     — за период по сотрудникам: дни, часы, опоздания, ранние уходы,
//               «нет ухода», прогулы по графику; смены строками для Excel
//               (attendance_report);
//   Правка    — HR создаёт, правит или аннулирует смену с ОБЯЗАТЕЛЬНОЙ
//               причиной; старое и новое значения пишутся в
//               attendance_corrections (attendance_correct);
//   Точки     — входы и ссылки экранов QR (attendance_location_*);
//   Сотрудники и Telegram — коды подключения, отключение (staff_link_*);
//   Бот       — токен, проверка связи, «опоздание после N минут» (staff_bot_*);
//   Подозрительное — отказы и странные попытки (attendance_flags_list).
//
// График — users.working_hours (тот же, что в анкете сотрудника): день
// включён и часы «с — до». Опоздание — приход позже «с» больше чем на
// grace_minutes; ранний уход — последний уход раньше «до» больше чем на столько же.
//
// Право — строка «Ролей» hr_attendance («HR · Посещаемость»): «Просмотр» —
// видеть, «Изменение» — правки, точки, бот, подключения. Не настроена —
// только администратор.
import { grantAllowsAdminOr } from '../grants.js';
import { today as clinicToday } from '../domain/day.js';
import { newSecret } from '../attendance/tokens.js';
import { publicSettings, saveSettings, clearToken, getDecryptedToken, recordCheck, SettingsError } from '../staff-bot/settings.js';
import { issueLinkCode, revokeLink } from '../staff-bot/linking.js';
import { getMe } from '../telegram/api.js';
import { wakeStaffBot } from '../staff-bot/index.js';

export class RpcError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const KEY = 'hr_attendance';
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_DT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const WEEK = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MAX_RANGE_DAYS = 93;

function need(db, user, level) {
  if (!user || !user.id) throw new RpcError('Нужно войти в систему.', 401);
  if (!grantAllowsAdminOr(db, user, KEY, 'view')) {
    throw new RpcError('«Посещаемость» недоступна вашей роли. Доступ выдаёт администратор в «Настройки → Роли» (строка «HR · Посещаемость»).', 403);
  }
  if (level === 'edit' && !grantAllowsAdminOr(db, user, KEY, 'edit')) {
    throw new RpcError('У вас доступ «Просмотр»: менять отметки, точки и бота нельзя.', 403);
  }
}

function posInt(v, what) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new RpcError(what, 400);
  return n;
}
function optId(v, what) { return v == null || v === '' ? null : posInt(v, what); }
function ymd(v, what) {
  const s = String(v || '');
  if (!YMD.test(s)) throw new RpcError(`Дата «${what}» не разобрана.`, 400);
  return s;
}

// ---- график ----------------------------------------------------------------
function parseHours(raw) {
  if (!raw) return null;
  try { const o = typeof raw === 'string' ? JSON.parse(raw) : raw; return o && typeof o === 'object' ? o : null; } catch { return null; }
}
const toMin = (hhmm) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };

/** График сотрудника на дату: { from, to } в минутах или null — выходной / графика нет. */
export function scheduleFor(hours, dateYmd) {
  if (!hours) return null;
  const slot = hours[WEEK[new Date(dateYmd + 'T00:00:00Z').getUTCDay()]];
  if (!slot || slot.on === false || slot.enabled === false) return null;
  const from = toMin(slot.from); const to = toMin(slot.to);
  if (from == null || to == null || to <= from) return null;
  return { from, to };
}

function addDays(dateYmd, n) {
  const d = new Date(dateYmd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function grace(db) {
  const r = db.prepare('SELECT grace_minutes FROM staff_bot_settings WHERE id = 1').get();
  return r ? r.grace_minutes : 10;
}

function staffRows(db, { department_id, branch_id, user_id, position } = {}) {
  const where = ['u.is_active = 1'];
  const p = {};
  if (department_id) { where.push('u.department_id = @department_id'); p.department_id = department_id; }
  if (branch_id) { where.push('(u.branch_id = @branch_id OR EXISTS (SELECT 1 FROM user_branches ub WHERE ub.user_id = u.id AND ub.branch_id = @branch_id))'); p.branch_id = branch_id; }
  if (user_id) { where.push('u.id = @user_id'); p.user_id = user_id; }
  if (position) { where.push('u.position = @position'); p.position = position; }
  return db.prepare(`SELECT u.id, u.full_name, u.position, u.working_hours, u.department_id, d.name AS department, u.branch_id, b.name AS branch,
                            (SELECT COUNT(*) FROM staff_telegram_links l WHERE l.user_id = u.id AND l.revoked_at IS NULL) AS linked
                       FROM users u LEFT JOIN departments d ON d.id = u.department_id LEFT JOIN branches b ON b.id = u.branch_id
                      WHERE ${where.join(' AND ')} ORDER BY u.full_name COLLATE NOCASE, u.id`).all(p);
}

function sessionsIn(db, fromYmd, toYmd, userIds) {
  if (!userIds.length) return [];
  return db.prepare(`
    SELECT s.id, s.user_id, s.in_at, s.out_at, s.missing_out, s.source,
           date(s.in_at, 'localtime') AS day,
           strftime('%H:%M', s.in_at, 'localtime') AS in_time, strftime('%H:%M', s.out_at, 'localtime') AS out_time,
           CAST(strftime('%H', s.in_at, 'localtime') AS INTEGER) * 60 + CAST(strftime('%M', s.in_at, 'localtime') AS INTEGER) AS in_min,
           CASE WHEN s.out_at IS NULL THEN NULL ELSE
             (julianday(date(s.out_at, 'localtime')) - julianday(date(s.in_at, 'localtime'))) * 1440
             + CAST(strftime('%H', s.out_at, 'localtime') AS INTEGER) * 60 + CAST(strftime('%M', s.out_at, 'localtime') AS INTEGER) END AS out_min,
           CASE WHEN s.out_at IS NULL THEN NULL ELSE CAST(ROUND((julianday(s.out_at) - julianday(s.in_at)) * 1440) AS INTEGER) END AS minutes,
           li.name AS in_location, lo.name AS out_location,
           (SELECT COUNT(*) FROM attendance_corrections c WHERE c.session_id = s.id) AS corrections
      FROM attendance_sessions s
      LEFT JOIN attendance_locations li ON li.id = s.in_location_id
      LEFT JOIN attendance_locations lo ON lo.id = s.out_location_id
     WHERE s.voided_at IS NULL AND date(s.in_at, 'localtime') BETWEEN ? AND ?
       AND s.user_id IN (${userIds.map(() => '?').join(',')})
     ORDER BY s.in_at`).all(fromYmd, toYmd, ...userIds);
}

/** Итог дня сотрудника по его сменам и графику. */
function dayFacts(sessions, sched, g, { isToday, nowMin }) {
  const first = sessions[0] || null;
  const open = sessions.find((s) => !s.out_at && !s.missing_out) || null;
  const closed = sessions.filter((s) => s.out_at);
  const last = closed.length ? closed[closed.length - 1] : null;
  const minutes = closed.reduce((a, s) => a + (s.minutes || 0), 0);
  const late = first && sched && first.in_min > sched.from + g ? first.in_min - sched.from : 0;
  const early = !open && last && sched && last.out_min < sched.to - g ? sched.to - last.out_min : 0;
  const missingOut = sessions.some((s) => s.missing_out);
  let status;
  if (open) status = 'present';
  else if (sessions.length) status = 'left';
  else if (!sched) status = 'off';
  else if (isToday && nowMin <= sched.from + g) status = 'expected';
  else status = 'absent';
  return {
    status, first_in: first ? first.in_time : null, last_out: last ? last.out_time : null,
    minutes, late_min: late, early_min: early, missing_out: missingOut,
    sched_from: sched ? sched.from : null, sched_to: sched ? sched.to : null,
  };
}

const hhmm = (min) => (min == null ? null : `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`);

function filtersOf(a) {
  return {
    department_id: optId(a.department_id, 'Отдел не выбран.'),
    branch_id: optId(a.branch_id, 'Филиал не выбран.'),
    user_id: optId(a.user_id, 'Сотрудник не выбран.'),
    position: a.position ? String(a.position).slice(0, 200) : null,
  };
}

function options(db) {
  return {
    departments: db.prepare('SELECT id, name FROM departments WHERE active = 1 ORDER BY name COLLATE NOCASE').all(),
    branches: db.prepare('SELECT id, name FROM branches WHERE active = 1 ORDER BY id').all(),
    positions: db.prepare(`SELECT DISTINCT position AS v FROM users WHERE is_active = 1 AND COALESCE(position, '') <> '' ORDER BY position COLLATE NOCASE`).all().map((r) => r.v),
  };
}

// ---- Сегодня ---------------------------------------------------------------
export function attendanceToday(db, args, user) {
  need(db, user, 'view');
  const a = args || {};
  const day = a.date ? ymd(a.date, 'День') : clinicToday(db);
  const isToday = day === clinicToday(db);
  const nowMin = db.prepare("SELECT CAST(strftime('%H','now','localtime') AS INTEGER) * 60 + CAST(strftime('%M','now','localtime') AS INTEGER) AS m").get().m;
  const g = grace(db);
  const staff = staffRows(db, filtersOf(a));
  const byUser = new Map();
  for (const s of sessionsIn(db, day, day, staff.map((u) => u.id))) {
    if (!byUser.has(s.user_id)) byUser.set(s.user_id, []);
    byUser.get(s.user_id).push(s);
  }
  // Незакрытые смены прошлых дней — «нет ухода», отдельным списком.
  const stale = db.prepare(`
    SELECT s.id, s.user_id, u.full_name, s.in_at, date(s.in_at, 'localtime') AS day, strftime('%H:%M', s.in_at, 'localtime') AS in_time, s.missing_out
      FROM attendance_sessions s JOIN users u ON u.id = s.user_id
     WHERE s.voided_at IS NULL AND s.out_at IS NULL AND date(s.in_at, 'localtime') < ?
       AND date(s.in_at, 'localtime') >= date(?, '-30 days')
     ORDER BY s.in_at DESC`).all(day, day).filter((s) => staff.some((u) => u.id === s.user_id));

  const rows = staff.map((u) => {
    const sessions = byUser.get(u.id) || [];
    const f = dayFacts(sessions, scheduleFor(parseHours(u.working_hours), day), g, { isToday, nowMin });
    return {
      user_id: u.id, full_name: u.full_name, position: u.position || '', department: u.department || '', branch: u.branch || '',
      linked: !!u.linked, ...f, sched: f.sched_from == null ? null : `${hhmm(f.sched_from)}–${hhmm(f.sched_to)}`,
      sessions: sessions.map((s) => ({ id: s.id, in_time: s.in_time, out_time: s.out_time, missing_out: !!s.missing_out, in_location: s.in_location, out_location: s.out_location, corrections: s.corrections })),
    };
  });
  const count = (fn) => rows.filter(fn).length;
  return {
    date: day, is_today: isToday, grace_minutes: g,
    summary: {
      total: rows.length, present: count((r) => r.status === 'present'), left: count((r) => r.status === 'left'),
      absent: count((r) => r.status === 'absent'), expected: count((r) => r.status === 'expected'), off: count((r) => r.status === 'off'),
      late: count((r) => r.late_min > 0), early: count((r) => r.early_min > 0), missing_out: stale.length,
    },
    rows, stale, options: options(db), can_edit: grantAllowsAdminOr(db, user, KEY, 'edit'),
  };
}

// ---- Отчёт за период -------------------------------------------------------
export function attendanceReport(db, args, user) {
  need(db, user, 'view');
  const a = args || {};
  const from = ymd(a.from, 'С'); const to = ymd(a.to, 'По');
  if (to < from) throw new RpcError('Дата «по» раньше даты «с».', 400);
  const span = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
  if (span > MAX_RANGE_DAYS) throw new RpcError(`Период — не длиннее ${MAX_RANGE_DAYS} дней.`, 400);
  const g = grace(db);
  const todayYmd = clinicToday(db);
  const nowMin = db.prepare("SELECT CAST(strftime('%H','now','localtime') AS INTEGER) * 60 + CAST(strftime('%M','now','localtime') AS INTEGER) AS m").get().m;
  const staff = staffRows(db, filtersOf(a));
  const sessions = sessionsIn(db, from, to, staff.map((u) => u.id));
  const byUserDay = new Map();
  for (const s of sessions) {
    const k = `${s.user_id}|${s.day}`;
    if (!byUserDay.has(k)) byUserDay.set(k, []);
    byUserDay.get(k).push(s);
  }
  const employees = staff.map((u) => {
    const hours = parseHours(u.working_hours);
    const t = { days_present: 0, minutes: 0, late_days: 0, late_min: 0, early_days: 0, missing_out: 0, absent_days: 0, scheduled_days: 0 };
    for (let d = from; d <= to; d = addDays(d, 1)) {
      if (d > todayYmd) break;
      const sched = scheduleFor(hours, d);
      const list = byUserDay.get(`${u.id}|${d}`) || [];
      if (sched) t.scheduled_days += 1;
      const f = dayFacts(list, sched, g, { isToday: d === todayYmd, nowMin });
      if (list.length) t.days_present += 1;
      t.minutes += f.minutes;
      if (f.late_min) { t.late_days += 1; t.late_min += f.late_min; }
      if (f.early_min) t.early_days += 1;
      if (f.missing_out) t.missing_out += 1;
      if (f.status === 'absent') t.absent_days += 1;
    }
    return { user_id: u.id, full_name: u.full_name, position: u.position || '', department: u.department || '', branch: u.branch || '', ...t };
  });
  const names = new Map(staff.map((u) => [u.id, u]));
  return {
    from, to, grace_minutes: g, employees,
    sessions: sessions.map((s) => ({
      id: s.id, user_id: s.user_id, full_name: names.get(s.user_id)?.full_name || '', department: names.get(s.user_id)?.department || '',
      day: s.day, in_time: s.in_time, out_time: s.out_time, minutes: s.minutes, missing_out: !!s.missing_out,
      in_location: s.in_location, out_location: s.out_location, source: s.source, corrections: s.corrections,
    })),
    options: options(db), can_edit: grantAllowsAdminOr(db, user, KEY, 'edit'),
  };
}

// ---- Правка HR -------------------------------------------------------------
function localToUtc(db, v, what) {
  if (v == null || v === '') return null;
  const s = String(v);
  if (!LOCAL_DT.test(s)) throw new RpcError(`Время «${what}» не разобрано.`, 400);
  return db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ', ?, 'utc') AS t").get(s + ':00').t;
}

/** Смена с историей правок — окну правки. */
export function attendanceSessionGet(db, args, user) {
  need(db, user, 'view');
  const id = posInt(args && args.id, 'Смена не выбрана.');
  const s = db.prepare(`SELECT s.*, u.full_name, strftime('%Y-%m-%dT%H:%M', s.in_at, 'localtime') AS in_local,
                               strftime('%Y-%m-%dT%H:%M', s.out_at, 'localtime') AS out_local
                          FROM attendance_sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`).get(id);
  if (!s) throw new RpcError('Смена не найдена.', 404);
  const corrections = db.prepare(`
    SELECT c.action, c.reason, c.at, b.full_name AS by_name,
           strftime('%d.%m %H:%M', c.old_in_at, 'localtime') AS old_in, strftime('%d.%m %H:%M', c.old_out_at, 'localtime') AS old_out,
           strftime('%d.%m %H:%M', c.new_in_at, 'localtime') AS new_in, strftime('%d.%m %H:%M', c.new_out_at, 'localtime') AS new_out
      FROM attendance_corrections c LEFT JOIN users b ON b.id = c.by_user WHERE c.session_id = ? ORDER BY c.id DESC`).all(id);
  return { session: s, corrections };
}

/**
 * Правка HR. action:
 *   'create' — смена вручную (человек забыл телефон): user_id, in_at, out_at?;
 *   'edit'   — поправить приход и/или уход существующей смены: id, in_at, out_at?;
 *   'void'   — аннулировать смену (отметка по ошибке): id.
 * Время — местное 'YYYY-MM-DDTHH:MM'. Причина — обязательно (от 3 символов).
 */
export function attendanceCorrect(db, args, user) {
  need(db, user, 'edit');
  const a = args || {};
  const reason = String(a.reason || '').trim();
  if (reason.length < 3) throw new RpcError('Напишите причину правки.', 400);
  if (reason.length > 1000) throw new RpcError('Причина — не длиннее 1000 символов.', 400);
  const action = String(a.action || '');
  if (!['create', 'edit', 'void'].includes(action)) throw new RpcError('Неизвестное действие правки.', 400);
  const now = db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now') AS t").get().t;

  return db.transaction(() => {
    if (action === 'create') {
      const userId = posInt(a.user_id, 'Сотрудник не выбран.');
      if (!db.prepare('SELECT id FROM users WHERE id = ?').get(userId)) throw new RpcError('Сотрудник не найден.', 404);
      const inAt = localToUtc(db, a.in_at, 'Приход');
      if (!inAt) throw new RpcError('Укажите время прихода.', 400);
      const outAt = localToUtc(db, a.out_at, 'Уход');
      if (outAt && outAt < inAt) throw new RpcError('Уход раньше прихода.', 400);
      if (inAt > now || (outAt && outAt > now)) throw new RpcError('Время в будущем отметить нельзя.', 400);
      if (!outAt && db.prepare('SELECT id FROM attendance_sessions WHERE user_id = ? AND out_at IS NULL AND missing_out = 0 AND voided_at IS NULL').get(userId)) {
        throw new RpcError('У сотрудника уже есть открытая смена — укажите время ухода или поправьте ту смену.', 409);
      }
      const id = Number(db.prepare(`INSERT INTO attendance_sessions (user_id, in_at, out_at, source, created_at, updated_at) VALUES (?, ?, ?, 'correction', ?, ?)`)
        .run(userId, inAt, outAt, now, now).lastInsertRowid);
      db.prepare(`INSERT INTO attendance_corrections (session_id, user_id, action, new_in_at, new_out_at, reason, by_user) VALUES (?, ?, 'create', ?, ?, ?, ?)`)
        .run(id, userId, inAt, outAt, reason, user.id);
      db.prepare(`INSERT INTO attendance_events (user_id, session_id, kind, at, source, by_user) VALUES (?, ?, 'correction', ?, 'correction', ?)`).run(userId, id, now, user.id);
      return { id };
    }
    const id = posInt(a.id, 'Смена не выбрана.');
    const s = db.prepare('SELECT * FROM attendance_sessions WHERE id = ?').get(id);
    if (!s) throw new RpcError('Смена не найдена.', 404);
    if (s.voided_at) throw new RpcError('Смена уже аннулирована.', 409);
    if (action === 'void') {
      db.prepare('UPDATE attendance_sessions SET voided_at = ?, updated_at = ? WHERE id = ?').run(now, now, id);
      db.prepare(`INSERT INTO attendance_corrections (session_id, user_id, action, old_in_at, old_out_at, reason, by_user) VALUES (?, ?, 'void', ?, ?, ?, ?)`)
        .run(id, s.user_id, s.in_at, s.out_at, reason, user.id);
    } else {
      const inAt = localToUtc(db, a.in_at, 'Приход') || s.in_at;
      const outAt = a.out_at === undefined ? s.out_at : localToUtc(db, a.out_at, 'Уход');
      if (outAt && outAt < inAt) throw new RpcError('Уход раньше прихода.', 400);
      if (inAt > now || (outAt && outAt > now)) throw new RpcError('Время в будущем отметить нельзя.', 400);
      if (inAt === s.in_at && outAt === s.out_at) return { id, changed: false };
      // Поставили уход «забытой» смене — она больше не «нет ухода».
      const missing = outAt ? 0 : s.missing_out;
      if (!outAt && !missing && db.prepare('SELECT id FROM attendance_sessions WHERE user_id = ? AND id <> ? AND out_at IS NULL AND missing_out = 0 AND voided_at IS NULL').get(s.user_id, id)) {
        throw new RpcError('У сотрудника уже есть другая открытая смена.', 409);
      }
      db.prepare('UPDATE attendance_sessions SET in_at = ?, out_at = ?, missing_out = ?, updated_at = ? WHERE id = ?').run(inAt, outAt, missing, now, id);
      db.prepare(`INSERT INTO attendance_corrections (session_id, user_id, action, old_in_at, old_out_at, new_in_at, new_out_at, reason, by_user)
                  VALUES (?, ?, 'edit', ?, ?, ?, ?, ?, ?)`).run(id, s.user_id, s.in_at, s.out_at, inAt, outAt, reason, user.id);
    }
    db.prepare(`INSERT INTO attendance_events (user_id, session_id, kind, at, source, by_user) VALUES (?, ?, 'correction', ?, 'correction', ?)`).run(s.user_id, id, now, user.id);
    return { id, changed: true };
  })();
}

// ---- Подозрительное --------------------------------------------------------
export function attendanceFlagsList(db, args, user) {
  need(db, user, 'view');
  const a = args || {};
  const from = a.from ? ymd(a.from, 'С') : clinicToday(db);
  const to = a.to ? ymd(a.to, 'По') : from;
  const items = db.prepare(`
    SELECT f.id, f.kind, f.tg_user_id, f.detail, strftime('%d.%m.%Y %H:%M:%S', f.at, 'localtime') AS at_local,
           u.full_name, l.name AS location
      FROM attendance_flags f LEFT JOIN users u ON u.id = f.user_id LEFT JOIN attendance_locations l ON l.id = f.location_id
     WHERE date(f.at, 'localtime') BETWEEN ? AND ? ORDER BY f.id DESC LIMIT 500`).all(from, to);
  // Один и тот же код (точка + окно) у разных сотрудников — возможно, код переслали.
  const shared = db.prepare(`
    SELECT s.location_id, l.name AS location, s.token_window, GROUP_CONCAT(u.full_name, ', ') AS names, COUNT(*) AS n,
           strftime('%d.%m.%Y %H:%M', MIN(s.created_at), 'localtime') AS at_local
      FROM attendance_scans s JOIN users u ON u.id = s.user_id JOIN attendance_locations l ON l.id = s.location_id
     WHERE s.result IN ('in', 'out') AND date(s.created_at, 'localtime') BETWEEN ? AND ?
     GROUP BY s.location_id, s.token_window HAVING COUNT(*) > 1 ORDER BY MIN(s.created_at) DESC LIMIT 200`).all(from, to);
  return { from, to, items, shared };
}

// ---- Точки входа -----------------------------------------------------------
export function attendanceLocationsList(db, args, user) {
  need(db, user, 'view');
  const canEdit = grantAllowsAdminOr(db, user, KEY, 'edit');
  const rows = db.prepare(`SELECT l.id, l.name, l.branch_id, b.name AS branch, l.active, l.rotate_secs AS rotate_seconds, l.display_key, l.created_at
                             FROM attendance_locations l LEFT JOIN branches b ON b.id = l.branch_id ORDER BY l.active DESC, l.name COLLATE NOCASE`).all();
  // Ссылку экрана видит только «Изменение»: по ней показывают коды у входа.
  return {
    locations: rows.map((r) => ({ ...r, display_key: undefined, screen_path: canEdit ? `/attendance-screen/${r.id}?k=${r.display_key}` : null })),
    branches: db.prepare('SELECT id, name FROM branches WHERE active = 1 ORDER BY id').all(),
    can_edit: canEdit,
  };
}

export function attendanceLocationSave(db, args, user) {
  need(db, user, 'edit');
  const a = args || {};
  const name = String(a.name || '').trim();
  if (!name) throw new RpcError('Напишите название точки, например «Главный вход».', 400);
  if (name.length > 200) throw new RpcError('Название — не длиннее 200 символов.', 400);
  const branchId = optId(a.branch_id, 'Филиал не выбран.');
  if (branchId && !db.prepare('SELECT id FROM branches WHERE id = ?').get(branchId)) throw new RpcError('Филиал не найден.', 404);
  // STAFF_ATTENDANCE_FAST_QR_V1 — 3–120 с, по умолчанию 3 (мигр. 305: колонка rotate_secs).
  const rotate = a.rotate_seconds == null || a.rotate_seconds === '' ? 3 : Number(a.rotate_seconds);
  if (!Number.isInteger(rotate) || rotate < 3 || rotate > 120) throw new RpcError('Код меняется раз в 3–120 секунд.', 400);
  const active = a.active === undefined ? 1 : (a.active ? 1 : 0);
  if (a.id != null && a.id !== '') {
    const id = posInt(a.id, 'Точка не выбрана.');
    const r = db.prepare(`UPDATE attendance_locations SET name = ?, branch_id = ?, rotate_secs = ?, active = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`)
      .run(name, branchId, rotate, active, id);
    if (!r.changes) throw new RpcError('Точка не найдена.', 404);
    return { id };
  }
  const r = db.prepare(`INSERT INTO attendance_locations (branch_id, name, active, token_secret, display_key, rotate_secs, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(branchId, name, active, newSecret(32), newSecret(24), rotate, user.id);
  return { id: Number(r.lastInsertRowid) };
}

/** Новая ссылка экрана (утекла старая) и новый секрет подписи — старые коды и ссылка перестают работать. */
export function attendanceLocationResetScreen(db, args, user) {
  need(db, user, 'edit');
  const id = posInt(args && args.id, 'Точка не выбрана.');
  const r = db.prepare(`UPDATE attendance_locations SET display_key = ?, token_secret = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`)
    .run(newSecret(24), newSecret(32), id);
  if (!r.changes) throw new RpcError('Точка не найдена.', 404);
  return { id };
}

// ---- Сотрудники и Telegram -------------------------------------------------
export function staffLinksList(db, args, user) {
  need(db, user, 'view');
  const rows = db.prepare(`
    SELECT u.id, u.full_name, u.position, d.name AS department,
           l.tg_username, l.linked_at, l.lang
      FROM users u LEFT JOIN departments d ON d.id = u.department_id
      LEFT JOIN staff_telegram_links l ON l.user_id = u.id AND l.revoked_at IS NULL
     WHERE u.is_active = 1 ORDER BY u.full_name COLLATE NOCASE, u.id`).all();
  const bot = publicSettings(db);
  return { staff: rows, bot_username: bot.bot_username, bot_ready: !!(bot.enabled && bot.bot_username), can_edit: grantAllowsAdminOr(db, user, KEY, 'edit') };
}

export function staffLinkCodeCreate(db, args, user) {
  need(db, user, 'edit');
  const userId = posInt(args && args.user_id, 'Сотрудник не выбран.');
  const u = db.prepare('SELECT id, full_name, is_active FROM users WHERE id = ?').get(userId);
  if (!u) throw new RpcError('Сотрудник не найден.', 404);
  if (!u.is_active) throw new RpcError('Сотрудник уволен — подключать его нельзя.', 409);
  const bot = publicSettings(db);
  if (!bot.bot_username) throw new RpcError('Сначала подключите бота сотрудников во вкладке «Бот» и нажмите «Проверить связь».', 409);
  const r = issueLinkCode(db, userId, user.id);
  return { url: `https://t.me/${bot.bot_username}?start=${r.start}`, expires_at: r.expires_at, full_name: u.full_name };
}

export function staffLinkRevoke(db, args, user) {
  need(db, user, 'edit');
  return revokeLink(db, posInt(args && args.user_id, 'Сотрудник не выбран.'), user.id);
}

// ---- Бот -------------------------------------------------------------------
const wrap = (fn) => { try { return fn(); } catch (e) { if (e instanceof SettingsError) throw new RpcError(e.message, e.status); throw e; } };

export function staffBotSettingsGet(db, args, user) { need(db, user, 'view'); return publicSettings(db); }

export function staffBotSettingsSave(db, args, user) {
  need(db, user, 'edit');
  const out = wrap(() => saveSettings(db, args || {}, user.id));
  wakeStaffBot();
  return out;
}

export function staffBotClearToken(db, args, user) {
  need(db, user, 'edit');
  const out = clearToken(db, user.id);
  wakeStaffBot();
  return out;
}

/** Проверка связи: getMe — запоминает имя бота (нужно для ссылки в QR). */
export async function staffBotCheck(db, args, user, deps = {}) {
  need(db, user, 'edit');
  const token = getDecryptedToken(db);
  if (!token) throw new RpcError('Сначала введите токен бота.', 400);
  try {
    const me = await getMe(token, deps);
    const out = recordCheck(db, { ok: true, username: me.username, id: me.id });
    wakeStaffBot();
    return out;
  } catch (e) {
    return recordCheck(db, { ok: false, error: e.message });
  }
}
