// REFUND_ANY_V1 (2026-10-29) — ПОИСК СЧЁТА ЗА ЛЮБОЙ ДЕНЬ НЕ ДЕРЖИТ СЕРВЕР.
//
// better-sqlite3 синхронный: пока считается поиск кассы, ждут все экраны
// клиники. Самая большая касса в истории проекта — 354 тыс. счетов
// (V3120_FIX PERF, cashier.js). Здесь — 300 тыс. счетов на 30 тыс. пациентов
// за 400 дней, и поиск каждым видом строки: номер целиком и хвостом, ФИО,
// номер карты (и строчными), телефон как записан и одними цифрами, редкое имя
// (страница не набирается — проход до конца), строка, которой нет.
//
// Замер на разработческой машине (Windows, 300 тыс. счетов, 30 тыс. пациентов,
// медиана из пяти; ревью кода B1, I-1). Было: любой поиск 60–180 мс — страница
// шла по idx_invoices_created через все счета (BLOOM FILTER ON sel), и номер,
// редкое имя или строка, которой нет, стоили дороже всего (160–180 мс). Стало:
// номер счёта, номер карты, телефон, редкое имя, строка, которой нет, — 4–45
// мс; частая фамилия (четверть пациентов) — 55–75 мс; две буквы, под которые
// подходит почти вся база («ов», «90» — 225–300 тыс. счетов на сортировку), —
// 145–180 мс: их сортировка и проверка документов денег — честная цена такой
// строки. Замер шёл при пустых patient_deposits и patient_discounts, а счета
// здесь без визита: проверку связи с депозитом и продажей карты проходил каждый
// счёт — по индексу пустой таблицы. В настоящей кассе эти таблицы не пусты, но
// счёт визита (почти все счета) эту проверку пропускает (SEARCH_VISIBLE,
// visit_id IS NOT NULL); её проходят только счета без визита — стационар,
// депозит, продажа карты. Граница теста щедрая (1500 мс), в стиле
// cashier-unbilled.perf.test.js; главное правило — план страницы ниже.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { cashierInvoiceSearch, invoiceSearchPageQuery } from './cashier.js';

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

const FOUND = ['INV-A-26-123456', '123456', 'Пациент 1234', 'пациент 29999', 'P-001234', 'p-001234', '90 001 23', '900012345', 'Пациент 12345'];
const NOT_FOUND = ['zzzz', 'Петров'];

test('поиск счёта на ' + INVOICES + ' счетах: каждым видом строки — быстро', () => {
  const db = seedLarge();
  try {
    for (const q of [...FOUND, ...NOT_FOUND]) {
      const t = Date.now();
      const out = cashierInvoiceSearch(db, { q }, cashier);
      const ms = Date.now() - t;
      if (FOUND.includes(q)) assert.ok(out.rows.length > 0, 'по «' + q + '» ничего не нашлось');
      else assert.equal(out.rows.length, 0, 'по «' + q + '» найдено лишнее');
      assert.ok(out.rows.length <= 50, 'страница — не больше 50');
      assert.ok(ms < 1500, 'поиск «' + q + '» шёл ' + ms + ' мс');
    }
    // Ревью кода B1 (I-1) — страницу ведёт найденное, а не лента всех счетов
    // по дате: SQLite не должен идти по idx_invoices_created через все 300 тыс.
    // счетов, сверяя каждый с найденным (BLOOM FILTER ON sel).
    for (const q of [...FOUND, ...NOT_FOUND]) {
      const { sql, params } = invoiceSearchPageQuery(q, 0);
      const plan = db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...params).map((r) => r.detail).join('\n');
      assert.doesNotMatch(plan, /BLOOM FILTER ON sel/, 'план «' + q + '»:\n' + plan);
      assert.doesNotMatch(plan, /SCAN i USING INDEX idx_invoices_created/, 'план «' + q + '»:\n' + plan);
    }
  } finally { db.close(); }
});
