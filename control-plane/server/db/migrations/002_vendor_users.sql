-- CONTROL_PLANE_V1 — the vendor's own login for settings.easymed.uz/cp/.
--
-- Task 6a's decision: the panel is served BY the control plane itself, with
-- its own session login — not the Supabase-backed Platform Console. Nothing
-- in the local product touches Supabase (verified: zero real
-- @supabase/supabase-js imports in the clinic app, zero references anywhere
-- under control-plane/), and keeping it that way means the local product
-- survives the cloud one being retired, and a Supabase outage can never stop
-- the vendor licensing a clinic.
--
-- Mirrors server/db/migrations/001_init.sql's users/sessions shape closely —
-- same columns, same idioms — because that implementation is battle-tested
-- and this is deliberately not the place for a novel auth design. Two
-- differences from that shape, both because this is a different kind of
-- system:
--   - no `role` column — every vendor user has the same, full access to this
--     back office; there is no clinic-side doctor/registrar/cashier concept
--     to mirror here.
--   - no bootstrapping from a clinic database — the clinic app seeds its
--     first admin from data an installer already has; this registry has no
--     clinics to read staff off of, so the very first vendor account is
--     created by vendor-auth.js's bootstrapVendorAdmin(), the same way
--     services/auth.js's bootstrapAdmin() creates 'admin' on the clinic side.

CREATE TABLE vendor_users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  full_name     TEXT NOT NULL DEFAULT '',
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE vendor_sessions (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES vendor_users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_vendor_sessions_user ON vendor_sessions(user_id);
