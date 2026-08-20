import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { bootstrapAdmin, hashPassword } from '../services/auth.js';
import { canonical } from '../services/control/canonical.js';
import { __setPublicKeyForTests } from '../services/control/state.js';
import { expectedResponse } from '../services/control/unlock.js';
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

// LICENCE_CORE_V1 — Task 11: the three RPCs that must survive a licence lockout.
//
// This is the single most valuable test in that task: a name mismatch between
// this file's expectations, gate.js's ALWAYS_ALLOWED_RPCS and rpc/index.js's
// registration would strand every locked clinic behind its own escape hatch,
// and nothing else in the suite would catch it — the read-only/unknown-RPC
// tests above exercise entirely different RPC names.
test('all three licence RPCs stay reachable through the real HTTP route on a locked clinic', async (t) => {
  const { app, password } = harness({ validUntil: '2020-01-01T00:00:00Z' });
  const server = await listen(app); t.after(() => server.close());
  const cookie = await login(server, password);

  const status = await post(server, cookie, '/api/rpc/licence_status', {});
  assert.notEqual(status.status, 402, 'licence_status must answer even while locked');
  const statusBody = await status.json();
  assert.equal(statusBody.data.locked, true);

  // Wrong code on purpose: this proves the RPC is REACHABLE (400, not 402),
  // not that redemption succeeds — the full round trip is the next test.
  const unlock = await post(server, cookie, '/api/rpc/licence_unlock', { code: 'WRONG-CODE1' });
  assert.notEqual(unlock.status, 402, 'licence_unlock must answer even while locked');
  assert.equal(unlock.status, 400, 'a wrong code is a bad request, not a lock');

  const req = await post(server, cookie, '/api/rpc/module_request', { module_key: 'crm' });
  assert.notEqual(req.status, 402, 'module_request must answer even while locked');
  assert.equal(req.status, 200);
});

test('a locked clinic can redeem the correct telephone code end-to-end', async (t) => {
  const { app, password } = harness({ validUntil: '2020-01-01T00:00:00Z' });
  const server = await listen(app); t.after(() => server.close());
  const cookie = await login(server, password);

  const status = await (await post(server, cookie, '/api/rpc/licence_status', {})).json();
  const challenge = status.data.challenge;
  assert.ok(challenge, 'the lock screen must have a code to read out over the phone');

  // The vendor side of the call: same computation, done here with the secret
  // from control.json ('s', written by harness()) instead of reading it off disk.
  const code = expectedResponse({ clinicId: 'c-1', challenge, secret: 's' });
  const res = await post(server, cookie, '/api/rpc/licence_unlock', { code });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.ok, true);
  assert.ok(body.data.until, 'the extension date must come back so the UI can show it');

  // And the clinic should read as unlocked immediately after, on the same
  // connection that redeemed the code — no restart needed.
  const after = await (await post(server, cookie, '/api/rpc/licence_status', {})).json();
  assert.equal(after.data.locked, false);
});

async function loginAs(server, username, password) {
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

// ADMIN_DOCTOR_V1-class check (see easymed-admin-doctor memory): a clinic
// admin's PRIMARY role is not always 'admin' — extra_roles exists precisely so
// one account can be, say, a doctor AND an admin. Testing user.role directly
// (as opposed to hasAnyRole(), which every other RPC guard in this codebase
// uses) would lock exactly that admin out of the one screen that lets them
// pay. These two tests pin the fix for this RPC specifically.
test('an admin granted only via extra_roles can still reach licence_unlock', async (t) => {
  const { app, db } = harness({ validUntil: '2020-01-01T00:00:00Z' });
  db.prepare(
    'INSERT INTO users (username, password_hash, full_name, role, extra_roles) VALUES (?,?,?,?,?)'
  ).run('deskadmin', hashPassword('password1'), 'Front Desk', 'registrar', JSON.stringify(['admin']));
  const server = await listen(app); t.after(() => server.close());
  const cookie = await loginAs(server, 'deskadmin', 'password1');

  // Wrong code deliberately — this test is about getting PAST the role guard
  // (403), not about redemption succeeding. 400 proves the role check passed.
  const res = await post(server, cookie, '/api/rpc/licence_unlock', { code: 'WRONG-CODE1' });
  assert.notEqual(res.status, 403, 'an admin granted through extra_roles must not be locked out of activation');
  assert.equal(res.status, 400);
});

test('a user without the admin role anywhere is refused licence_unlock, not silently allowed', async (t) => {
  const { app, db } = harness({ validUntil: '2020-01-01T00:00:00Z' });
  db.prepare(
    'INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)'
  ).run('nursebeth', hashPassword('password1'), 'Beth', 'nurse');
  const server = await listen(app); t.after(() => server.close());
  const cookie = await loginAs(server, 'nursebeth', 'password1');

  const res = await post(server, cookie, '/api/rpc/licence_unlock', { code: 'WRONG-CODE1' });
  assert.equal(res.status, 403, 'only an admin (primary or extra role) may activate a licence');
});

test('clicking «Подключить модуль» twice through the real route records one lead, not two', async (t) => {
  const { app, password } = harness({ validUntil: '2020-01-01T00:00:00Z' });
  const server = await listen(app); t.after(() => server.close());
  const cookie = await login(server, password);

  const first = await (await post(server, cookie, '/api/rpc/module_request', { module_key: 'telegram' })).json();
  assert.equal(first.data.already, false);
  const second = await (await post(server, cookie, '/api/rpc/module_request', { module_key: 'telegram' })).json();
  assert.equal(second.data.already, true, 'the button must not show an error on a second click');
});

// LICENCE_CORE_V1 — an install that has never been enrolled (no control.json at
// all, e.g. a fresh copy before the vendor has run the enrollment step) still
// locks, via state.js's 'not_enrolled' path. The lock screen still needs
// SOMETHING to render: currentChallenge() only ever touches control_state
// (always created by migrate()), never control.json, so a challenge is
// generated even with no clinic identity on disk at all.
test('licence_status renders a real activation code even with no control.json at all', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-unenrolled-'));
  const db = openDb(':memory:'); migrate(db);
  const password = bootstrapAdmin(db);
  const server = await listen(createApp(db, { dataDir: dir }));
  t.after(() => server.close());
  const cookie = await login(server, password);

  const res = await post(server, cookie, '/api/rpc/licence_status', {});
  assert.notEqual(res.status, 402);
  const body = await res.json();
  assert.equal(body.data.reason, 'not_enrolled');
  assert.equal(body.data.locked, true);
  assert.ok(body.data.challenge, 'the activation screen must have something to show, not a blank lock screen');
});

// LICENCE_CORE_V1 — the rule this whole feature exists to protect.
//
// A clinic that has PAID, whose router died, must never be told it owes money.
// This shipped hardcoded to the money wording and reached review before anyone
// noticed a paying customer saving a patient card was being dunned for payment.
test('a paid but offline clinic is NOT told it owes money', async (t) => {
  const { app, password } = harness({ validUntil: '2020-01-01T00:00:00Z' });   // subscription: 'active'
  const server = await listen(app); t.after(() => server.close());
  const cookie = await login(server, password);

  const res = await post(server, cookie, '/api/db', { table: 'patients', op: 'insert', values: { full_name: 'Тест' } });
  assert.equal(res.status, 402);
  const body = await res.json();

  assert.equal(body.error.reason, 'offline', 'they have paid — the licence simply was not re-armed');
  assert.match(body.error.message, /Нет связи с Easy-Med/);
  assert.doesNotMatch(body.error.message, /Подписка не активна/, 'never accuse a paying clinic of not paying');
});

test('a clinic that stopped paying IS told about the subscription', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-unpaid-'));
  fs.writeFileSync(path.join(dir, 'control.json'), JSON.stringify({
    clinic_id: 'c-1', unlock_secret: 's', subscription: 'unpaid',
  }));
  const payload = { clinic_id: 'c-1', clinic_name: 'T', modules: [], valid_until: '2020-01-01T00:00:00Z', issued_at: '2020-01-01T00:00:00Z', nonce: 'n' };
  fs.writeFileSync(path.join(dir, 'licence.dat'), JSON.stringify({
    payload, sig: sign(null, Buffer.from(canonical(payload), 'utf8'), privateKey).toString('base64'),
  }));
  const db = openDb(':memory:'); migrate(db);
  const password = bootstrapAdmin(db);
  const server = await listen(createApp(db, { dataDir: dir })); t.after(() => server.close());
  const cookie = await login(server, password);

  const res = await post(server, cookie, '/api/db', { table: 'patients', op: 'insert', values: { full_name: 'Тест' } });
  const body = await res.json();
  assert.equal(body.error.reason, 'unpaid');
  assert.match(body.error.message, /Подписка не активна/);
});
