CREATE TABLE services (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT NOT NULL,
  code             TEXT,
  price            REAL NOT NULL DEFAULT 0,
  tax_rate         REAL NOT NULL DEFAULT 0,
  duration_minutes INTEGER NOT NULL DEFAULT 30,
  requires_doctor  INTEGER NOT NULL DEFAULT 0,
  active           INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE invoices (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_number TEXT UNIQUE,
  visit_id       INTEGER REFERENCES visits(id),
  patient_id     INTEGER NOT NULL REFERENCES patients(id),
  branch_id      INTEGER REFERENCES branches(id),
  subtotal       REAL NOT NULL DEFAULT 0,
  discount_amount REAL NOT NULL DEFAULT 0,
  total_amount   REAL NOT NULL DEFAULT 0,
  paid_amount    REAL NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'unpaid'
                   CHECK (status IN ('unpaid','partial','paid','debt','void','refunded')),
  created_by     INTEGER REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  paid_at        TEXT
);
CREATE INDEX idx_invoices_visit ON invoices(visit_id);
CREATE INDEX idx_invoices_patient ON invoices(patient_id);

CREATE TABLE invoice_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id  INTEGER NOT NULL REFERENCES invoices(id),
  service_id  INTEGER REFERENCES services(id),
  description TEXT NOT NULL DEFAULT '',
  quantity    INTEGER NOT NULL DEFAULT 1,
  unit_price  REAL NOT NULL DEFAULT 0,
  total       REAL NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_invoice_items_invoice ON invoice_items(invoice_id);

CREATE TABLE visit_services (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  visit_id        INTEGER NOT NULL REFERENCES visits(id),
  service_id      INTEGER REFERENCES services(id),
  doctor_id       INTEGER REFERENCES users(id),
  quantity        INTEGER NOT NULL DEFAULT 1,
  unit_price      REAL NOT NULL DEFAULT 0,
  total           REAL NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'added',
  invoice_item_id INTEGER REFERENCES invoice_items(id),
  created_by      INTEGER REFERENCES users(id),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_visit_services_visit ON visit_services(visit_id);

CREATE TABLE payments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  amount     REAL NOT NULL,
  method     TEXT NOT NULL DEFAULT 'cash',
  cashier_id INTEGER REFERENCES users(id),
  notes      TEXT NOT NULL DEFAULT '',
  paid_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_payments_invoice ON payments(invoice_id);
