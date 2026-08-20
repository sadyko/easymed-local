-- Add «Лучевая диагностика» (radiology) to the services.type routing set.
-- Changing a CHECK constraint requires rebuilding the table. `services` is
-- FK-referenced by visit_services / invoice_items / doctor_rates, so:
--   * PRAGMA defer_foreign_keys=ON defers FK enforcement to COMMIT, so dropping
--     `services` mid-transaction is tolerated.
--   * We keep the table NAME stable (drop + recreate as `services`, no RENAME) —
--     a RENAME rewrites child FK references and would break them here.
-- Row ids are copied unchanged, so at COMMIT every child FK resolves.
PRAGMA defer_foreign_keys=ON;

CREATE TABLE _services_bak AS SELECT * FROM services;
DROP TABLE services;

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
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  is_lab           INTEGER NOT NULL DEFAULT 0,
  specimen         TEXT,
  result_unit      TEXT,
  ref_low          REAL,
  ref_high         REAL,
  ref_text         TEXT,
  type             TEXT NOT NULL DEFAULT 'consultation'
                     CHECK (type IN ('consultation','lab','procedure','imaging','other','radiology'))
);
INSERT INTO services (id, name, code, price, tax_rate, duration_minutes, requires_doctor, active, created_at, updated_at, is_lab, specimen, result_unit, ref_low, ref_high, ref_text, type)
  SELECT id, name, code, price, tax_rate, duration_minutes, requires_doctor, active, created_at, updated_at, is_lab, specimen, result_unit, ref_low, ref_high, ref_text, type FROM _services_bak;
DROP TABLE _services_bak;
