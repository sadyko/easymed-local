-- 031_doc_branding.sql
-- Clinic-wide print/branding settings for the rich 6-type document designer
-- (documents.js / doc-settings.js). `settings` is a JSON blob stored as TEXT —
-- the compat layer serialises it on write (registry `json: ['settings']`) and
-- parses it back on read. Keyed by company_id (the local clinic is id 1) with a
-- UNIQUE constraint so the designer's upsert (ON CONFLICT (company_id) DO UPDATE)
-- keeps exactly one branding row per clinic.
CREATE TABLE IF NOT EXISTS doc_branding (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id  INTEGER,
  settings    TEXT,
  updated_at  TEXT,
  UNIQUE (company_id)
);
