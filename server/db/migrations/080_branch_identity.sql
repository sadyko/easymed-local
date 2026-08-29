-- 080_branch_identity.sql
-- BRANCH_IDENTITY_V1 — a branch needs an identity BEFORE any clinical data
-- moves between branches. Two installs both allocate patient id 1, so the row
-- id can never be the shared identity; patients.mrn (TEXT UNIQUE since 002) is,
-- and it becomes unique across branches by carrying the branch letter.
--
-- Design: docs/plans/2026-08-29-branch-architecture-stage2-design.md

ALTER TABLE branches ADD COLUMN letter TEXT;

-- The seeded 'Main Branch' from 002 is A. Every other letter is allocated by
-- letters.js, which never reuses one — reuse would give two different people
-- the same MRN years apart, which is the single failure this scheme exists to
-- prevent.
UPDATE branches SET letter = 'A' WHERE id = 1;
UPDATE branches SET letter = NULL WHERE id <> 1;

-- Which branch THIS install is. One row, id = 1, always present.
--
-- Why a table and not data/branch-sync.json, where the rest of the pairing
-- state lives: the MRN trigger below has to read the letter, and a trigger
-- cannot read a file. Network/pairing config stays in the file; identity that
-- SQL must see lives here.
CREATE TABLE branch_identity (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  letter     TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'main' CHECK (role IN ('main','secondary')),
  branch_id  INTEGER REFERENCES branches(id),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
INSERT INTO branch_identity (id, letter, role, branch_id) VALUES (1, 'A', 'main', 1);

-- Every letter ever issued. branches.letter alone cannot carry this: deleting a
-- branch would delete its letter and the next allocation would hand it out
-- again, giving two different people the same MRN years apart. Used by
-- letters.js (Task 2) and identity.js (Task 3).
CREATE TABLE branch_letters_spent (
  letter     TEXT PRIMARY KEY,
  issued_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
INSERT INTO branch_letters_spent (letter) VALUES ('A');

-- MRN autogen, now branch-aware.
--
-- Two changes from 034, both deliberate:
--   * the prefix is this install's branch letter, not the literal 'P'.
--   * the number is read as the LAST FIVE characters, not substr(mrn, 6).
--     034 could assume a fixed offset because the prefix was always 'P-YY-'.
--     A branch letter may be 'A' or 'AB', so a fixed offset silently reads the
--     wrong digits the day a clinic passes 26 branches.
--
-- The MAX-suffix reasoning from 034 is unchanged and must stay: COUNT(*)
-- numbering collides the moment rows with EXPLICIT MRNs exist (the Excel
-- importer brings them in) — count 1 -> '…-00001' duplicates an imported
-- '…-00001'. MAX + 1 is always past every imported number.
--
-- The year is matched as substr(mrn, -9, 4) = '-YY-'. Measured, not assumed:
-- the tail of a well-formed MRN is exactly nine characters ('-YY-NNNNN'), so
-- the window lands on '-YY-' whatever the letter's length —
--   'A-26-00001'   -> '-26-'   'AB-26-00001' -> '-26-'
--   'ABC-26-00007' -> '-26-'   'P-26-00042'  -> '-26-'
-- while last year's 'A-25-00500' -> '-25-' is correctly excluded, so numbering
-- restarts at 1 each January under a year that cannot collide with the old one.
--
-- Note what this predicate deliberately does NOT do: unlike 034's
-- LIKE 'P-YY-%' it is not anchored to a prefix, so EVERY row of the current
-- year counts, whatever letter it carries. That is the safe direction. A wider
-- match can only push the next number higher, never lower, and MRNs arriving
-- from other branches in Stage 2 must not be able to hand this branch a number
-- it has already printed. Anchoring on this install's own letter would also
-- break the day letters.js reaches 'P' and starts colliding with the legacy
-- 'P-' rows below.
--
-- Legacy 'P-' rows are counted when picking the next number, so a clinic that
-- already has P-26-00042 gets A-26-00043 and never collides. Existing MRNs are
-- deliberately NOT renumbered: they are printed on cards patients carry.
DROP TRIGGER IF EXISTS patients_mrn_autogen;
CREATE TRIGGER patients_mrn_autogen AFTER INSERT ON patients
WHEN NEW.mrn IS NULL
BEGIN
  UPDATE patients
     SET mrn = (SELECT letter FROM branch_identity WHERE id = 1)
               || '-' || substr(strftime('%Y','now'), 3, 2) || '-'
               || substr('00000' || (
                    SELECT COALESCE(MAX(CAST(substr(mrn, -5) AS INTEGER)), 0) + 1
                      FROM patients
                     WHERE substr(mrn, -9, 4) = '-' || substr(strftime('%Y','now'), 3, 2) || '-'
                  ), -5)
   WHERE id = NEW.id;
END;
