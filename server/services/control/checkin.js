import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { verifyLicence } from './licence.js';
import { buildStatsPayload as defaultBuildStatsPayload } from './metrics.js';
import { assertControlUrlIsTestSafe } from './prod-guard.js';   // PROD_GUARD_V1

// LICENCE_CORE_V1 — the clinic's half of the hourly call.
//
// THE RULE THAT OUTRANKS EVERYTHING ELSE HERE: if the control plane is
// unreachable, broken, or lying, the clinic must not notice. Every clinic
// holds a licence valid for 14 more days, so even a full day of vendor
// downtime is invisible — but only if this file treats every failure (a
// timeout, a 500, an HTML error page, a licence for someone else, a licence
// signed with the wrong key, a truncated body, a gigantic body) as "try
// again next hour" and nothing else. Nothing below this comment is allowed
// to throw out of runCheckin(), overwrite a good licence with an
// unverifiable one, or leave a half-written file on disk.

const DEFAULT_ENDPOINT = 'https://settings.easymed.uz';
const CHECKIN_PATH = '/cp/v1/checkin';

// Delay chosen so a slow or dead control plane can never be blamed for a slow
// boot: the server is already listening and serving patients long before this
// ever fires.
//
// The interval itself is the owner's standing requirement for the whole
// system, not a guess: "add 1 hour synchronization period for the entire
// system, so clinic owners get data and other reports every 1 hour."
// server/services/branch-sync/relay.js (and schedule-pull.js) already poll
// hourly; this file was the one piece still left at a day, and that gap was
// not theoretical — on 2026-09-02 three released fixes did not reach any
// clinic for hours, and every symptom looked like "sync is broken" when the
// machines had simply not asked yet.
//
// What the shorter interval costs: a check-in body is install_token +
// version + a sha256 fingerprint + whatever module_requests/stats/
// update_result happen to be pending (see the fetch call in performCheckin
// below). Measured against a realistic payload — the full stats catalogue,
// no pending module request — that is ~420 bytes; with a small update_result
// attached, ~500 bytes; the bare minimum (nothing pending, empty stats) is
// ~180 bytes. Nowhere near the 1MB MAX_RESPONSE_BYTES backstop below. Going
// from 1 call/day to 24 turns "a few hundred bytes a day" into "a few
// kilobytes a day" per clinic — still nothing.
//
// What it buys: a release published to a ring reaches a clinic within the
// hour instead of within the day, and the vendor's dashboard statistics for
// a clinic are never more than an hour stale.
//
// Why the vendor server can carry it: this is a handful of clinics, not
// thousands — even at 24 check-ins/clinic/day the whole fleet is a trivial
// request rate for one small JSON endpoint. The 14-day licence validity
// remains the real safety margin against vendor downtime, and it is
// completely independent of this number: polling more often does not touch
// it either way, and polling less would only shrink it for no benefit.
const INITIAL_DELAY_MS = 60_000;
const INTERVAL_MS = 60 * 60 * 1000;
// Absolute ceiling for an EASYMED_CHECKIN_INTERVAL_MS override — see
// checkinIntervalMs()'s own comment for why this can no longer just be
// INTERVAL_MS itself now that INTERVAL_MS is an hour, not a day.
const MAX_INTERVAL_MS = 24 * 60 * 60 * 1000;

// The HTTP call itself must not hang indefinitely — a clinic PC with no
// internet must fail fast and quietly, not pile up open sockets. 15s is
// generous for a tiny JSON exchange but nowhere near "indistinguishable from
// a hang" the way an unbounded wait would be.
const TIMEOUT_MS = 15_000;

// A licence response is a few hundred bytes; a module_requests list is at
// most a handful of short strings. Node's fetch will happily buffer whatever
// a server sends, so this is the client's own backstop against a
// misbehaving or hostile endpoint answering with megabytes of data — read
// readBounded()'s own comment for how the cap is enforced without ever
// buffering past it.
const MAX_RESPONSE_BYTES = 1_000_000;

// STATS_V1 (docs/plans/2026-08-22-statistics.md) — the vendor's collect list
// is a handful of counter names, not a real dataset; a cap here is a backstop
// against a buggy or hostile control plane trying to make control_state grow
// without bound, not a real-world limit anyone should ever hit.
const MAX_COLLECT_NAMES = 50;

let _testPublicKey = null;
/**
 * Tests inject their own throwaway key, mirroring state.js's own seam of the
 * same name and for the same reason: verifyLicence() takes the key as a
 * parameter rather than reading a module-global, so whoever CALLS it needs a
 * way to override the default in tests without touching production code
 * paths. Never called in production — the compiled-in vendor key (the one
 * baked into licence.js) is what every real clinic trusts.
 */
export function __setPublicKeyForTests(key) { _testPublicKey = key; }

// TWO_OVERLAPPING_CHECKINS_V1 — the boot-time timer and the interval timer
// share this one module-level flag. In real operation they can never
// coincide (60s after boot vs. every INTERVAL_MS, an hour by default), but a
// run that somehow took longer than the interval (the TIMEOUT_MS bound above
// makes this practically impossible, but "practically" is not "provably" —
// and less so than it used to be: a clinic that has set
// EASYMED_CHECKIN_INTERVAL_MS down near the one-minute floor is only 4x
// TIMEOUT_MS away from a real overlap) must not let a second, overlapping
// run send duplicate module_requests or race two file writes against each
// other. The guard lives in the OUTER function (runCheckin),
// not inside the logic it wraps, so that a call which bails out early here
// never touches the flag that the ACTUAL in-progress call is relying on to
// reset itself in its own `finally` — see the "two overlapping check-ins"
// test for the failure this ordering avoids.
let inFlight = false;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function controlStateGet(db, key) {
  return db.prepare('SELECT value FROM control_state WHERE key = ?').get(key)?.value ?? null;
}

function controlStatePut(db, key, value) {
  db.prepare(`INSERT INTO control_state (key, value, updated_at)
              VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(key, String(value));
}

// STATS_V1 — the counter names the vendor asked for on our LAST check-in
// (learned from that response's `collect` field, see below). Read back
// defensively: a hand-edited or corrupted value here must fall back to "no
// names" rather than throw — the same fail-open rule Task 3's own attack
// list asks for on the control-plane side of this same field.
function readStoredCollectNames(db) {
  const raw = controlStateGet(db, 'stats_collect');
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((n) => typeof n === 'string').slice(0, MAX_COLLECT_NAMES);
  } catch {
    return [];
  }
}

// Temp file in the SAME directory as the target, then rename — path.dirname
// guarantees that, which is what makes the rename atomic (same filesystem,
// same volume). A crash or power cut between these two lines leaves either
// the old file (rename never happened) or the new one (rename is a single
// filesystem operation) — never a half-written licence.dat that would read
// as corrupt and lock the clinic out of its own, otherwise-healthy licence.
//
// writeFileSync/renameSync are parameters, not hardcoded calls to `fs`, so
// tests can inject a renameSync that fails for ONE specific destination
// (control.json) while the real filesystem still services licence.dat's
// write — see the "control.json unwritable" test, which is the only way to
// prove the write-ordering claim below without depending on OS-specific
// permission quirks.
// Exported for enroll.js, which writes the same two files at first enrollment —
// the same never-two-implementations rule unlock.js states for expectedResponse().
/**
 * Read a JSON file that POWERSHELL may have written — i.e. one that probably
 * starts with a UTF-8 BOM.
 *
 * The retired apply-update.ps1 wrote update-result.json through PowerShell
 * 5.1, whose Out-File/Set-Content emit a BOM by default. `JSON.parse` treats
 * that BOM as an unexpected token and THROWS, and both readers of that file
 * wrapped the parse in a try/catch that quietly turned the throw into "no
 * result".
 *
 * The damage was invisible and total: the clinic could never display the
 * outcome of its own update (neither the failure notice nor the
 * installed-pending-restart one), and — worse — checkin.js never attached an
 * update_result to its call home, so the control plane never learned whether
 * ANY update succeeded. The vendor's auto-halt (two reported failures halt a
 * release for everyone) could therefore never fire: it counts reports that
 * were never sent. Found 2026-08-24 by the smoke test that finally ran the
 * real apply script instead of a stub.
 *
 * THE WRITER IS FIXED — updater.js's writeOutcome() is Node and emits no BOM
 * (NODE_NATIVE_UPDATES_V1). Stripping on READ stays anyway, and that is the
 * whole point of this function: BOM-prefixed result files already exist on
 * clinic disks, and they must become readable the moment that clinic updates,
 * not stay lost forever because the writer was fixed afterwards.
 *
 * @returns {object|null} the parsed object, or null for missing/unreadable/
 *   non-object content. Never throws — every caller is on a path that must
 *   not be able to fail because of a status file.
 */
export function readJsonFile(file, { readFileSync = fs.readFileSync } = {}) {
  let raw;
  try { raw = readFileSync(file, 'utf8'); } catch { return null; }
  if (typeof raw !== 'string') return null;
  // ﻿ is the BOM as it appears once the bytes are decoded as UTF-8.
  const text = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch { return null; }
}
export function writeAtomic(file, content, { writeFileSync = fs.writeFileSync, renameSync = fs.renameSync } = {}) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}

/** Where the check-in call goes. Exported so the endpoint-resolution logic itself is unit-testable without a real network call. */
export function checkinUrl(env = process.env) {
  const base = String((env && env.EASYMED_CONTROL_URL) || DEFAULT_ENDPOINT).trim().replace(/\/+$/, '');
  return base + CHECKIN_PATH;
}

/**
 * How often the scheduled check-in repeats. One hour by default (see
 * INTERVAL_MS's own comment for the full reasoning — that number IS the
 * owner's standing "every clinic hears about updates and reports its
 * numbers within the hour" requirement for the whole product, not a
 * vendor-only fast path) unless EASYMED_CHECKIN_INTERVAL_MS says otherwise.
 *
 * Clamped, not trusted: a typo like "1" must not turn an hourly call into a
 * hammer on the control plane (floor: one minute, unchanged from before).
 *
 * The ceiling is now the fixed MAX_INTERVAL_MS (24h), not "the default
 * itself" as it used to be when the default was also 24h. Clamping an
 * override to the default would, now that the default is one hour, silently
 * cap EVERY override at one hour too — defeating the one legitimate reason
 * to raise it (a clinic on a metered or unreliable link that wants to poll
 * less often than the norm). 24h is still a real ceiling, not a formality:
 * it keeps the worst case an operator can configure — the override pushed
 * all the way up — comfortably inside the 14-day licence margin, and still
 * guarantees an update offer or a reported statistic is never more than a
 * day stale even for that one deliberately-slow install. Garbage falls back
 * to the default — a misspelled value must degrade to "a normal clinic",
 * never to "no check-ins at all".
 */
export function checkinIntervalMs(env = process.env) {
  const raw = env && env.EASYMED_CHECKIN_INTERVAL_MS;
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n <= 0) return INTERVAL_MS;
  return Math.min(MAX_INTERVAL_MS, Math.max(60_000, Math.floor(n)));
}

/**
 * The installed version, read from package.json rather than hardcoded so it
 * can never drift from what actually shipped. Defaulted rather than thrown —
 * mirrors server/index.js's own readAppVersion(): a version string that can't
 * be read is not worth failing (or even warning loudly during) a check-in
 * over, since it is purely informational on the vendor's side.
 */
export function readAppVersion() {
  try {
    const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'package.json');
    const v = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
    return typeof v === 'string' && v ? v : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * A machine fingerprint: hash of hostname + the first non-loopback MAC.
 *
 * hostname/interfaces are injectable (default to the real os.* calls) purely
 * for deterministic tests — os.networkInterfaces() cannot be made to return
 * a fixed answer otherwise.
 *
 * Interface NAMES are sorted before picking one, so re-enumeration on a
 * plain reboot (same adapters, same names, whatever order the OS happens to
 * report them in that boot) cannot change the answer. This does NOT make the
 * fingerprint immune to a genuine hardware change — docking a laptop and
 * gaining a new adapter whose name sorts alphabetically ahead of the
 * existing one WILL change the fingerprint, because a real new MAC is now
 * the "first" one. That is accepted, not fixed, because checkin.js's own
 * contract (mirroring control-plane/server/services/checkin.js's rule 4)
 * treats a fingerprint change as evidence only, never a lock — see this
 * file's KNOWN LIMITATION test and the task report for the reasoning.
 */
export function computeFingerprint({ hostname = os.hostname(), interfaces = os.networkInterfaces() } = {}) {
  let mac = '';
  for (const name of Object.keys(interfaces || {}).sort()) {
    for (const iface of interfaces[name] || []) {
      if (iface && !iface.internal && iface.mac && iface.mac !== '00:00:00:00:00:00') {
        mac = iface.mac;
        break;
      }
    }
    if (mac) break;
  }
  return createHash('sha256').update(`${hostname}|${mac}`).digest('hex');
}

// Reads a fetch Response body up to maxBytes, THEN stops — never buffers a
// gigantic or endless body into memory just to throw it away afterwards. Node's
// fetch (undici) exposes res.body as a WHATWG ReadableStream; reading it
// chunk-by-chunk and cancelling once the cap is crossed is what makes the
// bound real rather than cosmetic (a plain `await res.text()` would already
// have paid the memory cost by the time any length check could run).
// Exported for enroll.js: an enrollment response comes from the same endpoint
// class as a check-in response and deserves the same bound.
export async function readBounded(res, maxBytes) {
  const reader = res.body && typeof res.body.getReader === 'function' ? res.body.getReader() : null;
  if (!reader) {
    // Some fetch implementations may not expose a streamable body; fall back
    // to reading it whole and checking size after the fact rather than
    // refusing to function at all. Never reachable against Node's own fetch.
    const text = await res.text();
    return Buffer.byteLength(text, 'utf8') > maxBytes ? null : text;
  }
  let total = 0;
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* best-effort — we are discarding this response anyway */ }
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * One check-in attempt. Never throws — every failure path logs a warning and
 * returns, leaving licence.dat, control.json and module_requests exactly as
 * they were. See this file's header for why that guarantee is the entire
 * point of the feature.
 *
 * @param {Database} db
 * @param {string} dataDir
 * @param {object} [opts]
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {string} [opts.endpoint]        override for the control-plane BASE url (tests point this at a fake server)
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.maxResponseBytes]
 * @param {Function} [opts.writeFileSync] override for atomic-write testing
 * @param {Function} [opts.renameSync]    override for atomic-write testing
 * @param {typeof import('./metrics.js').buildStatsPayload} [opts.buildStatsPayload] override for tests that force the catalogue to throw
 */
export async function runCheckin(db, dataDir, opts = {}) {
  if (inFlight) return; // see TWO_OVERLAPPING_CHECKINS_V1 above
  inFlight = true;
  try {
    await performCheckin(db, dataDir, opts);
  } finally {
    inFlight = false;
  }
}

async function performCheckin(db, dataDir, {
  fetchImpl = globalThis.fetch,
  endpoint,
  timeoutMs = TIMEOUT_MS,
  maxResponseBytes = MAX_RESPONSE_BYTES,
  writeFileSync,
  renameSync,
  buildStatsPayload = defaultBuildStatsPayload,
} = {}) {
  try {
    const identityPath = path.join(dataDir, 'control.json');
    const identity = readJson(identityPath);

    // RULE — no token, no call. This install was licensed by hand and must
    // keep working exactly as it does today; nothing here may change that.
    const token = identity && typeof identity === 'object' && !Array.isArray(identity)
      && typeof identity.install_token === 'string' && identity.install_token
      ? identity.install_token
      : null;
    if (!token) return;

    const pending = db.prepare(
      'SELECT id, module_key, requested_at FROM module_requests WHERE sent_at IS NULL ORDER BY id',
    ).all();

    // STATS_NEVER_BLOCKS_CHECKIN_V1 — "licensing outranks telemetry,
    // everywhere" (docs/plans/2026-08-22-statistics.md). buildStatsPayload is
    // documented to never throw on its own (see metrics.js), but this call
    // site does not get to trust that promise forever: the names collected
    // here were learned from a PREVIOUS response and could, in principle,
    // point at a counter whose query was broken by a later schema change.
    // Wrapping it is the same "backstop a guarantee, don't just assume it"
    // idiom verifyLicence's own try/catch below already uses. Building this
    // BEFORE the network call (not after) is deliberate too: a slow or
    // throwing builder must never delay or skip the call that renews the
    // licence, so it either succeeds fast or falls back to {} immediately.
    let stats;
    try {
      stats = buildStatsPayload(db, readStoredCollectNames(db));
    } catch (e) {
      console.warn('[checkin] could not build the stats payload, sending none this time:', e && e.message);
      stats = {};
    }

    // UPDATE_DELIVERY_V1 — updater.js's applyUpdate() writes this file in
    // EVERY outcome after its own attempt. Read here, BEFORE the network
    // call, so a report sits ready to attach the moment a token exists;
    // renamed to .sent only once the vendor has actually answered (see
    // below) — never here, and never on a read failure, so a result that
    // hasn't reached the vendor yet is never lost to a corrupt or racing
    // read.
    const updateResultPath = path.join(dataDir, 'update-result.json');
    // readJsonFile, not a bare JSON.parse: the PowerShell apply this replaced
    // wrote the file with a BOM, which made every parse throw and silently
    // reported 'no outcome' to the vendor forever. Those files still exist on
    // clinic disks — see readJsonFile's own comment.
    const updateResult = readJsonFile(updateResultPath);

    if (!endpoint) assertControlUrlIsTestSafe(process.env, fetchImpl);   // PROD_GUARD_V1
    const url = endpoint ? String(endpoint).replace(/\/+$/, '') + CHECKIN_PATH : checkinUrl();

    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          install_token: token,
          version: readAppVersion(),
          fingerprint: computeFingerprint(),
          module_requests: pending.map((r) => ({ module_key: r.module_key, requested_at: r.requested_at })),
          stats,
          ...(updateResult ? { update_result: updateResult } : {}),
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      // Connection refused, DNS failure, timeout — all land here. Exactly the
      // "vendor is unreachable" case the whole file exists for.
      console.warn('[checkin] could not reach the control plane, will retry next hour:', e && e.message);
      return;
    }

    // UPDATE_DELIVERY_V1 — the instant res.ok is true, the control plane's own
    // checkIn() has ALREADY recorded update_result inside its own transaction
    // (control-plane/server/services/checkin.js) — whatever happens to THIS
    // client's own parsing of the response body from here on cannot change
    // that fact. So the rename — "sent exactly once" — happens right here,
    // not after the response body is parsed: waiting would mean a client-side
    // JSON hiccup AFTER a successful send could re-send a report the vendor
    // already has, which is the exact double-report this file-rename exists
    // to prevent. A rename is a single filesystem operation, so a crash
    // between "vendor answered 2xx" and "file renamed" is the only window
    // that could ever cause a duplicate — accepted as unavoidable, the same
    // way writeAtomic's own tmp-then-rename accepts a crash between its two
    // lines (see that function's comment).
    if (updateResult && res.ok) {
      try {
        fs.renameSync(updateResultPath, updateResultPath + '.sent');
      } catch (e) {
        console.warn('[checkin] could not rename update-result.json after sending it:', e && e.message);
      }
    }

    if (!res.ok) {
      console.warn('[checkin] control plane responded with status', res.status);
      return;
    }

    const text = await readBounded(res, maxResponseBytes);
    if (text === null) {
      console.warn('[checkin] response exceeded the size bound — discarded');
      return;
    }

    let body;
    try {
      body = JSON.parse(text);
    } catch {
      console.warn('[checkin] response was not valid JSON — discarded');
      return;
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      console.warn('[checkin] response was not a JSON object — discarded');
      return;
    }

    // STATS_V1 — remember which counters the vendor wants NEXT time, so the
    // check-in after this one can build and send them (see the DI-wrapped
    // buildStatsPayload call above, which reads this same control_state key
    // back). Validated before it ever touches disk: only a real array is
    // accepted at all (a missing or wrong-shaped `collect` leaves whatever
    // was already learned untouched, never overwritten with garbage), and
    // within that array only strings survive, capped at MAX_COLLECT_NAMES —
    // this is the clinic's own defence against a compromised or buggy panel,
    // on top of buildStatsPayload's own re-check of every name against the
    // real catalogue at build time.
    if (Array.isArray(body.collect)) {
      const names = body.collect.filter((n) => typeof n === 'string').slice(0, MAX_COLLECT_NAMES);
      try {
        controlStatePut(db, 'stats_collect', JSON.stringify(names));
      } catch (e) {
        console.warn('[checkin] could not store the collect set:', e && e.message);
      }
    }

    // UPDATE_DELIVERY_V1 — persist the offer exactly as the control plane sent
    // it; updater.js (the actual download/verify/stage pipeline) and
    // updates.js (the approval RPCs) are the only things that ever interpret
    // it. Distinguishes an ABSENT `update` key (an older or misbehaving
    // control plane that never mentions the field at all — leave whatever
    // was already stored alone, back-compat) from an EXPLICIT `null` (this
    // clinic is offered nothing right now — e.g. already on the newest
    // version, or the release was halted — which must clear a stale offer,
    // not leave one sitting there forever looking current). A malformed,
    // non-null value (wrong shape, no version string) is neither: it is
    // logged and ignored, keeping whatever offer was already on file rather
    // than overwriting a good one with garbage.
    if ('update' in body) {
      if (body.update === null) {
        try {
          db.prepare(`DELETE FROM control_state WHERE key = 'update_offer'`).run();
        } catch (e) {
          console.warn('[checkin] could not clear the stored update offer:', e && e.message);
        }
      } else if (
        body.update && typeof body.update === 'object' && !Array.isArray(body.update)
        && typeof body.update.version === 'string' && body.update.version
      ) {
        try {
          controlStatePut(db, 'update_offer', JSON.stringify(body.update));
        } catch (e) {
          console.warn('[checkin] could not store the update offer:', e && e.message);
        }
      } else {
        console.warn('[checkin] update field was malformed — ignored, keeping any previously stored offer');
      }
    }

    // ORDER MATTERS — licence.dat is written BEFORE control.json. If the
    // control.json write below fails (disk full, permissions), the
    // functionally important half — the renewed licence, the actual thing
    // that keeps the clinic unlocked — has already landed safely. A stale
    // subscription WORD (money vs. offline wording) is a cosmetic gap that
    // heals on the next successful check-in; a lost licence renewal is not.
    if (body.licence) {
      let verified;
      try {
        verified = verifyLicence(JSON.stringify(body.licence), {
          publicKey: _testPublicKey,
          clinicId: identity.clinic_id,
        });
      } catch {
        // verifyLicence is documented never to throw; this is a backstop for
        // that guarantee changing out from under this call site someday, not
        // a path expected to ever run.
        verified = { ok: false, reason: 'malformed' };
      }
      if (verified.ok) {
        try {
          writeAtomic(path.join(dataDir, 'licence.dat'), JSON.stringify(body.licence), { writeFileSync, renameSync });
        } catch (e) {
          console.warn('[checkin] could not write licence.dat:', e && e.message);
        }
      } else {
        // NEVER overwrite a good licence with an unverifiable one — the
        // existing licence.dat, if any, is left completely untouched.
        console.warn('[checkin] discarded an unverifiable licence:', verified.reason);
      }
    }

    // The vendor recorded these leads inside its own transaction the moment
    // the HTTP call succeeded (control-plane/server/services/checkin.js),
    // independent of whether a licence came back — so they are marked
    // delivered here regardless of the licence-verification outcome above.
    if (pending.length) {
      try {
        const sentAt = new Date().toISOString();
        const mark = db.prepare('UPDATE module_requests SET sent_at = ? WHERE id = ?');
        db.transaction((rows) => { for (const row of rows) mark.run(sentAt, row.id); })(pending);
      } catch (e) {
        console.warn('[checkin] could not mark module_requests as sent:', e && e.message);
      }
    }

    if (typeof body.subscription === 'string' && body.subscription) {
      try {
        writeAtomic(identityPath, JSON.stringify({ ...identity, subscription: body.subscription }), { writeFileSync, renameSync });
      } catch (e) {
        console.warn('[checkin] could not store the reported subscription:', e && e.message);
      }
    }

    try {
      controlStatePut(db, 'last_checkin_at', new Date().toISOString());
    } catch (e) {
      console.warn('[checkin] could not record the last check-in time:', e && e.message);
    }
  } catch (e) {
    // Backstop. Every meaningful step above already has its own guard; this
    // exists so that something unforeseen still resolves to "try again next
    // hour" rather than an uncaught exception reaching the caller.
    console.warn('[checkin] unexpected error, treating as "try again next hour":', e && e.message);
  }
}

/**
 * Wires the check-in into the running process. Fires once ~60s after boot
 * (so it can never slow startup or delay listen()) and then every hour by
 * default — or every EASYMED_CHECKIN_INTERVAL_MS (60s floor, 24h ceiling),
 * see checkinIntervalMs() above.
 * .unref() on both timers so neither can hold the process open — a clinic
 * shutting down must not wait on a licensing timer that has nothing urgent
 * to do.
 */
export function scheduleCheckin(db, dataDir, opts = {}) {
  const { initialDelayMs = INITIAL_DELAY_MS, intervalMs = checkinIntervalMs(), ...runOpts } = opts;
  const run = () => {
    // runCheckin() is documented never to reject, but a scheduled timer
    // callback has no caller to hand a rejection to anyway — an uncaught
    // rejection here would surface as a process-level warning at best and a
    // crash at worst, neither of which this feature is allowed to cause.
    runCheckin(db, dataDir, runOpts).catch((e) => console.warn('[checkin] scheduled run failed:', e && e.message));
  };
  const initial = setTimeout(run, initialDelayMs);
  initial.unref();
  const interval = setInterval(run, intervalMs);
  interval.unref();
  return { initial, interval };
}
