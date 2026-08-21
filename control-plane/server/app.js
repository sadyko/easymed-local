import express from 'express';
import { enrollRoutes } from './routes/enroll.js';
import { checkinRoutes } from './routes/checkin.js';
import { vendorAuthRoutes, attachVendorUser } from './routes/vendor-auth.js';
import { adminRoutes } from './routes/admin.js';

// LICENCE_CORE_V1 — the control plane's own HTTP surface, minimal on purpose.
//
// Mirrors the clinic app's server/app.js — same idioms (disable x-powered-by,
// nosniff, JSON body limit, JSON 404 for unknown /api paths, a last-resort
// error handler that never echoes the raw error to the client) — deliberately
// not copying what that app needs and this one doesn't: no session cookies, no
// static file serving, no licence gate (the control plane IS the thing that
// issues licences; it has no licence of its own to check).
// CONTROL_PLANE_V1 — mounted under /cp, NOT /api/v1, and that is deliberate.
//
// setting.easymed.uz already proxies /api/v1/* to the EasyMed CORE FastAPI
// gateway — platform-console/js/setting/gateway.js calls exactly that prefix. A
// control plane on the same prefix would collide with it, and worse, would end up
// routed THROUGH the very gateway this service exists to stay clear of: it hung
// twice in August 2026 and took symptex.uz down with it. If it took check-in down
// too, every clinic in the country would start a 14-day countdown at once.
//
// /cp/* must be routed by nginx straight to this process as its own upstream —
// never through the gateway, and preferably not even on the same machine.
export function createApp(db) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => { res.set('X-Content-Type-Options', 'nosniff'); next(); });
  app.use('/cp', express.json({ limit: '100kb' }));
  // VENDOR_LOGIN_V1 — resolves the vendor session cookie into req.vendorUser
  // for every /cp route, in one place. /cp/v1/enroll and /cp/v1/checkin never
  // read req.vendorUser (they authenticate CLINICS by install_token /
  // enrollment_code, never a vendor session) — attaching it here anyway costs
  // nothing and keeps exactly one place that knows how a vendor session
  // resolves, rather than each router re-deriving it.
  app.use('/cp', attachVendorUser(db));

  // CLINIC-FACING — called by clinics over the wire, never by a logged-in
  // vendor. Deliberately NOT behind requireVendor: a clinic has no vendor
  // session to present. See routes/enroll.js and routes/checkin.js.
  app.use('/cp/v1/enroll', enrollRoutes(db));
  app.use('/cp/v1/checkin', checkinRoutes(db));

  // VENDOR-FACING — the panel's own login (/login, /logout, /me are
  // themselves how a vendor becomes authenticated, so this router is not
  // behind requireVendor either) and, behind it, the admin API.
  // requireVendor is applied INSIDE adminRoutes(), not here — see admin.js.
  app.use('/cp/v1/auth', vendorAuthRoutes(db));
  app.use('/cp/v1/admin', adminRoutes(db));

  // Unknown /api paths answer JSON, not an HTML 404 page.
  app.use('/cp', (req, res) => res.status(404).json({ error: { code: 'not_found', message: 'Unknown API endpoint.' } }));

  // Last resort. Client errors (malformed JSON, oversized body) keep their
  // real status; only true server errors log a stack. NEVER log the error
  // object itself if it could carry request data — body-parser puts the raw
  // request body on parse-error objects, and this endpoint's body carries an
  // enrollment code that must never reach a log (see routes/enroll.js).
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error('[control-plane server error]', err.stack || err);
    else console.warn('[control-plane client error]', status, err.type || err.code);
    if (res.headersSent) return next(err);
    res.status(status).json({
      error: status >= 500
        ? { code: 'internal', message: 'Server error.' }
        : { code: 'bad_request', message: 'Malformed request.' },
    });
  });

  return app;
}
