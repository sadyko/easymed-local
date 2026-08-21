import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

function freshDb() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

function insertUser(db, username, overrides = {}) {
  return db.prepare(
    `INSERT INTO vendor_users (username, password_hash, full_name, active) VALUES (?, ?, ?, ?)`
  ).run(
    username,
    overrides.password_hash ?? 'hash',
    overrides.full_name ?? '',
    overrides.active ?? 1,
  );
}

test('002: vendor_users.username is unique, case-insensitively (COLLATE NOCASE)', () => {
  // Same collation as the clinic app's own `users.username` column — a vendor
  // typing their name with different capitalisation across two sessions must
  // not be able to create a second, distinct account by accident.
  const db = freshDb();
  insertUser(db, 'admin');
  assert.throws(() => insertUser(db, 'Admin'), /UNIQUE constraint failed/);
  assert.throws(() => insertUser(db, 'ADMIN'), /UNIQUE constraint failed/);
});

test('002: vendor_users requires username and password_hash', () => {
  const db = freshDb();
  assert.throws(
    () => db.prepare(`INSERT INTO vendor_users (password_hash) VALUES (?)`).run('hash'),
    /NOT NULL constraint failed/,
  );
  assert.throws(
    () => db.prepare(`INSERT INTO vendor_users (username) VALUES (?)`).run('nouser'),
    /NOT NULL constraint failed/,
  );
});

test('002: vendor_users.active defaults to 1, full_name defaults to empty string', () => {
  const db = freshDb();
  insertUser(db, 'someone', { active: undefined, full_name: undefined });
  const row = db.prepare('SELECT active, full_name FROM vendor_users WHERE username = ?').get('someone');
  assert.equal(row.active, 1);
  assert.equal(row.full_name, '');
});

test('002: vendor_users.created_at is auto-populated', () => {
  const db = freshDb();
  insertUser(db, 'someone');
  const row = db.prepare('SELECT created_at FROM vendor_users WHERE username = ?').get('someone');
  assert.ok(row.created_at, 'created_at should be auto-populated');
});

test('002: a vendor_session requires user_id and expires_at', () => {
  const db = freshDb();
  const info = insertUser(db, 'someone');
  assert.throws(
    () => db.prepare(`INSERT INTO vendor_sessions (id, user_id) VALUES (?, ?)`).run('sid-1', info.lastInsertRowid),
    /NOT NULL constraint failed/,
  );
});

test('002: deleting a vendor_user cascades to its vendor_sessions', () => {
  // Mirrors the clinic app's own users/sessions cascade — a deleted account
  // must not leave orphaned session rows a stale cookie could still resolve
  // through some future bug in sessionUser().
  const db = freshDb();
  const info = insertUser(db, 'someone');
  const userId = info.lastInsertRowid;
  db.prepare(`INSERT INTO vendor_sessions (id, user_id, expires_at) VALUES (?, ?, ?)`)
    .run('sid-1', userId, '2099-01-01T00:00:00Z');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM vendor_sessions').get().n, 1);

  db.prepare('DELETE FROM vendor_users WHERE id = ?').run(userId);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM vendor_sessions').get().n, 0);
});

test('002: a vendor_session id is unique (primary key)', () => {
  const db = freshDb();
  const info = insertUser(db, 'someone');
  const insert = () => db.prepare(`INSERT INTO vendor_sessions (id, user_id, expires_at) VALUES (?, ?, ?)`)
    .run('sid-dup', info.lastInsertRowid, '2099-01-01T00:00:00Z');
  insert();
  assert.throws(() => insert(), /UNIQUE constraint failed/);
});
