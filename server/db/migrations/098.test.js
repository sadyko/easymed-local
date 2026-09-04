// 098.test.js — ИНДЕКС `invoices(admission_id)`, ОБЪЯВЛЕННЫЙ ДВАЖДЫ.
//
// Проверяется не «индекс существует» (это одна строка SQL, ей тест не нужен), а
// ровно те три утверждения, ради которых он написан в двух файлах:
//
//   1. НА ЧИСТОЙ УСТАНОВКЕ он есть — и его создаёт 091, ДО пересборки. Это и
//      есть весь смысл первого объявления: `DROP TABLE admissions` при
//      foreign_keys=ON проверяет `invoices` на каждую удаляемую строку, и без
//      индекса это полный перебор (замер в шапке 091: 8 000 госпитализаций /
//      250 000 счетов — 447 секунд, семь с половиной минут без клиники).
//      Порядок проверяется ПОРЯДКОМ ОПЕРАТОРОВ В ФАЙЛЕ, а не секундомером:
//      «быстро» на пустой тестовой базе не измеряется, а «CREATE INDEX стоит
//      выше DROP TABLE» — измеряется точно и не зависит от машины.
//
//   2. НА УЖЕ ОБНОВЛЁННОЙ МАШИНЕ его добавляет 098. Это второе объявление:
//      091 записана в schema_migrations и второй раз не запустится НИКОГДА,
//      поэтому правка внутри неё до таких баз не доедет.
//
//   3. ПЛАНИРОВЩИК ЕГО БЕРЁТ. Индекс, который база не выбирает, — не
//      ускорение, а расход (тот же довод, которым 097 отказалась от своего
//      частичного индекса). Оба запроса admissionBalance проверяются
//      EXPLAIN QUERY PLAN: до — SCAN, после — SEARCH … USING INDEX.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const M091 = '091_inpatient_workflow.sql';
const M098 = '098_invoices_admission_index.sql';
const INDEX = 'idx_invoices_admission';

// Оба запроса, которыми admissionBalance (rpc/inpatient.js) считает долг
// госпитализации. Их зовёт admission_discharge_queue ПО КАЖДОЙ СТРОКЕ очереди.
const BALANCE_QUERIES = [
  "SELECT COALESCE(SUM(total_amount),0) t, COALESCE(SUM(paid_amount),0) p, COUNT(*) n"
  + " FROM invoices WHERE admission_id = 1 AND status NOT IN ('void','refunded')",
  "SELECT COUNT(*) n FROM invoices WHERE admission_id = 1 AND status IN ('void','refunded')",
];

const plan = (db, sql) => db.prepare('EXPLAIN QUERY PLAN ' + sql).all().map((r) => r.detail).join(' | ');
const indexNames = (db) => db.prepare(
  "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='invoices'").all().map((r) => r.name);

/** База ровно в том виде, в каком её застаёт файл `upTo` (сам файл НЕ применён). */
function dbBefore(upTo) {
  const db = openDb(':memory:');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  )`);
  for (const file of fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort()) {
    if (file >= upTo) break;
    const sql = fs.readFileSync(path.join(DIR, file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(file);
    })();
  }
  return db;
}

function applyFile(db, file) {
  const sql = fs.readFileSync(path.join(DIR, file), 'utf8');
  db.transaction(() => {
    db.exec(sql);
    db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(file);
  })();
}

test('098: на чистой установке индекс есть', () => {
  const db = openDb(':memory:');
  migrate(db);
  assert.ok(indexNames(db).includes(INDEX), 'после полной миграции индекса нет');
  db.close();
});

// ГЛАВНОЕ УТВЕРЖДЕНИЕ ПРО СКОРОСТЬ, И ОНО НЕ СЕКУНДОМЕР.
//
// «091 на заполненной базе выполняется быстро» нельзя проверить временем: на
// тестовой базе из четырёх строк быстро всё, а завести 250 000 счетов, чтобы
// увидеть 447 секунд, значит написать тест, который идёт семь минут и падает по
// таймауту у того, кто его чинит. Проверяется ПРИЧИНА, а не следствие: индекс
// создаётся РАНЬШЕ, чем выполняется DROP TABLE, ради которого он и нужен.
test('091: CREATE INDEX стоит ВЫШЕ пересборки — иначе он бесполезен именно там, где нужен', () => {
  const sql = fs.readFileSync(path.join(DIR, M091), 'utf8');
  // Из текста убираются комментарии: слова «DROP TABLE admissions» встречаются
  // в шапке миграции, и без этого тест сравнивал бы позиции рассказа о коде.
  const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

  const idxAt = code.indexOf(`CREATE INDEX IF NOT EXISTS ${INDEX}`);
  const dropAt = code.indexOf('DROP TABLE admissions');
  assert.ok(idxAt >= 0, '091 обязана создавать индекс сама — иначе каждая новая установка ждёт минуты');
  assert.ok(dropAt >= 0, 'в 091 не нашлось пересборки — тест устарел вместе с миграцией');
  assert.ok(idxAt < dropAt,
    'индекс создаётся ПОСЛЕ DROP TABLE: FK-проверка при удалении пройдёт полным перебором invoices');
});

test('091: индекс появляется на живой базе ДО пересборки, и пересборка его не уносит', () => {
  const db = dbBefore(M091);
  assert.ok(!indexNames(db).includes(INDEX), 'до 091 индекса быть не должно — иначе тест ничего не проверяет');

  // Клиника накануне обновления: госпитализация и счёт, который на неё смотрит.
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (1,'u','x','admin')").run();
  db.prepare("INSERT INTO patients (id, full_name) VALUES (1,'Иванов')").run();
  db.prepare(`INSERT INTO admissions (id, patient_id, status, created_by, admitted_at)
              VALUES (1, 1, 'active', 1, '2026-08-01T08:00:00Z')`).run();
  db.prepare(`INSERT INTO invoices (id, invoice_number, patient_id, admission_id, subtotal, total_amount, status)
              VALUES (1, 'INV-1', 1, 1, 100, 100, 'unpaid')`).run();

  applyFile(db, M091);

  assert.ok(indexNames(db).includes(INDEX), 'после 091 индекса нет');
  // Пересборка касалась admissions, а не invoices: счёт остался на месте и на
  // своей госпитализации.
  assert.equal(db.prepare('SELECT admission_id a FROM invoices WHERE id=1').get().a, 1);
  db.close();
});

// ВТОРОЕ ОБЪЯВЛЕНИЕ — РАДИ ЭТОГО СЛУЧАЯ. Машина, где 091 уже применена: правка
// внутри неё туда не доедет никогда, потому что migrate() её не перезапустит.
test('098: машина, уже принявшая 091 без индекса, получает его именно из 098', () => {
  const db = dbBefore(M098);
  // Ровно та база: 091 применена, индекса нет (091 старой редакции его не
  // создавала). Воспроизводим это состояние честно — удалением.
  db.exec(`DROP INDEX IF EXISTS ${INDEX}`);
  assert.ok(!indexNames(db).includes(INDEX));
  assert.ok(db.prepare('SELECT 1 FROM schema_migrations WHERE name = ?').get(M091),
    '091 обязана быть уже записанной — иначе это не тот случай');

  applyFile(db, M098);

  assert.ok(indexNames(db).includes(INDEX), '098 не создала индекс на уже обновлённой машине');
  db.close();
});

test('098: повторный прогон миграций ничего не ломает (IF NOT EXISTS, два объявления)', () => {
  const db = openDb(':memory:');
  migrate(db);
  migrate(db);   // обе миграции уже записаны — не применяются заново
  assert.equal(indexNames(db).filter((n) => n === INDEX).length, 1, 'индекс должен быть ровно один');
  // И прямое повторное применение файла тоже безвредно — это и есть смысл
  // IF NOT EXISTS при двух объявлениях одного индекса.
  db.exec(fs.readFileSync(path.join(DIR, M098), 'utf8'));
  assert.equal(indexNames(db).filter((n) => n === INDEX).length, 1);
  db.close();
});

test('098: планировщик БЕРЁТ индекс — оба запроса долга перестают читать всю таблицу счетов', () => {
  const db = openDb(':memory:');
  migrate(db);

  // «После»: с индексом, как в рабочей базе.
  for (const sql of BALANCE_QUERIES) {
    const after = plan(db, sql);
    assert.match(after, new RegExp(`SEARCH invoices USING (COVERING )?INDEX ${INDEX}`),
      'с индексом запрос долга обязан идти поиском, а не перебором: ' + after);
  }

  // «До»: тот же запрос без индекса — полный перебор. Сравнение обязательно:
  // без него тест не отличил бы «индекс работает» от «SQLite и так быстра».
  db.exec(`DROP INDEX ${INDEX}`);
  for (const sql of BALANCE_QUERIES) {
    assert.match(plan(db, sql), /SCAN invoices/,
      'без индекса эти запросы читают всю таблицу счетов — именно это и чинится');
  }
  db.close();
});
