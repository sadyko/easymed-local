import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

test('019 adds employee staff-category fields to users', () => {
  const db = openDb(':memory:'); migrate(db);
  const cols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
  for (const c of [
    'staff_type', 'scheduling_mode', 'branch_id', 'working_hours',
    'service_rate_default', 'referral_rate_default',
  ]) {
    assert.ok(cols.includes(c), 'missing column ' + c);
  }

  // defaults are sane for existing rows (NOT NULL DEFAULT applies retroactively)
  db.prepare("INSERT INTO users (username, password_hash, full_name, role) VALUES ('x','h','X','admin')").run();
  const row = db.prepare("SELECT * FROM users WHERE username='x'").get();
  assert.equal(row.staff_type, '');
  assert.equal(row.scheduling_mode, 'schedulable');
  assert.equal(row.branch_id, null);
  assert.equal(row.working_hours, '');
  assert.equal(row.service_rate_default, 0);
  assert.equal(row.referral_rate_default, 0);

  // branch_id FK is enforced (foreign_keys=ON per connection.js)
  assert.throws(() => db.prepare("UPDATE users SET branch_id=999999 WHERE username='x'").run());
});
