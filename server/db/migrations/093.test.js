// 093.test.js — TREATMENT_ORDERS_V1: модель листа назначений.
//
// Два вопроса, и второй важнее первого:
//   • новые таблицы держат ровно те правила, ради которых они заведены —
//     ключ отметки (назначение, ДАТА, слот), причина у отказа, PRN без слота;
//   • СТАРЫЕ таблицы 025 (admission_prescriptions, med_administrations) после
//     этой миграции целы и по-прежнему принимают то, что пишет работающий
//     экран. Он остаётся на них до Задачи 5, и день обновления не должен стать
//     днём, когда медсестра не смогла нажать кнопку.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const M093 = '093_treatment_orders.sql';

/** База ровно в том виде, в каком её застаёт 093 на работающей клинике. */
function dbBefore093() {
  const db = openDb(':memory:');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  )`);
  for (const file of fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort()) {
    if (file >= M093) break;
    db.transaction(() => {
      db.exec(fs.readFileSync(path.join(DIR, file), 'utf8'));
      db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(file);
    })();
  }
  return db;
}

function apply093(db) {
  db.transaction(() => {
    db.exec(fs.readFileSync(path.join(DIR, M093), 'utf8'));
    db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(M093);
  })();
}

/** Клиника: пациент на койке, лечащий врач, склад и прейскурант. */
function clinic(db) {
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (1,'doc','x','Лечащий','doctor')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (2,'nur','x','Медсестра','nurse')").run();
  db.prepare("INSERT INTO patients (id, full_name) VALUES (1,'Иванов Иван')").run();
  db.prepare("INSERT INTO wards (id, name, billing_mode, price_per_day) VALUES (1,'Терапия','daily',150000)").run();
  db.prepare("INSERT INTO beds (id, code, ward_id, status) VALUES (1,'K-1',1,'occupied')").run();
  db.prepare("INSERT INTO services (id, name, price) VALUES (1,'Инъекция в/м',20000)").run();
  db.prepare("INSERT INTO products (id, name, unit, category) VALUES (1,'Цефтриаксон 1 г','pcs','drug')").run();
  db.prepare(`INSERT INTO admissions (id, patient_id, bed_id, ward_id, doctor_id, attending_doctor_id, status)
              VALUES (1,1,1,1,1,1,'active')`).run();
  return db;
}

/** База после 093 с заведённой клиникой. */
function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  return clinic(db);
}

const ORDER = `INSERT INTO treatment_orders
  (id, admission_id, kind, name, dose, route, freq_code, slots, prn, starts_on, days, ends_on, prescribed_by)
  VALUES (1, 1, 'med', 'Цефтриаксон', '1 г', 'в/м', '3x', '[6,14,22]', 0, '2026-09-04', 5, '2026-09-08', 1)`;

// ─── 1. Миграция на живой базе ──────────────────────────────────────────────

test('093 применяется к базе, где уже стоят ПУСТЫЕ таблицы 025, и не трогает их', () => {
  const db = dbBefore093();
  clinic(db);

  // Так эта база и выглядит в клиниках: таблицы 025 существуют и пусты.
  const before = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table'
                              AND name IN ('admission_prescriptions','med_administrations')
                              ORDER BY name`).all();
  assert.equal(before.length, 2);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM admission_prescriptions').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM med_administrations').get().n, 0);

  apply093(db);

  const after = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table'
                             AND name IN ('admission_prescriptions','med_administrations')
                             ORDER BY name`).all();
  assert.deepEqual(after, before, 'старые таблицы не пересобраны и не изменены');

  // И, главное, они по-прежнему принимают то, что пишет работающий экран
  // (admission-modal.js) — без due_date, без статуса, без ссылки на назначение.
  db.prepare(`INSERT INTO admission_prescriptions (admission_id, patient_id, name, dose, freq, dur, prescribed_by, active)
              VALUES (1,1,'Анальгин','1 таб','3 р/д','5 дней',1,1)`).run();
  db.prepare(`INSERT INTO med_administrations (admission_id, patient_id, med_name, dose, administered_by)
              VALUES (1,1,'Анальгин','1 таб',2)`).run();
  assert.equal(db.prepare('SELECT COUNT(*) n FROM admission_prescriptions').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM med_administrations').get().n, 1);

  // Новые таблицы при этом появились и пусты.
  assert.equal(db.prepare('SELECT COUNT(*) n FROM treatment_orders').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM treatment_administrations').get().n, 0);
  db.close();
});

test('миграция ни разу не названа применённой дважды и проходит на чистой базе', () => {
  const db = openDb(':memory:');
  migrate(db);
  migrate(db);   // повторный прогон — ничего не применяет заново
  assert.equal(db.prepare('SELECT COUNT(*) n FROM schema_migrations WHERE name = ?').get(M093).n, 1);
  db.close();
});

// ─── 2. Назначение ──────────────────────────────────────────────────────────

test('назначение хранит курс, снимок часов и подпись врача', () => {
  const db = fresh();
  db.exec(ORDER);
  const o = db.prepare('SELECT * FROM treatment_orders WHERE id = 1').get();
  assert.equal(o.status, 'active');
  assert.equal(o.source, 'clinic');
  assert.equal(o.slots, '[6,14,22]');
  assert.equal(o.ends_on, '2026-09-08');
  assert.equal(o.prn, 0);
  assert.equal(o.cancel_reason, '');
  assert.ok(o.prescribed_at, 'время назначения проставляется само');
  db.close();
});

test('закрытые списки: род, путь введения, частота, источник и статус', () => {
  const db = fresh();
  db.exec(ORDER);
  const bad = [
    ["UPDATE treatment_orders SET kind='витамины' WHERE id=1", 'род'],
    ["UPDATE treatment_orders SET route='в вену' WHERE id=1", 'путь введения'],
    ["UPDATE treatment_orders SET freq_code='5x' WHERE id=1", 'частота'],
    ["UPDATE treatment_orders SET source='аптека' WHERE id=1", 'источник'],
    ["UPDATE treatment_orders SET status='paused' WHERE id=1", 'статус'],
    ['UPDATE treatment_orders SET days=0 WHERE id=1', 'ноль дней курса'],
  ];
  for (const [sql, what] of bad) {
    assert.throws(() => db.exec(sql), /CHECK constraint failed/, what);
  }
  // А NULL в пути введения законен: у процедуры и ухода пути нет.
  db.exec("UPDATE treatment_orders SET kind='care', route=NULL WHERE id=1");
  assert.equal(db.prepare('SELECT route FROM treatment_orders WHERE id=1').get().route, null);
  db.close();
});

test('назначение без госпитализации завести нельзя', () => {
  const db = fresh();
  assert.throws(() => db.prepare(`INSERT INTO treatment_orders
      (admission_id, name, freq_code, starts_on) VALUES (999,'Ампициллин','1x','2026-09-04')`).run(),
    /FOREIGN KEY constraint failed/);
  db.close();
});

// ─── 3. Отметка ─────────────────────────────────────────────────────────────

const mark = (db, date, slot, status = 'given', reason = '') =>
  db.prepare(`INSERT INTO treatment_administrations (order_id, due_date, due_slot, status, reason)
              VALUES (1,?,?,?,?)`).run(date, slot, status, reason);

test('ключ отметки — (назначение, ДАТА, слот): один час в разные дни не сталкивается', () => {
  const db = fresh();
  db.exec(ORDER);
  mark(db, '2026-09-04', 6);
  mark(db, '2026-09-05', 6);   // тот же час, другой день — законно
  mark(db, '2026-09-05', 14);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM treatment_administrations').get().n, 3);

  // А вот та же доза второй раз — нет. Это и есть защита от двойного нажатия.
  assert.throws(() => mark(db, '2026-09-04', 6), /UNIQUE constraint failed/);
  db.close();
});

test('PRN отмечается без слота, и таких отметок за день может быть сколько угодно', () => {
  const db = fresh();
  db.exec(ORDER);
  db.exec("UPDATE treatment_orders SET freq_code='prn', prn=1, slots='[]', days=NULL, ends_on=NULL WHERE id=1");
  const prn = db.prepare(`INSERT INTO treatment_administrations (order_id, due_date, due_slot, status)
                          VALUES (1,'2026-09-04',NULL,'given')`);
  prn.run(); prn.run(); prn.run();
  assert.equal(db.prepare('SELECT COUNT(*) n FROM treatment_administrations WHERE due_slot IS NULL').get().n, 3,
    'по требованию — не дубли, а три введения');
  db.close();
});

test('отказ, пропуск и задержка без причины в базу не ложатся', () => {
  const db = fresh();
  db.exec(ORDER);
  for (const status of ['refused', 'missed', 'held']) {
    assert.throws(() => mark(db, '2026-09-04', 14, status), /CHECK constraint failed/, status);
    assert.throws(() => mark(db, '2026-09-04', 14, status, '   '), /CHECK constraint failed/, status + ' (пробелы)');
  }
  mark(db, '2026-09-04', 14, 'refused', 'пациент отказался');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM treatment_administrations').get().n, 1);
  db.close();
});

test('снятая отметка остаётся строкой-следом и освобождает слот под новую', () => {
  const db = fresh();
  db.exec(ORDER);
  mark(db, '2026-09-04', 6, 'refused', 'ошиблась пациентом');
  db.prepare(`UPDATE treatment_administrations
                 SET voided_at = '2026-09-04T07:00:00Z', voided_by = 2, void_reason = 'не тот пациент'
               WHERE id = 1`).run();

  // Слот снова свободен — иначе исправить ошибку было бы невозможно.
  mark(db, '2026-09-04', 6, 'given');

  const rows = db.prepare('SELECT status, voided_at FROM treatment_administrations ORDER BY id').all();
  assert.equal(rows.length, 2, 'снятая отметка не удалена — она след');
  assert.equal(rows[0].voided_at, '2026-09-04T07:00:00Z');
  assert.equal(rows[1].voided_at, null);
  // И два действующих на один слот всё так же невозможны.
  assert.throws(() => mark(db, '2026-09-04', 6), /UNIQUE constraint failed/);
  db.close();
});

test('час дозы — только настоящий час суток', () => {
  const db = fresh();
  db.exec(ORDER);
  assert.throws(() => mark(db, '2026-09-04', 24), /CHECK constraint failed/, 'слота 24 не бывает: это 0 следующего дня');
  assert.throws(() => mark(db, '2026-09-04', -1), /CHECK constraint failed/);
  db.close();
});

test('отметка без назначения и с неизвестным статусом невозможна', () => {
  const db = fresh();
  db.exec(ORDER);
  assert.throws(() => db.prepare(`INSERT INTO treatment_administrations (order_id, due_date, due_slot, status)
                                  VALUES (999,'2026-09-04',6,'given')`).run(), /FOREIGN KEY constraint failed/);
  assert.throws(() => mark(db, '2026-09-04', 6, 'может быть', 'причина'), /CHECK constraint failed/);
  db.close();
});

test('отмена назначения не уносит его отметки', () => {
  const db = fresh();
  db.exec(ORDER);
  mark(db, '2026-09-04', 6);
  db.prepare(`UPDATE treatment_orders SET status='cancelled', cancel_reason='аллергия',
                 cancel_by=1, cancel_at='2026-09-04T09:00:00Z' WHERE id=1`).run();
  assert.equal(db.prepare('SELECT COUNT(*) n FROM treatment_administrations').get().n, 1);
  assert.equal(db.prepare('SELECT status FROM treatment_orders WHERE id=1').get().status, 'cancelled');
  db.close();
});

// ─── 4. Индексы под два настоящих запроса ───────────────────────────────────

test('оба настоящих запроса идут индексом, а не перебором таблицы', () => {
  const db = fresh();

  // «Лист этой госпитализации на дату».
  const one = db.prepare(`EXPLAIN QUERY PLAN
    SELECT * FROM treatment_orders WHERE admission_id = 1 AND status = 'active'
       AND starts_on <= '2026-09-04' AND (ends_on IS NULL OR ends_on >= '2026-09-04')`).all()
    .map((r) => r.detail).join(' ');
  assert.match(one, /USING INDEX idx_treatment_orders_admission/, one);

  // «Что уже закрыто сегодня по отделению».
  const two = db.prepare(`EXPLAIN QUERY PLAN
    SELECT order_id, due_slot FROM treatment_administrations
     WHERE due_date = '2026-09-04' AND voided_at IS NULL`).all()
    .map((r) => r.detail).join(' ');
  assert.match(two, /USING INDEX idx_treatment_admin_date/, two);
  db.close();
});
