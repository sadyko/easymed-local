// INPATIENT_SHARE_V1, ревью C1 — стационарная доля на объёме клиники.
//
// Проверка «у строки счёта нет амбулаторного врача» была коррелированным
// NOT EXISTS по неиндексированной visit_services.invoice_item_id: полный
// проход таблицы на КАЖДУЮ строку стационара. 27 тысяч строк — 11 с, 51 тысяча
// — 39 с; кабинет врача звал это при каждом открытии, а better-sqlite3
// синхронный — стояла вся клиника. Здесь 20 тысяч строк стационара и 20 тысяч
// строк визитов; прежний запрос на таком объёме шёл десятки секунд.
//
// Проверяется и БЕЗ индекса миграции 149: форма запроса (сгруппированный
// LEFT JOIN) сама не должна быть квадратичной.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { doctorInpatientShare, doctorPaySummary, runReport } from './reports.js';

const N = 20000;
const admin = { id: 9, role: 'admin' };

function seedLarge() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare(`INSERT INTO users (id, username, password_hash, role, full_name, is_doctor, service_rates)
              VALUES (2,'surg','x','doctor','Хирургов',1,?)`).run(JSON.stringify([{ service_id: 1, pct: 10, inpatient_pct: 20 }]));
  db.prepare("INSERT INTO patients (id, mrn, full_name) VALUES (1,'P-1','Пациент')").run();
  db.prepare("INSERT INTO services (id, name, price, tax_rate) VALUES (1,'Перевязка',1000,0)").run();
  db.prepare("INSERT INTO admissions (id, admission_no, patient_id, doctor_id, status) VALUES (1,'A-1',1,2,'active')").run();
  db.prepare("INSERT INTO visits (id, patient_id, visit_date) VALUES (1,1,'2026-08-05T09:00:00Z')").run();
  db.prepare(`INSERT INTO invoices (id, invoice_number, patient_id, admission_id, subtotal, discount_amount, total_amount, paid_amount, status, created_at)
              VALUES (1,'INV-1',1,1,?,0,?,?,'paid','2026-08-06T10:00:00Z')`).run(2 * N * 1000, 2 * N * 1000, 2 * N * 1000);
  db.exec(`
    WITH RECURSIVE n(k) AS (SELECT 1 UNION ALL SELECT k + 1 FROM n WHERE k < ${2 * N})
    INSERT INTO invoice_items (id, invoice_id, service_id, description, quantity, unit_price, total)
    SELECT k, 1, 1, 'Перевязка', 1, 1000, 1000 FROM n;
    WITH RECURSIVE n(k) AS (SELECT 1 UNION ALL SELECT k + 1 FROM n WHERE k < ${N})
    -- PAY_BASIS_PERFORMED_V1 — строки ВЫПОЛНЕНЫ (performed_at): доля платится
    -- за выполненное, и нагрузка проверяется на строках, которые считаются.
    INSERT INTO admission_services (admission_id, service_id, doctor_id, performer_id, quantity, unit_price, total, status, billable, invoice_item_id, performed_at)
    SELECT 1, 1, 2, 2, 1, 1000, 1000, 'added', 1, k, '2026-08-06T09:00:00Z' FROM n;
    WITH RECURSIVE n(k) AS (SELECT 1 UNION ALL SELECT k + 1 FROM n WHERE k < ${N})
    INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, invoice_item_id)
    SELECT 1, 1, 2, 1, 1000, 1000, 'completed', ${N} + k FROM n;
  `);
  return db;
}

for (const withIndex of [true, false]) {
  test('стационарная доля на ' + N + ' строках — быстро' + (withIndex ? '' : ' (и без индекса 149)'), () => {
    const db = seedLarge();
    try {
      if (!withIndex) db.exec('DROP INDEX idx_visit_services_invoice_item');
      const t = Date.now();
      const r = doctorInpatientShare(db, { doctor_id: 2, from: '2026-08-01', to: '2026-08-31' }, admin);
      const ms = Date.now() - t;
      assert.equal(r.count, N);
      assert.equal(r.fee, N * 200);   // 20 % от 1 000 на каждой строке
      // Щедрая граница: на разработческой машине — доли секунды; прежний
      // запрос здесь шёл десятки секунд.
      assert.ok(ms < 5000, 'стационарная доля считалась ' + ms + ' мс');
      const t2 = Date.now();
      runReport(db, { kind: 'inpatient_share', from: '2026-08-01', to: '2026-08-31' }, admin);
      assert.ok(Date.now() - t2 < 5000, 'отчёт считался ' + (Date.now() - t2) + ' мс');
      // PAY_BASIS_PERFORMED_V1 — выплата по выполненному читает строки визитов
      // и стационара напрямую; ни одна из дорог не должна стать квадратичной.
      for (const [name, fn] of [
        ['зарплаты врачей', () => runReport(db, { kind: 'doctor_salaries', from: '2026-08-01', to: '2026-08-31' }, admin)],
        ['по врачам', () => runReport(db, { kind: 'by_doctors', from: '2026-08-01', to: '2026-08-31' }, admin)],
        ['кабинет: doctor_pay_summary', () => doctorPaySummary(db, { doctor_id: 2, from: '2026-08-01', to: '2026-08-31' }, admin)],
      ]) {
        const t3 = Date.now();
        const out = fn();
        const took = Date.now() - t3;
        assert.ok(took < 5000, name + ' считались ' + took + ' мс');
        if (out.outpatient) {
          assert.equal(out.outpatient.count, N);
          assert.equal(out.inpatient.count, N);
          assert.equal(out.outpatient.fee, N * 100);   // 10 % от 1 000
        }
      }
    } finally { db.close(); }
  });
}
