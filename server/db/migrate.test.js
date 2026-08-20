import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from './connection.js';
import { migrate } from './migrate.js';

test('migrate creates tables and is idempotent', () => {
  const db = openDb(':memory:');
  migrate(db);
  migrate(db); // second run must be a no-op, not an error
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  assert.ok(tables.includes('users'));
  assert.ok(tables.includes('sessions'));
  assert.ok(tables.includes('schema_migrations'));
});

test('a failing migration rolls back and is not marked applied', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
  fs.writeFileSync(path.join(dir, '001_bad.sql'), 'CREATE TABLE x (id INTEGER); SELECT not_valid_sql;');
  const db = openDb(':memory:');
  assert.throws(() => migrate(db, dir));
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='x'").get(), undefined);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get().c, 0);
});

test('badly named migration file is rejected', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
  fs.writeFileSync(path.join(dir, '1_unpadded.sql'), 'CREATE TABLE y (id INTEGER);');
  const db = openDb(':memory:');
  assert.throws(() => migrate(db, dir), /Bad migration filename/);
});
