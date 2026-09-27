// V3120_FINAL (мигр. 213) — money_idempotency.fingerprint: отпечаток формы
// квитанции; старые квитанции без него остаются (NULL).
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

test('213: money_idempotency.fingerprint — есть, необязательна', () => {
  const db = openDb(':memory:');
  try {
    migrate(db);
    const cols = db.prepare('PRAGMA table_info(money_idempotency)').all().map((c) => c.name);
    assert.ok(cols.includes('fingerprint'));
    db.prepare("INSERT INTO money_idempotency (key, rpc, result) VALUES ('old-key-0001', 'record_payment', '{}')").run();
    assert.equal(db.prepare("SELECT fingerprint f FROM money_idempotency WHERE key = 'old-key-0001'").get().f, null);
  } finally { db.close(); }
});
