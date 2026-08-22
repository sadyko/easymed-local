import fs from 'node:fs';
import path from 'node:path';
import { createHash, createPublicKey } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyBundle, tarCommand } from '../../../scripts/build-bundle.mjs';
import { readAppVersion } from './checkin.js';
import { nextRunAt, isInWindow, consentAppliesTo } from './update-schedule.js';

// UPDATE_DELIVERY_V1 (docs/plans/2026-08-20-update-delivery.md, Task 4) — the
// clinic's own machine: check the stored offer, confirm it is still
// consented to, and — only inside the clinic's chosen hour — download,
// verify, stage, and hand off to apply-update.ps1.
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
// REPLACE THIS at first release with the real public key printed by
// `node scripts/build-bundle.mjs` 's companion keygen step (mirrors
// make-licence.mjs keygen). The matching private half must live only in the
// EASYMED_RELEASE_KEY CI secret, never here. The placeholder below is a real,
// valid Ed25519 key whose private half was generated once, used to print
// this PEM, and then discarded — so an un-replaced build fails closed: no
// bundle can ever verify against it, the same reasoning licence.js documents
// for its own placeholder.
// ############################################################################
// ##  DEVELOPMENT KEY — NOT THE PRODUCTION KEY. the production release key.  ##
// ############################################################################
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

async function downloadToFile(url, destPath, { fetchImpl = globalThis.fetch, maxBytes = MAX_BUNDLE_BYTES, timeoutMs = DOWNLOAD_TIMEOUT_MS } = {}) {
  let res;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    return { ok: false, reason: 'network', detail: e && e.message };
  }
  if (!res.ok) return { ok: false, reason: 'http_status', status: res.status };

  const reader = res.body && typeof res.body.getReader === 'function' ? res.body.getReader() : null;
  if (!reader) return { ok: false, reason: 'no_body' };

  const hash = createHash('sha256');
  let total = 0;
  let fd;
  try {
    fd = fs.openSync(destPath, 'w');
  } catch (e) {
    return { ok: false, reason: 'disk', detail: e && e.message };
  }
  try {
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
    }
  } catch (e) {
    return { ok: false, reason: 'stream_error', detail: e && e.message };
  } finally {
    try { fs.closeSync(fd); } catch { /* already closed or never opened successfully */ }
  }
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
// genuine, service-managed layout: staging into a plain checkout's sibling
// folders would be inert, but the WORSE mistake this guards against is ever
// deciding "versioned" when it is not, which is what gates whether
// apply-update.ps1 gets to touch a Windows service at all.
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
  spawnImpl = spawn,
  execFileSyncImpl = execFileSync,
  mkdirSync = fs.mkdirSync,
  rmSync = fs.rmSync,
  writeFileSync = fs.writeFileSync,
  realpathSync = fs.realpathSync,
  now = () => new Date(),
  endpoint,
  publicKey,
  appRoot = DEFAULT_APP_ROOT,
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
      fetchImpl, spawnImpl, execFileSyncImpl, mkdirSync, rmSync, writeFileSync, realpathSync,
      endpoint, publicKey, appRoot, timeoutMs, maxBytes,
    });
  } catch (e) {
    // Backstop — every step below has its own guard, but nothing may ever
    // escape performTick as an uncaught rejection. "Try again tomorrow."
    console.warn('[updater] unexpected error, treating as "try again tomorrow":', e && e.message);
  }
}

async function runPipeline(db, dataDir, offer, {
  fetchImpl, spawnImpl, execFileSyncImpl, mkdirSync, rmSync, writeFileSync, realpathSync,
  endpoint, publicKey, appRoot, timeoutMs, maxBytes,
}) {
  const base = endpoint ? String(endpoint).replace(/\/+$/, '') : controlBaseUrl();
  const resolved = resolveDownloadUrl(offer.url, base);
  if (!resolved.ok) {
    console.warn('[updater] refusing to download — ' + resolved.reason + ':', offer.url);
    return;
  }

  const tarPath = path.join(dataDir, TEMP_TAR_NAME);
  const manifestPath = path.join(dataDir, TEMP_MANIFEST_NAME);

  try {
    const dl = await downloadToFile(resolved.url, tarPath, { fetchImpl, maxBytes, timeoutMs });
    if (!dl.ok) {
      console.warn('[updater] download failed (' + dl.reason + '), will retry tomorrow:', dl.detail || dl.status || '');
      return;
    }

    // VERIFY BEFORE UNPACKING, NEVER AFTER — verifyBundle is imported, never
    // reimplemented, and checks signature, then hash, then min_from, in that
    // fixed order. manifestPath is a temp file here (not a downloaded one)
    // because verifyBundle's real signature is {tarPath, manifestPath, ...}
    // — it has no `manifest` object parameter — so offer.manifest (already
    // parsed JSON from the check-in response) is written back out to disk
    // once, purely to hand it to the same verifier every bundle uses.
    try {
      writeFileSync(manifestPath, JSON.stringify(offer.manifest ?? null));
    } catch (e) {
      console.warn('[updater] could not write the manifest temp file:', e.message);
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
      return;
    }
    // Belt-and-braces beyond verifyBundle's own checks: the SIGNED manifest
    // must actually claim the version this offer said it was — a control
    // plane that served a validly-signed but mismatched manifest (a bug, not
    // necessarily an attack) must not silently install the wrong version.
    if (verified.manifest.version !== offer.version) {
      console.warn('[updater] manifest version does not match the offer — refusing');
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
        return;
      }
    }

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
      return;
    }

    if (!layout.versioned) {
      console.warn('[updater] dev layout — staged only; apply is skipped (a dev machine must never have its service switched)');
      return;
    }

    // APPLY — spawned, never awaited to completion. apply-update.ps1 calls
    // switch-version.ps1, which STOPS this very Windows service as one of
    // its first steps: this Node process may be killed mid-flight moments
    // after this call returns. detached + unref'd so the child survives that
    // and this function returns immediately rather than hanging on a
    // process that is about to outlive its parent.
    try {
      const applyScript = path.join(layout.root, 'current', 'install', 'apply-update.ps1');
      const child = spawnImpl(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', applyScript, '-Version', offer.version, '-Root', layout.root],
        { cwd: layout.root, detached: true, stdio: 'ignore' },
      );
      // A DI stub is not obliged to return a real ChildProcess — guarded so
      // a test's plain stub return value can never crash this call.
      if (child && typeof child.unref === 'function') child.unref();
    } catch (e) {
      console.warn('[updater] could not launch apply-update.ps1, will retry tomorrow:', e.message);
    }
  } finally {
    // Disk hygiene — a failed attempt's temp files must never accumulate.
    // Unconditional: reached whether the pipeline above succeeded, refused
    // the bundle, or threw partway through staging.
    try { fs.existsSync(tarPath) && fs.unlinkSync(tarPath); } catch { /* best-effort cleanup */ }
    try { fs.existsSync(manifestPath) && fs.unlinkSync(manifestPath); } catch { /* best-effort cleanup */ }
  }
}

/**
 * Wires the minute timer into the running process. Mirrors checkin.js's
 * scheduleCheckin shape: .unref()'d so it can never hold the process open,
 * and every tick is wrapped so a rejection from tickUpdater (documented never
 * to happen, but not something a timer callback has any caller to hand a
 * rejection to anyway) cannot crash the clinic's server.
 */
export function scheduleUpdater(db, dataDir, opts = {}) {
  const { intervalMs = 60_000, ...runOpts } = opts;
  const tick = () => {
    tickUpdater(db, dataDir, runOpts).catch((e) => console.warn('[updater] scheduled tick failed:', e && e.message));
  };
  const interval = setInterval(tick, intervalMs);
  interval.unref();
  return { interval };
}
