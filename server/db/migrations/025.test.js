import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

// 025 creates the 6 tables the original easymed INPATIENT (bed board / admission
// modal) and LAB (panel settings) screens read+write. Each table's key columns
// (incl. its main FK) are derived from real `.from()` usage in public/js/admin —
// see 025_inpatient_lab_tables.sql for the driving view file(s).
const EXPECTED = {
  admission_services:     ['admission_id', 'service_id', 'clinic_item_id', 'doctor_id', 'bed_id', 'ward_id',
                           'quantity', 'unit_price', 'total', 'status', 'billable', 'performed_at', 'invoice_item_id'],
  admission_transfers:    ['admission_id', 'from_bed_id', 'to_bed_id', 'from_ward_id', 'to_ward_id', 'kind',
                           'reason', 'transferred_at', 'transferred_by'],
  admission_prescriptions:['admission_id', 'patient_id', 'name', 'dose', 'freq', 'dur', 'nurse_notes',
                           'prescribed_by', 'prescribed_by_name', 'active'],
  med_administrations:    ['admission_id', 'patient_id', 'med_name', 'dose', 'instructions',
                           'administered_by', 'administered_by_name', 'administered_at'],
  lab_panels:             ['name', 'code', 'modality', 'has_narrative', 'service_id', 'active'],
  lab_panel_analytes:     ['panel_id', 'name', 'code', 'unit', 'value_type', 'ref_low', 'ref_high',
                           'ref_text', 'sort_order', 'active'],
};

test('025 creates all 6 inpatient + lab tables', () => {
  const db = openDb(':memory:'); migrate(db);
  const names = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name)
  );
  for (const t of Object.keys(EXPECTED)) {
    assert.ok(names.has(t), 'missing table ' + t);
  }
});

test('025 each table has its key columns (incl. main FK) + id/created_at', () => {
  const db = openDb(':memory:'); migrate(db);
  for (const [t, cols] of Object.entries(EXPECTED)) {
    const have = new Set(db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name));
    assert.ok(have.has('id'), t + ' missing id');
    assert.ok(have.has('created_at'), t + ' missing created_at');
    for (const c of cols) assert.ok(have.has(c), `${t} missing column ${c}`);
  }
});

test('025 tables are FK-clean and insertable against existing local tables', () => {
  const db = openDb(':memory:'); migrate(db);
  const p = db.prepare("INSERT INTO patients (full_name) VALUES ('P')").run().lastInsertRowid;
  const s = db.prepare("INSERT INTO services (name, price) VALUES ('Consult', 90000)").run().lastInsertRowid;
  const u = db.prepare("INSERT INTO users (username, password_hash, full_name, role) VALUES ('doc','h','Doc','doctor')").run().lastInsertRowid;
  const prod = db.prepare("INSERT INTO products (name) VALUES ('Gauze')").run().lastInsertRowid;
  const w = db.prepare("INSERT INTO wards (name) VALUES ('Ward A')").run().lastInsertRowid;
  const b = db.prepare("INSERT INTO beds (code, ward_id) VALUES ('A-1', ?)").run(w).lastInsertRowid;
  const a = db.prepare("INSERT INTO admissions (patient_id, bed_id, ward_id, doctor_id) VALUES (?,?,?,?)").run(p, b, w, u).lastInsertRowid;

  // service line (service_id set) and a product line (clinic_item_id → products)
  db.prepare(`INSERT INTO admission_services (admission_id, service_id, doctor_id, bed_id, ward_id, quantity, unit_price, total, status, billable, performed_at)
              VALUES (?,?,?,?,?, 1, 90000, 90000, 'added', 1, '2026-08-06T09:00:00Z')`).run(a, s, u, b, w);
  db.prepare(`INSERT INTO admission_services (admission_id, clinic_item_id, bed_id, ward_id, quantity, unit_price, total, status, billable)
              VALUES (?,?,?,?, 2, 3000, 6000, 'added', 0)`).run(a, prod, b, w);
  db.prepare(`INSERT INTO admission_transfers (admission_id, to_bed_id, to_ward_id, kind, transferred_by)
              VALUES (?,?,?, 'admit', ?)`).run(a, b, w, u);
  db.prepare(`INSERT INTO admission_prescriptions (admission_id, patient_id, name, dose, freq, prescribed_by, prescribed_by_name, active)
              VALUES (?,?, 'Paracetamol', '500 mg', '2x/day', ?, 'Doc', 1)`).run(a, p, u);
  db.prepare(`INSERT INTO med_administrations (admission_id, patient_id, med_name, dose, instructions, administered_by, administered_by_name)
              VALUES (?,?, 'Paracetamol', '500 mg', 'oral', ?, 'Nurse')`).run(a, p, u);

  const panel = db.prepare("INSERT INTO lab_panels (name, code, modality, service_id) VALUES ('CBC', 'CBC', 'lab', ?)").run(s).lastInsertRowid;
  db.prepare(`INSERT INTO lab_panel_analytes (panel_id, name, code, unit, value_type, ref_low, ref_high, sort_order)
              VALUES (?, 'Hemoglobin', 'HGB', 'g/L', 'numeric', 130, 170, 0)`).run(panel);

  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM admission_services WHERE admission_id=?").get(a).n, 2);
  assert.equal(db.prepare("SELECT active FROM admission_prescriptions WHERE admission_id=?").get(a).active, 1);
  assert.equal(db.prepare("SELECT name FROM lab_panel_analytes WHERE panel_id=?").get(panel).name, 'Hemoglobin');
});
