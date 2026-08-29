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

-- Without this the ledger below is only advisory. letters.js reads the highest
-- letter ever issued and writes the new one onto a branch row; nothing stops a
-- hand-written INSERT, a restored backup, or letters.js racing itself from
-- putting the same letter on two rows, and two branches minting the same MRNs
-- is exactly the failure this migration exists to prevent. NULLs stay distinct
-- in SQLite, so branches created before a letter is allocated do not collide.
CREATE UNIQUE INDEX branches_letter_uniq ON branches(letter);

-- Which branch THIS install is. One row, id = 1, always present.
--
-- Why a table and not data/branch-sync.json, where the rest of the pairing
-- state lives: the MRN trigger below has to read the letter, and a trigger
-- cannot read a file. Network/pairing config stays in the file; identity that
-- SQL must see lives here.
--
-- How this relates to branches.letter, since the letter appears in both:
-- `branches` is the ROSTER of the clinic's branches as this install knows them
-- — on a secondary install it still holds the main branch's 'A' row alongside
-- its own — while `branch_identity` is the one-row answer to "which of them am
-- I", with branch_id naming that row. For minting an MRN, branch_identity
-- WINS, and the trigger deliberately does not join branches to re-derive the
-- letter: branch_id is nullable, so a join that found nothing would silently
-- mint mrn = NULL again, which is the exact failure the RAISE guard below
-- exists to stop. identity.js (Task 3) is the only writer of either column and
-- sets both in one transaction.
--
-- CHECK: a letter is plain A-Z, one or more characters, nothing else. '' and
-- lowercase are what an empty form field or a hand-edited row actually
-- produces, and 'A1' or 'A-' are what a half-finished paste produces; any of
-- them would put a nonsense prefix on every MRN the clinic prints from then on.
-- The second clause is what rejects the mixed shapes: GLOB '[A-Z]*' alone only
-- constrains the FIRST character, so 'Ab' would pass it.
CREATE TABLE branch_identity (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  letter     TEXT NOT NULL CHECK (letter GLOB '[A-Z]*' AND letter NOT GLOB '*[^A-Z]*'),
  role       TEXT NOT NULL DEFAULT 'main' CHECK (role IN ('main','secondary')),
  branch_id  INTEGER REFERENCES branches(id),
  -- Written by identity.js (Task 3) on every identity change — becomeSecondary
  -- must set it. Nothing else maintains it, so if that is missed this column
  -- reads "install time" forever and silently answers the wrong question the
  -- first time someone asks when this branch was re-pointed.
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
INSERT INTO branch_identity (id, letter, role, branch_id) VALUES (1, 'A', 'main', 1);

-- Every letter ever issued. branches.letter alone cannot carry this: deleting a
-- branch would delete its letter and the next allocation would hand it out
-- again, giving two different people the same MRN years apart. Used by
-- letters.js (Task 2) and identity.js (Task 3).
--
-- 'A' is the main branch. 'P' is spent WITHOUT ever being a branch, and that is
-- the one entry here that is not obvious:
--
--   letters.js allocates A, B, C ... so the SIXTEENTH branch a clinic opens
--   would be lettered P — the prefix every legacy MRN already carries (002 and
--   034 minted 'P-YY-NNNNN' for years; a live clinic holds ~70 000 of them).
--   That branch is a SEPARATE database with no legacy rows, so its allocator
--   would start at P-26-00001 and climb straight through numbers the main
--   branch printed years ago. Stage 2 matches patients on natural: ['mrn'], so
--   two unrelated people would silently merge into one record.
--
-- It is seeded here rather than skip-listed in letters.js because this is where
-- the reason lives: the same file that changed the prefix away from 'P' is the
-- file that records 'P' as burned. A list in letters.js would be a second copy
-- of that knowledge, free to drift.
--
-- Hence `kind`, which is NOT bookkeeping — without it the fix above breaks the
-- thing it was added to protect:
--
--   'issue' = handed to a real branch; drives what comes next.
--   'burn'  = never a branch and never allowed to be one (the legacy 'P-'
--             prefix, and anything else later found to be already in use).
--
-- letters.js takes the next letter from the highest ISSUED row, then walks
-- forward past anything present at all. Seed 'P' without the distinction and it
-- becomes the highest letter in a one-branch clinic, so the SECOND branch is
-- lettered Q, skipping B through O — and the obvious fix for that is deleting
-- the 'P' row, which silently undoes the collision guard this table exists for.
-- A guard whose failure mode invites its own removal is worse than no guard.
--
-- 'P' is the only letter poisoned this way: it is the only MRN prefix this
-- codebase has ever GENERATED (grep the migrations — 002, 034 and this file are
-- the only 'P-' literals). The Excel importer does accept arbitrary MRN text,
-- so a clinic could in principle carry some other prefix in from an old system,
-- but that set is unbounded and unknowable and cannot be pre-seeded. Guarding
-- it belongs at allocation time in letters.js: before issuing a letter, refuse
-- one that any existing patients.mrn already uses.
CREATE TABLE branch_letters_spent (
  -- Same shape rule as branch_identity.letter above, and it matters more here:
  -- this is the table letters.js READS to decide the next letter, so a junk row
  -- becomes a junk MRN prefix on a whole branch.
  letter     TEXT PRIMARY KEY CHECK (letter GLOB '[A-Z]*' AND letter NOT GLOB '*[^A-Z]*'),
  kind       TEXT NOT NULL DEFAULT 'issue' CHECK (kind IN ('issue','burn')),
  issued_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
INSERT INTO branch_letters_spent (letter, kind) VALUES ('A','issue'), ('P','burn');

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
-- Why the predicate is not anchored to a prefix the way 034's LIKE 'P-YY-%'
-- was: CONTINUITY ACROSS THE P->A CHANGE. An upgraded clinic's existing rows
-- are all 'P-' and its new ones are 'A-'; anchoring on 'A-' would find nothing
-- and restart the register at 00001 while cards numbered 70 000 are in
-- patients' hands. Counting every row of the current year instead gives that
-- clinic A-26-70001, which is what the staff expect to see. (It is NOT about
-- MRNs synced in from other branches — those carry a different letter and can
-- never equal one of this branch's numbers.)
--
-- And note the direction this predicate errs in, because it is the opposite of
-- what "unanchored" suggests: relative to 034 it is NARROWER, not wider. It
-- needs a five-character numeric tail, so an imported legacy 'P-26-0042' (four
-- digits) is skipped where 034's LIKE would have counted it. Harmless while no
-- branch is lettered P — which the ledger above now guarantees forever — but it
-- is a narrowing, not a widening, and the next person to touch this should know
-- which way it fails.
--
-- Existing MRNs are deliberately NOT renumbered: they are printed on cards
-- patients carry.
DROP TRIGGER IF EXISTS patients_mrn_autogen;
CREATE TRIGGER patients_mrn_autogen AFTER INSERT ON patients
WHEN NEW.mrn IS NULL
BEGIN
  -- mrn is UNIQUE, and SQLite allows unlimited NULLs in a UNIQUE column. Without
  -- this guard a deleted branch_identity row makes the SELECT below return NULL,
  -- the concatenation collapses to NULL, and the clinic quietly registers patient
  -- after patient with no medical record number — discovered weeks later, by
  -- which time the paperwork is already wrong. Refusing the registration is loud,
  -- immediate and recoverable.
  SELECT RAISE(ABORT, 'branch identity missing')
   WHERE NOT EXISTS (SELECT 1 FROM branch_identity WHERE id = 1);

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
