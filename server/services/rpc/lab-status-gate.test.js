// INPATIENT_MONEY_FIX_V1 — амбулаторные дыры лаборатории и снятия услуги.
//
//   • save_lab_results принимал результат на НЕОПЛАЧЕННУЮ ('added') и на
//     ОТМЕНЁННУЮ услугу, а пересохранение проверенного анализа оставляло
//     отметку проверки — новый результат выдавался как проверенный;
//   • remove_unpaid_service снимал взятый/готовый анализ (на готовом падал 500
//     на внешнем ключе lab_results), change_unpaid_service переносил бы
//     результаты на другую услугу.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { saveLabResults } from './lab.js';
import { removeUnpaidService, changeUnpaidService } from './billing.js';

const lab = { id: 2, role: 'lab' };
const admin = { id: 1, role: 'admin' };

function seed(status, extra = '') {
  const db = openDb(':memory:');
  migrate(db);
  const u = db.prepare('INSERT INTO users (id,username,password_hash,full_name,role) VALUES (?,?,?,?,?)');
  u.run(1, 'boss', 'x', 'Админ', 'admin');
  u.run(2, 'lab1', 'x', 'Лаборант', 'lab');
  const p = db.prepare("INSERT INTO patients (full_name) VALUES ('Пациент')").run().lastInsertRowid;
  const v = db.prepare("INSERT INTO visits (patient_id, visit_date) VALUES (?, date('now'))").run(p).lastInsertRowid;
  const s = db.prepare("INSERT INTO services (name, price, is_lab, active) VALUES ('ОАК', 50000, 1, 1)").run().lastInsertRowid;
  const s2 = db.prepare("INSERT INTO services (name, price, is_lab, active) VALUES ('Глюкоза', 30000, 1, 1)").run().lastInsertRowid;
  const vs = db.prepare(`INSERT INTO visit_services (visit_id, service_id, status, quantity, unit_price, total ${extra ? ', verified_at, verified_by' : ''})
                         VALUES (?,?,?,1,50000,50000 ${extra ? ", '2026-09-01T10:00:00Z', 2" : ''})`).run(v, s, status).lastInsertRowid;
  return { db, vs, s2 };
}
const one = [{ parameter: 'Hb', value: '120', flag: 'normal' }];
const count = (db, vs) => db.prepare('SELECT COUNT(*) n FROM lab_results WHERE visit_service_id = ?').get(vs).n;

test('результат не принимается на неоплаченную и на отменённую услугу', () => {
  for (const status of ['added', 'cancelled']) {
    const { db, vs } = seed(status);
    try {
      assert.throws(() => saveLabResults(db, { visit_service_id: vs, rows: one }, lab), (e) => e.status === 400, status);
      assert.equal(count(db, vs), 0, status);
      assert.equal(db.prepare('SELECT status FROM visit_services WHERE id = ?').get(vs).status, status);
    } finally { db.close(); }
  }
});

test('оплаченный, взятый и в работе — принимается, как и прежде', () => {
  for (const status of ['queued', 'collected', 'in_progress', 'resulted']) {
    const { db, vs } = seed(status);
    try {
      saveLabResults(db, { visit_service_id: vs, rows: one }, lab);
      assert.equal(db.prepare('SELECT status FROM visit_services WHERE id = ?').get(vs).status, 'resulted', status);
    } finally { db.close(); }
  }
});

test('правка проверенного анализа снимает отметку проверки — снова на проверку', () => {
  const { db, vs } = seed('completed', 'verified');
  try {
    db.prepare("INSERT INTO lab_results (visit_service_id, parameter, value, flag, notes, verified_by, verified_at) VALUES (?, 'Hb', '110', 'normal', '', 2, '2026-09-01T10:00:00Z')").run(vs);
    saveLabResults(db, { visit_service_id: vs, rows: one }, lab);
    const line = db.prepare('SELECT status, verified_at, verified_by FROM visit_services WHERE id = ?').get(vs);
    assert.deepEqual({ ...line }, { status: 'resulted', verified_at: null, verified_by: null });
    const r = db.prepare('SELECT verified_at FROM lab_results WHERE visit_service_id = ?').all(vs);
    assert.ok(r.every((x) => x.verified_at === null), 'и у показателей');
  } finally { db.close(); }
});

test('снять или заменить взятый / готовый анализ нельзя — отказ словами, а не 500', () => {
  for (const status of ['collected', 'resulted']) {
    const { db, vs, s2 } = seed(status);
    try {
      if (status === 'resulted') {
        db.prepare("INSERT INTO lab_results (visit_service_id, parameter, value, flag, notes) VALUES (?, 'Hb', '120', 'normal', '')").run(vs);
      }
      assert.throws(() => removeUnpaidService(db, { visit_service_id: vs }, admin), (e) => e.status === 400 && /выполн|взят|оказ/.test(e.message), status);
      assert.throws(() => changeUnpaidService(db, { visit_service_id: vs, new_service_id: s2 }, admin), (e) => e.status === 400, status);
      assert.equal(db.prepare('SELECT service_id FROM visit_services WHERE id = ?').get(vs) != null, true);
    } finally { db.close(); }
  }
});

test('неначатую услугу по-прежнему снимают', () => {
  const { db, vs } = seed('added');
  try {
    removeUnpaidService(db, { visit_service_id: vs }, admin);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM visit_services WHERE id = ?').get(vs).n, 0);
  } finally { db.close(); }
});
