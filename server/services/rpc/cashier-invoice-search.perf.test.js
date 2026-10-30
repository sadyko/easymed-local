// REFUND_ANY_V1 (2026-10-29) — ПОИСК СЧЁТА ЗА ЛЮБОЙ ДЕНЬ НЕ ДЕРЖИТ СЕРВЕР.
//
// better-sqlite3 синхронный: пока считается поиск кассы, ждут все экраны
// клиники. Самая большая касса в истории проекта — 354 тыс. счетов
// (V3120_FIX PERF, cashier.js). Здесь — 300 тыс. счетов на 30 тыс. пациентов
// за 400 дней, и поиск каждым видом строки: номер целиком и хвостом, ФИО,
// номер карты, телефон как записан и одними цифрами, редкое имя (страница не
// набирается — проход до конца). Граница щедрая, в стиле
// cashier-unbilled.perf.test.js: на разработческой машине — десятки
// миллисекунд.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { cashierInvoiceSearch } from './cashier.js';

const PATIENTS = 30000;
const INVOICES = 300000;
const cashier = { id: 9, role: 'cashier' };

function seedLarge() {
  const db = openDb(':memory:');
  migrate(db);
  db.pragma('foreign_keys = OFF');
  db.exec(`
    WITH RECURSIVE n(k) AS (SELECT 1 UNION ALL SELECT k + 1 FROM n WHERE k < ${PATIENTS})
    INSERT INTO patients (id, full_name, mrn, phone) SELECT k, 'Пациент ' || k, 'P-' || printf('%06d', k), '+998 90 ' || printf('%07d', k) FROM n;
    WITH RECURSIVE n(k) AS (SELECT 1 UNION ALL SELECT k + 1 FROM n WHERE k < ${INVOICES})
    INSERT INTO invoices (id, invoice_number, patient_id, subtotal, total_amount, paid_amount, status, created_at, paid_at)
    SELECT k, 'INV-A-26-' || printf('%06d', k), 1 + (k * 7) % ${PATIENTS}, 100000, 100000, 100000, 'paid',
           strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-' || (k % 400) || ' days'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-' || (k % 400) || ' days') FROM n;
    ANALYZE;
  `);
  return db;
}

test('поиск счёта на ' + INVOICES + ' счетах: каждым видом строки — быстро', () => {
  const db = seedLarge();
  try {
    for (const q of ['INV-A-26-123456', '123456', 'Пациент 1234', 'пациент 29999', 'P-001234', '90 001 23', '900012345', 'Пациент 12345']) {
      const t = Date.now();
      const out = cashierInvoiceSearch(db, { q }, cashier);
      const ms = Date.now() - t;
      assert.ok(out.rows.length > 0, 'по «' + q + '» ничего не нашлось');
      assert.ok(out.rows.length <= 50, 'страница — не больше 50');
      assert.ok(ms < 1500, 'поиск «' + q + '» шёл ' + ms + ' мс');
    }
  } finally { db.close(); }
});
