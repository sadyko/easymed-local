// WIZ_TEMPLATES_REGISTRAR_V1 — a смета template is the registrar's tool, so the
// registrar must be able to make one.
//
// service_templates (mig 027) was registered admin-only for writes while the UI
// that saves a template lives in the booking flow the REGISTRAR runs. Pressing
// «Сохранить как шаблон» therefore ended in the same bare «not allowed» the CRM
// board produced — the section is reachable, the table is not.
//
// Soft delete is an UPDATE (active = 0), which is what the template list's «×»
// does, so granting update necessarily lets a registrar retire a template too.
// Hard DELETE stays admin-only.

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
  for (const [user, role] of [['reg', 'registrar'], ['money', 'cashier']]) {
    db.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)')
      .run(user, hashPassword('password1'), user, role);
  }
  db.prepare('INSERT INTO services (name, price) VALUES (?,?)').run('Консультация кардиолога', 100000);
  db.prepare('INSERT INTO services (name, price) VALUES (?,?)').run('С-реактивный белок', 35000);
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

const newTemplate = {
  table: 'service_templates', op: 'insert', returning: true, single: 'single',
  values: { name: 'Первичный приём', service_ids: [1, 2], active: true },
};

test('a registrar can save a смета as a template', async (t) => {
  const { db, server, base } = await startServer();
  t.after(() => { server.close(); db.close(); });

  const res = await dbCall(base, await login(base, 'reg'), newTemplate);

  assert.equal(res.status, 200, 'registrar must be able to save a template: ' + JSON.stringify(res.json));
  assert.equal(res.json.data.name, 'Первичный приём');
});

// service_ids is a JSON array in a TEXT column. Without json:['service_ids'] in
// the registry the array is rejected on write, and on read comes back as the
// string "[1,2]" — which Array.isArray() rejects, so every template renders as
// «услуг: 0» and applying one adds nothing. This asserts the READ path the
// template picker actually uses.
//
// (The insert-with-`returning` reply is NOT json-parsed: meta.json is only set
// for op:'select' in the compiler, so that path hands back the raw string. No
// caller requests returning here, so it is left alone rather than changing a
// response path every table shares.)
test('service_ids round-trips as an array, not the string "[1,2]"', async (t) => {
  const { db, server, base } = await startServer();
  t.after(() => { server.close(); db.close(); });
  const cookie = await login(base, 'reg');
  await dbCall(base, cookie, newTemplate);

  const read = await dbCall(base, cookie, {
    table: 'service_templates', op: 'select', columns: '*',
    filters: [{ col: 'active', op: 'eq', val: true }],
  });

  assert.equal(read.status, 200, JSON.stringify(read.json));
  assert.ok(Array.isArray(read.json.data[0].service_ids), 'must be an array, got: ' + JSON.stringify(read.json.data[0].service_ids));
  assert.deepEqual(read.json.data[0].service_ids, [1, 2]);
});

test('a registrar can retire a template (soft delete via active=0)', async (t) => {
  const { db, server, base } = await startServer();
  t.after(() => { server.close(); db.close(); });
  const cookie = await login(base, 'reg');
  const made = await dbCall(base, cookie, newTemplate);

  const res = await dbCall(base, cookie, {
    table: 'service_templates', op: 'update', values: { active: false },
    filters: [{ col: 'id', op: 'eq', val: made.json.data.id }],
  });

  assert.equal(res.status, 200, 'registrar must be able to retire a template: ' + JSON.stringify(res.json));
  assert.equal(db.prepare('SELECT active FROM service_templates WHERE id=?').get(made.json.data.id).active, 0);
});

test('hard delete stays admin-only', async (t) => {
  const { db, server, base } = await startServer();
  t.after(() => { server.close(); db.close(); });
  const cookie = await login(base, 'reg');
  const made = await dbCall(base, cookie, newTemplate);

  const res = await dbCall(base, cookie, {
    table: 'service_templates', op: 'delete',
    filters: [{ col: 'id', op: 'eq', val: made.json.data.id }],
  });

  assert.equal(res.status, 403, 'registrar must not hard-delete a template: ' + JSON.stringify(res.json));
});

// The grant is for the role that runs the booking flow, not for everyone.
test('a cashier still cannot save a template', async (t) => {
  const { db, server, base } = await startServer();
  t.after(() => { server.close(); db.close(); });

  const res = await dbCall(base, await login(base, 'money'), newTemplate);

  assert.equal(res.status, 403, 'cashier must not write templates: ' + JSON.stringify(res.json));
});
