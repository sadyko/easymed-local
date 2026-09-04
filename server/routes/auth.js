import { Router } from 'express';
import { login, logout, changeOwnPassword, SESSION_TTL_HOURS } from '../services/auth.js';
import { SESSION_COOKIE } from '../middleware/auth.js';

// Per-IP login throttle: bcrypt costs ~60ms of the single JS thread per
// attempt, so without this one rogue LAN device could freeze the app for
// everyone. The map lives per app instance (fresh per createApp) so tests
// don't interfere with each other.
const IP_WINDOW_MS = 60 * 1000;
const IP_LIMIT = 10;
const IP_MAX_TRACKED = 200;

export function authRoutes(db) {
  const r = Router();
  const ipAttempts = new Map(); // ip -> { count, windowStart }

  function ipThrottled(ip) {
    const now = Date.now();
    const e = ipAttempts.get(ip) || { count: 0, windowStart: now };
    if (now - e.windowStart > IP_WINDOW_MS) { e.count = 0; e.windowStart = now; }
    e.count += 1;
    ipAttempts.delete(ip); // re-insert keeps Map order oldest-first for eviction
    ipAttempts.set(ip, e);
    if (ipAttempts.size > IP_MAX_TRACKED) {
      for (const [k, v] of ipAttempts) {
        if (ipAttempts.size <= IP_MAX_TRACKED) break;
        if (now - v.windowStart > IP_WINDOW_MS) ipAttempts.delete(k);
      }
    }
    return e.count > IP_LIMIT;
  }

  r.post('/login', (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (ipThrottled(req.ip)) {
      return res.status(429).json({ error: { code: 'locked', message: 'Too many attempts. Try again in a few minutes.' } });
    }
    const { username, password } = req.body || {};
    const result = login(db, username, password);
    if (result.error === 'locked') {
      return res.status(429).json({ error: { code: 'locked', message: 'Too many attempts. Try again in a few minutes.' } });
    }
    if (result.error) {
      return res.status(401).json({ error: { code: 'invalid_credentials', message: 'Wrong username or password.' } });
    }
    // Login replaces whatever session this browser presented — so on a shared
    // clinic PC, an abandoned session dies when the next person signs in.
    if (req.sessionId) logout(db, req.sessionId);
    res.setHeader('Set-Cookie',
      `${SESSION_COOKIE}=${encodeURIComponent(result.session)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_HOURS * 3600}`);
    res.json({ user: result.user });
  });

  // FIRST_RUN_PASSWORD_V1 — self-service, session required. Deliberately under
  // /api/auth so requirePasswordChanged (app.js) can gate everything else while
  // leaving this reachable: it is the way OUT of the must-change state.
  // Re-checks the current password despite the live session — see
  // changeOwnPassword for why. Counts toward the same per-IP throttle as login,
  // so the current-password check cannot be brute-forced any faster than login.
  r.post('/change-password', (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!req.user) return res.status(401).json({ error: { code: 'unauthorized', message: 'Login required.' } });
    if (ipThrottled(req.ip)) {
      return res.status(429).json({ error: { code: 'locked', message: 'Too many attempts. Try again in a few minutes.' } });
    }
    // STAFF_SYNC_V1 (migration 086) — an account that arrived from the main
    // clinic cannot change its password HERE, and this refusal is what keeps the
    // owner's rule honest rather than merely stated. The password rides the
    // catalogue channel, so a change accepted at a branch would live until the
    // next hourly synchronisation and then revert with no message and no trace:
    // the person would be locked out by a password they set themselves and
    // watched being accepted. Saying so now costs one trip to the main clinic;
    // the alternative costs a support call nobody can explain.
    const me = db.prepare('SELECT is_local FROM users WHERE id = ?').get(req.user.id);
    if (me && me.is_local === 0) {
      return res.status(409).json({ error: { code: 'conflict',
        message: 'This account is managed by the main clinic. Change the password there — it is the same login in every building.' } });
    }
    const { current_password, new_password } = req.body || {};
    const result = changeOwnPassword(db, req.user.id, current_password, new_password, req.sessionId);
    if (result.error === 'weak_password') {
      return res.status(400).json({ error: { code: 'weak_password', message: 'Password must be 8 characters or more (max 72 bytes).' } });
    }
    if (result.error) {
      return res.status(401).json({ error: { code: 'invalid_credentials', message: 'Current password is wrong.' } });
    }
    res.json({ ok: true });
  });

  r.post('/logout', (req, res) => {
    logout(db, req.sessionId);
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    res.json({ ok: true });
  });

  r.get('/me', (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!req.user) return res.status(401).json({ error: { code: 'unauthorized', message: 'Login required.' } });
    res.json({ user: req.user });
  });

  return r;
}
