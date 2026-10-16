-- 013_sync_keys_history.sql — PUBLIC_LICENCE_V1, step 8c re-check round 2:
-- every online-booking (sync) key a clinic EVER had accepted. Never deleted.
--
-- Re-enrolment clears the old install's rows from sync_keys_seen (a clean
-- slate, so a clinic that went back to a previous computer can have its key
-- accepted again). That also wiped the clinic's former keys, and with them:
--   • the refusal of a new key whose CODE equals a former key's code while its
--     full fingerprint differs (a key ground to that 8-hex code);
--   • blocking a former key by its fingerprint (a stolen old computer);
--   • the former key's code label in «Blocked keys».
-- They all read this table. A returning key with the SAME full fingerprint as
-- a former key is not refused by it — that is the genuine return.
--
-- Fingerprints and times only — no keys, no patient data (guard:
-- server/services/api/no-patient-data-to-vendor.test.js).
CREATE TABLE sync_keys_history (
  clinic_id          TEXT NOT NULL,
  fp                 TEXT NOT NULL CHECK (length(fp) = 32 AND fp NOT GLOB '*[^0-9a-f]*'),
  first_accepted_at  TEXT NOT NULL,
  PRIMARY KEY (clinic_id, fp)
);

-- A registry that already ran 012 keeps what it knew.
INSERT OR IGNORE INTO sync_keys_history (clinic_id, fp, first_accepted_at)
  SELECT clinic_id, fp, state_at FROM sync_keys_seen WHERE state IN ('accepted', 'replaced');
INSERT OR IGNORE INTO sync_keys_history (clinic_id, fp, first_accepted_at)
  SELECT clinic_id, api_sync_key, COALESCE(api_sync_key_accepted_at, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    FROM clinics
   WHERE api_sync_key IS NOT NULL AND length(api_sync_key) = 32 AND api_sync_key NOT GLOB '*[^0-9a-f]*';
