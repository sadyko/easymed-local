// 095.test.js — INPATIENT_REVIEW_V1: модель врачебного осмотра.
//
// Три вопроса, и третий — тот, ради которого таблица заведена именно такой:
//   • миграция ложится на работающую клинику и ничего в ней не трогает;
//   • закрытые списки закрыты (род записи), а ссылки — ссылаются;
//   • ИСПРАВЛЕНИЕ НЕ СТИРАЕТ ИСХОДНИК: у опубликованной записи есть чем
//     указать на ту, что пришла ей на смену, и сама она остаётся целой.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const M095 = '095_admission_reviews.sql';

/** База ровно в том виде, в каком её застаёт 095 на работающей клинике. */
function dbBefore095() {
  const db = openDb(':memory:');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  )`);
  for (const file of fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort()) {
    if (file >= M095) break;
    db.transaction(() => {
      db.exec(fs.readFileSync(path.join(DIR, file), 'utf8'));
      db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(file);
    })();
  }
  return db;
}

function apply095(db) {
  db.transaction(() => {
    db.exec(fs.readFileSync(path.join(DIR, M095), 'utf8'));
    db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(M095);
  })();
}

/** Клиника: пациент на койке, главный врач, лечащий врач. */
function clinic(db) {
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (1,'hdoc','x','Главный врач','doctor',1)").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (2,'doc','x','Лечащий врач','doctor',1)").run();
  db.prepare("INSERT INTO patients (id, full_name) VALUES (1,'Иванов Иван')").run();
  db.prepare("INSERT INTO wards (id, name) VALUES (1,'Терапия')").run();
  db.prepare("INSERT INTO beds (id, code, ward_id, status) VALUES (1,'K-1',1,'occupied')").run();
  db.prepare("INSERT INTO admissions (id, patient_id, bed_id, ward_id, status) VALUES (1,1,1,1,'admitted')").run();
  return db;
}

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  return clinic(db);
}

const PRIMARY = `INSERT INTO admission_reviews
  (id, admission_id, kind, complaints, objective, diagnosis, plan, body, author_id, author_role, published_at)
  VALUES (1, 1, 'primary', 'Боли в животе', 'Состояние средней тяжести', 'K35.8',
          'Стол №1, инфузия', 'Анамнез без особенностей', 1, 'head_doctor', '2026-09-04T10:00:00Z')`;

// ─── 1. Миграция на живой базе ──────────────────────────────────────────────

test('095 применяется к работающей базе и ничего в ней не переписывает', () => {
  const db = dbBefore095();
  clinic(db);

  const before = db.prepare(`SELECT name, sql FROM sqlite_master WHERE type='table'
                              AND name IN ('admissions','treatment_orders') ORDER BY name`).all();
  assert.equal(before.length, 2, 'база до 095 — это база после 093');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM admissions').get().n, 1);

  apply095(db);

  const after = db.prepare(`SELECT name, sql FROM sqlite_master WHERE type='table'
                             AND name IN ('admissions','treatment_orders') ORDER BY name`).all();
  assert.deepEqual(after, before, 'существующие таблицы не пересобраны');
  // Лежащий пациент продолжает лежать: миграция ничего не двигает.
  assert.equal(db.prepare('SELECT status FROM admissions WHERE id=1').get().status, 'admitted');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM admission_reviews').get().n, 0);
  db.close();
});

test('миграция не применяется дважды и проходит на чистой базе', () => {
  const db = openDb(':memory:');
  migrate(db);
  migrate(db);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM schema_migrations WHERE name = ?').get(M095).n, 1);
  db.close();
});

// ─── 2. Что таблица хранит ──────────────────────────────────────────────────

test('осмотр хранит четыре части записи, автора и РОЛЬ, которой воспользовались', () => {
  const db = fresh();
  db.exec(PRIMARY);
  const r = db.prepare('SELECT * FROM admission_reviews WHERE id=1').get();
  assert.equal(r.kind, 'primary');
  assert.equal(r.complaints, 'Боли в животе');
  assert.equal(r.objective, 'Состояние средней тяжести');
  assert.equal(r.diagnosis, 'K35.8');
  assert.equal(r.plan, 'Стол №1, инфузия');
  assert.equal(r.body, 'Анамнез без особенностей');
  assert.equal(r.author_id, 1);
  // Одного имени мало: главный врач — надстройка над врачом, и через год по
  // users.extra_roles уже не сказать, в каком качестве он подписал запись.
  assert.equal(r.author_role, 'head_doctor');
  assert.ok(r.created_at, 'время создания проставляется само');
  assert.equal(r.superseded_by, null);
  db.close();
});

test('черновик — это published_at IS NULL, и он законен', () => {
  const db = fresh();
  db.prepare(`INSERT INTO admission_reviews (admission_id, kind, complaints, author_id, author_role)
              VALUES (1,'primary','Черновик',1,'head_doctor')`).run();
  const r = db.prepare('SELECT * FROM admission_reviews').get();
  assert.equal(r.published_at, null, 'черновик существует и ничем не подписан');
  // Пустые части — это норма для черновика: врач дописывает его по частям.
  assert.equal(r.objective, '');
  assert.equal(r.plan, '');
  db.close();
});

test('род записи — закрытый список, а госпитализация и автор обязаны существовать', () => {
  const db = fresh();
  assert.throws(() => db.prepare("INSERT INTO admission_reviews (admission_id, kind) VALUES (1,'консилиум')").run(),
    /CHECK/i, 'выдуманный род записи');
  assert.throws(() => db.prepare("INSERT INTO admission_reviews (admission_id, kind) VALUES (999,'primary')").run(),
    /FOREIGN KEY/i, 'осмотр без госпитализации');
  assert.throws(() => db.prepare("INSERT INTO admission_reviews (admission_id, kind, author_id) VALUES (1,'primary',777)").run(),
    /FOREIGN KEY/i, 'осмотр несуществующего автора');
  // Три законных рода — все три принимаются.
  for (const kind of ['primary', 'round', 'discharge']) {
    db.prepare('INSERT INTO admission_reviews (admission_id, kind) VALUES (1,?)').run(kind);
  }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM admission_reviews').get().n, 3);
  db.close();
});

// ─── 3. Исправление не стирает исходник ─────────────────────────────────────

test('исправление ЗАКРЫВАЕТ прежний осмотр ссылкой, а не переписывает его', () => {
  const db = fresh();
  db.exec(PRIMARY);
  db.prepare(`INSERT INTO admission_reviews (id, admission_id, kind, diagnosis, author_id, author_role, published_at)
              VALUES (2, 1, 'primary', 'K35.2', 1, 'head_doctor', '2026-09-04T12:00:00Z')`).run();
  db.prepare('UPDATE admission_reviews SET superseded_by = 2 WHERE id = 1').run();

  const old = db.prepare('SELECT * FROM admission_reviews WHERE id=1').get();
  assert.equal(old.superseded_by, 2);
  assert.equal(old.diagnosis, 'K35.8', 'прежний диагноз остался в истории целиком');
  assert.equal(old.published_at, '2026-09-04T10:00:00Z', 'и прежнее время публикации тоже');

  // Действующий осмотр — тот, который ещё никем не закрыт.
  const current = db.prepare(
    "SELECT * FROM admission_reviews WHERE admission_id=1 AND kind='primary' AND published_at IS NOT NULL AND superseded_by IS NULL"
  ).all();
  assert.equal(current.length, 1);
  assert.equal(current[0].id, 2);
  db.close();
});

test('осмотр не может отменить сам себя, и ссылка на несуществующий — отказ', () => {
  const db = fresh();
  db.exec(PRIMARY);
  assert.throws(() => db.prepare('UPDATE admission_reviews SET superseded_by = 1 WHERE id = 1').run(), /CHECK/i);
  assert.throws(() => db.prepare('UPDATE admission_reviews SET superseded_by = 42 WHERE id = 1').run(), /FOREIGN KEY/i);
  db.close();
});

test('индекс (госпитализация, род, публикация) существует — это гейт маршрута', () => {
  const db = fresh();
  const idx = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='admission_reviews'").all()
    .find((r) => r.name === 'idx_admission_reviews_lookup');
  assert.ok(idx, 'индекс поиска осмотров не создан');
  assert.match(idx.sql, /admission_id/);
  assert.match(idx.sql, /kind/);
  assert.match(idx.sql, /published_at/);
  db.close();
});
