import { Router } from 'express';
import { randomBytes } from 'node:crypto';

// BRANCH_IDENTITY_V1 — mint a relay-scoped credential for a secondary branch.
//
// PRESENTED BY the MAIN branch, with its install_token: it is the one machine in
// the group that enrolled, so it is the only one with a vendor identity to prove.
// USED BY a secondary branch, which has none — it joined a clinic, not the
// vendor. The minted token reaches that branch inside the hand-carried branch
// key (services/branch-sync/pairing.js) and never through this server.
//
// WHAT THE MINTED TOKEN CAN DO, exhaustively: PUT and GET ONE relay id on
// /cp/v1/relay. It is refused on any other relay id, and it is refused by
// /cp/v1/checkin — which authenticates against clinics.install_token and never
// reads this table. That last property is what makes the whole design safe, and
// relay-token.route.test.js asserts it explicitly rather than trusting it.
//
// See db/migrations/006_relay_tokens.sql for why this exists at all, and for the
// two cheaper designs that were rejected.

export const RELAY_TOKEN_MOUNT = '/cp/v1/relay-token';

// The SAME format routes/relay.js enforces on the URL path. Deliberately stated
// here rather than imported FROM relay.js: relay.js imports clinicForRelayToken
// from this file, and importing back would make the two modules circular. The
// two are held in step by a test that compares both sources directly
// (relay-token.route.test.js), so this cannot drift unnoticed — which matters,
// because a mint route that accepted an id the relay route rejects would hand a
// clinic a live credential that mysteriously never works.
export const RELAY_ID_RE = /^[0-9a-f]{32}$/;

// 32 bytes of randomness — the same size as the install_token this is minted
// with (services/enrollment.js). base64url, not base64: this string is copied
// into the branch key a human carries between buildings, and '+', '/' and '='
// are exactly the characters that get mangled on that journey.
const TOKEN_BYTES = 32;

// SAME status, SAME body as routes/checkin.js's GENERIC_FAILURE_BODY and
// routes/relay.js's, byte-identical, for the same reason: missing, malformed,
// unknown and deactivated must be indistinguishable from the outside, so nothing
// here helps anyone work out which install_tokens are live.
const GENERIC_FAILURE_BODY = {
  error: { code: 'invalid_token', message: 'This install is not recognised.' },
};

// A ceiling on live tokens per (clinic, relay id). Minting is an authenticated
// write available to every enrolled clinic, and an unbounded write path is an
// unbounded table. A clinic has branches, not thousands of them: 64 is far above
// any real group and far below "this is now a storage problem". Refused with a
// DISTINCT error, not the generic 401 — the caller has already proved it is an
// enrolled clinic at that point, so a specific answer tells an attacker nothing
// and tells the clinic exactly what happened.
const MAX_LIVE_TOKENS_PER_RELAY = 64;

// `Authorization: Bearer <token>` and nothing else — the same reader relay.js
// and deploy.js use, including the case-insensitive scheme (RFC 7235) and the
// case-sensitive token.
function bearerToken(header) {
  const m = /^Bearer[ \t]+(\S+)$/i.exec(String(header || ''));
  return m ? m[1] : null;
}

export function relayTokenRouter(db, { now = () => new Date() } = {}) {
  const r = Router();

  r.post('/', (req, res) => {
    const presented = bearerToken(req.headers.authorization);
    if (!presented) return res.status(401).json(GENERIC_FAILURE_BODY);

    // The SAME SELECT services/checkin.js and routes/relay.js identify a clinic
    // with, `active = 1` included: only an ENROLLED, ACTIVE clinic may mint, and
    // a retired clinic loses the ability to mint at the same instant it loses
    // check-in, with no second switch for anyone to remember.
    //
    // Plain SQL equality on an indexed column, exactly like those two, and NOT
    // crypto.timingSafeEqual. That is a deliberate consistency, not laziness:
    // deploy.js uses timingSafeEqual because it compares against ONE configured
    // value it already holds in memory, which is a comparison you can make
    // constant-time. This is a lookup among rows the server does not know in
    // advance — making it constant-time would mean scanning every clinic on
    // every request, which is strictly worse and still leaks nothing useful,
    // since the token is 32 random bytes and the answer is dominated by B-tree
    // traversal rather than the final byte compare.
    const clinic = db.prepare('SELECT clinic_id FROM clinics WHERE install_token = ? AND active = 1').get(presented);
    if (!clinic) return res.status(401).json(GENERIC_FAILURE_BODY);

    // FORMAT-checked before anything can become a row. Not a lookup — the
    // control plane has no way to know which relay ids exist (they are HMACs of
    // a group key it has never seen), so this bounds what can be stored, and it
    // means a probing request is refused before it touches the database.
    const relayId = typeof req.body?.relay_id === 'string' ? req.body.relay_id : '';
    if (!RELAY_ID_RE.test(relayId)) {
      return res.status(400).json({
        error: { code: 'bad_relay_id', message: 'relay_id must be 32 lowercase hex characters.' },
      });
    }

    const live = db.prepare(
      'SELECT COUNT(*) n FROM relay_tokens WHERE clinic_id = ? AND relay_id = ? AND revoked_at IS NULL'
    ).get(clinic.clinic_id, relayId).n;
    if (live >= MAX_LIVE_TOKENS_PER_RELAY) {
      return res.status(409).json({
        error: { code: 'too_many_tokens', message: 'This clinic already has the maximum number of live relay tokens.' },
      });
    }

    // ADDITIVE, never rotating, and this is the decision the whole re-issue
    // story turns on. Every branch in a group shares ONE relay id (it is derived
    // from the one group key they all hold), so the main branch mints ONE TOKEN
    // PER BRANCH against the same id. If minting rotated — revoking what came
    // before — issuing a key to a third branch would silently cut off the
    // second, which is the opposite of what the owner asked for.
    //
    // Re-issuing the clinic's GROUP KEY still un-pairs every branch, exactly as
    // documented, and needs nothing from this route: a new group key produces a
    // new relay id (services/branch-sync/relay-crypto.js relayIdFor), and every
    // token minted against the old id is scoped to an address that no longer
    // exists. Individual revocation (revoked_at) is what un-pairs ONE branch
    // without disturbing the others.
    const minted = randomBytes(TOKEN_BYTES).toString('base64url');
    db.prepare(
      'INSERT INTO relay_tokens (token, clinic_id, relay_id, created_at) VALUES (?, ?, ?, ?)'
    ).run(minted, clinic.clinic_id, relayId, now().toISOString());

    // The ONLY time this value is ever sent anywhere. Everything after this is
    // the clinic's problem: it goes into the branch key by hand.
    res.status(201).json({ token: minted, relay_id: relayId });
  });

  return r;
}

/**
 * The clinic_id this relay token may act for ON THIS RELAY ID, or null.
 *
 * Used by routes/relay.js as the second, strictly weaker credential its
 * authentication accepts. Every condition below is load-bearing:
 *   - `relay_id = ?` is the scope. A token for one relay id is worthless on any
 *     other, so a leaked branch key cannot reach another group's blob.
 *   - `revoked_at IS NULL` is revocation, effective on the very next request.
 *   - the JOIN on clinics with `active = 1` is what stops a token outliving its
 *     clinic's deactivation. Without it, retiring a clinic would stop its
 *     check-in and its main branch's relay access while leaving every SECONDARY
 *     branch still reading and writing — a switch that only half works.
 *
 * @returns {string|null} clinic_id, or null for unknown / wrong id / revoked /
 *   deactivated — the caller collapses all of those into one generic 401.
 */
export function clinicForRelayToken(db, token, relayId, { now = () => new Date() } = {}) {
  if (typeof token !== 'string' || token.length === 0) return null;
  // Re-checked here and not only in the caller: this function is exported, and a
  // future caller that forgot to validate must not be able to turn an arbitrary
  // string into a database round-trip.
  if (typeof relayId !== 'string' || !RELAY_ID_RE.test(relayId)) return null;

  const row = db.prepare(
    `SELECT t.clinic_id
       FROM relay_tokens t
       JOIN clinics c ON c.clinic_id = t.clinic_id
      WHERE t.token = ? AND t.relay_id = ? AND t.revoked_at IS NULL AND c.active = 1`
  ).get(token, relayId);
  if (!row) return null;

  // Best-effort, for exactly the reason routes/relay.js's read_at touch is
  // best-effort: a failed bookkeeping write must never cost a branch its
  // catalogue. Not throttled — a branch polls the relay about four times a day
  // (services/branch-sync/relay.js INTERVAL_MS = 6h), and the same request
  // already writes relay_blobs.read_at, so this is not a new class of cost.
  try {
    db.prepare('UPDATE relay_tokens SET last_used = ? WHERE token = ?').run(now().toISOString(), token);
  } catch (e) {
    console.warn('[control-plane] could not record a relay-token use:', e && e.message);
  }

  return row.clinic_id;
}
