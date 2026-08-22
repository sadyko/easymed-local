import { sessionUser } from '../services/auth.js';

export const SESSION_COOKIE = 'emsid';

export function parseCookies(header) {
  // Later duplicates overwrite earlier ones (last wins): browsers send the
  // most-specific-Path cookie FIRST, so a planted Path=/api cookie loses to
  // the legitimate Path=/ one. Pinned by an app-level test.
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

// Runs on every request: resolves the session cookie to req.user (or null).
export function attachUser(db) {
  return (req, res, next) => {
    req.sessionId = parseCookies(req.headers.cookie)[SESSION_COOKIE] || null;
    req.user = sessionUser(db, req.sessionId);
    next();
  };
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: { code: 'unauthorized', message: 'Login required.' } });
  next();
}

// FIRST_RUN_PASSWORD_V1 — a user still on the well-known first-run default may
// not use the API for anything but changing it. Mounted in app.js AFTER the
// /api/auth router (login, me, logout and change-password itself must keep
// working — they are the way out of this state) and BEFORE everything else, so
// a new router added later is gated by default rather than by remembering to.
// Anonymous requests pass through untouched: requireAuth on each router still
// answers those with its own 401.
export function requirePasswordChanged(req, res, next) {
  if (req.user && req.user.must_change_password) {
    return res.status(403).json({ error: {
      code: 'password_change_required',
      message: 'Set a new password before continuing.',
    } });
  }
  next();
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: { code: 'unauthorized', message: 'Login required.' } });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: { code: 'forbidden', message: 'Not allowed for your role.' } });
    }
    next();
  };
}
