import test from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { hashPassword } from '../services/vendor-auth.js';
import { createApp } from '../app.js';
import { VENDOR_SESSION_COOKIE } from './vendor-auth.js';
import { listen } from '../test-helpers/listen.js';

// --- test harness ------------------------------------------------------------

function freshDb() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

function withVendorUser(db, username, password) {
  db.prepare('INSERT INTO vendor_users (username, password_hash, full_name) VALUES (?,?,?)')
    .run(username, hashPassword(password), 'Test Vendor');
  return db;
}

async function post(server, path, body, cookie) {
  return fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body ?? {}),
  });
}

async function get(server, path, cookie) {
  return fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    headers: cookie ? { Cookie: cookie } : {},
  });
}

// Extracts the emsid-shaped cookie pair ("name=value") from a Set-Cookie
// response, ready to be sent straight back on the next request — same
// convention server/routes/multi-role-access.test.js uses for the clinic app.
function cookieFrom(res) {
  const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')];
  return set.map((c) => c.split(';')[0]).join('; ');
}

// --- login / logout / me ------------------------------------------------------

test('POST /cp/v1/auth/login: wrong credentials are rejected, correct ones set an HttpOnly SameSite=Lax cookie', async (t) => {
  const db = withVendorUser(freshDb(), 'vendor', 'secret123');
  const app = createApp(db);
  const server = await listen(app); t.after(() => server.close());

  const wrong = await post(server, '/cp/v1/auth/login', { username: 'vendor', password: 'nope' });
  assert.equal(wrong.status, 401);
  assert.equal((await wrong.json()).error.code, 'invalid_credentials');

  const ok = await post(server, '/cp/v1/auth/login', { username: 'vendor', password: 'secret123' });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.user.username, 'vendor');
  assert.ok(!('password_hash' in body.user));

  const setCookie = ok.headers.get('set-cookie');
  assert.ok(setCookie.includes(VENDOR_SESSION_COOKIE + '='), 'must set the vendor session cookie');
  assert.ok(/HttpOnly/i.test(setCookie), 'cookie must be HttpOnly');
  assert.ok(/SameSite=Lax/i.test(setCookie), 'cookie must be SameSite=Lax');
});

test('GET /cp/v1/auth/me: 401 with no cookie, 200 with a valid session', async (t) => {
  const db = withVendorUser(freshDb(), 'vendor', 'secret123');
  const app = createApp(db);
  const server = await listen(app); t.after(() => server.close());

  const anon = await get(server, '/cp/v1/auth/me');
  assert.equal(anon.status, 401);

  const login = await post(server, '/cp/v1/auth/login', { username: 'vendor', password: 'secret123' });
  const cookie = cookieFrom(login);

  const me = await get(server, '/cp/v1/auth/me', cookie);
  assert.equal(me.status, 200);
  assert.equal((await me.json()).user.username, 'vendor');
});

test('POST /cp/v1/auth/logout: clears the session — /me then answers 401 with the same cookie', async (t) => {
  const db = withVendorUser(freshDb(), 'vendor', 'secret123');
  const app = createApp(db);
  const server = await listen(app); t.after(() => server.close());

  const login = await post(server, '/cp/v1/auth/login', { username: 'vendor', password: 'secret123' });
  const cookie = cookieFrom(login);

  const logout = await post(server, '/cp/v1/auth/logout', {}, cookie);
  assert.equal(logout.status, 200);

  const me = await get(server, '/cp/v1/auth/me', cookie);
  assert.equal(me.status, 401, 'the session must be dead after logout, even presenting the same cookie');
});

// --- session fixation, through the real HTTP layer ---------------------------

test('logging in twice issues two different session cookies', async (t) => {
  const db = withVendorUser(freshDb(), 'vendor', 'secret123');
  const app = createApp(db);
  const server = await listen(app); t.after(() => server.close());

  const first = await post(server, '/cp/v1/auth/login', { username: 'vendor', password: 'secret123' });
  const second = await post(server, '/cp/v1/auth/login', { username: 'vendor', password: 'secret123' });
  assert.notEqual(cookieFrom(first), cookieFrom(second));
});

// --- per-IP throttle ----------------------------------------------------------

test('the per-IP login limit engages under a flood of attempts', async (t) => {
  const db = withVendorUser(freshDb(), 'vendor', 'secret123');
  const app = createApp(db);
  const server = await listen(app); t.after(() => server.close());

  let sawThrottled = false;
  for (let i = 0; i < 15; i++) {
    const res = await post(server, '/cp/v1/auth/login', { username: 'vendor', password: 'wrong' });
    if (res.status === 429) { sawThrottled = true; break; }
    assert.equal(res.status, 401);
  }
  assert.ok(sawThrottled, 'a flood of login attempts from one IP must eventually be throttled');
});
