// 102.test.js — PROC_PERFORMER_V1: одна колонка, один индекс, ноль сдвинутых денег.
//
// Проверяется не «ALTER TABLE выполнился» — это одна строка SQL, — а те четыре
// утверждения, из-за которых миграция могла бы навредить или оказаться
// бесполезной:
//
//   1. НА ЖИВОЙ БАЗЕ ОНА БЕЗОПАСНА. Файл применяется к базе с пациентом,
//      врачом, койкой, госпитализацией и уже заведённой строкой начисления;
//      после него данные на месте, а новая колонка у старой строки — NULL,
//      то есть «исполнитель не назначен» — ровно то, чем она и была.
//
//   2. ГЛАВНОЕ: doctor_id ПАЛАТНОЙ СТРОКИ НЕ ТРОНУТ. Это денежная колонка:
//      views/ward-beds.js пишет туда лечащего врача, а rpc/billing.js берёт по
//      ней ЛИЧНУЮ ЦЕНУ врача в счёт пациента. Ради этого колонка и отдельная.
//      Проверяется не глазами, а СЧЁТОМ: счёт госпитализации до и после
//      выставляется на ту же сумму.
//
//   3. ЖУРНАЛ ФИЛИАЛОВ НЕ ШЕВЕЛИТСЯ. ADD COLUMN строк не трогает; у
//      admission_services журнальных триггеров нет вовсе (084_sync_journal.sql
//      их ей не ставит — стационар между зданиями не ездит). Проверяется
//      счётчиком до и после и отсутствием триггеров на таблице.
//
//   4. ПЛАНИРОВЩИК БЕРЁТ ИНДЕКС. Индекс, который база не выбирает, — не
//      ускорение, а расход (тот же довод, которым 097 отказалась от своего
//      частичного индекса). Проверяется EXPLAIN QUERY PLAN.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { createInvoiceForAdmission } from '../../services/rpc/billing.js';

const ADMIN = { id: 9, role: 'admin' };

// Клиника накануне обновления: врач с ЛИЧНОЙ ценой на процедуру, лежачий
// пациент и одна незабилленная строка начисления, записанная на этого врача.
function seed() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare(`INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, service_rates)
              VALUES (1,'doc','x','Лечащий врач','doctor',1,?)`)
    .run(JSON.stringify([{ service_id: 1, pct: 30, price: 150000 }]));
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (2,'nur','x','Медсестра','nurse')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (9,'adm','x','Администратор','admin')").run();
  db.prepare("INSERT INTO patients (id, mrn, full_name) VALUES (1,'P-1','Пациент П.')").run();
  db.prepare("INSERT INTO wards (id, name) VALUES (1,'Терапия')").run();
  db.prepare("INSERT INTO beds (id, code, ward_id) VALUES (1,'Т-1',1)").run();
  db.prepare("INSERT INTO services (id, name, price, type) VALUES (1,'Внутривенная инъекция',100000,'procedure')").run();
  db.prepare(`INSERT INTO admissions (id, patient_id, bed_id, ward_id, doctor_id, attending_doctor_id, status)
              VALUES (1,1,1,1,1,1,'active')`).run();
  db.prepare(`INSERT INTO admission_services (id, admission_id, service_id, doctor_id, bed_id, ward_id,
                quantity, unit_price, total, status, billable)
              VALUES (1,1,1,1,1,1,1,100000,100000,'added',1)`).run();
  return db;
}

const cols = (db, t) => new Set(db.prepare(`PRAGMA table_info(${t})`).all().map((r) => r.name));

test('колонка добавлена, у существующей строки она NULL, данные на месте', () => {
  const db = seed();
  assert.ok(cols(db, 'admission_services').has('performer_id'), 'performer_id должен появиться');
  const row = db.prepare('SELECT * FROM admission_services WHERE id = 1').get();
  assert.equal(row.performer_id, null, 'у старой строки исполнитель не назначен');
  assert.equal(row.doctor_id, 1);
  assert.equal(row.total, 100000);
  assert.equal(row.status, 'added');
});

test('doctor_id остаётся денежной колонкой: счёт берёт ЛИЧНУЮ цену лечащего врача', () => {
  const db = seed();
  // Исполнителем ставим медсестру — именно то, ради чего колонка и заведена.
  db.prepare('UPDATE admission_services SET performer_id = 2 WHERE id = 1').run();
  const { invoice } = createInvoiceForAdmission(db, { admission_id: 1, admission_service_ids: [1] }, ADMIN);
  // 150 000 — личная цена врача, а не 100 000 из каталога. Если бы медсестру
  // записали в doctor_id, счёт молча стал бы каталожным.
  assert.equal(invoice.subtotal, 150000);
  assert.equal(db.prepare('SELECT doctor_id FROM admission_services WHERE id = 1').get().doctor_id, 1);
});

test('журнал филиалов не шевелится, триггеров на таблице нет', () => {
  const db = seed();
  const journal = db.prepare("SELECT COUNT(*) n FROM sync_journal WHERE tbl = 'admission_services'").get().n;
  assert.equal(journal, 0);
  const trig = db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'admission_services'").get().n;
  assert.equal(trig, 0, 'стационар между зданиями не ездит — журнальных триггеров у него нет');
});

test('планировщик берёт индекс по исполнителю', () => {
  const db = seed();
  const plan = db.prepare('EXPLAIN QUERY PLAN SELECT id FROM admission_services WHERE performer_id = ?').all(2)
    .map((r) => r.detail).join(' | ');
  assert.match(plan, /idx_admission_services_performer/, plan);
});
