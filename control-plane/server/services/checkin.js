// LICENCE_CORE_V1 — the daily call that re-arms a paid clinic's licence.
//
// A clinic's licence is a dead-man's switch: it is valid for 14 days and is
// only ever renewed by this call succeeding. Nobody flips a "disable" switch
// on a clinic — stopping this call (non-payment, a clinic gone quiet) is the
// ENTIRE mechanism. That shapes every rule below:
//
//   - identify first, and identify ONLY (rule 1): an unknown, deactivated, or
//     malformed token gets nothing, indistinguishable from the outside;
//   - once identified, record the visit BEFORE attempting anything that could
//     fail (rule 2): signing is the one step here that can throw (a bad key,
//     an unset env var), and a clinic whose licence fails to sign must still
//     show up as having called in — the absence of check-ins is the vendor's
//     only early warning that something is wrong with a clinic;
//   - a fingerprint change is evidence, never a lock (rule 4) — hardware gets
//     replaced, and locking an innocent clinic over it is worse than letting
//     a duplicated install run a few days until a human notices the flag.
//
// Deliberately signing-agnostic, mirroring enrollment.js's own reasoning:
// this file never imports signing.js. The caller (routes/checkin.js, in
// production) passes signLicence in as a hook — and, critically, that hook is
// invoked only AFTER the transaction below has already committed, which is
// the exact opposite ordering from enrollment.js's beforeCommit (which runs
// BEFORE its commit, so a signing failure can roll the enrollment back). Here
// there is nothing to roll back: the check-in already happened by the time
// signing is even attempted, so a throw from signLicence propagates straight
// out of this function without being able to un-record anything.

import { SELLABLE_MODULES } from '../../../server/services/rpc/licence.js';
// STATS_V1 (docs/plans/2026-08-22-statistics.md) — the ONE vocabulary of
// counter names, imported rather than re-typed. Same drift trap this repo
// has already been bitten by once (see this file's own SELLABLE_MODULES
// import, and metrics.js's own header): if the vendor's picklist and the
// clinic's own catalogue could ever disagree on what a name means, that
// disagreement would be invisible until a clinic reported a number under a
// name the vendor never actually offered.
import { COUNTER_NAMES } from '../../../server/services/control/metrics.js';
// UPDATE_DELIVERY_V1 (docs/plans/2026-08-20-update-delivery.md, Task 3) — the
// pure ring/halt decision logic, imported rather than re-derived here. This
// file's job is DB plumbing (read the clinic's ring/pin, read the releases
// table, count outcomes); rings.js's job is deciding what those facts mean.
import { offerFor, shouldHalt } from './rings.js';

// Advisory bounds, mirroring enrollment.js's own MAX_FINGERPRINT_LEN (same
// reasoning: these are evidence, not credentials, so an absurd value is
// truncated, never a reason to fail). Defined locally rather than imported —
// this task's file scope is checkin.js and its route, not a refactor of
// enrollment.js's unexported helpers.
const MAX_VERSION_LEN = 64;
const MAX_FINGERPRINT_LEN = 256;
const MAX_REQUESTED_AT_LEN = 64;

// STATS_V1 — a bound on how many stats keys a single check-in can carry,
// mirroring normaliseModuleRequests' own reasoning: this is a backstop
// against a hostile or buggy caller, not a real limit (COUNTER_NAMES itself
// is a small, fixed catalogue today).
const MAX_STATS_KEYS = 50;

// UPDATE_DELIVERY_V1 — a version string looks like "2.4.0"; generous enough
// for any real release tag, small enough that a hostile caller can't stuff an
// enormous string into a column that only ever needs to match a releases.version.
const MAX_UPDATE_RESULT_VERSION_LEN = 32;

// EVIDENCE_RETENTION_V1 (2026-09-02) — checkins is "evidence, not state"
// (see migrations/001_registry.sql's own comment on the table) and was never
// pruned: at the old once-a-day check-in cadence that was one row/clinic/day,
// small enough nobody had to care. ONE_HOUR_SYNC_V1 raised the clinic-side
// interval (server/services/control/checkin.js INTERVAL_MS) to once an
// hour — 24 rows/clinic/day instead of 1 — so this table is now worth
// bounding, following the exact "retention that only runs as a side effect
// of traffic" idiom pruneRelayBlobs (routes/relay.js) and pruneRelayTokens
// (routes/relay-token.js) already use in this same service, rather than
// inventing a second pattern for the same problem.
//
// 90 days, not the 30 those two use: this table is read for real diagnosis
// (routes/admin.js's clinic-detail check-in history, and latestStats()'s own
// walk back through payloads) and answers billing-adjacent questions months
// later — a longer memory than a relay blob or a bearer token needs. Even at
// the new hourly rate that is ~2,160 rows/clinic over 90 days: trivial for
// SQLite, and migrations/009_checkins_at_index.sql gives the DELETE below an
// index to run against instead of a full-table scan on every check-in.
const DEFAULT_CHECKIN_RETENTION_DAYS = 90;

function normaliseToken(token) {
  return typeof token === 'string' && token.length > 0 ? token : null;
}

/**
 * Delete check-in evidence older than `days`.
 *
 * Exported for the same reason pruneRelayBlobs/pruneRelayTokens are:
 * retention that only runs as a side effect of traffic is retention nobody
 * can test or trigger. Called from checkIn() itself, AFTER its own
 * transaction has already committed — never from inside it. A housekeeping
 * DELETE must not be able to roll back the check-in it is attached to: this
 * file's header (rule 2) is explicit that recording the visit is the one
 * thing here that may never fail, and better-sqlite3's db.transaction()
 * rolls back the WHOLE transaction on any thrown error, so nesting this
 * inside checkIn's txn would put a housekeeping bug on the same failure path
 * as the licence renewal it is deliberately unrelated to. The internal
 * try/catch below is a second, independent backstop for the same reason —
 * belt and braces, not redundant.
 *
 * @returns {number} rows removed
 */
export function pruneCheckins(db, { days = DEFAULT_CHECKIN_RETENTION_DAYS, now = () => new Date() } = {}) {
  const cutoff = new Date(now().getTime() - days * 24 * 60 * 60 * 1000).toISOString();
  try {
    const info = db.prepare('DELETE FROM checkins WHERE at < ?').run(cutoff);
    return info.changes;
  } catch (e) {
    // Housekeeping must never fail the check-in it is attached to — same rule
    // pruneRelayBlobs/pruneRelayTokens state for their own callers.
    console.warn('[control-plane] checkins retention sweep failed:', e && e.message);
    return 0;
  }
}

// Advisory only — version and fingerprint are informational, never a reason
// to fail a check-in. A non-string (an object, a number, absent entirely)
// becomes null rather than being coerced: String({}) === '[object Object]'
// would store a value that LOOKS like real data but isn't, which is worse
// than recording "we don't know".
function normaliseAdvisory(value, maxLen) {
  if (typeof value !== 'string' || value.length === 0) return null;
  return value.length > maxLen ? value.slice(0, maxLen) : value;
}

function normaliseRequestedAt(value) {
  if (typeof value === 'string' && value.trim()) {
    return value.trim().slice(0, MAX_REQUESTED_AT_LEN);
  }
  // Missing or garbage (a number, an object, absent entirely). requested_at
  // has NO schema default (unlike received_at) — some value must be stored,
  // so a missing one is stamped with receipt time rather than the whole lead
  // being dropped over one missing field.
  return new Date().toISOString();
}

// Turns whatever module_requests the client sent into a clean, deduplicated
// list of {module_key, requested_at}. Never throws and never drops the WHOLE
// call over one bad entry: a check-in carries the clinic's licence renewal,
// and a malformed lead in this array must cost only that lead, never the
// clinic's licence. See checkin.test.js's own attack tests for the shapes
// this must survive: not an array at all, 500 entries, a non-sellable key, a
// missing requested_at, and a "__proto__" key.
//
// Deliberately no length cap on `input` itself: app.js already bounds the
// whole request body to 100kb, which bounds how many entries can even arrive,
// and SELLABLE_MODULES below narrows whatever DOES arrive down to at most a
// handful of real keys regardless of how many raw entries were sent. A
// positional cap (take only the first N) was tried and rejected here — it can
// silently drop a genuine, sellable entry that happens to sit past the cutoff
// in a large batch, which is exactly the "one bad entry costs a good lead"
// failure this function exists to avoid.
function normaliseModuleRequests(input) {
  if (!Array.isArray(input)) return []; // wrong shape entirely — dropped, not fatal

  // A Map, not a plain object — a module_key of "__proto__" must never reach
  // an object literal used as a lookup table. Array.from(map) below turns it
  // back into the plain array the rest of this file wants.
  const seen = new Map();
  for (const entry of input) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue; // rubbish entry, dropped
    const key = typeof entry.module_key === 'string' ? entry.module_key.trim() : '';
    if (!key || !SELLABLE_MODULES.has(key)) continue; // unknown/unsellable/missing key — dropped, not fatal
    seen.set(key, normaliseRequestedAt(entry.requested_at)); // last one in the batch wins; both describe the same lead
  }
  return Array.from(seen, ([module_key, requested_at]) => ({ module_key, requested_at }));
}

// Parses a "YYYY-M-D"-shaped date STRING at day granularity, ignoring any
// time component. Deliberately not `new Date(value)` — that constructor's
// handling of non-ISO strings is implementation-defined, and this project has
// already flagged that '2026-9-1' and '2026-09-01' must compare equal despite
// not being string-equal. Parsing the three numbers out by hand and comparing
// them as a UTC day makes that true regardless of what the engine's own
// string parser would have done with the unpadded form.
function parseDateOnly(value) {
  if (typeof value !== 'string') return null;
  const m = value.trim().match(/^(\d{1,4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return null;
  const [, y, mo, d] = m;
  const dt = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  return Number.isNaN(dt.getTime()) ? null : dt;
}

// STATS_V1 — turns clinics.collect_set (NULL, valid JSON, or hand-edited
// junk) into the actual list of names to hand back as `collect`. NULL is the
// documented default (migrations/003_collect_set.sql: "the default set"),
// and so is anything this column could never legitimately contain — a
// corrupt value must fail OPEN to the default catalogue, never 500 a
// check-in over a bad column value the clinic had no part in writing.
// Filtered against the CURRENT COUNTER_NAMES on the way out, too: a name
// stored while it still existed but since removed from the catalogue would
// otherwise instruct an old install to keep trying to collect something
// that no longer means anything.
function resolveCollectSet(rawCollectSet) {
  if (rawCollectSet === null || rawCollectSet === undefined) return COUNTER_NAMES.slice();
  let parsed;
  try {
    parsed = JSON.parse(rawCollectSet);
  } catch {
    return COUNTER_NAMES.slice(); // hand-corrupted column — fall back to the default, not a crash
  }
  if (!Array.isArray(parsed)) return COUNTER_NAMES.slice();
  return parsed.filter((n) => typeof n === 'string' && COUNTER_NAMES.includes(n));
}

// STATS_V1 — the incoming `stats` object, cut down to exactly what the
// no-PII guarantee promises: known catalogue keys, finite numbers, a bounded
// count. Never throws, and never fails the check-in over a garbage value —
// "a malformed stat costs a data point; a rejected check-in costs a licence
// renewal" (this task's own instruction). Deliberately NOT scoped to the
// clinic's own collect_set: a counter the vendor un-ticked since the
// clinic's last check-in is still a real, known name, and rejecting it here
// would only throw away a harmless, already-computed number for no security
// benefit (buildStatsPayload — the clinic side — is what enforces "the panel
// can never send a query"; this side's job is "never store garbage").
function normaliseStats(input) {
  const out = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out; // wrong shape entirely — dropped, not fatal
  let count = 0;
  for (const key of Object.keys(input)) {
    if (count >= MAX_STATS_KEYS) break;
    if (!COUNTER_NAMES.includes(key)) continue; // unknown or since-removed counter — dropped, not fatal
    const value = Number(input[key]);
    if (!Number.isFinite(value)) continue; // NaN/Infinity/non-numeric — dropped
    out[key] = value;
    count++;
  }
  return out;
}

// UPDATE_DELIVERY_V1 — the clinic's own report on whether ITS update attempt
// succeeded. Same normalisation discipline as normaliseStats: a malformed
// report costs nothing but itself, never the check-in that carries it — see
// this function's own callers for why the WHOLE object is dropped (returned
// null) rather than salvaged field-by-field, unlike normaliseStats: there is
// no sensible partial reading of "an update result with a version but no
// verdict", or vice versa, so a shape that isn't cleanly both is treated as
// not having said anything at all.
function normaliseUpdateResult(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null; // wrong shape entirely
  const version = typeof input.version === 'string' ? input.version.trim().slice(0, MAX_UPDATE_RESULT_VERSION_LEN) : '';
  if (!version) return null; // no version named — nothing to attribute this report to
  if (typeof input.ok !== 'boolean') return null; // never coerced: '', 0, 'false' are not booleans
  return { version, ok: input.ok };
}

// Rule 5 — re-arm only if entitled. subscription_until is inclusive of the
// day itself: "paid until 2026-08-21" means still paid ON the 21st, not only
// on the days strictly before it — only a date strictly BEFORE today has
// actually lapsed. A subscription_until that fails to parse (hand-typed junk
// in the registry) is treated as NOT entitled: fail closed, the same way the
// rest of this project treats "can't tell" as "locked" rather than guessing
// in the clinic's favour.
function isEntitled(subscription, subscriptionUntil, now = new Date()) {
  if (subscription !== 'active') return false;
  if (subscriptionUntil === null || subscriptionUntil === undefined || subscriptionUntil === '') return true;
  const until = parseDateOnly(subscriptionUntil);
  if (!until) return false;
  const today = parseDateOnly(now.toISOString());
  return until.getTime() >= today.getTime();
}

/**
 * The daily call. See this file's header for the record-then-sign ordering
 * guarantee, and routes/checkin.js for how this is wired to HTTP.
 *
 * @param {Database} db
 * @param {object} args
 * @param {*} args.installToken
 * @param {*} [args.version]
 * @param {*} [args.fingerprint]
 * @param {*} [args.moduleRequests]
 * @param {*} [args.stats] STATS_V1 — the clinic's reported counters, `{ [name]: number }`. Optional forever: an
 *   older clinic that never sends this field at all must check in exactly as it always has.
 * @param {*} [args.updateResult] UPDATE_DELIVERY_V1 — `{ version, ok }`, the clinic's own report on whether ITS
 *   update attempt succeeded. Optional forever, same as `stats` — an old clinic that never sends this checks in
 *   exactly as before. Never verified/interpreted beyond version+ok (see normaliseUpdateResult); only ever used to
 *   move this file's own outcome counters and, via rings.js:shouldHalt, to freeze a release from further offers.
 * @param {object} [hooks]
 * @param {function({clinicId:string, clinicName:string, modules:string[]}): {payload:object, sig:string}} [hooks.signLicence]
 *   Called ONLY when the clinic is currently entitled to a fresh licence
 *   (rule 5), and ONLY after the check-in below has already committed (rule
 *   2) — if it throws, the throw propagates straight to the caller, but the
 *   checkins row (and everything else this call wrote) is already durable.
 * @returns {{licence: object|null, subscription: 'active'|'unpaid', collect: string[], update: object|null} | null}
 *   null means unknown, inactive, or malformed token (rule 1) — the caller
 *   (routes/checkin.js) turns that into ONE generic 401, indistinguishable
 *   from the outside. `collect` (STATS_V1) is this clinic's collect_set, or
 *   the code-level default (every COUNTER_NAMES) when it has never been set.
 *   `update` (UPDATE_DELIVERY_V1) is `{version, notes_ru, url, sha256, manifest}`
 *   for the single newest release this clinic is eligible for (rings.js:offerFor),
 *   or null when there is nothing to offer.
 */
export function checkIn(db, { installToken, version, fingerprint, moduleRequests, stats, updateResult } = {}, { signLicence } = {}) {
  const token = normaliseToken(installToken);
  if (!token) return null; // malformed/missing — never worth a DB round-trip, same outward shape as "unknown"

  const normVersion = normaliseAdvisory(version, MAX_VERSION_LEN);
  const normFingerprint = normaliseAdvisory(fingerprint, MAX_FINGERPRINT_LEN);
  const requests = normaliseModuleRequests(moduleRequests);
  // STATS_V1 — normalised OUTSIDE the transaction, same as `requests` above:
  // it never touches the database itself, so there is nothing here that
  // needs transactional atomicity, only the same "never throw, never fail
  // the call" guarantee normaliseModuleRequests already gives.
  const normStats = normaliseStats(stats);
  // UPDATE_DELIVERY_V1 — same reasoning: pure, outside the transaction.
  const normUpdateResult = normaliseUpdateResult(updateResult);

  // ATOMICITY — as with enrollment.js's own transaction, this is not about
  // concurrent-request locking: better-sqlite3 is fully synchronous and Node
  // is single-threaded, so nothing else can run between any two statements
  // below regardless of this wrapper. What it buys is crash-safety and
  // all-or-nothing ordering: if the process died mid-write, the check-in is
  // either fully recorded (row + last_seen_at + leads) or not recorded at
  // all — never a checkins row with no matching last_seen_at update.
  const txn = db.transaction(() => {
    // UPDATE_DELIVERY_V1 — ring and pinned_version are also read here (in the
    // same identifying SELECT, not a second query) purely so rings.js:offerFor
    // has what it needs; neither column affects rule 1's identification/entitlement logic.
    const clinic = db.prepare(
      `SELECT clinic_id, name, subscription, subscription_until, last_fingerprint, collect_set, ring, pinned_version
       FROM clinics WHERE install_token = ? AND active = 1`
    ).get(token);
    // Rule 1 — unknown, inactive, and (handled above) malformed tokens are
    // ALL this same early return: nothing is written, nothing here is
    // distinguishable from the outside. A stale token whose clinic row was
    // since deleted also lands here — the row it would have matched is
    // simply gone (see checkin.test.js's "clinic row deleted" test).
    if (!clinic) return null;

    // Recorded, never acted on — rule 4. Only flagged when there WAS a prior
    // fingerprint to compare against; a clinic's very first recorded
    // fingerprint is a baseline, not a "change".
    const fingerprintChanged = !!(clinic.last_fingerprint && normFingerprint && clinic.last_fingerprint !== normFingerprint);

    // RULE 2, THE ORDERING THAT MATTERS — this INSERT (and everything else in
    // this transaction) happens unconditionally, before this function has
    // even decided whether the clinic is entitled to a fresh licence. See
    // checkIn's own doc comment: signLicence runs only AFTER this whole
    // transaction has returned, so a clinic whose licence fails to sign must
    // still show up here.
    // STATS_V1 — `stats` merged into the SAME payload object as
    // module_requests/fingerprint_changed, not written as a second update:
    // this row is written once, so "merge, don't clobber" means building the
    // whole object in one place, never overwriting an earlier write to this
    // same row. Present even when empty (an old clinic that never sends
    // `stats` at all, or one that sent nothing usable) so `stats` in a
    // payload is always a reliable, present key — see routes/admin.js's
    // latestStats(), which distinguishes "carried stats" by non-empty keys,
    // not by the key's mere presence.
    db.prepare(
      `INSERT INTO checkins (clinic_id, version, fingerprint, payload) VALUES (?, ?, ?, ?)`
    ).run(clinic.clinic_id, normVersion, normFingerprint, JSON.stringify({
      module_requests: requests,
      fingerprint_changed: fingerprintChanged,
      stats: normStats,
      update_result: normUpdateResult,
    }));

    db.prepare(
      `UPDATE clinics
       SET last_seen_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'), last_version = ?, last_fingerprint = ?
       WHERE clinic_id = ?`
    ).run(normVersion, normFingerprint, clinic.clinic_id);

    // Rule 6 — deduplicated per (clinic_id, module_key) while status='open'.
    // No unique index enforces this in THIS schema (unlike the clinic-side
    // module_requests_open_uniq partial index) — the SELECT-then-INSERT below
    // is the only guard, safe here for the same reason enrollment.js and the
    // clinic-side RPC give: synchronous, single-writer, nothing else can run
    // between the SELECT and the INSERT.
    for (const { module_key, requested_at } of requests) {
      const open = db.prepare(
        `SELECT id FROM module_requests WHERE clinic_id = ? AND module_key = ? AND status = 'open'`
      ).get(clinic.clinic_id, module_key);
      if (open) continue; // already an open lead for this clinic+module — idempotent, rule 7
      db.prepare(
        `INSERT INTO module_requests (clinic_id, module_key, requested_at) VALUES (?, ?, ?)`
      ).run(clinic.clinic_id, module_key, requested_at);
    }

    // BRANCH_MODULES_INHERIT_V1 — a branch runs the modules of its network.
    //
    // Owner's decision (2026-09-02), in their words: "everything in the main
    // clinic should be active as if it is a one system". A branch is a separate
    // row here with its own subscription and its own bill — that stays — but it
    // is not a separate BUSINESS. Reception in the second building answers the
    // same phone numbers and works the same leads as reception in the first.
    //
    // Resolved through the parent on every check-in rather than copied into the
    // branch's rows when it was created. A copy is a snapshot: enable telephony
    // for the network next month and every branch created before that stays
    // dark, with nothing on any screen to explain why. This cannot drift.
    //
    // UNION, not replacement: a branch may also have been granted something of
    // its own, and taking that away because it has a parent would be a silent
    // downgrade nobody asked for.
    const modules = db.prepare(
      `SELECT DISTINCT module_key FROM clinic_modules
        WHERE clinic_id = ?
           OR clinic_id = (SELECT parent_clinic_id FROM clinics WHERE clinic_id = ?)
        ORDER BY module_key`
    ).all(clinic.clinic_id, clinic.clinic_id).map((m) => m.module_key);

    // UPDATE_DELIVERY_V1 — the clinic's report on ITS OWN update attempt.
    // Already recorded (evidence, unconditionally) in the payload above; what
    // happens here is the ONLY thing that can change control-plane STATE from
    // it — a release's outcome counters, and possibly its `halted` flag, set
    // INSIDE this same transaction (the task's own requirement: a halt must
    // never be a separate, un-atomic write from the failure that caused it).
    //
    // Only a NEW FAILURE can flip halted from 0 to 1 — never a success, and
    // never when it is already halted. This is deliberate, not an oversight:
    // rings.js:shouldHalt looks at cumulative counters that are NEVER reset
    // (see migrations/004_releases.sql), so if a success were also allowed to
    // re-trigger the check, a release a human just unhalted could freeze
    // itself again on the very next ordinary success report, purely from
    // stale counts nobody asked to re-litigate. A fresh failure re-tripping
    // it after an unhalt, by contrast, is exactly the safety net working as
    // intended — new evidence, evaluated again.
    if (normUpdateResult) {
      if (normUpdateResult.ok) {
        // No-op (0 rows affected) if this version was never registered as a
        // release — a success report cannot invent a release row, only add
        // to one that already exists.
        db.prepare('UPDATE releases SET outcome_successes = outcome_successes + 1 WHERE version = ?')
          .run(normUpdateResult.version);
      } else {
        const release = db.prepare(
          'SELECT halted, outcome_failures, outcome_successes FROM releases WHERE version = ?'
        ).get(normUpdateResult.version);
        // An update_result naming a version this control plane never
        // registered (or has since removed) is still real EVIDENCE — already
        // stored in the payload above — but there is no release row to
        // credit it to or halt. Never throws, never invents one.
        if (release) {
          const failures = release.outcome_failures + 1;
          db.prepare('UPDATE releases SET outcome_failures = outcome_failures + 1 WHERE version = ?')
            .run(normUpdateResult.version);
          if (!release.halted && shouldHalt({ outcomes: { failures, successes: release.outcome_successes } })) {
            db.prepare('UPDATE releases SET halted = 1 WHERE version = ?').run(normUpdateResult.version);
            // LOUD and deliberate: console.error, not .warn. An automatic
            // halt stops every remaining clinic in the ring from being
            // offered this release with no admin having asked for it yet —
            // this must be impossible to miss in the server's own logs.
            console.error(
              `[control-plane] RELEASE AUTO-HALTED: ${normUpdateResult.version} — ` +
              `${failures} failure(s) vs ${release.outcome_successes} success(es) reported by clinic ${clinic.clinic_id}.`
            );
          }
        }
      }
    }

    // UPDATE_DELIVERY_V1 — at most one offer, the newest this clinic is
    // eligible for (rings.js:offerFor). Read INSIDE this same transaction so
    // a halt this very call just triggered above is already reflected in
    // what gets offered back to THIS clinic (never offer a release in the
    // same breath that just froze it).
    const releaseRows = db.prepare(
      `SELECT version, notes_ru, url, sha256, manifest, ring, halted FROM releases`
    ).all();
    const offer = offerFor({
      releases: releaseRows,
      clinic: { ring: clinic.ring, pinnedVersion: clinic.pinned_version },
      installedVersion: normVersion,
    });
    let update = null;
    if (offer) {
      // Manifest is stored and passed through OPAQUELY (see this file's own
      // header and routes/admin.js's POST /releases) — parsed here only to
      // embed it as a nested JSON object in the response rather than a
      // double-encoded string, never inspected for meaning. A release whose
      // stored manifest somehow fails to parse (a hand-corrupted column) is
      // the one case this refuses to offer at all: a broken manifest is
      // useless to the clinic anyway, and "no offer" is a safer failure than
      // handing back something the clinic cannot use.
      let manifest = null;
      try { manifest = JSON.parse(offer.manifest); } catch { manifest = null; }
      if (manifest) {
        update = { version: offer.version, notes_ru: offer.notes_ru, url: offer.url, sha256: offer.sha256, manifest };
      }
    }

    return {
      clinicId: clinic.clinic_id,
      clinicName: clinic.name,
      subscription: clinic.subscription,
      subscriptionUntil: clinic.subscription_until,
      modules,
      collectSet: clinic.collect_set,
      update,
    };
  });

  const recorded = txn();
  if (!recorded) return null;

  // Everything above this line is already committed. Nothing below can ever
  // un-record the visit — a throw from signLicence propagates straight out
  // of this function to the caller, but the checkins row (and the clinics/
  // module_requests writes) this call made stay exactly as they are. See
  // checkin.test.js's "signLicence throws" test.

  // EVIDENCE_RETENTION_V1 — deliberately here, not inside txn() above: see
  // pruneCheckins' own comment for why housekeeping must never be able to
  // roll back the check-in this call just committed. pruneCheckins never
  // throws on its own (internal try/catch), so this can never cost a clinic
  // its licence renewal below either.
  pruneCheckins(db);
  const eligible = isEntitled(recorded.subscription, recorded.subscriptionUntil);
  const licence = eligible && signLicence
    ? signLicence({ clinicId: recorded.clinicId, clinicName: recorded.clinicName, modules: recorded.modules })
    : null;

  return {
    licence,
    // NOT simply recorded.subscription: a clinic whose subscription column
    // still literally says 'active' but whose subscription_until has passed
    // is, from the clinic's point of view, unpaid — returning the raw column
    // value here would show the clinic "active" with no fresh licence and no
    // clue why, instead of the money wording rule 5 exists to trigger.
    subscription: eligible ? 'active' : 'unpaid',
    // STATS_V1 — resolved from the clinic's own collect_set, or the
    // code-level default (every COUNTER_NAMES) when it has never been set or
    // was hand-corrupted. See resolveCollectSet's own header.
    collect: resolveCollectSet(recorded.collectSet),
    // UPDATE_DELIVERY_V1 — already fully decided and shaped inside the
    // transaction above; returned regardless of `eligible`/licence status —
    // an unpaid clinic still deserves to know an update exists (this is a
    // software update, not a money gate).
    update: recorded.update,
  };
}
