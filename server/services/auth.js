import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { recordEvent } from './ops-log.js';   // OPS_EVENTS_V1

export const SESSION_TTL_HOURS = 12;

// Anti-brute-force: after 5 wrong passwords for a username, refuse logins
// for that username for 5 minutes. In-memory on purpose (resets on restart).
const FAILED_LIMIT = 5;
const LOCK_MS = 5 * 60 * 1000;
const failedAttempts = new Map(); // username -> { count, lockedUntil }

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

// bcrypt only hashes the first 72 BYTES — a 72-char Cyrillic password is 126
// bytes, so counting characters would silently ignore the tail. Count bytes.
// Lives here (not routes/users.js, where it started) because the self-service
// change-password path below applies the identical rule — one implementation.
export function validPassword(pw) {
  return typeof pw === 'string' && pw.length >= 8 && Buffer.byteLength(pw, 'utf8') <= 72;
}

export function login(db, username, password) {
  const name = String(username || '').trim().toLowerCase();
  const fail = failedAttempts.get(name);
  if (fail && fail.lockedUntil > Date.now()) return { error: 'locked' };

  const user = db.prepare(
    'SELECT id, username, password_hash, full_name, role, is_active, must_change_password FROM users WHERE username = ?'
  ).get(name);
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
    return { error: noteFailure(name) };
  }
  failedAttempts.delete(name);

  const sid = crypto.randomBytes(32).toString('base64url');
  const expiresAt = isoSeconds(Date.now() + SESSION_TTL_HOURS * 3600 * 1000);
  db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?,?,?)').run(sid, user.id, expiresAt);
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

export function sessionUser(db, sid) {
  if (!sid) return null;
  const row = db.prepare(
    'SELECT u.id, u.username, u.full_name, u.role, u.extra_roles, u.is_active, u.must_change_password, s.expires_at AS session_expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?'
  ).get(sid);
  if (!row) return null;
  if (row.session_expires_at <= isoSeconds(Date.now()) || !row.is_active) {
    logout(db, sid);
    return null;
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
           extra_roles: parseRoleList(u.extra_roles), is_active: !!u.is_active,
           // !! also maps SQLite's 0/1 — and an undefined column (rows selected
           // by callers that don't need the flag) — to a clean boolean.
           must_change_password: !!u.must_change_password };
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
