// MULTI_ROLE_SERVER_V1 — extra_roles must count for SERVER data access, not
// only for what the sidebar shows.
//
// The bug this pins: «Дополнительные роли» (Employees) and the module matrix
// (Settings → Roles & permissions) both looked like they granted access, but
// neither reached the server. query-compiler read `user.role` — the PRIMARY
// role alone — so a склад employee given the registrar role as an extra could
// see the CRM board and then hit a bare «not allowed» toast the moment she
// saved a request. sessionUser() did not even SELECT extra_roles, so the
// server could not have honoured it.
//
// The real case: Sabirova Visola, role 'inventory', extra_roles ['registrar'].
// Reading crm_requests was allowed (ALL_STAFF may read); every write was not.

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
  // Exactly the shipped shape of the account that hit this: a склад primary
  // role, widened by an admin with the registrar role as an extra.
  db.prepare('INSERT INTO users (username, password_hash, full_name, role, extra_roles) VALUES (?,?,?,?,?)')
    .run('visola', hashPassword('password1'), 'Sabirova Visola', 'inventory', '["registrar"]');
  // The control: the same primary role with NO extras must stay denied.
  db.prepare('INSERT INTO users (username, password_hash, full_name, role, extra_roles) VALUES (?,?,?,?,?)')
    .run('sklad', hashPassword('password1'), 'Склад Без Ролей', 'inventory', '');
  return new Promise((resolve) => {
    // LICENCE_CORE_V1 — enrolled+active so the write gate (routes/db.js,
    // routes/rpc.js) never fires; this file predates licensing.
    const server = createApp(db, { dataDir: licensedDataDir() }).listen(0, '127.0.0.1', () => {
      resolve({ db, server, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

async function login(base, who) {
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: who, password: 'password1' }),
  });
  assert.equal(res.status, 200, `login as ${who} failed`);
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

async function dbCall(base, cookie, desc) {
  const res = await fetch(base + '/api/db', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(desc),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

const newRequest = {
  table: 'crm_requests', op: 'insert', returning: true, single: 'single',
  values: { full_name: 'Пациент Тест', phone: '+998950768008', source: 'call', status: 'in_process' },
};

test('an extra role grants server write access the primary role lacks', async (t) => {
  const { db, server, base } = await startServer();
  t.after(() => { server.close(); db.close(); });

  const res = await dbCall(base, await login(base, 'visola'), newRequest);

  assert.equal(res.status, 200, 'extra role registrar must authorise the CRM write: ' + JSON.stringify(res.json));
  assert.equal(res.json.data.full_name, 'Пациент Тест');
});

test('the same primary role WITHOUT the extra stays denied', async (t) => {
  const { db, server, base } = await startServer();
  t.after(() => { server.close(); db.close(); });

  const res = await dbCall(base, await login(base, 'sklad'), newRequest);

  assert.equal(res.status, 403, 'inventory alone must not write CRM: ' + JSON.stringify(res.json));
});

// The RPC layer guards the same way and had the same defect, so the /api/db fix
// alone would have moved the wall one step further down the SAME workflow: the
// call centre books the service, and creating the visit for it is ensure_visit.
async function rpc(base, cookie, name, args) {
  const res = await fetch(base + '/api/rpc/' + name, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(args),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

test('an extra role also authorises RPC calls the primary role lacks', async (t) => {
  const { db, server, base } = await startServer();
  t.after(() => { server.close(); db.close(); });
  const cookie = await login(base, 'visola');

  const pat = await dbCall(base, cookie, {
    table: 'patients', op: 'insert', returning: true, single: 'single',
    values: { full_name: 'Пациент Тест', phone: '+998950768008' },
  });
  assert.equal(pat.status, 200, 'patient seed: ' + JSON.stringify(pat.json));

  const res = await rpc(base, cookie, 'ensure_visit', { patient_id: pat.json.data.id, date: '2026-08-20' });

  assert.equal(res.status, 200, 'extra role registrar must authorise ensure_visit: ' + JSON.stringify(res.json));
  assert.equal(res.json.data.created, true);
});

test('RPC stays denied for the primary role without the extra', async (t) => {
  const { db, server, base } = await startServer();
  t.after(() => { server.close(); db.close(); });

  const res = await rpc(base, await login(base, 'sklad'), 'ensure_visit', { patient_id: 1, date: '2026-08-20' });

  assert.equal(res.status, 403, 'inventory alone must not create visits: ' + JSON.stringify(res.json));
});
