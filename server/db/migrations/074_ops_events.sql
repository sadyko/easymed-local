-- OPS_EVENTS_V1 — what the statistics counters count.
--
-- Deliberately NO message column and NO free text. An error message can carry a
-- patient name (a constraint violation echoes the offending values), and the
-- owner's rule is that no patient data ever leaves the clinic. The schema makes
-- storing any impossible, so there is nothing to leak later. `route` is a path
-- template the client already knows, never a URL with ids in it.
CREATE TABLE ops_events (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  kind  TEXT NOT NULL CHECK (kind IN ('server_error','slow_request','failed_login','boot')),
  route TEXT,
  at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX ops_events_kind_at ON ops_events (kind, at DESC);
