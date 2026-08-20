import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { compile } from '../query-compiler.js';

const LAB = { id: 5, role: 'lab' };
const ADMIN = { id: 1, role: 'admin' };
const CASHIER = { id: 9, role: 'cashier' };

function freshDb() { const db = openDb(':memory:'); migrate(db); return db; }

test('041 lab handling columns exist', () => {
  const db = freshDb();
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  for (const c of ['sample_collected_at', 'verified_by', 'verified_at']) {
    assert.ok(cols('visit_services').includes(c), 'visit_services.' + c);
  }
  assert.ok(cols('services').includes('tube_color'), 'services.tube_color');
  for (const c of ['ref_low', 'ref_high']) {
    assert.ok(cols('lab_results').includes(c), 'lab_results.' + c);
  }
});

// 042 (LAB_NO_PANEL_SEED_V1) removes the 041 panel fixture again: the lab
// runs PANEL-LESS until the clinic builds its own catalogue. End state after
// a full migrate(): one orderable CBC lab service, ZERO panels/analytes.
test('041+042 end state: CBC lab service seeded, no panel fixture survives', () => {
  const db = freshDb();
  assert.equal(db.prepare('SELECT COUNT(*) n FROM lab_panels').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM lab_panel_analytes').get().n, 0);
  const svc = db.prepare("SELECT * FROM services WHERE code = 'LAB-CBC'").get();
  assert.ok(svc, 'the workflow stays orderable via the seeded lab service');
  assert.equal(svc.is_lab, 1);
  assert.equal(svc.tube_color, 'lavender');
});

// Design rule (2026-08-08 v2), the one guarantee that must not silently
// regress: seeds ship STRUCTURE ONLY — «Reference range values of any kind»
// are excluded. Ranges depend on each lab's analyser and method; the clinic
// fills its own numbers in the settings editor.
test('041 seed carries NO reference range values anywhere', () => {
  const db = freshDb();
  const svc = db.prepare("SELECT * FROM services WHERE code = 'LAB-CBC'").get();
  assert.ok(svc, 'fixture service seeded');
  assert.equal(svc.ref_low, null);
  assert.equal(svc.ref_high, null);
  assert.ok(svc.ref_text == null || svc.ref_text === '');
  // and no analyte rows exist at all to carry ranges
  for (const a of db.prepare('SELECT * FROM lab_panel_analytes').all()) {
    for (const col of ['ref_low', 'ref_high', 'ref_low_m', 'ref_high_m', 'ref_low_f', 'ref_high_f']) {
      assert.equal(a[col], null, `analyte ${a.code}: ${col} must be NULL`);
    }
  }
});

test('041 registry: lab collects and verifies; cashier cannot touch the queue', () => {
  // collect: status + sample stamp
  const collect = compile({
    table: 'visit_services', op: 'update',
    values: { status: 'collected', sample_collected_at: '2026-08-08T09:00:00Z' },
    filters: [{ col: 'id', op: 'eq', val: 1 }],
  }, LAB);
  assert.ok(collect.sql.includes('UPDATE'));

  // verify: completed + verify stamps
  const verify = compile({
    table: 'visit_services', op: 'update',
    values: { status: 'completed', verified_by: 5, verified_at: '2026-08-08T10:00:00Z' },
    filters: [{ col: 'id', op: 'eq', val: 1 }],
  }, LAB);
  assert.ok(verify.sql.includes('UPDATE'));

  // the two NEW status values are plain TEXT — 'resulted' compiles as well
  compile({ table: 'visit_services', op: 'update', values: { status: 'resulted' }, filters: [{ col: 'id', op: 'eq', val: 1 }] }, LAB);

  // cashier is not in the visit_services update roles
  assert.throws(() => compile({
    table: 'visit_services', op: 'update', values: { status: 'collected' },
    filters: [{ col: 'id', op: 'eq', val: 1 }],
  }, CASHIER), /role|allow|forbid/i);
});

test('041 registry: lab writes numeric ranges on results; tube_color is admin-only', () => {
  const ins = compile({
    table: 'lab_results', op: 'insert',
    values: { visit_service_id: 1, parameter: 'HGB', value: '135', numeric_value: 135, unit: 'г/л', ref_low: 130, ref_high: 160, flag: 'normal', entered_by: 5 },
  }, LAB);
  assert.ok(ins.sql.includes('INSERT'));

  const upd = compile({
    table: 'services', op: 'update', values: { tube_color: 'red' },
    filters: [{ col: 'id', op: 'eq', val: 1 }],
  }, ADMIN);
  assert.ok(upd.sql.includes('UPDATE'));

  assert.throws(() => compile({
    table: 'services', op: 'update', values: { tube_color: 'red' },
    filters: [{ col: 'id', op: 'eq', val: 1 }],
  }, LAB), /role|allow|forbid/i);
});

// ---------------------------------------------------------------------------
// Regressions found 2026-08-10. All three broke the lab at runtime while every
// test still passed, because they live in the payload/value layer rather than
// in the workflow logic.
// ---------------------------------------------------------------------------

test('a panel with named ranges saves from a raw array payload', () => {
  // savePanel in lab-settings.js sends ref_ranges as a JS array. bindable()
  // rejects arrays with a 400, so this only works because the registry declares
  // ref_ranges as a JSON column and bindWrite() serialises it. Without that
  // declaration, saving any panel carrying a named range fails outright.
  const db = openDb(':memory:'); migrate(db);
  const svc = db.prepare("INSERT INTO services (name, price, type) VALUES ('ОАК', 1, 'lab')").run().lastInsertRowid;
  const pi = compile({ table: 'lab_panels', op: 'insert', values: { name: 'ОАК', service_id: svc, modality: 'lab' } }, LAB);
  const pid = db.prepare(pi.sql).run(...pi.params).lastInsertRowid;

  const ranges = [{ label: 'Менопауза', sex: 'female', age_min: 50, age_max: null, low: 30, high: 40, text: '' }];
  const ai = compile({ table: 'lab_panel_analytes', op: 'insert', values: [
    { panel_id: pid, name: 'Гемоглобин', unit: 'g/l', value_type: 'numeric', sort_order: 0, ref_ranges: ranges },
  ]}, LAB);
  db.prepare(ai.sql).run(...ai.params);

  const row = db.prepare('SELECT ref_ranges FROM lab_panel_analytes WHERE panel_id = ?').get(pid);
  assert.equal(typeof row.ref_ranges, 'string', 'stored as JSON text');
  assert.equal(JSON.parse(row.ref_ranges)[0].label, 'Менопауза');

  const sel = compile({ table: 'lab_panel_analytes', op: 'select', columns: '*',
    filters: [{ col: 'panel_id', op: 'eq', val: pid }] }, LAB);
  assert.ok(sel.meta.json.includes('ref_ranges'), 'the read path parses it back to an array');
});

test('a result saves with a blank note and a non-numeric analyte', () => {
  // lab_results.flag and .notes are both NOT NULL. Binding NULL OVERRIDES a
  // column default rather than falling back to it, so the results modal must
  // send 'normal' and '' — not null. Sending null failed every save: notes on
  // every result, flag on every text or select analyte.
  const db = openDb(':memory:'); migrate(db);
  const svc = db.prepare("INSERT INTO services (name, price) VALUES ('Глюкоза', 1)").run().lastInsertRowid;
  const pat = db.prepare("INSERT INTO patients (mrn, full_name) VALUES ('M9','Т')").run().lastInsertRowid;
  const vis = db.prepare('INSERT INTO visits (patient_id, visit_date) VALUES (?,?)').run(pat, '2026-08-12T09:00:00Z').lastInsertRowid;
  const vs = db.prepare('INSERT INTO visit_services (visit_id, service_id, unit_price, total) VALUES (?,?,0,0)').run(vis, svc).lastInsertRowid;

  const ins = (vals) => {
    const c = compile({ table: 'lab_results', op: 'insert', values: { visit_service_id: vs, ...vals } }, LAB);
    return db.prepare(c.sql).run(...c.params);
  };

  ins({ parameter: 'Группа крови', value: 'A(II)', flag: 'normal', notes: '' });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM lab_results WHERE visit_service_id = ?').get(vs).n, 1);

  assert.throws(() => ins({ parameter: 'X', value: '1', flag: 'normal', notes: null }), /NOT NULL/, 'a null note is rejected');
  assert.throws(() => ins({ parameter: 'Y', value: '1', flag: null, notes: '' }), /NOT NULL/, 'a null flag is rejected');
});
