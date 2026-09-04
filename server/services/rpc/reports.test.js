import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { reportsOverview, runReport, ownerReport, reportBuildings, reportFreshness } from './reports.js';

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
  // BUILDING_REPORTS_V1 — первая колонка теперь «Здание».
  const [building, source, category, mode, count, amount, pct, reward] = r.rows[0];
  assert.equal(building, 'Main Branch');    // своё здание подписано своим именем
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
  // Данные засеяны фиксированным августом 2026, а ряд всегда заканчивается
  // ТЕКУЩИМ месяцем — поэтому индекс августа зависит от даты запуска. Раньше
  // здесь стояло monthly[11] («последняя точка»), и тест сломался сам собой
  // 1 сентября: выручка уехала в monthly[10], а последней точкой стал
  // сентябрь с нулём. Ищем месяц по подписи: в окне из 12 месяцев август
  // ровно один, поэтому проверка больше не зависит от календаря.
  const augIdx = o.monthly.findIndex((m) => m.label === 'авг');
  assert.ok(augIdx >= 0, 'в 12-месячном ряду всегда есть август');
  assert.equal(o.monthly[augIdx].value, 1090000);
  const others = o.monthly.reduce((sum, m, i) => sum + (i === augIdx ? 0 : m.value), 0);
  assert.equal(others, 0, 'выручка стоит ровно в одном месяце');
  const payerLabels = o.byPayer.map(x => x.label);
  assert.ok(payerLabels.includes('Пациент (самооплата)'));
  assert.ok(payerLabels.includes('B2B (корпоратив)'));

  // A proper-subset branch filter excludes rows from other branches (and NULLs).
  const none = runReport(db, { kind:'total_revenue', from:FROM, to:TO, branch_ids:[999] }, user);
  assert.equal(none.rows.length, 0);
  const all = runReport(db, { kind:'total_revenue', from:FROM, to:TO, branch_ids:[] }, user);
  assert.equal(all.rows.length, 2);
});

// ---------------------------------------------------------------------------
// BUILDING_REPORTS_V1 — отчёты считают ВСЕ ЗДАНИЯ клиники, а не только своё.
//
// «Здание» — это отдельная установка со своей базой (branch-sync), а не филиал
// внутри одной базы. Признак строки — `sync_origin` (миграция 083): NULL —
// заведена здесь, буква — приехала оттуда. Так выглядит ПРИНЯТАЯ строка, и
// именно так она ставится в фикстурах ниже.
//
// Деньги (invoices / invoice_items / payments) учатся ездить соседней работой;
// колонки может ещё не быть. moneyTravels() доводит тестовую базу до того
// состояния, в котором она окажется после той миграции, и НИЧЕГО не делает,
// когда колонка уже есть, — поэтому тест верен и до, и после.
// ---------------------------------------------------------------------------

function moneyTravels(db) {
  for (const t of ['invoices', 'invoice_items', 'payments']) {
    const has = db.prepare(`PRAGMA table_info(${t})`).all().some((c) => c.name === 'sync_origin');
    if (!has) db.prepare(`ALTER TABLE ${t} ADD COLUMN sync_origin TEXT`).run();
  }
}

// Клиника из двух зданий: своё (буква A, «Main Branch» из миграции) и соседнее
// «Чиланзар» под буквой B. Соседнее заводится ИМЕННО как active = 0 — так его
// заводит приём справочника (branch-sync/catalogue.js), и так его не видел
// прежний список филиалов в «Отчётах».
function seedTwoBuildings() {
  const { db } = seedRu();
  moneyTravels(db);
  db.prepare("INSERT INTO branches (name, letter, active) VALUES ('Чиланзар','B',0)").run();

  // Своя оплата: seedRu помечает счёт оплаченным, но строки платежа не заводит,
  // а «Собрано» считается по ПЛАТЕЖАМ.
  db.prepare(`INSERT INTO payments (invoice_id, amount, method, cashier_id, paid_at)
      SELECT id, 90000, 'cash', 1, '2026-08-05T10:00:00Z' FROM invoices WHERE invoice_number = 'INV-1'`).run();

  // Приехавший счёт: деньги настоящие, но ни врача, ни регистратора, ни
  // branch_id у него нет — эти поля между зданиями не путешествуют.
  // Свои пациенты заводятся «сейчас» (seedRu), а период отчёта — август;
  // сдвигаем их в период, иначе объёмы проверять не на чем.
  db.prepare("UPDATE patients SET created_at = '2026-08-05T09:00:00Z' WHERE sync_origin IS NULL").run();
  const p3 = db.prepare("INSERT INTO patients (full_name, mrn, created_at, sync_origin) VALUES ('Чарли','B-26-9','2026-08-07T09:00:00Z','B')").run().lastInsertRowid;
  const inv3 = db.prepare(`INSERT INTO invoices
      (invoice_number, patient_id, subtotal, discount_amount, total_amount, paid_amount, status, created_at, paid_at, sync_origin)
      VALUES ('B-INV-3',?,400000,0,400000,400000,'paid','2026-08-07T09:30:00Z','2026-08-07T10:00:00Z','B')`)
    .run(p3).lastInsertRowid;
  const sCons = db.prepare("SELECT id FROM services WHERE name = 'Консультация'").get().id;
  db.prepare(`INSERT INTO invoice_items (invoice_id, service_id, description, quantity, unit_price, total, sync_origin)
      VALUES (?,?,'Консультация',1,400000,400000,'B')`).run(inv3, sCons);
  db.prepare(`INSERT INTO payments (invoice_id, amount, method, paid_at, sync_origin)
      VALUES (?,400000,'cash','2026-08-07T10:00:00Z','B')`).run(inv3);
  return { db, inv3 };
}

test('здания: перечень называет соседа, заведённого как active = 0', () => {
  const { db } = seedTwoBuildings();
  const r = reportBuildings(db, {}, user);
  assert.equal(r.own_letter, 'A');
  const keys = r.buildings.map((b) => b.key);
  assert.deepEqual(keys, ['A', 'B'], 'своё здание первым, сосед следом');
  const b = r.buildings.find((x) => x.key === 'B');
  assert.equal(b.label, 'Чиланзар', 'сосед НАЗВАН, хотя его строка active = 0');
  assert.equal(b.own, false);
  assert.equal(r.buildings.find((x) => x.own).label, 'Main Branch');
});

test('total_revenue: строки обоих зданий, разрез по зданиям и итог по клинике', () => {
  const { db } = seedTwoBuildings();
  const r = runReport(db, { kind: 'total_revenue', from: FROM, to: TO }, user);
  const cols = r.columns;
  assert.equal(cols[0], 'Здание');
  assert.equal(r.rows.length, 3, 'две свои строки + приехавшая');

  const byB = r.by_building.find((x) => x.key === 'B');
  const byOwn = r.by_building.find((x) => x.own);
  assert.equal(byB.total, 400000);
  assert.equal(byOwn.total, 1090000);          // 90 000 + 1 000 000
  assert.equal(byOwn.total + byB.total, 1490000, 'итог по клинике = сумма зданий');

  const foreign = r.rows.find((x) => x[0] === 'Чиланзар');
  assert.ok(foreign, 'строка соседнего здания в отчёте ЕСТЬ');
  assert.equal(foreign[cols.indexOf('Врач')], 'Чиланзар, врач не указан',
    'приехавшую строку нельзя привязать к врачу — её подписывают зданием, а не выбрасывают');
  assert.ok(r.notes.some((n) => n.includes('врач не указан')), 'на экране сказано, почему');
});

test('total_revenue: выбор одного здания исключает второе', () => {
  const { db } = seedTwoBuildings();
  const onlyB = runReport(db, { kind: 'total_revenue', from: FROM, to: TO, buildings: ['B'] }, user);
  assert.equal(onlyB.rows.length, 1);
  assert.equal(onlyB.rows[0][0], 'Чиланзар');

  const onlyOwn = runReport(db, { kind: 'total_revenue', from: FROM, to: TO, buildings: ['A'] }, user);
  assert.equal(onlyOwn.rows.length, 2);
  assert.ok(onlyOwn.rows.every((x) => x[0] === 'Main Branch'));

  // Выбраны ОБА = фильтра нет.
  const both = runReport(db, { kind: 'total_revenue', from: FROM, to: TO, buildings: ['A', 'B'] }, user);
  assert.equal(both.rows.length, 3);
});

test('invoices_full и Отчёт кассира-подобные суммы: счета обоих зданий', () => {
  const { db } = seedTwoBuildings();
  const r = runReport(db, { kind: 'invoices_full', from: FROM, to: TO }, user);
  assert.equal(r.columns[0], 'Здание');
  assert.equal(r.rows.length, 3);
  const b = r.by_building.find((x) => x.key === 'B');
  assert.equal(b.total, 400000);
  assert.equal(b.paid, 400000);
});

test('doctor_salaries: оплаченные услуги соседнего здания не пропадают', () => {
  const { db } = seedTwoBuildings();
  const r = runReport(db, { kind: 'doctor_salaries', from: FROM, to: TO }, user);
  const cols = r.columns;
  const foreign = r.rows.find((x) => x[0] === 'Чиланзар');
  assert.ok(foreign, 'строка соседнего здания осталась в отчёте');
  assert.equal(foreign[cols.indexOf('Врач')], 'Чиланзар, врач не указан');
  assert.equal(foreign[cols.indexOf('Сумма после скидки')], 400000);
  assert.ok(r.notes.length, 'на экране объяснено, почему врач не указан');

  // Своя строка по-прежнему привязана к врачу — правило для своего здания не изменилось.
  const own = r.rows.find((x) => x[cols.indexOf('Врач')] === 'Доктор Д.');
  assert.ok(own);
  assert.equal(own[0], 'Main Branch');
});

test('procurement: склад не ездит — цифры только по своему зданию, и это сказано', () => {
  const { db } = seedTwoBuildings();
  const r = runReport(db, { kind: 'procurement', from: FROM, to: TO }, user);
  assert.equal(r.columns[0], 'Здание');
  assert.ok(r.rows.length >= 1);
  assert.ok(r.rows.every((x) => x[0] === 'Main Branch'), 'все поступления — свои');
  assert.ok(r.notes.some((n) => n.includes('Складские движения')), 'примечание про склад обязательно');

  // «Только соседнее здание» обязано вернуть ПУСТО, а не свои же поступления.
  const onlyB = runReport(db, { kind: 'procurement', from: FROM, to: TO, buildings: ['B'] }, user);
  assert.equal(onlyB.rows.length, 0);
});

test('surgery_profit: операции обоих зданий + примечание про расходники', () => {
  const { db } = seedTwoBuildings();
  const r = runReport(db, { kind: 'surgery_profit', from: FROM, to: TO }, user);
  assert.equal(r.columns[0], 'Здание');
  assert.ok(r.notes.some((n) => n.includes('Складские движения')));
});

test('reports_overview: объёмы не завышены — считаются по зданиям и в сумме', () => {
  const { db } = seedTwoBuildings();
  const o = reportsOverview(db, { from: FROM, to: TO }, user);
  assert.equal(o.building_count, 2);
  const own = o.buildings.find((b) => b.own);
  const b = o.buildings.find((x) => x.key === 'B');

  assert.equal(b.patients_new, 1, 'приехавший пациент приписан зданию B');
  assert.equal(own.patients_new, 2, 'своих пациентов ровно двое');
  assert.equal(own.patients_new + b.patients_new, o.patients_new, 'итог = сумма зданий, без двойного счёта');

  assert.equal(b.cash_collected, 400000, 'деньги соседнего здания ВИДНЫ');
  assert.equal(o.cash_collected, own.cash_collected + b.cash_collected);
});

test('reports_overview: выбор одного здания исключает второе', () => {
  const { db } = seedTwoBuildings();
  const onlyB = reportsOverview(db, { from: FROM, to: TO, buildings: ['B'] }, user);
  assert.equal(onlyB.patients_new, 1);
  assert.equal(onlyB.cash_collected, 400000);
  const onlyOwn = reportsOverview(db, { from: FROM, to: TO, buildings: ['A'] }, user);
  assert.equal(onlyOwn.cash_collected, 90000, 'приехавшие деньги исключены');
});

test('owner_report: KPI по клинике и разрез по зданиям', () => {
  const { db } = seedTwoBuildings();
  const o = ownerReport(db, { from: FROM, to: TO }, user);
  const b = o.buildings.find((x) => x.key === 'B');
  const own = o.buildings.find((x) => x.own);
  assert.equal(b.value, 400000);
  assert.equal(own.value + b.value, o.kpis.revenue, 'итог владельца = сумма зданий');
});

// Клиника в ОДНОМ здании: чужих строк нет вовсе. Отчёт обязан выглядеть ровно
// как раньше (плюс колонка «Здание» с именем самой клиники), а «только сосед»
// — отдать пусто, а не свои же деньги под чужим именем.
test('одно здание: отчёт как раньше, а «только сосед» отдаёт пусто', () => {
  const { db } = seedRu();
  db.prepare("INSERT INTO branches (name, letter, active) VALUES ('Чиланзар','B',0)").run();
  const r = runReport(db, { kind: 'total_revenue', from: FROM, to: TO }, user);
  assert.equal(r.rows.length, 2);
  assert.ok(r.rows.every((x) => x[0] === 'Main Branch'));
  const onlyB = runReport(db, { kind: 'total_revenue', from: FROM, to: TO, buildings: ['B'] }, user);
  assert.equal(onlyB.rows.length, 0, 'своих денег под чужим именем не показываем');
  const o = reportsOverview(db, { from: FROM, to: TO }, user);
  assert.equal(o.building_count, 2, 'здание B известно из перечня, даже пока пустое');
});

// ---------------------------------------------------------------------------
// PENDING_ITEMS_V1 — счёт приехал ШАПКОЙ, а его позиции ещё в пути.
//
// Так и выглядит расхождение двух семей отчётов: «Счета» и «Собрано» деньги
// видят (шапка приехала), «Общая выручка» и KPI владельца — нет (строк счёта в
// базе ещё нет). Фикстура ставит sync_origin прямо, как это делает приём.
// ---------------------------------------------------------------------------

function seedItemsInTransit() {
  const { db } = seedTwoBuildings();
  const b = db.prepare("SELECT id FROM patients WHERE sync_origin = 'B'").get().id;
  const own = db.prepare('SELECT id FROM patients WHERE sync_origin IS NULL ORDER BY id').get().id;
  const sCons = db.prepare("SELECT id FROM services WHERE name = 'Консультация'").get().id;

  // (1) Шапка приехала, позиций нет ВООБЩЕ — ровно случай ревью: 300 в кассе,
  // 0 в выручке.
  db.prepare(`INSERT INTO invoices
      (invoice_number, patient_id, subtotal, discount_amount, total_amount, paid_amount, status, created_at, paid_at, sync_origin)
      VALUES ('B-INV-4',?,300,0,300,300,'paid','2026-08-08T09:30:00Z','2026-08-08T10:00:00Z','B')`).run(b);

  // (2) Приехала ПОЛОВИНА позиций: 500 000 − 100 000 скидки = 400 000 по шапке,
  // доехало строк на 200 000 (после своей доли скидки — 160 000). Недостача
  // 240 000, и считается она той же арифметикой, что итог отчёта.
  const inv5 = db.prepare(`INSERT INTO invoices
      (invoice_number, patient_id, subtotal, discount_amount, total_amount, paid_amount, status, created_at, sync_origin)
      VALUES ('B-INV-5',?,500000,100000,400000,0,'unpaid','2026-08-08T09:40:00Z','B')`).run(b).lastInsertRowid;
  db.prepare(`INSERT INTO invoice_items (invoice_id, service_id, description, quantity, unit_price, total, sync_origin)
      VALUES (?,?,'Консультация',1,200000,200000,'B')`).run(inv5, sCons);

  // (3) СВОЙ счёт без позиций. Это не задержка доставки, а ошибка ввода —
  // считать его «ещё едет» значит соврать про совсем другую беду.
  db.prepare(`INSERT INTO invoices
      (invoice_number, patient_id, subtotal, discount_amount, total_amount, paid_amount, status, created_at)
      VALUES ('INV-9',?,777000,0,777000,0,'unpaid','2026-08-09T09:00:00Z')`).run(own);
  return { db };
}

test('недоехавшие позиции: считаются, названы и в итог отчёта НЕ попадают', () => {
  const { db } = seedItemsInTransit();
  const r = runReport(db, { kind: 'total_revenue', from: FROM, to: TO }, user);

  assert.equal(r.pending_items.invoices, 2, 'два приехавших счёта ждут свои позиции');
  assert.equal(r.pending_items.amount, 240300, '300 целиком + 240 000 недостающей части');

  const p = r.pending_items.by_building.find((x) => x.key === 'B');
  assert.equal(p.invoices, 2);
  assert.equal(p.amount, 240300, 'недостача приписана зданию, которое её прислало');
  const pOwn = r.pending_items.by_building.find((x) => x.own);
  assert.equal(pOwn.amount, 0, 'свой счёт без позиций — не доставка, а ввод');

  // И ГЛАВНОЕ: сумма отчёта осталась суммой ПРИЕХАВШИХ строк.
  const byB = r.by_building.find((x) => x.key === 'B');
  assert.equal(byB.total, 560000, '400 000 прежнего счёта + 160 000 доехавшей строки');
  assert.ok(!r.rows.some((row) => row.includes('B-INV-4')), 'счёта без позиций в строках нет');
  const rowsTotal = r.rows.reduce((n, row) => n + row[r.columns.indexOf('После скидки')], 0);
  assert.equal(rowsTotal, 1090000 + 560000, 'ни одной выдуманной строки: итог = сумма строк');

  assert.match(r.pending_items.note, /Позиции ещё не доехали: 2 счетов, 240 300 сум/);
  db.close();
});

test('недоехавшие позиции: видны во всех отчётах по строкам и у владельца', () => {
  const { db } = seedItemsInTransit();
  for (const kind of ['total_revenue', 'referrals', 'surgery_profit', 'doctor_salaries']) {
    const r = runReport(db, { kind, from: FROM, to: TO }, user);
    assert.equal(r.pending_items.amount, 240300, kind + ': отчёт по строкам обязан сказать о недостаче');
  }
  // Отчёты по шапкам и по складу этой дыры не имеют — им и говорить не о чем.
  assert.equal(runReport(db, { kind: 'invoices_full', from: FROM, to: TO }, user).pending_items, null);
  assert.equal(runReport(db, { kind: 'procurement', from: FROM, to: TO }, user).pending_items, null);

  const o = ownerReport(db, { from: FROM, to: TO }, user);
  assert.equal(o.pending_items.amount, 240300);
  assert.ok(o.pending_items.note.includes('240 300'));
  db.close();
});

test('недоехавшие позиции: фильтр по зданию и период действуют так же, как на отчёт', () => {
  const { db } = seedItemsInTransit();
  const onlyOwn = runReport(db, { kind: 'total_revenue', from: FROM, to: TO, buildings: ['A'] }, user);
  assert.equal(onlyOwn.pending_items.invoices, 0, 'у своего здания недоехавших позиций нет');
  assert.equal(onlyOwn.pending_items.note, null, 'нечего сказать — и не говорим');

  const onlyB = runReport(db, { kind: 'total_revenue', from: FROM, to: TO, buildings: ['B'] }, user);
  assert.equal(onlyB.pending_items.amount, 240300);

  const other = runReport(db, { kind: 'total_revenue', from: '2026-09-01', to: '2026-09-30' }, user);
  assert.equal(other.pending_items.invoices, 0, 'за другой период — своя недостача, а не общая');
  db.close();
});

test('недоехавшие позиции: аннулированный счёт деньгами не считается', () => {
  const { db } = seedItemsInTransit();
  db.prepare("UPDATE invoices SET status = 'void' WHERE invoice_number = 'B-INV-4'").run();
  const r = runReport(db, { kind: 'total_revenue', from: FROM, to: TO }, user);
  assert.equal(r.pending_items.invoices, 1);
  assert.equal(r.pending_items.amount, 240000);
  db.close();
});

// ---------------------------------------------------------------------------
// BUILDING_FRESHNESS_V1 — «данные ещё едут» по каждому зданию.
// ---------------------------------------------------------------------------

function seedSyncState(db) {
  db.prepare(`INSERT INTO sync_peers (node, recv_upto, last_ok, last_ack, clock_skew_ms)
              VALUES ('B', 4120, '2026-08-07T10:00:00Z', '2026-08-07T10:05:00Z', 250)`).run();
  // Буква здания у ожидания зашита в МЕТКУ: отдельной колонки у sync_pending нет.
  const pend = db.prepare(`INSERT INTO sync_pending (tbl, uid, stamp, record, waits_tbl, waits_uid, received_at)
                           VALUES (?,?,?,'{}',?,?,?)`);
  pend.run('invoice_items', 'u-1', '0000018f0000-0000-B', 'services', 'CODE-77', '2026-08-07T10:05:00Z');
  pend.run('invoice_items', 'u-2', '0000018f0001-0000-B', 'services', 'CODE-78', '2026-08-07T10:06:00Z');
  // Метка не той формы: приписать её своему зданию значило бы повторить ту же
  // ошибку, ради которой всё это писалось.
  pend.run('lab_results', 'u-3', 'мусор', 'visit_services', 'u-0', '2026-08-07T10:07:00Z');
  db.prepare(`INSERT INTO sync_refused (tbl, uid, peer, err, at)
              VALUES ('lab_results','u-9','B','NOT NULL constraint failed: lab_results.value','2026-08-07T11:00:00Z')`).run();
}

test('свежесть: по каждому зданию видно, когда его слышали, сколько ждёт и сколько не принято', () => {
  const { db } = seedTwoBuildings();
  seedSyncState(db);
  const f = reportFreshness(db, {}, user);

  assert.equal(f.building_count, 2);
  const own = f.buildings.find((x) => x.own);
  const b = f.buildings.find((x) => x.key === 'B');

  assert.equal(own.label, 'Main Branch');
  assert.equal(own.last_received, null, 'своё здание само себе ничего не присылает');
  assert.equal(own.pending, 0);
  assert.equal(own.refused, 0);

  assert.equal(b.label, 'Чиланзар');
  assert.equal(b.linked, true);
  assert.equal(b.last_received, '2026-08-07T10:05:00Z');
  assert.equal(b.last_sent_ok, '2026-08-07T10:00:00Z');
  assert.equal(b.recv_upto, 4120);
  assert.equal(b.clock_skew_ms, 250);
  assert.equal(b.pending, 2, 'оба ожидания приписаны зданию по букве из метки');
  assert.equal(b.pending_oldest, '2026-08-07T10:05:00Z');
  assert.equal(b.refused, 1);
  assert.equal(b.refused_last, '2026-08-07T11:00:00Z');
  assert.match(b.refused_error, /NOT NULL/, 'на экран идёт то, что сказала база');
  assert.equal(b.seeding, false);

  assert.equal(f.pending_total, 2);
  assert.equal(f.refused_total, 1);
  assert.equal(f.pending_unattributed, 1, 'ожидание с нечитаемой меткой посчитано отдельно');

  // Версия соседа по проводу не едет — и экран обязан сказать это прямо.
  assert.equal(b.version, null);
  assert.equal(b.version_known, false);
  assert.match(f.version_note, /Версия/);
  db.close();
});

test('свежесть: первичная загрузка названа страницей, а не «зависло»', () => {
  const { db } = seedTwoBuildings();
  db.prepare(`INSERT INTO sync_peers (node, seed_floor, seed_page, last_ack)
              VALUES ('B', 100, 3, '2026-08-07T10:05:00Z')`).run();
  const b = reportFreshness(db, {}, user).buildings.find((x) => x.key === 'B');
  assert.equal(b.seeding, true);
  assert.equal(b.seed_page, 4, 'страницы считаются с нуля, человеку показываем следующую');
  db.close();
});

test('свежесть: здание, о котором знает только обмен, всё равно НАЗВАНО', () => {
  const { db } = seedTwoBuildings();
  db.prepare("INSERT INTO sync_refused (tbl, uid, peer, err) VALUES ('patients','u-7','C','no such column: x')").run();
  const f = reportFreshness(db, {}, user);
  const c = f.buildings.find((x) => x.key === 'C');
  assert.ok(c, 'самая плохая новость экрана не должна быть единственной, которая на него не попала');
  assert.equal(c.refused, 1);
  assert.equal(c.label, 'Филиал C');
  db.close();
});

test('свежесть: клиника без соседей и без обмена отвечает, а не падает', () => {
  const { db } = seedRu();
  const f = reportFreshness(db, {}, user);
  assert.equal(f.building_count, 1);
  assert.equal(f.buildings[0].own, true);
  assert.equal(f.pending_total, 0);
  assert.equal(f.refused_total, 0);
  db.close();
});
