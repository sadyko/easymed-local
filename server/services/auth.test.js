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

// --- OPS_EVENTS_V1 -----------------------------------------------------------

test('a wrong password records one failed_login ops_event', () => {
  const db = withUser(freshDb(), 'opslog1');
  login(db, 'opslog1', 'wrong');
  const rows = db.prepare('SELECT * FROM ops_events').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'failed_login');
  assert.equal(rows[0].route, null, 'no username, no IP — the event carries nothing identifying');
});

test('an unknown username records the SAME kind as a wrong password — no distinguishing which usernames exist', () => {
  const db = freshDb();
  login(db, 'no-such-user-at-all', 'whatever');
  const rows = db.prepare('SELECT * FROM ops_events').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'failed_login');
});

test('a successful login records no failed_login event', () => {
  const db = withUser(freshDb(), 'opslog2');
  login(db, 'opslog2', 'secret123');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ops_events').get().n, 0);
});

test('login still works when the ops_events table does not exist yet (recordEvent must never break the login path)', () => {
  const db = openDb(':memory:'); // deliberately unmigrated: no users table either, so use raw SQL setup below
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, password_hash TEXT, full_name TEXT, role TEXT, extra_roles TEXT, is_active INTEGER DEFAULT 1);
           CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id INTEGER, expires_at TEXT);`);
  db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?,?,?)').run('bare', hashPassword('secret123'), 'admin');
  assert.doesNotThrow(() => login(db, 'bare', 'wrong'));
  assert.equal(login(db, 'bare', 'wrong').error, 'invalid', 'the actual login result must be unaffected');
});

// --- timing: recording the event on the shared failure branch must not ------
// --- introduce (or worsen) a gap between "no such user" and "wrong password" -

test('adding the failed_login write does not break cost-equalisation between an unknown user and a wrong password', () => {
  const db = withUser(freshDb(), 'timing-user');

  function timeIt(fn, iterations) {
    const start = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) fn();
    const end = process.hrtime.bigint();
    return Number(end - start) / iterations / 1e6; // ms/call
  }

  const ITER = 8;
  const unknownMs = timeIt(() => login(db, `no-such-user-${Math.random()}`, 'whatever-password'), ITER);
  const wrongPwMs = timeIt(() => login(db, 'timing-user', 'definitely-wrong'), ITER);

  // Same bounds and reasoning as vendor-auth.test.js's equivalent test: both
  // paths run bcrypt.compareSync against a real cost-10 hash, and both now
  // also run the same recordEvent() write, so the ratio should be unchanged
  // by this task's instrumentation.
  assert.ok(unknownMs > 2, `unknown-username login should cost real bcrypt time, took ${unknownMs}ms`);
  assert.ok(wrongPwMs > 2, `wrong-password login should cost real bcrypt time, took ${wrongPwMs}ms`);
  const ratio = Math.max(unknownMs, wrongPwMs) / Math.min(unknownMs, wrongPwMs);
  assert.ok(ratio < 4, `unknown-username (${unknownMs}ms) and wrong-password (${wrongPwMs}ms) should be comparable, ratio was ${ratio}`);
});
