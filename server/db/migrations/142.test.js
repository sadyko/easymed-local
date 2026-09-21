// CRM_REAL_BOOKING_V1 (mig 142) — у строки заявки появляется ЕЁ визит.
//
// Форма проверки — та же, что у 140: колонка есть и пуста у старых строк ·
// реестр её читает, фильтрует и принимает · повторный накат ничего не ломает.
// Плюс две проверки, ради которых эта колонка и заведена именно ссылкой:
// внешний ключ (несуществующий визит в неё не записать) и индекс (сетка
// календаря спрашивает «из какой заявки эта запись» про все блоки дня разом).
// И одна — ради того, чего она делать НЕ должна: уезжать в другое здание.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';
import { writableColumns, readableColumns, filterAllowed } from '../schema-registry.js';
import { SHIPPED } from '../../services/branch-sync/journal.js';

const MIGRATIONS = path.dirname(fileURLToPath(import.meta.url));

function seedPatientVisit(db) {
  db.prepare("INSERT INTO patients (id, full_name) VALUES (1,'П')").run();
  db.prepare("INSERT INTO visits (id, patient_id, visit_date) VALUES (10, 1, '2026-09-21T09:00:00Z')").run();
  const rid = db.prepare("INSERT INTO crm_requests (full_name, phone, status, patient_id) VALUES ('Лид','1','scheduled',1)")
    .run().lastInsertRowid;
  return rid;
}

test('142: у строки заявки есть visit_id — пустой по умолчанию, ссылкой на визит', () => {
  const db = openDb(':memory:');
  migrate(db);
  try {
    const col = db.prepare('PRAGMA table_info(crm_request_services)').all().find((c) => c.name === 'visit_id');
    assert.ok(col, 'нет колонки crm_request_services.visit_id');
    assert.equal(col.notnull, 0, 'visit_id обязан допускать пустоту: строка «на дату» слота не держит');
    assert.equal(col.dflt_value, null);

    // Внешний ключ — это и есть смысл колонки: «слот, который держит эта
    // строка». Номер визита, которого нет, в неё записать нельзя.
    const fks = db.prepare('PRAGMA foreign_key_list(crm_request_services)').all();
    const fk = fks.find((f) => f.from === 'visit_id');
    assert.ok(fk, 'visit_id заведён без внешнего ключа');
    assert.equal(fk.table, 'visits');

    const rid = seedPatientVisit(db);
    const lid = db.prepare('INSERT INTO crm_request_services (request_id, scheduled_date) VALUES (?,?)')
      .run(rid, '2026-09-21').lastInsertRowid;
    assert.equal(db.prepare('SELECT visit_id FROM crm_request_services WHERE id=?').get(lid).visit_id, null,
      'у строки без записи появился визит из ниоткуда');

    db.prepare('UPDATE crm_request_services SET visit_id = 10 WHERE id = ?').run(lid);
    assert.equal(db.prepare('SELECT visit_id FROM crm_request_services WHERE id=?').get(lid).visit_id, 10);
    assert.throws(() => db.prepare('UPDATE crm_request_services SET visit_id = 9999 WHERE id = ?').run(lid),
      /FOREIGN KEY/i, 'в visit_id записался визит, которого нет');
  } finally { db.close(); }
});

test('142: обратный вопрос календаря идёт по индексу, а не перебором таблицы', () => {
  const db = openDb(':memory:');
  migrate(db);
  try {
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_crm_req_services_visit'").get(),
      'индекс по visit_id не создан: «из какой заявки эта запись» станет полным перебором на каждую перерисовку календаря');
    const plan = db.prepare('EXPLAIN QUERY PLAN SELECT id FROM crm_request_services WHERE visit_id IN (1,2,3)').all()
      .map((r) => r.detail).join(' ');
    assert.match(plan, /idx_crm_req_services_visit/, 'запрос сетки календаря не берёт индекс: ' + plan);
  } finally { db.close(); }
});

test('142: реестр отдаёт visit_id на чтение, фильтр и запись — тем же, кто пишет саму строку', () => {
  assert.ok(readableColumns('crm_request_services').includes('visit_id'), 'visit_id не читается');
  assert.ok(filterAllowed('crm_request_services', 'visit_id'),
    'по visit_id нельзя отфильтровать: сетка календаря спрашивает про все блоки дня одним `in`');
  for (const op of ['insert', 'update']) {
    assert.ok(writableColumns('crm_request_services', op).includes('visit_id'), 'visit_id не принимается при ' + op);
  }
});

// ФИЛИАЛАМ ЭТА КОЛОНКА НЕ ЕЗДИТ. visit_id — id ЭТОЙ базы; у соседа под тем же
// номером лежит чужая строка (потому визиты и ездят по uid, миграция 083).
// Обмен везёт ровно те таблицы, что перечислены в SHIPPED, и доски заявок там
// нет вовсе — проверка пришпиливает именно это, чтобы колонку не внесли туда
// «за компанию» при следующей правке обмена.
test('142: строки заявки и их визит не уезжают в другое здание', () => {
  assert.ok(!Object.prototype.hasOwnProperty.call(SHIPPED, 'crm_request_services'),
    'доска заявок попала в обмен между зданиями: visit_id у соседа указывает в чужую строку');
  for (const [tbl, cols] of Object.entries(SHIPPED)) {
    assert.ok(!cols.includes('visit_id'), `visit_id уехал бы филиалам в составе ${tbl}`);
  }
  const db = openDb(':memory:');
  migrate(db);
  try {
    // Журнальных триггеров у этой таблицы нет (миграция 084 завела их четырём
    // таблицам обмена), поэтому правка visit_id не даёт обмену ни записи.
    const trigs = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='crm_request_services'").all();
    assert.deepEqual(trigs, [], 'у строк заявки появились триггеры обмена: ' + JSON.stringify(trigs));
  } finally { db.close(); }
});

test('142 ложится на базу с заявками и не трогает уже заведённые строки', () => {
  const db = openDb(':memory:');
  const stage = tmpDir('em-mig142-');
  for (const f of fs.readdirSync(MIGRATIONS)) {
    if (parseInt(f, 10) >= 142 || !f.endsWith('.sql')) continue;
    fs.copyFileSync(path.join(MIGRATIONS, f), path.join(stage, f));
  }
  migrate(db, stage);
  const rid = seedPatientVisit(db);
  db.prepare("INSERT INTO crm_request_services (request_id, scheduled_date, status) VALUES (?,?,'pending')")
    .run(rid, '2026-09-22');

  migrate(db);
  migrate(db);   // повторный прогон — ничего не ломает и не задваивает

  const row = db.prepare('SELECT scheduled_date, status, visit_id FROM crm_request_services WHERE request_id=?').get(rid);
  assert.deepEqual(row, { scheduled_date: '2026-09-22', status: 'pending', visit_id: null },
    'миграция переписала строку, заведённую до неё');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='index' AND name='idx_crm_req_services_visit'").get().n, 1);
  db.close();
});
