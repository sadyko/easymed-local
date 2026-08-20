import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { bootstrapAdmin } from '../services/auth.js';
import { canonical } from '../services/control/canonical.js';
import { __setPublicKeyForTests } from '../services/control/state.js';
import { createApp } from '../app.js';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
__setPublicKeyForTests(publicKey);

function harness({ validUntil }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-gate-'));
  fs.writeFileSync(path.join(dir, 'control.json'), JSON.stringify({
    clinic_id: 'c-1', unlock_secret: 's', subscription: 'active',
  }));
  const payload = {
    clinic_id: 'c-1', clinic_name: 'T', modules: ['crm'],
    valid_until: validUntil, issued_at: '2026-08-01T00:00:00Z', nonce: 'n',
  };
  fs.writeFileSync(path.join(dir, 'licence.dat'), JSON.stringify({
    payload, sig: sign(null, Buffer.from(canonical(payload), 'utf8'), privateKey).toString('base64'),
  }));

  const db = openDb(':memory:');
  migrate(db);
  const password = bootstrapAdmin(db);
  return { db, dir, password, app: createApp(db, { dataDir: dir }) };
}

const listen = (app) => new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });

async function login(server, password) {
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password }),
  });
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

const post = (server, cookie, url, body) =>
  fetch(`http://127.0.0.1:${server.address().port}${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(body),
  });

// method/body optional so this also covers plain GET/DELETE with no body.
const request = (server, cookie, method, url, body) =>
  fetch(`http://127.0.0.1:${server.address().port}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

test('a licensed clinic can still write', async (t) => {
  const { app, password } = harness({ validUntil: '2099-01-01T00:00:00Z' });
  const server = await listen(app); t.after(() => server.close());
  const cookie = await login(server, password);
  const res = await post(server, cookie, '/api/db', { table: 'patients', op: 'insert', values: { full_name: 'Тест Тестов' } });
  assert.notEqual(res.status, 402);
});

test('a lapsed clinic cannot write, and is told why', async (t) => {
  const { app, password } = harness({ validUntil: '2020-01-01T00:00:00Z' });
  const server = await listen(app); t.after(() => server.close());
  const cookie = await login(server, password);
  const res = await post(server, cookie, '/api/db', { table: 'patients', op: 'insert', values: { full_name: 'Тест Тестов' } });
  assert.equal(res.status, 402, 'Payment Required is the honest status here');
  assert.equal((await res.json()).error.code, 'licence_locked');
});

test('a lapsed clinic can still READ its own records', async (t) => {
  const { app, password } = harness({ validUntil: '2020-01-01T00:00:00Z' });
  const server = await listen(app); t.after(() => server.close());
  const cookie = await login(server, password);
  const res = await post(server, cookie, '/api/db', { table: 'patients', op: 'select', columns: '*', filters: [] });
  assert.equal(res.status, 200, 'reading a patient card must never be blocked');
});

test('a lapsed clinic cannot call a mutating RPC', async (t) => {
  const { app, password } = harness({ validUntil: '2020-01-01T00:00:00Z' });
  const server = await listen(app); t.after(() => server.close());
  const cookie = await login(server, password);
  assert.equal((await post(server, cookie, '/api/rpc/record_payment', { invoice_id: 1, amount: 100 })).status, 402);
});

test('a lapsed clinic can still call a read-only RPC', async (t) => {
  const { app, password } = harness({ validUntil: '2020-01-01T00:00:00Z' });
  const server = await listen(app); t.after(() => server.close());
  const cookie = await login(server, password);
  assert.notEqual((await post(server, cookie, '/api/rpc/dashboard_summary', {})).status, 402);
});

test('an unknown RPC is blocked while locked — the gate fails CLOSED', async (t) => {
  const { app, password } = harness({ validUntil: '2020-01-01T00:00:00Z' });
  const server = await listen(app); t.after(() => server.close());
  const cookie = await login(server, password);
  const res = await post(server, cookie, '/api/rpc/some_future_rpc', {});
  assert.equal(res.status, 402, 'an RPC nobody remembered to classify must not become a hole');
});

test('login still works when locked — otherwise nobody can pay', async (t) => {
  const { app, password } = harness({ validUntil: '2020-01-01T00:00:00Z' });
  const server = await listen(app); t.after(() => server.close());
  const cookie = await login(server, password);
  assert.ok(cookie.includes('emsid'), 'a locked clinic must still be able to log in');
});

// LICENCE_CORE_V1 — /api/auth/me and /api/auth/logout are the other half of
// "login stays open": an admin who is locked out of /api/auth/me can't tell
// the browser knows who they are, and one who can't log out can't hand the
// shared clinic PC to a different account that might be able to pay.
// routes/auth.js is deliberately untouched by this task — attachControl still
// runs ahead of it (it's global middleware in app.js), it just never reads
// req.control, so nothing here can regress by omission.
test('/api/auth/me still works when locked', async (t) => {
  const { app, password } = harness({ validUntil: '2020-01-01T00:00:00Z' });
  const server = await listen(app); t.after(() => server.close());
  const cookie = await login(server, password);
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/me`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200, 'a locked clinic must still be able to confirm who is logged in');
});

test('/api/auth/logout still works when locked', async (t) => {
  const { app, password } = harness({ validUntil: '2020-01-01T00:00:00Z' });
  const server = await listen(app); t.after(() => server.close());
  const cookie = await login(server, password);
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/logout`, {
    method: 'POST', headers: { Cookie: cookie },
  });
  assert.equal(res.status, 200, 'a locked clinic must still be able to log out and hand the PC to another account');
});

test('the app boots and serves with no licence file at all', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-nolic-'));
  const db = openDb(':memory:'); migrate(db); bootstrapAdmin(db);
  const server = await listen(createApp(db, { dataDir: dir }));
  t.after(() => server.close());
  assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/api/health`)).status, 200);
});

// LICENCE_CORE_V1 — /api/storage is the OTHER write path: patient photos,
// lab-report scans and Telegram attachments never touch /api/db at all, they
// go straight to disk (server/routes/storage.js). Uploading or deleting a
// file is exactly the "create/edit/delete" the owner said must stop; serving
// one back is exactly the "read past results" the owner said must not.
test('a lapsed clinic cannot upload a file to storage', async (t) => {
  const { app, password } = harness({ validUntil: '2020-01-01T00:00:00Z' });
  const server = await listen(app); t.after(() => server.close());
  const cookie = await login(server, password);
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/storage/clinic-docs/x.txt`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', Cookie: cookie },
    body: Buffer.from('hello'),
  });
  assert.equal(res.status, 402, 'a file upload is a write and must be blocked the same as /api/db');
  assert.equal((await res.json()).error.code, 'licence_locked');
});

test('a lapsed clinic can still download a file already on disk', async (t) => {
  const { app, dir, password } = harness({ validUntil: '2020-01-01T00:00:00Z' });
  fs.mkdirSync(path.join(dir, 'storage', 'clinic-docs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'storage', 'clinic-docs', 'existing.txt'), 'already stored');
  const server = await listen(app); t.after(() => server.close());
  const cookie = await login(server, password);
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/storage/clinic-docs/existing.txt`, {
    headers: { Cookie: cookie },
  });
  assert.equal(res.status, 200, 'serving a document already on disk must never be blocked');
  assert.equal(await res.text(), 'already stored');
});

test('a lapsed clinic cannot delete a file from storage', async (t) => {
  const { app, dir, password } = harness({ validUntil: '2020-01-01T00:00:00Z' });
  fs.mkdirSync(path.join(dir, 'storage', 'clinic-docs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'storage', 'clinic-docs', 'existing.txt'), 'already stored');
  const server = await listen(app); t.after(() => server.close());
  const cookie = await login(server, password);
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/storage/clinic-docs/existing.txt`, {
    method: 'DELETE',
    headers: { Cookie: cookie },
  });
  assert.equal(res.status, 402, 'deleting a stored file is a write and must be blocked');
});

// LICENCE_CORE_V1 — /api/users is a THIRD write path, entirely separate from
// /api/db and /api/rpc. schema-registry.js DOES list 'users', but its write
// block is `{insert:{roles:[]},update:{roles:[]},delete:{roles:[]}}` — nobody
// can write it through /api/db by design (username/password/admin-count rules
// need more care than the generic compiler gives). routes/users.js is that
// dedicated path, with its own `db.prepare(...).run(...)` calls the gate in
// db.js never sees. Unguarded, a lapsed clinic could still create, edit or
// delete staff accounts — exactly the "create/edit/delete anything" the
// owner said must stop.
test('a lapsed clinic cannot create a staff account', async (t) => {
  const { app, password } = harness({ validUntil: '2020-01-01T00:00:00Z' });
  const server = await listen(app); t.after(() => server.close());
  const cookie = await login(server, password);
  const res = await post(server, cookie, '/api/users', {
    username: 'newnurse', password: 'password1', full_name: 'New Nurse', role: 'nurse',
  });
  assert.equal(res.status, 402, 'creating a staff account is a write and must be blocked');
});

test('a lapsed clinic cannot edit a staff account', async (t) => {
  const { app, db, password } = harness({ validUntil: '2020-01-01T00:00:00Z' });
  const info = db.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)')
    .run('nurse1', 'x', 'Nurse One', 'nurse');
  const server = await listen(app); t.after(() => server.close());
  const cookie = await login(server, password);
  const res = await request(server, cookie, 'PATCH', `/api/users/${info.lastInsertRowid}`, { full_name: 'Changed' });
  assert.equal(res.status, 402, 'editing a staff account is a write and must be blocked');
});

test('a lapsed clinic cannot delete a staff account', async (t) => {
  const { app, db, password } = harness({ validUntil: '2020-01-01T00:00:00Z' });
  const info = db.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)')
    .run('nurse2', 'x', 'Nurse Two', 'nurse');
  const server = await listen(app); t.after(() => server.close());
  const cookie = await login(server, password);
  const res = await request(server, cookie, 'DELETE', `/api/users/${info.lastInsertRowid}`);
  assert.equal(res.status, 402, 'deleting a staff account is a write and must be blocked');
});

test('a lapsed clinic can still list staff', async (t) => {
  const { app, password } = harness({ validUntil: '2020-01-01T00:00:00Z' });
  const server = await listen(app); t.after(() => server.close());
  const cookie = await login(server, password);
  const res = await request(server, cookie, 'GET', '/api/users');
  assert.equal(res.status, 200, 'reading the staff roster must never be blocked');
});
