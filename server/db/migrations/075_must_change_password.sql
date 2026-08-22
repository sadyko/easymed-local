-- FIRST_RUN_PASSWORD_V1 — owner decision 2026-08-22: the first-run admin is
-- created with a KNOWN default password instead of a random one, so whoever
-- installs at a clinic doesn't have to fish a generated string out of a
-- service log. The trade that makes this acceptable is this flag: a user
-- carrying it must set a new password before the API lets them do anything
-- else (enforced server-side in app.js, not just by the login screen).
-- 1 on the bootstrap admin; 0 for everyone created through the users screen,
-- where a human chose the password on purpose.
ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;
