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

test('refuses to run when two migrations share a number prefix', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-mig-'));
  fs.writeFileSync(path.join(dir, '001_a.sql'), 'CREATE TABLE a (id INTEGER);');
  fs.writeFileSync(path.join(dir, '001_b.sql'), 'CREATE TABLE b (id INTEGER);');
  const db = openDb(':memory:');
  assert.throws(() => migrate(db, dir), /Duplicate migration number: 001/);
  // and nothing was applied
  const applied = db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name IN ('a','b')").get();
  assert.equal(applied.n, 0);
});

test('the real migrations directory still runs despite its historical collisions', () => {
  // 058 and 071 collide and are deliberately grandfathered — see the comment in
  // migrate.js. If this test fails, someone removed the exemption and every
  // existing clinic would refuse to start.
  const db = openDb(':memory:');
  assert.doesNotThrow(() => migrate(db));
});

test('a NEW file under a grandfathered number is still refused', () => {
  // The exemption forgives five specific files, not the numbers 058 and 071.
  // Without this test the guard silently stops guarding at exactly the two
  // numbers most likely to be reused by accident.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-mig-'));
  fs.writeFileSync(path.join(dir, '058_crm_line_doctor.sql'), 'CREATE TABLE a (id INTEGER);');
  fs.writeFileSync(path.join(dir, '058_referral_source_person.sql'), 'CREATE TABLE b (id INTEGER);');
  fs.writeFileSync(path.join(dir, '058_brand_new_mistake.sql'), 'CREATE TABLE c (id INTEGER);');
  const db = openDb(':memory:');
  assert.throws(() => migrate(db, dir), /Duplicate migration number: 058/);
});

test('the same number padded differently is still one number', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-mig-'));
  fs.writeFileSync(path.join(dir, '001_a.sql'), 'CREATE TABLE a (id INTEGER);');
  fs.writeFileSync(path.join(dir, '0001_b.sql'), 'CREATE TABLE b (id INTEGER);');
  const db = openDb(':memory:');
  assert.throws(() => migrate(db, dir), /Duplicate migration number/);
});
