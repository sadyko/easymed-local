import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

test('020 adds extra_roles column to users', () => {
  const db = openDb(':memory:'); migrate(db);
  const cols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
  assert.ok(cols.includes('extra_roles'), 'missing column extra_roles');

  // default is sane for existing rows (NOT NULL DEFAULT applies retroactively)
  db.prepare("INSERT INTO users (username, password_hash, full_name, role) VALUES ('x','h','X','admin')").run();
  const row = db.prepare("SELECT * FROM users WHERE username='x'").get();
  assert.equal(row.extra_roles, '');
});
