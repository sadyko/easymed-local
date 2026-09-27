// REPORTS_AUDIT_FIX_V1 (2026-09-27) — находки аудита отчётов, каждая — на
// настоящих RPC и настоящих строках базы, а не на выражениях SQL.
//
//   1  «Счета»: у отменённого счёта нет долга; итог не складывает отменённые
//      счета и счета депозита/карты (DEP-/CARD-) — они в списке, но не в итоге;
//   2  «По специальностям»: работа соседнего здания не считается дважды;
//   3  «Рентабельность операций»: операция — и по группе «Хирургия»;
//      расходники визита делятся между операциями, а не повторяются; у
//      стационарной операции — расходники её госпитализации;
//   4  частичный фильтр по филиалу не выбрасывает деньги стационара;
//   6  «Кто платит» — плательщик СЧЁТА, а не нынешний плательщик пациента;
//   14 прежние виды run_report: «payments» без кошелька, «services» без
//      отменённых счетов и со скидкой;
//   15 счёт с полным возвратом в выручку не входит — как отменённый.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { runReport, ownerReport } from './reports.js';

const admin = { id: 9, role: 'admin' };
const FROM = '2026-09-01';
const TO = '2026-09-30';
const DAY = '2026-09-10T09:00:00Z';
const objects = (r) => r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]])));
const sumCol = (r, col) => objects(r).reduce((n, o) => n + (Number(o[col]) || 0), 0);

function clinic() {
  const db = openDb(':memory:');
  migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, role, full_name, is_doctor, service_rates, specialty) VALUES (?,?,?,?,?,?,?,?)');
  u.run(1, 'doc', 'x', 'doctor', 'Хирург Х.', 1, JSON.stringify([{ service_id: 1, pct: 10 }, { service_id: 2, pct: 10 }]), 'Хирург');
  u.run(9, 'adm', 'x', 'admin', 'Администратор', 0, '', '');
  db.prepare("INSERT INTO patients (id, mrn, full_name) VALUES (1,'P-1','Пациент')").run();
  db.prepare("INSERT INTO services (id, name, price, tax_rate, type) VALUES (1,'Аппендэктомия',1000000,0,'other')").run();
  db.prepare("INSERT INTO services (id, name, price, tax_rate, type) VALUES (2,'Лапароскопия',500000,0,'other')").run();
  db.prepare("INSERT INTO services (id, name, price, tax_rate, type) VALUES (3,'Приём',100000,0,'consultation')").run();
  db.prepare("INSERT INTO products (id, name, avg_cost) VALUES (1,'Шовный материал',1000)").run();
  return db;
}
let invSeq = 0;
function invoice(db, { number, total, paid = 0, status = 'paid', visit = null, admission = null, branch = null, payer = null, discount = 0 }) {
  invSeq += 1;
  return db.prepare(`INSERT INTO invoices (invoice_number, patient_id, visit_id, admission_id, branch_id, payer_id,
                       subtotal, discount_amount, total_amount, paid_amount, status, created_at)
                     VALUES (?,1,?,?,?,?,?,?,?,?,?,?)`)
    .run(number || 'INV-' + invSeq, visit, admission, branch, payer, total + discount, discount, total, paid, status, DAY).lastInsertRowid;
}
function item(db, inv, { service = 3, total, qty = 1, description = 'Услуга' }) {
  return db.prepare('INSERT INTO invoice_items (invoice_id, service_id, description, quantity, unit_price, total) VALUES (?,?,?,?,?,?)')
    .run(inv, service, description, qty, total / qty, total).lastInsertRowid;
}

// ─── 1 ───────────────────────────────────────────────────────────────────────

test('1: «Счета» — у отменённого и возвращённого счёта долга нет; итог без них и без DEP-/CARD-', () => {
  const db = clinic();
  invoice(db, { number: 'INV-A', total: 100000, paid: 100000, status: 'paid' });
  invoice(db, { number: 'INV-V', total: 50000, paid: 0, status: 'void' });
  invoice(db, { number: 'INV-R', total: 70000, paid: 0, status: 'refunded' });
  invoice(db, { number: 'DEP-1', total: 200000, paid: 200000, status: 'paid' });
  invoice(db, { number: 'CARD-1', total: 30000, paid: 30000, status: 'paid' });
  invoice(db, { number: 'INV-U', total: 40000, paid: 10000, status: 'partial' });
  const r = runReport(db, { kind: 'invoices_full', from: FROM, to: TO }, admin);
  const o = objects(r);
  const by = (n) => o.find((x) => x['№ счёта'] === n);
  assert.equal(by('INV-V')['Остаток / долг'], 0, 'отменённый счёт показывал долг');
  assert.equal(by('INV-R')['Остаток / долг'], 0, 'возвращённый счёт показывал долг');
  assert.equal(by('INV-U')['Остаток / долг'], 30000);
  // Итог по зданиям — только живые счета услуг.
  assert.equal(r.by_building[0].total, 140000, 'итог сложил отменённые или DEP-/CARD-');
  // Строки вне итога названы серверу-клиенту списком — футер таблицы их не сложит.
  const skipped = (r.total_skip_rows || []).map((i) => r.rows[i][r.columns.indexOf('№ счёта')]).sort();
  assert.deepEqual(skipped, ['CARD-1', 'DEP-1', 'INV-R', 'INV-V']);
  assert.ok(r.notes.some((n) => /DEP-/.test(n) && /Итого/.test(n)), 'нет примечания о строках вне итога');
});

// ─── 2 ───────────────────────────────────────────────────────────────────────

test('2: «По специальностям» — работа соседнего здания один раз, а не строкой визита и строкой счёта', () => {
  const db = clinic();
  db.prepare("INSERT INTO branches (name, letter, active) VALUES ('Чиланзар','B',0)").run();
  // Приехавший визит и его выполненная строка: врача и связи со счётом нет.
  db.prepare("INSERT INTO visits (id, patient_id, visit_date, status, sync_origin) VALUES (5,1,?,'arrived','B')").run(DAY);
  db.prepare(`INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, sync_origin)
              VALUES (5,3,NULL,1,100000,100000,'completed','B')`).run();
  // Приехавший счёт этой же работы.
  const inv = db.prepare(`INSERT INTO invoices (invoice_number, patient_id, visit_id, subtotal, discount_amount, total_amount, paid_amount, status, created_at, sync_origin)
                          VALUES ('B-INV-1',1,5,100000,0,100000,100000,'paid',?,'B')`).run(DAY).lastInsertRowid;
  db.prepare(`INSERT INTO invoice_items (invoice_id, service_id, description, quantity, unit_price, total, sync_origin)
              VALUES (?,3,'Приём',1,100000,100000,'B')`).run(inv);
  const r = runReport(db, { kind: 'by_specialty', from: FROM, to: TO }, admin);
  assert.equal(sumCol(r, 'Сумма после скидки'), 100000, 'работа соседнего здания посчитана дважды');
  assert.equal(sumCol(r, 'Кол-во'), 1);
});

// ─── 3 ───────────────────────────────────────────────────────────────────────

test('3: «Рентабельность операций» — группа «Хирургия», расходники визита один раз, стационар с расходниками', () => {
  const db = clinic();
  db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (1,1,?,'arrived')").run(DAY);
  const inv = invoice(db, { total: 1500000, paid: 1500000, visit: 1 });
  const i1 = item(db, inv, { service: 1, total: 1000000 });
  const i2 = item(db, inv, { service: 2, total: 500000 });
  const vs = db.prepare(`INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, invoice_item_id)
                         VALUES (1,?,1,1,?,?,'completed',?)`);
  const v1 = vs.run(1, 1000000, 1000000, i1).lastInsertRowid;
  vs.run(2, 500000, 500000, i2);
  // 30 единиц по 1 000 = 30 000 на визит; 5 из них отменены (void) → 25 000.
  db.prepare("INSERT INTO stock_movements (product_id, kind, qty, unit_cost, reference_type, reference_id, created_at) VALUES (1,'dispense',-30,1000,'visit',?,?)").run(v1, DAY);
  db.prepare("INSERT INTO stock_movements (product_id, kind, qty, unit_cost, reference_type, reference_id, created_at) VALUES (1,'void',5,1000,'visit',?,?)").run(v1, DAY);

  // Стационарная операция: счёт госпитализации, строка стационара, расход на неё.
  db.prepare("INSERT INTO admissions (id, patient_id, status, admitted_at) VALUES (1,1,'discharged',?)").run(DAY);
  const ainv = invoice(db, { total: 500000, paid: 500000, admission: 1 });
  const ai = item(db, ainv, { service: 2, total: 500000 });
  const as = db.prepare(`INSERT INTO admission_services (admission_id, service_id, doctor_id, performer_id, quantity, unit_price, total, performed_at, invoice_item_id, billable)
                         VALUES (1,2,1,1,1,500000,500000,?,?,1)`).run(DAY, ai).lastInsertRowid;
  db.prepare("INSERT INTO stock_movements (product_id, kind, qty, unit_cost, reference_type, reference_id, created_at) VALUES (1,'dispense',-8,1000,'admission',?,?)").run(as, DAY);

  const r = runReport(db, { kind: 'surgery_profit', from: FROM, to: TO }, admin);
  const o = objects(r);
  assert.equal(o.length, 3, 'операции группы «Хирургия» без слова «операция» в названии не найдены');
  assert.equal(sumCol(r, 'Расходники (товары)'), 25000 + 8000, 'расходники визита повторены у каждой операции или стационар без расходников');
  // Делятся пропорционально сумме операции: 2/3 и 1/3.
  const out = o.filter((x) => x['Сумма по счёту'] !== 500000 || x['Расходники (товары)'] !== 8000);
  const big = o.find((x) => x['Операция'] === 'Аппендэктомия');
  assert.equal(Math.round(big['Расходники (товары)']), Math.round(25000 * 2 / 3));
  assert.ok(out.length >= 2);
});

// ─── 4 ───────────────────────────────────────────────────────────────────────

test('4: фильтр по филиалу не выбрасывает деньги стационара (счёт госпитализации без филиала)', () => {
  const db = clinic();
  const own = db.prepare('SELECT COALESCE(bi.branch_id, (SELECT id FROM branches WHERE letter = bi.letter)) AS id FROM branch_identity bi WHERE id = 1').get().id;
  assert.ok(own, 'у базы нет своего филиала');
  db.prepare("INSERT INTO branches (id, name, active) VALUES (77,'Второй',1)").run();
  db.prepare("INSERT INTO admissions (id, patient_id, status, admitted_at) VALUES (1,1,'discharged',?)").run(DAY);
  const ainv = invoice(db, { total: 300000, paid: 300000, admission: 1, branch: null });
  item(db, ainv, { service: 3, total: 300000 });
  const other = invoice(db, { total: 50000, paid: 50000, branch: 77 });
  item(db, other, { service: 3, total: 50000 });
  const args = { from: FROM, to: TO, branch_ids: [own] };
  assert.equal(sumCol(runReport(db, { kind: 'total_revenue', ...args }, admin), 'После скидки'), 300000);
  assert.equal(sumCol(runReport(db, { kind: 'invoices_full', ...args }, admin), 'Итого'), 300000);
  assert.equal(ownerReport(db, args, admin).kpis.revenue, 300000);
  // И второй филиал своё получает, стационара у него нет.
  assert.equal(sumCol(runReport(db, { kind: 'total_revenue', from: FROM, to: TO, branch_ids: [77] }, admin), 'После скидки'), 50000);
});

// ─── 6 ───────────────────────────────────────────────────────────────────────

test('6: «Кто платит» — плательщик счёта, а не нынешний плательщик пациента', () => {
  const db = clinic();
  db.prepare("INSERT INTO payers (id, name, kind) VALUES (1,'Страховая А','insurance')").run();
  db.prepare("INSERT INTO payers (id, name, kind) VALUES (2,'Завод Б','corporate')").run();
  db.prepare('UPDATE patients SET payer_id = 2 WHERE id = 1').run();   // сегодня — завод
  const inv = invoice(db, { total: 100000, paid: 100000, payer: 1 });  // счёт — страховой
  item(db, inv, { service: 3, total: 100000 });
  const self = invoice(db, { total: 20000, paid: 20000, payer: null });   // этот — сам пациент
  item(db, self, { service: 3, total: 20000 });
  const o = objects(runReport(db, { kind: 'invoices_full', from: FROM, to: TO }, admin));
  assert.equal(o.find((x) => x['Итого'] === 100000)['Кто платит'], 'Страховая А');
  assert.equal(o.find((x) => x['Итого'] === 20000)['Кто платит'], 'Пациент');
  const payers = ownerReport(db, { from: FROM, to: TO }, admin).byPayer;
  const val = (label) => (payers.find((p) => p.label.startsWith(label)) || { value: 0 }).value;
  assert.equal(val('ДМС'), 100000);
  assert.equal(val('B2B'), 0);
  assert.equal(val('Пациент'), 20000);
});

// ─── 14 ──────────────────────────────────────────────────────────────────────

test('14: прежние виды — «payments» без оплаты кошельком, «services» без отменённых и со скидкой', () => {
  const db = clinic();
  const inv = invoice(db, { total: 90000, paid: 90000, discount: 10000 });
  item(db, inv, { service: 3, total: 100000 });
  db.prepare("INSERT INTO payments (invoice_id, amount, method, paid_at) VALUES (?,60000,'cash',?)").run(inv, DAY);
  db.prepare("INSERT INTO payments (invoice_id, amount, method, paid_at) VALUES (?,30000,'wallet',?)").run(inv, DAY);
  const v = invoice(db, { total: 500000, status: 'void' });
  item(db, v, { service: 3, total: 500000 });
  const pay = runReport(db, { kind: 'payments', from: FROM, to: TO }, admin);
  assert.equal(pay.rows.length, 1, 'оплата кошельком попала в поступления');
  const svc = objects(runReport(db, { kind: 'services', from: FROM, to: TO }, admin));
  assert.equal(svc.length, 1);
  assert.equal(svc[0].Revenue, 90000, 'отменённый счёт или сумма без скидки');
});

// ─── 15 ──────────────────────────────────────────────────────────────────────

test('15: счёт с полным возвратом в выручку не входит — как отменённый, с примечанием', () => {
  const db = clinic();
  const ok = invoice(db, { total: 100000, paid: 100000 });
  item(db, ok, { service: 3, total: 100000 });
  const back = invoice(db, { total: 80000, paid: 0, status: 'refunded' });
  item(db, back, { service: 3, total: 80000 });
  const tr = runReport(db, { kind: 'total_revenue', from: FROM, to: TO }, admin);
  assert.equal(sumCol(tr, 'После скидки'), 100000, 'возвращённый счёт остался выручкой');
  assert.ok(tr.notes.some((n) => /возврат/i.test(n) && /Отменённые/.test(n)));
  assert.equal(ownerReport(db, { from: FROM, to: TO }, admin).kpis.revenue, 100000);
  const bs = runReport(db, { kind: 'by_services', from: FROM, to: TO }, admin);
  assert.equal(sumCol(bs, 'Сумма'), 100000);
});

// ─── 8 ───────────────────────────────────────────────────────────────────────
//
// Доли врачей — это «Оплата врачей». Роль, которой эта группа закрыта, видит
// отчёты по выручке, услугам и рефералам, но не чужие доли и не вознаграждение
// сотрудников за направления; свои — врач видит всегда.

function payClinic() {
  const db = clinic();
  const u = db.prepare('INSERT INTO users (id, username, password_hash, role, full_name, is_doctor, service_rates, specialty, custom_role_code) VALUES (?,?,?,?,?,?,?,?,?)');
  u.run(2, 'doc2', 'x', 'doctor', 'Терапевт Т.', 1, JSON.stringify([{ service_id: 3, pct: 20 }]), 'Терапевт', null);
  u.run(20, 'kassa', 'x', 'cashier', 'Кассир К.', 0, '', '', 'kassa_rev');
  db.prepare("INSERT INTO custom_roles (code, name, base_role) VALUES ('kassa_rev', 'Выручка без зарплат', 'cashier')").run();
  const grants = { reports: 'view', 'reports.revenue': 'view', 'reports.services': 'view', 'reports.referrals': 'view', 'reports.doctor_pay': 'none' };
  db.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?)')
    .run('kassa_rev', JSON.stringify({ sections: ['reports-hub'], levels: {}, grants }));
  // Врачам — та же выручка, «Оплата врачей» закрыта.
  const row = db.prepare("SELECT permissions FROM role_permissions WHERE role = 'doctor'").get();
  const perms = row ? JSON.parse(row.permissions) : { sections: [], levels: {} };
  perms.grants = { ...(perms.grants || {}), ...grants };
  db.prepare("UPDATE role_permissions SET permissions = ? WHERE role = 'doctor'").run(JSON.stringify(perms));
  // Внутренний источник направлений — врач 2, 10 % от приёма.
  const cat = db.prepare("INSERT INTO referral_source_categories (name, standard_percent, is_internal) VALUES ('Свои врачи', 10, 1)").run().lastInsertRowid;
  // Источник сотрудника заводится вместе с врачом (мигр. 122) — ставим ему категорию.
  let src = (db.prepare('SELECT id FROM referral_sources WHERE doctor_id = 2').get() || {}).id;
  if (src == null) src = db.prepare("INSERT INTO referral_sources (name, doctor_id) VALUES ('Терапевт Т.', 2)").run().lastInsertRowid;
  db.prepare('UPDATE referral_sources SET category_id = ? WHERE id = ?').run(cat, src);
  db.prepare("INSERT INTO visits (id, patient_id, visit_date, status, referral_source_id) VALUES (1,1,?,'arrived',?)").run(DAY, src);
  const inv = invoice(db, { total: 1100000, paid: 1100000, visit: 1 });
  const i1 = item(db, inv, { service: 1, total: 1000000 });
  const i2 = item(db, inv, { service: 3, total: 100000 });
  const vs = db.prepare(`INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, invoice_item_id)
                         VALUES (1,?,?,1,?,?,'completed',?)`);
  vs.run(1, 1, 1000000, 1000000, i1);   // хирург (1): 10 % = 100 000
  vs.run(3, 2, 100000, 100000, i2);     // терапевт (2): 20 % = 20 000
  return db;
}
const KASSA = { id: 20, role: 'cashier', extra_roles: [], custom_role_code: 'kassa_rev' };
const DOC1 = { id: 1, role: 'doctor', extra_roles: [] };
const col = (r, name) => objects(r).map((o) => o[name]);

test('8: без «Оплаты врачей» — доли врачей скрыты в выручке, услугах, операциях и рефералах', () => {
  const db = payClinic();
  const args = { from: FROM, to: TO };
  // Администратор видит всё.
  assert.deepEqual(col(runReport(db, { kind: 'total_revenue', ...args }, admin), 'Доля врача').sort(), [100000, 20000].sort());
  const tr = runReport(db, { kind: 'total_revenue', ...args }, KASSA);
  assert.deepEqual(col(tr, 'Доля врача'), [null, null], 'кассир видит доли врачей');
  assert.deepEqual(col(tr, 'Ставка врача'), [null, null]);
  assert.ok(tr.notes.some((n) => /Оплата врачей/.test(n)), 'нет примечания, почему колонка пуста');
  assert.ok(tr.by_building.every((b) => !('doctor_fee' in b)), 'доля врача утекла разрезом по зданиям');
  assert.equal(sumCol(tr, 'После скидки'), 1100000, 'выручку маскировать нельзя');
  // Врач видит свою долю, чужую — нет.
  const own = objects(runReport(db, { kind: 'total_revenue', ...args }, DOC1));
  assert.equal(own.find((o) => o['Врач'] === 'Хирург Х.')['Доля врача'], 100000);
  assert.equal(own.find((o) => o['Врач'] === 'Терапевт Т.')['Доля врача'], null);

  const bs = runReport(db, { kind: 'by_services', ...args }, KASSA);
  assert.ok(col(bs, 'Доля врача').every((v) => v == null));
  assert.ok(col(bs, 'Остаток клинике').every((v) => v == null), '«Остаток клинике» выдаёт долю вычитанием');
  const sp = runReport(db, { kind: 'surgery_profit', ...args }, KASSA);
  assert.ok(col(sp, 'Гонорар хирурга').every((v) => v == null));
  const spec = runReport(db, { kind: 'by_specialty', ...args }, KASSA);
  assert.ok(col(spec, 'Доля врача').every((v) => v == null));
  assert.ok(!spec.notes.some((n) => /доля врачей \d/.test(n)), 'подытог специальности называет долю врачей');
  // Рефералы: вознаграждение сотруднику-направившему — это его начисление.
  const ref = objects(runReport(db, { kind: 'referrals', ...args }, KASSA));
  assert.equal(ref.length, 1);
  assert.equal(ref[0]['Вознаграждение'], null);
  assert.equal(objects(runReport(db, { kind: 'referrals', ...args }, admin))[0]['Вознаграждение'], 110000);
  const det = runReport(db, { kind: 'referrals_detail', ...args }, KASSA);
  assert.ok(col(det, 'Вознаграждение').every((v) => v == null));
});

test('8: сводка отчётов (reports_overview) — только группе «Выручка и счета»', async () => {
  const { reportsOverview } = await import('./reports.js');
  const db = payClinic();
  assert.ok(reportsOverview(db, { from: FROM, to: TO }, admin));
  assert.ok(reportsOverview(db, { from: FROM, to: TO }, KASSA));
  db.prepare("UPDATE role_permissions SET permissions = json_set(permissions, '$.grants.\"reports.revenue\"', 'none') WHERE role = 'kassa_rev'").run();
  assert.throws(() => reportsOverview(db, { from: FROM, to: TO }, KASSA), (e) => e.status === 403);
});

// ─── 10 ──────────────────────────────────────────────────────────────────────

test('10: сервер называет складываемые колонки — цены, ставки, пациенты и количества склада не складываются', async () => {
  const { summableColumns } = await import('./reports.js');
  const db = clinic();
  const inv = invoice(db, { total: 100000, paid: 100000 });
  item(db, inv, { service: 3, total: 100000 });
  const tr = runReport(db, { kind: 'total_revenue', from: FROM, to: TO }, admin);
  for (const c of ['Сумма', 'Скидка', 'После скидки', 'Налог', 'Доля врача', 'Кол-во']) assert.ok(tr.summable_columns.includes(c), c);
  for (const c of ['Цена', 'Налог %', 'Ставка врача']) assert.ok(!tr.summable_columns.includes(c), c);
  const bd = summableColumns('by_doctors', ['Пациентов', 'Визитов', 'Госпитализаций', 'Услуг', 'Доля за услуги', 'Итого к выплате']);
  assert.deepEqual(bd, ['Услуг', 'Доля за услуги', 'Итого к выплате']);
  assert.deepEqual(summableColumns('procurement', ['Количество', 'Цена за ед.', 'Сумма']), ['Сумма']);
  assert.deepEqual(summableColumns('stock_statement', ['Начало: кол-во', 'Конец: кол-во', 'Средняя себестоимость', 'Конец: сумма']), ['Конец: сумма']);
  assert.deepEqual(summableColumns('stock_expiry', ['Дней до срока', 'Остаток (расчёт)', 'Стоимость']), ['Стоимость']);
  assert.deepEqual(summableColumns('stock_consumption', ['Кол-во', 'Себестоимость ед.', 'Движений', 'Израсходовано на пациентов (себестоимость)']),
    ['Движений', 'Израсходовано на пациентов (себестоимость)']);
  assert.ok(runReport(db, { kind: 'payments', from: FROM, to: TO }, admin).summable_columns.includes('Amount'));
});
