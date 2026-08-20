// PAYER_FROM_SETTINGS_V1 — the exact read the booking wizard makes for the
// «Кто платит» buttons. It went out as `.select('id, name, kind').eq('active', true)`
// and the wizard silently rendered «Плательщики не заведены» with two active
// payers sitting in the table — the error was swallowed into `|| []`.
//
// So: assert the query the client actually sends, end to end.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { hashPassword } from '../services/auth.js';
import { createApp } from '../app.js';
import { licensedDataDir } from '../services/control/licensed-fixture.js';   // LICENCE_CORE_V1

function startServer() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)')
    .run('boss', hashPassword('password1'), 'Boss', 'admin');
  db.prepare("INSERT INTO payers (name, kind, active) VALUES ('ФМС','government',1)").run();
  db.prepare("INSERT INTO payers (name, kind, active) VALUES ('VAQF','government',1)").run();
  db.prepare("INSERT INTO payers (name, kind, active) VALUES ('Старый','insurance',0)").run();
  return new Promise((resolve) => {
    // LICENCE_CORE_V1 — enrolled+active; this file's one POST /api/users call
    // (adding a cashier) would otherwise trip the write gate on the default
    // (unenrolled) dataDir.
    const server = createApp(db, { dataDir: licensedDataDir() }).listen(0, '127.0.0.1', () => {
      resolve({ db, server, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

async function loginAdmin(base) {
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'boss', password: 'password1' }),
  });
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

async function db(base, cookie, desc) {
  const res = await fetch(base + '/api/db', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(desc),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

test('the wizard payer query returns the active payers', async (t) => {
  const { db: sqlite, server, base } = await startServer();
  t.after(() => { server.close(); sqlite.close(); });
  const cookie = await loginAdmin(base);

  // Byte-for-byte the descriptor public/js/db-client.js builds for
  //   supabase.from('payers').select('id, name, kind').eq('active', true).order('name')
  const res = await db(base, cookie, {
    table: 'payers', op: 'select', columns: 'id, name, kind',
    filters: [{ col: 'active', op: 'eq', val: true }],
    order: [{ col: 'name', asc: true }],
  });

  assert.equal(res.status, 200, 'the query must not error: ' + JSON.stringify(res.json));
  assert.ok(Array.isArray(res.json.data), 'data must be an array, not null');
  assert.deepEqual(res.json.data.map((p) => p.name), ['VAQF', 'ФМС']);
  assert.equal(res.json.data[0].kind, 'government', 'kind drives dms-vs-contract routing');
});

// PAYER_LOAD_V2 — the read the wizard actually makes now: the whole table, with
// `active` projected so the client can filter. No server-side filter means one
// fewer thing that can 400 the query and blank the picker.
test('the unfiltered payer read returns every payer with its active flag', async (t) => {
  const { db: sqlite, server, base } = await startServer();
  t.after(() => { server.close(); sqlite.close(); });
  const cookie = await loginAdmin(base);

  const res = await db(base, cookie, {
    table: 'payers', op: 'select', columns: 'id, name, kind, active',
    filters: [], order: [{ col: 'name', asc: true }],
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.data.length, 3, 'all three rows, including the inactive one');

  // Exactly the client-side filter in visit-wizard.js.
  const usable = res.json.data.filter((p) => p.active === undefined || !!p.active);
  assert.deepEqual(usable.map((p) => p.name), ['VAQF', 'ФМС']);
});

test('a deactivated payer stays out of the picker', async (t) => {
  const { db: sqlite, server, base } = await startServer();
  t.after(() => { server.close(); sqlite.close(); });
  const cookie = await loginAdmin(base);
  const res = await db(base, cookie, {
    table: 'payers', op: 'select', columns: 'id, name, kind',
    filters: [{ col: 'active', op: 'eq', val: true }], order: [],
  });
  assert.ok(!res.json.data.some((p) => p.name === 'Старый'));
});

// The wizard reads `kind` to decide insurance-vs-contract. If it is not a
// readable column the select 400s and every payer disappears at once.
test('id, name and kind are all readable on payers', async (t) => {
  const { db: sqlite, server, base } = await startServer();
  t.after(() => { server.close(); sqlite.close(); });
  const cookie = await loginAdmin(base);
  for (const col of ['id', 'name', 'kind', 'active']) {
    const res = await db(base, cookie, { table: 'payers', op: 'select', columns: col, filters: [], order: [] });
    assert.equal(res.status, 200, `column ${col} must be readable: ` + JSON.stringify(res.json));
  }
});

// A registrar books visits, so the picker has to fill for them too — not just
// for the admin who set the payers up.
test('a registrar can read the payer list', async (t) => {
  const { db: sqlite, server, base } = await startServer();
  t.after(() => { server.close(); sqlite.close(); });
  const adminCookie = await loginAdmin(base);
  await fetch(base + '/api/users', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
    body: JSON.stringify({ username: 'reg.one', password: 'ChangeMe123', role: 'registrar', full_name: 'Reg One' }),
  });
  const logged = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'reg.one', password: 'ChangeMe123' }),
  });
  const regCookie = logged.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');

  const res = await db(base, regCookie, {
    table: 'payers', op: 'select', columns: 'id, name, kind',
    filters: [{ col: 'active', op: 'eq', val: true }], order: [{ col: 'name', asc: true }],
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.data.length, 2);
});
