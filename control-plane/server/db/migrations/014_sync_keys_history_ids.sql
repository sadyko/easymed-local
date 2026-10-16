-- 014_sync_keys_history_ids.sql — PUBLIC_LICENCE_V1, step 8c re-check round 3:
-- the history of accepted keys (013) gets
--   • an opaque id — the panel lists a clinic's former keys and blocks one by
--     this id, never by fingerprint (as it does new keys, F4); after a
--     re-enrolment a former key exists only here, and the card had no way to
--     block it;
--   • last_accepted_at / replaced_at — when the key was last accepted and when
--     another key replaced it (shown on the card; NULL when not known).
-- A forward rebuild: a registry that ran 013 keeps every row, ids follow the
-- old row order, last_accepted_at starts as first_accepted_at. Fingerprints and
-- times only — no keys, no patient data.
CREATE TABLE sync_keys_history_v2 (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  clinic_id          TEXT NOT NULL,
  fp                 TEXT NOT NULL CHECK (length(fp) = 32 AND fp NOT GLOB '*[^0-9a-f]*'),
  first_accepted_at  TEXT NOT NULL,
  last_accepted_at   TEXT,
  replaced_at        TEXT,
  UNIQUE (clinic_id, fp)
);
INSERT INTO sync_keys_history_v2 (clinic_id, fp, first_accepted_at, last_accepted_at)
  SELECT clinic_id, fp, first_accepted_at, first_accepted_at FROM sync_keys_history ORDER BY rowid;
DROP TABLE sync_keys_history;
ALTER TABLE sync_keys_history_v2 RENAME TO sync_keys_history;
