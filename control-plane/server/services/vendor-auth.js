import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

// CONTROL_PLANE_V1 — the vendor's own login for settings.easymed.uz/cp/.
//
// This is deliberately a close copy of the clinic app's server/services/auth.js
// — cost-equalised bcrypt, per-username lockout, sessions as rows keyed by an
// HttpOnly cookie — not a novel design. See migrations/002_vendor_users.sql for
// the two structural differences (no `role`, no bootstrapping from a clinic
// database) that this file mirrors in its own shape.

export const SESSION_TTL_HOURS = 12; // same as the clinic app; no reason yet to diverge

// Anti-brute-force: after 5 wrong passwords for a username, refuse logins for
// that username for 5 minutes. In-memory on purpose (resets on restart) —
// same reasoning and same numbers as the clinic app's own limiter.
const FAILED_LIMIT = 5;
const LOCK_MS = 5 * 60 * 1000;
const failedAttempts = new Map(); // username -> { count, lockedUntil }

const BCRYPT_COST = 10;

// Cost-equalising hash: bcrypt runs on EVERY attempt, so an unknown or
// deactivated vendor account costs the same ~60ms as a wrong password (no
// user enumeration by timing, and failed logins can't be fired cheaply in
// bulk). See vendor-auth.test.js's own timing test.
const DUMMY_HASH = bcrypt.hashSync('no-such-vendor-user', BCRYPT_COST);
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
// (Same rule the clinic app applies in routes/users.js's validPassword.)
function validPassword(pw) {
  return typeof pw === 'string' && pw.length >= 8 && Buffer.byteLength(pw, 'utf8') <= 72;
}

export function login(db, username, password) {
  const name = String(username || '').trim().toLowerCase();
  const fail = failedAttempts.get(name);
  if (fail && fail.lockedUntil > Date.now()) return { error: 'locked' };

  const user = db.prepare(
    'SELECT id, username, password_hash, full_name, active FROM vendor_users WHERE username = ?'
  ).get(name);
  const match = bcrypt.compareSync(String(password ?? ''), user?.password_hash || DUMMY_HASH);
  if (!user || !user.active || !match) return { error: noteFailure(name) };
  failedAttempts.delete(name);

  // A fresh, random session id on EVERY successful login — never derived
  // from, or influenced by, whatever cookie the browser happened to present
  // beforehand. That is what makes session fixation a non-issue here: an
  // attacker planting a session id in a victim's browser before login gains
  // nothing, because login() never adopts a caller-supplied id.
  const sid = crypto.randomBytes(32).toString('base64url');
  const expiresAt = isoSeconds(Date.now() + SESSION_TTL_HOURS * 3600 * 1000);
  db.prepare('INSERT INTO vendor_sessions (id, user_id, expires_at) VALUES (?,?,?)').run(sid, user.id, expiresAt);
  return { session: sid, user: publicVendorUser(user) };
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
  if (sid) db.prepare('DELETE FROM vendor_sessions WHERE id = ?').run(sid);
}

export function sessionUser(db, sid) {
  if (!sid) return null;
  const row = db.prepare(
    'SELECT u.id, u.username, u.full_name, u.active, s.expires_at AS session_expires_at ' +
    'FROM vendor_sessions s JOIN vendor_users u ON u.id = s.user_id WHERE s.id = ?'
  ).get(sid);
  if (!row) return null;
  if (row.session_expires_at <= isoSeconds(Date.now()) || !row.active) {
    logout(db, sid);
    return null;
  }
  return publicVendorUser(row);
}

export function publicVendorUser(u) {
  return { id: u.id, username: u.username, full_name: u.full_name, active: !!u.active };
}

// First run only: create the vendor admin account with a random password and
// return it so the entry point can print it to the console once. Never a
// fixed default password — mirrors the clinic app's bootstrapAdmin exactly,
// minus the clinic-database bootstrapping that has no equivalent here (this
// registry has no staff roster to seed from).
export function bootstrapVendorAdmin(db) {
  if (db.prepare('SELECT COUNT(*) AS n FROM vendor_users').get().n > 0) return null;
  const password = crypto.randomBytes(9).toString('base64url'); // 12 chars
  db.prepare('INSERT INTO vendor_users (username, password_hash, full_name) VALUES (?,?,?)')
    .run('admin', hashPassword(password), 'Vendor Admin');
  return password;
}

/**
 * Self-service password change. Not wired to a route in this task (no
 * settings-page task exists yet to call it from) — exported and tested here
 * so the behaviour exists and is pinned before that route is built.
 *
 * @returns {{ok:true} | {error:'not_found'|'wrong_password'|'weak_password'}}
 */
export function changePassword(db, userId, currentPassword, newPassword, exceptSessionId = null) {
  const user = db.prepare('SELECT id, password_hash FROM vendor_users WHERE id = ?').get(userId);
  if (!user) return { error: 'not_found' };
  // No cost-equalisation needed here: the caller already authenticated as
  // this exact userId (a session, not a guessed username), so there is no
  // enumeration surface to protect against — unlike login().
  if (!bcrypt.compareSync(String(currentPassword ?? ''), user.password_hash)) {
    return { error: 'wrong_password' };
  }
  if (!validPassword(newPassword)) return { error: 'weak_password' };

  db.prepare('UPDATE vendor_users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), userId);
  // A password change is the standard response to a suspected compromise, so
  // every OTHER session for this account must die immediately — the one that
  // just proved the current password (exceptSessionId) survives, mirroring
  // the clinic app's own PATCH /api/users/:id behaviour.
  db.prepare('DELETE FROM vendor_sessions WHERE user_id = ? AND id <> ?').run(userId, exceptSessionId ?? '');
  return { ok: true };
}
