import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

// 026 creates the 7 tables the original easymed STAFF / RBAC / BRANCH config
// screens read+write. Each table's real columns are derived from the actual
// `.from()` usage in public/js/admin — see 026_staff_config_tables.sql for the
// driving view file(s). Multi-tenant `company_id` is intentionally omitted
// (single-clinic; the query compiler ignores that filter).
const EXPECTED = {
  roles:             ['name', 'description', 'permissions', 'active'],
  user_branches:     ['user_id', 'branch_id'],
  user_specialties:  ['user_id', 'specialty_slug', 'name_ru', 'name_uz', 'is_primary'],
  positions:         ['name', 'department_id', 'is_doctor', 'active'],
  virtual_doctors:   ['user_id', 'specialty', 'consultation_fee', 'platforms', 'availability_note', 'active'],
  doctor_conditions: ['doctor_id', 'kind', 'slug', 'name_ru', 'name_uz'],
  companies:         ['name', 'legal_name', 'tax_id', 'license_number', 'director', 'phone',
                      'email', 'website', 'logo_url', 'address', 'active'],
};

test('026 creates all 7 staff/RBAC/branch config tables', () => {
  const db = openDb(':memory:'); migrate(db);
  const names = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name)
  );
  for (const t of Object.keys(EXPECTED)) {
    assert.ok(names.has(t), 'missing table ' + t);
  }
});

test('026 each table has its key columns (incl. FK) + id/created_at', () => {
  const db = openDb(':memory:'); migrate(db);
  for (const [t, cols] of Object.entries(EXPECTED)) {
    const have = new Set(db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name));
    assert.ok(have.has('id'), t + ' missing id');
    assert.ok(have.has('created_at'), t + ' missing created_at');
    for (const c of cols) assert.ok(have.has(c), `${t} missing column ${c}`);
  }
});

test('026 FKs point at existing local tables (users/branches/departments)', () => {
  const db = openDb(':memory:'); migrate(db);
  const fkTargets = t => db.prepare(`PRAGMA foreign_key_list(${t})`).all().map(f => f.table);
  assert.ok(fkTargets('user_branches').includes('users'));
  assert.ok(fkTargets('user_branches').includes('branches'));
  assert.ok(fkTargets('user_specialties').includes('users'));
  assert.ok(fkTargets('positions').includes('departments'));
  assert.ok(fkTargets('virtual_doctors').includes('users'));
  assert.ok(fkTargets('doctor_conditions').includes('users'));
});

test('026 tables are FK-clean and insertable against existing local tables', () => {
  const db = openDb(':memory:'); migrate(db);
  const u = db.prepare("INSERT INTO users (username, password_hash, full_name, role) VALUES ('doc','h','Doc','doctor')").run().lastInsertRowid;
  const b = db.prepare("INSERT INTO branches (name) VALUES ('Main')").run().lastInsertRowid;
  const d = db.prepare("INSERT INTO departments (name) VALUES ('Cardiology')").run().lastInsertRowid;

  db.prepare(`INSERT INTO roles (name, description, permissions, active)
              VALUES ('Receptionist', 'Front desk', '{"sections":["registration"],"levels":{"registration":"editor"}}', 1)`).run();
  db.prepare(`INSERT INTO positions (name, department_id, is_doctor, active) VALUES ('Senior Cardiologist', ?, 1, 1)`).run(d);
  db.prepare(`INSERT INTO user_branches (user_id, branch_id) VALUES (?, ?)`).run(u, b);
  db.prepare(`INSERT INTO user_specialties (user_id, specialty_slug, name_ru, name_uz, is_primary)
              VALUES (?, 'cardiology', 'Кардиология', 'Kardiologiya', 1)`).run(u);
  db.prepare(`INSERT INTO virtual_doctors (user_id, specialty, consultation_fee, platforms, availability_note, active)
              VALUES (?, 'Cardiology', 150000, 'Telegram, Zoom', 'Mon-Fri', 1)`).run(u);
  db.prepare(`INSERT INTO doctor_conditions (doctor_id, kind, slug, name_ru, name_uz)
              VALUES (?, 'disease', 'htn', 'Гипертония', 'Gipertoniya')`).run(u);
  db.prepare(`INSERT INTO companies (name, legal_name, tax_id, license_number, director, active)
              VALUES ('Easy-Med', 'Easy-Med LLC', '123456789', 'LIC-1', 'Dr. Ivanov', 1)`).run();

  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  assert.equal(db.prepare('SELECT branch_id FROM user_branches WHERE user_id=?').get(u).branch_id, b);
  assert.equal(db.prepare('SELECT consultation_fee FROM virtual_doctors WHERE user_id=?').get(u).consultation_fee, 150000);
});

test('026 user_branches is unique per (user_id, branch_id)', () => {
  const db = openDb(':memory:'); migrate(db);
  const u = db.prepare("INSERT INTO users (username, password_hash, full_name, role) VALUES ('doc','h','Doc','doctor')").run().lastInsertRowid;
  const b = db.prepare("INSERT INTO branches (name) VALUES ('Main')").run().lastInsertRowid;
  db.prepare(`INSERT INTO user_branches (user_id, branch_id) VALUES (?, ?)`).run(u, b);
  assert.throws(() => db.prepare(`INSERT INTO user_branches (user_id, branch_id) VALUES (?, ?)`).run(u, b));
});
