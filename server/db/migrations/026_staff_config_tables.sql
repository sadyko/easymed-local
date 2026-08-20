-- 026 — staff / RBAC / branch config tables the original easymed admin screens
-- read+write. Columns are derived from real `.from('<table>')` usage in
-- public/js/admin (there are no original SQL migrations); see the header comment
-- on each table for the driving view file(s). Multi-tenant `company_id` is
-- intentionally omitted — Easy-Med Local is single-clinic and the query compiler
-- ignores that filter (TENANCY_NOOP_V1). No CHECK constraints (kept flexible).
-- FKs point only at tables that already exist locally (users, branches, departments).

-- Dynamic RBAC roles. admin.js (role preview), sections.js "Roles", section-crud.js,
-- permissions.js. `permissions` is the JSON blob the section_picker writes:
-- { sections:[...], levels:{...}, patient_tabs:{...} }. users.role_id → roles.id.
-- (Separate from the local `role_permissions` table — this is easymed's editable roles.)
CREATE TABLE roles (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  description  TEXT,
  permissions  TEXT,                  -- JSON: { sections:[...], levels:{...}, patient_tabs:{...} }
  active        INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- User ↔ branch assignment junction. branch-context.js (selects branches embed),
-- employee-editor.js (delete-then-insert on save), consultation-types.js,
-- cashier-shifts.js. Saved by clearing a user's rows then inserting the ticked
-- set, so (user_id, branch_id) is unique.
CREATE TABLE user_branches (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER REFERENCES users(id),
  branch_id   INTEGER REFERENCES branches(id),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (user_id, branch_id)
);
CREATE INDEX idx_user_branches_user ON user_branches(user_id);

-- Doctor specialties junction (up to 4 per doctor). employee-editor.js,
-- doctor-profile.js, service-workspace.js. Saved by delete-then-insert.
CREATE TABLE user_specialties (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER REFERENCES users(id),
  specialty_slug  TEXT,
  name_ru         TEXT,
  name_uz         TEXT,
  is_primary      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_user_specialties_user ON user_specialties(user_id);

-- Job positions. sections.js "Positions", employee-editor.js (ensureDoctorPosition
-- selects/inserts by is_doctor). department_id → departments.
CREATE TABLE positions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL,
  department_id  INTEGER REFERENCES departments(id),
  is_doctor      INTEGER NOT NULL DEFAULT 0,
  active         INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_positions_department ON positions(department_id);

-- Tele-medicine doctor profiles (parked/comingSoon catalog). sections.js
-- "Virtual doctors" (config-driven CRUD). user_id → users.
CREATE TABLE virtual_doctors (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id            INTEGER REFERENCES users(id),
  specialty          TEXT,
  consultation_fee   REAL NOT NULL DEFAULT 0,
  platforms          TEXT,
  availability_note  TEXT,
  active             INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_virtual_doctors_user ON virtual_doctors(user_id);

-- Doctor's saved clinical conditions / quick-picks (diseases + symptoms) surfaced
-- in the workspace dx picker. doctor-profile.js (doctor self-edit; delete-then-insert
-- on doctor_id). doctor_id → users.
CREATE TABLE doctor_conditions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  doctor_id   INTEGER REFERENCES users(id),
  kind        TEXT,                   -- 'disease' | 'symptom'
  slug        TEXT,
  name_ru     TEXT,
  name_uz     TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_doctor_conditions_doctor ON doctor_conditions(doctor_id);

-- Clinic company / legal entity. sections.js "Companies" (config-driven CRUD),
-- cash-shifts-store.js. Global (no company_id — this IS the company row).
CREATE TABLE companies (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  legal_name      TEXT,
  tax_id          TEXT,
  license_number  TEXT,
  director        TEXT,
  phone           TEXT,
  email           TEXT,
  website         TEXT,
  logo_url        TEXT,
  address         TEXT,
  active          INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
