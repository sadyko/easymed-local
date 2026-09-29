// REFBILL_REVIEW_V1 (2026-09-29) — ревью REFERRAL_BILL_V1, M2: «ЖДУТ СЧЁТА»
// НЕ ДЕРЖИТ СЕРВЕР.
//
// cashier_unbilled считал сумму каждой строки через lineUnitPrice, а тот на
// каждую строку спрашивал свою цену врача отдельным запросом по json_each
// всей его карточки ставок (doctorPriceFor). Ревью на объёме клиники: SQL —
// 132 мс, а целиком — 0,6–2,7 с на каждую перерисовку кассы, и
// better-sqlite3 синхронный: всё это время стоит весь сервер.
//
// Теперь свои цены врачей выборки читаются ОДНИМ запросом (doctorPriceLookup
// — тот же отбор записи, что у doctorPriceFor), консультации — один раз на
// вид приёма и врача. Здесь — клиника, где «Ждут счёта» большой: 40 врачей с
// карточками на 300 услуг, 18 000 невыставленных строк за последние 30 дней.
// Проверяется и число подготовленных запросов (не растёт со строками), и
// время — со щедрой границей, в стиле reports.scale.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { cashierUnbilled } from './cashier.js';

const DOCTORS = 40;
const SERVICES = 300;
const DAYS = 30;          // окно «Ждут счёта» — сегодня и 30 дней назад
const VISITS_PER_DAY = 300;
const LINES_PER_VISIT = 2;
const admin = { id: 1, role: 'admin' };

function seedLarge() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, role, full_name) VALUES (1, 'adm', 'x', 'admin', 'Админ')").run();
  db.exec(`
    WITH RECURSIVE n(k) AS (SELECT 1 UNION ALL SELECT k + 1 FROM n WHERE k < ${SERVICES})
    INSERT INTO services (id, name, price, type) SELECT k, 'Услуга ' || k, 50000 + k * 100, CASE WHEN k % 3 = 0 THEN 'consultation' ELSE 'lab' END FROM n;
  `);
  // Карточка ставок врача — на все 300 услуг; своя цена — у каждой четвёртой.
  const rates = [];
  for (let s = 1; s <= SERVICES; s++) rates.push(s % 4 === 0 ? { service_id: s, pct: 20, price: 90000 } : { service_id: s, pct: 20 });
  const insDoc = db.prepare("INSERT INTO users (id, username, password_hash, role, full_name, is_doctor, service_rates) VALUES (?, ?, 'x', 'doctor', ?, 1, ?)");
  for (let d = 0; d < DOCTORS; d++) insDoc.run(100 + d, 'doc' + d, 'Врач ' + d, JSON.stringify(rates));
  db.exec(`
    WITH RECURSIVE n(k) AS (SELECT 1 UNION ALL SELECT k + 1 FROM n WHERE k < 5000)
    INSERT INTO patients (id, full_name) SELECT k, 'Пациент ' || k FROM n;
    WITH RECURSIVE n(k) AS (SELECT 0 UNION ALL SELECT k + 1 FROM n WHERE k < ${DAYS * VISITS_PER_DAY - 1})
    INSERT INTO visits (id, patient_id, visit_date, status, created_by)
    SELECT k + 1, 1 + (k * 7) % 5000,
           strftime('%Y-%m-%dT%H:%M:%SZ', date('now', 'localtime', '-' || (k / ${VISITS_PER_DAY}) || ' days') || ' 12:00:00', 'utc'),
           'scheduled', 1 FROM n;
    WITH RECURSIVE n(k) AS (SELECT 0 UNION ALL SELECT k + 1 FROM n WHERE k < ${DAYS * VISITS_PER_DAY * LINES_PER_VISIT - 1})
    INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, created_by)
    SELECT 1 + k / ${LINES_PER_VISIT}, 1 + (k * 13) % ${SERVICES}, 100 + (k * 11) % ${DOCTORS}, 1, 1, 1, 'added', 1 FROM n;
  `);
  db.exec('ANALYZE');
  return db;
}

test('«Ждут счёта» на ' + DAYS * VISITS_PER_DAY * LINES_PER_VISIT + ' невыставленных строках: запросов не больше, чем при десяти, и быстро', () => {
  const db = seedLarge();
  try {
    // Число подготовленных запросов за вызов не зависит от числа строк: своя
    // цена врача — не запрос на строку.
    const prepare = db.prepare.bind(db);
    let prepared = 0;
    db.prepare = (sql) => { prepared++; return prepare(sql); };
    const t = Date.now();
    const out = cashierUnbilled(db, {}, admin);
    const ms = Date.now() - t;
    db.prepare = prepare;
    assert.equal(out.totals.n, DAYS * VISITS_PER_DAY, 'все визиты окна ждут счёта');
    assert.ok(prepared < 60, 'запросов на один вызов: ' + prepared + ' — своя цена врача снова спрашивается на каждую строку');
    // Щедрая граница: на разработческой машине — доли секунды; прежний расчёт
    // здесь шёл секундами.
    assert.ok(ms < 2500, '«Ждут счёта» считались ' + ms + ' мс');
  } finally { db.close(); }
});
