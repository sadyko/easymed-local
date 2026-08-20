-- 032_doctor_workspace.sql
-- DOCTOR_WORKSPACE_V1 — schema easymed's My services queue (consultation.js)
-- and service workspace (service-workspace.js) read, so both run unmodified
-- on the local backend.

-- users: columns the My-services doctor dashboard selects. `active` is a
-- read-only mirror of is_active — easymed filters users by `active` (16 call
-- sites); a virtual generated column keeps one source of truth and cannot
-- drift. room_id = the doctor's cabinet (users:doctor_id(rooms(floors))).
ALTER TABLE users ADD COLUMN kpi_links TEXT;
ALTER TABLE users ADD COLUMN room_id INTEGER REFERENCES rooms(id);
ALTER TABLE users ADD COLUMN active INTEGER GENERATED ALWAYS AS (is_active) VIRTUAL;

-- services: FK columns behind easymed's nested embeds
-- services(service_types(name), departments(kind), service_categories(name)).
ALTER TABLE services ADD COLUMN type_id INTEGER REFERENCES service_types(id);
ALTER TABLE services ADD COLUMN category_id INTEGER REFERENCES service_categories(id);
ALTER TABLE services ADD COLUMN department_id INTEGER REFERENCES departments(id);

-- consultation_types: easymed selects bilingual names (name_ru, name_uz) and
-- orders the picker by sort_order.
ALTER TABLE consultation_types ADD COLUMN name_ru TEXT;
ALTER TABLE consultation_types ADD COLUMN name_uz TEXT;
ALTER TABLE consultation_types ADD COLUMN sort_order INTEGER;
UPDATE consultation_types SET name_ru = name WHERE name_ru IS NULL;

-- lab_results: the workspace's recent-labs strip reads a parameter name per row.
ALTER TABLE lab_results ADD COLUMN parameter TEXT;

-- visit_services: the queue row remembers which consultation type was booked.
ALTER TABLE visit_services ADD COLUMN consultation_type_id INTEGER REFERENCES consultation_types(id);

-- admissions: allow status 'requested' — the doctor files an inpatient request
-- from the workspace (request_admission RPC, no bed taken); the ward desk later
-- admits properly (admit_patient). SQLite cannot ALTER a CHECK, so rebuild.
-- Safe here: this migration runs once, in order, before any admissions data
-- exists (all admission tables are empty at this point in the sequence).
CREATE TABLE admissions_new (
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
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('requested','active','discharged','cancelled')),
  accommodation_discount_percent REAL NOT NULL DEFAULT 0,
  charge_amount REAL,
  invoice_id INTEGER REFERENCES invoices(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
INSERT INTO admissions_new (id, admission_no, patient_id, bed_id, ward_id, doctor_id, pathway,
  chief_complaint, admission_diagnosis, admitted_at, discharged_at, status,
  accommodation_discount_percent, charge_amount, invoice_id, created_by, created_at)
  SELECT id, admission_no, patient_id, bed_id, ward_id, doctor_id, pathway,
    chief_complaint, admission_diagnosis, admitted_at, discharged_at, status,
    accommodation_discount_percent, charge_amount, invoice_id, created_by, created_at
  FROM admissions;
DROP TABLE admissions;
ALTER TABLE admissions_new RENAME TO admissions;
CREATE INDEX idx_admissions_status ON admissions(status);
CREATE INDEX idx_admissions_bed ON admissions(bed_id, status);
