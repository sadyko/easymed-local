-- 027 — reference / catalog tables the original easymed screens READ (mostly
-- read-only dropdown sources). Columns are derived from real `.from('<table>')`
-- usage in public/js/admin (there are no original SQL migrations); see the
-- header comment on each table for the driving view file(s). Multi-tenant shims
-- (company_id) are intentionally omitted — Easy-Med Local is single-clinic and
-- the query-compiler ignores that filter (TENANCY_NOOP_V1). No CHECK
-- constraints. These tables ship EMPTY: seeding reference rows (geo, ICD-10,
-- IKPU, units, tariffs) is a separate follow-up — the views just show empty
-- dropdowns until then. FK-safe create order: parents before children.

-- Geography — patient-registration country→region→district cascade.
-- registration.js (country/region/district selects), sections.js "Geography".
CREATE TABLE countries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  code        TEXT,                          -- ISO 3166-1 alpha-2 (UZ, RU, KZ…)
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE regions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  country_id  INTEGER REFERENCES countries(id),
  name        TEXT NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_regions_country ON regions(country_id);

CREATE TABLE districts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  region_id   INTEGER REFERENCES regions(id),
  name        TEXT NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_districts_region ON districts(region_id);

-- Fiscal IKPU codes (17-digit codes for receipts). sections.js "IKPU codes",
-- section-import-export.js (autoCreate {code,name}). services.ikpu_code_id links here.
CREATE TABLE ikpu_codes (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  code              TEXT NOT NULL,
  name              TEXT,
  group_code        TEXT,
  unit              TEXT,                     -- шт / услуга / kg …
  default_tax_rate  REAL DEFAULT 12,
  active            INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- Marked-goods (NNM) catalogue, linked to an IKPU code. sections.js "Product NNM".
CREATE TABLE product_nnm (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  nnm_code      TEXT NOT NULL,
  name          TEXT,
  ikpu_code_id  INTEGER REFERENCES ikpu_codes(id),
  manufacturer  TEXT,
  packaging     TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_product_nnm_ikpu ON product_nnm(ikpu_code_id);

-- Service category / direction tree (self-nesting). sections.js "Product
-- categories", section-crud.js, section-import-export.js. services.category_id links here.
CREATE TABLE service_categories (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  code         TEXT,
  name         TEXT NOT NULL,
  parent_id    INTEGER REFERENCES service_categories(id),
  description  TEXT,
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_service_categories_parent ON service_categories(parent_id);

-- ICD-10 diagnosis catalogue (14 000+ codes). service-workspace.js diagnosis
-- picker: .select('code,name') .order('code') .or(code.ilike/name.ilike). Read-only.
CREATE TABLE icd10 (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL,
  name        TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_icd10_code ON icd10(code);

-- Units of measure (shared unit-engine catalogue). procurement.js:
-- .select('code, name_ru, name_en, name_uz, kind') .eq('active',true) .order('code').
CREATE TABLE units (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL,
  name_ru     TEXT,
  name_en     TEXT,
  name_uz     TEXT,
  kind        TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- Subscription/price tariffs (read-only plan catalogue). upgrade-modal.js:
-- .select('key, display_name, tagline, price_monthly, currency, sort_order,
-- visible_in_modal, is_active') .eq('visible_in_modal',true) .eq('is_active',true)
-- .order('sort_order'). Uses is_active/visible_in_modal (NOT `active`).
CREATE TABLE tariffs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  key               TEXT,
  display_name      TEXT,
  tagline           TEXT,
  price_monthly     REAL,
  currency          TEXT,
  sort_order        INTEGER DEFAULT 0,
  visible_in_modal  INTEGER NOT NULL DEFAULT 1,
  is_active         INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- Reusable service-order templates (bundle of service ids). service-picker-modal.js:
-- insert {name, service_ids, active}; .select('id, name, service_ids')
-- .eq('active',true) .order('name'); soft-delete via update {active:false}.
CREATE TABLE service_templates (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  service_ids  TEXT,                          -- JSON array of service ids
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
