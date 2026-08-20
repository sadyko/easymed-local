import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
test('005 creates invoice_counters', () => {
  const db = openDb(':memory:'); migrate(db);
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='invoice_counters'").get());
});
