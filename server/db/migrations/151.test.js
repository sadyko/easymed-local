// CRM_HEAD_MERGE_TAGS_V1 (mig 151) — журнал слияния дублей заявок CRM.
//
// Форма проверки — та же, что у 148: таблица и её колонки · нет внешних ключей
// (журнал переживает и заявку, и сотрудника) · в другое здание не уезжает ·
// через /api/db не читается · повторный накат ничего не ломает.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';
import { tableEntry } from '../schema-registry.js';
import { SHIPPED } from '../../services/branch-sync/journal.js';

const MIGRATIONS = path.dirname(fileURLToPath(import.meta.url));

test('151: crm_merge_log — колонки, без внешних ключей, индекс по оставшейся карточке', () => {
  const db = openDb(':memory:');
  try {
    migrate(db);
    const cols = db.prepare('PRAGMA table_info(crm_merge_log)').all().map((c) => c.name);
    assert.deepEqual(cols, ['id', 'kept_id', 'merged_ids', 'snapshot', 'actor_id', 'actor_name', 'created_at']);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_list(crm_merge_log)').all(), [], 'журнал держит внешний ключ — он мешал бы удалить заявку или сотрудника');
    const id = db.prepare("INSERT INTO crm_merge_log (kept_id, merged_ids, snapshot) VALUES (1, '[2]', '{}')").run().lastInsertRowid;
    assert.match(db.prepare('SELECT created_at FROM crm_merge_log WHERE id = ?').get(id).created_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='index' AND name = 'idx_crm_merge_log_kept'").get().n, 1);
  } finally { db.close(); }
});

test('151: журнал не уезжает в другое здание и не открыт через /api/db', () => {
  assert.ok(!Object.prototype.hasOwnProperty.call(SHIPPED, 'crm_merge_log'), 'журнал слияний попал в обмен между зданиями');
  assert.ok(!tableEntry('crm_merge_log'), 'журнал слияний открыт экранам через /api/db');
  const db = openDb(':memory:');
  try {
    migrate(db);
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='crm_merge_log'").all(), []);
  } finally { db.close(); }
});

test('151 ложится на базу с заявками и повторный накат ничего не ломает', () => {
  const db = openDb(':memory:');
  const stage = tmpDir('em-mig151-');
  for (const f of fs.readdirSync(MIGRATIONS)) {
    if (parseInt(f, 10) >= 151 || !f.endsWith('.sql')) continue;
    fs.copyFileSync(path.join(MIGRATIONS, f), path.join(stage, f));
  }
  migrate(db, stage);
  db.prepare("INSERT INTO crm_requests (id, full_name, phone, status) VALUES (5,'Лид','1','in_process')").run();
  migrate(db);
  migrate(db);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM crm_requests').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM crm_merge_log').get().n, 0);
  db.close();
});
