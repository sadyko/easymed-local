import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { enrollRoutes } from './routes/enroll.js';
import { checkinRoutes } from './routes/checkin.js';
import { vendorAuthRoutes, attachVendorUser } from './routes/vendor-auth.js';
import { adminRoutes } from './routes/admin.js';
import { deployRoutes, DEPLOY_MOUNT } from './routes/deploy.js';
import { relayRoutes, RELAY_MOUNT } from './routes/relay.js';   // BRANCH_SYNC_RELAY_V1
import { relayTokenRouter, RELAY_TOKEN_MOUNT } from './routes/relay-token.js';   // BRANCH_IDENTITY_V1

// control-plane/server/app.js -> control-plane/ -> control-plane/public
const CONTROL_PLANE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PUBLIC_DIR = path.join(CONTROL_PLANE_ROOT, 'public');

// LICENCE_CORE_V1 — the control plane's own HTTP surface, minimal on purpose.
//
// Mirrors the clinic app's server/app.js — same idioms (disable x-powered-by,
// nosniff, JSON body limit, JSON 404 for unknown /api paths, a last-resort
// error handler that never echoes the raw error to the client, and — since
// THE_PANEL_V1 below — the same NO_STALE_CODE_V1 static-file caching rule).
// Deliberately not copying what that app needs and this one doesn't: no
// per-clinic session cookies for patient-facing staff, no licence gate (the
// control plane IS the thing that issues licences; it has no licence of its
// own to check).
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

  // AUTO_ROLLOUT_V1 — CI's publish endpoint, mounted ABOVE the 100kb JSON
  // parser below and that ordering is load-bearing, twice over:
  //   - a release bundle is ~15 MB (~20 MB base64), so the 100kb parser would
  //     reject it outright; this router carries its own, much larger limit,
  //     and it is the ONLY path in the control plane that does.
  //   - the router checks the bearer token BEFORE parsing anything, so an
  //     unauthenticated caller can never make this process buffer megabytes.
  //     Mounting it below the global parser would parse first and authenticate
  //     afterwards, which is the wrong way round.
  // Also above attachVendorUser: CI has no vendor session and must never be
  // able to gain anything from presenting one. See routes/deploy.js.
  app.use(DEPLOY_MOUNT, deployRoutes(db));

  // BRANCH_SYNC_RELAY_V1 — the branch-sync relay, mounted above the 100kb JSON
  // parser for exactly the two reasons deploy is: an encrypted catalogue is
  // megabytes, and the router authenticates (install_token, the check-in
  // credential) BEFORE it buffers a single byte. It must also stay above
  // attachVendorUser: a vendor session grants nothing here and must not be able
  // to. See routes/relay.js — the whole point of that file is that this service
  // stores bytes it cannot read.
  app.use(RELAY_MOUNT, relayRoutes(db));

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
  // BRANCH_IDENTITY_V1 — the main branch mints a relay-scoped token here for a
  // branch that never enrolled. Mounted HERE, with the other clinic-facing
  // routes, and deliberately NOT up beside the relay itself: the two reasons the
  // relay sits above the JSON parser are body size (a catalogue is megabytes)
  // and authenticating before buffering it. Neither applies to a request whose
  // whole body is a 32-character relay id, and the global 100kb parser is the
  // right ceiling for it — a second, differently-configured body parser is a
  // thing to explain later for no benefit now.
  //
  // It sits BELOW attachVendorUser, like enroll and checkin, and that is safe
  // for the same reason: this router authenticates on install_token and never
  // reads req.vendorUser, so a vendor session buys nothing here.
  //
  // '/cp/v1/relay' above does NOT swallow this path — express matches a mount
  // prefix on segment boundaries, so '/cp/v1/relay-token' is not '/cp/v1/relay'.
  // relay-token.route.test.js proves it by minting over real HTTP.
  app.use(RELAY_TOKEN_MOUNT, relayTokenRouter(db));

  // VENDOR-FACING — the panel's own login (/login, /logout, /me are
  // themselves how a vendor becomes authenticated, so this router is not
  // behind requireVendor either) and, behind it, the admin API.
  // requireVendor is applied INSIDE adminRoutes(), not here — see admin.js.
  app.use('/cp/v1/auth', vendorAuthRoutes(db));
  app.use('/cp/v1/admin', adminRoutes(db));

  // THE_PANEL_V1 — the page the owner actually clicks, served at /cp/.
  // Registered AFTER every /cp/v1/* router above (so those still win) and
  // BEFORE the catch-all 404 below (so a request for a real static file
  // falls through to it only when nothing here matched).
  //
  // NO_STALE_CODE_V1 — same reasoning and same fix as the clinic app's own
  // server/app.js: 'no-cache' does NOT mean "never cache", it means "always
  // ask the server before using the cached copy" (an ETag round-trip is a
  // 304 in the common case — a few bytes, not the whole file). Without this,
  // a browser that already loaded panel.js keeps running the OLD code after
  // a deploy until a hard refresh, and there is no way to tell from the
  // screen that this happened — see that file's own comment for the day
  // this cost the clinic app before the fix. Images/fonts (none live here
  // yet, but if any are added) deliberately don't match this regex — they
  // don't change silently under a stable filename the way code does.
  const REVALIDATE = /\.(?:html|js|mjs|css)$/i;
  app.use('/cp', express.static(PUBLIC_DIR, {
    extensions: ['html'],
    setHeaders: (res, filePath) => {
      if (REVALIDATE.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
    },
  }));

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
