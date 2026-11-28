// SERVICE_REGISTRAR_V1 (2026-11-27) — «Общая выручка»: колонка «Записал услугу».
//
// Владелец: «to total revenue report add one more column to show who registered
// the service». «Регистратор» — автор СЧЁТА; «Записал услугу» — автор строки
// визита (visit_services.created_by). У строки без визита — автор счёта.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { getRpc } from './index.js';

const ADMIN = { id: 1, role: 'admin', extra_roles: [] };
const objects = (r) => r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]])));

function seed() {
  const db = openDb(':memory:'); migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, role, full_name, is_doctor) VALUES (?,?,?,?,?,?)');
  u.run(1, 'adm', 'x', 'admin', 'Админ', 0);
  u.run(2, 'reg', 'x', 'registrar', 'Регистратор Анна', 0);
  u.run(3, 'cash', 'x', 'cashier', 'Кассир Олег', 0);
  u.run(4, 'doc', 'x', 'doctor', 'Врач Иван', 1);
  db.prepare("INSERT INTO patients (id, full_name) VALUES (10, 'Пациент Тест')").run();
  db.prepare("INSERT INTO services (id, name, price) VALUES (20, 'УЗИ', 100000), (21, 'Анализ', 50000)").run();
  db.prepare(`INSERT INTO visits (id, patient_id, doctor_id, visit_date, status, created_by)
              VALUES (30, 10, 4, '2026-11-20', 'arrived', 2)`).run();
  // Счёт выставил кассир — он «Регистратор» отчёта.
  db.prepare(`INSERT INTO invoices (id, invoice_number, visit_id, patient_id, subtotal, total_amount, paid_amount, status, created_by, created_at, paid_at)
              VALUES (40, 'INV-1', 30, 10, 150000, 150000, 150000, 'paid', 3, '2026-11-20T08:00:00Z', '2026-11-20T08:05:00Z')`).run();
  db.prepare(`INSERT INTO invoice_items (id, invoice_id, service_id, description, quantity, unit_price, total)
              VALUES (50, 40, 20, 'УЗИ', 1, 100000, 100000), (51, 40, 21, 'Анализ', 1, 50000, 50000)`).run();
  // УЗИ записала регистратура; у «Анализа» строки визита нет.
  db.prepare(`INSERT INTO visit_services (id, visit_id, service_id, doctor_id, quantity, unit_price, total, status, invoice_item_id, created_by)
              VALUES (60, 30, 20, 4, 1, 100000, 100000, 'completed', 50, 2)`).run();
  return db;
}

test('«Записал услугу» — автор строки визита, а без визита — автор счёта', () => {
  const db = seed();
  try {
    const r = getRpc('run_report')(db, { kind: 'total_revenue', from: '2026-11-01', to: '2026-11-30' }, ADMIN);
    const ci = r.columns.indexOf('Записал услугу');
    assert.ok(ci > 0, 'колонка есть');
    assert.equal(r.columns[ci - 1], 'Регистратор', 'стоит сразу за «Регистратором»');
    const rows = objects(r);
    const us = rows.find((o) => o['Услуга'] === 'УЗИ');
    const lab = rows.find((o) => o['Услуга'] === 'Анализ');
    assert.ok(us && lab, JSON.stringify(rows.map((o) => o['Услуга'])));
    assert.equal(us['Регистратор'], 'Кассир Олег');
    assert.equal(us['Записал услугу'], 'Регистратор Анна');
    assert.equal(lab['Записал услугу'], 'Кассир Олег', 'строки визита нет — услугу в счёт добавил автор счёта');
    assert.equal(rows.length, 2, 'строки счёта не размножились');
  } finally { db.close(); }
});
