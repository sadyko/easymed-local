// LICENCE_CORE_V1 — a clinic becomes a known, unique thing over the wire.
//
// This is the vendor side of first run: a clinic is created here (in the
// registry), gets a short code, and someone at the clinic reads that code back
// through the app once. redeemEnrollmentCode() turns that one-time code into a
// permanent install_token — the credential every later check-in presents.
//
// Deliberately signing-agnostic: this file knows nothing about Ed25519 or
// signLicence(). See redeemEnrollmentCode()'s `beforeCommit` hook for why that
// separation is also what makes the redemption safe to use with signing that
// can fail.

import { randomBytes } from 'node:crypto';
import { ALPHABET } from '../../../server/services/control/unlock.js';

// Same alphabet, same reason, as the telephone-unlock codes: both are read
// aloud over a phone (this one by whoever is setting the clinic up, reading
// the code the vendor gave them), so I/O/0/1 are excluded to avoid a
// mis-heard character. Imported rather than re-typed — see unlock.js's own
// comment on ALPHABET for the drift this project already got bitten by once.
const CODE_LEN = 8;          // split as XXXX-XXXX
const CODE_PREFIX = 'EM';    // a human glancing at the code can tell it's an Easy-Med one

// 8 characters from a 32-character alphabet is 32**8 ≈ 1.1 trillion possible
// codes. A retry loop this small is not a real collision handler at that
// scale — it exists so a genuine bug (a broken RNG, a shrunk alphabet) fails
// loudly with a clear error instead of spinning forever.
const MAX_CODE_ATTEMPTS = 5;

// Advisory only: fingerprint is never a lock (see redeemEnrollmentCode), so an
// absurd value must never cause a failure — either normalise it or drop it.
// A machine fingerprint has no legitimate reason to be longer than this; a
// caller sending more is almost certainly sending the wrong thing entirely
// (e.g. a whole system-info blob), and storing it as-is would let an
// unbounded, attacker-controlled string reach the vendor's own database.
const MAX_FINGERPRINT_LEN = 256;

let _testCodeGenerator = null;
/**
 * Tests force a specific (and specifically colliding) code sequence, to
 * exercise the retry-on-collision path deterministically without depending on
 * randomBytes() ever actually colliding. Never called in production — mirrors
 * the __setPublicKeyForTests seam in server/services/control/state.js.
 */
export function __setCodeGeneratorForTests(fn) { _testCodeGenerator = fn; }

function randomCode(alphabet, len) {
  // bytes[i] % alphabet.length is unbiased only because 256 (a byte's range)
  // is an exact multiple of alphabet.length (32) — same caveat as unlock.js's
  // own randomCode, which this deliberately mirrors rather than imports (it's
  // a different length and a different generic helper, not the same function).
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

function generateEnrollmentCode() {
  const raw = randomCode(ALPHABET, CODE_LEN);
  return `${CODE_PREFIX}-${raw.slice(0, 4)}-${raw.slice(4)}`;
}

function nextCode() {
  return _testCodeGenerator ? _testCodeGenerator() : generateEnrollmentCode();
}

// better-sqlite3 error shape verified directly: a UNIQUE violation throws with
// .code === 'SQLITE_CONSTRAINT_UNIQUE' and a .message of the form
// "UNIQUE constraint failed: <table>.<column>". Checking the column, not just
// the error code, is what lets a colliding GENERATED code be retried while a
// colliding CALLER-SUPPLIED clinic_id (the clinic already exists — a caller
// bug, or a genuine duplicate enrollment attempt) still throws.
function isUniqueViolation(e, column) {
  return !!e && e.code === 'SQLITE_CONSTRAINT_UNIQUE' &&
    typeof e.message === 'string' && e.message.includes(`clinics.${column}`);
}

/**
 * Create a clinic row and issue it a one-time enrollment code.
 *
 * @param {Database} db
 * @param {object} args
 * @param {string}  args.clinicId
 * @param {string}  args.name
 * @param {string} [args.contactPhone]
 * @param {string} [args.contactName]
 * @returns {string} the code, shaped EM-XXXX-XXXX
 */
export function createEnrollmentCode(db, { clinicId, name, contactPhone = null, contactName = null }) {
  if (typeof clinicId !== 'string' || clinicId.length === 0) {
    throw new Error(`createEnrollmentCode: clinicId must be a non-empty string, got ${JSON.stringify(clinicId)}.`);
  }
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error(`createEnrollmentCode: name must be a non-empty string, got ${JSON.stringify(name)}.`);
  }

  // The shared secret behind telephone unlock codes (see unlock.js). Generated
  // here — at enrollment — because the clinic has no unlock_secret of its own
  // to send us; the vendor is the one place both halves of that secret can
  // originate from the same source.
  const unlockSecret = randomBytes(32).toString('base64');

  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
    const code = nextCode();
    try {
      db.prepare(
        `INSERT INTO clinics (clinic_id, name, contact_phone, contact_name, enrollment_code, unlock_secret)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(clinicId, name, contactPhone, contactName, code, unlockSecret);
      return code;
    } catch (e) {
      if (isUniqueViolation(e, 'enrollment_code')) continue; // the astronomically unlikely case — try another code
      throw e; // anything else (most commonly: clinic_id already exists) is a real failure, not ours to retry
    }
  }
  throw new Error(`createEnrollmentCode: could not generate a unique code after ${MAX_CODE_ATTEMPTS} attempts.`);
}

// Typed by a human off a phone call: case and spacing are not the point, and
// this mirrors unlock.js's own redeem() normalisation exactly (same reasoning,
// same shape of input) rather than inventing a second convention.
function normaliseCode(code) {
  if (typeof code !== 'string') return ''; // wrong type entirely (object, number, array…) — never thrown, just never matches a real code
  return code.trim().toUpperCase().replace(/\s+/g, '');
}

// Advisory only — see MAX_FINGERPRINT_LEN above. Decision: a non-string value
// (absent, an object, a number) is dropped to null rather than coerced or
// rejected, because coercing (e.g. String(obj) => "[object Object]") would
// store a value that LOOKS like real fingerprint data but isn't, and rejecting
// would let something that carries zero security weight fail an enrollment
// that is otherwise perfectly valid. An oversized string is truncated, not
// rejected, for the same reason — it's just evidence, not a credential.
function normaliseFingerprint(fp) {
  if (typeof fp !== 'string' || fp.length === 0) return null;
  return fp.length > MAX_FINGERPRINT_LEN ? fp.slice(0, MAX_FINGERPRINT_LEN) : fp;
}

/**
 * Redeem a one-time enrollment code: single use, issues install_token.
 *
 * @param {Database} db
 * @param {object} args
 * @param {string}  args.code          as typed by a human — case/whitespace forgiven
 * @param {*}      [args.fingerprint]  advisory only; never a reason to fail
 * @param {object} [hooks]
 * @param {function({clinicId, clinicName, modules}): *} [hooks.beforeCommit]
 *   Runs INSIDE the same transaction that consumes the code, before anything
 *   is written. If it throws, db.transaction() rolls back everything this
 *   call would otherwise have written — the code stays valid and install_token
 *   stays unissued. This is the whole reason the hook exists: it is where the
 *   route plugs in signLicence(), so that a signing failure (e.g. no signing
 *   key configured) can NEVER leave a clinic enrolled with a burned code and
 *   no licence — see this function's own tests, and the task's own
 *   "what if signLicence throws after the code has been consumed" question.
 *   Its return value is passed through as `licence` on the result.
 * @returns {{
 *   clinic_id:string, clinic_name:string, install_token:string,
 *   unlock_secret:string, subscription:string, licence:*
 * } | null} null covers every invalid case uniformly — wrong, reused, unknown
 *   or malformed code, and the defensive already-has-a-token case below. The
 *   caller (routes/enroll.js) turns null into ONE generic failure response so
 *   none of these are distinguishable from outside.
 */
export function redeemEnrollmentCode(db, { code, fingerprint } = {}, { beforeCommit } = {}) {
  const normalisedCode = normaliseCode(code);
  const fp = normaliseFingerprint(fingerprint);
  if (!normalisedCode) return null; // empty/absent/wrong-typed — never worth a DB round-trip

  // ATOMICITY — better-sqlite3 is fully synchronous and Node is single-
  // threaded, so no OTHER request's JavaScript can run between the SELECT and
  // UPDATE below regardless of this wrapper: there is no `await` anywhere in
  // this function for another request's handler to be scheduled into. In that
  // sense db.transaction() here is not defending against concurrent HTTP
  // requests interleaving — that was never possible in this process.
  //
  // What db.transaction() actually buys is real: if beforeCommit (signLicence,
  // in production) throws, everything written before the throw — there is
  // nothing yet, since the UPDATE runs AFTER beforeCommit — is rolled back,
  // and more importantly nothing partial is ever committed if this function
  // is later restructured to write before signing. It also gives crash-
  // safety: if the process were killed between the SELECT and the UPDATE, an
  // uncommitted transaction leaves the row exactly as it was, never half-
  // consumed. Decoration would be doing this with two autocommit statements
  // and hoping nothing goes wrong in between; this doesn't have to hope.
  const txn = db.transaction(() => {
    const row = db.prepare(
      `SELECT clinic_id, name, unlock_secret, subscription, install_token
       FROM clinics WHERE enrollment_code = ?`
    ).get(normalisedCode);
    if (!row) return null; // wrong / unknown / already-redeemed (redemption clears enrollment_code to NULL, so a reused code matches nothing here)

    // DEFENSIVE — see this function's own doc comment. In normal operation
    // this is unreachable: enrollment_code is cleared in the SAME UPDATE that
    // sets install_token, so a row found BY a non-null enrollment_code should
    // never already carry a token. If it somehow does (hand-repaired data, a
    // bug elsewhere reintroducing a code), the decision is to refuse rather
    // than either silently minting a SECOND install_token for a clinic that
    // already has a working one (letting two installs share one identity) or
    // silently overwriting the existing token (breaking whichever install
    // already holds it). Refusing is the same generic failure as any other
    // invalid code from the outside — it leaks nothing new and forces a human
    // to look at the row directly instead of the API quietly picking a side.
    if (row.install_token) return null;

    const modules = db.prepare(
      `SELECT module_key FROM clinic_modules WHERE clinic_id = ? ORDER BY module_key`
    ).all(row.clinic_id).map((m) => m.module_key);

    // See the FAILURE-ORDERING doc comment above: this runs before the code
    // is touched. A throw here propagates straight out of txn() (and out of
    // db.transaction()'s automatic rollback) to the caller — nothing below
    // this line ever runs, and nothing above it needed rolling back because
    // nothing was written yet.
    const licence = beforeCommit
      ? beforeCommit({ clinicId: row.clinic_id, clinicName: row.name, modules })
      : null;

    const installToken = randomBytes(32).toString('base64');
    db.prepare(
      `UPDATE clinics SET enrollment_code = NULL, install_token = ?, last_fingerprint = ? WHERE clinic_id = ?`
    ).run(installToken, fp, row.clinic_id);

    return {
      clinic_id: row.clinic_id,
      clinic_name: row.name,
      install_token: installToken,
      unlock_secret: row.unlock_secret,
      subscription: row.subscription,
      licence,
    };
  });

  return txn();
}
