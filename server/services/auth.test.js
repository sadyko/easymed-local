import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { bootstrapAdmin, login, logout, sessionUser, hashPassword } from './auth.js';

function freshDb() { const db = openDb(':memory:'); migrate(db); return db; }

test('bootstrapAdmin creates admin only when there are no users', () => {
  const db = freshDb();
  const pw = bootstrapAdmin(db);
  assert.ok(pw && pw.length >= 10);
  assert.equal(db.prepare('SELECT role FROM users WHERE username = ?').get('admin').role, 'admin');
  assert.equal(bootstrapAdmin(db), null); // second call: users exist, no-op
});

test('login validates password and manages sessions', () => {
  const db = freshDb();
  db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?,?,?)')
    .run('anna', hashPassword('secret123'), 'admin');

  assert.equal(login(db, 'anna', 'wrong').error, 'invalid');
  const ok = login(db, 'anna', 'secret123');
  assert.ok(ok.session);
  assert.equal(ok.user.username, 'anna');

  assert.equal(sessionUser(db, ok.session).username, 'anna');
  logout(db, ok.session);
  assert.equal(sessionUser(db, ok.session), null);
  assert.equal(sessionUser(db, null), null);
});

test('inactive users cannot log in', () => {
  const db = freshDb();
  db.prepare('INSERT INTO users (username, password_hash, role, is_active) VALUES (?,?,?,0)')
    .run('gone', hashPassword('secret123'), 'doctor');
  assert.equal(login(db, 'gone', 'secret123').error, 'invalid');
});

function withUser(db, name) {
  db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?,?,?)')
    .run(name, hashPassword('secret123'), 'admin');
  return db;
}

test('five wrong passwords lock the username, even for the right password', () => {
  const db = withUser(freshDb(), 'lockme');
  for (let i = 0; i < 4; i++) assert.equal(login(db, 'lockme', 'bad').error, 'invalid');
  assert.equal(login(db, 'lockme', 'bad').error, 'locked'); // 5th trips the lock
  assert.equal(login(db, 'lockme', 'secret123').error, 'locked');
});

test('a successful login clears the failure counter', () => {
  const db = withUser(freshDb(), 'resetme');
  for (let i = 0; i < 4; i++) login(db, 'resetme', 'bad');
  assert.ok(login(db, 'resetme', 'secret123').session);
  for (let i = 0; i < 4; i++) assert.equal(login(db, 'resetme', 'bad').error, 'invalid');
  assert.ok(login(db, 'resetme', 'secret123').session, 'counter must have been cleared');
});

test('expired sessions are rejected and deleted', () => {
  const db = withUser(freshDb(), 'expiry');
  const { session } = login(db, 'expiry', 'secret123');
  db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?')
    .run(new Date(Date.now() - 1000).toISOString(), session);
  assert.equal(sessionUser(db, session), null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE id = ?').get(session).n, 0);
});

test('login result never contains password_hash', () => {
  const db = withUser(freshDb(), 'nohash');
  const ok = login(db, 'nohash', 'secret123');
  assert.ok(!('password_hash' in ok.user));
});

test('hashPassword rejects non-string or empty input', () => {
  assert.throws(() => hashPassword(undefined), TypeError);
  assert.throws(() => hashPassword(''), TypeError);
});

test('lockout also applies to unknown usernames', () => {
  const db = freshDb();
  for (let i = 0; i < 4; i++) assert.equal(login(db, 'ghost-user', 'x').error, 'invalid');
  assert.equal(login(db, 'ghost-user', 'x').error, 'locked');
});

test('sessionUser result never contains password_hash', () => {
  const db = withUser(freshDb(), 'nohash2');
  const { session } = login(db, 'nohash2', 'secret123');
  assert.ok(!('password_hash' in sessionUser(db, session)));
});
