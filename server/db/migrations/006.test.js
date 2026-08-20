import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

test('006 adds lab columns to services and creates lab_results', () => {
  const db = openDb(':memory:'); migrate(db);
  // services has the new lab columns with a default is_lab=0
  const sid = db.prepare("INSERT INTO services (name, price, is_lab, result_unit, ref_low, ref_high) VALUES ('CBC', 20000, 1, '10^9/L', 4, 11)").run().lastInsertRowid;
  const s = db.prepare('SELECT is_lab, result_unit, ref_low, ref_high FROM services WHERE id=?').get(sid);
  assert.equal(s.is_lab, 1);
  assert.equal(s.result_unit, '10^9/L');
  assert.equal(db.prepare("INSERT INTO services (name, price) VALUES ('Plain', 100)").run() && db.prepare("SELECT is_lab FROM services WHERE name='Plain'").get().is_lab, 0); // default 0

  // lab_results exists with a flag CHECK
  const pid = db.prepare("INSERT INTO patients (full_name, branch_id) VALUES ('P',1)").run().lastInsertRowid;
  const vid = db.prepare("INSERT INTO visits (patient_id, branch_id, visit_date) VALUES (?,1,'2026-08-12T09:00:00Z')").run(pid).lastInsertRowid;
  const vs = db.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total) VALUES (?,?,1,20000,20000)").run(vid,sid).lastInsertRowid;
  const lr = db.prepare("INSERT INTO lab_results (visit_service_id, value, numeric_value, unit, flag) VALUES (?, '7.2', 7.2, '10^9/L', 'normal')").run(vs).lastInsertRowid;
  assert.equal(db.prepare('SELECT flag FROM lab_results WHERE id=?').get(lr).flag, 'normal');
  assert.throws(() => db.prepare("INSERT INTO lab_results (visit_service_id, flag) VALUES (?, 'bogus')").run(vs));
});
