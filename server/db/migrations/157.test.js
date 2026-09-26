// DEPOSIT_WALLET_V1 (мигр. 157) — вид строки баланса, ссылка на платёж и причина.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

test('157: patient_deposits.kind (deposit по умолчанию, только три вида), payment_id, reason', () => {
  const db = openDb(':memory:');
  try {
    migrate(db);
    const cols = Object.fromEntries(db.prepare('PRAGMA table_info(patient_deposits)').all().map((c) => [c.name, c]));
    assert.ok(cols.kind && cols.payment_id && cols.reason);
    const pt = db.prepare("INSERT INTO patients (full_name) VALUES ('П')").run().lastInsertRowid;
    const d = db.prepare('INSERT INTO patient_deposits (patient_id, amount) VALUES (?, 100)').run(pt).lastInsertRowid;
    assert.equal(db.prepare('SELECT kind FROM patient_deposits WHERE id = ?').get(d).kind, 'deposit', 'старые строки — депозиты');
    assert.throws(() => db.prepare("INSERT INTO patient_deposits (patient_id, amount, kind) VALUES (?, 1, 'gift')").run(pt));
  } finally { db.close(); }
});
