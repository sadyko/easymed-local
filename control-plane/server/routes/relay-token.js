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
// WHAT THE MINTED TOKEN CAN DO, exhaustively: PUT and GET the relay ids IN ITS
// SCOPE on /cp/v1/relay. It is refused on every other relay id, and it is
// refused by /cp/v1/checkin — which authenticates against clinics.install_token
// and never reads this table. That last property is what makes the whole design
// safe, and relay-token.route.test.js asserts it explicitly rather than trusting
// it.
//
// THE SCOPE IS A SET, AND WAS A SINGLE ADDRESS UNTIL PHASE 2 (Задача 7a). A
// token belongs to a BRANCH, not to an address. While the whole group shared one
// relay address — the catalogue — those two statements were the same thing, so
// 006 stored the address in a column and checked it there. Phase 2 gives every
// branch its own address for its journal (services/branch-sync/relay-crypto.js
// relayIdFor(key, letter)), and a secondary branch must write its own and read
// every peer's; under the old rule every one of those requests was a 401, which
// the clinic app reports as "the main branch revoked your access" — a wrong
// remedy for a code bug, and invisible on one machine, because the main branch
// authenticates on install_token, which is not scoped to an address at all.
// See db/migrations/008_relay_token_scopes.sql, including why this is NOT one
// token per address (that grows as N² and hits the per-clinic cap at nine
// branches).
//
// WHAT IT DOES GIVE AWAY, stated plainly: a clinic can mint a token for relay
// ids it does not own and hand that token to somebody else, delegating a narrow
// "read and write THESE relay ids" capability without handing over its own
// identity. That is a delegation of access the clinic already had — any enrolled
// clinic can already reach any relay id it knows with its install_token (see
// routes/relay.js's own note on clinic scoping) — not an escalation, and it is
// bounded to the ids named at mint time and never widened afterwards. It is
// written down because it is the one thing this credential makes possible that
// proxying through the clinic did not.
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

// THE HARD BOUND ON THIS TABLE: live tokens per CLINIC, across every relay id.
//
// Per clinic and NOT per (clinic, relay id), and the difference is the whole
// point. relay_id arrives in the request body out of a 2^128 space, so a
// per-relay-id cap bounds nothing at all — one enrolled clinic simply names a
// new id each time and writes rows for ever. Measured before this was fixed:
// 3,000 permanent rows in 1.77 s from a single install_token, and no 409 in
// sight. Counted per clinic, the table cannot exceed clinics x 64 rows no matter
// what any caller sends.
//
// Why this matters more than the number suggests — app.js's own header: if this
// service's disk fills, check-in stops, and every clinic in the country starts
// its 14-day licence countdown at the same moment.
//
// 64 is far above any real clinic (branches are counted in ones and tens) and far
// below a storage problem. A clinic that burns slots by re-pairing reclaims them
// automatically: pruneRelayTokens runs on the way in, before the count below.
const MAX_LIVE_TOKENS_PER_CLINIC = 64;

// THE BOUND ON ONE TOKEN'S SCOPE: how many relay ids a single mint may name.
//
// The same 64, and deliberately the same number rather than a coincidence: a
// branch's scope is the catalogue plus one address per branch in the group, so
// this is the same "how large can one clinic's network be" question the cap
// above answers, asked about rows instead of tokens. Together they bound this
// half of the schema at clinics x 64 tokens x 64 grants — with a real network
// (branches counted in ones and tens) using a handful of each.
//
// It is a REFUSAL, not a truncation. Minting a token with half the addresses the
// caller asked for would hand a branch a credential that works for some of its
// peers and 401s for the rest, which on the clinic screen reads as "your access
// was revoked" for half the network — a fault nobody could diagnose from the
// outside. A 400 says exactly what happened, and the clinic app trims its own
// list before it ever asks (services/branch-sync/relay.js).
// Exported for the drift test in services/branch-sync/relay-e2e.test.js — the one
// file that imports both halves. The clinic app trims its list by ITS copy of
// this number and this route refuses by this one: were the client's larger, a
// whole network would get a 400 and no token at all; were it smaller, the client
// would silently drop peers this route would have accepted.
export const MAX_SCOPE = 64;

// How long an unused token survives. Deliberately the same 30 days
// routes/relay.js gives a blob, and for the same reason: a branch polls the
// relay every 6 hours (services/branch-sync/relay.js INTERVAL_MS), so 30 days of
// total silence means the branch is gone, the group key was re-issued (which
// changes the relay id and orphans every token scoped to the old one), or the
// key was minted and never carried to a branch at all. A token still in use is
// never touched — the window runs from LAST USE, not from issue.
const DEFAULT_TOKEN_RETENTION_DAYS = 30;

// Per-IP throttle on minting. Same shape as routes/enroll.js and
// routes/vendor-auth.js — an in-memory counter, not a table — but a looser limit
// and a different reason: those two are guessing defences on unauthenticated
// endpoints, while this one authenticates before it writes anything. The hard
// bound here is MAX_LIVE_TOKENS_PER_CLINIC above; this only stops one
// authenticated caller turning that bound into a burst of database writes, and
// 20/minute still lets an owner set up a dozen branches in one sitting.
const IP_WINDOW_MS = 60 * 1000;
const IP_LIMIT = 20;
const IP_MAX_TRACKED = 200; // bounds the map's memory against a spoofed-IP flood

// `Authorization: Bearer <token>` and nothing else — the same reader relay.js
// and deploy.js use, including the case-insensitive scheme (RFC 7235) and the
// case-sensitive token.
function bearerToken(header) {
  const m = /^Bearer[ \t]+(\S+)$/i.exec(String(header || ''));
  return m ? m[1] : null;
}

/**
 * The scope a mint request asks for, or null if the request cannot have one.
 *
 * ALL OR NOTHING, deliberately: one malformed address refuses the whole mint
 * rather than quietly dropping that one. See MAX_SCOPE for why a partly-granted
 * scope is the worst outcome on offer.
 *
 * Duplicates are folded, not refused. The clinic app derives the scope from the
 * group key — the catalogue address plus one node address per branch letter —
 * and sends the same id twice whenever a letter it was handed is also one the
 * alphabet already covers. That is an ordinary request, and answering it with an owner-visible
 * refusal would be a bug report about nothing. The cap is applied to what was
 * ASKED FOR, before folding: 65 addresses is over the line whether or not some
 * of them repeat.
 *
 * @returns {string[]|null} 1..MAX_SCOPE distinct relay ids, first one first
 */
function scopeFromBody(body) {
  // A `relay_ids` that is present but is not a list is a REFUSAL, never a
  // fall-through to `relay_id`. Both fields arrive together from the clinic app,
  // so falling through would answer a broken scope request with a working
  // catalogue-only token — the branch would be 401ed on every node address and
  // its owner told the main branch had revoked it. Silently narrower is the one
  // outcome worse than a refusal here.
  if (body != null && body.relay_ids !== undefined && !Array.isArray(body.relay_ids)) return null;

  const asked = Array.isArray(body?.relay_ids)
    ? body.relay_ids
    : (typeof body?.relay_id === 'string' ? [body.relay_id] : null);
  if (!asked || asked.length === 0 || asked.length > MAX_SCOPE) return null;

  const out = [];
  for (const raw of asked) {
    if (typeof raw !== 'string' || !RELAY_ID_RE.test(raw)) return null;
    if (!out.includes(raw)) out.push(raw);
  }
  return out;
}

/**
 * Delete tokens nobody has used in `days`, and revocations older than that.
 *
 * Exported for the same reason pruneRelayBlobs is: retention that only runs as a
 * side effect of traffic is retention nobody can test or trigger. Called on
 * every mint — one DELETE on a table that is bounded by construction, cheaper
 * than a scheduler, and it runs exactly when the table is growing.
 *
 * Running it BEFORE the cap check is what stops a clinic being stranded: an
 * owner who re-paired a branch a dozen times over a year does not need to call
 * the vendor to free the slots, because the attempt that would hit the cap is
 * the attempt that reclaims them.
 *
 * @returns {number} rows removed
 */
export function pruneRelayTokens(db, { days = DEFAULT_TOKEN_RETENTION_DAYS, now = () => new Date() } = {}) {
  const cutoff = new Date(now().getTime() - days * 24 * 60 * 60 * 1000).toISOString();
  try {
    // COALESCE(last_used, created_at) — a token minted this morning and not yet
    // carried across to the branch must not be swept, and a token in daily use
    // must not be swept however old it is. Revoked rows are kept for the same
    // window, as evidence of WHEN a branch was cut off, and then dropped.
    const info = db.prepare(
      `DELETE FROM relay_tokens
        WHERE COALESCE(last_used, created_at) < ?
           OR (revoked_at IS NOT NULL AND revoked_at < ?)`
    ).run(cutoff, cutoff);
    return info.changes;
  } catch (e) {
    // Housekeeping must never fail the mint it is attached to — pruneRelayBlobs'
    // own rule. A clinic adding a branch does not care that last year's dead
    // token is still there; it cares very much that its branch key was issued.
    console.warn('[control-plane] relay token retention sweep failed:', e && e.message);
    return 0;
  }
}

export function relayTokenRouter(db, { now = () => new Date() } = {}) {
  const r = Router();
  const ipAttempts = new Map(); // ip -> { count, windowStart }

  // Copied from routes/enroll.js rather than reinvented, down to the
  // delete-then-set that keeps Map iteration order oldest-first for eviction.
  function ipThrottled(ip) {
    const at = Date.now();
    const e = ipAttempts.get(ip) || { count: 0, windowStart: at };
    if (at - e.windowStart > IP_WINDOW_MS) { e.count = 0; e.windowStart = at; }
    e.count += 1;
    ipAttempts.delete(ip);
    ipAttempts.set(ip, e);
    if (ipAttempts.size > IP_MAX_TRACKED) {
      for (const [k, v] of ipAttempts) {
        if (ipAttempts.size <= IP_MAX_TRACKED) break;
        if (at - v.windowStart > IP_WINDOW_MS) ipAttempts.delete(k);
      }
    }
    return e.count > IP_LIMIT;
  }

  r.post('/', (req, res) => {
    // Before authentication, exactly as in enroll.js. This answer depends only
    // on how many times this IP has called, never on whether the token it
    // presented was any good, so it tells nobody which tokens are live.
    if (ipThrottled(req.ip)) {
      return res.status(429).json({ error: { code: 'too_many_attempts', message: 'Too many attempts. Try again later.' } });
    }

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
    //
    // TWO SHAPES, ONE MEANING. `relay_ids` is the scope a branch asks for;
    // `relay_id` is the same request with one address in it, and it is still
    // read because it is what every clinic in the field sends today — the client
    // half of this change ships separately from this server, and a deploy that
    // 400ed those callers would strand every clinic mid-upgrade. The clinic app
    // sends BOTH for the same reason in reverse (an older control plane reads
    // relay_id and ignores the rest), so `relay_ids` wins whenever it is there.
    const relayIds = scopeFromBody(req.body);
    if (!relayIds) {
      return res.status(400).json({
        error: {
          code: 'bad_relay_id',
          message: `relay_ids must be 1 to ${MAX_SCOPE} relay ids of 32 lowercase hex characters.`,
        },
      });
    }
    // The first is the PRIMARY address — the catalogue, as the clinic app orders
    // them — and the one that stays in relay_tokens.relay_id for display and for
    // what an older caller reads back.
    const relayId = relayIds[0];

    // Reclaim first, then count — see pruneRelayTokens for why this ordering is
    // what keeps a re-pairing clinic from being stranded behind the cap.
    pruneRelayTokens(db, { now });

    const live = db.prepare(
      'SELECT COUNT(*) n FROM relay_tokens WHERE clinic_id = ? AND revoked_at IS NULL'
    ).get(clinic.clinic_id).n;
    if (live >= MAX_LIVE_TOKENS_PER_CLINIC) {
      return res.status(409).json({
        error: { code: 'too_many_tokens', message: 'This clinic already has the maximum number of live relay tokens.' },
      });
    }

    // ADDITIVE, never rotating, and this is the decision the whole re-issue
    // story turns on. Every address in a group is derived from the one group key
    // they all hold, so branches SHARE addresses — the catalogue, and since
    // Задача 7a every node's journal address too. The main branch therefore
    // mints ONE TOKEN PER BRANCH over those shared addresses. If minting rotated
    // — revoking what came before — issuing a key to a third branch would
    // silently cut off the second, which is the opposite of what the owner asked
    // for.
    //
    // Re-issuing the clinic's GROUP KEY still un-pairs every branch, exactly as
    // documented, and needs nothing from this route: a new group key produces
    // new relay ids for every node (services/branch-sync/relay-crypto.js
    // relayIdFor), and every token minted before is scoped to addresses that no
    // longer exist. Individual revocation (revoked_at) is what un-pairs ONE branch
    // without disturbing the others.
    const minted = randomBytes(TOKEN_BYTES).toString('base64url');
    // ONE TRANSACTION, and it has to be: a token row without its grants is a
    // credential that is refused everywhere — issued, carried to another
    // building by hand, and dead on arrival with no way to tell it apart from a
    // revoked one. A grant without its token cannot happen (the foreign key),
    // which is the other half of the same argument.
    db.transaction(() => {
      db.prepare(
        'INSERT INTO relay_tokens (token, clinic_id, relay_id, created_at) VALUES (?, ?, ?, ?)'
      ).run(minted, clinic.clinic_id, relayId, now().toISOString());
      const grant = db.prepare('INSERT INTO relay_token_scopes (token, relay_id) VALUES (?, ?)');
      for (const id of relayIds) grant.run(minted, id);
    })();

    // The ONLY time this value is ever sent anywhere. Everything after this is
    // the clinic's problem: it goes into the branch key by hand.
    //
    // `relay_id` is kept alongside `relay_ids` for the caller that only knows
    // the old field — same reason the request accepts both.
    res.status(201).json({ token: minted, relay_id: relayId, relay_ids: relayIds });
  });

  return r;
}

/**
 * The clinic_id this relay token may act for ON THIS RELAY ID, or null.
 *
 * Used by routes/relay.js as the second, strictly weaker credential its
 * authentication accepts. Every condition below is load-bearing:
 *   - the EXISTS over relay_token_scopes is the scope. A token is worthless on
 *     an address it was not minted for, so a leaked branch key cannot reach
 *     another group's blobs — the set got wider (Задача 7a: a branch needs its
 *     own node address and every peer's, not just the catalogue), the rule that
 *     it is checked on every single request did not change.
 *   - `revoked_at IS NULL` is revocation, effective on the very next request,
 *     and it stays on the TOKEN: one UPDATE cuts a branch off at every address
 *     at once. Revocation spread over the grant rows would have made "un-pair
 *     this branch" a multi-row operation that could half-finish, leaving a
 *     branch that still reaches some of the group.
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
      WHERE t.token = ?
        AND EXISTS (SELECT 1 FROM relay_token_scopes s WHERE s.token = t.token AND s.relay_id = ?)
        AND t.revoked_at IS NULL AND c.active = 1`
  ).get(token, relayId);
  if (!row) return null;

  // Best-effort, for exactly the reason routes/relay.js's read_at touch is
  // best-effort: a failed bookkeeping write must never cost a branch its
  // catalogue. Not throttled — a branch polls the relay about four times a day
  // (services/branch-sync/relay.js INTERVAL_MS = 6h), and the same request
  // already writes relay_blobs.read_at, so this is not a new class of cost.
  // It is also what keeps the row alive: pruneRelayTokens sweeps on LAST USE.
  try {
    db.prepare('UPDATE relay_tokens SET last_used = ? WHERE token = ?').run(now().toISOString(), token);
  } catch (e) {
    console.warn('[control-plane] could not record a relay-token use:', e && e.message);
  }

  return row.clinic_id;
}
