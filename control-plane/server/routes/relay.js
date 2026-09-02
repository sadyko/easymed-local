import express, { Router } from 'express';
import { clinicForRelayToken } from './relay-token.js';   // BRANCH_IDENTITY_V1

// BRANCH_SYNC_RELAY_V1 — the relay. Stores one opaque blob per branch group and
// hands it back. That is the entire feature.
//
// WHY IT EXISTS. Branch sync (Route A) has the branches talk to each other
// directly, and patient data never leaves the clinic's own machines. It cannot
// work when two buildings sit on unrelated internet connections with no VPN —
// they simply cannot see each other. This route is the fallback: the main branch
// PUTs an encrypted catalogue here, the other branch GETs it.
//
// THE ONE RULE THIS FILE MUST NEVER BREAK: this service cannot read what it
// stores, and no future change may make it able to. The bytes are AES-256-GCM
// under a key generated inside the clinic at activation, carried to the second
// branch by hand inside the pairing key, and never sent here — not at
// enrollment, not at check-in, never. So this route:
//   - never parses the body (express.raw, straight into a BLOB column);
//   - never inspects, transcodes, compresses or validates the payload;
//   - has no code path that could produce plaintext even if someone asked.
// A test asserts it: a marker string seeded into the source clinic's database
// must appear nowhere in the bytes this service holds.
//
// The honest cost, recorded here so it cannot be quietly forgotten: A CLINIC
// THAT LOSES ITS KEY CANNOT GET THIS DATA BACK, AND THE VENDOR CANNOT HELP.
// The clinic's own screen says so before the owner relies on it.
//
// WHAT THE VENDOR *CAN* SEE, stated plainly: that a given install uploaded or
// downloaded, when, how large it was, and that some set of installs share a
// relay id. Nothing about services, prices, patients or money.
//
// AUTHENTICATION is the install_token from control.json — the SAME credential
// the daily check-in presents, looked up the same way (services/checkin.js's
// rule 1: unknown, deactivated and malformed all collapse to one generic 401,
// so nobody can probe which tokens are live). Deliberately not a second scheme:
// a clinic has exactly one identity with the vendor, and a relay is no reason to
// issue it another.
//
// BRANCH_IDENTITY_V1 — with ONE exception, added when real branch installs
// arrived: a RELAY TOKEN (routes/relay-token.js) is also accepted, and only ever
// for the single relay id it was minted against. It exists because a SECONDARY
// branch never enrols — it joins a clinic, not the vendor — so it has no
// install_token and could not use this route at all. It is NOT a second identity
// with the vendor: it names no clinic to check-in, carries no entitlement, and is
// refused by /cp/v1/checkin, which never looks at the relay_tokens table. The
// alternative — putting the clinic's install_token in the branch key — would
// have made every branch PC able to impersonate the clinic completely. See
// db/migrations/006_relay_tokens.sql for the full argument.
//
// WHAT AUTHENTICATION HERE DOES *NOT* DO, stated so this file cannot be read as
// promising more than it delivers: it identifies the CALLER, it does not bind a
// caller to a relay id. Any enrolled, active clinic that knows a relay id can
// read and overwrite the blob at it, including one belonging to another clinic —
// demonstrated end to end, and true since this route shipped (v0.4.5). The
// address is the capability: a relay id is 128 bits derived from a 256-bit key
// generated inside the clinic and never sent here, so learning one in practice
// means already holding either this server's database (which carries every
// install_token, a strictly worse compromise) or the victim's own group key
// (which decrypts the blob outright, making an overwrite the least of it).
//
// FIRST-WRITER-WINS WAS CONSIDERED AND NOT TAKEN. relay_blobs.clinic_id already
// records a writer, so refusing a PUT from a different clinic is cheap — but the
// clinic_id is OURS, not the group's, and it legitimately changes: a clinic that
// re-enrols after a rebuild keeps its data directory, hence its group key, hence
// its relay id, but gets a NEW clinic_id. Locking that install out of its own
// blob would be a silent, total, self-inflicted sync failure for a clinic that
// did nothing wrong, recoverable only by a vendor hand-editing a row — and
// deployed onto a live relay it would strand, on the spot, every existing blob
// whose recorded writer has since changed. A worse failure, aimed at innocent
// clinics, to raise the cost of an attack that already presupposes a bigger
// breach. So the change of hands is made LOUD instead of impossible (below), and
// the real fix — binding a relay id to a group identity the clinic proves rather
// than to a vendor-assigned clinic_id — is left as a design change for Stage 2,
// where the branch group gets an identity of its own.

export const RELAY_MOUNT = '/cp/v1/relay';

// The path shape, kept identical to the clinic's own relay.js. Two copies of a
// URL drift, and the day they drift the symptom is a 404 that reads as "the
// vendor does not support the fallback route".
export const relayPathFor = (relayId) => `${RELAY_MOUNT}/${relayId}`;

// 32 lowercase hex characters — the clinic derives it as HMAC-SHA256(group key)
// truncated to 16 bytes (server/services/branch-sync/relay-crypto.js). Enforced
// here as a FORMAT, not as a lookup: it bounds what can become a primary key,
// and it means a probing request is refused before it touches the database.
export const RELAY_ID_RE = /^[0-9a-f]{32}$/;

// The hard ceiling on one blob. A gzipped catalogue with a clinic logo in it is
// a few hundred kilobytes; 12 MB is "an implausibly large clinic" and, more to
// the point, a fixed number rather than "however much RAM this process has".
// Read per request so it can be raised on a running server without a code
// change — same reasoning as deploy.js's own bundle cap.
const DEFAULT_MAX_RELAY_BYTES = 12 * 1024 * 1024;

// How long an untouched blob survives. Storage that only ever grows is a slow
// outage, and a group that stopped using the relay a month ago is not coming
// back to the same blob — its clinic re-uploads whenever it syncs. Counted from
// the LAST TOUCH (upload or download), never from the upload alone: a group
// whose price list has not changed in six weeks is still reading its blob every
// day, and pruning that would break a working link. The clinic re-publishes at
// least daily anyway (relay.js REFRESH_MS), so 30 days is a wide margin.
const DEFAULT_RETENTION_DAYS = 30;

function maxRelayBytes(env = process.env) {
  const n = Number(env.EASYMED_CP_MAX_RELAY_BYTES);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_RELAY_BYTES;
}

function retentionDays(env = process.env) {
  const n = Number(env.EASYMED_CP_RELAY_RETENTION_DAYS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RETENTION_DAYS;
}

// `Authorization: Bearer <token>` and nothing else — the same reader deploy.js
// uses, including the case-insensitive scheme (RFC 7235) and the case-sensitive
// token.
function bearerToken(header) {
  const m = /^Bearer[ \t]+(\S+)$/i.exec(String(header || ''));
  return m ? m[1] : null;
}

// SAME status, SAME body for missing, malformed, unknown and deactivated —
// byte-identical to routes/checkin.js's GENERIC_FAILURE_BODY and for the same
// reason: nothing here may help someone work out which install_tokens are live.
const GENERIC_FAILURE_BODY = {
  error: { code: 'invalid_token', message: 'This install is not recognised.' },
};
const NOT_FOUND_BODY = { error: { code: 'not_found', message: 'Unknown API endpoint.' } };

/**
 * Delete blobs nobody has touched in `days`.
 *
 * Exported because retention that only runs as a side effect of traffic is
 * retention nobody can test or trigger. Called on every upload (one indexed
 * DELETE on a table with one row per branch group — cheaper than a scheduler,
 * and it runs exactly when the table is growing).
 *
 * @returns {number} rows removed
 */
export function pruneRelayBlobs(db, { days = DEFAULT_RETENTION_DAYS, now = () => new Date() } = {}) {
  const cutoff = new Date(now().getTime() - days * 24 * 60 * 60 * 1000).toISOString();
  try {
    // max(updated_at, read_at) — see DEFAULT_RETENTION_DAYS above for why a
    // blob that is only ever READ must not age out.
    const info = db.prepare(
      `DELETE FROM relay_blobs WHERE max(updated_at, COALESCE(read_at, updated_at)) < ?`
    ).run(cutoff);
    return info.changes;
  } catch (e) {
    // Housekeeping must never fail the upload it is attached to. A clinic
    // syncing its branches does not care that yesterday's dead blob is still
    // there; it very much cares that its own upload succeeded.
    console.warn('[control-plane] relay retention sweep failed:', e && e.message);
    return 0;
  }
}

export function relayRoutes(db, { env = process.env, now = () => new Date() } = {}) {
  const r = Router();

  // Authentication runs BEFORE the body parser below, on purpose and for the
  // same reason as deploy.js: an unauthenticated caller must never make this
  // process buffer megabytes. It also means a refused request cannot possibly
  // have stored anything, because nothing has even been read yet.
  // Mounted on '/:relayId', not bare, and that is load-bearing rather than
  // cosmetic. The relay-token fallback below has to know WHICH relay id is being
  // asked for, and this is the only way to learn it from EXPRESS ITSELF — the
  // same parse, the same percent-decoding, the same value the handlers below
  // read out of req.params. A hand-rolled reader of req.url (this file had one
  // for exactly one commit) is a second URL parser that can disagree with the
  // first about fragments, absolute-form request targets and %-escapes; the day
  // it disagrees, the id the scope was CHECKED against is not the id the blob is
  // STORED under. One parser, no daylight.
  //
  // Consequence worth noting: a request to the mount root itself (no relay id at
  // all) no longer reaches this middleware, so it answers 404 — for everyone.
  // That is strictly better than what it did before: it used to answer 401 to an
  // unknown token and 404 to a valid one, which made the bare mount path a
  // one-bit oracle for "is this install_token live".
  r.use('/:relayId', (req, res, next) => {
    const token = bearerToken(req.headers.authorization);
    if (!token) return res.status(401).json(GENERIC_FAILURE_BODY);
    // The same SELECT services/checkin.js identifies a clinic with, including
    // `active = 1`: a retired clinic loses the relay exactly when it loses
    // check-in, with no second switch to remember.
    const clinic = db.prepare('SELECT clinic_id FROM clinics WHERE install_token = ? AND active = 1').get(token);
    if (clinic) {
      req.relayClinicId = clinic.clinic_id;
      return next();
    }

    // BRANCH_IDENTITY_V1 — the fallback, tried ONLY after the install_token
    // lookup has already failed, so the enrolled main branch's path is exactly
    // what it was before this existed.
    //
    // Checked against the relay id in THIS request's path, every request: the
    // token is accepted only if that id is in the scope it was minted with, and
    // the same token presented for any other id gets the same generic 401 as a
    // token that was never issued. clinicForRelayToken also refuses a revoked
    // token and one whose clinic has been deactivated, so a retired clinic loses
    // the relay for EVERY branch at once, not just for the one holding the
    // install_token.
    //
    // THE SCOPE IS A SET SINCE Задача 7a (db/migrations/008_relay_token_scopes.sql),
    // because a branch now has an address of its own for its journal and must
    // reach its peers' too. Nothing here changed: this middleware still asks the
    // same question about the same single id, and gets a yes or a no.
    //
    // req.params.relayId — express's own parse, byte-identical to what the PUT
    // and GET handlers below will use as the storage key. See the mount comment.
    const relayId = String(req.params.relayId || '');
    const viaRelayToken = RELAY_ID_RE.test(relayId) ? clinicForRelayToken(db, token, relayId, { now }) : null;
    if (!viaRelayToken) return res.status(401).json(GENERIC_FAILURE_BODY);
    req.relayClinicId = viaRelayToken;
    next();
  });

  // Mounted INSIDE this router (which app.js mounts ABOVE the global 100kb JSON
  // parser) so exactly two paths in the control plane accept a large body, and
  // every other endpoint keeps its tight ceiling.
  //
  // type:'*/*' — whatever the clinic labels it, this is an opaque byte string
  // and is treated as one. There is deliberately no content-type negotiation:
  // negotiating implies caring what is inside.
  const raw = express.raw({ type: '*/*', limit: maxRelayBytes(env) });

  r.put('/:relayId', raw, (req, res) => {
    const relayId = String(req.params.relayId || '');
    if (!RELAY_ID_RE.test(relayId)) return res.status(404).json(NOT_FOUND_BODY);

    const bytes = req.body;
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
      return res.status(400).json({ error: { code: 'bad_request', message: 'The body must be the encrypted blob.' } });
    }
    if (bytes.length > maxRelayBytes(env)) {
      return res.status(413).json({ error: { code: 'too_large', message: 'The blob is larger than this server accepts.' } });
    }

    // A blob changing hands has exactly two causes: a clinic that re-enrolled
    // (same data directory, same group key, same relay id, new clinic_id) and is
    // republishing its own catalogue, or one clinic overwriting another's. The
    // first is rare and legitimate; the second is an attack, and this route
    // cannot tell them apart — see this file's header for why it refuses neither.
    //
    // So it is logged, LOUDLY (console.error, the same register as check-in's
    // automatic release halt), because the one thing worse than a cross-clinic
    // overwrite is a cross-clinic overwrite nobody can see afterwards. Never the
    // bytes, never the size — the relay id and the two clinic ids are metadata
    // this service already holds. Best-effort: bookkeeping must not fail an
    // upload (the same rule as the read_at touch below).
    try {
      const held = db.prepare('SELECT clinic_id FROM relay_blobs WHERE relay_id = ?').get(relayId);
      if (held && held.clinic_id !== req.relayClinicId) {
        console.error(
          `[control-plane] RELAY BLOB CHANGED HANDS: relay ${relayId} was written by clinic ` +
          `${held.clinic_id} and is now being overwritten by clinic ${req.relayClinicId}. ` +
          `Expected only after a re-enrolment; otherwise check the registry.`
        );
      }
    } catch (e) {
      console.warn('[control-plane] could not check relay blob ownership:', e && e.message);
    }

    // ONE row per group, replaced wholesale. No history, no versions, no second
    // copy: the relay is a letterbox, not an archive, and every extra copy of a
    // clinic's data on the vendor's disk is a copy that has to be justified.
    db.prepare(
      `INSERT INTO relay_blobs (relay_id, clinic_id, bytes, size, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(relay_id) DO UPDATE SET
         clinic_id = excluded.clinic_id,
         bytes = excluded.bytes,
         size = excluded.size,
         updated_at = excluded.updated_at`
    ).run(relayId, req.relayClinicId, bytes, bytes.length, now().toISOString());

    // Retention runs here rather than on a timer — see pruneRelayBlobs.
    pruneRelayBlobs(db, { days: retentionDays(env), now });

    res.status(200).json({ ok: true, size: bytes.length });
  });

  r.get('/:relayId', (req, res) => {
    const relayId = String(req.params.relayId || '');
    if (!RELAY_ID_RE.test(relayId)) return res.status(404).json(NOT_FOUND_BODY);

    const row = db.prepare('SELECT bytes, size, updated_at FROM relay_blobs WHERE relay_id = ?').get(relayId);
    // 404 is a real answer here, not a refusal: the main branch has not
    // published yet (or never enabled the fallback at all). The clinic turns it
    // into "the main branch has not put a copy on the server" — a sentence about
    // the OTHER machine, which is where the fix is.
    if (!row) return res.status(404).json(NOT_FOUND_BODY);

    // Touch, so retention does not delete a blob a branch is actively living
    // off. Best-effort: a failed bookkeeping write must not cost the branch its
    // catalogue.
    try {
      db.prepare('UPDATE relay_blobs SET read_at = ? WHERE relay_id = ?').run(now().toISOString(), relayId);
    } catch (e) {
      console.warn('[control-plane] could not record a relay read:', e && e.message);
    }

    // no-store: this is a clinic's own catalogue, encrypted, and it has no
    // business sitting in any proxy cache between here and the branch.
    res.set('Cache-Control', 'no-store');
    res.set('Content-Type', 'application/octet-stream');
    res.set('X-Em-Relay-Updated', String(row.updated_at || ''));
    res.status(200).send(row.bytes);
  });

  return r;
}
