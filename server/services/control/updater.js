import fs from 'node:fs';
import path from 'node:path';
import { createHash, createPublicKey } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// NOT from scripts/build-bundle.mjs — scripts/ is not on that file's own
// ALLOWLIST, so importing it here meant an unpacked release bundle died with
// ERR_MODULE_NOT_FOUND before the server ever bound its port. See bundle.js.
import { verifyBundle, tarCommand, compareVersions } from './bundle.js';
import { readAppVersion, readJsonFile, writeAtomic } from './checkin.js';
import { assertControlUrlIsTestSafe } from './prod-guard.js';   // PROD_GUARD_V1
// The ONE WAL-safe snapshot implementation, reused rather than copied — a
// second one would drift, and the whole rollback story rests on this being
// db.backup() and never fs.copyFileSync (see db/backup.js's own header).
import { backupBeforeMigrate } from '../../db/backup.js';
import { nextRunAt, isInWindow, consentAppliesTo } from './update-schedule.js';
// UPDATE_PROGRESS_V1 — the "what is it doing right now" record. Its writes are
// all best-effort by construction; see that file's header.
import { makeProgressReporter, reconcileProgressAtBoot } from './update-progress.js';

// UPDATE_DELIVERY_V1 (docs/plans/2026-08-20-update-delivery.md, Task 4) — the
// clinic's own machine: check the stored offer, confirm it is still
// consented to, and — only inside the clinic's chosen hour — download,
// verify, stage and apply it, all in this process (NODE_NATIVE_UPDATES_V1,
// docs/plans/2026-08-24-node-native-updates.md — see applyUpdate below).
//
// THE RULE THAT OUTRANKS EVERYTHING BELOW, same as checkin.js's own header:
// nothing here may harm the RUNNING clinic. Every network error, every disk
// error, every refused bundle is "try again tomorrow" — logged, never
// thrown, never staged, never applied. tickUpdater() must be safe to call
// once a minute, forever, against a clinic that never approves anything.

// ---------------------------------------------------------------------------
// The release public key — a SEPARATE keypair from the licence key
// (server/services/control/licence.js), by design: see build-bundle.mjs's own
// header for why leaking this one only lets someone forge an UPDATE, not mint
// a licence.
//
// ############################################################################
// ##  PRODUCTION RELEASE KEY — this is what every clinic verifies against.  ##
// ############################################################################
// The private half lives ONLY in the EASYMED_RELEASE_KEY GitHub Actions secret
// (plus the owner's offline backup in Documents/easymed-keys) — never in this
// repo. Replacing this PEM orphans every already-shipped install: their
// compiled-in copy stops accepting new bundles, so a key rotation must ship AS
// an update signed by the old key first. Proven against v0.1.1's CI-built
// manifest on 2026-08-22.
const RELEASE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAjCh/fDySue8xTrMIdwxu4YoXV9qkmbDSpCM7BJdc+70=
-----END PUBLIC KEY-----`;

let _defaultReleaseKey = null;
function defaultReleaseKey() {
  if (!_defaultReleaseKey) _defaultReleaseKey = createPublicKey(RELEASE_PUBLIC_KEY_PEM);
  return _defaultReleaseKey;
}

let _testReleasePublicKey = null;
/**
 * Tests inject their own throwaway key, mirroring checkin.js's
 * __setPublicKeyForTests and licence.test.js's own seam. Never called in
 * production — the compiled-in key above is what every real clinic trusts.
 */
export function __setReleasePublicKeyForTests(key) { _testReleasePublicKey = key; }

function releasePublicKey() { return _testReleasePublicKey || defaultReleaseKey(); }

// ---------------------------------------------------------------------------
// Sizing and timeouts.
// ---------------------------------------------------------------------------

// A whole application bundle (server + public + node_modules), not a JSON
// reply — 100 MB is generous for this project's dependency footprint (three
// runtime deps) while still being a hard backstop against a compromised or
// merely broken control plane trying to make a clinic download something
// unbounded overnight.
const MAX_BUNDLE_BYTES = 100 * 1024 * 1024;

// Unlike checkin.js's 15s (a few hundred bytes), this is up to 100MB over
// whatever connection a clinic happens to have at 3am with nobody waiting on
// it — generous on purpose. Still finite: a hung connection must eventually
// free the socket rather than pile up forever next to a dead control plane.
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

// Fixed names, not per-attempt-unique (unlike checkin.js's writeAtomic temp
// files, which use a random suffix because collisions between concurrent
// writers matter there). Here the opposite property matters: every attempt
// reuses the SAME path, so a failed download's leftovers are simply
// overwritten by the next attempt rather than accumulating a new file every
// night the control plane is unreachable — this file's own "attack your own
// code" report addresses this directly.
const TEMP_TAR_NAME = 'update-download.tmp';
const TEMP_MANIFEST_NAME = 'update-manifest.tmp.json';

function controlStateGet(db, key) {
  return db.prepare('SELECT value FROM control_state WHERE key = ?').get(key)?.value ?? null;
}
function controlStatePut(db, key, value) {
  db.prepare(`INSERT INTO control_state (key, value, updated_at)
              VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(key, String(value));
}

function controlStateDel(db, key) {
  db.prepare('DELETE FROM control_state WHERE key = ?').run(key);
}

function readJsonState(db, key) {
  const raw = controlStateGet(db, key);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function readScheduledAt(db) {
  const raw = controlStateGet(db, 'update_scheduled_at');
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}
function putScheduledAt(db, date) {
  controlStatePut(db, 'update_scheduled_at', date.toISOString());
}

/** Where the daily call's base URL is, same default and same env var as checkin.js. */
function controlBaseUrl(env = process.env) {
  return String((env && env.EASYMED_CONTROL_URL) || 'https://settings.easymed.uz').trim().replace(/\/+$/, '');
}

// ---------------------------------------------------------------------------
// Cross-host refusal.
//
// A compromised (or merely buggy) registry offering `offer.url` must not be
// able to point a clinic at an ATTACKER'S host. verifyBundle's signature
// check protects the CONTENT of whatever gets downloaded, but says nothing
// about WHO the clinic downloaded it from or how much it downloaded getting
// there — a malicious absolute URL could still exhaust bandwidth, probe an
// internal network address, or serve an oversized body from a host the
// clinic was never supposed to talk to, all before the signature check ever
// runs. This is checked BEFORE any network call is made.
// ---------------------------------------------------------------------------

/**
 * Resolve `offer.url` against the control-plane base, refusing anything that
 * would leave that origin.
 *
 * A relative URL ("/releases/2.4.0/x.tar.gz") always resolves safely against
 * base. An ABSOLUTE URL is only accepted if its origin (scheme+host+port)
 * matches base's origin EXACTLY — the WHATWG URL constructor otherwise
 * ignores `base` entirely for an absolute input and just returns the input
 * verbatim, which is precisely the trap this function exists to close.
 */
export function resolveDownloadUrl(offerUrl, baseUrl) {
  if (typeof offerUrl !== 'string' || !offerUrl) return { ok: false, reason: 'missing_url' };

  let base;
  try {
    base = new URL(baseUrl);
  } catch {
    return { ok: false, reason: 'bad_base' };
  }

  // Detect whether offerUrl is itself absolute BEFORE resolving it against
  // base — `new URL(x, base)` silently discards `base` when `x` already has
  // its own scheme, so checking that case has to happen on `x` alone.
  let isAbsolute = true;
  try {
    // eslint-disable-next-line no-new
    new URL(offerUrl);
  } catch {
    isAbsolute = false;
  }

  let resolved;
  try {
    resolved = new URL(offerUrl, base);
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  if (isAbsolute && resolved.origin !== base.origin) {
    return { ok: false, reason: 'cross_host' };
  }
  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
    return { ok: false, reason: 'bad_protocol' };
  }
  return { ok: true, url: resolved.toString() };
}

// ---------------------------------------------------------------------------
// Streamed, size-capped download.
//
// Same shape as checkin.js's readBounded: read chunk by chunk, count bytes as
// they arrive, and cancel the instant the cap is crossed — never buffer (or,
// here, write to disk) past the bound just to discard it afterwards. The
// running sha256 is computed for free while streaming (nothing here trusts
// it over verifyBundle's own re-hash-from-disk — that stays the single
// source of truth for the security decision) and is returned only for
// logging.
// ---------------------------------------------------------------------------

async function downloadToFile(url, destPath, { fetchImpl = globalThis.fetch, maxBytes = MAX_BUNDLE_BYTES, timeoutMs = DOWNLOAD_TIMEOUT_MS, onProgress = null } = {}) {
  let res;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    return { ok: false, reason: 'network', detail: e && e.message };
  }
  if (!res.ok) return { ok: false, reason: 'http_status', status: res.status };

  // UPDATE_PROGRESS_V1 — the whole size, when the server bothers to declare
  // one. Content-Length is OPTIONAL: a chunked response, or one gzipped on
  // the fly, carries none. `expected` then stays null and the screen says
  // "downloaded N MB" instead of a percentage of an unknown whole — never a
  // bar that pretends to know where it is.
  let expected = null;
  try {
    const raw = res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : null;
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) expected = n;
  } catch { /* a header bag that misbehaves simply means an unknown size */ }

  const reader = res.body && typeof res.body.getReader === 'function' ? res.body.getReader() : null;
  if (!reader) return { ok: false, reason: 'no_body' };

  // Reporting must never break the download it describes (update-progress.js's
  // header rule). Swallowed HERE as well as inside the reporter, because
  // onProgress is an injected callback and this loop cannot know what a
  // caller put in it.
  const report = (received, force) => {
    if (!onProgress) return;
    try { onProgress(received, expected, { force }); } catch { /* progress is never worth a failed update */ }
  };

  const hash = createHash('sha256');
  let total = 0;
  let fd;
  try {
    fd = fs.openSync(destPath, 'w');
  } catch (e) {
    return { ok: false, reason: 'disk', detail: e && e.message };
  }
  try {
    // "0 of 45 MB" the instant the connection opens — the screen must not sit
    // empty while a slow first chunk is on its way.
    report(0, true);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* best-effort — discarding this response anyway */ }
        return { ok: false, reason: 'too_large' };
      }
      hash.update(value);
      fs.writeSync(fd, value);
      // Throttled on the reporter's side, not here: this loop runs once per
      // chunk and must stay a counter increment plus a cheap clock read.
      report(total, false);
    }
  } catch (e) {
    return { ok: false, reason: 'stream_error', detail: e && e.message };
  } finally {
    try { fs.closeSync(fd); } catch { /* already closed or never opened successfully */ }
  }
  // Forced past the throttle: without it the record's last word on a finished
  // download is whatever it happened to say up to two seconds before the end.
  report(total, true);
  return { ok: true, bytes: total, sha256: hash.digest('hex') };
}

// ---------------------------------------------------------------------------
// Layout detection — mirrors server/index.js's own junction/realpath logic
// (see that file's SUPERVISED_INSTALL_V1 comment) rather than reinventing a
// second way to answer "am I the versioned service, or a plain checkout?".
//
// Under the versioned layout, `appRoot` (Node's ESM loader already resolved
// import.meta.url THROUGH the `current` junction, exactly as index.js's own
// ROOT does) is `<root>\versions\<runningVersion>`. Detected by CONFIRMING —
// not assuming from the directory name alone — that `<root>\current` is a
// junction whose real target IS appRoot. A directory that merely happens to
// sit two levels under a folder named "versions" (a coincidence, or a dev
// checkout cloned into an oddly-named path) must not be mistaken for the
// genuine, versioned install: staging into a plain checkout's sibling folders
// would be inert, but the WORSE mistake this guards against is ever deciding
// "versioned" when it is not, which is what gates whether applyUpdate() gets
// to repoint anything at all.
// ---------------------------------------------------------------------------

export function detectLayout(appRoot, { realpathSync = fs.realpathSync } = {}) {
  const resolvedAppRoot = path.resolve(appRoot);
  const versionsDir = path.dirname(resolvedAppRoot);
  if (path.basename(versionsDir) !== 'versions') return { versioned: false, root: null };
  const root = path.dirname(versionsDir);
  const currentLink = path.join(root, 'current');
  let real;
  try {
    real = realpathSync(currentLink);
  } catch {
    return { versioned: false, root: null };
  }
  if (path.resolve(real) !== resolvedAppRoot) return { versioned: false, root: null };
  return { versioned: true, root };
}

// This module's own app root, computed the SAME way server/index.js computes
// its ROOT constant (dirname(dirname(url))) — just from four directories
// deeper, since this file lives at server/services/control/ rather than
// server/. Used only as the DEFAULT; server/index.js's timer wiring passes
// its own ROOT explicitly instead, so the two can never disagree.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_APP_ROOT = path.resolve(HERE, '..', '..', '..');

// ---------------------------------------------------------------------------
// TWO_TICKS_ONE_WINDOW_V1 — the minute-granularity timer versus the
// hour-wide window. Mirrors checkin.js's own TWO_OVERLAPPING_CHECKINS_V1
// exactly, including WHERE the guard lives: in the OUTER function
// (tickUpdater), never inside performTick. A guard placed inside performTick
// would still let a second call that arrives while the first is still
// running (a slow download) start its own pipeline the instant the first one
// happened to be between two `await`s — the outer wrapper is what actually
// closes that window, because performTick's own internal early-returns
// (nothing due, already attempted) run to completion synchronously before
// the first `await` and can never be pre-empted.
// ---------------------------------------------------------------------------
let inFlight = false;

/**
 * Called from a minute-granularity timer. Never throws.
 *
 * @param {Database} db
 * @param {string} dataDir
 * @param {object} [opts]
 */
export async function tickUpdater(db, dataDir, opts = {}) {
  if (inFlight) return;
  inFlight = true;
  try {
    await performTick(db, dataDir, opts);
  } finally {
    inFlight = false;
  }
}

async function performTick(db, dataDir, {
  fetchImpl = globalThis.fetch,
  execFileSyncImpl = execFileSync,
  mkdirSync = fs.mkdirSync,
  rmSync = fs.rmSync,
  writeFileSync = fs.writeFileSync,
  realpathSync = fs.realpathSync,
  now = () => new Date(),
  endpoint,
  publicKey,
  appRoot = DEFAULT_APP_ROOT,
  // Injectable for the same reason staleAfterSwitch's is: readAppVersion()
  // reads package.json off disk, so a test cannot describe an install other
  // than the checkout it runs inside. (setAppVersion() sets a DIFFERENT value —
  // config.js's — and using it here would silently never match.)
  runningVersion = readAppVersion(),
  // Passed through to applyUpdate, which ends a successful install with
  // exit(75) so the launcher relaunches on the new version. Injectable for the
  // same reason scheduleUpdater's own exitImpl is: a test must be able to
  // observe "it asked for a restart" without taking the test runner down.
  exitImpl,
  timeoutMs = DOWNLOAD_TIMEOUT_MS,
  maxBytes = MAX_BUNDLE_BYTES,
} = {}) {
  try {
    const offer = readJsonState(db, 'update_offer');
    if (!offer) return; // nothing offered — nothing to do, ever

    const consent = readJsonState(db, 'update_consent');
    // NEVER ACT WITHOUT CONSENT, and consent NAMES A VERSION: an approval for
    // a release the vendor has since replaced is not an approval for the new
    // one. Both "no approval at all" and "approval for a superseded version"
    // land here, identically — do nothing, forever, until an admin approves
    // THIS offer.
    if (!consentAppliesTo(offer, consent)) return;

    // A consent for the version ALREADY RUNNING is spent — clear it.
    //
    // It survives a successful install (nothing deletes it on the way to
    // exit 75), so the next boot found consent + a not-yet-cleared offer for
    // the version now running, walked all the way to the staging guard and
    // logged «refusing to stage over the currently running version — will
    // retry tomorrow» on a clinic that was already up to date. Harmless — the
    // guard is exactly right — but it reads as a failure to the owner, who
    // reported it as one (2026-08-29). Clearing it here also stops a stale
    // approval from outliving the update it was given for.
    if (offer.version === runningVersion) {
      controlStateDel(db, 'update_consent');
      controlStateDel(db, 'update_scheduled_at');
      return;
    }

    const nowDate = now();
    let scheduledAt = readScheduledAt(db);
    if (!scheduledAt) {
      // Bootstrap: consent exists but no schedule was ever recorded for it
      // (should not happen via the RPC path, which always sets both
      // together — this is a backstop for a hand-edited or corrupted
      // control_state row, not a path this project's own UI can reach).
      scheduledAt = nextRunAt(consent.hour, nowDate);
      putScheduledAt(db, scheduledAt);
    }

    if (nowDate.getTime() < scheduledAt.getTime()) return; // not due yet

    if (!isInWindow(scheduledAt, nowDate)) {
      // MISSED WINDOW RULE — the PC was off, asleep, or this process simply
      // wasn't running at the chosen hour. The fix is never "run it now,
      // whatever time it is" (that could be 09:15 with a full waiting
      // room) — it is: compute the NEXT occurrence of the same hour and
      // wait for that, exactly like a fresh approval would.
      putScheduledAt(db, nextRunAt(consent.hour, nowDate));
      return;
    }

    // TWO_TICKS_ONE_WINDOW_V1 — even with the outer re-entrancy guard above,
    // a tick a minute after a FINISHED (not still-running) attempt would
    // otherwise start a second one, same window. One attempt per scheduled
    // instant: mark it BEFORE running anything, so a crash mid-pipeline
    // still counts as "attempted" rather than hot-looping retries every
    // minute for the rest of the hour — a failure here waits for tomorrow,
    // same as every other failure in this file.
    const attemptKey = scheduledAt.toISOString();
    if (controlStateGet(db, 'update_attempted_for') === attemptKey) return;
    controlStatePut(db, 'update_attempted_for', attemptKey);

    await runPipeline(db, dataDir, offer, {
      fetchImpl, execFileSyncImpl, mkdirSync, rmSync, writeFileSync, realpathSync,
      endpoint, publicKey, appRoot, exitImpl, now, timeoutMs, maxBytes,
    });
  } catch (e) {
    // Backstop — every step below has its own guard, but nothing may ever
    // escape performTick as an uncaught rejection. "Try again tomorrow."
    console.warn('[updater] unexpected error, treating as "try again tomorrow":', e && e.message);
  }
}

// ---------------------------------------------------------------------------
// NODE_NATIVE_UPDATES_V1 (docs/plans/2026-08-24-node-native-updates.md) — the
// apply step, in this process, with no PowerShell anywhere.
//
// WHAT IT REPLACES, AND WHY. The apply used to spawn install/apply-update.ps1,
// which called install/switch-version.ps1. Every defect that made updating
// painful lived in that layer and only there:
//   1. the apply step never ran — `detached: true` gives a Windows console
//      app no console, so powershell.exe died at startup, silently;
//   2. the wrong port was health-checked — a script argument nobody passed;
//   3. a healthy clinic read as down — `localhost` resolving to ::1 inside a
//      child PowerShell, which then ate the whole timeout;
//   4. the outcome file was unreadable — PowerShell 5.1 writes a UTF-8 BOM,
//      JSON.parse throws on it, so the vendor's two-failure auto-halt was
//      counting reports that were never sent.
// None of those failure modes exist in Node. The finding that made the swap
// possible at all: Node creates and repoints a Windows junction with NO
// elevation — fs.symlinkSync(target, link, 'junction') — verified on the
// owner's machine before the plan was written. Elevation was the ONLY reason
// PowerShell was ever involved in the switch.
//
// The sibling product (symptex local/server/services/updates.js) has shipped
// 49 releases on exactly this shape — download, verify, back up, unpack,
// restart — against 6 releases here, four of which needed a human mid-flight.
//
// LESSONS KEPT FROM THE DELETED SCRIPTS, because they were bought with real
// incidents rather than reasoning:
//   - removing `current` removes the LINK, never the directory it points at.
//     install-service.ps1's Set-CurrentJunction carried this warning about
//     Remove-Item; apply-update.test.js now asserts it, because getting it
//     wrong deletes a clinic's application instead of a shortcut to it.
//   - refuse when `current` is a REAL directory rather than a link: that is a
//     botched manual install or a copy-paste that flattened the junction, and
//     repointing it would mean deleting a folder that might BE the running
//     version (Get-CurrentVersionInfo's own refusal, kept verbatim in spirit).
//   - refuse to touch the version that is currently running.
//   - snapshot the database FIRST — the new version's migrations run at its
//     next boot, and a migration is the one part of an update that can hurt
//     data.
//   - write the outcome in EVERY path, including the failures: a vendor's
//     auto-halt cannot count a failure it never saw.
//
// WHAT WAS DELIBERATELY NOT KEPT: the post-switch health check and automatic
// rollback. On a launcher install it polled the OLD process — which was still
// answering, because there is no service to stop — so it vouched for switches
// it had never verified. Theatre, not protection. Its replacement is
// install/recover.cmd, shipped in the clinic package root: a double-click that
// repoints `current` back at the previous version, which is still on disk.
// ---------------------------------------------------------------------------

// A junction on Windows (no elevation, and the same kind the launcher's own
// EnsureCurrent creates with `mklink /J`); a directory symlink everywhere
// else, purely so this step is testable on Linux CI. That portability IS the
// point of the change: for four releases the apply step could only be
// exercised on a Windows desktop, so nothing caught that it never ran.
const CURRENT_LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir';

/**
 * The outcome file — the clinic's only record of what its own update did, and
 * the only thing the vendor's two-failure auto-halt can ever count.
 *
 * Written as plain JSON from Node, which is the whole fix for defect 4 above.
 * checkin.js still STRIPS a BOM on read, deliberately: files written by the
 * retired PowerShell script already sit on clinic disks and must become
 * readable the moment the clinic updates. Nothing writes one any more.
 *
 * Shape unchanged from Write-UpdateOutcome — {version, from, ok, db, at,
 * detail} — because checkin.js, rpc/updates.js and the updates screen all
 * already read exactly this.
 */
function writeOutcome(dataDir, outcome) {
  // Printed FIRST, one grep-able line: apply-update.ps1's rule, kept. If the
  // file write below fails (a disk that has just absorbed a multi-MB unpack is
  // a plausible place to run out), the outcome must still exist SOMEWHERE.
  console.log('UPDATE_RESULT ' + JSON.stringify(outcome));
  try {
    // writeAtomic, not writeFileSync: a power cut mid-write must leave either
    // the old file or the new one, never a half-written outcome that reads as
    // "no result" — the same tmp-then-rename checkin.js uses for licence.dat.
    // Pretty-printed because a clinic manager may well open it in Notepad.
    writeAtomic(path.join(dataDir, 'update-result.json'), JSON.stringify(outcome, null, 2) + '\n');
  } catch (e) {
    console.warn('[updater] could not write update-result.json (the UPDATE_RESULT line above is the record):', e && e.message);
  }
}

/**
 * Apply a version that is ALREADY staged at <root>/versions/<version>:
 * snapshot the database, repoint `current`, record the outcome, restart.
 *
 * Never throws. Every failure leaves the clinic running the OLD version and
 * writes ok:false with the reason — "nothing here may harm the RUNNING
 * clinic" is this file's header rule and it applies hardest right here.
 *
 * @param {Database} db        the open connection, for the WAL-safe snapshot
 * @param {string} dataDir     where easymed.db, backups/ and the outcome live
 * @param {object} opts
 * @param {string} opts.root      the install root (holds versions/ and current)
 * @param {string} opts.version   the staged version to switch to
 * @returns {Promise<{ok: boolean, from: string|null, detail: string}>}
 */
export async function applyUpdate(db, dataDir, opts = {}) {
  const { version, exitImpl = (code) => process.exit(code), now = () => new Date() } = opts;
  let result;
  try {
    result = await performApply(db, dataDir, opts);
  } catch (e) {
    // Backstop only — performApply returns on every path it knows about. An
    // outcome must exist even for the failure nobody predicted, or the vendor
    // learns nothing and the auto-halt stays blind (defect 4's real lesson,
    // which was never really about BOMs).
    const detail = 'Unexpected error while applying ' + version + ': ' + (e && e.message);
    writeOutcome(dataDir, { version, from: null, ok: false, db: 'unknown', at: now().toISOString(), detail });
    console.warn('[updater] ' + detail);
    result = { ok: false, from: null, detail };
  }
  // The restart is requested HERE, outside the try, so a test's exitImpl
  // cannot be caught by the backstop above and turned into a second outcome.
  // Exit code 75 is the launcher's restart convention (install/launcher/
  // EasyMed.cs: `while (exitCode == 75)`), and the entry path runs through
  // `current`, so the relaunch lands on the version just installed.
  if (result.restart) exitImpl(75);
  return { ok: result.ok, from: result.from, detail: result.detail };
}

async function performApply(db, dataDir, {
  root,
  version,
  now = () => new Date(),
  // UPDATE_PROGRESS_V1 — optional: applyUpdate is also called directly by
  // apply-update.test.js, which has no pipeline and no reporter. A no-op
  // stand-in keeps the call sites below free of `progress && progress.phase`.
  progress = { phase() {} },
  // Injected so a test can prove the apply REFUSES when no rollback point can
  // be taken. Never a second backup implementation — see the import.
  backupImpl = backupBeforeMigrate,
  symlinkSync = fs.symlinkSync,
  rmSync = fs.rmSync,
  realpathSync = fs.realpathSync,
  lstatSync = fs.lstatSync,
} = {}) {
  const currentLink = path.join(root, 'current');
  const targetDir = path.join(root, 'versions', version);

  // Where `current` points RIGHT NOW. That reading IS the rollback plan —
  // switch-version.ps1's step 2, and the one thing every failure path below
  // needs in order to put things back.
  let fromDir = null;
  try { fromDir = realpathSync(currentLink); } catch { /* absent or dangling — handled below */ }
  const from = fromDir ? path.basename(fromDir) : null;

  const fail = (dbState, detail) => {
    writeOutcome(dataDir, { version, from, ok: false, db: dbState, at: now().toISOString(), detail });
    console.warn('[updater] ' + version + ' was NOT applied: ' + detail);
    return { ok: false, from, detail, restart: false };
  };

  // ── Preconditions: refuse loudly, before anything is touched ──────────────

  // The bundle was unpacked moments ago by runPipeline, so this should always
  // hold — but a truncated unpack that still "succeeded" (tar's exit code says
  // nothing about a bundle built wrong) must be caught before `current` is
  // pointed at a directory with no application in it, which is the one mistake
  // that takes the clinic down with no way back except recover.cmd.
  const entry = path.join(targetDir, 'server', 'index.js');
  if (!fs.existsSync(entry)) {
    return fail('untouched', `Staged version '${version}' is missing or incomplete — '${entry}' was not found. Nothing was switched.`);
  }

  let linkStat = null;
  try { linkStat = lstatSync(currentLink); } catch { /* no `current` at all — created below, same as the launcher does */ }
  if (linkStat && !linkStat.isSymbolicLink()) {
    return fail('untouched', `'${currentLink}' exists but is a real directory, not a junction — a botched manual install, or a copy-paste that flattened the link. Removing it here could delete the running application rather than a link to it, so this refuses to touch it. Fix '${currentLink}' by hand first.`);
  }

  if (fromDir && path.resolve(fromDir) === path.resolve(targetDir)) {
    // NO outcome file on purpose: this is neither a failed install (auto-halt
    // must not count it) nor a successful one. Structurally unreachable —
    // runPipeline already refuses to stage over the running version — and kept
    // only as the backstop that makes an exit-75 restart loop impossible.
    console.warn(`[updater] 'current' already points at ${version} — nothing to apply`);
    return { ok: false, from, detail: 'already current', restart: false };
  }

  // ── 1. The rollback point ────────────────────────────────────────────────
  // The new version's migrations run at ITS next boot, and a migration is the
  // one part of an update that can hurt data. A snapshot that cannot be taken
  // CANCELS the update: an update is always deferrable ("try again tomorrow"
  // is this file's whole ethic), losing the only rollback point is not.
  let backupPath;
  progress.phase('snapshot');
  try {
    backupPath = await backupImpl(db, path.join(dataDir, 'easymed.db'), version);
  } catch (e) {
    return fail('untouched', `Could not take the pre-update database snapshot (${e && e.message}) — the update was cancelled and the clinic is still running ${from || 'the version it was already on'}.`);
  }

  // ── 2. The switch ────────────────────────────────────────────────────────
  // fs.rmSync on a junction removes the LINK, never the directory it points
  // at (verified directly, and asserted in apply-update.test.js — the previous
  // version has to survive, or there is nothing to recover TO).
  progress.phase('switching');
  try {
    if (linkStat) rmSync(currentLink, { recursive: true, force: true });
    symlinkSync(targetDir, currentLink, CURRENT_LINK_TYPE);
  } catch (e) {
    // Crash-safe: the clinic must be left runnable whatever happened. If the
    // old link is already gone and the new one could not be made, put the old
    // one back — the launcher CAN rebuild a missing `current` from the newest
    // version on disk, but only when somebody restarts it, and a clinic must
    // not have to discover that.
    let recovery = `'current' still points at ${from || 'wherever it did'}`;
    if (fromDir && !fs.existsSync(currentLink)) {
      try {
        symlinkSync(fromDir, currentLink, CURRENT_LINK_TYPE);
        recovery = `'current' was put back to ${from}`;
      } catch (e2) {
        recovery = `'current' could not be put back either (${e2 && e2.message}) — the launcher rebuilds a missing 'current' from the newest version on disk at its next start, or run recover.cmd`;
      }
    }
    return fail('untouched', `Repointing 'current' at ${version} failed: ${e && e.message}. ${recovery}. The database was not modified; the snapshot at ${backupPath} is intact.`);
  }

  // ── 3. Confirm, never assume ─────────────────────────────────────────────
  // A link that was created but resolves somewhere else must be reported as a
  // failure, not as an install nobody actually made. (The realistic case is an
  // operator double-clicking recover.cmd at the same moment.)
  let landed = null;
  try { landed = realpathSync(currentLink); } catch { /* falls into the mismatch below */ }
  if (!landed || path.resolve(landed) !== path.resolve(targetDir)) {
    return fail('untouched', `'current' was repointed but now resolves to '${landed || 'nothing'}' instead of '${targetDir}'. The database was not modified.`);
  }

  // 'current' is apply-update.ps1's own success vocabulary for "no rollback
  // question applies" — kept because updates-logic.js reads this field and
  // only ever singles out 'restored'.
  writeOutcome(dataDir, {
    version,
    from,
    ok: true,
    db: 'current',
    at: now().toISOString(),
    detail: `Repointed 'current' from ${from || '(nothing)'} to ${version}. Database snapshot taken first: ${backupPath}. Restarting to run the new version.`,
  });
  console.log(`[updater] version ${version} installed — restarting to run it`);
  return { ok: true, from, detail: 'applied', restart: true };
}
async function runPipeline(db, dataDir, offer, {
  fetchImpl, execFileSyncImpl, mkdirSync, rmSync, writeFileSync, realpathSync,
  endpoint, publicKey, appRoot, exitImpl, now, timeoutMs, maxBytes,
}) {
  if (!endpoint) assertControlUrlIsTestSafe(process.env, fetchImpl);   // PROD_GUARD_V1
  const base = endpoint ? String(endpoint).replace(/\/+$/, '') : controlBaseUrl();
  const resolved = resolveDownloadUrl(offer.url, base);
  if (!resolved.ok) {
    console.warn('[updater] refusing to download — ' + resolved.reason + ':', offer.url);
    return;
  }

  // Created only AFTER the URL is accepted: a refused cross-host offer never
  // reaches the network, so telling the screen "downloading" would be a lie.
  // The throttle keeps its default here on purpose: the rate a progress row
  // may be written at is a property of the clinic's database, not something a
  // caller should be able to turn up. update-progress.test.js drives it
  // directly, off a fake clock, where it belongs.
  const progress = makeProgressReporter(db, { version: offer.version, now });

  const tarPath = path.join(dataDir, TEMP_TAR_NAME);
  const manifestPath = path.join(dataDir, TEMP_MANIFEST_NAME);

  // Disk hygiene — a failed attempt's temp files must never accumulate.
  // Extracted from the `finally` below because it now has to run BEFORE the
  // apply as well: a successful apply ends in process.exit(75), and
  // process.exit does not run finally blocks, so the downloaded bundle would
  // otherwise sit on a clinic's disk until the next attempt overwrote it.
  const cleanupTempFiles = () => {
    try { fs.existsSync(tarPath) && fs.unlinkSync(tarPath); } catch { /* best-effort cleanup */ }
    try { fs.existsSync(manifestPath) && fs.unlinkSync(manifestPath); } catch { /* best-effort cleanup */ }
  };

  try {
    progress.phase('downloading');
    const dl = await downloadToFile(resolved.url, tarPath, {
      fetchImpl, maxBytes, timeoutMs,
      onProgress: (received, total, opts) => progress.bytes(received, total, opts),
    });
    if (!dl.ok) {
      console.warn('[updater] download failed (' + dl.reason + '), will retry tomorrow:', dl.detail || dl.status || '');
      // Kept, not cleared: "the download failed and we will try again" is
      // something the clinic can act on (check the internet), and it is the
      // only signal for a failure that never reaches the outcome file —
      // writeOutcome only ever runs from the APPLY step.
      progress.fail(dl.reason);
      return;
    }

    // VERIFY BEFORE UNPACKING, NEVER AFTER — verifyBundle is imported, never
    // reimplemented, and checks signature, then hash, then min_from, in that
    // fixed order. manifestPath is a temp file here (not a downloaded one)
    // because verifyBundle's real signature is {tarPath, manifestPath, ...}
    // — it has no `manifest` object parameter — so offer.manifest (already
    // parsed JSON from the check-in response) is written back out to disk
    // once, purely to hand it to the same verifier every bundle uses.
    progress.phase('verifying');
    try {
      writeFileSync(manifestPath, JSON.stringify(offer.manifest ?? null));
    } catch (e) {
      console.warn('[updater] could not write the manifest temp file:', e.message);
      progress.fail('manifest_write');
      return;
    }

    const verified = verifyBundle({
      tarPath,
      manifestPath,
      publicKey: publicKey || releasePublicKey(),
      installedVersion: readAppVersion(),
    });
    if (!verified.ok) {
      console.warn('[updater] bundle refused (' + verified.reason + ') — nothing staged, nothing applied');
      progress.fail('bundle_refused');
      return;
    }
    // Belt-and-braces beyond verifyBundle's own checks: the SIGNED manifest
    // must actually claim the version this offer said it was — a control
    // plane that served a validly-signed but mismatched manifest (a bug, not
    // necessarily an attack) must not silently install the wrong version.
    if (verified.manifest.version !== offer.version) {
      console.warn('[updater] manifest version does not match the offer — refusing');
      progress.fail('version_mismatch');
      return;
    }

    const layout = detectLayout(appRoot, { realpathSync });
    const stagingRoot = layout.versioned
      ? path.join(layout.root, 'versions')
      // DEV LAYOUT — a plain checkout must never have its service switched
      // under it, because there IS no service. Staging still happens (so the
      // download/verify pipeline is exercised for real), but into a scratch
      // folder under dataDir, and apply is skipped entirely below.
      : path.join(dataDir, 'update-staging');
    const versionDir = path.join(stagingRoot, offer.version);

    if (layout.versioned) {
      // Never stage over the directory `current` is ACTUALLY pointing at —
      // this should be structurally impossible (a clinic already on a
      // version is never offered it again, per Task 3), but a control-plane
      // bug that offered the running version anyway must not be able to
      // overwrite the live, running code out from under this very process.
      const currentLink = path.join(layout.root, 'current');
      let currentReal = null;
      try { currentReal = realpathSync(currentLink); } catch { /* no current link — nothing to protect */ }
      if (currentReal && path.resolve(currentReal) === path.resolve(versionDir)) {
        console.warn('[updater] refusing to stage over the currently running version — will retry tomorrow');
        // Cleared, not failed: this is the clinic ALREADY being on the offered
        // version (see performTick's spent-consent note). Nothing went wrong,
        // so nothing should be shown.
        progress.clear();
        return;
      }
    }

    progress.phase('unpacking');
    try {
      // An "already exists" versionDir is always a LEFTOVER from a prior,
      // never-applied attempt (the safety check above already ruled out it
      // being the live version) — safe to discard and re-stage fresh from a
      // bundle that has JUST passed signature+hash verification. Removed
      // only AFTER verification, never before: "verify before unpacking,
      // never after" applies to what gets trusted, and nothing here trusts
      // the leftover directory's contents.
      if (fs.existsSync(versionDir)) rmSync(versionDir, { recursive: true, force: true });
      mkdirSync(versionDir, { recursive: true });
      const tar = tarCommand();
      execFileSyncImpl(tar.exe, [...tar.extraFlags, '-xzf', tarPath, '-C', versionDir], { stdio: 'pipe' });
    } catch (e) {
      console.warn('[updater] could not stage the update, will retry tomorrow:', e.message);
      try { rmSync(versionDir, { recursive: true, force: true }); } catch { /* best-effort */ }
      progress.fail('unpack');
      return;
    }

    if (!layout.versioned) {
      // BROKEN_LAYOUT_VISIBLE_V1 — «не могу обновиться» обязано быть СКАЗАНО.
      //
      // Здесь встречаются два совершенно разных случая, и раньше оба молчали:
      //
      //   1. Машина разработчика. Обновлять её нечего и незачем, экрана, на
      //      который кто-то смотрит, у неё нет — молчание правильно.
      //   2. НАСТОЯЩАЯ клиника, разложенная неправильно: без versions\<v> и
      //      без current переключать нечего, и она не примет ни одного
      //      обновления НИКОГДА. Молчание тут — худшее из возможных: филиал
      //      владельца 2026-09-02 скачивал и распаковывал обновление раз за
      //      разом, показывал «доступно обновление» и не двигался с места, а
      //      причина существовала только в логе.
      //
      // Различаем по .git: рабочее дерево разработчика его имеет, распакованный
      // релиз — нет (сборка его не кладёт). Признак грубый, но честный, и
      // ошибается в безопасную сторону: лишний раз показать «переустановите
      // правильно» разработчику не страшно, а промолчать клинике — страшно.
      let looksLikeCheckout = false;
      try { looksLikeCheckout = fs.existsSync(path.join(appRoot, '.git')); } catch { /* не смогли — считаем клиникой */ }

      if (looksLikeCheckout) {
        console.warn('[updater] dev layout — staged only; apply is skipped (a dev machine must never have its `current` switched)');
        progress.clear();
        return;
      }

      console.warn('[updater] this install has no versions/current layout — it can never apply an update. Reinstall with the official package.');
      progress.fail('not_installed');
      return;
    }

    // APPLY — in this process, and awaited. There is no child to lose track
    // of any more: the whole of the 2026-08-24 hunt existed because a spawned
    // powershell.exe died silently and nothing could tell the difference
    // between "installed" and "never started". applyUpdate never throws, and
    // ends a successful install by asking the launcher for a restart.
    cleanupTempFiles();
    const applied = await applyUpdate(db, dataDir, {
      root: layout.root,
      version: offer.version,
      exitImpl,
      now,
      progress,
    });
    // A successful apply never gets here — exit(75) already took the process
    // down, and the record it left ('switching') is cleaned up by
    // reconcileProgressAtBoot on the way back in. A FAILED apply does get
    // here, and the outcome file (which the screen renders as its own,
    // louder notice) is now the better record — so this one steps aside
    // rather than showing two versions of the same bad news.
    if (!applied || !applied.ok) progress.clear();
  } finally {
    // Unconditional backstop — reached whether the pipeline above succeeded,
    // refused the bundle, or threw partway through staging. (A successful
    // apply has already cleaned up and exited before reaching this.)
    cleanupTempFiles();
  }
}

/**
 * Wires the minute timer into the running process. Mirrors checkin.js's
 * scheduleCheckin shape: .unref()'d so it can never hold the process open,
 * and every tick is wrapped so a rejection from tickUpdater (documented never
 * to happen, but not something a timer callback has any caller to hand a
 * rejection to anyway) cannot crash the clinic's server.
 */
/**
 * Am I the OLD code, still serving after the junction already moved?
 *
 * Historically the last gap in hands-free updating: the retired apply-update.ps1
 * stopped and started a Windows SERVICE, a launcher install has none, so the
 * script repointed `current` and the already-running Node kept serving the
 * previous version — screen still showing the old number, owner reasonably
 * concluding the update failed (it happened three times on 2026-08-24).
 *
 * KEPT, though applyUpdate now exits 75 itself the moment it switches, because
 * this is the only thing that notices a switch THIS process did not make: an
 * outcome file left by a clinic that was still on the PowerShell apply when it
 * updated, or a `current` moved by hand or by recover.cmd while the server ran.
 *
 * Detected from facts on disk only: a successful outcome file naming a version
 * newer than the one THIS process is running, plus `current` now resolving
 * somewhere other than where this process was loaded from. Both must hold, so
 * a dev checkout (no versions/ parent) and a service install (already restarted
 * by the SCM, versions equal) can never trip it.
 *
 * @returns {string|null} the newly installed version, or null if nothing to do
 */
export function staleAfterSwitch(dataDir, appRoot, {
  realpathSync = fs.realpathSync,
  // The version THIS process is running. Injectable for the same reason
  // realpathSync is: a test must be able to describe an install other than
  // the checkout it happens to be running inside.
  runningVersion = readAppVersion(),
} = {}) {
  const result = readJsonFile(path.join(dataDir, 'update-result.json'))
    || readJsonFile(path.join(dataDir, 'update-result.json.sent'));
  if (!result || result.ok !== true) return null;

  const installed = typeof result.version === 'string' ? result.version : '';
  const running = runningVersion;
  if (!installed || !running || compareVersions(installed, running) <= 0) return null;

  // Must look like a versioned install: <root>/versions/<mine>
  const resolvedAppRoot = path.resolve(appRoot);
  const versionsDir = path.dirname(resolvedAppRoot);
  if (path.basename(versionsDir) !== 'versions') return null;

  // ...and `current` must now point somewhere OTHER than here — that is the
  // switch having happened underneath this process.
  let currentReal;
  try { currentReal = realpathSync(path.join(path.dirname(versionsDir), 'current')); } catch { return null; }
  if (path.resolve(currentReal) === resolvedAppRoot) return null;

  return installed;
}
export function scheduleUpdater(db, dataDir, opts = {}) {
  const { intervalMs = 60_000, exitImpl = (code) => process.exit(code), ...rest } = opts;

  // UPDATE_PROGRESS_V1 — ONCE, at boot, before anything is armed. The whole
  // pipeline runs inside a single process, so a progress record still in a
  // live phase at this moment belongs to a process that no longer exists: it
  // either finished (and exit(75) is why we are booting) or it died. Either
  // way it must stop claiming to be downloading. See that file's own header.
  try {
    // rest.runningVersion is performTick's own test seam, reused here for the
    // same reason its comment gives: readAppVersion() reads package.json off
    // disk, so a test cannot otherwise describe an install other than the
    // checkout it is running inside.
    reconcileProgressAtBoot(db, { runningVersion: rest.runningVersion || readAppVersion(), compare: compareVersions });
  } catch (e) {
    // Bookkeeping may never be the reason a clinic fails to start.
    console.warn('[updater] could not reconcile the update progress record (continuing):', e && e.message);
  }

  // exitImpl is destructured out AND put back: this scheduler uses it for the
  // staleAfterSwitch restart below, and applyUpdate needs the same seam to end
  // a successful install. Two exits, one injection point — a test that stubs
  // it must never have one of the two slip through to the real process.exit.
  const runOpts = { ...rest, exitImpl };
  const tick = () => {
    // Checked BEFORE the pipeline: if the junction already moved under us,
    // this process is the old code and has nothing useful left to do — hand
    // the window back to the launcher, which relaunches on exit code 75 and
    // comes up on the new version. Without this the clinic runs the previous
    // release until someone happens to close and reopen the window.
    try {
      const installed = staleAfterSwitch(dataDir, runOpts.appRoot || DEFAULT_APP_ROOT);
      if (installed) {
        console.log(`[updater] version ${installed} is installed and active on disk — restarting to run it`);
        exitImpl(75);
        return;
      }
    } catch (e) {
      // A restart decision must never be the reason a clinic stops working.
      console.warn('[updater] post-switch check failed (continuing):', e && e.message);
    }
    tickUpdater(db, dataDir, runOpts).catch((e) => console.warn('[updater] scheduled tick failed:', e && e.message));
  };
  const interval = setInterval(tick, intervalMs);
  interval.unref();
  return { interval };
}
