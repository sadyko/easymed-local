// ADMIN_ACT_AS_V1 (2026-10-28) — ВХОД ОТ ИМЕНИ СОТРУДНИКА: начало, возврат,
// журнал действий и его чтение для карточки сотрудника.
//
// Спецификация — docs/specs/2026-10-28-admin-act-as-design.md. Сессия остаётся
// сессией администратора (sessions.user_id); вход от имени — три колонки той же
// сессии (мигр. 249) и запись журнала act_as_sessions. Пароль сотрудника не
// нужен и не меняется (R6), его собственные сессии не трогаются (R5).
// Чтение сессии и авто-конец (R4) — services/auth.js sessionUser; правила
// R1/R2/R4 — services/act-as-rules.js; маршруты — routes/auth.js.
import { SESSION_USER_COLUMNS, closeActAs, sessionUser } from './auth.js';
import { actAsStartRefusal, actAsTargetRefusal } from './act-as-rules.js';
import { isReadOnlyRpc } from './control/gate.js';
import { ACT_AS_END, ACT_AS_MESSAGES } from '../../public/js/shared/act-as.js';

const nowIso = () => new Date().toISOString().slice(0, 19) + 'Z';
/** Номер (сотрудника, записи журнала) из запроса: целое > 0 или null. */
export function positiveId(v) {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * POST /api/auth/act-as { user_id } — R1 (кто) и R2 (как кого), запись
 * журнала, сотрудник на сессии. → { user, acting_admin } или { error:
 * { status, code, message } }. user — то, что дальше будет отдавать /me.
 */
export function startActAs(db, sid, user, rawTargetId) {
  const r1 = actAsStartRefusal(user);
  if (r1) return { error: r1 };
  const targetId = positiveId(rawTargetId);
  if (targetId == null) return { error: { status: 400, code: 'bad_request', message: ACT_AS_MESSAGES.noTarget } };
  const target = db.prepare(`SELECT ${SESSION_USER_COLUMNS.join(', ')} FROM users WHERE id = ?`).get(targetId);
  const r2 = actAsTargetRefusal(db, user.id, target);
  if (r2) return { error: r2 };
  const at = nowIso();
  db.transaction(() => {
    const id = Number(db.prepare(`INSERT INTO act_as_sessions (admin_id, admin_name, target_id, target_name, started_at)
                                  VALUES (?, ?, ?, ?, ?)`)
      .run(user.id, user.full_name || user.username || '', target.id, target.full_name || target.username || '', at).lastInsertRowid);
    // Номер прежней, уже закрытой записи (авто-конец, о котором экран не узнал) заменяется новой.
    db.prepare('UPDATE sessions SET act_as_user_id = ?, act_as_id = ?, act_as_started_at = ? WHERE id = ?')
      .run(target.id, id, at, sid);
  })();
  const acting = sessionUser(db, sid);   // тем же путём, что и каждый следующий запрос
  return { user: acting, acting_admin: acting ? acting.acting_admin : null };
}

/**
 * DELETE /api/auth/act-as — «Вернуться к своей учётной записи». Открытая
 * запись журнала закрывается «Вернулся» (закрытую сам авто-конец — не
 * переписывается), сессия снова только администратора. Без входа от имени —
 * ничего не делает (двойной щелчок, вторая вкладка). → администратор или null.
 */
export function stopActAs(db, sid) {
  const s = db.prepare('SELECT act_as_id FROM sessions WHERE id = ?').get(sid);
  if (s && s.act_as_id != null) {
    db.transaction(() => {
      closeActAs(db, s.act_as_id, ACT_AS_END.returned);
      db.prepare('UPDATE sessions SET act_as_user_id = NULL, act_as_id = NULL, act_as_started_at = NULL WHERE id = ?').run(sid);
    })();
  }
  return sessionUser(db, sid);
}

/** Одно действие от имени: kind — db | rpc | users, name — таблица.операция / имя RPC / «МЕТОД /users/…». */
export function recordActAsAction(db, actAsId, kind, name, status) {
  db.prepare('INSERT INTO act_as_actions (act_as_id, kind, name, status) VALUES (?, ?, ?, ?)')
    .run(actAsId, kind, name, Number.isInteger(status) ? status : null);
}

const readOnly = (a) => a.kind === 'rpc' && isReadOnlyRpc(a.name);
const SESSION_COLS = 'id, admin_id, admin_name, target_id, target_name, started_at, ended_at, end_reason';
export const ACT_AS_LOG_SESSIONS = 100;
export const ACT_AS_LOG_ACTIONS = 5000;

/**
 * GET /api/auth/act-as/log?user_id=[&act_as_id=] — «Входы от имени» в карточке
 * сотрудника: сеансы, где он — сотрудник или администратор (последние 100, новые
 * первыми), с числом действий (action_count) и записей (write_count — без RPC
 * только для чтения). С act_as_id — один сеанс этого сотрудника и его действия
 * по порядку (до 5000; truncated — были ещё). Имена — как были на момент входа.
 */
export function actAsLog(db, userId, actAsId = null) {
  const withCounts = (rows) => {
    if (!rows.length) return rows;
    const counts = db.prepare(`SELECT act_as_id, kind, name, COUNT(*) AS n FROM act_as_actions
                               WHERE act_as_id IN (${rows.map(() => '?').join(', ')}) GROUP BY act_as_id, kind, name`)
      .all(...rows.map((r) => r.id));
    return rows.map((r) => {
      const mine = counts.filter((c) => c.act_as_id === r.id);
      return { ...r,
        action_count: mine.reduce((s, c) => s + c.n, 0),
        write_count: mine.filter((c) => !readOnly(c)).reduce((s, c) => s + c.n, 0) };
    });
  };
  if (actAsId == null) {
    const rows = db.prepare(`SELECT ${SESSION_COLS} FROM act_as_sessions WHERE target_id = ? OR admin_id = ?
                             ORDER BY started_at DESC, id DESC LIMIT ?`).all(userId, userId, ACT_AS_LOG_SESSIONS);
    return { sessions: withCounts(rows) };
  }
  const row = db.prepare(`SELECT ${SESSION_COLS} FROM act_as_sessions WHERE id = ? AND (target_id = ? OR admin_id = ?)`)
    .get(actAsId, userId, userId);
  if (!row) return null;
  const list = db.prepare('SELECT at, kind, name, status FROM act_as_actions WHERE act_as_id = ? ORDER BY id LIMIT ?')
    .all(actAsId, ACT_AS_LOG_ACTIONS + 1);
  const truncated = list.length > ACT_AS_LOG_ACTIONS;
  return {
    session: withCounts([row])[0],
    actions: list.slice(0, ACT_AS_LOG_ACTIONS).map((a) => ({ ...a, read_only: readOnly(a) })),
    truncated,
  };
}
