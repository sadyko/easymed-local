// DASHBOARD_OVERVIEW_V1 — обзор клиники для руководителя. Что утверждается:
//   1. ПЕРИОД И СРАВНЕНИЕ: текущий период кончается сегодня, прошлый — той же
//      длины прямо перед ним; число прошлого периода не подмешивается в текущее;
//   2. ДЕНЬГИ — приход кассы без «кошелька», возвраты отдельно, долг по давности;
//   3. CRM — конверсия считается по колонке «Пришёл» (kind 'won'), источники и
//      операторы — по заявкам периода;
//   4. «НЕ ПЕРЕЗВОНИЛИ» — номер, чей пропущенный остался без разговора ПОСЛЕ
//      него; перезвонили — номер уходит из счёта;
//   5. TELEGRAM — подписчики без отписавшихся, непрочитанное, доставки;
//   6. ДОСТУП: без права на выручку, на всю доску CRM и на чат разделы приходят
//      null, а суммы по направлениям и врачам — null; счётчики остаются;
//   7. Обзор — чистое чтение для ворот лицензии.
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
  const doc = db.prepare("INSERT INTO users (username, password_hash, full_name, role, is_doctor) VALUES ('doc','x','Врач Один','doctor',1)").run().lastInsertRowid;
  const p1 = db.prepare(`INSERT INTO patients (full_name, branch_id, date_of_birth, created_at) VALUES ('A',1,'1990-01-01',${NOW})`).run().lastInsertRowid;
  const p2 = db.prepare(`INSERT INTO patients (full_name, branch_id, date_of_birth, created_at) VALUES ('B',1,'2015-01-01',${DAYS_AGO(20)})`).run().lastInsertRowid;
  // Два визита в периоде (один повторный), один — в прошлом периоде.
  const v1 = db.prepare(`INSERT INTO visits (patient_id, branch_id, doctor_id, visit_date, visit_kind) VALUES (?,1,?,${NOW},'first')`).run(p1, doc).lastInsertRowid;
  db.prepare(`INSERT INTO visits (patient_id, branch_id, doctor_id, visit_date, visit_kind) VALUES (?,1,?,${DAYS_AGO(2)},'repeat')`).run(p2, doc);
  db.prepare(`INSERT INTO visits (patient_id, branch_id, doctor_id, visit_date, visit_kind) VALUES (?,1,?,${DAYS_AGO(10)},'first')`).run(p2, doc);
  const svc = db.prepare("INSERT INTO services (name, price) VALUES ('Консультация', 100000)").run().lastInsertRowid;
  db.prepare(`INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status, created_at)
              VALUES (?,?,1,100000,100000,'completed',${NOW})`).run(v1, svc);
  // Деньги: 100 000 наличными и 30 000 с «кошелька» сегодня; возврат 10 000;
  // 50 000 — в прошлом периоде.
  const inv = db.prepare(`INSERT INTO invoices (patient_id, total_amount, paid_amount, status, created_at) VALUES (?,100000,100000,'paid',${NOW})`).run(p1).lastInsertRowid;
  db.prepare(`INSERT INTO payments (invoice_id, amount, method, paid_at) VALUES (?,100000,'cash',${NOW}),(?,30000,'wallet',${NOW}),(?,-10000,'cash',${NOW}),(?,50000,'card',${DAYS_AGO(10)})`).run(inv, inv, inv, inv);
  // Долг 40-дневной давности.
  db.prepare(`INSERT INTO invoices (patient_id, total_amount, paid_amount, status, created_at) VALUES (?,80000,0,'debt',${DAYS_AGO(40)})`).run(p2);
  // CRM: три заявки в периоде, одна дошла до клиники; одна — в прошлом.
  db.prepare(`INSERT INTO crm_requests (full_name, phone, source, status, created_at) VALUES
      ('L1','1','call','came',${NOW}),('L2','2','call','in_process',${NOW}),('L3','3','instagram','not_qualified',${NOW}),
      ('L0','4','call','came',${DAYS_AGO(10)})`).run();
  // Звонки: 111 пропущен и не перезвонили; 222 пропущен, потом перезвонили.
  db.prepare(`INSERT INTO calls (general_call_id, started_at, call_type, external_number, billsec, waitsec, disposition) VALUES
      ('g1',strftime('%Y-%m-%dT%H:%M:%SZ','now','-3 hours'),0,'111',0,20,'NOANSWER'),
      ('g2',strftime('%Y-%m-%dT%H:%M:%SZ','now','-3 hours'),0,'222',0,15,'CANCEL'),
      ('g3',strftime('%Y-%m-%dT%H:%M:%SZ','now','-2 hours'),1,'222',60,5,'ANSWER'),
      ('g4',strftime('%Y-%m-%dT%H:%M:%SZ','now','-1 hours'),0,'333',120,8,'ANSWER')`).run();
  // Telegram: два подписчика, один отписан; одно непрочитанное.
  db.prepare(`INSERT INTO telegram_links (chat_id, phone, linked_at) VALUES ('c1','1',${NOW}),('c2','2',${DAYS_AGO(30)})`).run();
  db.prepare(`INSERT INTO telegram_links (chat_id, phone, linked_at, revoked_at) VALUES ('c3','3',${NOW},${NOW})`).run();
  db.prepare(`INSERT INTO telegram_messages (chat_id, direction, text, kind, created_at) VALUES ('c1','in','Здравствуйте','text',${NOW}),('c1','out','Добрый день','text',${NOW})`).run();
  db.prepare(`UPDATE telegram_messages SET read_at = NULL WHERE direction = 'in'`).run();
  db.prepare(`INSERT INTO telegram_deliveries (chat_id, doc_kind, doc_ref, "trigger", status, created_at) VALUES ('c1','lab','1','push','sent',${NOW}),('c2','lab','2','push','failed',${NOW})`).run();
  return db;
}

// Обзор только читает: одна база на все проверки (миграции — секунды на каждую).
const db = seed();
test.after(() => db.close());

test('dashboard_overview: период кончается сегодня, прошлый — той же длины перед ним', () => {
  const o = dashboardOverview(db, { days: 7 }, ADMIN);
  assert.equal(o.period.days, 7);
  const dayMs = 86400000;
  const span = (a, b) => (Date.parse(b) - Date.parse(a)) / dayMs;
  assert.equal(span(o.period.from, o.period.to), 6);
  assert.equal(span(o.period.prev_from, o.period.prev_to), 6);
  assert.equal(span(o.period.prev_to, o.period.from), 1, 'прошлый период стыкуется с текущим');
  assert.equal(dashboardOverview(db, { days: 500 }, ADMIN).period.days, 90);
  assert.equal(dashboardOverview(db, {}, ADMIN).period.days, 14);
});

test('dashboard_overview: пациенты, визиты и сравнение с прошлым периодом', () => {
  const o = dashboardOverview(db, { days: 7 }, ADMIN);
  assert.equal(o.patients.new, 1);
  assert.equal(o.patients.visits, 2);
  assert.equal(o.patients.visits_prev, 1);
  assert.equal(o.patients.repeat, 1);
  assert.equal(o.patients.first, 1);
  assert.equal(o.patients.unique, 2);
  assert.equal(o.patients.ages.young, 1);
  assert.equal(o.patients.ages.child, 1);
  assert.equal(o.doctors[0].name, 'Врач Один');
  assert.equal(o.doctors[0].sum, 100000);
});

test('dashboard_overview: финансы — приход без «кошелька», возвраты отдельно, долг по давности', () => {
  const f = dashboardOverview(db, { days: 7 }, ADMIN).finance;
  assert.equal(f.collected, 90000, '100 000 наличными − 10 000 возврата; «кошелёк» не приход');
  assert.equal(f.collected_prev, 50000);
  assert.equal(f.refunds, 10000);
  assert.deepEqual(f.methods.map((m) => m.method).sort(), ['cash', 'wallet']);
  assert.equal(f.debt_aging.older.n, 1);
  assert.equal(f.debt_aging.older.sum, 80000);
  assert.equal(f.debt_aging.d7.n, 0);
});

test('dashboard_overview: CRM — конверсия по колонке «Пришёл», источники периода', () => {
  const c = dashboardOverview(db, { days: 7 }, ADMIN).crm;
  assert.equal(c.leads, 3);
  assert.equal(c.leads_prev, 1);
  assert.equal(c.won, 1);
  assert.equal(c.lost, 1);
  assert.equal(c.conversion, 33.3);
  const call = c.sources.find((s) => s.key === 'call');
  assert.equal(call.n, 2);
  assert.equal(call.won, 1);
});

test('dashboard_overview: «не перезвонили» — только номер без разговора после пропуска', () => {
  const k = dashboardOverview(db, { days: 7 }, ADMIN).calls;
  assert.equal(k.incoming, 3);
  assert.equal(k.outgoing, 1);
  assert.equal(k.missed, 2);
  assert.equal(k.answered, 1);
  assert.equal(k.not_called_back, 1, '222 перезвонили, 111 — нет');
});

test('dashboard_overview: Telegram — подписчики без отписавшихся, непрочитанное, доставки', () => {
  const t = dashboardOverview(db, { days: 7 }, ADMIN).telegram;
  assert.equal(t.subscribers, 2);
  assert.equal(t.new_subscribers, 2, 'в периоде привязаны c1 и отписанный позже c3');
  assert.equal(t.messages_in, 1);
  assert.equal(t.replies, 1);
  assert.equal(t.unread, 1);
  assert.equal(t.docs_sent, 1);
  assert.equal(t.docs_failed, 1);
});

test('dashboard_overview: без прав разделы приходят null, суммы — null, счётчики остаются', () => {
  const nurse = { id: 99, role: 'nurse' };
  const o = dashboardOverview(db, { days: 7 }, nurse);
  assert.equal(o.money_visible, false);
  assert.equal(o.finance, null);
  assert.equal(o.crm, null);
  assert.equal(o.calls, null);
  assert.equal(o.telegram, null);
  assert.ok(o.directions.length > 0);
  for (const d of o.directions) assert.equal(d.sum, null);
  for (const d of o.doctors) assert.equal(d.sum, null);
  assert.equal(o.patients.visits, 2, 'счётчики видит всякий, кто видит сводку');
});

test('DASHBOARD_OVERVIEW_V1: обзор пропускается при блокировке лицензии', async () => {
  const { isReadOnlyRpc } = await import('../control/gate.js');
  assert.equal(isReadOnlyRpc('dashboard_overview'), true);
});
