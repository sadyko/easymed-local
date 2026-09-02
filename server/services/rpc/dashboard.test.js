import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { dashboardSummary } from './dashboard.js';

test('dashboard_summary returns today counts, collected, outstanding, low-stock', () => {
  const db = openDb(':memory:'); migrate(db);
  const user = { id: 1, role: 'admin' };
  // seed: 2 patients today, 1 visit today, an invoice partially paid, a payment today, a low-stock product
  db.prepare("INSERT INTO patients (full_name, branch_id) VALUES ('A',1),('B',1)").run();
  const pid = db.prepare("INSERT INTO patients (full_name, branch_id) VALUES ('C',1)").run().lastInsertRowid;
  // DASHBOARD_TEST_TZ_V1 — сеем визит на ЛОКАЛЬНЫЙ день, как его считает
  // dashboardSummary (isLocalToday, domain/day.js). Раньше стояло
  // date('now') — это дата в UTC, и восточнее Гринвича после полуночи по
  // местному времени (UTC ещё «вчера») визит попадал во вчерашний день:
  // visits_today приходил 0, и тест падал каждую ночь. Проверять надо
  // поведение функции, а не время суток, когда запустили набор.
  db.prepare("INSERT INTO visits (patient_id, branch_id, visit_date) VALUES (?,1,strftime('%Y-%m-%dT%H:%M:%SZ','now'))").run(pid);
  const inv = db.prepare("INSERT INTO invoices (patient_id, total_amount, paid_amount, status) VALUES (?, 100000, 40000, 'partial')").run(pid).lastInsertRowid;
  db.prepare("INSERT INTO payments (invoice_id, amount, method, paid_at) VALUES (?, 40000, 'cash', strftime('%Y-%m-%dT%H:%M:%SZ','now'))").run(inv);
  db.prepare("INSERT INTO products (name, on_hand, reorder_level, active) VALUES ('Low', 2, 5, 1), ('Ok', 50, 5, 1)").run();

  const s = dashboardSummary(db, {}, user);
  assert.equal(s.patients_today, 3);         // A,B,C all created now
  assert.equal(s.visits_today, 1);
  assert.equal(s.collected_today, 40000);
  assert.equal(s.outstanding_count, 1);      // the partial invoice
  assert.equal(s.outstanding_amount, 60000); // 100000 - 40000
  assert.equal(s.low_stock_count, 1);        // only 'Low'
  assert.equal(typeof s.lab_pending_count, 'number');
});

// REGRESSION: outstanding filtered on ('unpaid','partial') only, so pressing
// «Оставить как долг» — whose whole purpose is recording money still owed —
// made the debt disappear from this KPI while the cashier's chips still counted it.
test('dashboard_summary counts debt invoices as outstanding', () => {
  const db = openDb(':memory:'); migrate(db);
  const pid = db.prepare("INSERT INTO patients (full_name, branch_id) VALUES ('C',1)").run().lastInsertRowid;
  db.prepare("INSERT INTO invoices (patient_id, total_amount, paid_amount, status) VALUES (?, 100000, 40000, 'partial')").run(pid);
  db.prepare("INSERT INTO invoices (patient_id, total_amount, paid_amount, status) VALUES (?, 80000, 0, 'debt')").run(pid);
  db.prepare("INSERT INTO invoices (patient_id, total_amount, paid_amount, status) VALUES (?, 50000, 0, 'void')").run(pid);

  const s = dashboardSummary(db, {}, { id: 1, role: 'admin' });
  assert.equal(s.outstanding_count, 2);          // partial + debt, never the void one
  assert.equal(s.outstanding_amount, 140000);    // 60000 + 80000
});

// BRANCH_ORIGIN_V1 — плитка «Анализы в работе» и лабораторная очередь под ней
// обязаны считать ОДНО И ТО ЖЕ. Очередь показывает работу своего здания
// (sync_origin IS NULL); если плитка считает и приехавшую, лаборант видит
// число, под которое в очереди нет ни одной пробирки.
test('dashboard_summary: анализы соседнего филиала не попадают в плитку «в работе»', () => {
  const db = openDb(':memory:'); migrate(db);
  const pid = db.prepare("INSERT INTO patients (full_name, branch_id) VALUES ('C',1)").run().lastInsertRowid;
  const vid = db.prepare("INSERT INTO visits (patient_id, branch_id, visit_date) VALUES (?,1,date('now'))").run(pid).lastInsertRowid;
  const sid = db.prepare("INSERT INTO services (name, code, price, type, is_lab, active) VALUES ('ОАК','CBC',50000,'lab',1,1)").run().lastInsertRowid;
  db.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, status) VALUES (?,?,1,'queued')").run(vid, sid);
  db.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, status, sync_origin) VALUES (?,?,1,'queued','C')").run(vid, sid);

  const s = dashboardSummary(db, {}, { id: 1, role: 'admin' });
  assert.equal(s.lab_pending_count, 1, 'считается только заказ, заведённый здесь');
});
