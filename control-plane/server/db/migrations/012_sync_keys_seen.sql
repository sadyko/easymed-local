-- 012_sync_keys_seen.sql — PUBLIC_LICENCE_V1, step 8c review: every online-
-- booking (sync) key a clinic's install has presented at check-in, one row per
-- key. A single "last key sent" cell (clinics.api_sync_key_seen) let a copy of
-- control.json that checked in AFTER the real new computer take that cell, and
-- «Accept new key» then accepted the copy's key.
--
--   candidate — arrived, not accepted (waits for «Accept new key»);
--   accepted  — the clinic's accepted key (stays 'accepted' while it is
--               blocked, so unblocking it can restore it);
--   replaced  — was accepted, another key was accepted after it.
--
-- More than one candidate since the last accept: nothing can be accepted —
-- only re-enrolling the install, which deletes this clinic's candidate and
-- replaced rows. id is the opaque handle the panel uses for a key it must not
-- learn the fingerprint (and with it the code) of.
--
-- A file of its own, not an edit to 011: migrate() records migrations by file
-- name, so a registry that already ran 011 would never get a table appended
-- there. Fingerprints and times only — no keys, no patient data (guard:
-- server/services/api/no-patient-data-to-vendor.test.js).
CREATE TABLE sync_keys_seen (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  clinic_id   TEXT NOT NULL,
  fp          TEXT NOT NULL CHECK (length(fp) = 32 AND fp NOT GLOB '*[^0-9a-f]*'),
  first_seen  TEXT NOT NULL,
  last_seen   TEXT NOT NULL,
  state       TEXT NOT NULL DEFAULT 'candidate' CHECK (state IN ('candidate', 'accepted', 'replaced')),
  state_at    TEXT NOT NULL,
  UNIQUE (clinic_id, fp)
);
