import express from 'express';
import { enrollRoutes } from './routes/enroll.js';
import { checkinRoutes } from './routes/checkin.js';

// LICENCE_CORE_V1 — the control plane's own HTTP surface, minimal on purpose.
//
// Mirrors the clinic app's server/app.js — same idioms (disable x-powered-by,
// nosniff, JSON body limit, JSON 404 for unknown /api paths, a last-resort
// error handler that never echoes the raw error to the client) — deliberately
// not copying what that app needs and this one doesn't: no session cookies, no
// static file serving, no licence gate (the control plane IS the thing that
// issues licences; it has no licence of its own to check).
export function createApp(db) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => { res.set('X-Content-Type-Options', 'nosniff'); next(); });
  app.use('/api', express.json({ limit: '100kb' }));

  app.use('/api/v1/enroll', enrollRoutes(db));
  app.use('/api/v1/checkin', checkinRoutes(db));

  // Unknown /api paths answer JSON, not an HTML 404 page.
  app.use('/api', (req, res) => res.status(404).json({ error: { code: 'not_found', message: 'Unknown API endpoint.' } }));

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
