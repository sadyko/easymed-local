-- Ward billing config
ALTER TABLE wards ADD COLUMN type TEXT NOT NULL DEFAULT 'general';
ALTER TABLE wards ADD COLUMN billing_mode TEXT NOT NULL DEFAULT 'daily';
ALTER TABLE wards ADD COLUMN price_per_day REAL NOT NULL DEFAULT 0;
ALTER TABLE wards ADD COLUMN price_per_hour REAL NOT NULL DEFAULT 0;
ALTER TABLE wards ADD COLUMN color TEXT NOT NULL DEFAULT '';

-- Rebuild beds to widen the status CHECK (add 'cleaning') + add type/rate-override/notes.
-- SQLite can't ALTER a CHECK, so recreate + copy.
CREATE TABLE beds_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  ward_id INTEGER REFERENCES wards(id),
  type TEXT NOT NULL DEFAULT 'standard',
  status TEXT NOT NULL DEFAULT 'free' CHECK (status IN ('free','occupied','cleaning','maintenance')),
  price_per_day REAL NOT NULL DEFAULT 0,
  price_per_hour REAL NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
INSERT INTO beds_new (id, code, ward_id, status, active, created_at)
  SELECT id, code, ward_id, status, active, created_at FROM beds;
DROP TABLE beds;
ALTER TABLE beds_new RENAME TO beds;

-- The stay row.
CREATE TABLE admissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admission_no TEXT,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  bed_id INTEGER REFERENCES beds(id),
  ward_id INTEGER REFERENCES wards(id),
  doctor_id INTEGER REFERENCES users(id),
  pathway TEXT NOT NULL DEFAULT 'therapy' CHECK (pathway IN ('therapy','surgical')),
  chief_complaint TEXT NOT NULL DEFAULT '',
  admission_diagnosis TEXT NOT NULL DEFAULT '',
  admitted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  discharged_at TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','discharged','cancelled')),
  accommodation_discount_percent REAL NOT NULL DEFAULT 0,
  charge_amount REAL,
  invoice_id INTEGER REFERENCES invoices(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_admissions_status ON admissions(status);
CREATE INDEX idx_admissions_bed ON admissions(bed_id, status);
