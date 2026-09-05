import { Router } from 'express';
import { requireVendor } from './vendor-auth.js';
import { createEnrollmentCode } from '../services/enrollment.js';
import { expectedResponse } from '../../../server/services/control/unlock.js';
import { SELLABLE_MODULES } from '../../../server/services/rpc/licence.js';
// STATS_V1 (docs/plans/2026-08-22-statistics.md) — the one vocabulary of
// counter names AND their human descriptions, imported rather than
// re-typed — same drift trap SELLABLE_MODULES above already guards against.
import { COUNTERS, COUNTER_NAMES } from '../../../server/services/control/metrics.js';
// Same module services/rings.js imports it from — never a third copy. Comparing
// versions numerically per segment ("0.10.0" is newer than "0.9.0") is exactly
// the kind of function that goes subtly wrong when re-typed.
import { compareVersions } from '../../../scripts/build-bundle.mjs';

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

// DELETE is the one mutating route NEXT_CHECKIN_NOTE is wrong for: it would
// claim the delete itself only takes effect at the next check-in, but the
// registry row is gone the moment this call returns — there is no "next
// check-in" for a row that no longer exists. What the owner actually needs
// to hear is the opposite kind of warning: the licence already SIGNED and
// sitting on that clinic's own computer (see services/control/unlock.js) is
// a separate, offline artifact this route cannot reach or revoke. It keeps
// working until it expires on its own — exactly like retiring — and
// deleting only stops it from ever being renewed.
const DELETE_NOTE = "The licence already installed on this clinic's computer keeps working until it expires — deleting only stops it from ever being renewed.";

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
  { method: 'DELETE', path: '/clinics/:id' },
  { method: 'POST', path: '/clinics/:id/unlock-code' },
  { method: 'POST', path: '/clinics/:id/collect' },
  { method: 'GET',  path: '/counters' },
  { method: 'GET',  path: '/requests' },
  { method: 'POST', path: '/requests/:id/grant' },
  // UPDATE_DELIVERY_V1 (docs/plans/2026-08-20-update-delivery.md, Task 3) —
  // ':id' here is a release VERSION, not a clinic_id, but this table's own
  // convention (see this table's own header) only cares that ':id' is the
  // literal placeholder the adversarial test substitutes a real string for —
  // the actual Express route below names its param `:version` for clarity;
  // that name never has to match this documentation table's placeholder.
  { method: 'POST', path: '/releases' },
  { method: 'GET',  path: '/releases' },
  { method: 'POST', path: '/releases/:id/publish' },
  { method: 'POST', path: '/releases/:id/halt' },
  { method: 'POST', path: '/releases/:id/unhalt' },
  { method: 'POST', path: '/clinics/:id/ring' },
  { method: 'POST', path: '/clinics/:id/pin' },
];

function bad(res, message) {
  return res.status(400).json({ error: { code: 'bad_request', message } });
}

// 409, not 400: the request is well-formed and the caller is allowed to make it
// — the CURRENT STATE of the clinic is what refuses. The panel shows this
// message verbatim, so every one of them is written as an instruction ("Retire
// this clinic before deleting it"), never as a diagnosis.
function conflict(res, message) {
  return res.status(409).json({ error: { code: 'conflict', message } });
}

function notFound(res, message) {
  return res.status(404).json({ error: { code: 'not_found', message } });
}

// ATTACK (found while writing this task's own duplicate-registration test,
// POST /releases twice with the same version): better-sqlite3 reports a
// collision on a non-INTEGER `TEXT PRIMARY KEY` column (releases.version,
// exactly like clinics.clinic_id above it) as e.code
// 'SQLITE_CONSTRAINT_PRIMARYKEY', NOT 'SQLITE_CONSTRAINT_UNIQUE' — verified
// directly against better-sqlite3 rather than assumed. The message text is
// identical either way ("UNIQUE constraint failed: table.column"), which is
// why this went unnoticed: createClinic()'s own retry-on-collision above
// never actually exercises this path (an id collision there is astronomically
// unlikely, never forced by a test), so the gap was silent until this task
// wrote a test that deliberately forces one. Both codes are accepted here now.
function isUniqueViolation(e, table, column) {
  return !!e && (e.code === 'SQLITE_CONSTRAINT_UNIQUE' || e.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') &&
    typeof e.message === 'string' && e.message.includes(`${table}.${column}`);
}

// UPDATE_DELIVERY_V1 — the only three ring values that exist, everywhere this
// file validates one (release publish, clinic ring). One list, not three
// hand-typed [0,1,2] literals that could quietly drift apart.
const VALID_RINGS = [0, 1, 2];

// UPDATE_DELIVERY_V1 — `{payload, sig}`-shaped, and nothing more. Deliberately
// NOT a signature check: this route never verifies the release signature —
// see POST /releases' own comment for why that trust decision is correct
// (the control plane may not even hold the release public key; the CLINIC is
// the verifier). This is only a SHAPE guard, so a manifest that could never
// possibly verify as anything (missing payload, sig not a string) is rejected
// at registration time rather than being silently stored and discovered
// broken only when a clinic tries to use it.
//
// Exported for routes/deploy.js (AUTO_ROLLOUT_V1), which registers a release
// from CI and must apply the SAME guard — one definition of "what a manifest
// looks like", never a second copy that could drift from this one.
export function isManifestShaped(manifest) {
  return !!manifest && typeof manifest === 'object' && !Array.isArray(manifest)
    && !!manifest.payload && typeof manifest.payload === 'object' && !Array.isArray(manifest.payload)
    && typeof manifest.sig === 'string' && manifest.sig.length > 0;
}

// The next unused c-NNNNNN id, derived from the highest numeric suffix seen
// today. This is a display convenience (clinic_id has no format CHECK — see
// migrations/001_registry.sql) so the non-technical owner never has to invent
// or type one; createClinic() below still retries on an actual collision
// rather than trusting this count alone.
//
// CONTROL_PLANE_V2 — the UNION is not optional. deleted_clinics holds ids that
// no longer exist in `clinics` but may never be issued again (see
// migrations/010_deleted_clinics.sql). Counting only the living would propose a
// number the trigger then refuses, five times over, and turn an ordinary "New
// clinic" click into a 500.
function nextClinicId(db) {
  const rows = db.prepare(
    'SELECT clinic_id FROM clinics UNION SELECT clinic_id FROM deleted_clinics'
  ).all();
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

// CONTROL_PLANE_V2 — the list's answer to latestStats(), for every clinic at
// once. latestStats() walks one clinic's whole check-in history; calling it per
// row turns a list render into N history scans.
//
// The window function bounds the work at RECENT_CHECKINS_SCANNED rows per
// clinic. That is a deliberate, documented difference from latestStats(): a
// clinic whose last ten check-ins all carried no stats reads as "—" on the
// board, while GET /clinics/:id still finds the older figure. The board is a
// glance; the clinic page is the record.
const RECENT_CHECKINS_SCANNED = 10;

function latestStatsForAll(db) {
  const rows = db.prepare(
    `SELECT clinic_id, at, payload FROM (
       SELECT clinic_id, at, payload,
              ROW_NUMBER() OVER (PARTITION BY clinic_id ORDER BY at DESC, id DESC) AS rn
       FROM checkins
     ) WHERE rn <= ?
     ORDER BY clinic_id, rn`
  ).all(RECENT_CHECKINS_SCANNED);

  const out = new Map();
  for (const row of rows) {
    if (out.has(row.clinic_id)) continue;   // already found this clinic's newest with stats
    let payload;
    try { payload = JSON.parse(row.payload); } catch { continue; }
    if (payload && payload.stats && typeof payload.stats === 'object' && Object.keys(payload.stats).length) {
      out.set(row.clinic_id, { stats: payload.stats, at: row.at });
    }
  }
  return out;
}

// Versions a clinic could actually be offered today: published to some ring and
// not halted. A registered-but-unpublished release (ring -1) or a halted one is
// something NOBODY is behind — saying otherwise would put an amber chip on a
// clinic that is doing exactly what it was told.
function offerableVersionsDesc(db) {
  return db.prepare('SELECT version FROM releases WHERE ring >= 0 AND halted = 0').all()
    .map((r2) => r2.version)
    .sort((a, b) => compareVersions(b, a));
}

function versionsBehind(offerable, installed) {
  if (!installed) return null;   // never checked in — unknown distance, not zero
  return offerable.filter((v) => compareVersions(v, installed) > 0).length;
}

export function adminRoutes(db) {
  const r = Router();
  r.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  r.use(requireVendor);

  // --- clinics --------------------------------------------------------------

  r.get('/clinics', (req, res) => {
    const rows = db.prepare(
      `SELECT clinic_id, name, subscription, subscription_until, last_seen_at, last_version,
              active, retired_at, parent_clinic_id, ring, pinned_version
       FROM clinics ORDER BY name COLLATE NOCASE`
    ).all();

    // CONTROL_PLANE_V2 — one grouped query, not one per row. The board draws a
    // "2 filials" line on every card, and a per-row COUNT here is the same
    // quadratic shape this route's own header warns against.
    const filialCounts = new Map(
      db.prepare(
        `SELECT parent_clinic_id AS parent, COUNT(*) AS n FROM clinics
         WHERE parent_clinic_id IS NOT NULL GROUP BY parent_clinic_id`
      ).all().map((r2) => [r2.parent, r2.n])
    );

    const statsByClinic = latestStatsForAll(db);
    const offerable = offerableVersionsDesc(db);

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
      retired_at: c.retired_at,
      parent_clinic_id: c.parent_clinic_id,
      filial_count: filialCounts.get(c.clinic_id) || 0,
      ring: c.ring,
      pinned_version: c.pinned_version,
      latest_stats: statsByClinic.get(c.clinic_id)?.stats ?? null,
      latest_stats_at: statsByClinic.get(c.clinic_id)?.at ?? null,
      versions_behind: versionsBehind(offerable, c.last_version),
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

    // RETIRE IS NOT DELETE — a clinic_id could always be reused after the row
    // that held it is deleted (migrations/001.test.js pins this as the
    // literal, un-guarded schema behaviour), and an old SIGNED licence for the
    // deleted clinic would then verify successfully against the new row
    // sharing that id — silently granting the new clinic whatever the old,
    // deleted one was entitled to. `active = 0` keeps the row (and its id)
    // dead forever instead, which was the only safe way to retire one.
    // CONTROL_PLANE_V2 — a real DELETE route exists below now, and is safe
    // ONLY because migrations/010_deleted_clinics.sql makes id reuse
    // impossible (a tombstone row plus two RAISE(ABORT) triggers refuse to
    // reissue a deleted clinic_id) and both id allocators count the graveyard.
    // Retiring is still the required FIRST step — see the delete route's own
    // comment for why deletion still requires it.
    // COALESCE, so re-retiring an already-retired clinic never rewrites the
    // date. retired_at is evidence of when it happened, and a second click
    // must not quietly relabel a decision made in August as one made today.
    db.prepare(
      "UPDATE clinics SET active = 0, retired_at = COALESCE(retired_at, strftime('%Y-%m-%dT%H:%M:%SZ','now')) WHERE clinic_id = ?"
    ).run(clinic.clinic_id);
    res.json({ ok: true, note: NEXT_CHECKIN_NOTE });
  });

  // CONTROL_PLANE_V2 — the delete 001_registry.sql said the application must
  // never do. It is safe now, and only now, because migrations/010 remembers
  // every id ever deleted and two triggers refuse to reissue one.
  r.delete('/clinics/:id', (req, res) => {
    const clinic = db.prepare('SELECT clinic_id, name, active FROM clinics WHERE clinic_id = ?')
      .get(req.params.id);
    if (!clinic) return notFound(res, 'Clinic not found.');

    // TWO STEPS, ALWAYS. Retire stops the licence renewing and is reversible by
    // hand; delete is not reversible by anything. Requiring the first before the
    // second means no single click can destroy a clinic that is still working.
    if (clinic.active) return conflict(res, 'Retire this clinic before deleting it.');

    // NOT MAPPED HERE, deliberately, and written down so the deferral is not
    // lost: migration 010's triggers raise SQLITE_CONSTRAINT_TRIGGER when
    // anything tries to reissue a deleted id, and nothing catches it — it
    // surfaces as a bare 500 from POST /clinics. That is the correct outcome
    // today: with both allocators fixed, the only way to reach it is a hand-run
    // insert or a corrupted registry, which IS a server-side invariant
    // violation and should look like one.

    // foreign_keys is ON (db/connection.js:17) and clinics.parent_clinic_id
    // carries no ON DELETE clause, so deleting a parent with filials raises
    // SQLITE_CONSTRAINT_FOREIGNKEY. Checked here so the owner reads an
    // instruction instead of a database error string.
    //
    // `<> ?` excludes the clinic's own row: parent_clinic_id = clinic_id is
    // only reachable by a hand-edited row (no route in this file sets it),
    // but without this a self-parented clinic counted as its own filial —
    // forever undeletable, "This clinic has 1 filial" about itself.
    const filials = db.prepare('SELECT COUNT(*) n FROM clinics WHERE parent_clinic_id = ? AND clinic_id <> ?')
      .get(clinic.clinic_id, clinic.clinic_id).n;
    if (filials > 0) {
      // Retiring a parent does NOT retire its filials (POST .../retire only
      // ever touches the one row named in the URL) — so "delete or reassign
      // them" was only half the procedure. The real one: retire each filial,
      // delete each filial, THEN delete this one. Said as the one sentence
      // the owner can act on, with the count still in it.
      const pronoun = filials === 1 ? 'it' : 'them';
      return conflict(res, `This clinic has ${filials} filial${filials === 1 ? '' : 's'} — retire and delete ${pronoun} first, then delete this clinic.`);
    }

    // ONE TRANSACTION. A tombstone without a delete would lock an id that still
    // has a live clinic on it; a delete without a tombstone is exactly the
    // resurrection bug this feature exists to prevent. Neither may happen alone.
    //
    // clinic_modules, relay_tokens and relay_blobs all declare ON DELETE
    // CASCADE and are cleared by the engine. checkins and module_requests carry
    // no foreign key — deliberately, see 001_registry.sql — and survive as the
    // record of what this clinic did.
    db.transaction(() => {
      db.prepare('INSERT INTO deleted_clinics (clinic_id, name, deleted_by) VALUES (?,?,?)')
        .run(clinic.clinic_id, clinic.name, req.vendorUser.username);
      db.prepare('DELETE FROM clinics WHERE clinic_id = ?').run(clinic.clinic_id);
      // module_requests has no foreign key (001_registry.sql, deliberately —
      // it survives as evidence, see the CASCADE comment above), so a
      // deleted clinic's OPEN request would otherwise keep being listed by
      // GET /requests forever (its own LEFT JOIN is what surfaces it with
      // clinic_name: null) with a live Grant button that has nothing left to
      // grant against — POST .../grant's INSERT OR IGNORE does NOT suppress
      // a FOREIGN KEY violation, so clicking it 500s, every time the owner
      // opens the screen. Close it here instead of deleting it: 'declined'
      // is reused from 001_registry.sql's own open | granted | declined
      // vocabulary rather than inventing a fourth value, and `notes` — which
      // exists for exactly this — carries the real reason.
      db.prepare(
        "UPDATE module_requests SET status = 'declined', handled_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'), notes = 'clinic deleted' WHERE clinic_id = ? AND status = 'open'"
      ).run(clinic.clinic_id);
    })();

    res.json({ ok: true, deleted: clinic.clinic_id, note: DELETE_NOTE });
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

      // BELT AND BRACES alongside the DELETE route closing a clinic's open
      // requests (see the CONTROL_PLANE_V2 delete transaction's own
      // comment): this catches anything that slipped through that —
      // a request that arrived in the gap between a real delete and the
      // next Requests refresh, or one left over from a registry deleted
      // before that fix existed. Checked explicitly rather than relying on
      // the FOREIGN KEY below, because INSERT OR IGNORE does NOT suppress a
      // FOREIGN KEY violation (only a UNIQUE/PRIMARY KEY collision) — without
      // this, granting such a request throws SQLITE_CONSTRAINT_FOREIGNKEY and
      // 500s instead of telling the owner something true.
      if (!db.prepare('SELECT 1 FROM clinics WHERE clinic_id = ?').get(request.clinic_id)) {
        return { status: 409, body: { error: { code: 'conflict', message: 'This clinic has been deleted.' } } };
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

  // --- releases (UPDATE_DELIVERY_V1) -------------------------------------------

  // Registers a release. Ring defaults to -1 (not published) via the schema —
  // registering is deliberately a SEPARATE act from publishing (POST
  // .../publish): a maintainer can stage a release's metadata before deciding
  // it is ready for even the vendor's own ring-0 install to see.
  r.post('/releases', (req, res) => {
    const { version, notes_ru, url, sha256, manifest } = req.body || {};
    if (typeof version !== 'string' || !version.trim()) return bad(res, 'version is required.');

    // TRUST BOUNDARY — deliberately NOT verified here. This control plane may
    // not even hold the release public key (it is a SEPARATE keypair from the
    // licence key — see scripts/build-bundle.mjs's own header on why two
    // keys exist), so this route only checks the manifest is the right
    // SHAPE, never that its signature is genuine. The CLINIC is the one
    // party that ever calls verifyBundle() against it (Task 4). If this API
    // is misused (a compromised vendor session, a bad admin script) the
    // manifest column can hold attacker-shaped JSON — services/checkin.js is
    // written to pass it through completely opaquely for exactly that
    // reason, never parsing it for meaning beyond "is it valid JSON".
    if (!isManifestShaped(manifest)) {
      return bad(res, 'manifest must be a {payload, sig} object — the CLINIC verifies the signature, not this API.');
    }

    try {
      db.prepare(
        `INSERT INTO releases (version, notes_ru, url, sha256, manifest) VALUES (?, ?, ?, ?, ?)`
      ).run(
        version.trim(),
        typeof notes_ru === 'string' ? notes_ru : null,
        typeof url === 'string' ? url : null,
        typeof sha256 === 'string' ? sha256 : null,
        JSON.stringify(manifest),
      );
    } catch (e) {
      if (isUniqueViolation(e, 'releases', 'version')) return bad(res, 'A release with this version is already registered.');
      throw e;
    }
    res.status(201).json({ ok: true });
  });

  // The list the panel shows: per-release outcome counts (what
  // services/checkin.js has counted from update_result reports) and the ring
  // it is offered to. Manifest is deliberately OMITTED from the list — a
  // large signed blob the panel has no row-by-row use for, the same
  // list-vs-detail split GET /clinics already draws against GET /clinics/:id.
  r.get('/releases', (req, res) => {
    const rows = db.prepare(
      `SELECT version, notes_ru, url, sha256, ring, halted, outcome_failures, outcome_successes, created_at
       FROM releases ORDER BY created_at DESC, version DESC`
    ).all();
    const releases = rows.map((row) => ({
      version: row.version,
      notes_ru: row.notes_ru,
      url: row.url,
      sha256: row.sha256,
      ring: row.ring, // -1 = registered, not published; 0/1/2 = offered up to (and including) that ring
      halted: !!row.halted,
      outcomes: { failures: row.outcome_failures, successes: row.outcome_successes },
      created_at: row.created_at,
    }));
    res.json({ releases });
  });

  // The manual promotion. Deliberately allows narrowing too (2 -> 0, say) —
  // an admin undoing a mistaken promotion must be possible, and refusing a
  // narrower ring the admin explicitly asked for would make that mistake
  // unfixable through this route.
  r.post('/releases/:version/publish', (req, res) => {
    const release = db.prepare('SELECT version FROM releases WHERE version = ?').get(req.params.version);
    if (!release) return notFound(res, 'Release not found.');

    const { ring } = req.body || {};
    if (!VALID_RINGS.includes(ring)) return bad(res, 'ring must be 0, 1, or 2.');

    db.prepare('UPDATE releases SET ring = ? WHERE version = ?').run(ring, release.version);
    res.json({ ok: true });
  });

  // Manual halt/unhalt — the SAME `halted` column services/checkin.js's own
  // automatic halt (rings.js:shouldHalt) flips, so an unhalt here always
  // means the same thing regardless of who or what set it. See checkin.js's
  // own comment for why the outcome counters are never reset by either route:
  // history survives a manual override, on purpose.
  r.post('/releases/:version/halt', (req, res) => {
    const release = db.prepare('SELECT version FROM releases WHERE version = ?').get(req.params.version);
    if (!release) return notFound(res, 'Release not found.');
    db.prepare('UPDATE releases SET halted = 1 WHERE version = ?').run(release.version);
    res.json({ ok: true });
  });

  r.post('/releases/:version/unhalt', (req, res) => {
    const release = db.prepare('SELECT version FROM releases WHERE version = ?').get(req.params.version);
    if (!release) return notFound(res, 'Release not found.');
    db.prepare('UPDATE releases SET halted = 0 WHERE version = ?').run(release.version);
    res.json({ ok: true });
  });

  // --- clinics: ring and pin (UPDATE_DELIVERY_V1) ------------------------------

  r.post('/clinics/:id/ring', (req, res) => {
    const clinic = db.prepare('SELECT clinic_id FROM clinics WHERE clinic_id = ?').get(req.params.id);
    if (!clinic) return notFound(res, 'Clinic not found.');

    const { ring } = req.body || {};
    if (!VALID_RINGS.includes(ring)) return bad(res, 'ring must be 0, 1, or 2.');

    db.prepare('UPDATE clinics SET ring = ? WHERE clinic_id = ?').run(ring, clinic.clinic_id);
    res.json({ ok: true, note: NEXT_CHECKIN_NOTE });
  });

  // `{version: null}` unpins — a real, deliberate choice, distinct from the
  // field being omitted entirely (rejected below as a malformed request: a
  // caller must say what they mean, the same discipline POST
  // .../subscription already applies to subscription_until).
  r.post('/clinics/:id/pin', (req, res) => {
    const clinic = db.prepare('SELECT clinic_id FROM clinics WHERE clinic_id = ?').get(req.params.id);
    if (!clinic) return notFound(res, 'Clinic not found.');

    const { version } = req.body || {};
    if (version !== null && (typeof version !== 'string' || !version.trim())) {
      return bad(res, 'version must be a non-empty string, or null to unpin.');
    }

    db.prepare('UPDATE clinics SET pinned_version = ? WHERE clinic_id = ?')
      .run(version === null ? null : version.trim(), clinic.clinic_id);
    res.json({ ok: true, note: NEXT_CHECKIN_NOTE });
  });

  return r;
}
