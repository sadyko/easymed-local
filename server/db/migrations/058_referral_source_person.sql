-- REFERRAL_SOURCE_PERSON_V1 — a referral source is usually a PERSON, and the
-- clinic pays them a commission. One free-text `name` could not carry any of
-- that: who they are (ФИО in three parts), how to reach them, where they work,
-- which district they cover, and how the reward is paid out (cash / card, plus
-- the card number it goes to).
--
-- `name` is KEPT and stays NOT NULL: it is the display label every consumer
-- already reads — the visit wizard's «Кто направил» list, the Рефералы report,
-- the service picker. The editor now composes it from the three name parts, so
-- nothing downstream has to change and existing rows (Instagram, «Клиника X»,
-- and other non-person sources) keep working untouched.
--
-- Additive only: every column is nullable with no default, so rows written
-- before this migration stay valid.
ALTER TABLE referral_sources ADD COLUMN last_name    TEXT;
ALTER TABLE referral_sources ADD COLUMN first_name   TEXT;
ALTER TABLE referral_sources ADD COLUMN middle_name  TEXT;
ALTER TABLE referral_sources ADD COLUMN phone        TEXT;
ALTER TABLE referral_sources ADD COLUMN workplace    TEXT;
ALTER TABLE referral_sources ADD COLUMN district     TEXT;
-- 'cash' | 'card' | 'transfer' — how the referral reward is handed over.
-- Deliberately no CHECK: the clinic may add its own wording later, and a failed
-- CHECK on a live register is a worse outcome than an unexpected string.
ALTER TABLE referral_sources ADD COLUMN payment_type TEXT;
ALTER TABLE referral_sources ADD COLUMN card_number  TEXT;

-- Backfill so an EXISTING source opens with its name already in the form. The
-- whole old `name` goes into first_name rather than being split on spaces: the
-- editor recomposes `name` from these parts, and "everything in one part" is the
-- only split guaranteed to reproduce the original string byte for byte — a
-- guessed split would silently rename partners that referral rewards are paid
-- against. Whoever edits the person next can move the surname across by hand.
UPDATE referral_sources
   SET first_name = name
 WHERE first_name IS NULL AND name IS NOT NULL AND trim(name) <> '';
