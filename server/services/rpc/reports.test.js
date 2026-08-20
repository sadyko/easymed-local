import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { reportsOverview, runReport, ownerReport } from './reports.js';

function seed() {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO users (id,username,password_hash,role) VALUES (1,'a','x','admin')").run();
  const pid = db.prepare("INSERT INTO patients (full_name, mrn, gender, branch_id, created_at) VALUES ('Ann','P-26-1','female',1,'2026-08-05T09:00:00Z')").run().lastInsertRowid;
  const vid = db.prepare("INSERT INTO visits (patient_id, branch_id, visit_date, status) VALUES (?,1,'2026-08-05T09:00:00Z','scheduled')").run(pid).lastInsertRowid;
  const inv = db.prepare("INSERT INTO invoices (invoice_number, patient_id, total_amount, paid_amount, status, created_at) VALUES ('INV-1',?,100000,60000,'partial','2026-08-05T09:30:00Z')").run(pid).lastInsertRowid;
  db.prepare("INSERT INTO payments (invoice_id, amount, method, cashier_id, paid_at) VALUES (?,60000,'cash',1,'2026-08-05T09:40:00Z')").run(inv);
  const s = db.prepare("INSERT INTO services (name, price) VALUES ('Consultation',50000)").run().lastInsertRowid;
  db.prepare("INSERT INTO invoice_items (invoice_id, service_id, description, quantity, total) VALUES (?,?,'Consultation',2,100000)").run(inv, s);
  return { db, pid, vid, inv, s };
}
const user = { id:1, role:'admin' };
const FROM = '2026-08-01', TO = '2026-08-31';

test('reports_overview returns period KPIs', () => {
  const { db } = seed();
  const o = reportsOverview(db, { from: FROM, to: TO }, user);
  assert.equal(o.cash_collected, 60000);
  assert.equal(o.invoices_created, 1);
  assert.equal(o.patients_new, 1);
  assert.equal(o.visits_count, 1);
  assert.equal(o.outstanding_total, 40000); // 100000-60000
});

// REGRESSION: 'debt' was missing from the outstanding filter, so an invoice
// parked as debt read as money the clinic was no longer owed. Mirrors the same
// assertion in dashboard.test.js — the two KPIs must agree.
test('reports_overview counts debt invoices as outstanding', () => {
  const { db, pid } = seed();
  db.prepare("INSERT INTO invoices (invoice_number, patient_id, total_amount, paid_amount, status, created_at) VALUES ('INV-2',?,80000,0,'debt','2026-08-06T09:00:00Z')").run(pid);
  db.prepare("INSERT INTO invoices (invoice_number, patient_id, total_amount, paid_amount, status, created_at) VALUES ('INV-3',?,50000,0,'void','2026-08-06T09:00:00Z')").run(pid);

  const o = reportsOverview(db, { from: FROM, to: TO }, user);
  assert.equal(o.outstanding_total, 120000);   // 40000 partial + 80000 debt, void excluded
});

test('run_report returns {columns, rows} for each kind, date-filtered', () => {
  const { db } = seed();
  const pay = runReport(db, { kind:'payments', from:FROM, to:TO }, user);
  assert.ok(Array.isArray(pay.columns) && Array.isArray(pay.rows));
  assert.equal(pay.rows.length, 1);
  // services report aggregates qty + revenue by service
  const svc = runReport(db, { kind:'services', from:FROM, to:TO }, user);
  const row = svc.rows[0];
  assert.ok(row.includes('Consultation'));
  // outside the range → empty
  const none = runReport(db, { kind:'payments', from:'2026-01-01', to:'2026-01-31' }, user);
  assert.equal(none.rows.length, 0);
  // unknown kind rejected
  assert.throws(() => runReport(db, { kind:'bogus', from:FROM, to:TO }, user), /unknown report|kind/i);
});

// ---------------------------------------------------------------------------
// REPORTS_HUB_RU_V1 — the seven card-grid reports
// ---------------------------------------------------------------------------
function seedRu() {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO users (id,username,password_hash,role,full_name) VALUES (1,'reg','x','admin','Регистратор Р.')").run();
  db.prepare("INSERT INTO users (id,username,password_hash,role,full_name) VALUES (2,'doc','x','doctor','Доктор Д.')").run();
  const payer = db.prepare("INSERT INTO payers (name, kind) VALUES ('ООО Ромашка','corporate')").run().lastInsertRowid;
  const src = db.prepare("INSERT INTO referral_sources (name, category) VALUES ('Клиника Х','Партнёры')").run().lastInsertRowid;
  db.prepare("INSERT INTO referral_rewards (name, percent) VALUES ('Клиника Х', 10)").run();
  const p1 = db.prepare("INSERT INTO patients (full_name, mrn, branch_id) VALUES ('Ann','P-26-1',1)").run().lastInsertRowid;
  const p2 = db.prepare("INSERT INTO patients (full_name, mrn, branch_id, payer_id) VALUES ('Bob','P-26-2',1,?)").run(payer).lastInsertRowid;
  const vid = db.prepare("INSERT INTO visits (patient_id, branch_id, visit_date, referral_source_id) VALUES (?,1,'2026-08-05T09:00:00Z',?)").run(p1, src).lastInsertRowid;
  const sCons = db.prepare("INSERT INTO services (name, price, tax_rate) VALUES ('Консультация',50000,0)").run().lastInsertRowid;
  const sSurg = db.prepare("INSERT INTO services (name, price, tax_rate) VALUES ('Операция аппендэктомия',1000000,12)").run().lastInsertRowid;
  db.prepare("INSERT INTO doctor_rates (doctor_id, service_id, percent) VALUES (2,?,30)").run(sCons);
  db.prepare("INSERT INTO doctor_rates (doctor_id, service_id, percent) VALUES (2,?,20)").run(sSurg);

  // Invoice 1 (Ann, paid): консультация 100 000 with a 10 000 invoice discount.
  const inv1 = db.prepare(`INSERT INTO invoices (invoice_number, visit_id, patient_id, branch_id, subtotal, discount_amount, total_amount, paid_amount, status, created_by, created_at, paid_at)
    VALUES ('INV-1',?,?,1,100000,10000,90000,90000,'paid',1,'2026-08-05T09:30:00Z','2026-08-05T10:00:00Z')`).run(vid, p1).lastInsertRowid;
  const it1 = db.prepare("INSERT INTO invoice_items (invoice_id, service_id, description, quantity, unit_price, total) VALUES (?,?,'Консультация',2,50000,100000)").run(inv1, sCons).lastInsertRowid;
  const vs1 = db.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, invoice_item_id) VALUES (?,?,2,2,50000,100000,'completed',?)").run(vid, sCons, it1).lastInsertRowid;

  // Invoice 2 (Bob, unpaid): операция 1 000 000, no discount.
  const inv2 = db.prepare(`INSERT INTO invoices (invoice_number, visit_id, patient_id, branch_id, subtotal, discount_amount, total_amount, paid_amount, status, created_by, created_at)
    VALUES ('INV-2',?,?,1,1000000,0,1000000,0,'unpaid',1,'2026-08-06T09:30:00Z')`).run(vid, p2).lastInsertRowid;
  const it2 = db.prepare("INSERT INTO invoice_items (invoice_id, service_id, description, quantity, unit_price, total) VALUES (?,?,'Операция аппендэктомия',1,1000000,1000000)").run(inv2, sSurg).lastInsertRowid;
  const vs2 = db.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, invoice_item_id) VALUES (?,?,2,1,1000000,1000000,'completed',?)").run(vid, sSurg, it2).lastInsertRowid;

  // Consumables for the surgery visit + a stock receipt for «Закупки».
  const prod = db.prepare("INSERT INTO products (name, unit, sale_price, on_hand) VALUES ('Шовный материал','pcs',0,100)").run().lastInsertRowid;
  db.prepare("INSERT INTO stock_movements (product_id, kind, qty, unit_cost, reference_type, note, created_at) VALUES (?,'receive',10,2000,'manual','ООО МедСнаб','2026-08-04T08:00:00Z')").run(prod);
  db.prepare("INSERT INTO stock_movements (product_id, kind, qty, unit_cost, reference_type, reference_id, created_at) VALUES (?,'dispense',-2,1500,'visit',?,'2026-08-06T10:00:00Z')").run(prod, vs2);

  return { db };
}

test('total_revenue: prorated discount, tax and doctor share per line', () => {
  const { db } = seedRu();
  const r = runReport(db, { kind:'total_revenue', from:FROM, to:TO }, user);
  assert.equal(r.rows.length, 2);
  const cols = r.columns;
  const row1 = r.rows.find(x => x[cols.indexOf('Услуга')] === 'Консультация');
  assert.equal(row1[cols.indexOf('Скидка')], 10000);          // whole invoice discount lands on its only item
  assert.equal(row1[cols.indexOf('После скидки')], 90000);
  // DOCTOR_FIX_RATE_V1 — «% врача» became «Ставка врача»: the cell now states
  // WHICH rate applied, because it can also hold a fixed sum.
  assert.equal(row1[cols.indexOf('Ставка врача')], 30);
  assert.equal(row1[cols.indexOf('Доля врача')], 27000);      // 30% of 90 000
  assert.equal(row1[cols.indexOf('Реферал')], 'Клиника Х');
  assert.equal(row1[cols.indexOf('Статус')], 'Оплачен');
});

test('referrals: grouped by source with reward % from referral_rewards', () => {
  const { db } = seedRu();
  const r = runReport(db, { kind:'referrals', from:FROM, to:TO }, user);
  assert.equal(r.rows.length, 1);
  const [source, category, mode, count, amount, pct, reward] = r.rows[0];
  assert.equal(source, 'Клиника Х');
  assert.equal(category, 'Партнёры');
  assert.equal(mode, 'Вручную');            // reward rate named exactly like the source
  assert.equal(count, 2);
  assert.equal(amount, 1090000);            // 90 000 + 1 000 000
  assert.equal(pct, 10);
  assert.equal(reward, 109000);
});

test('invoices_full: RU statuses, payer resolution, owed', () => {
  const { db } = seedRu();
  const r = runReport(db, { kind:'invoices_full', from:FROM, to:TO }, user);
  assert.equal(r.rows.length, 2);
  const cols = r.columns;
  const bob = r.rows.find(x => x[cols.indexOf('Пациент')] === 'Bob');
  assert.equal(bob[cols.indexOf('Кто платит')], 'ООО Ромашка');
  assert.equal(bob[cols.indexOf('Остаток / долг')], 1000000);
  assert.equal(bob[cols.indexOf('Статус')], 'Не оплачен');
  const ann = r.rows.find(x => x[cols.indexOf('Пациент')] === 'Ann');
  assert.equal(ann[cols.indexOf('Кто платит')], 'Пациент');
});

// INVOICE_METHOD_COLUMN_V1 — «Способ оплаты» в отчёте «Счета».
//
// There are TWO invoice reports with byte-identical column labels: this
// server-side one and the client-side «Счета» in views/reports-export.js. The
// method column was added to the client one first, which is why it looked like
// the change had not taken effect — the screen being looked at was the other
// report. Both now read from public/js/shared/payment-methods.js so they can
// never word the same payment differently.
test('invoices_full: способ оплаты — наличные, карта, эквайринг', () => {
  const { db, pid } = seed();

  // Один счёт — одна оплата картой.
  const card = db.prepare("INSERT INTO invoices (invoice_number, patient_id, total_amount, paid_amount, status, created_at) VALUES ('INV-C',?,50000,50000,'paid','2026-08-06T09:00:00Z')").run(pid).lastInsertRowid;
  db.prepare("INSERT INTO payments (invoice_id, amount, method, cashier_id, paid_at) VALUES (?,50000,'card',1,'2026-08-06T09:10:00Z')").run(card);

  // Сплит: часть картой, часть эквайрингом — колонка перечисляет оба.
  const split = db.prepare("INSERT INTO invoices (invoice_number, patient_id, total_amount, paid_amount, status, created_at) VALUES ('INV-S',?,90000,90000,'paid','2026-08-06T10:00:00Z')").run(pid).lastInsertRowid;
  db.prepare("INSERT INTO payments (invoice_id, amount, method, cashier_id, paid_at) VALUES (?,40000,'acquiring',1,'2026-08-06T10:05:00Z')").run(split);
  db.prepare("INSERT INTO payments (invoice_id, amount, method, cashier_id, paid_at) VALUES (?,50000,'card',1,'2026-08-06T10:06:00Z')").run(split);

  // Неоплаченный — платежей нет, ячейка пустая (а не «Наличные» по умолчанию:
  // это отчитывалось бы о деньгах, которых не было).
  db.prepare("INSERT INTO invoices (invoice_number, patient_id, total_amount, paid_amount, status, created_at) VALUES ('INV-U',?,30000,0,'unpaid','2026-08-06T11:00:00Z')").run(pid);

  const r = runReport(db, { kind: 'invoices_full', from: FROM, to: TO }, user);
  const cols = r.columns;
  const at = cols.indexOf('Способ оплаты');
  assert.ok(at > -1, 'колонка «Способ оплаты» должна быть в отчёте');

  const by = (num) => r.rows.find((x) => x[cols.indexOf('№ счёта')] === num);
  assert.equal(by('INV-1')[at], 'Наличные');
  assert.equal(by('INV-C')[at], 'Карта');
  assert.equal(by('INV-S')[at], 'Карта, Эквайринг');   // порядок словаря, не порядок строк
  assert.equal(by('INV-U')[at], '');
});

test('procurement: receive movements only, with line sum', () => {
  const { db } = seedRu();
  const r = runReport(db, { kind:'procurement', from:FROM, to:TO }, user);
  assert.equal(r.rows.length, 1);           // the dispense movement is NOT a purchase
  const cols = r.columns;
  assert.equal(r.rows[0][cols.indexOf('Товар')], 'Шовный материал');
  assert.equal(r.rows[0][cols.indexOf('Сумма')], 20000);
});

test('surgery_profit: filters surgery lines, subtracts tax + fee + consumables', () => {
  const { db } = seedRu();
  const r = runReport(db, { kind:'surgery_profit', from:FROM, to:TO }, user);
  assert.equal(r.rows.length, 1);           // консультация is not an operation
  const cols = r.columns;
  const row = r.rows[0];
  assert.equal(row[cols.indexOf('Сумма по счёту')], 1000000);
  assert.equal(row[cols.indexOf('Налог')], 120000);            // 12%
  // DOCTOR_SHARE_AFTER_TAX_V1 — гонорар считается ПОСЛЕ налога:
  // (1 000 000 − 120 000) × 20% = 176 000. Раньше брали 20% от 1 000 000
  // (200 000), то есть клиника платила долю и с той части, что ушла в налог.
  assert.equal(row[cols.indexOf('Гонорар хирурга')], 176000);
  assert.equal(row[cols.indexOf('Расходники (товары)')], 3000);// 2 × 1500 dispensed to the visit
  assert.equal(row[cols.indexOf('Прибыль клиники')], 701000);  // 1 000 000 − 120 000 − 176 000 − 3 000
  assert.equal(row[cols.indexOf('Маржа (%)')], 70.1);
});

test('doctor_salaries: fully-paid invoices only', () => {
  const { db } = seedRu();
  const r = runReport(db, { kind:'doctor_salaries', from:FROM, to:TO }, user);
  assert.equal(r.rows.length, 1);
  const c = r.columns;
  const row = r.rows[0];
  assert.equal(row[c.indexOf('Врач')], 'Доктор Д.');
  assert.equal(row[c.indexOf('Оплаченных услуг')], 1);        // INV-2 is unpaid → excluded
  assert.equal(row[c.indexOf('Сумма после скидки')], 90000);
  assert.equal(row[c.indexOf('Средний % врача')], 30);
  assert.equal(row[c.indexOf('Услуг по фикс. ставке')], 0);
  assert.equal(row[c.indexOf('Доля врача (гонорар)')], 27000);
});

// DOCTOR_FIX_RATE_V1 — a doctor paid a flat sum per unit instead of a share of
// the price. The two must never combine, and the fixed sum must NOT be reduced
// by the invoice discount the way a percentage is — that is the whole point of
// agreeing a fixed rate.
function setFixedRate(db, { pct, fix }) {
  const doc = db.prepare("SELECT id FROM users WHERE full_name = 'Доктор Д.'").get().id;
  const svc = db.prepare("SELECT id FROM services WHERE name = 'Консультация'").get().id;
  // doctor_rates would otherwise win the MAX() union with its own percent.
  db.prepare('UPDATE doctor_rates SET active = 0 WHERE doctor_id = ? AND service_id = ?').run(doc, svc);
  const entry = fix == null ? { service_id: svc, pct, branches: [] } : { service_id: svc, pct, fix, branches: [] };
  db.prepare('UPDATE users SET service_rates = ? WHERE id = ?').run(JSON.stringify([entry]), doc);
  return { doc, svc };
}

test('doctor fee: a fixed rate pays the flat sum per unit, ignoring the percentage', () => {
  const { db } = seedRu();
  setFixedRate(db, { pct: 30, fix: 50000 });

  const r = runReport(db, { kind:'total_revenue', from:FROM, to:TO }, user);
  const cols = r.columns;
  const row = r.rows.find(x => x[cols.indexOf('Услуга')] === 'Консультация');
  // The seeded line is 2 × 50 000, so a 50 000 fixed rate pays 100 000 — NOT
  // 30% of the 90 000 after discount (27 000). The fixed sum is per unit and is
  // deliberately untouched by the invoice's 10 000 discount.
  assert.equal(row[cols.indexOf('Кол-во')], 2);
  assert.equal(row[cols.indexOf('Доля врача')], 100000);
  assert.equal(row[cols.indexOf('Ставка врача')], 'фикс 50000');
});

test('doctor fee: a fixed rate multiplies by quantity', () => {
  const { db } = seedRu();
  const { doc, svc } = setFixedRate(db, { pct: 30, fix: 50000 });
  db.prepare("UPDATE invoice_items SET quantity = 3 WHERE service_id = ? AND id IN (SELECT ii.id FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id WHERE i.status = 'paid')").run(svc);

  const r = runReport(db, { kind:'doctor_salaries', from:FROM, to:TO }, user);
  const c = r.columns;
  assert.equal(r.rows[0][c.indexOf('Доля врача (гонорар)')], 150000);   // 3 × 50 000
  assert.equal(r.rows[0][c.indexOf('Услуг по фикс. ставке')], 1);
  assert.ok(doc && svc);
});

test('doctor fee: removing the fixed rate returns the doctor to their percentage', () => {
  const { db } = seedRu();
  setFixedRate(db, { pct: 30, fix: null });   // pct only — the pre-existing shape

  const r = runReport(db, { kind:'doctor_salaries', from:FROM, to:TO }, user);
  const c = r.columns;
  assert.equal(r.rows[0][c.indexOf('Доля врача (гонорар)')], 27000);
  assert.equal(r.rows[0][c.indexOf('Средний % врача')], 30);
  assert.equal(r.rows[0][c.indexOf('Услуг по фикс. ставке')], 0);
});

test('doctor_salaries: an all-fixed doctor reports no average %, not 0%', () => {
  const { db } = seedRu();
  setFixedRate(db, { pct: 30, fix: 50000 });
  const r = runReport(db, { kind:'doctor_salaries', from:FROM, to:TO }, user);
  const c = r.columns;
  // 0 would read as "works for nothing" beside a 50 000 fee.
  assert.equal(r.rows[0][c.indexOf('Средний % врача')], '—');
});

test('owner_report: KPIs, 12 months, payer buckets; branch_ids filters', () => {
  const { db } = seedRu();
  const o = ownerReport(db, { from:FROM, to:TO }, user);
  assert.equal(o.kpis.revenue, 1090000);
  assert.equal(o.kpis.count, 2);
  assert.equal(o.monthly.length, 12);
  assert.equal(o.monthly[11].value, 1090000);   // current month is the last point
  const payerLabels = o.byPayer.map(x => x.label);
  assert.ok(payerLabels.includes('Пациент (самооплата)'));
  assert.ok(payerLabels.includes('B2B (корпоратив)'));

  // A proper-subset branch filter excludes rows from other branches (and NULLs).
  const none = runReport(db, { kind:'total_revenue', from:FROM, to:TO, branch_ids:[999] }, user);
  assert.equal(none.rows.length, 0);
  const all = runReport(db, { kind:'total_revenue', from:FROM, to:TO, branch_ids:[] }, user);
  assert.equal(all.rows.length, 2);
});
