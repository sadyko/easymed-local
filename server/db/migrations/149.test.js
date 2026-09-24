// INPATIENT_SHARE_V1, ревью C1 (mig 149) — индекс строк визита по строке счёта.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

test('149: индекс visit_services(invoice_item_id) есть, и поиск по строке счёта идёт по нему', () => {
  const db = openDb(':memory:');
  migrate(db);
  try {
    const idx = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_visit_services_invoice_item'").get();
    assert.ok(idx, 'нет индекса idx_visit_services_invoice_item');
    assert.match(idx.sql, /visit_services\s*\(\s*invoice_item_id\s*\)/);
    const plan = db.prepare('EXPLAIN QUERY PLAN SELECT 1 FROM visit_services WHERE invoice_item_id = ?').all(1)
      .map((r) => r.detail).join(' | ');
    assert.match(plan, /idx_visit_services_invoice_item/, plan);
  } finally { db.close(); }
});

test('149: повторный накат ничего не ломает', () => {
  const db = openDb(':memory:');
  migrate(db);
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_visit_services_invoice_item ON visit_services(invoice_item_id);');
    migrate(db);
    const n = db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type = 'index' AND name = 'idx_visit_services_invoice_item'").get().c;
    assert.equal(n, 1);
  } finally { db.close(); }
});
