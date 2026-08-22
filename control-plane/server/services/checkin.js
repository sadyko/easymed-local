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

function normaliseToken(token) {
  return typeof token === 'string' && token.length > 0 ? token : null;
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
 * @param {object} [hooks]
 * @param {function({clinicId:string, clinicName:string, modules:string[]}): {payload:object, sig:string}} [hooks.signLicence]
 *   Called ONLY when the clinic is currently entitled to a fresh licence
 *   (rule 5), and ONLY after the check-in below has already committed (rule
 *   2) — if it throws, the throw propagates straight to the caller, but the
 *   checkins row (and everything else this call wrote) is already durable.
 * @returns {{licence: object|null, subscription: 'active'|'unpaid', collect: string[]} | null}
 *   null means unknown, inactive, or malformed token (rule 1) — the caller
 *   (routes/checkin.js) turns that into ONE generic 401, indistinguishable
 *   from the outside. `collect` (STATS_V1) is this clinic's collect_set, or
 *   the code-level default (every COUNTER_NAMES) when it has never been set.
 */
export function checkIn(db, { installToken, version, fingerprint, moduleRequests, stats } = {}, { signLicence } = {}) {
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

  // ATOMICITY — as with enrollment.js's own transaction, this is not about
  // concurrent-request locking: better-sqlite3 is fully synchronous and Node
  // is single-threaded, so nothing else can run between any two statements
  // below regardless of this wrapper. What it buys is crash-safety and
  // all-or-nothing ordering: if the process died mid-write, the check-in is
  // either fully recorded (row + last_seen_at + leads) or not recorded at
  // all — never a checkins row with no matching last_seen_at update.
  const txn = db.transaction(() => {
    const clinic = db.prepare(
      `SELECT clinic_id, name, subscription, subscription_until, last_fingerprint, collect_set
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

    const modules = db.prepare(
      `SELECT module_key FROM clinic_modules WHERE clinic_id = ? ORDER BY module_key`
    ).all(clinic.clinic_id).map((m) => m.module_key);

    return {
      clinicId: clinic.clinic_id,
      clinicName: clinic.name,
      subscription: clinic.subscription,
      subscriptionUntil: clinic.subscription_until,
      modules,
      collectSet: clinic.collect_set,
    };
  });

  const recorded = txn();
  if (!recorded) return null;

  // Everything above this line is already committed. Nothing below can ever
  // un-record the visit — a throw from signLicence propagates straight out
  // of this function to the caller, but the checkins row (and the clinics/
  // module_requests writes) this call made stay exactly as they are. See
  // checkin.test.js's "signLicence throws" test.
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
  };
}
