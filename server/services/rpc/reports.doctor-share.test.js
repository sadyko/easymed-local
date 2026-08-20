// DOCTOR_SHARE_AFTER_TAX_V1 — порядок расчёта доли врача, зафиксированный
// клиникой: 100% оплаты − скидка → минус налог → и только потом процент врача.
//
// Прежние тесты этого не ловили: у их услуг tax_rate = 0, поэтому «до налога» и
// «после налога» давали одно и то же число. Здесь ставка НЕНУЛЕВАЯ (6%, как у
// клиники), так что любой возврат к расчёту от суммы до налога роняет тест.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { runReport } from './reports.js';

const user = { id: 1, role: 'admin' };
const FROM = '2000-01-01';
const TO   = '2100-01-01';

// Один врач (30%), одна услуга 100 000 с налогом 6%, счёт оплачен.
// discount — сумма скидки на счёт (0, если не передана).
function seed({ price = 100000, taxRate = 6, pct = 30, discount = 0, fix = null, qty = 1 } = {}) {
  const db = openDb(':memory:');
  migrate(db);
  const rates = JSON.stringify([{ service_id: 1, pct, ...(fix == null ? {} : { fix }) }]);
  db.prepare(`INSERT INTO users (id, username, password_hash, role, full_name, service_rates)
              VALUES (1,'doc','x','doctor','Доктор Д.', ?)`).run(rates);
  db.prepare("INSERT INTO patients (id, mrn, full_name) VALUES (1,'P-1','Пациент')").run();
  db.prepare("INSERT INTO visits (id, patient_id, visit_date) VALUES (1,1,strftime('%Y-%m-%dT%H:%M:%SZ','now'))").run();
  db.prepare('INSERT INTO services (id, name, price, tax_rate) VALUES (1,?,?,?)').run('Приём', price, taxRate);
  db.prepare(`INSERT INTO visit_services (id, visit_id, service_id, doctor_id, quantity, unit_price, total, status)
              VALUES (1,1,1,1,?,?,?,'added')`).run(qty, price, price * qty);
  const subtotal = price * qty;
  db.prepare(`INSERT INTO invoices (id, invoice_number, visit_id, patient_id, subtotal, discount_amount, total_amount, paid_amount, status, created_at)
              VALUES (1,'INV-1',1,1,?,?,?,?, 'paid', strftime('%Y-%m-%dT%H:%M:%SZ','now'))`)
    .run(subtotal, discount, subtotal - discount, subtotal - discount);
  db.prepare(`INSERT INTO invoice_items (id, invoice_id, service_id, description, quantity, unit_price, total)
              VALUES (1,1,1,'Приём',?,?,?)`).run(qty, price, subtotal);
  db.prepare('UPDATE visit_services SET invoice_item_id = 1 WHERE id = 1').run();
  return db;
}

const fee = (db) => {
  const r = runReport(db, { kind: 'doctor_salaries', from: FROM, to: TO }, user);
  return r.rows[0][r.columns.indexOf('Доля врача (гонорар)')];
};

test('доля врача = (сумма − налог) × процент', () => {
  // 100 000 − 6% = 94 000;  30% = 28 200.   (до фикса было 30 000)
  assert.equal(fee(seed()), 28200);
});

test('скидка вычитается ДО налога, налог — до процента', () => {
  // база 100 000 − 20 000 = 80 000;  −6% = 75 200;  30% = 22 560.
  assert.equal(fee(seed({ discount: 20000 })), 22560);
});

test('нулевая ставка налога — процент от всей суммы (как раньше)', () => {
  assert.equal(fee(seed({ taxRate: 0 })), 30000);
});

test('фиксированная ставка налогом не режется и умножается на количество', () => {
  // fix = 15 000 за единицу × 2 = 30 000, независимо от налога и процента.
  assert.equal(fee(seed({ fix: 15000, qty: 2 })), 30000);
});

test('отчёт «Общая выручка» показывает ту же долю, что и зарплатный', () => {
  const db = seed();
  const rev = runReport(db, { kind: 'total_revenue', from: FROM, to: TO }, user);
  const share = rev.rows[0][rev.columns.indexOf('Доля врача')];
  const tax = rev.rows[0][rev.columns.indexOf('Налог')];
  assert.equal(tax, 6000);
  assert.equal(share, 28200);
  // Два отчёта не должны расходиться: это одна и та же выплата.
  assert.equal(share, fee(db));
});

test('клиника не платит долю с денег, ушедших в налог', () => {
  // Инвариант: доля + налог + остаток клиники = вся сумма, и доля НЕ больше,
  // чем процент от посленалоговой базы.
  const db = seed();
  const rev = runReport(db, { kind: 'total_revenue', from: FROM, to: TO }, user);
  const c = rev.columns, row = rev.rows[0];
  const after = row[c.indexOf('После скидки')];
  const tax = row[c.indexOf('Налог')];
  const share = row[c.indexOf('Доля врача')];
  assert.ok(share <= (after - tax) * 0.30 + 0.01, 'доля не превышает % от посленалоговой базы');
  assert.equal(Math.round(after - tax - share), 65800);   // остаётся клинике
});
