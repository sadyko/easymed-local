// DASHBOARD_CEO_V1 — отделы «Обзора клиники» для руководителя. Что утверждается:
//   1. МАРКЕТИНГ — заявки Meta по кампаниям, «пришли» и оплаты пришедших; заявка
//      с двумя источниками считается под каждым (как у CRM);
//   2. КОЛЛ-ЦЕНТР — оператор по внутреннему номеру, пропущенные по часам;
//   3. АМБУЛАТОРИЯ — неявки отдельно от работы; отделение — по услуге, если у
//      врача его нет;
//   4. СТАЦИОНАР — загрузка по госпитализациям в койке, выписка с долгом;
//   5. ПРОЦЕДУРЫ, СКЛАД, НАПРАВИТЕЛИ — по правилам своих разделов;
//   6. ДОСТУП: без прав — разделы null, суммы null.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { dashboardOverview } from './dashboard-overview.js';

const ADMIN = { id: 1, role: 'admin' };
const NOW = "strftime('%Y-%m-%dT%H:%M:%SZ','now')";
const DAYS_AGO = (n) => `strftime('%Y-%m-%dT%H:%M:%SZ','now','-${n} days')`;

function seed() {
  const db = openDb(':memory:'); migrate(db);
  const run = (sql, ...a) => db.prepare(sql).run(...a).lastInsertRowid;
  const doc = run("INSERT INTO users (username, password_hash, full_name, role, is_doctor) VALUES ('doc','x','Врач','doctor',1)");
  const op = run("INSERT INTO users (username, password_hash, full_name, role, pbx_extension) VALUES ('op','x','Оператор Анна','callcenter','101')");
  run("INSERT INTO users (username, password_hash, full_name, role) VALUES ('nobody','x','Никто','nobody_role')");
  db.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?)').run('nobody_role', JSON.stringify({ sections: [] }));

  const p1 = run(`INSERT INTO patients (full_name, branch_id, created_at) VALUES ('Пациент 1',1,${NOW})`);
  const p2 = run(`INSERT INTO patients (full_name, branch_id, created_at) VALUES ('Пациент 2',1,${NOW})`);

  // Маркетинг: две заявки Meta кампании «Осень», одна дошла и заплатила 200 000.
  const r1 = run(`INSERT INTO crm_requests (full_name, phone, source, sources, status, patient_id, created_at)
                  VALUES ('Лид 1','1','instagram','["instagram","call"]','came',?,${NOW})`, p1);
  const r2 = run(`INSERT INTO crm_requests (full_name, phone, source, status, created_at) VALUES ('Лид 2','2','instagram','in_process',${NOW})`);
  run(`INSERT INTO meta_leads (leadgen_id, campaign_name, form_name, crm_request_id, status, received_at) VALUES ('l1','Осень','Форма',?,'created',${NOW})`, r1);
  run(`INSERT INTO meta_leads (leadgen_id, campaign_name, form_name, crm_request_id, status, received_at) VALUES ('l2','Осень','Форма',?,'created',${NOW})`, r2);
  run(`INSERT INTO meta_leads (leadgen_id, form_name, status, received_at) VALUES ('l3','Форма','error',${NOW})`);
  const inv = run(`INSERT INTO invoices (patient_id, total_amount, paid_amount, status, created_at) VALUES (?,200000,200000,'paid',${NOW})`, p1);
  run(`INSERT INTO payments (invoice_id, amount, method, paid_at) VALUES (?,200000,'cash',${NOW})`, inv);

  // Колл-центр: оператору 101 — отвеченный и пропущенный входящий, исходящий.
  db.prepare(`INSERT INTO calls (general_call_id, started_at, call_type, external_number, internal_number, billsec, waitsec, disposition) VALUES
      ('g1',${NOW},0,'111','101',60,10,'ANSWER'),
      ('g2',${NOW},0,'222','101',0,25,'NOANSWER'),
      ('g3',${NOW},1,'333','101',120,0,'ANSWER')`).run();

  // Амбулатория: отделение — у услуги; один визит «не пришёл».
  const dep = run("INSERT INTO departments (name, kind) VALUES ('Терапия','clinical')");
  const svc = run("INSERT INTO services (name, price, department_id) VALUES ('Приём терапевта', 100000, ?)", dep);
  const v1 = run(`INSERT INTO visits (patient_id, branch_id, doctor_id, visit_date, status) VALUES (?,1,?,${NOW},'scheduled')`, p1, doc);
  run(`INSERT INTO visits (patient_id, branch_id, doctor_id, visit_date, status) VALUES (?,1,?,${NOW},'no_show')`, p2, doc);
  run(`INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status, created_at) VALUES (?,?,1,100000,100000,'completed',${NOW})`, v1, svc);
  // Процедура.
  const proc = run("INSERT INTO services (name, price, type) VALUES ('Массаж', 50000, 'procedure')");
  run(`INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status, created_at) VALUES (?,?,1,50000,50000,'completed',${NOW})`, v1, proc);

  // Стационар: палата на две койки, одна занята; выписан с долгом.
  const ward = run("INSERT INTO wards (name) VALUES ('101')");
  const b1 = run("INSERT INTO beds (code, ward_id) VALUES ('101-1', ?)", ward);
  run("INSERT INTO beds (code, ward_id) VALUES ('101-2', ?)", ward);
  const a1 = run(`INSERT INTO admissions (patient_id, bed_id, ward_id, status, admission_type, admitted_at) VALUES (?,?,?,'active','emergency',${DAYS_AGO(2)})`, p1, b1, ward);
  run(`INSERT INTO admissions (patient_id, status, admission_type, admitted_at, discharged_at, discharge_outcome, discharge_debt_amount)
       VALUES (?,'discharged','planned',${DAYS_AGO(5)},${NOW},'home',30000)`, p2);
  run(`INSERT INTO admission_services (admission_id, service_id, quantity, unit_price, total, billable, created_at) VALUES (?,NULL,2,150000,300000,1,${NOW})`, a1);

  // Склад: одна позиция ниже минимума, одна закончилась.
  run("INSERT INTO products (name, unit, on_hand, reorder_level, active) VALUES ('Шприц 5 мл','шт',3,10,1),('Перчатки','пар',0,20,1),('Вата','уп',50,5,1)");

  // Направитель.
  const rs = run("INSERT INTO referral_sources (name) VALUES ('Доктор Каримов')");
  db.prepare('UPDATE visits SET referral_source_id = ? WHERE id = ?').run(rs, v1);
  return db;
}

const db = seed();
test.after(() => db.close());

test('маркетинг: кампании Meta, пришедшие и их оплаты; ошибки; источник под каждым из своих', () => {
  const o = dashboardOverview(db, { days: 7 }, ADMIN);
  const m = o.marketing;
  assert.equal(m.meta.leads, 3);
  assert.equal(m.meta.errors, 1);
  assert.equal(m.meta.won, 1);
  const autumn = m.meta.campaigns.find((c) => c.name === 'Осень');
  assert.equal(autumn.n, 2);
  assert.equal(autumn.won, 1);
  assert.equal(autumn.revenue, 200000, 'оплаты пришедшего пациента за период');
  const src = Object.fromEntries(m.sources.map((s) => [s.key, s]));
  assert.equal(src.instagram.n, 2);
  assert.equal(src.call.n, 1, 'заявка с двумя источниками — и под «Звонком»');
  assert.equal(src.instagram.revenue, 200000);
});

test('колл-центр: оператор по внутреннему номеру; пропущенные по часам', () => {
  const c = dashboardOverview(db, { days: 7 }, ADMIN).callcenter;
  const anna = c.operators.find((o) => o.name === 'Оператор Анна');
  assert.deepEqual({ i: anna.incoming, a: anna.answered, o: anna.outgoing, t: anna.talk_min, w: anna.avg_wait_sec }, { i: 2, a: 1, o: 1, t: 3, w: 10 });
  assert.equal(c.missed_hours.reduce((n, x) => n + x.missed, 0), 1);
  assert.equal(c.missed_hours.reduce((n, x) => n + x.incoming, 0), 2);
});

test('амбулатория: отделение по услуге; неявки отдельно', () => {
  const a = dashboardOverview(db, { days: 7 }, ADMIN).outpatient;
  const t = a.departments.find((d) => d.name === 'Терапия');
  assert.ok(t, 'у врача отделения нет — берётся отделение услуги визита');
  assert.equal(t.visits, 1);
  assert.equal(a.no_show, 1);
  assert.equal(a.no_show_rate, 50);
  assert.equal(a.weekdays.reduce((n, x) => n + x.visits, 0), 1, 'неявка — не визит');
});

test('стационар: загрузка по госпитализациям в койке; койко-дни; выписка с долгом', () => {
  const ip = dashboardOverview(db, { days: 7 }, ADMIN).inpatient_ext;
  assert.equal(ip.in_bed_now, 1);
  assert.equal(ip.beds_total, 2);
  assert.equal(ip.occupancy, 50);
  assert.deepEqual(ip.wards, [{ name: '101', beds: 2, busy: 1 }]);
  assert.equal(ip.bed_days, 2);
  assert.equal(ip.bed_revenue, 300000);
  assert.equal(ip.discharge_debt_n, 1);
  assert.equal(ip.discharge_debt, 30000);
  assert.equal(ip.outcomes.home, 1);
  assert.equal(ip.planned, 1, 'плановая поступила 5 дней назад — в периоде');
  assert.equal(ip.emergency, 1);
});

test('процедуры, склад, направители', () => {
  const o = dashboardOverview(db, { days: 7 }, ADMIN);
  assert.equal(o.procedures.outpatient, 1);
  assert.equal(o.procedures.outpatient_done, 1);
  assert.equal(o.procedures.top[0].name, 'Массаж');
  assert.equal(o.stock.low_count, 2);
  assert.equal(o.stock.zero_count, 1);
  assert.equal(o.stock.low[0].name, 'Перчатки', 'сверху — то, что закончилось');
  assert.equal(o.referrers.visits, 1);
  assert.equal(o.referrers.top[0].name, 'Доктор Каримов');
  assert.equal(o.referrers.top[0].sum, 150000);
});

test('доступ: без прав — разделы null, суммы null', () => {
  const o = dashboardOverview(db, { days: 7 }, { id: 3, role: 'nobody_role' });
  assert.equal(o.marketing, null);
  assert.equal(o.callcenter, null);
  assert.equal(o.stock, null);
  assert.equal(o.referrers, null);
  assert.equal(o.inpatient_ext.revenue, null);
  assert.equal(o.inpatient_ext.discharge_debt, null);
  assert.equal(o.outpatient.revenue_per_visit, null);
  assert.equal(o.procedures.revenue, null);
  assert.equal(o.inpatient_ext.occupancy, 50, 'счётчики остаются — как на сводке');
});
