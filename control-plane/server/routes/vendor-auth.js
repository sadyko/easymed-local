import { Router } from 'express';
import { login, logout, sessionUser, SESSION_TTL_HOURS } from '../services/vendor-auth.js';

// CONTROL_PLANE_V1 — the vendor's own login for settings.easymed.uz/cp/. See
// services/vendor-auth.js's header for why this exists instead of reusing the
// Supabase-backed Platform Console: nothing here can be stopped by a Supabase
// outage, and this survives the cloud product being retired.
//
// Cookie name deliberately distinct from the clinic app's own `emsid` — this
// is a different application, on a different domain path, and the two must
// never be confused (a vendor's browser could in principle have both cookies
// if it ever visited both a clinic's local instance and this panel).
export const VENDOR_SESSION_COOKIE = 'cpvsid';

// Same idea as the clinic app's parseCookies (middleware/auth.js): later
// duplicates overwrite earlier ones, matching how browsers send the
// most-specific-Path cookie FIRST.
function parseCookies(header) {
  const out = Object.create(null);
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      const raw = part.slice(i + 1).trim();
      try { out[part.slice(0, i).trim()] = decodeURIComponent(raw); }
      catch { out[part.slice(0, i).trim()] = raw; } // keep undecodable value as-is
    }
  }
  return out;
}

// Runs on every /cp request: resolves the vendor session cookie into
// req.vendorUser (or null). Harmless for /cp/v1/enroll and /cp/v1/checkin —
// those routes never read req.vendorUser, they authenticate CLINICS by
// install_token/enrollment_code, never by a vendor session.
export function attachVendorUser(db) {
  return (req, res, next) => {
    req.vendorSessionId = parseCookies(req.headers.cookie)[VENDOR_SESSION_COOKIE] || null;
    req.vendorUser = sessionUser(db, req.vendorSessionId);
    next();
  };
}

export function requireVendor(req, res, next) {
  if (!req.vendorUser) return res.status(401).json({ error: { code: 'unauthorized', message: 'Login required.' } });
  next();
}

// Per-IP login throttle — same shape and same reasoning as the clinic app's
// routes/auth.js: bcrypt costs real JS-thread time per attempt, so without
// this one flood of requests could freeze the single vendor process for
// everyone using the panel.
const IP_WINDOW_MS = 60 * 1000;
const IP_LIMIT = 10;
const IP_MAX_TRACKED = 200;

export function vendorAuthRoutes(db) {
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
    // Login replaces whatever session this browser presented — same reasoning
    // as the clinic app's own login route (shared vendor-office PCs exist
    // too). This is a courtesy cleanup, NOT the session-fixation defence:
    // that defence is login() always minting a brand-new random session id,
    // regardless of what this request's cookie contained.
    if (req.vendorSessionId) logout(db, req.vendorSessionId);
    res.setHeader('Set-Cookie',
      `${VENDOR_SESSION_COOKIE}=${encodeURIComponent(result.session)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_HOURS * 3600}`);
    res.json({ user: result.user });
  });

  r.post('/logout', (req, res) => {
    logout(db, req.vendorSessionId);
    res.setHeader('Set-Cookie', `${VENDOR_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    res.json({ ok: true });
  });

  r.get('/me', (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!req.vendorUser) return res.status(401).json({ error: { code: 'unauthorized', message: 'Login required.' } });
    res.json({ user: req.vendorUser });
  });

  return r;
}
