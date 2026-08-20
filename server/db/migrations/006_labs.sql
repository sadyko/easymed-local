ALTER TABLE services ADD COLUMN is_lab      INTEGER NOT NULL DEFAULT 0;
ALTER TABLE services ADD COLUMN specimen    TEXT;
ALTER TABLE services ADD COLUMN result_unit TEXT;
ALTER TABLE services ADD COLUMN ref_low     REAL;
ALTER TABLE services ADD COLUMN ref_high    REAL;
ALTER TABLE services ADD COLUMN ref_text    TEXT;

CREATE TABLE lab_results (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  visit_service_id INTEGER NOT NULL REFERENCES visit_services(id),
  value            TEXT,
  numeric_value    REAL,
  unit             TEXT,
  reference_range  TEXT,
  flag             TEXT NOT NULL DEFAULT 'normal'
                     CHECK (flag IN ('normal','high','low','abnormal','critical')),
  notes            TEXT NOT NULL DEFAULT '',
  entered_by       INTEGER REFERENCES users(id),
  entered_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  verified_by      INTEGER REFERENCES users(id),
  verified_at      TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_lab_results_vs ON lab_results(visit_service_id);
