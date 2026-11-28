// STAFF_ATTENDANCE_V1 — правила отметки прихода и ухода. Без Telegram: бот
// (services/staff-bot/flow.js) только передаёт сюда from.id и параметр /start
// и показывает ответ. Так правила проверяются тестами без сети, и второй
// способ отметки (если когда-нибудь появится) пройдёт через те же ворота.
//
// ДВА ШАГА:
//   1. registerScan — человек открыл бота по QR. Проверяем код, точку,
//      личность, филиал и частоту; запоминаем скан (attendance_scans) и
//      спрашиваем «Отметить приход в …?».
//   2. confirmScan — человек нажал «Подтвердить». Направление (приход или
//      уход) пересчитывается здесь, в транзакции, по состоянию базы — а не
//      берётся из того, что показали на шаге 1.
//
// ЧЕМУ НЕ ВЕРИМ: ни времени, ни номеру сотрудника, ни филиалу из сообщения.
// Сотрудник — по привязке Telegram (from.id даёт Telegram, не телефон), время
// — часы сервера (nowMs параметром — только ради тестов), филиал — у точки.
import { parseStart, verify } from './tokens.js';

export const CONFIRM_SECONDS = 120;        // сколько живёт «Подтвердить» после скана
export const MIN_GAP_SECONDS = 60;         // приход и уход ближе минуты — двойной скан
export const MAX_SHIFT_HOURS = 20;         // открытая смена старше — уход забыли отметить
export const RATE_WINDOW_MIN = 10;         // окно ограничения частоты сканов
export const RATE_MAX_SCANS = 12;          // столько сканов за окно — дальше отказ

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

export function flag(db, kind, { tgUserId = '', userId = null, locationId = null, detail = '' } = {}) {
  db.prepare('INSERT INTO attendance_flags (kind, tg_user_id, user_id, location_id, detail) VALUES (?, ?, ?, ?, ?)')
    .run(kind, String(tgUserId || ''), userId, locationId, String(detail || '').slice(0, 500));
}

/** Привязанный сотрудник по Telegram from.id: { link, user } или null. */
export function staffByTelegram(db, tgUserId) {
  const link = db.prepare('SELECT * FROM staff_telegram_links WHERE tg_user_id = ? AND revoked_at IS NULL').get(String(tgUserId));
  if (!link) return null;
  const user = db.prepare('SELECT id, full_name, is_active, branch_id, role, department_id FROM users WHERE id = ?').get(link.user_id);
  if (!user) return null;
  return { link, user };
}

/**
 * Может ли сотрудник отмечаться на точке. Точка без филиала — может любой.
 * Сотрудник без назначенных филиалов (клиника с одним зданием) — может везде.
 * Иначе филиал точки должен быть среди его филиалов (users.branch_id и
 * user_branches).
 */
export function branchAllowed(db, user, location) {
  if (location.branch_id == null) return true;
  const own = new Set(db.prepare('SELECT branch_id FROM user_branches WHERE user_id = ?').all(user.id).map((r) => r.branch_id));
  if (user.branch_id != null) own.add(user.branch_id);
  if (!own.size) return true;
  return own.has(location.branch_id);
}

export function openSession(db, userId) {
  return db.prepare(`SELECT * FROM attendance_sessions
                      WHERE user_id = ? AND out_at IS NULL AND missing_out = 0 AND voided_at IS NULL`).get(userId);
}

function lastClosed(db, userId) {
  return db.prepare(`SELECT * FROM attendance_sessions WHERE user_id = ? AND out_at IS NOT NULL AND voided_at IS NULL
                      ORDER BY out_at DESC LIMIT 1`).get(userId);
}

const ageSeconds = (stamp, nowMs) => (nowMs - Date.parse(stamp)) / 1000;

/** Что будет при подтверждении сейчас: 'in' | 'out' (с учётом забытого ухода). */
export function nextKind(db, userId, nowMs = Date.now()) {
  const open = openSession(db, userId);
  if (!open) return 'in';
  return ageSeconds(open.in_at, nowMs) > MAX_SHIFT_HOURS * 3600 ? 'in' : 'out';
}

/**
 * Шаг 1. Человек открыл бота по QR.
 * Возвращает { ok: true, scanId, kind, location, user } или
 * { ok: false, reason } — reason совпадает с видом флага (attendance_flags.kind),
 * кроме 'not_a_code' (параметр /start — не код входа; не флаг).
 */
export function registerScan(db, { tgUserId, chatType = 'private', param, nowMs = Date.now() }) {
  const parsed = parseStart(param);
  if (!parsed) return { ok: false, reason: 'not_a_code' };
  const tg = String(tgUserId || '');
  if (chatType !== 'private') {
    flag(db, 'not_private', { tgUserId: tg, locationId: parsed.locationId });
    return { ok: false, reason: 'not_private' };
  }
  const location = db.prepare('SELECT * FROM attendance_locations WHERE id = ?').get(parsed.locationId);
  if (!location) { flag(db, 'bad_token', { tgUserId: tg, detail: `точка ${parsed.locationId} не существует` }); return { ok: false, reason: 'bad_token' }; }

  const staff = staffByTelegram(db, tg);
  const userId = staff ? staff.user.id : null;

  // Частота — первой: перебор подписи через бота упирается сюда, а не в CPU.
  const recent = db.prepare(`SELECT COUNT(*) AS n FROM attendance_flags WHERE tg_user_id = ? AND at >= ?`)
    .get(tg, iso(nowMs - RATE_WINDOW_MIN * 60000)).n
    + db.prepare(`SELECT COUNT(*) AS n FROM attendance_scans WHERE tg_user_id = ? AND created_at >= ?`)
      .get(tg, iso(nowMs - RATE_WINDOW_MIN * 60000)).n;
  if (recent >= RATE_MAX_SCANS) {
    flag(db, 'rate_limited', { tgUserId: tg, userId, locationId: location.id });
    return { ok: false, reason: 'rate_limited' };
  }

  const bad = verify(location, parsed, nowMs);
  if (bad) { flag(db, bad, { tgUserId: tg, userId, locationId: location.id, detail: `окно ${parsed.window}` }); return { ok: false, reason: bad }; }
  if (!location.active) { flag(db, 'inactive_location', { tgUserId: tg, userId, locationId: location.id }); return { ok: false, reason: 'inactive_location' }; }
  if (!staff) { flag(db, 'unknown_telegram', { tgUserId: tg, locationId: location.id }); return { ok: false, reason: 'unknown_telegram' }; }
  if (!staff.user.is_active) { flag(db, 'inactive_employee', { tgUserId: tg, userId, locationId: location.id }); return { ok: false, reason: 'inactive_employee' }; }
  if (!branchAllowed(db, staff.user, location)) {
    flag(db, 'branch_not_allowed', { tgUserId: tg, userId, locationId: location.id });
    return { ok: false, reason: 'branch_not_allowed' };
  }

  const kind = nextKind(db, userId, nowMs);
  let scanId;
  try {
    scanId = Number(db.prepare(`INSERT INTO attendance_scans (location_id, token_window, tg_user_id, user_id, kind, created_at)
                                VALUES (?, ?, ?, ?, ?, ?)`).run(location.id, parsed.window, tg, userId, kind, iso(nowMs)).lastInsertRowid);
  } catch (e) {
    if (!/UNIQUE/.test(String(e && e.message))) throw e;
    flag(db, 'replay', { tgUserId: tg, userId, locationId: location.id, detail: `окно ${parsed.window}` });
    return { ok: false, reason: 'replay' };
  }
  return { ok: true, scanId, kind, location: { id: location.id, name: location.name }, user: { id: userId, full_name: staff.user.full_name } };
}

/**
 * Шаг 2. «Подтвердить». Пишет приход или уход сервером временем.
 * Возвращает { ok: true, kind, at, sessionId, minutes? } или { ok: false, reason }:
 *   'confirm_expired' — скан старше CONFIRM_SECONDS, уже использован или чужой;
 *   'too_soon'        — вторая отметка в течение минуты (двойной скан).
 */
export function confirmScan(db, { tgUserId, scanId, nowMs = Date.now() }) {
  const tg = String(tgUserId || '');
  const run = db.transaction(() => {
    const scan = db.prepare('SELECT * FROM attendance_scans WHERE id = ?').get(Number(scanId));
    if (!scan || scan.tg_user_id !== tg || scan.consumed_at || ageSeconds(scan.created_at, nowMs) > CONFIRM_SECONDS) {
      flag(db, 'confirm_expired', { tgUserId: tg, userId: scan ? scan.user_id : null, locationId: scan ? scan.location_id : null });
      return { ok: false, reason: 'confirm_expired' };
    }
    // Привязку могли снять за эти две минуты — проверяем снова.
    const staff = staffByTelegram(db, tg);
    if (!staff || staff.user.id !== scan.user_id || !staff.user.is_active) {
      flag(db, staff ? 'inactive_employee' : 'unknown_telegram', { tgUserId: tg, userId: scan.user_id, locationId: scan.location_id });
      return { ok: false, reason: staff ? 'inactive_employee' : 'unknown_telegram' };
    }
    const location = db.prepare('SELECT * FROM attendance_locations WHERE id = ?').get(scan.location_id);
    const now = iso(nowMs);
    const userId = scan.user_id;
    const open = openSession(db, userId);

    if (open && ageSeconds(open.in_at, nowMs) > MAX_SHIFT_HOURS * 3600) {
      // Уход вчера не отметили: смену закрываем БЕЗ ухода (часы не выдумываем),
      // HR увидит её в «Нет ухода» и поправит с причиной.
      db.prepare(`UPDATE attendance_sessions SET missing_out = 1, updated_at = ? WHERE id = ?`).run(now, open.id);
      flag(db, 'missing_out', { tgUserId: tg, userId, locationId: scan.location_id, detail: `смена ${open.id} с ${open.in_at}` });
    }
    const current = openSession(db, userId);
    const markConsumed = (result) => db.prepare('UPDATE attendance_scans SET consumed_at = ?, result = ? WHERE id = ?').run(now, result, scan.id);

    if (current) {
      if (ageSeconds(current.in_at, nowMs) < MIN_GAP_SECONDS) {
        flag(db, 'too_soon', { tgUserId: tg, userId, locationId: scan.location_id, detail: 'уход через минуту после прихода' });
        markConsumed('too_soon');
        return { ok: false, reason: 'too_soon' };
      }
      db.prepare('UPDATE attendance_sessions SET out_at = ?, out_location_id = ?, updated_at = ? WHERE id = ?').run(now, scan.location_id, now, current.id);
      db.prepare(`INSERT INTO attendance_events (user_id, session_id, location_id, kind, at, source, scan_id) VALUES (?, ?, ?, 'out', ?, 'qr', ?)`)
        .run(userId, current.id, scan.location_id, now, scan.id);
      markConsumed('out');
      return { ok: true, kind: 'out', at: now, sessionId: current.id, minutes: Math.round(ageSeconds(current.in_at, nowMs) / 60) };
    }

    const prev = lastClosed(db, userId);
    if (prev && ageSeconds(prev.out_at, nowMs) < MIN_GAP_SECONDS) {
      flag(db, 'too_soon', { tgUserId: tg, userId, locationId: scan.location_id, detail: 'приход через минуту после ухода' });
      markConsumed('too_soon');
      return { ok: false, reason: 'too_soon' };
    }
    const sessionId = Number(db.prepare(`INSERT INTO attendance_sessions (user_id, branch_id, in_location_id, in_at, source, created_at, updated_at)
                                         VALUES (?, ?, ?, ?, 'qr', ?, ?)`)
      .run(userId, location ? location.branch_id : null, scan.location_id, now, now, now).lastInsertRowid);
    db.prepare(`INSERT INTO attendance_events (user_id, session_id, location_id, kind, at, source, scan_id) VALUES (?, ?, ?, 'in', ?, 'qr', ?)`)
      .run(userId, sessionId, scan.location_id, now, scan.id);
    markConsumed('in');
    return { ok: true, kind: 'in', at: now, sessionId };
  });
  return run.immediate();
}

/** Сводка для «Моя посещаемость» в боте: последние смены и часы за месяц. */
export function myAttendance(db, userId, { days = 7 } = {}) {
  const sessions = db.prepare(`
    SELECT s.in_at, s.out_at, s.missing_out, li.name AS in_location, lo.name AS out_location,
           date(s.in_at, 'localtime') AS day, strftime('%H:%M', s.in_at, 'localtime') AS in_time,
           strftime('%H:%M', s.out_at, 'localtime') AS out_time
      FROM attendance_sessions s
      LEFT JOIN attendance_locations li ON li.id = s.in_location_id
      LEFT JOIN attendance_locations lo ON lo.id = s.out_location_id
     WHERE s.user_id = ? AND s.voided_at IS NULL AND date(s.in_at, 'localtime') >= date('now', 'localtime', ?)
     ORDER BY s.in_at DESC`).all(userId, `-${days - 1} days`);
  const month = db.prepare(`
    SELECT COALESCE(SUM((julianday(out_at) - julianday(in_at)) * 24 * 60), 0) AS minutes, COUNT(*) AS shifts
      FROM attendance_sessions
     WHERE user_id = ? AND voided_at IS NULL AND out_at IS NOT NULL
       AND strftime('%Y-%m', in_at, 'localtime') = strftime('%Y-%m', 'now', 'localtime')`).get(userId);
  const open = openSession(db, userId);
  return { sessions, month_minutes: Math.round(month.minutes), month_shifts: month.shifts, open: !!open, open_since: open ? open.in_at : null };
}
