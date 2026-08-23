-- TELEPHONY_V1 — Settings → «Телефония»: the Binotel call-center integration
-- (docs/plans/2026-08-23-binotel-telephony.md). Phase 1: credentials, the
-- call poller, and the webhook receivers — NOT the callcenter screen rewrite.

-- Exactly one settings row (id = 1), like telegram_settings.
--
-- DELIBERATELY NOT REGISTERED in server/db/schema-registry.js: the registry
-- is an allow-list, so absence makes api_secret unreachable through /api/db
-- by construction — the same protection telegram_settings relies on for the
-- bot token. The only path to this row is the admin-only telephony RPCs, and
-- the secret never leaves the server in any response (the RPC reports only
-- api_secret_set: true/false).
CREATE TABLE telephony_settings (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  -- The poller stays silent until the administrator turns it on, even with
  -- credentials already saved — same honesty rule as telegram_settings.enabled.
  enabled           INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  -- 'binotel' is the only provider today; a column rather than a code
  -- constant so a second PBX vendor someday is a data change, not a schema one.
  provider          TEXT NOT NULL DEFAULT 'binotel',
  -- Issued by Binotel support (support@binotel.ua) — the settings screen says
  -- this so the admin knows where the pair comes from.
  api_key           TEXT NOT NULL DEFAULT '',
  api_secret        TEXT NOT NULL DEFAULT '',
  -- Seconds between poll ticks. The save path clamps to [10, 3600] so a typo
  -- can never turn the poller into a hammer on Binotel — or into silence.
  poll_interval_sec INTEGER NOT NULL DEFAULT 30,
  -- Webhooks need the clinic reachable FROM the internet, which most local
  -- installs are not — default off, polling-only is the normal mode (the
  -- plan's honest-limits section).
  webhooks_enabled  INTEGER NOT NULL DEFAULT 0 CHECK (webhooks_enabled IN (0,1)),
  -- Origin for building linkToCrmUrl in webhook answers, e.g.
  -- "https://clinic.example.uz". Empty = no link is sent.
  public_base_url   TEXT NOT NULL DEFAULT '',
  -- The clinic's Company ID at Binotel (issued with the key/secret by their
  -- support). Per-clinic DATA, never a code constant. When set, incoming
  -- webhook payloads must carry the same companyID — a cheap tenant check on
  -- top of the source-IP allowlist. Empty = don't check (Phase-1 installs
  -- that were issued no id must not lose webhooks over it).
  company_id        TEXT NOT NULL DEFAULT '',
  -- Poller proof-of-life for the settings screen: when we last asked, when a
  -- call last arrived, what went wrong last time ('' = nothing).
  last_poll_at      TEXT,
  last_call_at      TEXT,
  last_error        TEXT NOT NULL DEFAULT '',
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  -- SET NULL, not a bare reference: routes/users.js decides deletable-vs-
  -- blocked from a hardcoded table list this table is not on, so a plain FK
  -- would let a staff delete be announced as allowed and then die with an
  -- opaque 500 — the exact trap 073's module_requests documents.
  updated_by        INTEGER REFERENCES users(id) ON DELETE SET NULL
);
INSERT INTO telephony_settings (id) VALUES (1);

-- Captured calls, one row per Binotel generalCallID.
--
-- UNIQUE(general_call_id) is what makes poll + webhook double-delivery
-- idempotent BY CONSTRUCTION: both sources INSERT .. ON CONFLICT DO NOTHING,
-- so whichever arrives first wins and the second changes nothing (both carry
-- the same unified Binotel call structure).
CREATE TABLE calls (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Binotel's generalCallID. TEXT, not INTEGER: it is an opaque vendor id and
  -- nothing here ever does arithmetic on it.
  general_call_id  TEXT NOT NULL UNIQUE,
  -- ISO UTC seconds, converted from Binotel's unix startTime — matching every
  -- other timestamp in this schema so future reports can reuse domain/day.js.
  started_at       TEXT NOT NULL,
  -- Verbatim from Binotel's callType: 0 incoming, 1 outgoing.
  call_type        INTEGER NOT NULL DEFAULT 0,
  external_number  TEXT NOT NULL DEFAULT '',
  internal_number  TEXT NOT NULL DEFAULT '',
  waitsec          INTEGER,
  billsec          INTEGER,
  -- ANSWER / BUSY / NOANSWER / CANCEL / TRANSFER / … — Binotel's vocabulary,
  -- stored as-is; the screen maps it to human words, the database never does.
  disposition      TEXT NOT NULL DEFAULT '',
  is_new_call      INTEGER,
  -- Matched at capture time by the SAME phone normalisation the CRM and the
  -- Telegram bot use (crm-phone-match.js via telegram/documents.js — never a
  -- second normaliser). SET NULL, not CASCADE: deleting a patient must never
  -- delete the fact that a call happened.
  patient_id       INTEGER REFERENCES patients(id) ON DELETE SET NULL,
  -- The vendor's own JSON for this call, verbatim. Diagnostics only: it stays
  -- server-side (telephony_recent_calls does not return it).
  raw              TEXT NOT NULL DEFAULT '{}',
  source           TEXT NOT NULL DEFAULT 'poll' CHECK (source IN ('poll','webhook')),
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- The poller's cursor is MAX(started_at) and the settings screen reads the
-- last 20 by time — both walk this index instead of the table.
CREATE INDEX calls_started_at ON calls (started_at);
CREATE INDEX calls_patient_id ON calls (patient_id);
