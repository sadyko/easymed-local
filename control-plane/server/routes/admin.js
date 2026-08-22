import { Router } from 'express';
import { requireVendor } from './vendor-auth.js';
import { createEnrollmentCode } from '../services/enrollment.js';
import { expectedResponse } from '../../../server/services/control/unlock.js';
import { SELLABLE_MODULES } from '../../../server/services/rpc/licence.js';
// STATS_V1 (docs/plans/2026-08-22-statistics.md) — the one vocabulary of
// counter names AND their human descriptions, imported rather than
// re-typed — same drift trap SELLABLE_MODULES above already guards against.
import { COUNTERS, COUNTER_NAMES } from '../../../server/services/control/metrics.js';

// CONTROL_PLANE_V1 — the vendor's own admin API, behind vendor login. This is
// the part of the control plane the owner actually touches: today they would
// have to write SQL against the registry directly. Everything here is thin
// HTTP <-> registry-row translation, the same split routes/enroll.js and
// routes/checkin.js keep with their own service files — there is no separate
// services/admin.js because nothing here is reused by another caller (unlike
// enrollment.js/checkin.js, which are also called by scripts/make-licence.mjs
// and by checkin's own signing hook).

// MARKETING_NOT_OFFERABLE_V1 — 'marketing' is in the clinic's SELLABLE_MODULES
// vocabulary (the locked-module screen accepts it as something a clinic can
// REQUEST — see server/services/rpc/licence.js's moduleRequest) but the
// clinic app itself has no NAV entry for it and its route renders a "coming
// soon" overlay. A clinic that bought it would pay and see a placeholder, so
// granting it must never be possible from this panel — even though the
// underlying vocabulary still lets a clinic ASK for it (that's a real lead
// worth seeing in GET /requests, not a module worth selling yet).
//
// Filtered here, ONCE, from the one real vocabulary — never a second,
// hand-maintained list that could silently drift from SELLABLE_MODULES if
// the clinic app ever adds a fourth sellable key.
const OFFERABLE_MODULES = new Set([...SELLABLE_MODULES].filter((m) => m !== 'marketing'));

// Every mutating route returns this so the panel can tell the owner the
// change isn't instant — a clinic only sees it at its next daily check-in,
// not the moment this API call returns. See services/checkin.js: check-in is
// the ONLY place a clinic's licence is ever renewed or re-read.
const NEXT_CHECKIN_NOTE = "Takes effect at this clinic's next check-in — not instantly.";

// ADMIN_ROUTE_TABLE — the single source of truth for "every route this
// router exposes", consumed by admin.test.js's own adversarial test ("does
// requireVendor actually protect every admin route?"). A route added here
// without also adding it below would silently ship unprotected — keeping the
// table and the router in the same file, built from the same list, is what
// makes that impossible to forget. `:id` is a literal placeholder the test
// substitutes with a real row id.
export const ADMIN_ROUTE_TABLE = [
  { method: 'GET',  path: '/clinics' },
  { method: 'GET',  path: '/clinics/:id' },
  { method: 'POST', path: '/clinics' },
  { method: 'POST', path: '/clinics/:id/modules' },
  { method: 'POST', path: '/clinics/:id/subscription' },
  { method: 'POST', path: '/clinics/:id/retire' },
  { method: 'POST', path: '/clinics/:id/unlock-code' },
  { method: 'POST', path: '/clinics/:id/collect' },
  { method: 'GET',  path: '/counters' },
  { method: 'GET',  path: '/requests' },
  { method: 'POST', path: '/requests/:id/grant' },
];

function bad(res, message) {
  return res.status(400).json({ error: { code: 'bad_request', message } });
}

function notFound(res, message) {
  return res.status(404).json({ error: { code: 'not_found', message } });
}

function isUniqueViolation(e, table, column) {
  return !!e && e.code === 'SQLITE_CONSTRAINT_UNIQUE' &&
    typeof e.message === 'string' && e.message.includes(`${table}.${column}`);
}

// The next unused c-NNNNNN id, derived from the highest numeric suffix seen
// today. This is a display convenience (clinic_id has no format CHECK — see
// migrations/001_registry.sql) so the non-technical owner never has to invent
// or type one; createClinic() below still retries on an actual collision
// rather than trusting this count alone.
function nextClinicId(db) {
  const rows = db.prepare('SELECT clinic_id FROM clinics').all();
  let max = 0;
  for (const { clinic_id } of rows) {
    const m = /^c-(\d{6,})$/.exec(clinic_id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `c-${String(max + 1).padStart(6, '0')}`;
}

const MAX_CLINIC_ID_ATTEMPTS = 5;

// Creates a clinic with a freshly generated clinic_id, retrying only on an
// actual clinic_id collision (astronomically unlikely with the counter
// above, but two admins clicking "new clinic" in the same instant is not
// impossible) — mirrors enrollment.js's own retry-on-collision shape for
// enrollment_code, applied to the id this function is responsible for
// generating instead of the one createEnrollmentCode generates.
function createClinic(db, { name, contactPhone, contactName }) {
  for (let attempt = 0; attempt < MAX_CLINIC_ID_ATTEMPTS; attempt++) {
    const clinicId = nextClinicId(db);
    try {
      const enrollmentCode = createEnrollmentCode(db, { clinicId, name, contactPhone, contactName });
      return { clinicId, enrollmentCode };
    } catch (e) {
      if (isUniqueViolation(e, 'clinics', 'clinic_id')) continue; // raced with another creation — try the next id
      throw e;
    }
  }
  throw new Error(`createClinic: could not generate a unique clinic_id after ${MAX_CLINIC_ID_ATTEMPTS} attempts.`);
}

function clinicModules(db, clinicId) {
  return db.prepare('SELECT module_key FROM clinic_modules WHERE clinic_id = ? ORDER BY module_key')
    .all(clinicId).map((r) => r.module_key);
}

// Was the clinic's own last check-in flagged as a fingerprint change? Read
// from the evidence checkin.js already recorded (checkins.payload) rather
// than recomputed here — this file has no business deciding what counts as
// "changed"; that decision belongs entirely to services/checkin.js.
function lastCheckinFlaggedChange(db, clinicId) {
  const row = db.prepare('SELECT payload FROM checkins WHERE clinic_id = ? ORDER BY at DESC, id DESC LIMIT 1').get(clinicId);
  if (!row?.payload) return false;
  try { return !!JSON.parse(row.payload).fingerprint_changed; } catch { return false; }
}

function openRequestCount(db, clinicId) {
  return db.prepare("SELECT COUNT(*) n FROM module_requests WHERE clinic_id = ? AND status = 'open'").get(clinicId).n;
}

// STATS_V1 — the clinic's own collect_set, parsed for display. NULL (never
// set) and anything hand-corrupted both read as null here — "the default
// set" — so the panel can show one plain sentence for both rather than
// pretending a corrupt column is a real, empty choice.
function parsedCollectSet(rawCollectSet) {
  if (rawCollectSet === null || rawCollectSet === undefined) return null;
  try {
    const parsed = JSON.parse(rawCollectSet);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// STATS_V1 — the most recently REPORTED stats for a clinic, and when. Not
// every check-in carries usable stats (nothing learned yet, an old install,
// a throwing catalogue) — this walks check-ins newest-first and stops at the
// first payload whose `stats` object actually has something in it, rather
// than assuming the very latest row is the right one.
//
// Uses the checkins_clinic_at index (clinic_id, at DESC) for the ORDER BY —
// same `at DESC, id DESC` tie-break idiom as lastCheckinFlaggedChange() above
// — and .iterate() rather than .all(), so a clinic with hundreds of
// check-ins of history is read lazily, row by row, and this stops at the
// first hit instead of ever materialising the whole history into memory.
function latestStats(db, clinicId) {
  const stmt = db.prepare(
    'SELECT at, payload FROM checkins WHERE clinic_id = ? ORDER BY at DESC, id DESC'
  );
  for (const row of stmt.iterate(clinicId)) {
    let payload;
    try { payload = JSON.parse(row.payload); } catch { continue; } // an unparsable row is skipped, not fatal
    if (payload && payload.stats && typeof payload.stats === 'object' && Object.keys(payload.stats).length) {
      return { stats: payload.stats, at: row.at };
    }
  }
  return null; // this clinic has never reported anything usable
}

export function adminRoutes(db) {
  const r = Router();
  r.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  r.use(requireVendor);

  // --- clinics --------------------------------------------------------------

  r.get('/clinics', (req, res) => {
    const rows = db.prepare(
      `SELECT clinic_id, name, subscription, subscription_until, last_seen_at, last_version, active
       FROM clinics ORDER BY name COLLATE NOCASE`
    ).all();
    const clinics = rows.map((c) => ({
      id: c.clinic_id,
      name: c.name,
      subscription: c.subscription,
      subscription_until: c.subscription_until,
      modules: clinicModules(db, c.clinic_id),
      last_seen_at: c.last_seen_at,
      last_version: c.last_version,
      fingerprint_changed: lastCheckinFlaggedChange(db, c.clinic_id),
      open_request_count: openRequestCount(db, c.clinic_id),
      active: !!c.active,
    }));
    res.json({ clinics });
  });

  r.get('/clinics/:id', (req, res) => {
    const c = db.prepare(
      `SELECT clinic_id, name, contact_phone, contact_name, subscription, subscription_until,
              last_seen_at, last_version, last_fingerprint, active, created_at, collect_set
       FROM clinics WHERE clinic_id = ?`
    ).get(req.params.id);
    if (!c) return notFound(res, 'Clinic not found.');

    const latest = latestStats(db, c.clinic_id);

    // Deliberately NOT `SELECT *` — install_token and unlock_secret must
    // never reach this response. install_token authenticates check-in (the
    // clinic's ENTIRE credential); unlock_secret is what the /unlock-code
    // route derives a telephone code from. Either leaking here would let
    // anyone who can read this JSON impersonate or unlock the clinic without
    // ever calling that route. See admin.test.js's own leak-detection test.
    const checkins = db.prepare(
      'SELECT id, at, version, fingerprint, payload FROM checkins WHERE clinic_id = ? ORDER BY at DESC, id DESC LIMIT 50'
    ).all(c.clinic_id).map((row) => ({
      id: row.id, at: row.at, version: row.version, fingerprint: row.fingerprint,
      payload: (() => { try { return JSON.parse(row.payload); } catch { return null; } })(),
    }));

    res.json({
      clinic: {
        id: c.clinic_id,
        name: c.name,
        contact_phone: c.contact_phone,
        contact_name: c.contact_name,
        subscription: c.subscription,
        subscription_until: c.subscription_until,
        last_seen_at: c.last_seen_at,
        last_version: c.last_version,
        active: !!c.active,
        created_at: c.created_at,
        modules: clinicModules(db, c.clinic_id),
        // STATS_V1 — null means "the default set" (see resolveCollectSet in
        // services/checkin.js, the code this panel's checkbox list mirrors).
        collect_set: parsedCollectSet(c.collect_set),
        latest_stats: latest ? latest.stats : null,
        latest_stats_at: latest ? latest.at : null,
      },
      checkins,
    });
  });

  r.post('/clinics', (req, res) => {
    const { name, contact_phone, contact_name } = req.body || {};
    if (typeof name !== 'string' || !name.trim()) return bad(res, 'Name is required.');

    const { clinicId, enrollmentCode } = createClinic(db, {
      name: name.trim().slice(0, 200),
      contactPhone: typeof contact_phone === 'string' ? contact_phone.trim().slice(0, 100) || null : null,
      contactName: typeof contact_name === 'string' ? contact_name.trim().slice(0, 100) || null : null,
    });
    res.status(201).json({ clinic_id: clinicId, enrollment_code: enrollmentCode });
  });

  r.post('/clinics/:id/modules', (req, res) => {
    const clinic = db.prepare('SELECT clinic_id FROM clinics WHERE clinic_id = ?').get(req.params.id);
    if (!clinic) return notFound(res, 'Clinic not found.');

    const { module_key, granted } = req.body || {};
    if (typeof granted !== 'boolean') return bad(res, 'granted must be true or false.');
    const key = String(module_key || '');

    if (granted) {
      // Grant is intentionally the STRICTER direction — see
      // MARKETING_NOT_OFFERABLE_V1 above. 'marketing' fails this check even
      // though it IS in SELLABLE_MODULES.
      if (!OFFERABLE_MODULES.has(key)) return bad(res, 'Unknown or unofferable module.');
      // INSERT OR IGNORE: granting a module the clinic already has is a
      // no-op, not an error — (clinic_id, module_key) is the primary key.
      db.prepare('INSERT OR IGNORE INTO clinic_modules (clinic_id, module_key, granted_by) VALUES (?, ?, ?)')
        .run(clinic.clinic_id, key, req.vendorUser.username);
    } else {
      // Revoke is deliberately checked against the FULL sellable vocabulary,
      // not the offerable subset — if a 'marketing' grant ever existed (hand-
      // edited data, a bug elsewhere), taking it away must still be possible;
      // only GRANTING marketing is what this file refuses.
      if (!SELLABLE_MODULES.has(key)) return bad(res, 'Unknown module.');
      db.prepare('DELETE FROM clinic_modules WHERE clinic_id = ? AND module_key = ?').run(clinic.clinic_id, key);
    }
    res.json({ ok: true, note: NEXT_CHECKIN_NOTE });
  });

  r.post('/clinics/:id/subscription', (req, res) => {
    const clinic = db.prepare('SELECT clinic_id FROM clinics WHERE clinic_id = ?').get(req.params.id);
    if (!clinic) return notFound(res, 'Clinic not found.');

    const { subscription, subscription_until } = req.body || {};
    if (subscription !== 'active' && subscription !== 'unpaid') {
      return bad(res, 'subscription must be "active" or "unpaid".');
    }
    let until = null;
    if (subscription_until !== undefined && subscription_until !== null && subscription_until !== '') {
      // Day-granularity only, matching services/checkin.js's own
      // parseDateOnly expectations — anything else is rejected rather than
      // silently truncated, since this date directly gates re-arming.
      if (typeof subscription_until !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(subscription_until)) {
        return bad(res, 'subscription_until must be a YYYY-MM-DD date, or omitted/null to clear it.');
      }
      // A PAST date is deliberately still accepted — see this route's own
      // attack test: that is today's way to end a subscription, and
      // services/checkin.js is what actually enforces it at the next
      // check-in (isEntitled: a lapsed subscription_until never re-arms).
      until = subscription_until;
    }

    db.prepare('UPDATE clinics SET subscription = ?, subscription_until = ? WHERE clinic_id = ?')
      .run(subscription, until, clinic.clinic_id);
    res.json({ ok: true, note: NEXT_CHECKIN_NOTE });
  });

  r.post('/clinics/:id/retire', (req, res) => {
    const clinic = db.prepare('SELECT clinic_id FROM clinics WHERE clinic_id = ?').get(req.params.id);
    if (!clinic) return notFound(res, 'Clinic not found.');

    // NO DELETE ROUTE, DELIBERATELY — a clinic_id can be reused after the row
    // that held it is deleted (migrations/001.test.js pins this as today's
    // literal, un-guarded schema behaviour), and an old SIGNED licence for the
    // deleted clinic would then verify successfully against the new row
    // sharing that id — silently granting the new clinic whatever the old,
    // deleted one was entitled to. `active = 0` keeps the row (and its id)
    // dead forever instead, which is the only safe way to retire one.
    db.prepare('UPDATE clinics SET active = 0 WHERE clinic_id = ?').run(clinic.clinic_id);
    res.json({ ok: true, note: NEXT_CHECKIN_NOTE });
  });

  r.post('/clinics/:id/unlock-code', (req, res) => {
    const clinic = db.prepare('SELECT clinic_id, unlock_secret FROM clinics WHERE clinic_id = ?').get(req.params.id);
    if (!clinic) return notFound(res, 'Clinic not found.');

    const { challenge } = req.body || {};
    if (typeof challenge !== 'string' || !challenge.trim()) return bad(res, 'challenge is required.');

    // ALWAYS expectedResponse() from services/control/unlock.js — never a
    // second, reimplemented derivation. That exact duplication existed once
    // in this project (scripts/make-licence.mjs originally re-typed the
    // alphabet and reimplemented the HMAC) and was removed after nothing
    // forced the two copies to agree; the divergence only would have
    // surfaced when a locked, offline clinic read out a code that did not
    // verify.
    const code = expectedResponse({ clinicId: clinic.clinic_id, challenge: challenge.trim(), secret: clinic.unlock_secret });
    res.json({ code });
  });

  // STATS_V1 — the vendor's counter picklist for this clinic. Unlike
  // POST /clinics/:id/modules (which accepts an unofferable-but-sellable key
  // for REVOKE, see MARKETING_NOT_OFFERABLE_V1), there is no "offerable
  // subset" distinction here: every name in COUNTER_NAMES is always a valid
  // thing to collect, so any name outside that vocabulary is simply unknown
  // and rejected — a direct API caller inventing a name should hear about
  // it (400), unlike a clinic mid-check-in reporting one (silently dropped,
  // see normaliseStats in services/checkin.js — a check-in must never fail
  // over a name the panel picker itself would never have offered).
  r.post('/clinics/:id/collect', (req, res) => {
    const clinic = db.prepare('SELECT clinic_id FROM clinics WHERE clinic_id = ?').get(req.params.id);
    if (!clinic) return notFound(res, 'Clinic not found.');

    const { names } = req.body || {};
    if (!Array.isArray(names)) return bad(res, 'names must be an array.');
    for (const n of names) {
      if (typeof n !== 'string' || !COUNTER_NAMES.includes(n)) {
        return bad(res, `Unknown counter: ${JSON.stringify(n)}`);
      }
    }
    // Deduplicated — a double-submitted checkbox list must not store the
    // same name twice; harmless either way, but the stored set should read
    // as a clean, deliberate choice.
    const unique = [...new Set(names)];
    db.prepare('UPDATE clinics SET collect_set = ? WHERE clinic_id = ?').run(JSON.stringify(unique), clinic.clinic_id);
    res.json({ ok: true, note: NEXT_CHECKIN_NOTE });
  });

  // STATS_V1 — the panel's own checkbox list. Built server-side from the
  // imported catalogue: `describe` (previously unused outside the clinic
  // app) finally earns its keep here as the label the vendor actually reads
  // before deciding what to collect.
  r.get('/counters', (req, res) => {
    const counters = COUNTER_NAMES.map((name) => ({ name, describe: COUNTERS[name].describe }));
    res.json({ counters });
  });

  // --- module requests --------------------------------------------------------

  r.get('/requests', (req, res) => {
    // LEFT JOIN — module_requests.clinic_id is deliberately not a foreign key
    // (see migrations/001_registry.sql: check-in history survives a deleted
    // clinic row), so a request for a since-deleted clinic must still be
    // listed rather than silently disappearing from an INNER JOIN.
    const rows = db.prepare(
      `SELECT mr.id, mr.clinic_id, c.name AS clinic_name, mr.module_key, mr.requested_at, mr.received_at
       FROM module_requests mr LEFT JOIN clinics c ON c.clinic_id = mr.clinic_id
       WHERE mr.status = 'open' ORDER BY mr.received_at DESC`
    ).all();
    res.json({ requests: rows });
  });

  r.post('/requests/:id/grant', (req, res) => {
    // One transaction: granting the module and marking the request granted
    // must never happen one without the other — either outcome alone (a
    // grant with no request marked handled, or a request marked handled with
    // no actual entitlement) is a state this panel would then lie about.
    const outcome = db.transaction(() => {
      const request = db.prepare('SELECT * FROM module_requests WHERE id = ?').get(req.params.id);
      if (!request) return { status: 404, body: { error: { code: 'not_found', message: 'Request not found.' } } };

      // ATTACK: a double click, or a double-submit — the second call must be
      // a harmless success, never a duplicate grant or an error.
      if (request.status === 'granted') {
        return { status: 200, body: { ok: true, already: true, note: NEXT_CHECKIN_NOTE } };
      }

      // Same MARKETING_NOT_OFFERABLE_V1 rule as POST /clinics/:id/modules —
      // a lead for it can exist (a clinic is allowed to ASK), but granting it
      // through EITHER route must be refused. The request is left exactly as
      // it was: open, so a human can still see and decide what to do with it.
      if (!OFFERABLE_MODULES.has(request.module_key)) {
        return { status: 400, body: { error: { code: 'bad_request', message: 'This module cannot be granted.' } } };
      }

      db.prepare('INSERT OR IGNORE INTO clinic_modules (clinic_id, module_key, granted_by) VALUES (?, ?, ?)')
        .run(request.clinic_id, request.module_key, req.vendorUser.username);
      db.prepare("UPDATE module_requests SET status = 'granted', handled_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?")
        .run(request.id);
      return { status: 200, body: { ok: true, already: false, note: NEXT_CHECKIN_NOTE } };
    })();

    res.status(outcome.status).json(outcome.body);
  });

  return r;
}
