import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { dashboardSummary } from './dashboard.js';
import { ownBuildingOnly, LAB_SCOPE_CLINIC, LAB_SCOPE_BUILDING } from '../../../public/js/admin/views/lab-scope.js';

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

// LAB_ONE_CLINIC_V1 — плитка «Анализы в работе» и лабораторная очередь под ней
// обязаны считать ОДНУ И ТУ ЖЕ ГРАНИЦУ, а её с миграции 085 задаёт настройка
// doc_settings.lab_scope, а не константа.
//
// Раньше здесь стояло жёсткое «только своё здание», и с 0.7.0 это стало ЛОЖЬЮ:
// очередь по умолчанию клиниковая, плитка считала меньше, чем показывал список
// под ней. Тест проверяет ОБА значения настройки — именно то расхождение,
// ради которого условие когда-то и появилось.
function seedLab() {
  const db = openDb(':memory:'); migrate(db);
  const pid = db.prepare("INSERT INTO patients (full_name, branch_id) VALUES ('C',1)").run().lastInsertRowid;
  const vid = db.prepare("INSERT INTO visits (patient_id, branch_id, visit_date) VALUES (?,1,date('now'))").run(pid).lastInsertRowid;
  const sid = db.prepare("INSERT INTO services (name, code, price, type, is_lab, active) VALUES ('ОАК','CBC',50000,'lab',1,1)").run().lastInsertRowid;
  db.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, status) VALUES (?,?,1,'queued')").run(vid, sid);
  db.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, status, sync_origin) VALUES (?,?,1,'queued','C')").run(vid, sid);
  return db;
}

// Что показала бы ОЧЕРЕДЬ при этой настройке. Границу задаёт ТОТ ЖЕ модуль,
// которым её накладывает экран (views/lab-scope.js): переписать правило в тесте
// значило бы проверять свою копию, а не то, что видит лаборант.
function queueWouldShow(db, scope) {
  const rows = db.prepare(`SELECT vs.sync_origin AS o FROM visit_services vs
      JOIN services s ON s.id = vs.service_id
      WHERE s.is_lab = 1 AND vs.status IN ('queued','in_progress')
        AND NOT EXISTS (SELECT 1 FROM lab_results lr WHERE lr.visit_service_id = vs.id AND lr.verified_at IS NOT NULL)`).all();
  return ownBuildingOnly(scope) ? rows.filter((r) => r.o == null).length : rows.length;
}

test('dashboard_summary: по умолчанию плитка «в работе» считает всю клинику — как очередь', () => {
  const db = seedLab();
  const s = dashboardSummary(db, {}, { id: 1, role: 'admin' });
  assert.equal(s.lab_scope, LAB_SCOPE_CLINIC);
  assert.equal(s.lab_pending_count, 2, 'заказ соседнего здания виден и в очереди, и на плитке');
  assert.equal(s.lab_pending_count, queueWouldShow(db, s.lab_scope), 'плитка = очередь');
});

test('dashboard_summary: при lab_scope=building плитка считает только своё здание — как очередь', () => {
  const db = seedLab();
  db.prepare("UPDATE doc_settings SET lab_scope = 'building' WHERE id = 1").run();
  const s = dashboardSummary(db, {}, { id: 1, role: 'admin' });
  assert.equal(s.lab_scope, LAB_SCOPE_BUILDING);
  assert.equal(s.lab_pending_count, 1, 'считается только заказ, заведённый здесь');
  assert.equal(s.lab_pending_count, queueWouldShow(db, s.lab_scope), 'плитка = очередь');
});

// BUILDING_REPORTS_V1 — счётчики не смешивают здания молча: наверху итог по
// клинике, рядом разрез, где видно, чей это вклад.
test('dashboard_summary: пациенты и визиты считаются по зданиям и в сумме', () => {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO branches (name, letter, active) VALUES ('Чиланзар','B',0)").run();
  const own = db.prepare("INSERT INTO patients (full_name, branch_id) VALUES ('Своя',1)").run().lastInsertRowid;
  db.prepare("INSERT INTO patients (full_name, branch_id, sync_origin) VALUES ('Приехала',1,'B')").run();
  db.prepare("INSERT INTO visits (patient_id, branch_id, visit_date) VALUES (?,1,strftime('%Y-%m-%dT%H:%M:%SZ','now'))").run(own);
  db.prepare("INSERT INTO visits (patient_id, branch_id, visit_date, sync_origin) VALUES (?,1,strftime('%Y-%m-%dT%H:%M:%SZ','now'),'B')").run(own);

  const s = dashboardSummary(db, {}, { id: 1, role: 'admin' });
  assert.equal(s.patients_today, 2, 'итог по клинике');
  assert.equal(s.visits_today, 2);
  assert.equal(s.building_count, 2, 'два здания: своё и B');
  const own_b = s.buildings.find((b) => b.own);
  const b = s.buildings.find((x) => x.key === 'B');
  assert.equal(own_b.patients_today, 1);
  assert.equal(b.patients_today, 1, 'приехавшая строка приписана зданию B, а не своему');
  assert.equal(b.label, 'Чиланзар', 'имя берётся из перечня, включая строку active = 0');
  assert.equal(own_b.visits_today + b.visits_today, s.visits_today);
});
