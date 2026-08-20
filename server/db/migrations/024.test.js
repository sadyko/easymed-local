import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

// 024 creates the 10 "clinical spine" tables the original easymed clinical/money
// screens read+write. Each table's key columns (incl. its main FK) are derived
// from the real `.from()` usage in public/js/admin — see 024_clinical_tables.sql.
const EXPECTED = {
  recommended_services:       ['patient_id', 'service_id', 'recommended_by', 'source_visit_id', 'status'],
  visit_documents:            ['patient_id', 'visit_id', 'visit_service_id', 'doc_type', 'body'],
  patient_vitals:             ['patient_id', 'bp_sys', 'pulse_bpm', 'recorded_at'],
  patient_conditions:         ['patient_id', 'code', 'label', 'status', 'since_date'],
  patient_guardians:          ['patient_id', 'guardian_patient_id', 'name', 'relationship'],
  patient_deposits:           ['patient_id', 'amount', 'method', 'status', 'refund_amount'],
  consultation_templates:     ['name', 'doc_type', 'scope', 'body', 'author_id'],
  doctor_consultation_prices: ['doctor_id', 'consultation_type_id', 'price', 'available', 'is_free'],
  invoice_audit_log:          ['invoice_id', 'visit_id', 'action', 'actor_user_id'],
  service_queue_tickets:      ['visit_service_id', 'number', 'queue_key', 'issued_at'],
};

test('024 creates all 10 clinical-spine tables', () => {
  const db = openDb(':memory:'); migrate(db);
  const names = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name)
  );
  for (const t of Object.keys(EXPECTED)) {
    assert.ok(names.has(t), 'missing table ' + t);
  }
});

test('024 each clinical-spine table has its key columns (incl. FK) + id/created_at', () => {
  const db = openDb(':memory:'); migrate(db);
  for (const [t, cols] of Object.entries(EXPECTED)) {
    const have = new Set(db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name));
    assert.ok(have.has('id'), t + ' missing id');
    assert.ok(have.has('created_at'), t + ' missing created_at');
    for (const c of cols) assert.ok(have.has(c), `${t} missing column ${c}`);
  }
});

test('024 tables are FK-clean and insertable against existing local tables', () => {
  const db = openDb(':memory:'); migrate(db);
  const p = db.prepare("INSERT INTO patients (full_name) VALUES ('P')").run().lastInsertRowid;
  const s = db.prepare("INSERT INTO services (name, price) VALUES ('Echo', 90000)").run().lastInsertRowid;
  const v = db.prepare("INSERT INTO visits (patient_id, visit_date) VALUES (?, '2026-08-06T09:00:00Z')").run(p).lastInsertRowid;
  const u = db.prepare("INSERT INTO users (username, password_hash, full_name, role) VALUES ('doc','h','Doc','doctor')").run().lastInsertRowid;

  db.prepare(`INSERT INTO recommended_services (patient_id, service_id, recommended_by, source_visit_id, status)
              VALUES (?,?,?,?, 'pending')`).run(p, s, u, v);
  db.prepare(`INSERT INTO patient_vitals (patient_id, bp_sys, pulse_bpm) VALUES (?, 120, 72)`).run(p);
  db.prepare(`INSERT INTO patient_conditions (patient_id, code, label, status) VALUES (?, 'I10', 'HTN', 'active')`).run(p);

  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  assert.equal(db.prepare("SELECT status FROM recommended_services WHERE patient_id=?").get(p).status, 'pending');
});
