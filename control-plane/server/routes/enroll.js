import { Router } from 'express';
import { redeemEnrollmentCode } from '../services/enrollment.js';
import { signLicence } from '../services/signing.js';

// Per-IP throttle. This endpoint is hit once per clinic in its lifetime — a
// small in-memory counter is enough, and simpler than anything backed by a
// table. Mirrors the shape of the clinic app's own login throttle
// (server/routes/auth.js) rather than inventing a second convention, but with
// a tighter limit: a real operator gets the code right on the first or second
// try; anything hammering this endpoint is either a script guessing codes or
// a bug, and either way should be slowed down hard.
const IP_WINDOW_MS = 60 * 1000;
const IP_LIMIT = 5;
const IP_MAX_TRACKED = 200; // bounds the map's memory against a spoofed-IP flood

// SAME body, SAME status, for every kind of invalid code — a wrong one, a
// reused one, an unknown one, or a malformed one. Distinguishing these from
// the outside would let someone probe which codes exist (or ever existed) by
// watching which response they get back. redeemEnrollmentCode() already
// collapses all four cases to a single `null`; this is the one place that
// null becomes an HTTP response, so there is exactly one response to keep
// generic, not four call sites to keep in sync.
const GENERIC_FAILURE_STATUS = 400;
const GENERIC_FAILURE_BODY = {
  error: {
    code: 'invalid_code',
    message: 'That code is not valid. Check it and try again, or contact your vendor.',
  },
};

export function enrollRoutes(db) {
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

  r.post('/', (req, res) => {
    // Never logged, never echoed back except inside the (already-generic)
    // failure body above — see this file's header and app.js's error handler.
    if (ipThrottled(req.ip)) {
      return res.status(429).json({ error: { code: 'too_many_attempts', message: 'Too many attempts. Try again later.' } });
    }

    const { code, fingerprint } = req.body || {};

    // FAILURE-ORDERING — signLicence runs as the `beforeCommit` hook, INSIDE
    // the same transaction that consumes the code (see enrollment.js). If it
    // throws — e.g. EASYMED_SIGNING_KEY isn't configured — the transaction
    // rolls back: the code is never burned and no install_token is issued, so
    // a signing failure just means "try again once the vendor fixes signing",
    // not "this clinic is enrolled but permanently has no licence". The throw
    // propagates out of this handler; Express's own synchronous-handler
    // catching hands it to app.js's error middleware, which answers 500
    // without echoing the code, the error object, or anything request-shaped.
    const result = redeemEnrollmentCode(db, { code, fingerprint }, {
      beforeCommit: ({ clinicId, clinicName, modules }) => signLicence({ clinicId, clinicName, modules }),
    });

    if (!result) {
      return res.status(GENERIC_FAILURE_STATUS).json(GENERIC_FAILURE_BODY);
    }

    res.json({
      clinic_id: result.clinic_id,
      clinic_name: result.clinic_name,
      install_token: result.install_token,
      unlock_secret: result.unlock_secret,
      subscription: result.subscription,
      licence: result.licence,
    });
  });

  return r;
}
