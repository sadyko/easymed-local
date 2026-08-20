-- 025 — inpatient + lab-panel tables the original easymed INPATIENT (bed board /
-- admission modal) and LAB (panel settings) screens read+write. Columns are
-- derived from real `.from('<table>')` usage in public/js/admin (there are no
-- original SQL migrations); see the header comment on each table for the driving
-- view file(s). Multi-tenant shims (company_id) are intentionally omitted —
-- Easy-Med Local is single-clinic and the query-compiler ignores those filters
-- (TENANCY_NOOP_V1). No CHECK constraints (kept flexible). FKs point only at
-- tables that already exist locally.

-- Inpatient line items: medical services, dispensed products (clinic_item_id →
-- products, service_id null) AND accommodation charges (service_id null, priced
-- by ward/bed hours/days) all live here. beds.js, admission-modal.js, cashier.js,
-- reports-export.js. `billable=0` = internal expense («Учёт»), excluded from
-- invoicing; `invoice_item_id` links the row once it is billed.
CREATE TABLE admission_services (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  admission_id     INTEGER REFERENCES admissions(id),
  service_id       INTEGER REFERENCES services(id),
  clinic_item_id   INTEGER REFERENCES products(id),
  doctor_id        INTEGER REFERENCES users(id),
  bed_id           INTEGER REFERENCES beds(id),
  ward_id          INTEGER REFERENCES wards(id),
  quantity         REAL NOT NULL DEFAULT 1,
  unit_price       REAL NOT NULL DEFAULT 0,
  total            REAL NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'added',
  notes            TEXT,
  billable         INTEGER NOT NULL DEFAULT 1,
  performed_at     TEXT,
  invoice_item_id  INTEGER REFERENCES invoice_items(id),
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_admission_services_admission ON admission_services(admission_id);
CREATE INDEX idx_admission_services_invoice_item ON admission_services(invoice_item_id);

-- Bed movement log + accommodation billing-segment boundaries. beds.js,
-- admission-modal.js. kind ∈ 'admit'/'transfer'/'return_home'/'discharge'.
CREATE TABLE admission_transfers (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  admission_id    INTEGER REFERENCES admissions(id),
  from_bed_id     INTEGER REFERENCES beds(id),
  to_bed_id       INTEGER REFERENCES beds(id),
  from_ward_id    INTEGER REFERENCES wards(id),
  to_ward_id      INTEGER REFERENCES wards(id),
  kind            TEXT NOT NULL DEFAULT 'transfer',
  reason          TEXT,
  transferred_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  transferred_by  INTEGER REFERENCES users(id),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_admission_transfers_admission ON admission_transfers(admission_id);

-- Doctor's inpatient orders on a stay. beds.js, admission-modal.js. Cancelled by
-- flipping active=0 (never deleted); one-tap nurse execution lands in
-- med_administrations below.
CREATE TABLE admission_prescriptions (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  admission_id        INTEGER REFERENCES admissions(id),
  patient_id          INTEGER REFERENCES patients(id),
  name                TEXT,
  dose                TEXT,
  freq                TEXT,
  dur                 TEXT,
  nurse_notes         TEXT,
  prescribed_by       INTEGER REFERENCES users(id),
  prescribed_by_name  TEXT,
  active              INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_admission_prescriptions_admission ON admission_prescriptions(admission_id);

-- Nurse execution journal (same journal the doctor's cabinet reads). beds.js,
-- admission-modal.js, pharmacy.js. Append-only.
CREATE TABLE med_administrations (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  admission_id          INTEGER REFERENCES admissions(id),
  patient_id            INTEGER REFERENCES patients(id),
  med_name              TEXT,
  dose                  TEXT,
  instructions          TEXT,
  administered_by       INTEGER REFERENCES users(id),
  administered_by_name  TEXT,
  administered_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_med_administrations_admission ON med_administrations(admission_id);

-- Lab/diagnostic panel definitions. lab-settings.js. modality ∈ 'lab'/'diagnostic';
-- service_id links the billable catalog service; core_panel_id references the
-- medcore catalog (no local table → plain INTEGER).
CREATE TABLE lab_panels (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL,
  code           TEXT,
  modality       TEXT NOT NULL DEFAULT 'lab',
  has_narrative  INTEGER NOT NULL DEFAULT 0,
  service_id     INTEGER REFERENCES services(id),
  core_panel_id  INTEGER,
  active         INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- Analytes (result rows) within a panel. lab-settings.js. Saved by
-- delete-then-insert reconcile. value_type ∈ 'numeric'/'text'/'select';
-- ref_low/high plus sex-specific (_m/_f) ranges; ref_ranges = JSON of extra
-- named ranges (cycle phase, menopause, age bands).
CREATE TABLE lab_panel_analytes (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  panel_id       INTEGER REFERENCES lab_panels(id),
  code           TEXT,
  name           TEXT,
  unit           TEXT,
  value_type     TEXT NOT NULL DEFAULT 'numeric',
  value_options  TEXT,
  decimals       INTEGER NOT NULL DEFAULT 0,
  ref_low        REAL,
  ref_high       REAL,
  ref_text       TEXT,
  ref_low_m      REAL,
  ref_high_m     REAL,
  ref_low_f      REAL,
  ref_high_f     REAL,
  group_label    TEXT,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  ref_ranges     TEXT,
  active         INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_lab_panel_analytes_panel ON lab_panel_analytes(panel_id);
