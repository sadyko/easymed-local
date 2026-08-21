// LICENCE_CORE_V1 — the vendor's signer, now living in the control plane instead
// of only in scripts/make-licence.mjs. This builds the same six-key payload that
// file's `issue` command builds, serialises it with the ONE canonical() both
// sides share, and signs it with the vendor's private Ed25519 key. Anything
// this file produces must verify with server/services/control/licence.js
// exactly as if the CLI had produced it — that cross-check is this file's own
// test suite, and it is the entire reason both halves live in one repository
// (see control-plane/README.md).
//
// scripts/make-licence.mjs is NOT retired by this file. It stays as the
// break-glass path for when the panel (or this whole machine) is unreachable —
// see its own header comment.

import fs from 'node:fs';
import { createPrivateKey, sign, randomBytes } from 'node:crypto';
import { canonical } from '../../../server/services/control/canonical.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// A display label, not an identity — bounded so an absurd value (a form left
// unbounded, a copy-paste accident) doesn't put arbitrary-length text into a
// payload that gets written to a clinic's disk and read back on every request.
const MAX_CLINIC_NAME_LEN = 200;

// KEY_LOADING_STRATEGY_V1 — the key is loaded once per resolved path, then
// cached for the life of the process. It is NOT re-read from disk on every
// signLicence() call.
//
// The alternative — read fresh every call — makes a rotated key take effect
// immediately with no restart, which sounds strictly better until you weigh
// the failure mode: a key file is briefly absent mid-copy during a rotation,
// or a permissions change lands on the vendor's disk between two check-ins,
// and EVERY signLicence() call in that window fails — silently, for whichever
// clinic happens to check in right then, with nobody watching. That is exactly
// the failure ensureSigningKey() exists to prevent, just moved from boot time
// to a random moment in production. Caching means a bad key is caught once,
// loudly, at startup (ensureSigningKey, wired into the entry point by a later
// task) and never again until the process restarts. Rotating the vendor's
// signing key is rare and deliberate; restarting the control plane to pick up
// a rotation is a small, visible cost worth paying for never silently failing
// to sign in between.
const _keyCache = new Map(); // resolved path -> KeyObject

/**
 * Read and parse an Ed25519 private key from disk.
 *
 * Exported so the startup check (ensureSigningKey) and tests can exercise it
 * directly, but the key MATERIAL itself is never returned by anything except
 * this function's KeyObject result — never logged, never stored in the
 * database, never woven into an error message.
 *
 * @param {string} keyPath
 * @returns {import('node:crypto').KeyObject}
 */
export function loadSigningKey(keyPath) {
  let pem;
  try {
    pem = fs.readFileSync(keyPath, 'utf8');
  } catch (e) {
    // The PATH is fine to mention (it is not secret); the file's bytes never
    // reach this message because they were never read successfully.
    throw new Error(`Could not read the signing key at "${keyPath}" (${e.code || e.message}).`);
  }
  try {
    return createPrivateKey(pem);
  } catch {
    // Deliberately does NOT include `pem` or any slice of it: a key file that
    // fails to parse is still key material (or someone's attempt at one), and
    // error messages end up in logs and terminals far more casually than the
    // key file itself does.
    throw new Error(`"${keyPath}" does not look like a valid Ed25519 private key.`);
  }
}

function resolveKeyPath() {
  const p = process.env.EASYMED_SIGNING_KEY;
  if (!p) {
    throw new Error(
      'EASYMED_SIGNING_KEY is not set. The control plane needs a path to the vendor\'s ' +
      'Ed25519 private key to sign anything — see scripts/make-licence.mjs keygen.',
    );
  }
  return p;
}

function getSigningKey() {
  const keyPath = resolveKeyPath();
  if (!_keyCache.has(keyPath)) {
    _keyCache.set(keyPath, loadSigningKey(keyPath));
  }
  return _keyCache.get(keyPath);
}

/**
 * Startup check: refuses to let the process believe it can sign when it can't.
 *
 * Exported as a function (rather than run as a side effect of importing this
 * module) so it can be tested here and called explicitly, once, from the
 * service entry point at boot — see KEY_LOADING_STRATEGY_V1 above for why once
 * is the right number of times.
 *
 * A control plane that starts up but silently cannot sign is worse than one
 * that refuses to start: clinics keep checking in against a service that
 * answers "here's your status" but can never hand out a fresh licence, and the
 * failure isn't noticed until clinics start lapsing two weeks later with
 * nobody having watched it happen.
 *
 * @throws {Error} a clear, key-material-free message if signing is not possible
 */
export function ensureSigningKey() {
  getSigningKey(); // throws with a clear message if unset, unreadable, or unparseable
}

// clinic_id is the identity a signed licence is FOR. Get it wrong and the
// licence is either useless (verifies for nobody) or ambiguous. Never
// coerced — a number or object here is a caller bug to reject, not a value to
// guess at by stringifying.
function normaliseClinicId(clinicId) {
  if (typeof clinicId !== 'string' || clinicId.length === 0) {
    throw new Error(`signLicence: clinicId must be a non-empty string, got ${JSON.stringify(clinicId)}.`);
  }
  return clinicId;
}

// A display label, not an identity — unlike clinicId, an absent name is the
// normal case (scripts/make-licence.mjs's own --name is optional too) and
// defaults to ''. A wrong TYPE is still rejected: silently stringifying an
// object into "[object Object]" would hide a real caller bug behind a licence
// that looks fine until a human reads the clinic name on it.
function normaliseClinicName(clinicName) {
  if (clinicName === undefined || clinicName === null) return '';
  if (typeof clinicName !== 'string') {
    throw new Error(`signLicence: clinicName must be a string, got ${typeof clinicName}.`);
  }
  return clinicName.length > MAX_CLINIC_NAME_LEN ? clinicName.slice(0, MAX_CLINIC_NAME_LEN) : clinicName;
}

function normaliseModules(modules) {
  if (modules === undefined || modules === null) return []; // free core: nothing granted, not an error
  if (!Array.isArray(modules)) {
    throw new Error(`signLicence: modules must be an array of strings, got ${typeof modules}.`);
  }
  const set = new Set();
  for (const m of modules) {
    // Rejected, not filtered out: a caller passing a non-string here (an
    // object, a number, a typo'd config entry) is a bug that should fail
    // loudly. Silently dropping the bad entry could just as easily silently
    // drop a whole module grant the caller meant to include — worse than
    // refusing to sign at all, because nothing downstream would ever notice.
    if (typeof m !== 'string') {
      throw new Error(`signLicence: modules must all be strings, got ${JSON.stringify(m)}.`);
    }
    const trimmed = m.trim();
    if (trimmed) set.add(trimmed); // dedup; mirrors the CLI's own .filter(Boolean)
  }
  // Sorted with the default (UTF-16 code unit) comparator — the same order
  // canonical() uses for object keys. canonical() sorts object keys but
  // preserves ARRAY order verbatim, so two logically identical module grants
  // given in a different order would otherwise serialise to different bytes
  // and produce two different (both individually valid) signatures for what
  // should be the exact same licence. Sorting here, once, is what makes the
  // payload deterministic in a way a plain object-key sort can't reach.
  //
  // A module string of "__proto__" is not special-cased: the only consumer of
  // licence.modules (server/services/control/state.js) keys a Set off these
  // values, never an object's own properties, so there is no prototype to
  // pollute. It is signed and verified as an ordinary string like any other.
  return Array.from(set).sort();
}

function computeValidUntil(days) {
  const n = Number(days);
  // NaN is a bug (a typo'd config, an unparsed form field), not a testing
  // tool — it must never reach new Date(), which would turn it into an
  // Invalid Date whose .toISOString() throws a RangeError far from here, with
  // no context about why. Zero and negative days ARE allowed, deliberately:
  // they issue a licence that is already expired, which is the only way to
  // test the lockout screen against a real signature instead of hand-editing
  // a file. This mirrors scripts/make-licence.mjs's own --days handling
  // exactly (see its `issue` case, which prints a note but does not block).
  if (!Number.isFinite(n)) {
    throw new Error(`signLicence: days must be a finite number, got ${JSON.stringify(days)}.`);
  }
  const until = new Date(Date.now() + n * DAY_MS);
  if (Number.isNaN(until.getTime())) {
    throw new Error(`signLicence: days ${n} works out to a date outside what a computer can represent.`);
  }
  return until.toISOString();
}

/**
 * Sign a licence document for one clinic. Byte-compatible with
 * scripts/make-licence.mjs's `issue` command: both build the same six-key
 * payload and sign canonical(payload) with the same Ed25519 key, so a
 * document produced here verifies against server/services/control/licence.js
 * exactly as one produced by the CLI would.
 *
 * @param {object}   args
 * @param {string}   args.clinicId
 * @param {string}  [args.clinicName]
 * @param {string[]} [args.modules]
 * @param {number}  [args.days=14]
 * @returns {{payload: object, sig: string}}
 */
export function signLicence({ clinicId, clinicName, modules, days = 14 }) {
  const payload = {
    clinic_id:   normaliseClinicId(clinicId),
    clinic_name: normaliseClinicName(clinicName),
    modules:     normaliseModules(modules),
    // Computed here, from the real clock, and from nothing else the caller
    // passed in — any other field on the caller's object (including a
    // `valid_until` of its own) is simply ignored by the destructuring above.
    // Accepting a caller-supplied expiry would turn this function into an API
    // for forging licences of any length.
    valid_until: computeValidUntil(days),
    issued_at:   new Date().toISOString(),
    nonce:       randomBytes(8).toString('hex'), // matches the CLI's nonce shape; makes every issuance unique
  };

  const key = getSigningKey();
  let sig;
  try {
    sig = sign(null, Buffer.from(canonical(payload), 'utf8'), key).toString('base64');
  } catch {
    // node:crypto's sign() doesn't embed key bytes in its own errors either,
    // but rethrowing our own message here means that guarantee doesn't depend
    // on OpenSSL's error formatting staying that way forever.
    throw new Error('signLicence: failed to sign the payload with the configured key.');
  }
  return { payload, sig };
}
