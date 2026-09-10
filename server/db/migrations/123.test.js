// 123.test.js — LIS_INGEST_V1: две таблицы, пять колонок и ноль строк в
// журнале филиалов.
//
// Утверждения, ради которых файл существует:
//   1. На чистой установке всё создано и пусто по умолчанию.
//   2. На ЖИВОЙ базе данные целы, а source у прежних строк = 'manual'.
//   3. Журнал филиалов не получает НИ ОДНОЙ строки (см. шапку 084 и 100.test.js).
//   4. source НЕ уезжает соседям: происхождение — факт здания, как entered_by.
//   5. Сопоставление не уезжает в справочнике филиалов: анализатор соседнего
//      здания в нашей базе не означает ничего.
//   6. В файле нет UPDATE и нет пересборки таблиц.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { SHIPPED } from '../../services/branch-sync/journal.js';
import { TABLES } from '../../services/branch-sync/catalogue.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const M123 = '123_lis_ingest.sql';

const cols = (db, t) => db.prepare(`PRAGMA table_info("${t}")`).all();
const col = (db, t, n) => cols(db, t).find((c) => c.name === n);
const journalCount = (db) => db.prepare('SELECT COUNT(*) c FROM sync_journal').get().c;

/** База ровно в том виде, в каком её застаёт файл `upTo` (сам файл НЕ применён). */
function dbBefore(upTo) {
  const db = openDb(':memory:');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  )`);
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.sql')).sort()) {
    if (f >= upTo) break;
    const sql = fs.readFileSync(path.join(DIR, f), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(f);
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

/** Клиника накануне обновления: пациент, визит, лабораторный заказ, результат. */
function seedClinic(db) {
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (7,'lab','x','Лаборант Л.','lab')").run();
  db.prepare("INSERT INTO patients (id, full_name) VALUES (3,'Иванов Иван')").run();
  db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (55,3,'2026-09-05T09:30:00Z','scheduled')").run();
  db.prepare("INSERT INTO services (id, name, is_lab) VALUES (9,'Общий анализ крови',1)").run();
  db.prepare("INSERT INTO visit_services (id, visit_id, service_id, status) VALUES (123,55,9,'in_progress')").run();
  db.prepare("INSERT INTO lab_results (id, visit_service_id, parameter, value) VALUES (1,123,'Лейкоциты','6.1')").run();
}

test('123: на чистой установке таблицы и колонки есть, значения по умолчанию верны', () => {
  const db = openDb(':memory:');
  migrate(db);

  assert.ok(cols(db, 'lab_devices').length, 'lab_devices не создана');
  assert.ok(cols(db, 'lab_device_messages').length, 'lab_device_messages не создана');

  const src = col(db, 'lab_results', 'source');
  assert.ok(src, 'lab_results.source не создана');
  assert.equal(src.notnull, 1);
  assert.equal(src.dflt_value, "'manual'");

  const conf = col(db, 'lab_panel_analytes', 'device_code_confirmed');
  assert.equal(conf.notnull, 1);
  assert.equal(conf.dflt_value, '0', 'неподтверждённое сопоставление — состояние по умолчанию');

  assert.ok(col(db, 'lab_panels', 'device_id'), 'lab_panels.device_id не создана');
  db.close();
});

test('123: на живой базе данные целы, у прежнего результата source = manual', () => {
  const db = dbBefore(M123);
  assert.ok(!col(db, 'lab_results', 'source'), 'до 123 колонки быть не должно — иначе тест ничего не проверяет');
  seedClinic(db);

  applyFile(db, M123);

  const r = db.prepare('SELECT * FROM lab_results WHERE id = 1').get();
  assert.equal(r.parameter, 'Лейкоциты');
  assert.equal(r.value, '6.1');
  assert.equal(r.source, 'manual', 'прежний результат обязан остаться «введён человеком»');
  db.close();
});

// ГЛАВНОЕ УТВЕРЖДЕНИЕ ФАЙЛА.
test('123: журнал филиалов не получает НИ ОДНОЙ строки', () => {
  const db = dbBefore(M123);
  seedClinic(db);
  const before = journalCount(db);
  assert.ok(before > 0, 'посев обязан был зажурналиться — иначе «столько же после» ничего не значит');

  applyFile(db, M123);

  assert.equal(journalCount(db), before,
    'миграция породила записи в sync_journal: каждая уедет соседям под свежей меткой и перебьёт там их правки');
  db.close();
});

test('123: происхождение значения НЕ уезжает соседям — это факт здания, как entered_by', () => {
  assert.ok(!SHIPPED.lab_results.includes('source'),
    'source в SHIPPED: список уже исключает entered_by/verified_by — «кто и как получил» остаётся дома');
  // Половина со стороны базы: триггер не пересобирался, значит source в нём нет.
  const db = openDb(':memory:');
  migrate(db);
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='lab_results_journal_upd'").get();
  if (row) assert.ok(!/NEW\.source/i.test(row.sql), 'триггер знает про source — значит он начал уезжать');
  db.close();
});

test('123: сопоставление с анализатором не уезжает в справочнике филиалов', () => {
  const panels = TABLES.find((t) => t.name === 'lab_panels');
  const analytes = TABLES.find((t) => t.name === 'lab_panel_analytes');
  assert.ok(panels && analytes, 'панели обязаны быть в справочнике — иначе тест сторожит не то');
  assert.ok(!panels.columns.includes('device_id'),
    'device_id уехал соседям: анализатор соседнего здания в нашей базе не означает ничего');
  assert.ok(!analytes.columns.includes('device_code'));
  assert.ok(!analytes.columns.includes('device_code_confirmed'));
});

test('123: в файле нет ни одного UPDATE и ни одной пересборки', () => {
  const sql = fs.readFileSync(path.join(DIR, M123), 'utf8');
  const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  assert.ok(!/^\s*UPDATE\s/im.test(code), 'массовый UPDATE журналируемой таблицы — сетевое событие');
  assert.ok(!/\bDROP\s+TABLE\b/i.test(code));
  assert.ok(!/\bDELETE\b/i.test(code));
});
