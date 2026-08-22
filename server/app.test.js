import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { openDb } from './db/connection.js';
import { migrate } from './db/migrate.js';
import { hashPassword } from './services/auth.js';
import { createApp } from './app.js';
import { licensedDataDir } from './services/control/licensed-fixture.js';   // LICENCE_CORE_V1
import { RPC } from './services/rpc/index.js';   // OPS_EVENTS_V1 — used below to prove a real finding, see the test

function startServer() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)')
    .run('boss', hashPassword('password1'), 'Boss', 'admin');
  // Wait for the 'listening' callback rather than reading server.address()
  // synchronously right after .listen(): on this Node/Windows combination
  // the bind completes asynchronously, so address() is null until then.
  return new Promise((resolve) => {
    // LICENCE_CORE_V1 — this file predates licensing and isn't testing it;
    // without an enrolled dataDir the write gate treats the real (unenrolled)
    // ./data default as locked and every write here starts 402'ing.
    const server = createApp(db, { dataDir: licensedDataDir() }).listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      resolve({ db, server, base });
    });
  });
}

async function post(base, path, body, cookie) {
  return fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
}

test('health, login flow, session cookie, unknown api route', async () => {
  const { server, base } = await startServer();
  try {
    assert.equal((await fetch(`${base}/api/health`)).status, 200);

    let res = await post(base, '/api/auth/login', { username: 'boss', password: 'nope' });
    assert.equal(res.status, 401);

    res = await post(base, '/api/auth/login', { username: 'boss', password: 'password1' });
    assert.equal(res.status, 200);
    const cookie = res.headers.get('set-cookie').split(';')[0];
    assert.match(cookie, /^emsid=/);

    res = await fetch(`${base}/api/auth/me`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).user.username, 'boss');

    res = await post(base, '/api/auth/logout', {}, cookie);
    assert.equal(res.status, 200);
    res = await fetch(`${base}/api/auth/me`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 401);

    res = await fetch(`${base}/api/no-such-thing`);
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, 'not_found');
  } finally {
    server.close();
  }
});

test('malformed cookie header does not crash the request', async () => {
  const { server, base } = await startServer();
  try {
    const res = await fetch(`${base}/api/health`, { headers: { Cookie: 'emsid=%' } });
    assert.equal(res.status, 200); // bad cookie treated as no session, not a 500
  } finally {
    server.close();
  }
});

test('malformed JSON body returns 400, not 500', async () => {
  const { server, base } = await startServer();
  try {
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"username":"boss","password":"password1"', // truncated JSON
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'bad_request');
  } finally { server.close(); }
});

test('login cookie attributes are correct for plain-HTTP LAN', async () => {
  const { server, base } = await startServer();
  try {
    const res = await post(base, '/api/auth/login', { username: 'boss', password: 'password1' });
    const sc = res.headers.get('set-cookie');
    assert.match(sc, /HttpOnly/);
    assert.match(sc, /SameSite=Lax/);
    assert.match(sc, /Path=\//);
    assert.match(sc, /Max-Age=43200/);
    assert.ok(!/Secure/i.test(sc), 'Secure flag would break plain-HTTP LAN login');
    assert.equal(res.headers.get('cache-control'), 'no-store');
  } finally { server.close(); }
});

test('re-login invalidates the previous session cookie', async () => {
  const { server, base } = await startServer();
  try {
    let res = await post(base, '/api/auth/login', { username: 'boss', password: 'password1' });
    const first = res.headers.get('set-cookie').split(';')[0];
    res = await post(base, '/api/auth/login', { username: 'boss', password: 'password1' }, first);
    assert.equal(res.status, 200);
    res = await fetch(`${base}/api/auth/me`, { headers: { Cookie: first } });
    assert.equal(res.status, 401, 'old session must be dead after re-login');
  } finally { server.close(); }
});

test('logout without a session still succeeds', async () => {
  const { server, base } = await startServer();
  try {
    assert.equal((await post(base, '/api/auth/logout', {})).status, 200);
  } finally { server.close(); }
});

test('lockout surfaces as 429 at the HTTP layer', async () => {
  const { server, base } = await startServer();
  try {
    for (let i = 0; i < 4; i++) {
      assert.equal((await post(base, '/api/auth/login', { username: 'flood-user', password: 'x' })).status, 401);
    }
    assert.equal((await post(base, '/api/auth/login', { username: 'flood-user', password: 'x' })).status, 429);
  } finally { server.close(); }
});

test('per-IP throttle rejects a login flood', async () => {
  const { server, base } = await startServer();
  try {
    let last;
    for (let i = 0; i < 11; i++) {
      last = await post(base, '/api/auth/login', { username: 'u' + i, password: 'x' });
    }
    assert.equal(last.status, 429);
  } finally { server.close(); }
});

test('with duplicate emsid cookies the last one wins', async () => {
  const { server, base } = await startServer();
  try {
    const res = await post(base, '/api/auth/login', { username: 'boss', password: 'password1' });
    const valid = res.headers.get('set-cookie').split(';')[0];
    const me = await fetch(`${base}/api/auth/me`, { headers: { Cookie: `emsid=garbage; ${valid}` } });
    assert.equal(me.status, 200);
  } finally { server.close(); }
});

test('users API: admin CRUD, role guard, self-protection', async () => {
  const { server, base } = await startServer();
  try {
    let res = await post(base, '/api/auth/login', { username: 'boss', password: 'password1' });
    const admin = res.headers.get('set-cookie').split(';')[0];

    // unauthenticated is rejected
    assert.equal((await fetch(`${base}/api/users`)).status, 401);

    // create a registrar
    res = await post(base, '/api/users', { username: 'reg1', password: 'password2', full_name: 'Reception One', role: 'registrar' }, admin);
    assert.equal(res.status, 201);
    const reg1 = (await res.json()).user;
    assert.equal(reg1.role, 'registrar');

    // duplicate username rejected
    res = await post(base, '/api/users', { username: 'reg1', password: 'password2', role: 'registrar' }, admin);
    assert.equal(res.status, 400);

    // non-string password rejected cleanly (400, not a 500 from hashPassword)
    res = await post(base, '/api/users', { username: 'reg2', password: 12345678, role: 'registrar' }, admin);
    assert.equal(res.status, 400);

    // registrar cannot use the users API
    res = await post(base, '/api/auth/login', { username: 'reg1', password: 'password2' });
    const regCookie = res.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(`${base}/api/users`, { headers: { Cookie: regCookie } })).status, 403);

    // admin can list, edit role, deactivate (which kills sessions)
    res = await fetch(`${base}/api/users`, { headers: { Cookie: admin } });
    assert.equal((await res.json()).users.length, 2);
    res = await fetch(`${base}/api/users/${reg1.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: admin },
      body: JSON.stringify({ is_active: false }),
    });
    assert.equal(res.status, 200);
    assert.equal((await fetch(`${base}/api/auth/me`, { headers: { Cookie: regCookie } })).status, 401);

    // admin cannot deactivate own account
    const meId = (await (await fetch(`${base}/api/auth/me`, { headers: { Cookie: admin } })).json()).user.id;
    res = await fetch(`${base}/api/users/${meId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: admin },
      body: JSON.stringify({ is_active: false }),
    });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test('users API input hardening: is_active and full_name types', async () => {
  const { server, base } = await startServer();
  try {
    let res = await post(base, '/api/auth/login', { username: 'boss', password: 'password1' });
    const admin = res.headers.get('set-cookie').split(';')[0];
    const meId = (await (await fetch(`${base}/api/auth/me`, { headers: { Cookie: admin } })).json()).user.id;

    const patchSelf = (body) => fetch(`${base}/api/users/${meId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: admin },
      body: JSON.stringify(body),
    });

    // falsy non-boolean must NOT slip past self-protection
    assert.equal((await patchSelf({ is_active: 0 })).status, 400);
    assert.equal((await fetch(`${base}/api/auth/me`, { headers: { Cookie: admin } })).status, 200);
    // truthy string must NOT silently reactivate/deactivate
    assert.equal((await patchSelf({ is_active: 'false' })).status, 400);
    // full_name null must not become the text "null"
    assert.equal((await patchSelf({ full_name: null })).status, 400);

    // unknown ids 404; roster leaks no hashes and is not cacheable
    res = await fetch(`${base}/api/users/999`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: admin }, body: '{}' });
    assert.equal(res.status, 404);
    res = await fetch(`${base}/api/users`, { headers: { Cookie: admin } });
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const body = await res.text();
    assert.ok(!body.includes('password_hash'));
    assert.ok(!/\$2[aby]\$/.test(body));
  } finally { server.close(); }
});

test('password reset kills target sessions; role demotion is immediate', async () => {
  const { server, base } = await startServer();
  try {
    let res = await post(base, '/api/auth/login', { username: 'boss', password: 'password1' });
    const admin = res.headers.get('set-cookie').split(';')[0];

    res = await post(base, '/api/users', { username: 'staff1', password: 'password3', role: 'admin' }, admin);
    const staff = (await res.json()).user;
    res = await post(base, '/api/auth/login', { username: 'staff1', password: 'password3' });
    const staffCookie = res.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(`${base}/api/users`, { headers: { Cookie: staffCookie } })).status, 200);

    // demotion takes effect on the very next request, no logout needed
    res = await fetch(`${base}/api/users/${staff.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: admin },
      body: JSON.stringify({ role: 'registrar' }),
    });
    assert.equal(res.status, 200);
    assert.equal((await fetch(`${base}/api/users`, { headers: { Cookie: staffCookie } })).status, 403);

    // password reset ends the old session entirely
    res = await fetch(`${base}/api/users/${staff.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: admin },
      body: JSON.stringify({ password: 'newpassword9' }),
    });
    assert.equal(res.status, 200);
    assert.equal((await fetch(`${base}/api/auth/me`, { headers: { Cookie: staffCookie } })).status, 401);
  } finally { server.close(); }
});

test('/api/db enforces the registry over HTTP', async () => {
  const { server, base } = await startServer();
  try {
    let res = await post(base, '/api/auth/login', { username:'boss', password:'password1' });
    const admin = res.headers.get('set-cookie').split(';')[0];

    res = await fetch(`${base}/api/db`, { method:'POST',
      headers:{ 'Content-Type':'application/json', Cookie: admin },
      body: JSON.stringify({ table:'patients', op:'insert', values:{ full_name:'Jane Roe', phone:'555' }, returning:true, single:'single' }) });
    assert.equal(res.status, 200);
    const created = (await res.json()).data;
    assert.equal(created.full_name, 'Jane Roe');
    assert.match(created.mrn, /^P-\d{2}-\d{5}$/);

    res = await fetch(`${base}/api/db`, { method:'POST',
      headers:{ 'Content-Type':'application/json', Cookie: admin },
      body: JSON.stringify({ table:'patients', op:'select', columns:'*', filters:[{col:'id',op:'eq',val:created.id}], single:'single' }) });
    assert.equal((await res.json()).data.phone, '555');

    res = await fetch(`${base}/api/db`, { method:'POST', headers:{ 'Content-Type':'application/json', Cookie: admin },
      body: JSON.stringify({ table:'sqlite_master', op:'select', columns:'*' }) });
    assert.equal(res.status, 403);
    res = await fetch(`${base}/api/db`, { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ table:'patients', op:'select', columns:'*' }) });
    assert.equal(res.status, 401);
  } finally { server.close(); }
});

test('/api/db returns nested embeds and exact count', async () => {
  const { server, base } = await startServer();
  try {
    let res = await post(base, '/api/auth/login', { username:'boss', password:'password1' });
    const admin = res.headers.get('set-cookie').split(';')[0];
    await fetch(`${base}/api/db`, { method:'POST', headers:{'Content-Type':'application/json',Cookie:admin},
      body: JSON.stringify({ table:'patients', op:'insert', values:{ full_name:'Nesta', branch_id:1 } }) });
    res = await fetch(`${base}/api/db`, { method:'POST', headers:{'Content-Type':'application/json',Cookie:admin},
      body: JSON.stringify({ table:'patients', op:'select', columns:'*, branches(name)', count:'exact' }) });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(body.data) && body.data.length >= 1);
    assert.equal(typeof body.data[0].branches, 'object');   // nested, not flat
    assert.equal(body.data[0].branches.name, 'Main Branch');
    assert.equal(body.count, body.data.length);             // exact count present
  } finally { server.close(); }
});

test('/api/rpc: unknown function is a clean 501, auth required', async () => {
  const { server, base } = await startServer();
  try {
    let res = await post(base, '/api/auth/login', { username:'boss', password:'password1' });
    const admin = res.headers.get('set-cookie').split(';')[0];
    res = await fetch(`${base}/api/rpc/does_not_exist`, { method:'POST',
      headers:{ 'Content-Type':'application/json', Cookie: admin }, body:'{}' });
    assert.equal(res.status, 501);
    assert.equal((await res.json()).error.code, 'rpc_not_implemented');
    res = await fetch(`${base}/api/rpc/does_not_exist`, { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' });
    assert.equal(res.status, 401);
  } finally { server.close(); }
});

// --- OPS_EVENTS_V1 -----------------------------------------------------------

test('a 4xx (unknown /api route) never records a server_error ops_event', async () => {
  const { db, server, base } = await startServer();
  try {
    assert.equal((await fetch(`${base}/api/no-such-thing`)).status, 404);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ops_events').get().n, 0);
  } finally { server.close(); }
});

// FINDING, fixed here — do not assume app.js's handler sees "every 5xx" (the
// plan's own verified-facts table claims exactly that): routes/rpc.js has its
// OWN try/catch around every handler call and, on a >=500 error, responds
// directly (`return res.status(500).json(...)`) WITHOUT calling `next(e)`.
// The error therefore never reaches app.js's global error-handling
// middleware — confirmed empirically (a throwing handler was added to the
// live RPC registry and hit over real HTTP) before routes/rpc.js was given
// its own recordEvent call, at which point this test's assertion was 0, not
// 1. Left in as a regression test for the fix, not just a demonstration.
test('an RPC handler throwing 500 answers correctly AND records its own server_error event (app.js never sees it)', async () => {
  RPC.__ops_events_test_throw = () => { throw Object.assign(new Error('boom'), {}); };
  const { db, server, base } = await startServer();
  try {
    const login = await post(base, '/api/auth/login', { username: 'boss', password: 'password1' });
    const admin = login.headers.get('set-cookie').split(';')[0];
    const res = await post(base, '/api/rpc/__ops_events_test_throw', {}, admin);
    assert.equal(res.status, 500, 'the RPC route still answers 500 correctly');
    const row = db.prepare('SELECT * FROM ops_events').get();
    assert.equal(row.kind, 'server_error');
    assert.equal(row.route, '/api/rpc/__ops_events_test_throw', 'the RPC name is a safe, fixed-vocabulary identifier');
  } finally {
    server.close();
    delete RPC.__ops_events_test_throw;
  }
});

// Same gap, same fix, for /api/db: its own catch around query execution also
// answers 500s directly without calling next(e) — a constraint-shaped error
// (400/409, already classified by routes/db.js's own branches above the one
// touched here) must NOT record anything; only a truly unexpected failure
// falls to the final branch that now records one.
test('/api/db: a truly unexpected query failure records its own server_error event; ordinary requests record nothing', async () => {
  const { db, server, base } = await startServer();
  try {
    const login = await post(base, '/api/auth/login', { username: 'boss', password: 'password1' });
    const admin = login.headers.get('set-cookie').split(';')[0];

    let res = await post(base, '/api/db', { table: 'patients', op: 'select', columns: '*' }, admin);
    assert.equal(res.status, 200);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ops_events').get().n, 0, 'an ordinary request records nothing');

    // Force the truly-unexpected branch: compile() only checks the registry
    // allow-list, not whether the table literally exists in this connection,
    // so dropping it (safe — this is the test's own throwaway in-memory db)
    // makes the real db.prepare(sql).all(...) call below throw a plain
    // SQLITE_ERROR ("no such table"), which none of routes/db.js's four
    // classified constraint codes match — proving the final, unclassified
    // branch, the one this task's recordEvent call was added to.
    db.exec('DROP TABLE patients');
    res = await post(base, '/api/db', { table: 'patients', op: 'select', columns: '*' }, admin);
    assert.equal(res.status, 500);
    const row = db.prepare('SELECT * FROM ops_events').get();
    assert.equal(row.kind, 'server_error');
    assert.equal(row.route, '/api/db/patients', 'the schema-registry table name is a safe, fixed-vocabulary identifier');
  } finally { server.close(); }
});

// Reproduces app.js's exact error-handling shape (a matched, parameterised
// route ahead of a 4-arg middleware identical in structure to the real one) on
// a disposable Express app, to answer empirically whether req.route is
// populated inside that middleware. Not exercised through any production
// route: every route in THIS app that could throw uncaught already has its
// own local catch (rpc.js, db.js, storage.js all respond directly rather than
// calling next(err)) — see the FINDING test above — so there is currently no
// real request path left that reaches app.js's handler with req.route set.
// This still matters: it is the mechanism app.js's `req.route?.path ?? null`
// line relies on, and it must be shown true of Express itself, not assumed.
test('EMPIRICAL: req.route.path IS populated inside error-handling middleware for a throw in a matched route; UNDEFINED (not the string "undefined") for one thrown before routing', async () => {
  const seen = [];
  const app = express();
  app.get('/patients/:id', (req, res) => { throw new Error('boom'); });     // matched route: req.route should be set
  app.use(express.json());                                                  // registered AFTER the route on purpose: a parse failure here happens with no route matched yet
  app.post('/parse-me', (req, res) => res.json({ ok: true }));
  app.use((err, req, res, next) => {                                        // same shape as app.js's real handler
    seen.push(req.route?.path ?? null);
    res.status(500).json({ error: { code: 'internal' } });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fetch(`${base}/patients/42`);
    await fetch(`${base}/parse-me`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad json' });
    assert.equal(seen[0], '/patients/:id', 'populated: this is the whole reason req.route.path is safe to store');
    assert.equal(seen[1], null, 'no route matched yet when body-parser fails — must be null, never the literal string "undefined"');
  } finally { server.close(); }
});
