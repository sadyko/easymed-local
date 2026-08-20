-- 024 — clinical/money "spine" tables the original easymed admin screens read+write.
-- Columns are derived from real `.from('<table>')` usage in public/js/admin (there
-- are no original SQL migrations); see the header comment on each table for the
-- driving view file(s). Multi-tenant shims (company_id/clinic_id) are intentionally
-- omitted — Easy-Med Local is single-clinic and the query-compiler ignores those
-- filters (TENANCY_NOOP_V1). No CHECK constraints (kept flexible). FKs point only
-- at tables that already exist locally.

-- Doctor orders / referrals. consultation.js, service-workspace.js, visit-modal.js.
CREATE TABLE recommended_services (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id           INTEGER REFERENCES patients(id),
  service_id           INTEGER REFERENCES services(id),
  service_name         TEXT,
  recommended_by       INTEGER REFERENCES users(id),
  recommended_by_name  TEXT,
  source_visit_id      INTEGER REFERENCES visits(id),
  notes                TEXT,
  status               TEXT NOT NULL DEFAULT 'pending',
  closed_at            TEXT,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_recommended_services_patient ON recommended_services(patient_id);
CREATE INDEX idx_recommended_services_by ON recommended_services(recommended_by);

-- Signed encounter snapshots + document archive. service-workspace.js, docs-archive.js.
CREATE TABLE visit_documents (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  title             TEXT,
  file_name         TEXT,
  file_path         TEXT,
  file_size         INTEGER,
  content_type      TEXT,
  doc_type          TEXT,
  visit_id          INTEGER REFERENCES visits(id),
  visit_service_id  INTEGER REFERENCES visit_services(id),
  patient_id        INTEGER REFERENCES patients(id),
  body              TEXT,                 -- JSON snapshot (protocol/diag payload, base64 images)
  created_by        INTEGER REFERENCES users(id),
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_visit_documents_patient ON visit_documents(patient_id);
CREATE INDEX idx_visit_documents_visit ON visit_documents(visit_id);
CREATE INDEX idx_visit_documents_vs ON visit_documents(visit_service_id);

-- Vitals strip (latest reading per patient). service-workspace.js.
CREATE TABLE patient_vitals (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id   INTEGER REFERENCES patients(id),
  visit_id     INTEGER REFERENCES visits(id),
  bp_sys       INTEGER,
  bp_dia       INTEGER,
  pulse_bpm    INTEGER,
  temp_c       REAL,
  spo2         INTEGER,
  resp_rate    INTEGER,
  height_cm    REAL,
  weight_kg    REAL,
  notes        TEXT,
  recorded_by  INTEGER REFERENCES users(id),
  recorded_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_patient_vitals_patient ON patient_vitals(patient_id);

-- Chronic conditions / structured medcard. data.js, service-workspace.js.
CREATE TABLE patient_conditions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id     INTEGER REFERENCES patients(id),
  code           TEXT,
  label          TEXT,
  since_date     TEXT,
  resolved_date  TEXT,
  status         TEXT NOT NULL DEFAULT 'active',
  severity       TEXT,
  note           TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_patient_conditions_patient ON patient_conditions(patient_id);

-- Legal representative / guardian links written at registration. registration.js, data.js.
CREATE TABLE patient_guardians (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id           INTEGER REFERENCES patients(id),
  guardian_patient_id  INTEGER REFERENCES patients(id),
  name                 TEXT,
  relationship         TEXT,
  phone                TEXT,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_patient_guardians_patient ON patient_guardians(patient_id);

-- Prepaid balance ledger (deposit / spent / refund rows). cashier.js, deposit-modal.js,
-- cashback.js, invoice-actions.js, service-picker-modal.js.
CREATE TABLE patient_deposits (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  deposit_number    TEXT,
  patient_id        INTEGER REFERENCES patients(id),
  branch_id         INTEGER REFERENCES branches(id),
  amount            REAL NOT NULL DEFAULT 0,
  method            TEXT,
  status            TEXT NOT NULL DEFAULT 'pending',
  notes             TEXT,
  refund_amount     REAL,
  created_by        INTEGER REFERENCES users(id),
  created_by_name   TEXT,
  received_by       INTEGER REFERENCES users(id),
  received_by_name  TEXT,
  received_at       TEXT,
  closed_at         TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_patient_deposits_patient ON patient_deposits(patient_id);

-- Shared «Шаблоны заключений» SOAP templates. documents.js, service-workspace.js.
CREATE TABLE consultation_templates (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  doc_type     TEXT,
  scope        TEXT NOT NULL DEFAULT 'shared',
  body         TEXT,                  -- JSON section map
  author_id    INTEGER REFERENCES users(id),
  author_name  TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- Per-doctor consultation prices/overrides. appointments.js, consultation-types.js,
-- employee-editor.js, service-workspace.js, service-picker-modal.js.
CREATE TABLE doctor_consultation_prices (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  doctor_id             INTEGER REFERENCES users(id),
  consultation_type_id  INTEGER REFERENCES consultation_types(id),
  price                 REAL,
  available             INTEGER NOT NULL DEFAULT 1,
  is_free               INTEGER NOT NULL DEFAULT 0,
  name_ru               TEXT,
  name_uz               TEXT,
  name_en               TEXT,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_doctor_consultation_prices_doctor ON doctor_consultation_prices(doctor_id);

-- Append-only invoice action trail. invoice-actions.js, visit-modal.js, cashier.js.
CREATE TABLE invoice_audit_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id      INTEGER REFERENCES invoices(id),
  invoice_number  TEXT,
  visit_id        INTEGER REFERENCES visits(id),
  action          TEXT,
  from_status     TEXT,
  to_status       TEXT,
  amount          REAL,
  refund_amount   REAL,
  actor_user_id   INTEGER REFERENCES users(id),
  actor_name      TEXT,
  actor_role      TEXT,
  reason          TEXT,
  notes           TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_invoice_audit_log_invoice ON invoice_audit_log(invoice_id);
CREATE INDEX idx_invoice_audit_log_visit ON invoice_audit_log(visit_id);

-- Queue numbers issued per service. cashier.js, service-picker-modal.js.
CREATE TABLE service_queue_tickets (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  visit_service_id  INTEGER REFERENCES visit_services(id),
  visit_id          INTEGER REFERENCES visits(id),
  service_id        INTEGER REFERENCES services(id),
  room_id           INTEGER REFERENCES rooms(id),
  number            INTEGER,
  label             TEXT,
  queue_key         TEXT,
  status            TEXT NOT NULL DEFAULT 'waiting',
  issued_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_service_queue_tickets_vs ON service_queue_tickets(visit_service_id);
CREATE INDEX idx_service_queue_tickets_visit ON service_queue_tickets(visit_id);
