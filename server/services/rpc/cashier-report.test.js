// CASHIER_REPORT_V1 — «Отчёт кассира».
//
// Отчёт про деньги, поэтому проверяется прежде всего арифметика: доход — это
// принятые платежи (а не выставленные счета), возврат уменьшает доход, а итог
// сходится с плоской выгрузкой в Excel.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { cashierReport } from './cashier-report.js';

const RANGE = { from: '2000-01-01', to: '2100-01-01' };

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO users (id,username,password_hash,full_name,role) VALUES (1,'k','x','Кассир Одина','cashier')").run();
  db.prepare("INSERT INTO users (id,username,password_hash,full_name,role) VALUES (2,'d','x','Врач Барно','doctor')").run();
  db.prepare("INSERT INTO patients (id, full_name) VALUES (10,'Алиев Алишер')").run();
  // Филиал с id=1 уже заводит миграция — OR IGNORE, иначе сид падает на UNIQUE.
  db.prepare("INSERT OR IGNORE INTO branches (id, name) VALUES (1,'Главный'),(2,'Филиал')").run();
  db.prepare("INSERT INTO services (id, name, price) VALUES (7,'Консультация', 100000)").run();
  return db;
}

// Счёт с одной услугой и оплатой. Возвращает id счёта.
function invoiceWith(db, { branch = 1, amount = 100000, method = 'cash', paidAt = null } = {}) {
  const v = db.prepare("INSERT INTO visits (patient_id, visit_date) VALUES (10, date('now'))").run().lastInsertRowid;
  db.prepare('INSERT INTO visit_services (visit_id, service_id, doctor_id) VALUES (?,7,2)').run(v);
  const inv = db.prepare(
    `INSERT INTO invoices (invoice_number, visit_id, patient_id, branch_id, total_amount, status)
     VALUES (?,?,10,?,?, 'paid')`).run('INV-' + Math.random().toString(36).slice(2, 8), v, branch, amount).lastInsertRowid;
  db.prepare('INSERT INTO invoice_items (invoice_id, service_id, quantity, unit_price, total) VALUES (?,7,1,?,?)').run(inv, amount, amount);
  db.prepare(
    `INSERT INTO payments (invoice_id, amount, method, cashier_id, paid_at)
     VALUES (?,?,?,1, COALESCE(?, strftime('%Y-%m-%dT%H:%M:%SZ','now')))`).run(inv, amount, method, paidAt);
  return inv;
}

test('доход — это принятые платежи, а не выставленные счета', () => {
  const db = seed();
  invoiceWith(db, { amount: 100000 });
  // Счёт выставлен, но НЕ оплачен: денег в кассе нет, и в доход он не идёт.
  const v = db.prepare("INSERT INTO visits (patient_id, visit_date) VALUES (10, date('now'))").run().lastInsertRowid;
  db.prepare("INSERT INTO invoices (invoice_number, visit_id, patient_id, branch_id, total_amount, status) VALUES ('INV-X',?,10,1,500000,'unpaid')").run(v);

  const r = cashierReport(db, RANGE, {});
  assert.equal(r.kpi.income, 100000, 'неоплаченный счёт деньгами не считается');
  assert.equal(r.income.rows.length, 1);
  db.close();
});

test('возврат уменьшает доход, а не прячется', () => {
  const db = seed();
  const inv = invoiceWith(db, { amount: 300000 });
  // CASHIER_REFUND_V1 — возврат хранится отрицательным платежом.
  db.prepare(`INSERT INTO payments (invoice_id, amount, method, cashier_id, paid_at)
              VALUES (?, -100000, 'cash', 1, strftime('%Y-%m-%dT%H:%M:%SZ','now'))`).run(inv);

  const r = cashierReport(db, RANGE, {});
  assert.equal(r.kpi.income, 200000, 'касса за период = 300 000 − 100 000');
  assert.equal(r.income.rows.length, 2, 'возврат виден строкой, а не молча вычитается');
  db.close();
});

test('расход берётся из движений кассы наружу', () => {
  const db = seed();
  invoiceWith(db, { amount: 500000 });
  const sh = db.prepare("INSERT INTO cash_shifts (cashier_id, branch_id, status) VALUES (1,1,'open')").run().lastInsertRowid;
  db.prepare(`INSERT INTO cash_movements (shift_id, kind, amount, article, note, created_by)
              VALUES (?, 'out', 120000, 'Закупка', 'Бумага для принтера', 1)`).run(sh);
  // Внесение в кассу расходом не является.
  db.prepare(`INSERT INTO cash_movements (shift_id, kind, amount, article, note, created_by)
              VALUES (?, 'in', 999999, 'Размен', 'Разменный фонд', 1)`).run(sh);

  const r = cashierReport(db, RANGE, {});
  assert.equal(r.kpi.expense, 120000);
  assert.equal(r.kpi.net, 380000, 'итог = доход − расход');
  assert.equal(r.expense.rows.length, 1, 'внесение в кассу не расход');
  db.close();
});

test('фильтр по филиалу отбирает и приход, и расход', () => {
  const db = seed();
  invoiceWith(db, { branch: 1, amount: 100000 });
  invoiceWith(db, { branch: 2, amount: 700000 });
  const sh1 = db.prepare("INSERT INTO cash_shifts (cashier_id, branch_id, status) VALUES (1,1,'open')").run().lastInsertRowid;
  const sh2 = db.prepare("INSERT INTO cash_shifts (cashier_id, branch_id, status) VALUES (1,2,'open')").run().lastInsertRowid;
  db.prepare("INSERT INTO cash_movements (shift_id, kind, amount, article, created_by) VALUES (?, 'out', 10000, 'Прочее', 1)").run(sh1);
  db.prepare("INSERT INTO cash_movements (shift_id, kind, amount, article, created_by) VALUES (?, 'out', 50000, 'Прочее', 1)").run(sh2);

  const only1 = cashierReport(db, { ...RANGE, branch_ids: [1] }, {});
  assert.equal(only1.kpi.income, 100000);
  assert.equal(only1.kpi.expense, 10000, 'расход берёт филиал у смены — своего у движения нет');

  // Пустой список = все филиалы: «ничего не выбрано» не должно означать
  // «ничего не показывать».
  const all = cashierReport(db, { ...RANGE, branch_ids: [] }, {});
  assert.equal(all.kpi.income, 800000);
  assert.equal(all.kpi.expense, 60000);
  db.close();
});

test('период отсекает по МЕСТНОЙ дате', () => {
  const db = seed();
  invoiceWith(db, { amount: 100000, paidAt: '2026-08-10T09:00:00Z' });
  invoiceWith(db, { amount: 200000, paidAt: '2026-08-20T09:00:00Z' });

  const r = cashierReport(db, { from: '2026-08-01', to: '2026-08-15' }, {});
  assert.equal(r.kpi.income, 100000);
  assert.equal(r.income.rows.length, 1);
  db.close();
});

test('плоская выгрузка сходится с итогом: расход уходит со знаком минус', () => {
  const db = seed();
  invoiceWith(db, { amount: 400000 });
  const sh = db.prepare("INSERT INTO cash_shifts (cashier_id, branch_id, status) VALUES (1,1,'open')").run().lastInsertRowid;
  db.prepare("INSERT INTO cash_movements (shift_id, kind, amount, article, created_by) VALUES (?, 'out', 150000, 'Инкассация', 1)").run(sh);

  const r = cashierReport(db, RANGE, {});
  const AMOUNT = r.columns.indexOf('Сумма');
  const sum = r.rows.reduce((n, row) => n + (Number(row[AMOUNT]) || 0), 0);
  // Один лист для владельца: приход и расход в одном столбце обязаны
  // складываться в тот же итог, что показан плитками.
  assert.equal(sum, r.kpi.net);
  assert.equal(r.rows.length, 2);
  db.close();
});

test('строка поступления несёт услугу, врача, пациента и кассира', () => {
  const db = seed();
  invoiceWith(db, { amount: 100000, method: 'card' });

  const r = cashierReport(db, RANGE, {});
  const [row] = r.income.rows;
  const col = (name) => row[r.income.columns.indexOf(name)];
  assert.equal(col('Услуга'), 'Консультация');
  assert.equal(col('Врач'), 'Врач Барно');
  assert.equal(col('Пациент'), 'Алиев Алишер');
  assert.equal(col('Способ оплаты'), 'Карта', 'метод переводится, а не показывается как card');
  assert.equal(col('Кассир'), 'Кассир Одина');
  assert.equal(col('Сумма'), 100000);
  db.close();
});

// ---------------------------------------------------------------------------
// BUILDING_REPORTS_V1 — касса считает ВСЕ ЗДАНИЯ клиники.
//
// Раньше отчёт фильтровался по `i.branch_id`, а у приехавшего платежа branch_id
// пустой — «Отчёт кассира» по соседнему зданию отдавал ПУСТО. Теперь здание
// берётся с метки `sync_origin` самого платежа (так выглядит принятая строка).
// moneyTravels() доводит тестовую базу до состояния после миграции переезда
// денег и ничего не делает, когда колонка уже есть.
// ---------------------------------------------------------------------------

function moneyTravels(db) {
  for (const t of ['invoices', 'invoice_items', 'payments']) {
    const has = db.prepare(`PRAGMA table_info(${t})`).all().some((c) => c.name === 'sync_origin');
    if (!has) db.prepare(`ALTER TABLE ${t} ADD COLUMN sync_origin TEXT`).run();
  }
}

function seedTwoBuildings() {
  const db = seed();
  moneyTravels(db);
  // Соседнее здание заводится ИМЕННО как active = 0 — так его заводит приём
  // справочника (branch-sync/catalogue.js).
  db.prepare("INSERT INTO branches (name, letter, active) VALUES ('Чиланзар','B',0)").run();
  invoiceWith(db, { amount: 100000 });                    // своё здание
  const v = db.prepare("INSERT INTO visits (patient_id, visit_date) VALUES (10, date('now'))").run().lastInsertRowid;
  const inv = db.prepare(`INSERT INTO invoices (invoice_number, visit_id, patient_id, total_amount, status, sync_origin)
      VALUES ('B-INV-1',?,10,250000,'paid','B')`).run(v).lastInsertRowid;
  db.prepare(`INSERT INTO payments (invoice_id, amount, method, paid_at, sync_origin)
      VALUES (?,250000,'cash',strftime('%Y-%m-%dT%H:%M:%SZ','now'),'B')`).run(inv);
  return db;
}

test('касса: поступления соседнего здания ВИДНЫ, с разрезом и итогом по клинике', () => {
  const db = seedTwoBuildings();
  const r = cashierReport(db, RANGE, {});
  assert.equal(r.income.columns[0], 'Здание');
  assert.equal(r.kpi.income, 350000, 'итог по клинике = 100 000 + 250 000');
  const b = r.by_building.find((x) => x.key === 'B');
  const own = r.by_building.find((x) => x.own);
  assert.equal(b.income, 250000);
  assert.equal(own.income, 100000);
  assert.equal(own.income + b.income, r.kpi.income);
  const foreign = r.income.rows.find((x) => x[0] === 'Чиланзар');
  assert.ok(foreign, 'приехавший платёж есть в списке');
  assert.equal(foreign[foreign.length - 1], 'Чиланзар',
    'кассир приехавшего платежа неизвестен — строка подписана зданием, а не спрятана');
  assert.ok(r.notes.some((n) => n.includes('Расходы кассы')), 'про расходы сказано, что они только свои');
  db.close();
});

test('касса: выбор одного здания исключает второе', () => {
  const db = seedTwoBuildings();
  const onlyB = cashierReport(db, { ...RANGE, buildings: ['B'] }, {});
  assert.equal(onlyB.kpi.income, 250000);
  assert.equal(onlyB.income.rows.length, 1);
  const onlyOwn = cashierReport(db, { ...RANGE, buildings: ['A'] }, {});
  assert.equal(onlyOwn.kpi.income, 100000);
  db.close();
});

// ---------------------------------------------------------------------------
// CASHIER_NET_SCOPE_V1 — заголовок не смешивает охваты.
//
// Приход ездит между зданиями, расход — нет. Пока итог считался как «весь
// приход минус свой расход», он вычитал расход одного дома из дохода двух —
// число, которое не отвечает ни на один вопрос и тем красивее, чем больше
// соседнее здание. Проверяется ИМЕННО арифметика и подпись охвата.
// ---------------------------------------------------------------------------

test('касса: итог считается по ЭТОМУ зданию, а приход по клинике назван отдельно', () => {
  const db = seedTwoBuildings();
  const sh = db.prepare("INSERT INTO cash_shifts (cashier_id, branch_id, status) VALUES (1,1,'open')").run().lastInsertRowid;
  db.prepare("INSERT INTO cash_movements (shift_id, kind, amount, article, created_by) VALUES (?, 'out', 40000, 'Инкассация', 1)").run(sh);

  const r = cashierReport(db, RANGE, {});
  assert.equal(r.kpi.income, 350000, 'приход по клинике: 100 000 своих + 250 000 приехавших');
  assert.equal(r.kpi.income_own, 100000, 'приход этого здания — половина итога с тем же охватом');
  assert.equal(r.kpi.expense, 40000, 'расход только свой: движения кассы не ездят');
  assert.equal(r.kpi.net, 60000, 'итог = 100 000 − 40 000, обе части из одного дома');
  assert.notEqual(r.kpi.net, r.kpi.income - r.kpi.expense,
    'и это ГЛАВНОЕ: 350 000 − 40 000 = 310 000 — как раз то смешение охватов, которого больше нет');
  assert.equal(r.kpi.net_scope, 'own_building', 'охват итога назван в самих данных, а не только на экране');
  assert.equal(r.kpi.multi_building, true);
  assert.ok(r.notes.some((n) => n.includes('ПО ЭТОМУ ЗДАНИЮ')), 'на экране сказано, что именно посчитано');

  // Разрез по зданиям остаётся вторым ответом: итог КАЖДОГО здания в отдельности.
  const own = r.by_building.find((x) => x.own);
  const b = r.by_building.find((x) => x.key === 'B');
  assert.equal(own.net, 60000);
  assert.equal(b.net, 250000, 'у соседа расхода здесь нет и быть не может — он не ездит');
  assert.equal(own.income + b.income, r.kpi.income, 'приход по клинике = сумма зданий');
  db.close();
});

test('касса: клинике в одном здании итог и подписи остаются прежними', () => {
  const db = seed();
  invoiceWith(db, { amount: 500000 });
  const sh = db.prepare("INSERT INTO cash_shifts (cashier_id, branch_id, status) VALUES (1,1,'open')").run().lastInsertRowid;
  db.prepare("INSERT INTO cash_movements (shift_id, kind, amount, article, created_by) VALUES (?, 'out', 120000, 'Закупка', 1)").run(sh);

  const r = cashierReport(db, RANGE, {});
  assert.equal(r.kpi.multi_building, false, 'две плитки про один и тот же приход читались бы как поломка');
  assert.equal(r.kpi.income_own, r.kpi.income, 'у неё оба охвата — одно и то же число');
  assert.equal(r.kpi.net, r.kpi.income - r.kpi.expense, 'итог тот же, что и был');
  assert.equal(r.kpi.net, 380000);
  assert.equal(r.notes.length, 1, 'объяснять нечего — примечания про охват нет');
  db.close();
});
