CREATE TABLE visits (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id         INTEGER NOT NULL REFERENCES patients(id),
  doctor_id          INTEGER REFERENCES users(id),
  branch_id          INTEGER REFERENCES branches(id),
  visit_date         TEXT NOT NULL,
  duration_minutes   INTEGER NOT NULL DEFAULT 30,
  visit_kind         TEXT NOT NULL DEFAULT 'first',
  visit_type         TEXT NOT NULL DEFAULT 'outpatient',
  status             TEXT NOT NULL DEFAULT 'scheduled'
                       CHECK (status IN ('scheduled','confirmed','arrived','cancelled','no_show')),
  referral_source_id INTEGER REFERENCES referral_sources(id),
  notes              TEXT NOT NULL DEFAULT '',
  created_by         INTEGER REFERENCES users(id),
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_visits_doctor_date ON visits(doctor_id, visit_date);
CREATE INDEX idx_visits_patient ON visits(patient_id);
