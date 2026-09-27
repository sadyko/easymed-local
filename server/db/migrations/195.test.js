// V3120_FIX — миграции 194 (смена, закрытая в полночь, — не пересчитана) и
// 195 (кэшбэк: отметка «оценён» снимается с ещё не оплаченных счетов).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';

const MIGRATIONS = path.dirname(fileURLToPath(import.meta.url));

function stagedBefore(n) {
  const db = openDb(':memory:');
  const stage = tmpDir('em-mig' + n + '-');
  for (const f of fs.readdirSync(MIGRATIONS)) {
    if (parseInt(f, 10) >= n || !f.endsWith('.sql')) continue;
    fs.copyFileSync(path.join(MIGRATIONS, f), path.join(stage, f));
  }
  migrate(db, stage);
  return db;
}

test('194: старая автозакрытая смена теряет выдуманный пересчёт; закрытая руками — нет', () => {
  const db = stagedBefore(194);
  try {
    db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (9, 'c', 'x', 'cashier')").run();
    const mk = (counted, expected, over, notes) => db.prepare(`INSERT INTO cash_shifts (cashier_id, status, counted_amount, expected_amount, over_short, notes)
      VALUES (9, 'closed', ?, ?, ?, ?)`).run(counted, expected, over, notes).lastInsertRowid;
    const auto = mk(5000, 5000, 0, 'Открыта автоматически (начало дня) · Закрыта автоматически (конец дня 00:00)');
    const manual = mk(4000, 5000, -1000, 'пересчитано');
    migrate(db);
    const a = db.prepare('SELECT * FROM cash_shifts WHERE id = ?').get(auto);
    assert.equal(a.auto_closed, 1);
    assert.equal(a.counted_amount, null);
    assert.equal(a.over_short, null);
    assert.equal(a.expected_amount, 5000);
    const m = db.prepare('SELECT * FROM cash_shifts WHERE id = ?').get(manual);
    assert.equal(m.auto_closed, 0);
    assert.equal(m.counted_amount, 4000);
    assert.equal(m.over_short, -1000);
  } finally { db.close(); }
});

test('195: отметка кэшбэка снята только у неоплаченных счетов без возвратов и без кэшбэка', () => {
  const db = stagedBefore(195);
  try {
    const pt = db.prepare("INSERT INTO patients (full_name) VALUES ('П')").run().lastInsertRowid;
    const mk = (no, status, paid) => db.prepare(`INSERT INTO invoices (invoice_number, patient_id, total_amount, paid_amount, status, cashback_evaluated_at)
      VALUES (?, ?, 100, ?, ?, '2026-09-01T00:00:00Z')`).run(no, pt, paid, status).lastInsertRowid;
    const part = mk('INV-A-26-1', 'partial', 50);
    db.prepare("INSERT INTO payments (invoice_id, amount, method) VALUES (?, 50, 'cash')").run(part);
    const debt = mk('INV-A-26-2', 'debt', 0);
    const paid = mk('INV-A-26-3', 'paid', 100);
    const refundedPartial = mk('INV-A-26-4', 'partial', 50);
    db.prepare("INSERT INTO payments (invoice_id, amount, method) VALUES (?, 100, 'cash')").run(refundedPartial);
    db.prepare("INSERT INTO payments (invoice_id, amount, method) VALUES (?, -50, 'cash')").run(refundedPartial);
    migrate(db);
    const at = (id) => db.prepare('SELECT cashback_evaluated_at FROM invoices WHERE id = ?').get(id).cashback_evaluated_at;
    assert.equal(at(part), null);
    assert.equal(at(debt), null);
    assert.ok(at(paid), 'оплаченный не трогается');
    assert.ok(at(refundedPartial), 'счёт с возвратом уже был оплачен целиком — оценка остаётся');
    assert.ok(db.prepare("SELECT 1 FROM pragma_table_info('patient_deposits') WHERE name = 'new_money'").get());
  } finally { db.close(); }
});
