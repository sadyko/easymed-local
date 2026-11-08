// REFERRAL_SERVICE_RATES_V1 (мигр. 273) — особая ставка источника за ОТДЕЛЬНУЮ
// услугу в настоящем отчёте: строка по этой услуге платит по ней, остальные —
// по категории, а сводка называет такую ставку своим именем. Считаются чужие
// деньги, поэтому проверяется через те же RPC, что и касса: счёт, оплата, отчёт.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { runReport } from './reports.js';
import { createInvoiceForVisit, recordPayment } from './billing.js';
import { today } from '../domain/day.js';

const admin = { id: 9, role: 'admin' };
const objects = (r) => r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]])));
const lastDay = (m) => m + '-' + String(new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).getUTCDate()).padStart(2, '0');

// Категория «Внешние» 10 %. Партнёр П. — по категории, но за УЗИ (услуга 2)
// особые 25 %. Партнёр Т. — тоже по категории, особая ставка за УЗИ фиксом.
function clinic() {
  const db = openDb(':memory:');
  migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, role, full_name, is_doctor) VALUES (?,?,?,?,?,?)');
  u.run(1, 'doc', 'x', 'doctor', 'Доктор Д.', 1);
  u.run(9, 'adm', 'x', 'admin', 'Администратор', 0);
  const catId = db.prepare("INSERT INTO referral_source_categories (name, standard_percent) VALUES ('Внешние', 10)").run().lastInsertRowid;
  const srcP = db.prepare("INSERT INTO referral_sources (name, category_id, reward_mode, service_rates) VALUES ('Партнёр П.', ?, 'category', ?)")
    .run(catId, JSON.stringify([{ service_id: 2, unit: 'pct', value: 25 }])).lastInsertRowid;
  const srcT = db.prepare("INSERT INTO referral_sources (name, category_id, reward_mode, service_rates) VALUES ('Партнёр Т.', ?, 'category', ?)")
    .run(catId, JSON.stringify([{ service_id: 2, unit: 'fix', value: 70000 }])).lastInsertRowid;
  db.prepare("INSERT INTO patients (id, mrn, full_name, referral_source_id) VALUES (1,'P-1','Пациент П.', ?)").run(srcP);
  db.prepare("INSERT INTO patients (id, mrn, full_name, referral_source_id) VALUES (2,'P-2','Пациент Т.', ?)").run(srcT);
  db.prepare("INSERT INTO services (id, name, price, tax_rate, type) VALUES (1,'Приём',100000,0,'consultation')").run();
  db.prepare("INSERT INTO services (id, name, price, tax_rate, type) VALUES (2,'УЗИ',200000,0,'imaging')").run();
  const cur = today(db).slice(0, 7);
  const range = { from: cur + '-01', to: lastDay(cur) };
  let seq = 0;
  const line = ({ patient = 1, service = 1 } = {}) => {
    const id = ++seq;
    const price = service === 1 ? 100000 : 200000;
    db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (?,?,?,'scheduled')").run(id, patient, cur + '-05T09:00:00Z');
    db.prepare(`INSERT INTO visit_services (id, visit_id, service_id, doctor_id, quantity, unit_price, total, status)
                VALUES (?,?,?,1,1,?,?,'completed')`).run(id, id, service, price, price);
    return id;
  };
  const billAndPay = (id) => {
    const inv = createInvoiceForVisit(db, { visit_id: id, visit_service_ids: [id] }, admin).invoice;
    recordPayment(db, { invoice_id: inv.id, amount: inv.total_amount, method: 'cash' }, admin);
    return inv;
  };
  return { db, range, line, billAndPay };
}

test('особая ставка услуги: строка по ней — по особой, остальные — по категории; сводка суммирует', () => {
  const c = clinic();
  c.billAndPay(c.line({ patient: 1, service: 1 }));   // Приём 100 000 → 10 % категории = 10 000
  c.billAndPay(c.line({ patient: 1, service: 2 }));   // УЗИ 200 000 → особые 25 % = 50 000
  const det = objects(runReport(c.db, { kind: 'referrals_detail', ...c.range }, admin));
  const uzi = det.find((o) => o['Услуга'] === 'УЗИ');
  const pri = det.find((o) => o['Услуга'] === 'Приём');
  assert.ok(uzi && pri, 'обе строки пришли по направлению: ' + JSON.stringify(det.map((o) => o['Услуга'])));
  assert.equal(uzi['Вознаграждение'], 50000);
  assert.equal(uzi['Ставка'], '25 %');
  assert.equal(pri['Вознаграждение'], 10000);
  assert.equal(pri['Ставка'], '10 %');
  const sum = objects(runReport(c.db, { kind: 'referrals', ...c.range }, admin)).find((o) => o['Источник'] === 'Партнёр П.');
  assert.ok(sum, 'партнёр в сводке');
  assert.equal(sum['Вознаграждение'], 60000);
});

test('особая ставка услуги: фикс за услугу; «Режим ставок» в сводке — «Особая (услуга)»', () => {
  const c = clinic();
  c.billAndPay(c.line({ patient: 2, service: 2 }));   // УЗИ → фикс 70 000, не 10 % от 200 000
  const det = objects(runReport(c.db, { kind: 'referrals_detail', ...c.range }, admin));
  const uzi = det.find((o) => o['Услуга'] === 'УЗИ');
  assert.ok(uzi, 'строка пришла по направлению');
  assert.equal(uzi['Вознаграждение'], 70000);
  assert.match(String(uzi['Ставка']), /^фикс /);
  const sum = objects(runReport(c.db, { kind: 'referrals', ...c.range }, admin)).find((o) => o['Источник'] === 'Партнёр Т.');
  assert.ok(sum, 'партнёр в сводке');
  assert.equal(sum['Режим ставок'], 'Особая (услуга)');
  assert.equal(sum['Вознаграждение'], 70000);
});

test('особая ставка услуги: у партнёра без особых ставок ничего не меняется', () => {
  const c = clinic();
  c.db.prepare("UPDATE referral_sources SET service_rates = '' WHERE name = 'Партнёр П.'").run();
  c.billAndPay(c.line({ patient: 1, service: 2 }));   // УЗИ → 10 % категории = 20 000
  const det = objects(runReport(c.db, { kind: 'referrals_detail', ...c.range }, admin));
  const uzi = det.find((o) => o['Услуга'] === 'УЗИ');
  assert.equal(uzi['Вознаграждение'], 20000);
  const sum = objects(runReport(c.db, { kind: 'referrals', ...c.range }, admin)).find((o) => o['Источник'] === 'Партнёр П.');
  assert.equal(sum['Режим ставок'], 'По категории');
});
