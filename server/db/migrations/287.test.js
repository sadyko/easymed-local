// WAIT_REG_V1 (ревью) — миграция 287: номер строки визита в журнале правок строк.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';

const MIGRATIONS = path.dirname(fileURLToPath(import.meta.url));

/** База версии до 287: все миграции ниже 287. */
function before287() {
  const db = openDb(':memory:');
  const stage = tmpDir('em-mig287-');
  for (const f of fs.readdirSync(MIGRATIONS)) {
    if (parseInt(f, 10) >= 287 || !f.endsWith('.sql')) continue;
    fs.copyFileSync(path.join(MIGRATIONS, f), path.join(stage, f));
  }
  migrate(db, stage);
  return db;
}

test('287: invoice_audit_log.visit_service_id — новая пустая колонка с частичным индексом; прежние строки журнала не тронуты', () => {
  const db = before287();
  try {
    db.prepare("INSERT INTO invoice_audit_log (visit_id, action, reason, notes) VALUES (NULL, 'line_referral_skipped', 'было', 'строка визита № 7')").run();
    db.prepare("INSERT INTO invoice_audit_log (visit_id, action, amount) VALUES (NULL, 'invoice_created', 120000)").run();
    const before = db.prepare('SELECT * FROM invoice_audit_log ORDER BY id').all();
    migrate(db);
    const cols = db.prepare('PRAGMA table_info(invoice_audit_log)').all().map((c) => c.name);
    assert.ok(cols.includes('visit_service_id'));
    const after = db.prepare('SELECT * FROM invoice_audit_log ORDER BY id').all();
    assert.equal(after.length, before.length);
    for (const [i, r] of before.entries()) {
      for (const [k, v] of Object.entries(r)) assert.equal(after[i][k], v, 'колонка ' + k + ' изменилась');
      assert.equal(after[i].visit_service_id, null);
    }
    const idx = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_invoice_audit_log_vs'").get();
    assert.ok(idx && /WHERE visit_service_id IS NOT NULL/.test(idx.sql), 'нет частичного индекса');
    // Пропуски по строке визита ищутся индексом.
    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT 1 FROM invoice_audit_log WHERE visit_service_id = ? AND action = 'line_referral_skipped'").all(1)
      .map((r) => r.detail).join(' | ');
    assert.match(plan, /idx_invoice_audit_log_vs/);
    // Повторный запуск ничего не меняет.
    migrate(db);
    assert.deepEqual(db.prepare('SELECT * FROM invoice_audit_log ORDER BY id').all(), after);
  } finally { db.close(); }
});
