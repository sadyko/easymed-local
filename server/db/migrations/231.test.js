// CRM_MULTI_SOURCE_V1 (мигр. 231) — crm_requests.sources: JSON-массив
// источников заявки в порядке выбора, главный (source) — первый. Колонка
// добавляется (ADD COLUMN), таблица НЕ пересобирается: на crm_requests
// ссылаются строки услуг, задачи, метки и зеркало записи.
//
// Проверяется на базе С ДАННЫМИ — миграция, падающая на настоящих строках,
// останавливает клинику при старте.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';
import { readableColumns, writableColumns, jsonColumns } from '../schema-registry.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const FILE = '231_crm_request_sources.sql';
const SQL = fs.readFileSync(path.join(DIR, FILE), 'utf8');

function dbBefore231() {
  const db = openDb(':memory:');
  const tmp = tmpDir('em-mig231-');
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.sql') && parseInt(x, 10) < 231)) {
    fs.copyFileSync(path.join(DIR, f), path.join(tmp, f));
  }
  migrate(db, tmp);
  return db;
}

/** Клиника с заявками: три источника, строка услуги, задача, метка — и одна старая заявка без источника. */
function seedClinic(db) {
  db.prepare("INSERT INTO services (id, name, price) VALUES (77, 'Консультация', 100000)").run();
  const lead = db.prepare('INSERT INTO crm_requests (id, full_name, phone, source, status) VALUES (?,?,?,?,?)');
  lead.run(1, 'Каримова Азиза', '+998901112233', 'call', 'in_process');
  lead.run(2, 'Юсупов Бахтиёр', '+998902223344', 'instagram', 'scheduled');
  lead.run(3, '+998903334455', '+998903334455', 'telephony', 'recall');
  db.prepare("INSERT INTO crm_request_services (request_id, service_id, scheduled_date, status) VALUES (2, 77, '2026-10-01', 'pending')").run();
  db.prepare("INSERT INTO crm_tasks (request_id, text) VALUES (1, 'Перезвонить')").run();
  // Старая заявка без источника: справочник её не пустил бы (внешний ключ),
  // но в базе до 077 такие бывали — миграция обязана её пережить.
  db.pragma('foreign_keys = OFF');
  lead.run(4, 'Старая', '+998904445566', '', 'in_process');
  db.pragma('foreign_keys = ON');
}

test('231: бэкфилл на базе с заявками — sources = [source], остальное нетронуто', () => {
  const db = dbBefore231();
  try {
    seedClinic(db);
    const before = db.prepare('SELECT id, full_name, phone, source, status FROM crm_requests ORDER BY id').all();
    assert.equal(db.prepare("SELECT COUNT(*) n FROM pragma_table_info('crm_requests') WHERE name = 'sources'").get().n, 0);
    migrate(db);
    const after = db.prepare('SELECT id, full_name, phone, source, status, sources FROM crm_requests ORDER BY id').all();
    assert.deepEqual(after.map(({ sources, ...rest }) => rest), before, 'миграция тронула что-то кроме sources');
    assert.deepEqual(after.map((r) => r.sources), ['["call"]', '["instagram"]', '["telephony"]', null]);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM crm_request_services WHERE request_id = 2').get().n, 1, 'строка услуги пропала');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM crm_tasks WHERE request_id = 1').get().n, 1, 'задача пропала');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check(crm_requests)').all().filter((x) => x.rowid !== 4), [],
      'внешние ключи заявок сломаны (кроме заведомо старой строки 4)');
    // Новая заявка после миграции без sources: колонка пустая, правило чтения
    // даёт [source] — как у заявок от звонка и зеркала записи.
    const id = db.prepare("INSERT INTO crm_requests (full_name, phone, source) VALUES ('Новый', '+998905556677', 'website')").run().lastInsertRowid;
    assert.equal(db.prepare('SELECT sources FROM crm_requests WHERE id = ?').get(id).sources, null);
  } finally { db.close(); }
});

test('231: повторный накат бэкфилла ничего не меняет; повторный migrate — тоже', () => {
  const db = dbBefore231();
  try {
    seedClinic(db);
    migrate(db);
    db.prepare("UPDATE crm_requests SET sources = '[\"instagram\",\"referral\"]' WHERE id = 2").run();   // уже выбрано на экране
    const snap = db.prepare('SELECT id, source, sources FROM crm_requests ORDER BY id').all();
    // Бэкфилл — всё, что в файле после ALTER TABLE.
    const backfill = SQL.slice(SQL.search(/^UPDATE\s+crm_requests/im));
    assert.match(backfill, /^UPDATE\s+crm_requests/i, 'в файле нет бэкфилла UPDATE crm_requests');
    let changes = 0;
    for (const stmt of backfill.split(';').map((s) => s.trim()).filter((s) => s && !/^--/.test(s))) changes += db.prepare(stmt).run().changes;
    assert.equal(changes, 0, 'повторный бэкфилл переписал заявки');
    migrate(db);
    assert.deepEqual(db.prepare('SELECT id, source, sources FROM crm_requests ORDER BY id').all(), snap);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM schema_migrations WHERE name = ?').get(FILE).n, 1);
  } finally { db.close(); }
});

test('231: заявка без source остаётся с пустым sources (правило чтения даст «Другое»)', () => {
  const db = dbBefore231();
  try {
    seedClinic(db);
    migrate(db);
    assert.equal(db.prepare('SELECT sources FROM crm_requests WHERE id = 4').get().sources, null);
  } finally { db.close(); }
});

test('231: чистая база — колонка есть, таблица не пересобрана (ссылки на неё целы)', () => {
  const db = openDb(':memory:');
  try {
    migrate(db);
    const col = db.prepare("SELECT type, \"notnull\" AS nn, dflt_value AS d FROM pragma_table_info('crm_requests') WHERE name = 'sources'").get();
    assert.deepEqual(col, { type: 'TEXT', nn: 0, d: null });
    assert.doesNotMatch(SQL, /DROP\s+TABLE|CREATE\s+TABLE/i, 'crm_requests пересобирать нельзя — только ADD COLUMN');
  } finally { db.close(); }
});

test('231: реестр — sources читают и пишут те же роли, что source; колонка JSON', () => {
  assert.ok(readableColumns('crm_requests').includes('sources'));
  assert.ok(writableColumns('crm_requests', 'insert').includes('sources'));
  assert.ok(writableColumns('crm_requests', 'update').includes('sources'));
  assert.deepEqual(jsonColumns('crm_requests'), ['sources']);
});
