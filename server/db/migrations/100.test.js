// 100.test.js — CROSS_BRANCH_CALENDAR_V1: три колонки, один пересозданный
// триггер и ноль строк в журнале филиалов.
//
// Утверждений, ради которых файл существует, шесть, и каждое — то место, где
// эта миграция могла бы навредить молча:
//
//   1. НА ЖИВОЙ БАЗЕ БЕЗОПАСНА. Применяется к базе с врачом, пациентом и
//      приёмом; после неё данные на месте, а новые колонки у старых строк —
//      '' и 0. Пустой booked_at и есть честное «время записи неизвестно»:
//      бэкфилл здесь запрещён (см. 2).
//
//   2. НЕ СЕТЕВОЕ СОБЫТИЕ. `visits` несёт журнальные триггеры (084), и её шапка
//      предупреждает: массовый UPDATE или пересборка — это выгрузка КАЖДОЙ
//      тронутой строки соседям под свежими метками, то есть молчаливая потеря
//      их правок. Здесь только ADD COLUMN и замена ТЕКСТА триггера; счётчик
//      sync_journal до и после обязан совпасть.
//
//   3. ТРИГГЕР СОШЁЛСЯ СО СПИСКОМ ОТПРАВЛЯЕМОГО. Договор «колонки триггера =
//      SHIPPED ∪ REFS ∪ CODE_REFS» стережёт journal.test.js для ВСЕХ таблиц;
//      здесь проверяется его половина, ради которой миграция и написана:
//      doctor_id и booked_at действительно попали в оба списка.
//
//   4. ПРАВКА ВРАЧА ТЕПЕРЬ УЕЗЖАЕТ. До этой миграции UPDATE одного doctor_id не
//      давал в журнале НИ ОДНОЙ строки: колонки не было в перечне. Врач,
//      переназначенный мышью в сетке, у соседа остался бы прежним навсегда.
//
//   5. КАБИНЕТ И СЛУЖЕБНЫЕ ПОМЕТКИ ПО-ПРЕЖНЕМУ НЕ УЕЗЖАЮТ. room_id/service_id
//      (решение 099) и cross_branch/cross_branch_seq (факты отправителя, у
//      соседа бессмысленные) не журналируются вовсе.
//
//   6. ФАЙЛ НЕ СОДЕРЖИТ НИ UPDATE, НИ ПЕРЕСБОРКИ. Проверяется по тексту, с
//      вырезанными комментариями: шапка обсуждает и то и другое.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { SHIPPED, REFS, CODE_REFS } from '../../services/branch-sync/journal.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const M100 = '100_cross_branch_calendar.sql';

const cols = (db, table) => db.prepare(`PRAGMA table_info("${table}")`).all();
const col = (db, table, name) => cols(db, table).find((c) => c.name === name);
const journalCount = (db) => db.prepare('SELECT COUNT(*) c FROM sync_journal').get().c;

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

/** Клиника накануне обновления: врач, пациент и приём на завтра. */
function seedClinic(db) {
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (7,'doc','x','Петров П.П.','doctor',1)").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (8,'doc2','x','Каримов Р.','doctor',1)").run();
  db.prepare("INSERT INTO patients (id, full_name) VALUES (3,'Иванов Иван')").run();
  db.prepare("INSERT INTO rooms (id, name) VALUES (11,'Кабинет 201')").run();
  db.prepare(`INSERT INTO visits (id, patient_id, doctor_id, visit_date, duration_minutes, status)
              VALUES (55, 3, 7, '2026-09-05T09:30:00Z', 20, 'scheduled')`).run();
}

test('100: на чистой установке колонки есть и пусты по умолчанию', () => {
  const db = openDb(':memory:');
  migrate(db);

  for (const [name, dflt] of [['booked_at', "''"], ['cross_branch', "''"], ['cross_branch_seq', '0']]) {
    const c = col(db, 'visits', name);
    assert.ok(c, 'visits.' + name + ' не создана');
    assert.equal(c.notnull, 1, name + ': пустое значение обязано быть пустой строкой/нулём, а не NULL');
    assert.equal(c.dflt_value, dflt);
  }
  db.close();
});

test('100: на живой базе данные целы, старые строки получают пустое время записи', () => {
  const db = dbBefore(M100);
  assert.ok(!col(db, 'visits', 'booked_at'), 'до 100 колонки быть не должно — иначе тест ничего не проверяет');
  seedClinic(db);

  applyFile(db, M100);

  const v = db.prepare('SELECT * FROM visits WHERE id = 55').get();
  assert.equal(v.patient_id, 3);
  assert.equal(v.doctor_id, 7);
  assert.equal(v.status, 'scheduled');
  // Пустая строка = «когда записали, неизвестно». Бэкфилл запрещён (см. ниже),
  // а разрешение спора за слот в этом случае падает на запасной ключ.
  assert.equal(v.booked_at, '');
  assert.equal(v.cross_branch, '');
  assert.equal(v.cross_branch_seq, 0);
  db.close();
});

// ГЛАВНОЕ УТВЕРЖДЕНИЕ ФАЙЛА.
test('100: журнал филиалов не получает НИ ОДНОЙ строки — миграция не сетевое событие', () => {
  const db = dbBefore(M100);
  seedClinic(db);
  const before = journalCount(db);
  assert.ok(before > 0, 'посев обязан был зажурналиться — иначе «столько же после» ничего не значит');

  applyFile(db, M100);

  assert.equal(journalCount(db), before,
    'миграция породила записи в sync_journal: каждая уедет соседям под свежей меткой и перебьёт там их правки');
  db.close();
});

test('100: в файле нет ни одного UPDATE и ни одной пересборки таблицы', () => {
  const sql = fs.readFileSync(path.join(DIR, M100), 'utf8');
  // Комментарии вырезаются: шапка обсуждает и UPDATE, и пересборку — иначе тест
  // сравнивал бы рассказ о коде с кодом.
  const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  // UPDATE ищется КАК ОТДЕЛЬНЫЙ ОПЕРАТОР (с начала строки), а не как слово: в
  // теле журнального триггера оно стоит дважды и оба раза законно — «AFTER
  // UPDATE ON visits» и «ON CONFLICT … DO UPDATE SET». Запрещён здесь массовый
  // UPDATE САМОЙ таблицы, и только он.
  assert.ok(!/^\s*UPDATE\s/im.test(code), 'массовый UPDATE журналируемой таблицы — сетевое событие (см. шапку 084)');
  assert.ok(!/\bDROP\s+TABLE\b/i.test(code), 'пересборка журналируемой таблицы уносит все строки соседям под метками «мы авторы»');
  assert.ok(!/\bDELETE\b/i.test(code));
  assert.ok(!/\bINSERT\s+INTO\s+visits\b/i.test(code));
});

test('100: врач и время записи попали в ОБА списка — и в отправляемое, и в триггер', () => {
  assert.ok(SHIPPED.visits.includes('booked_at'),
    'без booked_at в SHIPPED здания не смогут назвать одного и того же «первого» в споре за слот');
  assert.equal(CODE_REFS.visits.doctor_id.table, 'users');
  assert.equal(CODE_REFS.visits.doctor_id.key, 'username',
    'логин — единственная колонка users с UNIQUE, то есть единственный общий ключ двух установок');
  assert.equal(CODE_REFS.visits.doctor_id.soft, true,
    'незнакомый логин обязан ронять ВРАЧА, а не всю запись');

  // Кабинет остаётся дома — решение владельца, а не забывчивость.
  assert.ok(!SHIPPED.visits.includes('room_id'));
  assert.ok(!SHIPPED.visits.includes('cross_branch'), 'пометка ожидания — факт ОТПРАВИТЕЛЯ, соседу она бессмысленна');
  assert.ok(!SHIPPED.visits.includes('cross_branch_seq'));

  // Та же половина со стороны базы: перечень триггера сошёлся со списком.
  const db = openDb(':memory:');
  migrate(db);
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='visits_journal_upd'").get().sql;
  const inTrigger = new Set([...sql.matchAll(/NEW\.(\w+)\s+IS\s+NOT\s+OLD\.\1/gi)].map((m) => m[1]));
  const shipped = new Set([...SHIPPED.visits, ...Object.keys(REFS.visits), ...Object.keys(CODE_REFS.visits)]);
  assert.deepEqual([...inTrigger].sort(), [...shipped].sort());
  db.close();
});

test('100: правка ВРАЧА теперь уезжает, а кабинет и служебные пометки — по-прежнему нет', () => {
  const db = openDb(':memory:');
  migrate(db);
  seedClinic(db);

  // 1. Врач. До этой миграции такой UPDATE не давал в журнале ничего, и врач,
  //    переназначенный в сетке, у соседа оставался прежним НАВСЕГДА.
  let before = journalCount(db);
  db.prepare('UPDATE visits SET doctor_id = 8 WHERE id = 55').run();
  assert.equal(journalCount(db), before + 1, 'правка врача обязана уезжать — ради неё всё и делалось');
  const cols55 = db.prepare('SELECT cols FROM sync_journal ORDER BY seq DESC LIMIT 1').get().cols;
  assert.equal(cols55, 'doctor_id', 'уехать обязана ИМЕННО эта колонка, а не строка целиком');

  // 2. Кабинет и служебные пометки — молчат.
  before = journalCount(db);
  db.prepare("UPDATE visits SET room_id = 11, cross_branch = 'B', cross_branch_seq = 42 WHERE id = 55").run();
  assert.equal(journalCount(db), before,
    'кабинет или пометка ожидания зажурналились — значит начали уезжать соседям');
  db.close();
});
