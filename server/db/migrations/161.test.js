// CASHBACK_SERVER_V2, третья проверка (мигр. 161) — счета, по которым уже были
// деньги, отмечены «кэшбэк оценён»: задним числом кэшбэк не начисляется.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';

const MIGRATIONS = path.dirname(fileURLToPath(import.meta.url));

test('161: оплаченные и частично оплаченные счета отмечены, неоплаченные — нет', () => {
  const db = openDb(':memory:');
  try {
    const stage = tmpDir('em-mig161-');
    for (const f of fs.readdirSync(MIGRATIONS)) {
      if (parseInt(f, 10) >= 161 || !f.endsWith('.sql')) continue;
      fs.copyFileSync(path.join(MIGRATIONS, f), path.join(stage, f));
    }
    migrate(db, stage);
    const pt = db.prepare("INSERT INTO patients (full_name) VALUES ('П')").run().lastInsertRowid;
    const mk = (no, status, paid) => db.prepare('INSERT INTO invoices (invoice_number, patient_id, total_amount, paid_amount, status) VALUES (?, ?, 100, ?, ?)').run(no, pt, paid, status).lastInsertRowid;
    const paid = mk('INV-A-26-1', 'paid', 100);
    const part = mk('INV-A-26-2', 'partial', 50);
    db.prepare("INSERT INTO payments (invoice_id, amount, method) VALUES (?, 50, 'cash')").run(part);
    const unpaid = mk('INV-A-26-3', 'unpaid', 0);
    // Только 161: миграция 195 (V3120_FIX) снимает отметку с ещё не
    // оплаченных счетов — её проверяет 195.test.js.
    fs.copyFileSync(path.join(MIGRATIONS, '161_cashback_evaluated.sql'), path.join(stage, '161_cashback_evaluated.sql'));
    migrate(db, stage);
    const at = (id) => db.prepare('SELECT cashback_evaluated_at FROM invoices WHERE id = ?').get(id).cashback_evaluated_at;
    assert.ok(at(paid));
    assert.ok(at(part));
    assert.equal(at(unpaid), null);
  } finally { db.close(); }
});
