CREATE TABLE branches (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  phone       TEXT NOT NULL DEFAULT '',
  address     TEXT NOT NULL DEFAULT '',
  license_number TEXT NOT NULL DEFAULT '',
  is_24_7     INTEGER NOT NULL DEFAULT 0,
  working_hours TEXT NOT NULL DEFAULT '{}',
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
INSERT INTO branches (name) VALUES ('Main Branch');

CREATE TABLE payers (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  name     TEXT NOT NULL,
  kind     TEXT NOT NULL DEFAULT 'insurance',
  active   INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE referral_sources (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  name     TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  active   INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE patients (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  mrn           TEXT UNIQUE,
  full_name     TEXT NOT NULL,
  first_name    TEXT NOT NULL DEFAULT '',
  last_name     TEXT NOT NULL DEFAULT '',
  middle_name   TEXT NOT NULL DEFAULT '',
  date_of_birth TEXT,
  gender        TEXT NOT NULL DEFAULT 'other' CHECK (gender IN ('male','female','other')),
  blood_type    TEXT NOT NULL DEFAULT 'unknown',
  phone         TEXT NOT NULL DEFAULT '',
  email         TEXT NOT NULL DEFAULT '',
  national_id   TEXT NOT NULL DEFAULT '',
  address       TEXT NOT NULL DEFAULT '',
  nationality   TEXT NOT NULL DEFAULT '',
  occupation    TEXT NOT NULL DEFAULT '',
  emergency_contact_name  TEXT NOT NULL DEFAULT '',
  emergency_contact_phone TEXT NOT NULL DEFAULT '',
  allergies         TEXT NOT NULL DEFAULT '',
  chronic_conditions TEXT NOT NULL DEFAULT '',
  branch_id         INTEGER REFERENCES branches(id),
  primary_doctor_id INTEGER REFERENCES users(id),
  payer_id          INTEGER REFERENCES payers(id),
  referral_source_id INTEGER REFERENCES referral_sources(id),
  notes             TEXT NOT NULL DEFAULT '',
  photo_url         TEXT NOT NULL DEFAULT '',
  active            INTEGER NOT NULL DEFAULT 1,
  registration_date TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  created_by        INTEGER REFERENCES users(id),
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_patients_branch ON patients(branch_id);
CREATE INDEX idx_patients_phone ON patients(phone);

CREATE TRIGGER patients_mrn_autogen AFTER INSERT ON patients
WHEN NEW.mrn IS NULL
BEGIN
  UPDATE patients
     SET mrn = 'P-' || substr(strftime('%Y','now'), 3, 2) || '-' ||
               substr('00000' || (
                 SELECT COUNT(*) FROM patients
                  WHERE mrn LIKE 'P-' || substr(strftime('%Y','now'), 3, 2) || '-%'
               ), -5)
   WHERE id = NEW.id;
END;
