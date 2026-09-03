import fs from 'node:fs';
import path from 'node:path';
import { verifyLicence } from './licence.js';
import { computeFingerprint, writeAtomic, readBounded } from './checkin.js';
import { ensureSyncGroup } from '../branch-sync/sync-group.js';   // BRANCH_SYNC_RELAY_V1
import { assertControlUrlIsTestSafe } from './prod-guard.js';   // PROD_GUARD_V1

// ENROLLMENT_SCREEN_V1 — the clinic's half of first-run enrollment.
//
// The admin types the EM- code the vendor read out; this module redeems it
// against the control plane and writes the install's identity to disk. It is
// the only place besides checkin.js that ever writes control.json/licence.dat,
// and it holds itself to checkin.js's headline rule: never throw, never leave
// a half-written file, and never write ANYTHING an Ed25519 verification did
// not first approve — a control plane that answers garbage (or whoever is
// answering in its place) must leave the install exactly as it was.
//
// No in-flight guard on purpose, unlike runCheckin(): the screen disables its
// button, and the worst genuine race (two admins typing the SAME code on two
// PCs) resolves server-side — codes are single-use, the loser gets a plain
// invalid_code and the winner's files are untouched.

const DEFAULT_ENDPOINT = 'https://settings.easymed.uz';
const ENROLL_PATH = '/cp/v1/enroll';

// Same budget reasoning as checkin.js's own constants: fail fast on a dead
// network rather than hang a click, and never buffer a hostile body.
const TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 1_000_000;

let _testPublicKey = null;
/** Tests inject their own throwaway key — the seam state.js/checkin.js also carry. */
export function __setPublicKeyForTests(key) { _testPublicKey = key; }

/** Where enrollment goes. Exported so URL resolution is unit-testable without a network call — mirrors checkinUrl(). */
export function enrollUrl(env = process.env) {
  const base = String((env && env.EASYMED_CONTROL_URL) || DEFAULT_ENDPOINT).trim().replace(/\/+$/, '');
  return base + ENROLL_PATH;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/**
 * Redeem an enrollment code and write this install's identity.
 *
 * @param {string} dataDir  where control.json and licence.dat live
 * @param {string} code     what the admin typed, as typed
 * @param {object} [opts]   fetchImpl/endpoint/timeoutMs and the atomic-write
 *                          seams, same shape as performCheckin's
 * @param {boolean} [opts.replace]  BRANCH_REISSUE_V1 — redeem the code even
 *                          though this install ALREADY carries an identity,
 *                          and replace that identity with the one the code
 *                          belongs to. See REPLACE below.
 * @returns {Promise<{ok:true, clinic_id:string, clinic_name:string|null}
 *                 | {ok:false, reason:string}>}
 *
 * NEVER throws. `reason` is a fixed vocabulary the RPC layer maps to Russian:
 * empty_code | already_enrolled | offline | invalid_code | too_many_attempts
 * | server_error | bad_response | write_failed.
 */
export async function enrollWithCode(dataDir, code, {
  fetchImpl = globalThis.fetch,
  endpoint,
  timeoutMs = TIMEOUT_MS,
  maxResponseBytes = MAX_RESPONSE_BYTES,
  writeFileSync,
  renameSync,
  replace = false,   // BRANCH_REISSUE_V1
} = {}) {
  // The same normalisation the control plane applies before matching
  // (control-plane/server/services/enrollment.js) — applied here TOO so what
  // the clinic sends is already canonical and a lowercase code typed with a
  // stray space works even against some future stricter server.
  const normalized = typeof code === 'string' ? code.trim().toUpperCase().replace(/\s+/g, '') : '';
  if (!normalized) return { ok: false, reason: 'empty_code' };

  // Refusing here, before the network, is what keeps the single-use code
  // alive: the control plane burns it on redemption, so an already-enrolled
  // install that reached the server would waste a code just to be told no.
  //
  // REPLACE — BRANCH_REISSUE_V1, and the ONE case where that refusal is wrong.
  //
  // A branch PC that was reinstalled and then activated as a brand-new
  // STANDALONE clinic (the owner's own workaround on 2026-09-02, because the
  // branch's one-time code had already burned) carries a perfectly valid
  // identity — the WRONG one. It cannot sync (wrong clinic, no pairing on the
  // main's side) and no amount of re-typing the branch key fixes it, because
  // this very refusal fires before the code ever reaches the vendor. So the
  // one cure is to redeem the branch's fresh code ON TOP of the identity the
  // install already has: it stops being clinic X and becomes branch
  // c-…-bN, with that branch's subscription, modules and check-in.
  //
  // WHAT THIS DOES NOT WEAKEN. Everything below this line is untouched, so
  // the guarantees the rest of this file argues for hold exactly as before:
  // the code is still single-use server-side, a refused code (400) still
  // writes NOTHING and leaves the install exactly as it was, and the licence
  // must still verify against the vendor key FOR THE clinic_id the response
  // claims before a single byte is written. `replace` buys one thing only —
  // the right to spend a code from an install that already has an identity —
  // and it is never inferred: the caller (rpc/branch-sync.js) asks for it
  // explicitly, having first established that this install is licensed as
  // something that is not a branch at all.
  const existing = readJson(path.join(dataDir, 'control.json'));
  if (!replace && existing && typeof existing === 'object' && !Array.isArray(existing)
      && typeof existing.install_token === 'string' && existing.install_token) {
    return { ok: false, reason: 'already_enrolled' };
  }

  if (!endpoint) assertControlUrlIsTestSafe(process.env, fetchImpl);   // PROD_GUARD_V1
  const url = endpoint ? String(endpoint).replace(/\/+$/, '') + ENROLL_PATH : enrollUrl();

  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: normalized, fingerprint: computeFingerprint() }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    // DNS failure, refused connection, timeout — for a first run this is the
    // COMMON case (the clinic's internet may not be set up yet), not an error
    // worth distinguishing further.
    return { ok: false, reason: 'offline' };
  }

  if (!res.ok) {
    // Status is the whole contract here — the control plane's 400 body is a
    // deliberately generic English sentence (anti-probing, see its
    // enroll.js), so there is nothing in it worth surfacing to the clinic.
    if (res.status === 429) return { ok: false, reason: 'too_many_attempts' };
    if (res.status === 400) return { ok: false, reason: 'invalid_code' };
    // 5xx: signing runs inside the redemption transaction server-side, so the
    // code is NOT burned and retrying later is the honest advice.
    return { ok: false, reason: 'server_error' };
  }

  let text = null;
  try { text = await readBounded(res, maxResponseBytes); } catch { text = null; }
  let body = null;
  try { body = JSON.parse(text); } catch { body = null; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, reason: 'bad_response' };

  const { clinic_id, clinic_name, install_token, unlock_secret, licence } = body;
  if (typeof clinic_id !== 'string' || !clinic_id
      || typeof install_token !== 'string' || !install_token
      || typeof unlock_secret !== 'string' || !unlock_secret
      || !licence || typeof licence !== 'object') {
    return { ok: false, reason: 'bad_response' };
  }

  // The gate before any disk write: the licence must verify against the
  // compiled-in vendor key AND name the clinic_id the response claims to be
  // enrolling. verifyLicence never throws.
  const verified = verifyLicence(JSON.stringify(licence), {
    publicKey: _testPublicKey,
    clinicId: clinic_id,
  });
  if (!verified.ok) return { ok: false, reason: 'bad_response' };

  const identity = {
    clinic_id,
    clinic_name: typeof clinic_name === 'string' ? clinic_name : null,
    install_token,
    unlock_secret,
    subscription: typeof body.subscription === 'string' ? body.subscription : 'active',
  };

  // Identity FIRST, licence second — the INVERSE of checkin.js's licence-first
  // rule, deliberately. Check-in renews a pair that already exists; enrollment
  // creates it, and the code is already burned server-side by the time either
  // write runs. If only control.json lands (crash, full disk), the install
  // reads as 'unlicensed' WITH an install_token — and the next daily check-in
  // fetches a fresh licence and completes the pair with no human involved.
  // Licence-first would instead leave 'not_enrolled' with a dead code: a stuck
  // install only the vendor can rescue. Pinned by the two write-order tests.
  //
  // The same order is the right one for a REPLACE, and for the same reason.
  // Crash between the two writes and control.json names the new clinic while
  // licence.dat still holds the old one: the licence no longer verifies for
  // the clinic_id on disk, so the install reads as unlicensed WITH an
  // install_token, and the next check-in fetches the branch's own licence
  // with no human involved. The other order would leave a licence for a
  // clinic this install no longer claims to be — the same stuck install,
  // reached from the other side.
  try {
    writeAtomic(path.join(dataDir, 'control.json'), JSON.stringify(identity), { writeFileSync, renameSync });
    writeAtomic(path.join(dataDir, 'licence.dat'), JSON.stringify(licence), { writeFileSync, renameSync });
  } catch (e) {
    console.warn('[enroll] could not write identity files:', e && e.message);
    return { ok: false, reason: 'write_failed' };
  }

  // BRANCH_SYNC_RELAY_V1 — the branch-sync key is born HERE, with the install's
  // identity. The owner's decision: activating the clinic is the moment it gets
  // a key, and "add a branch" later just hands that same identity to the second
  // building.
  //
  // AFTER both writes and OUTSIDE their try/catch, deliberately: this key never
  // goes to the vendor and nothing in enrollment depends on it, so failing to
  // write it (full disk, permissions) must cost the branch-sync fallback route
  // and NOT the enrollment, whose single-use code is already burned server-side.
  // An install left without the file picks one up the first time the Branches
  // screen is opened (ensureSyncGroup is called from there too) — the same path
  // every clinic enrolled before Route B existed takes.
  ensureSyncGroup(dataDir, { writeFileSync, renameSync });

  return { ok: true, clinic_id, clinic_name: identity.clinic_name };
}
