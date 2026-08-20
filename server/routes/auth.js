import { Router } from 'express';
import { login, logout, SESSION_TTL_HOURS } from '../services/auth.js';
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
