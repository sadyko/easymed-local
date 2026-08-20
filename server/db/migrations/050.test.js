import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

// LAB_TEMPLATES_V1 — the catalogue the clinic imports panels from, seeded from
// the Symptex service workbook (laboratory branch).

test('050 seeds the full laboratory catalogue', () => {
  const db = openDb(':memory:'); migrate(db);
  const n = db.prepare('SELECT COUNT(*) n FROM lab_panel_templates').get().n;
  assert.equal(n, 1002, 'every laboratory service in the workbook became a template');

  const cats = db.prepare('SELECT DISTINCT category FROM lab_panel_templates WHERE category IS NOT NULL').all();
  assert.equal(cats.length, 16, 'all 16 laboratory categories are represented');

  const cbc = db.prepare("SELECT * FROM lab_panel_templates WHERE code = 'klinicheskiy-analiz-krovi'").get();
  assert.ok(cbc, 'the CBC template exists');
  assert.match(cbc.name, /Клинический анализ крови/);
  assert.equal(cbc.category, 'Общеклинические исследования');
  assert.equal(cbc.specimen, 'Кровь');
  assert.ok(cbc.preparation && cbc.preparation.length > 10, 'patient preparation text came across');
});

test('050 templates are inert — nothing reaches the clinic until it is imported', () => {
  const db = openDb(':memory:'); migrate(db);
  // The seed must not create clinic-visible rows. A fresh install shows an empty
  // lab, not 1002 panels and services nobody chose.
  assert.equal(db.prepare('SELECT COUNT(*) n FROM lab_panels').get().n, 0, 'no clinic panels created');
  const svc = db.prepare("SELECT COUNT(*) n FROM services WHERE code IS NOT NULL AND code <> 'LAB-CBC'").get().n;
  assert.equal(svc, 0, 'no clinic services created from templates');
});

test('051 gives the multi-indicator panels their parameters', () => {
  const db = openDb(':memory:'); migrate(db);
  const rows = db.prepare(`
    SELECT t.code, COUNT(a.id) n FROM lab_panel_templates t
      JOIN lab_panel_template_analytes a ON a.template_id = t.id
     GROUP BY t.code ORDER BY t.code`).all();
  const byCode = Object.fromEntries(rows.map(r => [r.code, r.n]));
  assert.equal(byCode['klinicheskiy-analiz-krovi'], 17);
  assert.equal(byCode['obschiy-analiz-mochi'], 18);
  assert.equal(byCode['spermogramma'], 14);
  assert.equal(rows.length, 9, 'nine panels carry indicator lists');

  const cbc = db.prepare(`
    SELECT a.name, a.unit, a.value_type, a.group_label FROM lab_panel_template_analytes a
      JOIN lab_panel_templates t ON t.id = a.template_id
     WHERE t.code = 'klinicheskiy-analiz-krovi' ORDER BY a.sort_order`).all();
  assert.equal(cbc[0].name, 'Эритроциты (RBC)');
  assert.equal(cbc[0].unit, '10^12/л');
  assert.equal(cbc[0].group_label, 'Эритроцитарные показатели');
  assert.ok(cbc.some(a => a.group_label === 'Лейкоцитарная формула'), 'the differential is its own group');
});

test('051 uses all three result types where they belong', () => {
  const db = openDb(':memory:'); migrate(db);
  const urine = db.prepare(`
    SELECT a.name, a.value_type, a.value_options FROM lab_panel_template_analytes a
      JOIN lab_panel_templates t ON t.id = a.template_id
     WHERE t.code = 'obschiy-analiz-mochi'`).all();
  assert.ok(urine.some(a => a.value_type === 'text'), 'Цвет is free text');
  assert.ok(urine.some(a => a.value_type === 'numeric'), 'Белок is numeric');
  const sel = urine.find(a => a.value_type === 'select');
  assert.ok(sel, 'Прозрачность is a list');
  assert.ok((sel.value_options || '').includes(','), 'a list carries its options');
});

// THE GUARANTEE. Reference ranges depend on the analyser, method and population
// each laboratory uses — one clinic's numbers are wrong in another, and a wrong
// range on a patient's report is a clinical error. The template tables therefore
// have NO range columns at all, so a future seed cannot introduce them by
// accident. If this test fails, someone added range data to the catalogue.
test('050/051 ship NO reference values of any kind', () => {
  const db = openDb(':memory:'); migrate(db);
  const cols = db.prepare('PRAGMA table_info(lab_panel_template_analytes)').all().map(c => c.name);
  for (const forbidden of ['ref_low', 'ref_high', 'ref_text', 'ref_low_m', 'ref_high_m', 'ref_low_f', 'ref_high_f', 'ref_ranges']) {
    assert.ok(!cols.includes(forbidden), `template analytes must not carry ${forbidden}`);
  }
  // And the clinic's own analyte table, which DOES have them, is still empty.
  assert.equal(db.prepare('SELECT COUNT(*) n FROM lab_panel_analytes').get().n, 0);
});
