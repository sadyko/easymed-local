import { test } from 'node:test';
import assert from 'node:assert';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

const fresh = () => { const db = openDb(':memory:'); migrate(db); return db; };

test('075 users gains must_change_password, defaulting to 0', () => {
  const db = fresh();
  db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('u1', 'x', 'registrar')").run();
  const row = db.prepare("SELECT must_change_password FROM users WHERE username = 'u1'").get();
  // Default 0: a user created through the users screen had their password
  // chosen by a human on purpose — only bootstrapAdmin sets 1, explicitly.
  assert.equal(row.must_change_password, 0);
});

test('075 the flag can be set and cleared', () => {
  const db = fresh();
  db.prepare("INSERT INTO users (username, password_hash, role, must_change_password) VALUES ('u2', 'x', 'admin', 1)").run();
  assert.equal(db.prepare("SELECT must_change_password FROM users WHERE username = 'u2'").get().must_change_password, 1);
  db.prepare("UPDATE users SET must_change_password = 0 WHERE username = 'u2'").run();
  assert.equal(db.prepare("SELECT must_change_password FROM users WHERE username = 'u2'").get().must_change_password, 0);
});
