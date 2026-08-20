import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

test('018 adds employee fields to users', () => {
  const db = openDb(':memory:'); migrate(db);
  const cols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
  for (const c of [
    'first_name', 'last_name', 'middle_name', 'phone', 'email', 'specialty',
    'is_doctor', 'department_id', 'position', 'doctor_category', 'hire_date',
    'license_number', 'license_expiry_date', 'employment_type', 'salary_type',
    'salary_fixed', 'salary_percent',
  ]) {
    assert.ok(cols.includes(c), 'missing column ' + c);
  }

  // defaults are sane for existing rows (NOT NULL DEFAULT applies retroactively)
  db.prepare("INSERT INTO users (username, password_hash, full_name, role) VALUES ('x','h','X','admin')").run();
  const row = db.prepare("SELECT * FROM users WHERE username='x'").get();
  assert.equal(row.first_name, '');
  assert.equal(row.is_doctor, 0);
  assert.equal(row.department_id, null);
  assert.equal(row.salary_fixed, 0);
  assert.equal(row.salary_percent, 0);

  // department_id FK is enforced (foreign_keys=ON per connection.js)
  assert.throws(() => db.prepare("UPDATE users SET department_id=999999 WHERE username='x'").run());
});
