-- CONTROL_PLANE_V2 (docs/specs/2026-09-05-control-plane-v2-design.md) — what
-- makes a hard DELETE of a clinic safe.
--
-- 001_registry.sql wrote down the danger and then declined to guard it: "Nothing
-- in this schema forbids a hard DELETE — migrations/001.test.js pins that
-- deleting and re-inserting the same clinic_id is currently possible — but the
-- application is expected to never do it for a live clinic." The owner now wants
-- a Delete button, so "expected to never" is no longer good enough.
--
-- THE DANGER, precisely: routes/admin.js:nextClinicId() allocates the next id as
-- max(numeric suffix seen in `clinics`) + 1. Delete c-000009 and the next clinic
-- created is c-000009 again. services/control/licence.js verifies a licence by
-- clinic_id, so the deleted clinic's licence file — still sitting on its old
-- computer, still signed, still inside its validity window — would verify
-- against the new clinic and grant it whatever the old one was entitled to.
--
-- The fix is a graveyard: an id that has been deleted is remembered forever, and
-- may never be issued again to anything.
CREATE TABLE deleted_clinics (
  clinic_id  TEXT PRIMARY KEY,
  -- Last known name. NOT for lookup — for the human reading the audit trail six
  -- months later, who needs "test on laptop" and not just "c-000008".
  name       TEXT,
  deleted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  -- vendor_users.username. Deliberately TEXT and not a foreign key: this row
  -- must outlive the vendor account that made it, exactly as `checkins` outlives
  -- the clinic row it describes.
  deleted_by TEXT
);

-- THE SECOND LINE, and the reason this is a trigger rather than an `if` in a
-- route. routes/admin.js will consult this table, but the route is not the only
-- thing that will ever insert into `clinics`: a future route, a support fix run
-- by hand at 2am, or an old backup replayed over this database. Every one of
-- those paths must hit the same wall, so the wall is in the schema.
--
-- ABORT, not IGNORE: a caller trying to resurrect a deleted clinic has made a
-- mistake worth hearing about. routes/admin.js turns it into a 409.
CREATE TRIGGER clinics_no_resurrection
BEFORE INSERT ON clinics
WHEN EXISTS (SELECT 1 FROM deleted_clinics WHERE clinic_id = NEW.clinic_id)
BEGIN
  SELECT RAISE(ABORT, 'clinic_id was permanently deleted and can never be reissued');
END;

-- When a clinic was retired, so a retired card can say "Retired 31 Aug 2026".
--
-- NO BACKFILL, deliberately. Clinics already retired (c-000008 on the live
-- registry) have no recorded date, and inventing one — created_at, or today —
-- would print a confident wrong answer. NULL renders as "date unknown", which is
-- true.
ALTER TABLE clinics ADD COLUMN retired_at TEXT;
