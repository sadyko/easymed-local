import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import {
  bootstrapVendorAdmin, login, logout, sessionUser, hashPassword, changePassword,
} from './vendor-auth.js';

// Mirrors server/services/auth.test.js closely — same behaviours, same shape
// of tests — because vendor-auth.js is deliberately a copy of that design,
// not a novel one. See vendor-auth.js's own header for the two differences
// (no role, no bootstrapping from a clinic database).

function freshDb() { const db = openDb(':memory:'); migrate(db); return db; }

test('bootstrapVendorAdmin creates a vendor admin only when there are no vendor_users', () => {
  const db = freshDb();
  const pw = bootstrapVendorAdmin(db);
  assert.ok(pw && pw.length >= 10);
  assert.equal(db.prepare('SELECT username FROM vendor_users').get().username, 'admin');
  assert.equal(bootstrapVendorAdmin(db), null); // second call: a vendor user already exists, no-op
});

test('login validates password and manages sessions', () => {
  const db = freshDb();
  db.prepare('INSERT INTO vendor_users (username, password_hash) VALUES (?,?)')
    .run('anna', hashPassword('secret123'));

  assert.equal(login(db, 'anna', 'wrong').error, 'invalid');
  const ok = login(db, 'anna', 'secret123');
  assert.ok(ok.session);
  assert.equal(ok.user.username, 'anna');

  assert.equal(sessionUser(db, ok.session).username, 'anna');
  logout(db, ok.session);
  assert.equal(sessionUser(db, ok.session), null);
  assert.equal(sessionUser(db, null), null);
});

test('inactive vendor users cannot log in', () => {
  const db = freshDb();
  db.prepare('INSERT INTO vendor_users (username, password_hash, active) VALUES (?,?,0)')
    .run('gone', hashPassword('secret123'));
  assert.equal(login(db, 'gone', 'secret123').error, 'invalid');
});

function withUser(db, name) {
  db.prepare('INSERT INTO vendor_users (username, password_hash) VALUES (?,?)')
    .run(name, hashPassword('secret123'));
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
  db.prepare('UPDATE vendor_sessions SET expires_at = ? WHERE id = ?')
    .run(new Date(Date.now() - 1000).toISOString(), session);
  assert.equal(sessionUser(db, session), null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vendor_sessions WHERE id = ?').get(session).n, 0);
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

// --- session fixation: a fresh session id every time, never derived from
// --- whatever the caller happened to present -------------------------------

test('two successive logins for the same account issue two different session ids', () => {
  const db = withUser(freshDb(), 'fixation');
  const first = login(db, 'fixation', 'secret123');
  const second = login(db, 'fixation', 'secret123');
  assert.notEqual(first.session, second.session);
  // The first session is not implicitly invalidated by the second login —
  // login() only ever ADDS a row; routes/vendor-auth.js's login route is
  // what chooses to log out the browser's own previous session, and that is
  // the caller's decision, not this function's.
  assert.equal(sessionUser(db, first.session).username, 'fixation');
});

// --- changePassword ----------------------------------------------------------

test('changePassword rejects the wrong current password', () => {
  const db = withUser(freshDb(), 'changer');
  const userId = db.prepare('SELECT id FROM vendor_users WHERE username = ?').get('changer').id;
  const result = changePassword(db, userId, 'wrong-current', 'brandnewpassword');
  assert.equal(result.error, 'wrong_password');
  // the old password must still work
  assert.ok(login(db, 'changer', 'secret123').session);
});

test('changePassword rejects a weak new password', () => {
  const db = withUser(freshDb(), 'changer2');
  const userId = db.prepare('SELECT id FROM vendor_users WHERE username = ?').get('changer2').id;
  const result = changePassword(db, userId, 'secret123', 'short');
  assert.equal(result.error, 'weak_password');
});

test('changePassword succeeds: old password stops working, new one works', () => {
  const db = withUser(freshDb(), 'changer3');
  const userId = db.prepare('SELECT id FROM vendor_users WHERE username = ?').get('changer3').id;
  const result = changePassword(db, userId, 'secret123', 'brandnewpassword1');
  assert.equal(result.ok, true);
  assert.equal(login(db, 'changer3', 'secret123').error, 'invalid');
  assert.ok(login(db, 'changer3', 'brandnewpassword1').session);
});

test('changePassword invalidates other sessions but keeps the one passed as exceptSessionId', () => {
  const db = withUser(freshDb(), 'changer4');
  const userId = db.prepare('SELECT id FROM vendor_users WHERE username = ?').get('changer4').id;
  const sessionA = login(db, 'changer4', 'secret123').session;
  const sessionB = login(db, 'changer4', 'secret123').session;

  changePassword(db, userId, 'secret123', 'brandnewpassword1', sessionB);

  assert.equal(sessionUser(db, sessionA), null, 'other sessions must be killed by a password change');
  assert.ok(sessionUser(db, sessionB), 'the session that made the change survives');
});

test('changePassword on an unknown user id fails cleanly', () => {
  const db = freshDb();
  const result = changePassword(db, 999999, 'whatever', 'brandnewpassword1');
  assert.equal(result.error, 'not_found');
});

// --- timing: a wrong username must cost about the same as a wrong password --
// --- for a real one (cost-equalised bcrypt, no free enumeration) -----------

test('a wrong username and a wrong password for a real user take comparable time', () => {
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

  // Both paths run bcrypt.compareSync against a real cost-10 hash (a dummy
  // one for the unknown user, the real one for the known user) — so neither
  // should be a fast, near-zero short-circuit. Generous bounds to avoid CI
  // flakiness: this is checking for a structural equalisation (both take
  // "bcrypt-shaped" time), not asserting a precise ratio.
  assert.ok(unknownMs > 2, `unknown-username login should cost real bcrypt time, took ${unknownMs}ms`);
  assert.ok(wrongPwMs > 2, `wrong-password login should cost real bcrypt time, took ${wrongPwMs}ms`);
  const ratio = Math.max(unknownMs, wrongPwMs) / Math.min(unknownMs, wrongPwMs);
  assert.ok(ratio < 4, `unknown-username (${unknownMs}ms) and wrong-password (${wrongPwMs}ms) should be comparable, ratio was ${ratio}`);
});
