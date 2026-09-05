// 099.test.js — CALENDAR_BOOKING_V1: три колонки, один индекс, ноль строк в
// журнале филиалов.
//
// Проверяется не «ALTER TABLE выполнился» — это одна строка SQL, ей тест не
// нужен, — а ровно те четыре утверждения, из-за которых миграция могла бы
// навредить или оказаться бесполезной:
//
//   1. НА ЖИВОЙ БАЗЕ ОНА БЕЗОПАСНА. Файл применяется к базе с пациентом,
//      врачом, кабинетом и приёмом; после него данные на месте, а НОВЫЕ
//      КОЛОНКИ У СТАРЫХ СТРОК — NULL (visits) и '' (rooms). Пустая строка у
//      rooms.working_hours и есть обещание «существующий кабинет работает как
//      работал»: движок слотов читает '' как «часов не задано» и берёт часы
//      клиники.
//
//   2. ЖУРНАЛ ФИЛИАЛОВ НЕ ШЕВЕЛИТСЯ. Это главное утверждение файла. `visits` и
//      `rooms` несут триггеры 084_sync_journal.sql, и шапка той миграции
//      говорит прямо: массовый UPDATE или пересборка такой таблицы — сетевое
//      событие, каждая тронутая строка уедет соседям под свежими метками и
//      перебьёт там чужие правки. ADD COLUMN строк не трогает, поэтому
//      sync_journal обязан остаться ровно таким, каким был. Проверяется
//      СЧЁТЧИКОМ ДО И ПОСЛЕ, а не глазами.
//
//   3. НОВЫЕ КОЛОНКИ НЕ УЕЗЖАЮТ СОСЕДЯМ — и это тоже решение, а не побочный
//      эффект. Правка visits.service_id/room_id не даёт записи в журнал
//      вообще: их нет ни в SHIPPED.visits, ни в перечне колонок триггера
//      visits_journal_upd. Межфилиальный календарь — следующая задача, и она
//      требует отдельного решения про врача; пока запись живёт в своём здании.
//      Тест ПИНЯЕТ это, чтобы «заодно» добавленная колонка в SHIPPED не
//      проехала незамеченной.
//
//   4. ПЛАНИРОВЩИК БЕРЁТ ИНДЕКС. Индекс, который база не выбирает, — не
//      ускорение, а расход (тот же довод, которым 097 отказалась от своего
//      частичного индекса). Запрос календаря проверяется EXPLAIN QUERY PLAN:
//      до — SCAN visits, после — SEARCH … USING INDEX idx_visits_date.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { SHIPPED } from '../../services/branch-sync/journal.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const M099 = '099_calendar_booking.sql';
const INDEX = 'idx_visits_date';

// Ровно тот запрос, которым «Календарь записи» набирает день (или период):
// диапазон по visit_date и НИ ОДНОГО равенства по врачу — сетка показывает
// всех выбранных сразу.
const CALENDAR_QUERY =
  "SELECT id, patient_id, doctor_id, service_id, room_id, visit_date, duration_minutes, status"
  + " FROM visits WHERE visit_date >= '2026-09-05T00:00:00Z' AND visit_date < '2026-09-06T00:00:00Z'"
  + " ORDER BY visit_date";

const plan = (db, sql) => db.prepare('EXPLAIN QUERY PLAN ' + sql).all().map((r) => r.detail).join(' | ');
const cols = (db, table) => db.prepare(`PRAGMA table_info("${table}")`).all();
const col = (db, table, name) => cols(db, table).find((c) => c.name === name);
const fkeys = (db, table) => db.prepare(`PRAGMA foreign_key_list("${table}")`).all();

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

/** Клиника накануне обновления: врач, пациент, кабинет и приём на завтра. */
function seedClinic(db) {
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (7,'doc','x','Петров П.П.','doctor',1)").run();
  db.prepare("INSERT INTO patients (id, full_name) VALUES (3,'Иванов Иван')").run();
  db.prepare("INSERT INTO floors (id, name, level) VALUES (1,'2-й этаж',2)").run();
  db.prepare("INSERT INTO rooms (id, name, floor_id) VALUES (11,'Кабинет 201',1)").run();
  db.prepare(`INSERT INTO visits (id, patient_id, doctor_id, visit_date, duration_minutes, status)
              VALUES (55, 3, 7, '2026-09-05T09:30:00Z', 20, 'scheduled')`).run();
}

const journalCount = (db) => db.prepare('SELECT COUNT(*) c FROM sync_journal').get().c;

test('099: на чистой установке колонки и индекс есть', () => {
  const db = openDb(':memory:');
  migrate(db);

  assert.ok(col(db, 'visits', 'room_id'), 'visits.room_id не создана');
  assert.ok(col(db, 'visits', 'service_id'), 'visits.service_id не создана');
  assert.ok(col(db, 'rooms', 'working_hours'), 'rooms.working_hours не создана');

  // Ссылки настоящие: календарь кладёт в эти колонки id кабинета и услуги, и
  // мусор туда попасть не должен (foreign_keys = ON, см. connection.js).
  const vfk = fkeys(db, 'visits');
  assert.ok(vfk.some((f) => f.from === 'room_id' && f.table === 'rooms'), 'room_id не смотрит на rooms');
  assert.ok(vfk.some((f) => f.from === 'service_id' && f.table === 'services'), 'service_id не смотрит на services');

  // Форма rooms.working_hours — в точности users.working_hours (мигр. 019):
  // движок слотов один на оба, и две разные формы означали бы две разные
  // правды о том, что свободно.
  const rw = col(db, 'rooms', 'working_hours');
  const uw = col(db, 'users', 'working_hours');
  assert.equal(rw.type, uw.type, 'тип rooms.working_hours разошёлся с users.working_hours');
  assert.equal(rw.notnull, uw.notnull);
  assert.equal(rw.dflt_value, uw.dflt_value);

  assert.ok(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(INDEX),
    'индекс по visit_date не создан',
  );
  db.close();
});

test('099: FK работают — чужой кабинет и чужая услуга в визит не попадут', () => {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO patients (id, full_name) VALUES (3,'Иванов Иван')").run();
  assert.throws(
    () => db.prepare("INSERT INTO visits (patient_id, visit_date, room_id) VALUES (3,'2026-09-05T09:00:00Z',999)").run(),
    /FOREIGN KEY/i,
  );
  assert.throws(
    () => db.prepare("INSERT INTO visits (patient_id, visit_date, service_id) VALUES (3,'2026-09-05T09:00:00Z',999)").run(),
    /FOREIGN KEY/i,
  );
  db.close();
});

test('099: на живой базе данные целы, старые строки получают NULL / пустые часы', () => {
  const db = dbBefore(M099);
  assert.ok(!col(db, 'visits', 'room_id'), 'до 099 колонки быть не должно — иначе тест ничего не проверяет');
  seedClinic(db);

  applyFile(db, M099);

  const v = db.prepare('SELECT * FROM visits WHERE id = 55').get();
  assert.equal(v.patient_id, 3);
  assert.equal(v.doctor_id, 7);
  assert.equal(v.duration_minutes, 20);
  assert.equal(v.status, 'scheduled');
  assert.equal(v.room_id, null, 'старый визит обязан получить NULL, а не выдуманный кабинет');
  assert.equal(v.service_id, null);
  // Пустая строка = «часов не задано»: кабинет работает по часам клиники,
  // ровно как до обновления.
  assert.equal(db.prepare('SELECT working_hours w FROM rooms WHERE id = 11').get().w, '');
  db.close();
});

// ГЛАВНОЕ УТВЕРЖДЕНИЕ ФАЙЛА.
test('099: журнал филиалов не получает НИ ОДНОЙ строки — миграция не сетевое событие', () => {
  const db = dbBefore(M099);
  seedClinic(db);
  const before = journalCount(db);
  assert.ok(before > 0, 'посев обязан был зажурналиться — иначе «ноль после» ничего не значит');

  applyFile(db, M099);

  assert.equal(journalCount(db), before,
    'ADD COLUMN породил записи в sync_journal: каждая уедет соседям под свежей меткой и перебьёт там их правки');
  db.close();
});

test('099: в файле нет ни одного UPDATE и ни одной пересборки таблицы', () => {
  const sql = fs.readFileSync(path.join(DIR, M099), 'utf8');
  // Из текста убираются комментарии: шапка обсуждает и UPDATE, и пересборку —
  // без этого тест сравнивал бы рассказ о коде с кодом.
  const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  assert.ok(!/\bUPDATE\b/i.test(code), 'массовый UPDATE журналируемой таблицы — сетевое событие (см. шапку 084)');
  assert.ok(!/\bDROP\s+TABLE\b/i.test(code), 'пересборка журналируемой таблицы уносит все строки соседям под метками «мы авторы»');
  assert.ok(!/\bDELETE\b/i.test(code));
});

test('099: новые колонки НЕ уезжают филиалам — это шов, а не недосмотр', () => {
  // service_id/room_id — локальные: календарь этого шага показывает записи
  // своего здания. Появление их в SHIPPED — отдельное решение вместе с
  // ссылкой на врача (SHIPPED.visits не везёт doctor_id), и оно обязано
  // ломать этот тест, а не проезжать молча.
  assert.ok(!SHIPPED.visits.includes('service_id'), 'service_id попал в SHIPPED мимо решения о межфилиальном календаре');
  assert.ok(!SHIPPED.visits.includes('room_id'), 'room_id попал в SHIPPED мимо решения о межфилиальном календаре');

  // И та же половина правды со стороны триггера: правка ОДНОЙ такой колонки
  // не даёт записи в журнал вовсе.
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (7,'doc','x','doctor')").run();
  db.prepare("INSERT INTO patients (id, full_name) VALUES (3,'Иванов Иван')").run();
  db.prepare("INSERT INTO rooms (id, name) VALUES (11,'Кабинет 201')").run();
  db.prepare("INSERT INTO visits (id, patient_id, doctor_id, visit_date) VALUES (55,3,7,'2026-09-05T09:30:00Z')").run();
  const before = journalCount(db);
  db.prepare('UPDATE visits SET room_id = 11 WHERE id = 55').run();
  assert.equal(journalCount(db), before, 'правка room_id зажурналилась — значит колонка начала уезжать соседям');
  db.close();
});

test('099: планировщик БЕРЁТ индекс — открытие календаря перестаёт читать все визиты клиники', () => {
  const db = openDb(':memory:');
  migrate(db);

  const after = plan(db, CALENDAR_QUERY);
  assert.match(after, new RegExp(`SEARCH visits USING (COVERING )?INDEX ${INDEX}`),
    'запрос дня обязан идти поиском по диапазону, а не перебором: ' + after);

  // «До»: тот же запрос без индекса. Сравнение обязательно — без него тест не
  // отличил бы «индекс работает» от «SQLite и так быстра на пустой базе».
  db.exec(`DROP INDEX ${INDEX}`);
  assert.match(plan(db, CALENDAR_QUERY), /SCAN visits/,
    'без индекса открытие календаря читает всю таблицу визитов — именно это и чинится');
  db.close();
});

test('099: повторный прогон миграций ничего не ломает', () => {
  const db = openDb(':memory:');
  migrate(db);
  migrate(db);   // уже записана — второй раз не применяется
  assert.equal(
    db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='index' AND name=?").get(INDEX).c, 1,
    'индекс должен быть ровно один');
  db.close();
});
