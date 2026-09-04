// 096.test.js — MED_ADMIN_CHARGE_V1: списание и начисление за введённую дозу.
//
// Миграция добавляет три колонки, и весь вопрос теста — что она НЕ СЛОМАЛА
// работающую клинику: назначения и отметки, сделанные до обновления, читаются
// как раньше, у них разумные значения по умолчанию, и ни одна таблица не
// пересобрана. Отдельно проверяется то, ради чего эта миграция вообще
// написана: несписанное можно СОСЧИТАТЬ.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const M096 = '096_treatment_stock.sql';

/** База ровно в том виде, в каком её застаёт 096 на работающей клинике. */
function dbBefore096() {
  const db = openDb(':memory:');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  )`);
  for (const file of fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort()) {
    if (file >= M096) break;
    db.transaction(() => {
      db.exec(fs.readFileSync(path.join(DIR, file), 'utf8'));
      db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(file);
    })();
  }
  return db;
}

function apply096(db) {
  db.transaction(() => {
    db.exec(fs.readFileSync(path.join(DIR, M096), 'utf8'));
    db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(M096);
  })();
}

/** Клиника с уже идущим лечением: назначение и закрытая отметка. */
function running(db) {
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (1,'doc','x','Лечащий','doctor')").run();
  db.prepare("INSERT INTO patients (id, full_name) VALUES (1,'Иванов Иван')").run();
  db.prepare("INSERT INTO wards (id, name, billing_mode, price_per_day) VALUES (1,'Терапия','daily',150000)").run();
  db.prepare("INSERT INTO beds (id, code, ward_id, status) VALUES (1,'K-1',1,'occupied')").run();
  db.prepare("INSERT INTO products (id, name, unit, category) VALUES (1,'Цефтриаксон 1 г','шт','drug')").run();
  db.prepare(`INSERT INTO admissions (id, patient_id, bed_id, ward_id, doctor_id, attending_doctor_id, status)
              VALUES (1,1,1,1,1,1,'active')`).run();
  db.prepare(`INSERT INTO treatment_orders (id, admission_id, name, dose, route, freq_code, slots, starts_on, days, ends_on, stock_item_id)
              VALUES (1,1,'Цефтриаксон','1 г','в/м','3x','[6,14,22]','2026-09-01',5,'2026-09-05',1)`).run();
  db.prepare(`INSERT INTO treatment_administrations (id, order_id, due_date, due_slot, status, given_by)
              VALUES (1,1,'2026-09-01',6,'given',1)`).run();
  return db;
}

const cols = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

test('096 добавляет три колонки и НИЧЕГО не пересобирает', () => {
  const db = dbBefore096();
  running(db);
  const ordersBefore = cols(db, 'treatment_orders');
  const marksBefore = cols(db, 'treatment_administrations');

  apply096(db);

  // Ровно по одной новой колонке там, где ждём, и ни одной пропавшей старой.
  assert.deepEqual(cols(db, 'treatment_orders'), [...ordersBefore, 'stock_qty']);
  assert.deepEqual(cols(db, 'treatment_administrations'), [...marksBefore, 'stock_status', 'stock_note']);

  // Строки, сделанные до обновления, целы и читаются.
  const o = db.prepare('SELECT * FROM treatment_orders WHERE id = 1').get();
  assert.equal(o.name, 'Цефтриаксон');
  assert.equal(o.stock_qty, null, '«не сказано» — значит разбирается доза');
  const m = db.prepare('SELECT * FROM treatment_administrations WHERE id = 1').get();
  assert.equal(m.status, 'given');
  assert.equal(m.stock_status, '', 'старая отметка не притворяется списанной');
  assert.equal(m.stock_note, '');
  db.close();
});

test('096 не трогает деньги: ни invoices, ни триггеров синхронизации', () => {
  const db = dbBefore096();
  running(db);
  const sql = (t) => db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name = ?").get(t).sql;
  const invoicesBefore = sql('invoices');
  const trigBefore = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name").all();

  apply096(db);

  // Шапка 084_sync_journal.sql запрещает и пересборку, и массовый UPDATE
  // таблицы с триггерами синхронизации. Здесь она просто не упомянута.
  assert.equal(sql('invoices'), invoicesBefore);
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name").all(), trigBefore);
  assert.equal(fs.readFileSync(path.join(DIR, M096), 'utf8').includes('UPDATE invoices'), false);
  db.close();
});

test('несписанное можно сосчитать частичным индексом', () => {
  const db = openDb(':memory:');
  migrate(db);
  running(db);
  db.prepare(`INSERT INTO treatment_administrations (id, order_id, due_date, due_slot, status, stock_status, stock_note)
              VALUES (2,1,'2026-09-01',14,'given','skipped','не списано: не удалось определить количество')`).run();
  db.prepare(`INSERT INTO treatment_administrations (id, order_id, due_date, due_slot, status, stock_status)
              VALUES (3,1,'2026-09-01',22,'given','ok')`).run();
  db.prepare(`INSERT INTO treatment_administrations (id, order_id, due_date, due_slot, status, stock_status)
              VALUES (4,1,'2026-09-02',6,'given','short')`).run();

  const n = db.prepare(
    "SELECT COUNT(*) n FROM treatment_administrations WHERE stock_status IN ('skipped','short')").get().n;
  assert.equal(n, 2);

  // Индекс существует и именно частичный — по нему и ходит счётчик.
  const idx = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_treatment_admin_stock_issue'").get();
  assert.ok(idx, 'индекс на месте');
  assert.match(idx.sql, /WHERE stock_status IN \('skipped','short'\)/);
  db.close();
});
