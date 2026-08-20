import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

test('021 adds service_rates and referral_rates columns to users', () => {
  const db = openDb(':memory:'); migrate(db);
  const cols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
  for (const c of ['service_rates', 'referral_rates']) {
    assert.ok(cols.includes(c), 'missing column ' + c);
  }

  // default is sane for existing rows (NOT NULL DEFAULT applies retroactively)
  db.prepare("INSERT INTO users (username, password_hash, full_name, role) VALUES ('x','h','X','admin')").run();
  const row = db.prepare("SELECT * FROM users WHERE username='x'").get();
  assert.equal(row.service_rates, '');
  assert.equal(row.referral_rates, '');
});
