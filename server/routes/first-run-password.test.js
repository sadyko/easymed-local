import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { bootstrapAdmin, FIRST_RUN_PASSWORD } from '../services/auth.js';
import { createApp } from '../app.js';

// FIRST_RUN_PASSWORD_V1 — the whole point of the fixed default password is the
// gate that comes with it: until the first-run admin sets their own password,
// the API refuses everything except the auth endpoints that lead out of that
// state. These tests exercise the gate over real HTTP, because the gate is
// app.js mounting order, and only a real request stack tests mounting order.

function makeApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-frp-'));
  const db = openDb(':memory:');
  migrate(db);
  bootstrapAdmin(db);   // deliberately NOT clearing the flag — the flag is the subject here
  return { db, dir, app: createApp(db, { dataDir: dir }) };
}

const listen = (app) => new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });

async function login(server, password = FIRST_RUN_PASSWORD) {
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password }),
  });
  return { res, cookie: res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ') };
}

const request = (server, cookie, method, url, body) =>
  fetch(`http://127.0.0.1:${server.address().port}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

test('a flagged user may log in and see themselves, but every other API answers 403 password_change_required', async (t) => {
  const { app } = makeApp();
  const server = await listen(app);
  t.after(() => server.close());

  const { res, cookie } = await login(server);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).user.must_change_password, true);

  const me = await request(server, cookie, 'GET', '/api/auth/me');
  assert.equal(me.status, 200, '/api/auth/me must stay reachable — the login page needs it');

  for (const [method, url, body] of [
    ['POST', '/api/db', { table: 'patients', op: 'select', columns: '*' }],
    ['POST', '/api/rpc/licence_status', {}],
    ['GET',  '/api/users'],
  ]) {
    const r = await request(server, cookie, method, url, body);
    assert.equal(r.status, 403, `${url} must be gated`);
    assert.equal((await r.json()).error.code, 'password_change_required');
  }
});

test('the gate does not swallow anonymous requests — those still get their own 401', async (t) => {
  const { app } = makeApp();
  const server = await listen(app);
  t.after(() => server.close());
  const r = await request(server, null, 'POST', '/api/db', { table: 'patients', op: 'select', columns: '*' });
  assert.equal(r.status, 401);
});

test('change-password with the right current password lifts the gate for the SAME session', async (t) => {
  const { db, app } = makeApp();
  const server = await listen(app);
  t.after(() => server.close());
  const { cookie } = await login(server);

  const wrong = await request(server, cookie, 'POST', '/api/auth/change-password',
    { current_password: 'not-the-default', new_password: 'my-real-password' });
  assert.equal(wrong.status, 401);

  const weak = await request(server, cookie, 'POST', '/api/auth/change-password',
    { current_password: FIRST_RUN_PASSWORD, new_password: 'short' });
  assert.equal(weak.status, 400);
  assert.equal((await weak.json()).error.code, 'weak_password');

  const ok = await request(server, cookie, 'POST', '/api/auth/change-password',
    { current_password: FIRST_RUN_PASSWORD, new_password: 'my-real-password' });
  assert.equal(ok.status, 200);

  // Same cookie, no re-login: the caller's session survives and is no longer gated.
  const after = await request(server, cookie, 'POST', '/api/rpc/licence_status', {});
  assert.notEqual(after.status, 403, 'the gate must lift immediately for the session that changed the password');
  assert.equal(db.prepare("SELECT must_change_password FROM users WHERE username = 'admin'").get().must_change_password, 0);
});

test('change-password requires a session at all', async (t) => {
  const { app } = makeApp();
  const server = await listen(app);
  t.after(() => server.close());
  const r = await request(server, null, 'POST', '/api/auth/change-password',
    { current_password: FIRST_RUN_PASSWORD, new_password: 'my-real-password' });
  assert.equal(r.status, 401);
});
