CREATE TABLE departments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, code TEXT,
  kind TEXT NOT NULL DEFAULT 'clinical' CHECK (kind IN ('clinical','laboratory','diagnostics','procedure','inpatient','administrative')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE TABLE service_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, code TEXT,
  billing_mode TEXT NOT NULL DEFAULT 'one_time' CHECK (billing_mode IN ('one_time','continuable')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE TABLE consultation_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, price REAL NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE TABLE patient_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, tier TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE TABLE floors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, level INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE TABLE rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, floor_id INTEGER REFERENCES floors(id), active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE TABLE wards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE TABLE beds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL, ward_id INTEGER REFERENCES wards(id),
  status TEXT NOT NULL DEFAULT 'free' CHECK (status IN ('free','occupied','maintenance')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
