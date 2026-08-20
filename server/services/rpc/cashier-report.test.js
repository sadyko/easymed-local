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
