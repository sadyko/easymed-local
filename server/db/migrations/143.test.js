// CRM_REAL_BOOKING_V1 (mig 143) — ССЫЛКА СТРОКИ ЗАЯВКИ НА ВИЗИТ ГАСНЕТ, А НЕ ЗАПИРАЕТ.
//
// Миграция 142 в первой своей версии завела visit_id без ON DELETE, то есть с
// поведением по умолчанию (NO ACTION), а при `foreign_keys = ON` это запрет:
// визит, записанный колл-центром, переставал удаляться. Саму 142 исправили —
// она ещё не выпущена, — но на машинах разработки она УЖЕ НАКАЧЕНА, а миграция
// помнится по имени файла и второй раз не идёт. Эта пересобирает таблицу.
//
// Проверяется то, ради чего пересборка и нужна: ссылка гаснет, строки целы, и
// на базе, где 142 уже правильная, результат тот же самый.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';

const MIGRATIONS = path.dirname(fileURLToPath(import.meta.url));

const onDelete = (db) => (db.prepare('PRAGMA foreign_key_list(crm_request_services)').all()
  .find((f) => f.from === 'visit_id') || {}).on_delete;

function seed(db) {
  db.prepare("INSERT INTO patients (id, full_name) VALUES (1,'П')").run();
  db.prepare("INSERT INTO visits (id, patient_id, visit_date) VALUES (10, 1, '2026-09-21T09:00:00Z')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (5,'d','x','doctor')").run();
  db.prepare("INSERT INTO services (id, name, price) VALUES (7,'Приём',100000)").run();
  const rid = db.prepare("INSERT INTO crm_requests (full_name, phone, status, patient_id) VALUES ('Лид','1','scheduled',1)")
    .run().lastInsertRowid;
  return rid;
}

/**
 * База машины разработки: всё до 142 включительно, но 142 — В СТАРОМ ВИДЕ
 * (ссылка без ON DELETE) и уже записанная в журнал миграций. Ровно то, что
 * получил каждый, кто накатил ветку до исправления.
 */
function devBoxDb() {
  const db = openDb(':memory:');
  const stage = tmpDir('em-mig143-');
  for (const f of fs.readdirSync(MIGRATIONS)) {
    if (parseInt(f, 10) >= 142 || !f.endsWith('.sql')) continue;
    fs.copyFileSync(path.join(MIGRATIONS, f), path.join(stage, f));
  }
  migrate(db, stage);
  // Старая 142, дословно.
  db.exec('ALTER TABLE crm_request_services ADD COLUMN visit_id INTEGER REFERENCES visits(id);'
    + 'CREATE INDEX IF NOT EXISTS idx_crm_req_services_visit ON crm_request_services(visit_id);');
  db.prepare("INSERT INTO schema_migrations (name) VALUES ('142_crm_line_visit.sql')").run();
  return db;
}

test('143: на машине со СТАРОЙ 142 ссылка становится гаснущей, и ни одна строка не теряется', () => {
  const db = devBoxDb();
  try {
    assert.equal(onDelete(db), 'NO ACTION', 'фикстура не воспроизводит старую 142 — проверять нечего');
    const rid = seed(db);
    const kept = db.prepare(`INSERT INTO crm_request_services
        (request_id, service_id, scheduled_date, status, note, doctor_id, visit_id)
      VALUES (?, 7, '2026-09-21', 'pending', 'заметка', 5, 10)`).run(rid).lastInsertRowid;
    const done = db.prepare(`INSERT INTO crm_request_services
        (request_id, service_id, scheduled_date, status, visit_id)
      VALUES (?, 7, '2026-09-20', 'done', NULL)`).run(rid).lastInsertRowid;
    // Пока ссылка запрещающая, визит не удаляется — это и есть чинимый дефект.
    assert.throws(() => db.prepare('DELETE FROM visits WHERE id = 10').run(), /FOREIGN KEY/i);

    migrate(db);   // 143

    assert.equal(onDelete(db), 'SET NULL', 'пересборка не поменяла поведение ссылки');
    const rows = db.prepare('SELECT id, request_id, service_id, scheduled_date, status, note, doctor_id, visit_id FROM crm_request_services ORDER BY id').all();
    assert.deepEqual(rows, [
      { id: kept, request_id: rid, service_id: 7, scheduled_date: '2026-09-21', status: 'pending', note: 'заметка', doctor_id: 5, visit_id: 10 },
      { id: done, request_id: rid, service_id: 7, scheduled_date: '2026-09-20', status: 'done', note: null, doctor_id: null, visit_id: null },
    ], 'пересборка потеряла или переписала строки заявок');

    // И главное: визит теперь удаляется, а строка остаётся ждать записи.
    db.prepare('DELETE FROM visits WHERE id = 10').run();
    assert.equal(db.prepare('SELECT visit_id FROM crm_request_services WHERE id=?').get(kept).visit_id, null);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM crm_request_services').get().n, 2);
  } finally { db.close(); }
});

test('143: индексы, ключи и автонумерация переживают пересборку', () => {
  const db = devBoxDb();
  try {
    const rid = seed(db);
    const last = db.prepare("INSERT INTO crm_request_services (request_id, scheduled_date) VALUES (?, '2026-09-21')")
      .run(rid).lastInsertRowid;

    migrate(db);

    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='crm_request_services' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
    assert.deepEqual(idx, ['idx_crm_req_services_date', 'idx_crm_req_services_request', 'idx_crm_req_services_visit'],
      'пересборка потеряла индексы: «из какой заявки эта запись» снова станет перебором');
    // Ссылка на заявку осталась каскадной — удаление заявки уносит её строки.
    assert.equal((db.prepare('PRAGMA foreign_key_list(crm_request_services)').all()
      .find((f) => f.from === 'request_id') || {}).on_delete, 'CASCADE');
    // Номера не начинаются заново: следующая строка не наступает на прежнюю.
    const next = db.prepare("INSERT INTO crm_request_services (request_id, scheduled_date) VALUES (?, '2026-09-22')")
      .run(rid).lastInsertRowid;
    assert.ok(next > last, 'автонумерация сброшена — новая строка получила занятый номер');
    db.prepare('DELETE FROM crm_requests WHERE id = ?').run(rid);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM crm_request_services').get().n, 0, 'каскад по заявке потерян');
  } finally { db.close(); }
});

test('143: на свежей базе ничего не меняет — 142 уже завела гаснущую ссылку', () => {
  const db = openDb(':memory:');
  migrate(db);
  try {
    assert.equal(onDelete(db), 'SET NULL', 'свежая 142 обязана заводить ссылку сразу гаснущей');
    const rid = seed(db);
    const lid = db.prepare("INSERT INTO crm_request_services (request_id, scheduled_date, visit_id) VALUES (?, '2026-09-21', 10)")
      .run(rid).lastInsertRowid;

    migrate(db);   // повторный прогон — 143 уже в журнале, ничего не происходит

    assert.equal(db.prepare('SELECT visit_id FROM crm_request_services WHERE id=?').get(lid).visit_id, 10);
    assert.equal(onDelete(db), 'SET NULL');
  } finally { db.close(); }
});

// ПОЧЕМУ ПЕРЕСБОРКА ЗДЕСЬ ВООБЩЕ БЕЗОПАСНА — миграция 109 описывает, как та же
// операция уронила клинику: при `foreign_keys = ON` DROP TABLE делает неявное
// удаление строк и падает на первой же ЧУЖОЙ строке, ссылающейся на таблицу.
// На строки заявки не ссылается никто, и эта проверка сторожит именно это: как
// только на них сошлётся первая таблица, тест обязан упасть, а не клиника.
test('143: на строки заявки не ссылается ни одна таблица — иначе пересборка была бы опасна', () => {
  const db = openDb(':memory:');
  migrate(db);
  try {
    const refs = [];
    for (const t of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
      for (const fk of db.prepare(`PRAGMA foreign_key_list("${t.name}")`).all()) {
        if (fk.table === 'crm_request_services') refs.push(`${t.name}.${fk.from}`);
      }
    }
    assert.deepEqual(refs, [], 'на crm_request_services появилась ссылка: пересборка таблицы больше не безопасна');
  } finally { db.close(); }
});
