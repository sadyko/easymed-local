-- LICENCE_CORE_V1 — local side of the vendor control plane.
--
-- The licence itself is NOT stored here. It lives in data/licence.dat as a
-- signed document, because a row in this database is exactly what an operator
-- would edit to grant themselves a module. What lives here is only the state
-- that has no security value on its own.

CREATE TABLE control_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- «Подключить модуль» from the locked-module screen. Rows wait here until a
-- check-in carries them to the vendor (a later plan); until then this table IS
-- the outbox, so nothing is lost while a clinic is offline.
--
-- requested_by is ON DELETE SET NULL, deliberately. A module request is a sales
-- lead, not clinical history: nobody needs to know forever which receptionist
-- clicked the button. Without SET NULL the foreign key blocks deleting that
-- member of staff — and because routes/users.js decides deletable-vs-blocked
-- from a hardcoded list this table is not on, the clinic would be told the
-- delete was allowed and then get an opaque 500. Staff administration must
-- never fail because of a licensing table.
CREATE TABLE module_requests (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  module_key    TEXT NOT NULL,
  requested_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  requested_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  sent_at       TEXT
);

-- One pending request per module: a reception desk clicking the button four
-- times must not become four leads in the vendor's inbox. Partial index, so a
-- module can be requested again once the previous request has been delivered.
CREATE UNIQUE INDEX module_requests_open_uniq
  ON module_requests (module_key) WHERE sent_at IS NULL;
