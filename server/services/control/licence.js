import { createPublicKey, verify } from 'node:crypto';
import { canonical } from './canonical.js';

// LICENCE_CORE_V1 — the vendor's Ed25519 public key, compiled into the app.
//
// Ed25519 is used because node:crypto has it built in: this project has exactly
// three runtime dependencies and licensing was not going to be the fourth.
//
// REPLACE THIS at first release with the real public key printed by
// `node scripts/make-licence.mjs keygen` (a later task builds that tool). The
// matching private key must never exist anywhere except the control plane. The
// placeholder below is a real, valid Ed25519 key whose private half was
// discarded, so an un-replaced build fails closed: no licence can ever verify
// against it.
//
// Installed 2026-08-20 so the local dev instance is usable: with the discarded
// placeholder in place, no licence could verify and the whole app sat read-only.
// Its private half lives in this machine's scratchpad and is worth nothing.
//
// Before the first real install the owner must run `make-licence.mjs keygen`,
// store that private key somewhere deliberate and backed up, and paste its public
// half here. Shipping THIS key would let anyone holding the throwaway private key
// license themselves. server/index.js logs a warning at every boot while it is in
// place — see DEV_KEY_FINGERPRINT there.
const VENDOR_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAXaSA2ArkuT/Ci1VjOzeCx/vsYZNiuKwsF1yceOrRCjM=
-----END PUBLIC KEY-----`;

let _defaultKey = null;
function defaultKey() {
  if (!_defaultKey) _defaultKey = createPublicKey(VENDOR_PUBLIC_KEY_PEM);
  return _defaultKey;
}

// Deliberately excludes '-' and '_': a base64url signature (as some tools emit)
// fails here as "malformed" rather than being silently mis-decoded as base64
// and handed to verify() with the wrong bytes. Checked with a test.
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Verify a licence document.
 *
 * @param {string|Buffer|null} raw   contents of data/licence.dat
 * @param {object}      opts
 * @param {KeyObject}  [opts.publicKey]  override for tests
 * @param {string}      opts.clinicId    who this install claims to be
 * @returns {{ok: true, licence: object} | {ok: false, reason: string}}
 *
 * NEVER throws. A clinic must not be unable to open its own patient list because
 * a licence file got truncated by a bad shutdown.
 */
export function verifyLicence(raw, { publicKey = null, clinicId } = {}) {
  let doc;
  try {
    // fs.readFileSync without an encoding hands back a Buffer, not a string.
    // String(buf) runs Buffer#toString('utf8'), so this also fixes the file
    // straight up: JSON.parse never sees a [object Object]. Pinned by a test.
    doc = JSON.parse(String(raw ?? ''));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!doc || typeof doc !== 'object') return { ok: false, reason: 'malformed' };

  const { payload, sig } = doc;
  if (!payload || typeof payload !== 'object') return { ok: false, reason: 'malformed' };
  if (typeof sig !== 'string' || !BASE64_RE.test(sig)) {
    return { ok: false, reason: 'malformed' };
  }

  let canonicalPayload;
  try {
    // canonical()'s serialize() recurses per nesting level with no depth limit.
    // A licence file is attacker-controlled input (or just corrupted), and a
    // JSON text a few thousand levels deep parses fine but blows the call stack
    // here (RangeError) — verified experimentally before this try/catch existed.
    // Without it, a single bad file would crash every read of the patient list.
    canonicalPayload = canonical(payload);
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  let good = false;
  try {
    good = verify(
      null,                                   // Ed25519 takes no digest algorithm
      Buffer.from(canonicalPayload, 'utf8'),
      publicKey || defaultKey(),
      Buffer.from(sig, 'base64'),
    );
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!good) return { ok: false, reason: 'bad_signature' };

  // Checked AFTER the signature so a forged file can never choose its own answer.
  if (payload.clinic_id !== clinicId) return { ok: false, reason: 'wrong_clinic' };

  return { ok: true, licence: payload };
}
