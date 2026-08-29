-- BRANCH_IDENTITY_V1 (docs/plans/2026-08-29-branch-identity-stage1.md, Task 4)
-- — a credential a SECONDARY branch can present to the relay, and to nothing
-- else.
--
-- WHY THIS TABLE EXISTS. routes/relay.js authenticates on clinics.install_token,
-- and ONLY enrolment ever issues one. A secondary branch never enrols — it joins
-- a CLINIC, not the vendor — so it holds no credential the relay accepts and
-- could not use the fallback route (Маршрут Б) at all. That is the whole gap.
--
-- TWO CHEAPER FIXES, REJECTED. Written down so they are not re-proposed later:
--   * Put the clinic's install_token in the branch key. That key is carried to
--     the other building on a flash drive and typed in by a receptionist. One
--     leaked branch PC would then be able to check in, report statistics and
--     ACCEPT UPDATES as the clinic — total compromise from the weakest machine
--     in the group.
--   * Drop authentication and trust the relay id to be unguessable. Anyone who
--     ever learned one could overwrite the blob and silently stop a clinic
--     syncing. AES-256-GCM stops them injecting data the branch would READ; it
--     does not stop denial of service.
-- So the MAIN branch — which IS enrolled — mints a token scoped to ONE relay id,
-- individually revocable, worth nothing anywhere else. It travels to the
-- secondary inside the hand-carried branch key and never through this server.
CREATE TABLE relay_tokens (
  -- STORED RAW, NOT HASHED, and that is an argued decision, not an oversight.
  -- The credential that MINTS these — clinics.install_token — sits raw two
  -- tables over, as does clinics.unlock_secret. Anyone who can read this table
  -- can read that one, and with it mint fresh relay tokens at will: hashing the
  -- weaker credential while the stronger one is plaintext protects nothing at
  -- all. That is the whole argument, and it is the only one — an earlier draft
  -- of this comment also claimed a vendor support listing needed the raw value,
  -- which was false twice over (a listing is served by the row, not the secret,
  -- and no such listing exists — see revoked_at below). If this project ever
  -- hashes credentials at rest, install_token must be hashed FIRST; hashing
  -- this one before that one would be theatre.
  --
  -- 32 random bytes as base64url (see routes/relay-token.js). base64url rather
  -- than base64 because this string is carried inside the branch key a human
  -- copies between buildings: no '+', '/' or '=' to be mangled on the way.
  token      TEXT PRIMARY KEY,

  -- Who this token may act as on the relay. ON DELETE CASCADE, and not by
  -- imitation of relay_blobs: a credential must never outlive the identity it
  -- speaks for. Without the cascade, deleting a clinic would either fail on the
  -- foreign key or leave a live token naming a clinic_id that no longer exists —
  -- which routes/relay.js would then try to write into relay_blobs.clinic_id,
  -- turning a deleted clinic into a 500 on someone else's upload.
  clinic_id  TEXT NOT NULL REFERENCES clinics(clinic_id) ON DELETE CASCADE,

  -- THE SCOPE, and the reason this token is safe to hand out. One relay id,
  -- checked on every use (routes/relay-token.js clinicForRelayToken): the token
  -- is refused on any other id, and refused by /cp/v1/checkin, which never looks
  -- at this table at all.
  --
  -- The CHECK is the same 32-lowercase-hex format routes/relay.js enforces on
  -- the URL path. The route validates it FIRST, so a probing request is refused
  -- before it touches the database at all; this is the second line — it makes it
  -- impossible for any future code path to mint a token for a relay id the relay
  -- route could never accept, which would be a live credential that mysteriously
  -- never works. `NOT GLOB '*[^0-9a-f]*'` is an exact character-class test, not
  -- a prefix one.
  relay_id   TEXT NOT NULL CHECK (length(relay_id) = 32 AND relay_id NOT GLOB '*[^0-9a-f]*'),

  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),

  -- Support evidence, nothing more: "this branch last reached the relay on
  -- ...". Written best-effort on every accepted use — the relay is polled about
  -- four times a day per branch (server/services/branch-sync/relay.js
  -- INTERVAL_MS = 6h), so this is not a write worth throttling, and the same
  -- request already writes relay_blobs.read_at.
  last_used  TEXT,

  -- Revocation, and the ONLY switch there is: set it and the token stops working
  -- on the very next request. Deliberately a timestamp rather than a boolean, so
  -- the answer to "when did this branch stop being allowed in" survives.
  --
  -- NO OPERATOR SURFACE EXISTS YET, and that is a known gap, not an assumption:
  -- no route lists these and no route revokes one, so today revoking is an
  -- UPDATE typed by hand against this column. What keeps that from stranding a
  -- clinic in the meantime is the sweep (routes/relay-token.js
  -- pruneRelayTokens), which reclaims tokens nobody has used in 30 days and runs
  -- on the way into every mint. A vendor panel that lists a clinic's branches
  -- and revokes one by hand is FOLLOW-UP WORK, and deliberately out of scope
  -- here: this task is the credential, not the console.
  -- Re-issuing the clinic's GROUP KEY does not need this: a new group key means a
  -- new relay id (branch-sync/relay-crypto.js relayIdFor), so every token scoped
  -- to the old id is already worthless.
  revoked_at TEXT
);

-- Serves both queries that are not by primary key: the vendor's support listing
-- for one clinic, and the live-token count the mint route caps on. (clinic_id)
-- alone would serve the first; the pair serves both, and a leading-column lookup
-- still uses it.
CREATE INDEX relay_tokens_clinic ON relay_tokens (clinic_id, relay_id);
