import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// LICENCE_CORE_V1 — unlocking a clinic over the telephone.
//
// A locked clinic usually has no internet — that is often WHY it locked. So the
// recovery path must work with nothing but a voice call: the clinic reads six
// characters out, the vendor types them into the panel and reads ten back.
//
// HMAC, not the Ed25519 licence signature, because an Ed25519 signature is 103
// characters when encoded and nobody is reading that down a phone line. HMAC
// means the clinic holds the secret and could in principle mint its own codes.
// That is inherent: verifying offline requires the material to verify with. The
// attempt limiter below stops casual guessing; someone who digs the secret out
// of their own disk was always going to win, and would have patched the check
// out instead.
//
// Ambiguous characters (I, O, 0, 1) are excluded because these codes are read
// aloud by people, over a phone, in a busy clinic.
//
// Exported (added under LICENCE_CORE_V1's enrollment task) so enrollment codes
// — also read aloud over a phone, to enroll a clinic in the first place — use
// this exact alphabet by import, not by a second hand-typed copy. This project
// already paid for that mistake once: scripts/make-licence.mjs originally
// re-typed this alphabet and reimplemented the HMAC derivation instead of
// importing expectedResponse() from here, and nothing forced the two copies to
// agree — see the "refactor: the CLI reimplemented the unlock code instead of
// importing it" commit. Exporting a constant is a smaller change than that
// refactor needed, but it is the same fix applied before the drift happens
// instead of after.
export const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 chars — power of two, see randomCode()

const KEY_CHALLENGE       = 'unlock_challenge';
const KEY_ATTEMPTS        = 'unlock_attempts';
const KEY_ATTEMPTS_SINCE  = 'unlock_attempts_since'; // when the current run of failures started
const KEY_EXTENSION       = 'offline_extension_until';

const MAX_ATTEMPTS   = 5;
const EXTENSION_DAYS = 14;

// ATTEMPT_LIMITER_RESET_V1 — the limiter resets on a timer, not only on success.
//
// A pure "5 wrong guesses, ever, until a correct code" limiter strands a real
// clinic: a receptionist mis-hears two of six characters over a bad phone line,
// burns the budget, and now has no internet AND no working unlock path — the
// exact clinic this feature exists for. That is worse than the guessing risk it
// prevents: 5 attempts against a 32^10-keyspace HMAC is not meaningfully weaker
// for a 1-hour window than it would be forever, but "forever" turns a typo into
// a support ticket that itself needs the phone to fix (the vendor would have to
// walk them through editing control_state by hand). So: budget resets 1 hour
// after the FIRST wrong guess in a run, not after each guess — a sustained
// brute-force attempt still only gets 5 tries/hour, but a human who fumbles the
// call can hang up and try again shortly after.
const ATTEMPT_RESET_MS = 60 * 60 * 1000;

function get(db, key) {
  return db.prepare('SELECT value FROM control_state WHERE key = ?').get(key)?.value ?? null;
}

function put(db, key, value) {
  db.prepare(`INSERT INTO control_state (key, value, updated_at)
              VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(key, String(value));
}

function del(db, key) {
  db.prepare('DELETE FROM control_state WHERE key = ?').run(key);
}

function randomCode(len) {
  // bytes[i] % ALPHABET.length is only unbiased because 256 (a byte's range) is
  // an exact multiple of ALPHABET.length (32). If the alphabet is ever edited to
  // a length that doesn't divide 256, this silently skews toward the low end of
  // the alphabet instead of failing loudly — so any change to ALPHABET must keep
  // its length a power of two no greater than 256, or replace this with a
  // rejection-sampling loop.
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

/** The six characters shown on the lock screen. Stable until a code is redeemed. */
export function currentChallenge(db) {
  let c = get(db, KEY_CHALLENGE);
  if (!c) { c = randomCode(6); put(db, KEY_CHALLENGE, c); }
  return c;
}

/**
 * The code the vendor reads back. Computed identically on both sides — the panel
 * runs this exact function.
 */
export function expectedResponse({ clinicId, challenge, secret }) {
  // An empty/missing secret must not crash the unlock screen — the whole point
  // of this file is that it is the recovery path when everything else is
  // broken, including possibly control.json. createHmac('sha256', '') is valid
  // (HMAC pads a short key), so an empty secret still produces a code — it will
  // just never match a legitimate vendor response, i.e. it fails closed rather
  // than throwing.
  const mac = createHmac('sha256', String(secret ?? '')).update(`${clinicId}:${challenge}`).digest();
  let out = '';
  for (let i = 0; i < 10; i++) out += ALPHABET[mac[i] % ALPHABET.length];
  return out.slice(0, 5) + '-' + out.slice(5);
}

/** How long an accepted unlock has bought this install, or null. */
export function extensionUntil(db) {
  return get(db, KEY_EXTENSION);
}

/**
 * Try an unlock code.
 * @returns {{ok:true, until:string} | {ok:false, reason:'bad_code'|'too_many_attempts'}}
 */
export function redeem(db, { code, clinicId, secret, now = new Date() }) {
  const nowMs = now instanceof Date ? now.getTime() : Date.now();

  const sinceRaw = get(db, KEY_ATTEMPTS_SINCE);
  const since = sinceRaw ? Number(sinceRaw) : null;
  let attempts = Number(get(db, KEY_ATTEMPTS) || 0);

  // A run of failures older than the reset window no longer counts — see
  // ATTEMPT_LIMITER_RESET_V1 above. This clears state up front so a stale
  // block from hours ago never falls through to "too_many_attempts" below.
  if (since !== null && nowMs - since >= ATTEMPT_RESET_MS) {
    attempts = 0;
    del(db, KEY_ATTEMPTS);
    del(db, KEY_ATTEMPTS_SINCE);
  }

  if (attempts >= MAX_ATTEMPTS) return { ok: false, reason: 'too_many_attempts' };

  const challenge = currentChallenge(db);
  // An unwritable control_state (disk full, read-only mount) means currentChallenge
  // still returns a value read moments ago in memory in the common case, but if the
  // table is truly gone db.prepare() throws — deliberately NOT caught here. There is
  // no safe fallback value to verify against; better to surface the failure than to
  // fabricate a challenge nothing was ever compared against.
  const expected = expectedResponse({ clinicId, challenge, secret });

  // Typed by a human off a phone call: case and spacing are not the point.
  const given = String(code ?? '').trim().toUpperCase().replace(/\s+/g, '');

  // timingSafeEqual throws on mismatched buffer lengths, so the length check
  // guards that, not security: the expected code is always "XXXXX-XXXXX" (11
  // chars), a fixed public format, so leaking "your guess was the wrong length"
  // through a fast path tells an attacker nothing they didn't already know from
  // reading this file. What must stay constant-time is comparing two guesses of
  // the SAME (correct) length against each other, which timingSafeEqual does.
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  const same = a.length === b.length && timingSafeEqual(a, b);

  if (!same) {
    if (attempts === 0) put(db, KEY_ATTEMPTS_SINCE, String(nowMs));
    put(db, KEY_ATTEMPTS, attempts + 1);
    return { ok: false, reason: 'bad_code' };
  }

  const until = new Date(nowMs + EXTENSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  put(db, KEY_EXTENSION, until);
  del(db, KEY_ATTEMPTS);
  del(db, KEY_ATTEMPTS_SINCE);
  put(db, KEY_CHALLENGE, randomCode(6));   // rotate — a used code must never work twice
  return { ok: true, until };
}
