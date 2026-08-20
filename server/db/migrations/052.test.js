import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

// LAB_ANALYTE_LIBRARY_V1 — the dictionary of laboratory PARAMETERS the panel
// editor offers when you add an indicator, so building a panel is picking from a
// list rather than typing every row by hand.

test('052 seeds the parameter library', () => {
  const db = openDb(':memory:'); migrate(db);
  const n = db.prepare('SELECT COUNT(*) n FROM lab_analyte_templates').get().n;
  assert.equal(n, 190, 'every curated parameter became a library row');

  const hgb = db.prepare("SELECT * FROM lab_analyte_templates WHERE name = 'Гемоглобин'").get();
  assert.ok(hgb, 'Гемоглобин is in the library');
  assert.equal(hgb.unit, 'г/л');
  assert.equal(hgb.category, 'Гематология');
  assert.equal(hgb.value_type, 'numeric');
});

test('052 categorises every parameter, using the panel catalogue vocabulary', () => {
  const db = openDb(':memory:'); migrate(db);
  const uncategorised = db.prepare('SELECT COUNT(*) n FROM lab_analyte_templates WHERE category IS NULL').get().n;
  assert.equal(uncategorised, 0, 'a parameter with no category cannot be found by filter');

  // The picker filters by the same categories as the panel catalogue, so the two
  // vocabularies must not drift apart.
  const mine = db.prepare('SELECT DISTINCT category FROM lab_analyte_templates').all().map((r) => r.category);
  const catalogue = new Set(db.prepare('SELECT DISTINCT category FROM lab_panel_templates WHERE category IS NOT NULL').all().map((r) => r.category));
  for (const c of mine) assert.ok(catalogue.has(c), `"${c}" is not one of the catalogue's categories`);
});

test('052 carries units and result types, and select options where they belong', () => {
  const db = openDb(':memory:'); migrate(db);
  const types = db.prepare('SELECT value_type, COUNT(*) n FROM lab_analyte_templates GROUP BY value_type').all();
  const byType = Object.fromEntries(types.map((r) => [r.value_type, r.n]));
  assert.ok(byType.numeric > 100, 'most parameters are numeric');
  assert.ok(byType.text > 0 && byType.select > 0, 'text and select are both represented');

  for (const row of db.prepare("SELECT name, value_options FROM lab_analyte_templates WHERE value_type = 'select'").all()) {
    assert.ok((row.value_options || '').includes(','), `${row.name} is a list but carries no options`);
  }
  const blood = db.prepare("SELECT * FROM lab_analyte_templates WHERE name LIKE 'Группа%'").get();
  assert.equal(blood.value_type, 'select');
  assert.match(blood.value_options, /O\(I\)/);
});

test('052 codes are unique, so re-seeding cannot duplicate a parameter', () => {
  const db = openDb(':memory:'); migrate(db);
  const total = db.prepare('SELECT COUNT(*) n FROM lab_analyte_templates').get().n;
  const distinct = db.prepare('SELECT COUNT(DISTINCT code) n FROM lab_analyte_templates').get().n;
  assert.equal(distinct, total, 'every parameter has its own code');
  assert.throws(
    () => db.prepare("INSERT INTO lab_analyte_templates (code, name) VALUES ('gemoglobin', 'x')").run(),
    /UNIQUE/i,
    'the unique index is real, not decorative');
});

test('052 rejects a result type the editor cannot render', () => {
  const db = openDb(':memory:'); migrate(db);
  assert.throws(
    () => db.prepare("INSERT INTO lab_analyte_templates (code, name, value_type) VALUES ('x', 'x', 'freeform')").run(),
    /CHECK/i);
});

test('052 is inert — nothing reaches the clinic until a parameter is picked', () => {
  const db = openDb(':memory:'); migrate(db);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM lab_panel_analytes').get().n, 0, 'no clinic analytes created');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM lab_panels').get().n, 0, 'no clinic panels created');
});

// THE GUARANTEE, same as 050/051. Reference ranges depend on the analyser, method
// and population each laboratory uses — one clinic's numbers are wrong in another,
// and a wrong range on a patient's report is a clinical error. This table has no
// range columns at all, so a future seed cannot introduce them by accident.
// If this test fails, someone added range data to the parameter library.
test('052 ships NO reference values of any kind', () => {
  const db = openDb(':memory:'); migrate(db);
  const cols = db.prepare('PRAGMA table_info(lab_analyte_templates)').all().map((c) => c.name);
  for (const forbidden of ['ref_low', 'ref_high', 'ref_text', 'ref_low_m', 'ref_high_m', 'ref_low_f', 'ref_high_f', 'ref_ranges']) {
    assert.ok(!cols.includes(forbidden), `the parameter library must not carry ${forbidden}`);
  }
});

// The server modelled age bands as separate analytes — "СвободныйТ4 (2-11лет)",
// "(12-19лет)", "(20-100лет)" were three rows for one measurement. An age band is
// a property of a RANGE, not of a parameter, so the curation collapsed them.
test('052 collapsed the age-band duplicates into one parameter each', () => {
  const db = openDb(':memory:'); migrate(db);
  const withAge = db.prepare(
    "SELECT name FROM lab_analyte_templates WHERE name LIKE '%лет%' OR name LIKE '%год%'").all();
  assert.equal(withAge.length, 0, `an age band leaked into a parameter name: ${withAge.map((r) => r.name).join(', ')}`);

  const t4 = db.prepare("SELECT COUNT(*) n FROM lab_analyte_templates WHERE name LIKE '%Т4%'").get().n;
  assert.equal(t4, 1, 'free T4 is one parameter, not three age variants');
});
