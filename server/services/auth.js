import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { recordEvent } from './ops-log.js';   // OPS_EVENTS_V1

export const SESSION_TTL_HOURS = 12;

// V3120_FIX (M10) — ПРОСТОЙ СЕССИИ. Без обращений дольше этого сессия
// заканчивается, даже если 12 часов от входа ещё не прошли: компьютер у
// стойки, оставленный открытым, не остаётся открытым до вечера. Клиника может
// поменять предел переменной окружения EASYMED_SESSION_IDLE_HOURS (0 —
// выключить; дробные часы допустимы).
function idleHoursFromEnv() {
  const raw = process.env.EASYMED_SESSION_IDLE_HOURS;
  if (raw === undefined || raw === '') return 4;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 4;
}
export const SESSION_IDLE_HOURS = idleHoursFromEnv();
// Отметку обращения пишем не чаще раза в минуту: каждый запрос экрана — это
// запись в базу, а точности до секунды правилу «4 часа» не нужно.
const TOUCH_EVERY_MS = 60 * 1000;

// Anti-brute-force: after 5 wrong passwords, refuse logins for 5 minutes.
// In-memory on purpose (resets on restart).
//
// V3120_FIX (M10) — ключ — ИМЯ + АДРЕС, а не одно имя. Раньше пять неверных
// паролей к «admin» с ЛЮБОГО компьютера сети запирали администратора везде:
// чужой мог держать клинику без администратора сколько угодно. Теперь заперт
// только тот адрес, с которого подбирали; с других компьютеров человек входит.
// Перебор с многих адресов сдерживает предел попыток на адрес (routes/auth.js).
const FAILED_LIMIT = 5;
const LOCK_MS = 5 * 60 * 1000;
const failedAttempts = new Map(); // username|ip -> { count, lockedUntil }

const BCRYPT_COST = 10;

// Cost-equalising hash: bcrypt runs on EVERY attempt, so an unknown or
// deactivated account costs the same ~60ms as a wrong password (no user
// enumeration by timing, and failed logins can't be fired cheaply in bulk).
const DUMMY_HASH = bcrypt.hashSync('no-such-user', BCRYPT_COST);
// Bounded so unauthenticated garbage usernames can't grow memory forever.
const MAX_TRACKED = 500;

// Second-precision UTC ISO ('YYYY-MM-DDTHH:MM:SSZ') — matches the DB's
// strftime defaults so string comparisons across columns stay correct.
function isoSeconds(ms) {
  return new Date(ms).toISOString().slice(0, 19) + 'Z';
}

export function hashPassword(pw) {
  if (typeof pw !== 'string' || pw === '') throw new TypeError('Password must be a non-empty string');
  return bcrypt.hashSync(pw, BCRYPT_COST);
}

// PASSWORD_CLINIC_RULE_V1 (2026-09-16) — ДЛИНУ ПАРОЛЯ РЕШАЕТ КЛИНИКА.
//
// Владелец: «can we accept the 1 digit password … for the users created by
// admin and admin itself?». Раньше здесь стояло «не короче 8 символов», и
// администратор не мог завести медсестре короткий пароль, который она наберёт
// одной рукой у койки.
//
// Что это значит по-честному: короткий пароль подбирается. Установка работает
// в локальной сети клиники, вход к тому же придержан троттлингом неудачных
// попыток (см. noteFailure ниже), но если база окажется доступна снаружи,
// пароль из одной цифры не защитит ничего. Решение владельца, и оно записано
// здесь, а не растворено по экранам.
//
// Что осталось: пароль не может быть ПУСТЫМ (пустой — это вход без пароля), и
// он не длиннее 72 БАЙТ — bcrypt хеширует только первые 72 байта, а 72 буквы
// кириллицей это 126 байт, и хвост молча пропал бы. Считаем байты.
//
// Правило одно на всё приложение: его же применяет самостоятельная смена
// пароля ниже и обе ручки /api/users. Пароль ВЕНДОРСКОЙ панели
// (control-plane) живёт по своему, строгому правилу: та смотрит в интернет.
export function validPassword(pw) {
  return typeof pw === 'string' && pw.length >= 1 && Buffer.byteLength(pw, 'utf8') <= 72;
}

// LOGIN_ROLES_V1 — ОДИН СПИСОК КОЛОНОК СЕССИИ на все её чтения: вход (login),
// восстановление (sessionUser → /api/auth/me) и сотрудник для CRM
// (crm/tasks-follow.js staffById). Списки расходились: вход не брал ни своей
// роли клиники (CUSTOM_ROLES_V1), ни дополнительных ролей, а вход через форму
// страницу НЕ перезагружает — оболочка (admin.js onAuthed) строила права по
// ответу входа, и до первого F5 сотрудник со своей ролью видел экраны её
// основы, а администратор со своей ролью — без её «Нет». publicUser отдаёт
// ровно эти колонки (тест routes/auth.test.js держит список и форму ответа
// вместе). Хэша пароля здесь нет: его читает только вход, отдельно.
export const SESSION_USER_COLUMNS = Object.freeze([
  'id', 'username', 'full_name', 'role', 'extra_roles', 'custom_role_code',
  'department_id',          // MY_STOCK_V1 — пункт «Мой отдел» с первой минуты
  'is_active', 'must_change_password',
  'is_doctor',              // ADMIN_DOCTOR_LOCAL_V1 — врач по флагу, а не по роли
]);
const LOGIN_USER_SQL = `SELECT password_hash, ${SESSION_USER_COLUMNS.join(', ')} FROM users WHERE username = ?`;
const SESSION_USER_SQL = `SELECT ${SESSION_USER_COLUMNS.map((c) => 'u.' + c).join(', ')}, `
  + 's.expires_at AS session_expires_at, s.last_seen_at AS session_seen_at '
  + 'FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?';

export function login(db, username, password, { ip = '' } = {}) {
  const name = String(username || '').trim().toLowerCase();
  const key = name + '|' + String(ip || '');
  const fail = failedAttempts.get(key);
  if (fail && fail.lockedUntil > Date.now()) return { error: 'locked' };

  // MY_STOCK_V1 · ADMIN_DOCTOR_LOCAL_V1 · LOGIN_ROLES_V1 — вход НЕ
  // перезагружает страницу (форма → onAuthed): ответ входа обязан нести всё,
  // что несёт /me, — тот же SESSION_USER_COLUMNS.
  const user = db.prepare(LOGIN_USER_SQL).get(name);
  const match = bcrypt.compareSync(String(password ?? ''), user?.password_hash || DUMMY_HASH);
  if (!user || !user.is_active || !match) {
    // OPS_EVENTS_V1 — one kind, no distinction between "no such user" and
    // "wrong password": recording which would let anyone who later reads the
    // stats learn which usernames exist. No username, no IP in the event —
    // the in-memory throttle above already enforces; this call is only a
    // count, and it sits on the branch both failure paths already share, so
    // it cannot itself introduce a timing difference between them (see
    // auth.test.js's cost-equalisation timing test).
    recordEvent(db, 'failed_login');
    return { error: noteFailure(key) };
  }
  failedAttempts.delete(key);

  const sid = crypto.randomBytes(32).toString('base64url');
  const expiresAt = isoSeconds(Date.now() + SESSION_TTL_HOURS * 3600 * 1000);
  db.prepare('INSERT INTO sessions (id, user_id, expires_at, last_seen_at) VALUES (?,?,?,?)')
    .run(sid, user.id, expiresAt, isoSeconds(Date.now()));
  return { session: sid, user: publicUser(user) };
}

// Records one failure, returns the error code for the caller, keeps the map
// bounded (evicts oldest non-locked entries; live locks are never evicted).
function noteFailure(name) {
  const f = failedAttempts.get(name) || { count: 0, lockedUntil: 0 };
  f.count += 1;
  const locked = f.count >= FAILED_LIMIT;
  if (locked) { f.lockedUntil = Date.now() + LOCK_MS; f.count = 0; }
  failedAttempts.delete(name); // re-insert so Map iteration order stays oldest-first
  failedAttempts.set(name, f);
  if (failedAttempts.size > MAX_TRACKED) {
    const now = Date.now();
    for (const [k, v] of failedAttempts) {
      if (failedAttempts.size <= MAX_TRACKED) break;
      if (v.lockedUntil <= now) failedAttempts.delete(k);
    }
  }
  return locked ? 'locked' : 'invalid';
}

export function logout(db, sid) {
  if (sid) db.prepare('DELETE FROM sessions WHERE id = ?').run(sid);
}

// V3120_FINAL (I5) — { background: true }: запрос, который экран шлёт сам
// (опрос счётчиков меню, табло очереди, непрочитанные Telegram, телефония,
// автообновление), — клиент ставит заголовок x-em-background: 1
// (public/js/shared/user-activity.js). Такой запрос сессию ПРОВЕРЯЕТ, но не
// ПРОДЛЕВАЕТ: иначе опрос каждые 20 секунд держал её вечно, и правило
// «SESSION_IDLE_HOURS без работы — выход» не срабатывало никогда.
export function sessionUser(db, sid, { background = false } = {}) {
  if (!sid) return null;
  const row = db.prepare(
    // CUSTOM_ROLES_V1 — код своей роли едет вместе с ролью: по нему экран
    // грузит права и подписывает роль человеку её собственным названием.
    // MY_STOCK_V1 — department_id: оболочка решает по нему, показывать ли
    // пункт «Мой отдел» (и ссылку на карточку отдела с «Моих запасов»).
    // Принадлежность к отделу — ФАКТ о человеке, а не право, и спросить её
    // экрану больше негде: users читается только через /api/db, а роль без
    // прав на справочник сотрудников туда не ходит.
    // ADMIN_DOCTOR_LOCAL_V1 — is_doctor: см. publicUser.
    // LOGIN_ROLES_V1 — колонки — общий SESSION_USER_COLUMNS (тот же у входа).
    SESSION_USER_SQL
  ).get(sid);
  if (!row) return null;
  const now = Date.now();
  // V3120_FINAL (I5) — пустая отметка (сессия открыта до обновления, когда
  // колонки ещё не было) — это «сейчас», а не «с момента входа»: иначе каждый,
  // кто вошёл больше SESSION_IDLE_HOURS назад, вылетал на первом же запросе
  // после обновления. Отметка ставится и фоновым запросом — дальше обычное правило.
  if (!row.session_seen_at) {
    try { db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ? AND last_seen_at IS NULL').run(isoSeconds(now), sid); } catch { /* не повод отказать */ }
    row.session_seen_at = isoSeconds(now);
  }
  // V3120_FIX (M10) — и 12 часов от входа, и простой дольше SESSION_IDLE_HOURS.
  const idle = SESSION_IDLE_HOURS > 0 && row.session_seen_at
    && row.session_seen_at <= isoSeconds(now - SESSION_IDLE_HOURS * 3600 * 1000);
  if (row.session_expires_at <= isoSeconds(now) || !row.is_active || idle) {
    logout(db, sid);
    return null;
  }
  if (!background && row.session_seen_at <= isoSeconds(now - TOUCH_EVERY_MS)) {
    try { db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(isoSeconds(now), sid); } catch { /* отметка — не повод отказать */ }
  }
  return publicUser(row);
}

// MULTI_ROLE_SERVER_V1 — extra_roles rides along because the ACL layer
// authorises against the union of primary + extras (services/roles.js
// effectiveRoles). Stored as a JSON array in TEXT, '' before an admin ever set
// one; anything unparseable degrades to «no extras», i.e. fail-closed.
function parseRoleList(v) {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string' || !v.trim()) return [];
  try { const p = JSON.parse(v); return Array.isArray(p) ? p.filter((r) => typeof r === 'string' && r) : []; }
  catch { return []; }
}

export function publicUser(u) {
  return { id: u.id, username: u.username, full_name: u.full_name, role: u.role,
           extra_roles: parseRoleList(u.extra_roles),
           custom_role_code: (typeof u.custom_role_code === 'string' && u.custom_role_code.trim()) || null,   // CUSTOM_ROLES_V1
           // MY_STOCK_V1 — отдел сотрудника. Вызовы, которые его не выбирали,
           // получают null, а не undefined: поле должно ЛИБО называть отдел,
           // ЛИБО говорить «отдела нет», и никогда — «не знаю».
           department_id: u.department_id == null ? null : Number(u.department_id),
           is_active: !!u.is_active,
           // !! also maps SQLite's 0/1 — and an undefined column (rows selected
           // by callers that don't need the flag) — to a clean boolean.
           must_change_password: !!u.must_change_password,
           // ADMIN_DOCTOR_LOCAL_V1 — ВРАЧ ЛИ ЭТО: единственный признак — флаг
           // is_doctor, а не роль (администратор-врач — role 'admin'). Без него
           // оболочка (public/js/admin/auth.js actorFromUser) знала врача только
           // по role = 'doctor': у администратора-врача пустел «мой день»
           // кабинета, «Мой профиль» не открывался, «Взять» у процедуры
           // пряталось. Настоящим true/false, как флаги выше. Специальность и
           // лицензию сессия НЕ отдаёт: по ним оболочка угадывала бы врача и в
           // медсестре со специальностью. Колонку выбирает каждое чтение сессии
           // — через общий SESSION_USER_COLUMNS (LOGIN_ROLES_V1).
           is_doctor: !!u.is_doctor };
}

// FIRST_RUN_PASSWORD_V1 — the well-known default the first-run admin starts
// with. This REVERSES the original "never a fixed default password" rule, by
// owner decision (2026-08-22): installers were fishing a generated string out
// of a service log, and a clinic whose window closed too fast was locked out
// of its own fresh install. What makes the fixed default acceptable is the
// must_change_password flag set beside it: until the admin sets their own
// password, the API refuses everything except login/logout/me/change-password
// (enforced in app.js — requirePasswordChanged — not just by the login
// screen), so the default cannot be used to actually operate the clinic.
export const FIRST_RUN_PASSWORD = '123456789';

// First run only: create the admin account with the well-known default above
// and return it so index.js can print it to the console. must_change_password
// is what keeps this from being an open door — see FIRST_RUN_PASSWORD.
export function bootstrapAdmin(db) {
  if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) return null;
  db.prepare('INSERT INTO users (username, password_hash, full_name, role, must_change_password) VALUES (?,?,?,?,1)')
    .run('admin', hashPassword(FIRST_RUN_PASSWORD), 'Administrator', 'admin');
  return FIRST_RUN_PASSWORD;
}

/**
 * Self-service password change — the only way must_change_password clears.
 *
 * Verifies the CURRENT password even though the caller already holds a valid
 * session: a walked-away-from clinic PC must not let a passer-by silently
 * take over the account by setting a new password on an open session.
 *
 * Ends every OTHER session of the same user on success (mirrors
 * routes/users.js's reset behaviour); the caller's own session survives so
 * changing your password doesn't log you out.
 *
 * @returns {{ok: true} | {error: 'invalid_current'|'weak_password'}}
 */
export function changeOwnPassword(db, userId, currentPassword, newPassword, keepSessionId = null) {
  if (!validPassword(newPassword)) return { error: 'weak_password' };
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ? AND is_active = 1').get(userId);
  if (!row || !bcrypt.compareSync(String(currentPassword ?? ''), row.password_hash)) {
    return { error: 'invalid_current' };
  }
  db.prepare(`UPDATE users SET password_hash = ?, must_change_password = 0,
              updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`)
    .run(hashPassword(newPassword), userId);
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND id IS NOT ?').run(userId, keepSessionId);
  return { ok: true };
}
