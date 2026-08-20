import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

// 027 creates the 10 reference / catalog tables the original easymed screens
// READ (mostly read-only dropdown sources). Each table's real columns are
// derived from the actual `.from()` usage in public/js/admin — see
// 027_reference_tables.sql for the driving view file(s). These tables ship
// EMPTY (seeding is a separate follow-up).
const EXPECTED = {
  countries:          ['name', 'code', 'active'],
  regions:            ['country_id', 'name', 'active'],
  districts:          ['region_id', 'name', 'active'],
  ikpu_codes:         ['code', 'name', 'group_code', 'unit', 'default_tax_rate', 'active'],
  product_nnm:        ['nnm_code', 'name', 'ikpu_code_id', 'manufacturer', 'packaging', 'active'],
  service_categories: ['code', 'name', 'parent_id', 'description', 'active'],
  icd10:              ['code', 'name', 'active'],
  units:              ['code', 'name_ru', 'name_en', 'name_uz', 'kind', 'active'],
  tariffs:            ['key', 'display_name', 'price_monthly', 'currency', 'sort_order', 'visible_in_modal', 'is_active'],
  service_templates:  ['name', 'service_ids', 'active'],
};

test('027 creates all 10 reference/catalog tables', () => {
  const db = openDb(':memory:'); migrate(db);
  const names = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name)
  );
  for (const t of Object.keys(EXPECTED)) {
    assert.ok(names.has(t), 'missing table ' + t);
  }
});

test('027 each table has its key columns + id/created_at', () => {
  const db = openDb(':memory:'); migrate(db);
  for (const [t, cols] of Object.entries(EXPECTED)) {
    const have = new Set(db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name));
    assert.ok(have.has('id'), t + ' missing id');
    assert.ok(have.has('created_at'), t + ' missing created_at');
    for (const c of cols) assert.ok(have.has(c), `${t} missing column ${c}`);
  }
});

test('027 self/sibling FKs point at the right tables', () => {
  const db = openDb(':memory:'); migrate(db);
  const fkTargets = t => db.prepare(`PRAGMA foreign_key_list(${t})`).all().map(f => f.table);
  assert.ok(fkTargets('regions').includes('countries'));
  assert.ok(fkTargets('districts').includes('regions'));
  assert.ok(fkTargets('product_nnm').includes('ikpu_codes'));
  assert.ok(fkTargets('service_categories').includes('service_categories'));   // self-FK
});

test('027 geo cascade round-trips FK-clean (country → region → district)', () => {
  const db = openDb(':memory:'); migrate(db);
  const c = db.prepare("INSERT INTO countries (name, code) VALUES ('Uzbekistan', 'UZ')").run().lastInsertRowid;
  const r = db.prepare("INSERT INTO regions (country_id, name) VALUES (?, 'Tashkent')").run(c).lastInsertRowid;
  const d = db.prepare("INSERT INTO districts (region_id, name) VALUES (?, 'Chilonzor')").run(r).lastInsertRowid;

  // sibling-FK + self-FK inserts created in this migration
  const ik = db.prepare("INSERT INTO ikpu_codes (code, name) VALUES ('10203004005006007', 'Consultation')").run().lastInsertRowid;
  db.prepare("INSERT INTO product_nnm (nnm_code, name, ikpu_code_id) VALUES ('NNM-1', 'Gauze', ?)").run(ik);
  const parent = db.prepare("INSERT INTO service_categories (name) VALUES ('Diagnostics')").run().lastInsertRowid;
  db.prepare("INSERT INTO service_categories (name, parent_id) VALUES ('MRI', ?)").run(parent);

  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  assert.equal(db.prepare('SELECT country_id FROM regions WHERE id=?').get(r).country_id, c);
  assert.equal(db.prepare('SELECT region_id FROM districts WHERE id=?').get(d).region_id, r);
});
