-- 029_patient_history_tables.sql
-- Two patient-history tables the easymed patient card / registration expect:
--   • patient_relationships — undirected family/guardian links between two
--     patients (parent/child/spouse/sibling/guardian/other). data.js stores the
--     pair canonically and reads it with .or(a.eq / b.eq) + upsert; those two
--     compat-layer features are still pending, so this table is groundwork for
--     when the patient card is wired.
--   • patient_activity_log — append-only per-patient audit trail (cancellations,
--     refunds, referrals, service edits) written across all roles.
-- Local single-clinic model: company_id/branch_id are dropped (see the tenancy
-- no-op). migrate.js runs this whole file in one transaction.

CREATE TABLE IF NOT EXISTS patient_relationships (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id_a  INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  patient_id_b  INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  relation_type TEXT    NOT NULL DEFAULT 'other'
                  CHECK (relation_type IN ('parent','child','spouse','sibling','guardian','other')),
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (patient_id_a, patient_id_b)
);
CREATE INDEX IF NOT EXISTS idx_patient_rel_a ON patient_relationships(patient_id_a);
CREATE INDEX IF NOT EXISTS idx_patient_rel_b ON patient_relationships(patient_id_b);

CREATE TABLE IF NOT EXISTS patient_activity_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id    INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  visit_id      INTEGER REFERENCES visits(id) ON DELETE SET NULL,
  entity_type   TEXT,
  entity_id     INTEGER,
  entity_label  TEXT,
  action        TEXT    NOT NULL,
  summary       TEXT,
  detail        TEXT,
  actor_user_id INTEGER REFERENCES users(id),
  actor_name    TEXT,
  actor_role    TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_patient_activity_patient ON patient_activity_log(patient_id);
