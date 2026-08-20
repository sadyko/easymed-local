import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

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

export function login(db, username, password) {
  const name = String(username || '').trim().toLowerCase();
  const fail = failedAttempts.get(name);
  if (fail && fail.lockedUntil > Date.now()) return { error: 'locked' };

  const user = db.prepare(
    'SELECT id, username, password_hash, full_name, role, is_active FROM users WHERE username = ?'
  ).get(name);
  const match = bcrypt.compareSync(String(password ?? ''), user?.password_hash || DUMMY_HASH);
  if (!user || !user.is_active || !match) return { error: noteFailure(name) };
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
    'SELECT u.id, u.username, u.full_name, u.role, u.extra_roles, u.is_active, s.expires_at AS session_expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?'
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
           extra_roles: parseRoleList(u.extra_roles), is_active: !!u.is_active };
}

// First run only: create the admin account with a random password and return
// it so index.js can print it to the console. Never a fixed default password.
export function bootstrapAdmin(db) {
  if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) return null;
  const password = crypto.randomBytes(9).toString('base64url'); // 12 chars
  db.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)')
    .run('admin', hashPassword(password), 'Administrator', 'admin');
  return password;
}
