// 104.test.js — CASE_DOCS_V1: словарь родов документа расширяется, а история
// болезни при этом не теряет ни строки.
//
// Пересборка таблицы — самая опасная миграция из тех, что здесь бывают: она
// физически переписывает место, где лежат врачебные записи. Поэтому вопросов
// три, и первый из них — не про новые рода, а про СТАРЫЕ ДАННЫЕ:
//   • строки переезжают целиком, вместе с автором, временем публикации и —
//     главное — со ссылками исправлений (`superseded_by`), которые и есть
//     «оригинал не стёрт»;
//   • новый словарь принимает двенадцать родов и по-прежнему отвергает
//     выдуманный;
//   • всё, чем таблица была для остального кода (внешние ключи, запрет
//     ссылаться на себя, индекс поиска), осталось на месте.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const M104 = '104_case_documents.sql';

/** База ровно в том виде, в каком её застаёт 104 на работающей клинике. */
function dbBefore104() {
  const db = openDb(':memory:');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  )`);
  for (const file of fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort()) {
    if (file >= M104) break;
    db.transaction(() => {
      db.exec(fs.readFileSync(path.join(DIR, file), 'utf8'));
      db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(file);
    })();
  }
  return db;
}

function apply104(db) {
  db.transaction(() => {
    db.exec(fs.readFileSync(path.join(DIR, M104), 'utf8'));
    db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(M104);
  })();
}

function clinic(db) {
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (1,'hdoc','x','Главный врач','doctor',1)").run();
  db.prepare("INSERT INTO patients (id, full_name) VALUES (1,'Иванов Иван')").run();
  db.prepare("INSERT INTO wards (id, name) VALUES (1,'Хирургия')").run();
  db.prepare("INSERT INTO beds (id, code, ward_id, status) VALUES (1,'X-1',1,'occupied')").run();
  db.prepare("INSERT INTO admissions (id, patient_id, bed_id, ward_id, status) VALUES (1,1,1,1,'active')").run();
  return db;
}

/** Осмотр, ИСПРАВЛЕННЫЙ вторым осмотром: id 1 закрыт ссылкой на id 2. */
function correctedPrimary(db) {
  db.prepare(`INSERT INTO admission_reviews
      (id, admission_id, kind, complaints, objective, diagnosis, plan, body,
       author_id, author_role, created_at, published_at, superseded_by)
    VALUES (1,1,'primary','Боли','Средней тяжести','K35.8','Стол №0','Анамнез',
            1,'head_doctor','2026-09-01T10:00:00Z','2026-09-01T10:30:00Z',NULL)`).run();
  db.prepare(`INSERT INTO admission_reviews
      (id, admission_id, kind, complaints, objective, diagnosis, plan, body,
       author_id, author_role, created_at, published_at, superseded_by)
    VALUES (2,1,'primary','Боли','Средней тяжести','K35.2','Стол №0','Анамнез',
            1,'head_doctor','2026-09-01T12:00:00Z','2026-09-01T12:15:00Z',NULL)`).run();
  // Ссылка исправления ставится ОТДЕЛЬНО: внешний ключ немедленный, и строка
  // не может сослаться на ещё не вставленную. Ровно по этой причине и сама
  // миграция переносит данные в два прохода.
  db.prepare('UPDATE admission_reviews SET superseded_by = 2 WHERE id = 1').run();
  // И черновик рядом — он тоже обязан пережить переезд.
  db.prepare(`INSERT INTO admission_reviews (id, admission_id, kind, complaints, author_id, author_role)
              VALUES (3,1,'round','Черновик обхода',1,'doctor')`).run();
}

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  return clinic(db);
}

// ─── 1. Старые данные переезжают целиком ────────────────────────────────────

test('104 переносит записи вместе со ссылками исправлений и черновиками', () => {
  const db = dbBefore104();
  clinic(db);
  correctedPrimary(db);

  const before = db.prepare('SELECT * FROM admission_reviews ORDER BY id').all();
  assert.equal(before.length, 3);

  apply104(db);

  const after = db.prepare('SELECT * FROM admission_reviews ORDER BY id').all();
  assert.deepEqual(after, before, 'ни одна колонка ни одной строки не изменилась');

  // Отдельно и вслух — то, ради чего перенос идёт в два прохода: исправление
  // по-прежнему указывает на пришедшую на смену запись, а исходник цел.
  const old = db.prepare('SELECT * FROM admission_reviews WHERE id=1').get();
  assert.equal(old.superseded_by, 2);
  assert.equal(old.diagnosis, 'K35.8', 'прежний диагноз остался в истории');
  assert.equal(old.published_at, '2026-09-01T10:30:00Z');
  assert.equal(db.prepare('SELECT superseded_by FROM admission_reviews WHERE id=2').get().superseded_by, null);
  assert.equal(db.prepare('SELECT published_at FROM admission_reviews WHERE id=3').get().published_at, null, 'черновик остался черновиком');
  db.close();
});

test('104 не трогает соседние таблицы и лежащего пациента', () => {
  const db = dbBefore104();
  clinic(db);
  const before = db.prepare(`SELECT name, sql FROM sqlite_master WHERE type='table'
                              AND name IN ('admissions','treatment_orders','admission_diets') ORDER BY name`).all();
  apply104(db);
  const after = db.prepare(`SELECT name, sql FROM sqlite_master WHERE type='table'
                             AND name IN ('admissions','treatment_orders','admission_diets') ORDER BY name`).all();
  assert.deepEqual(after, before, 'существующие таблицы не пересобраны');
  assert.equal(db.prepare('SELECT status FROM admissions WHERE id=1').get().status, 'active');
  db.close();
});

test('миграция не применяется дважды и проходит на чистой базе', () => {
  const db = openDb(':memory:');
  migrate(db);
  migrate(db);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM schema_migrations WHERE name = ?').get(M104).n, 1);
  db.close();
});

// ─── 2. Новый словарь ───────────────────────────────────────────────────────

const ALL_KINDS = ['consent', 'intake', 'anesthesia', 'preop', 'head_review', 'primary',
  'rationale', 'operation', 'round', 'interim', 'discharge', 'other'];

test('двенадцать родов документа принимаются, выдуманный — нет', () => {
  const db = fresh();
  for (const kind of ALL_KINDS) {
    db.prepare('INSERT INTO admission_reviews (admission_id, kind) VALUES (1,?)').run(kind);
  }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM admission_reviews').get().n, ALL_KINDS.length);
  assert.throws(() => db.prepare("INSERT INTO admission_reviews (admission_id, kind) VALUES (1,'консилиум')").run(),
    /CHECK/i, 'словарь остался закрытым');
  // Умолчание не изменилось: род, который не назвали, — первичный осмотр.
  db.prepare('INSERT INTO admission_reviews (admission_id) VALUES (1)').run();
  assert.equal(db.prepare('SELECT kind FROM admission_reviews ORDER BY id DESC LIMIT 1').get().kind, 'primary');
  db.close();
});

// ─── 3. Таблица осталась тем, чем была ──────────────────────────────────────

test('внешние ключи, самоссылка и индекс пережили пересборку', () => {
  const db = fresh();
  assert.throws(() => db.prepare("INSERT INTO admission_reviews (admission_id, kind) VALUES (999,'consent')").run(),
    /FOREIGN KEY/i, 'документ без госпитализации');
  assert.throws(() => db.prepare("INSERT INTO admission_reviews (admission_id, kind, author_id) VALUES (1,'consent',777)").run(),
    /FOREIGN KEY/i, 'документ несуществующего автора');

  db.prepare("INSERT INTO admission_reviews (id, admission_id, kind) VALUES (10,1,'consent')").run();
  assert.throws(() => db.prepare('UPDATE admission_reviews SET superseded_by = 10 WHERE id = 10').run(),
    /CHECK/i, 'документ не может отменить сам себя');
  assert.throws(() => db.prepare('UPDATE admission_reviews SET superseded_by = 42 WHERE id = 10').run(),
    /FOREIGN KEY/i, 'ссылка исправления ведёт в ту же таблицу');

  const idx = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='admission_reviews'").all()
    .find((r) => r.name === 'idx_admission_reviews_lookup');
  assert.ok(idx, 'индекс поиска документов не пересоздан');
  assert.match(idx.sql, /admission_id/);
  assert.match(idx.sql, /kind/);
  assert.match(idx.sql, /published_at/);

  // AUTOINCREMENT пережил переезд: id не выдаётся повторно.
  const next = db.prepare("INSERT INTO admission_reviews (admission_id, kind) VALUES (1,'other')").run().lastInsertRowid;
  assert.ok(next > 10, `новый id ${next} должен быть больше уже выданного 10`);
  db.close();
});

test('реестр отдаёт документ теми же колонками, что и до 104', async () => {
  // schema-registry.js перечисляет колонки admission_reviews поимённо. Уедь
  // хоть одна при пересборке — экран получил бы «unknown column», а не пустой
  // список: тот самый класс поломки, ради которого реестр и заведён.
  const { REGISTRY } = await import('../schema-registry.js');
  const db = fresh();
  const cols = new Set(db.prepare('PRAGMA table_info(admission_reviews)').all().map((c) => c.name));
  for (const c of REGISTRY.admission_reviews.read.columns) {
    assert.ok(cols.has(c), `реестр читает колонку ${c}, а после 104 её нет`);
  }
  db.close();
});
