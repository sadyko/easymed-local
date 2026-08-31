-- 081_service_editor.sql
-- SERVICE_EDITOR_V1 — the two columns the service editor writes.
-- Design: docs/plans/2026-08-31-service-editor-design.md
--
-- Both are plain ADD COLUMNs that read no branch state, so this is safe on any
-- 0.4.x database — including one that took 080 (branch identity) minutes ago.

-- The performer's default share of this service, in percent. Ticking a
-- performer in the editor writes {pct: <this value>} into users.service_rates —
-- the SAME store the employee card edits and reports.js doctor-pay reads
-- (DOC_RATE_JSON_V1), so pay reports work unchanged. Per-person overrides stay
-- on the employee card; this column is only the seed for NEW memberships.
--
-- NOT NULL DEFAULT 0, not nullable: reports.js COALESCEs a missing rate to the
-- doctor's card default and then to 0, and a NULL here would add a fourth state
-- ("service has no opinion") that no consumer distinguishes from 0 anyway.
ALTER TABLE services ADD COLUMN default_doctor_percent REAL NOT NULL DEFAULT 0;

-- The room the service is performed in (QUEUE_TICKET_V1 heritage: drives the
-- per-room diagnostics queue number on the registration slip). Nullable — most
-- services are performed wherever the doctor sits.
--
-- BRANCH-SYNC ASYMMETRY, DELIBERATE: default_doctor_percent above JOINS the
-- catalogue sync (clinic-wide pay policy travels with the price list);
-- room_id does NOT (a room in building A means nothing in building B — the
-- receiving branch keeps its own NULL/local value). The column lists in
-- branch-sync/catalogue.js are the enforcement; 081.test.js pins both
-- directions against the real exporter and importer.
ALTER TABLE services ADD COLUMN room_id INTEGER REFERENCES rooms(id);
