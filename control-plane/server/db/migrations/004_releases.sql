-- UPDATE_DELIVERY_V1 (docs/plans/2026-08-20-update-delivery.md, Task 3) — the
-- releases table, and the two clinic columns that decide who is offered what.
--
-- RING LIVES ON TWO DIFFERENT ROWS, DELIBERATELY:
--   - clinics.ring is a property of the CLINIC — which cohort it belongs to
--     (0 = the vendor's own install, 1 = a handful of friendly clinics, 2 =
--     everyone). Assigned once, rarely changed.
--   - releases.ring is a property of the RELEASE's own lifetime — how far the
--     vendor has manually promoted it (-1 registered-only, then 0, then 1,
--     then 2), moving forward release-over-release as confidence grows.
-- A release "published to ring N" means "every clinic whose own ring is <= N
-- may see it" — so a clinic is offered a release iff clinic.ring <=
-- release.ring, the release is not halted, and the release is strictly newer
-- than what that clinic already runs. See services/rings.js:offerFor for the
-- actual decision; this table only stores the facts it decides from.
CREATE TABLE releases (
  version      TEXT PRIMARY KEY,
  notes_ru     TEXT,
  url          TEXT,
  sha256       TEXT,
  -- The signed {payload, sig} JSON, stored and returned OPAQUELY — see
  -- routes/admin.js's POST /releases and services/checkin.js's own header for
  -- why: the control plane may not even hold the release public key (that is
  -- a SEPARATE keypair from the licence one, see scripts/build-bundle.mjs),
  -- so the CLINIC is the only party that ever verifies this. Never
  -- parsed-and-trusted here for anything beyond "is it {payload,sig}-shaped".
  manifest     TEXT,
  -- -1 = registered but never published to any ring — the real, deliberate
  -- default (not published), never NULL. 0/1/2 = published up to (and
  -- including) that ring. CHECK, not just app-level validation: this column
  -- is read by EVERY check-in to decide who gets offered a release, so a
  -- typo'd value would silently mean "reaches nobody" or "reaches everybody"
  -- with no error anywhere near the typo — same reasoning as clinics.subscription's own CHECK.
  ring         INTEGER NOT NULL DEFAULT -1 CHECK (ring IN (-1, 0, 1, 2)),
  -- 0/1. Flipped to 1 either by hand (POST .../halt) or automatically
  -- (services/rings.js:shouldHalt, applied inside the SAME check-in
  -- transaction that observed the failure — see services/checkin.js) — one
  -- column, one meaning, regardless of who/what set it.
  halted       INTEGER NOT NULL DEFAULT 0 CHECK (halted IN (0, 1)),
  -- Per-release update_result counts reported at check-in (services/checkin.js).
  -- Columns on the release row itself, not a separate outcomes table: every
  -- write here happens inside the SAME check-in transaction that might also
  -- flip `halted`, and two counters on one row are trivially atomic with that
  -- write in a way a second table would need its own extra care to guarantee.
  -- Never reset on halt/unhalt — see checkin.js's own comment on why history
  -- is kept even across a manual unhalt.
  outcome_failures  INTEGER NOT NULL DEFAULT 0,
  outcome_successes INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- A clinic's OWN ring (see the table comment above for why this is separate
-- from releases.ring). Default 2 ("everyone") — a freshly enrolled clinic is
-- an ordinary customer unless someone deliberately narrows it; nobody becomes
-- an early-ring test subject by accident.
ALTER TABLE clinics ADD COLUMN ring INTEGER NOT NULL DEFAULT 2 CHECK (ring IN (0, 1, 2));

-- NULL = not pinned (the common case). A pinned clinic is never offered a
-- release NEWER than this version — pin is a CEILING, not a lock to one exact
-- build: see services/rings.js:offerFor's own header for why a release equal
-- to the pin is still offered if it clears installedVersion, and why that is
-- the only reading of "hold this clinic here" that doesn't also block the
-- pinned version itself.
ALTER TABLE clinics ADD COLUMN pinned_version TEXT;
