// CALLCENTER_ROLE_V1 — the call centre is its own job, so it is its own role.
//
// The bug this pins: a call-centre operator opened «Даты приёма», filled the
// doctor and the date, pressed «Сохранить и записать» and got a bare «not
// allowed» toast. Nothing in the CRM code was wrong. There are TWO permission
// systems and only one of them had been configured:
//
//   role_permissions (in the DB, Settings → Роли)  -> which SECTIONS a role sees
//   schema-registry ACL (hard-coded in code)       -> which TABLE OPS it may do
//
// canWrite() takes no db handle, so it cannot consult role_permissions even in
// principle. Granting the склад role the `crm` section therefore rendered the
// board — crm_requests.read is ALL_STAFF — and then refused every write, which
// stayed hard-coded to ['admin','registrar'].
//
// The clinic had worked around it by repurposing 'inventory' as the call centre
// and, for one account, adding 'registrar' to «Дополнительные роли» — which
// hands a phone operator the entire registrar right set. These tests pin a real
// 'callcenter' role instead: it may run the CRM board and register the patient
// it is talking to, and nothing else.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { hashPassword } from '../services/auth.js';
import { createApp } from '../app.js';

function startServer() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare('INSERT INTO users (username, password_hash, full_name, role, extra_roles) VALUES (?,?,?,?,?)')
    .run('operator', hashPassword('password1'), 'Оператор Колл-центра', 'callcenter', '');
  // A doctor to book against, and a service that requires one — the exact shape
  // of the «Консультация кардиолога» line in the report.
  db.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)')
    .run('cardio', hashPassword('password1'), 'Каххоров Сирожиддин', 'doctor');
  db.prepare('INSERT INTO services (name, price, requires_doctor) VALUES (?,?,1)')
    .run('Консультация кардиолога', 100000);
  return new Promise((resolve) => {
    const server = createApp(db).listen(0, '127.0.0.1', () => {
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

async function rpc(base, cookie, name, args) {
  const res = await fetch(base + '/api/rpc/' + name, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(args),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

const newRequest = {
  table: 'crm_requests', op: 'insert', returning: true, single: 'single',
  values: { full_name: 'Пациент Тест', phone: '+998950768008', source: 'call', status: 'scheduled' },
};

// The reported failure, end to end: create the request, then write the dated
// service line with its doctor. Both halves are one click in «Сохранить и
// записать», so both must be allowed or the button is dead.
test('a callcenter user can book a dated service on a CRM request', async (t) => {
  const { db, server, base } = await startServer();
  t.after(() => { server.close(); db.close(); });
  const cookie = await login(base, 'operator');

  const req = await dbCall(base, cookie, newRequest);
  assert.equal(req.status, 200, 'callcenter must create the CRM request: ' + JSON.stringify(req.json));

  const line = await dbCall(base, cookie, {
    table: 'crm_request_services', op: 'insert', returning: true, single: 'single',
    values: { request_id: req.json.data.id, service_id: 1, scheduled_date: '2026-08-17', doctor_id: 2, status: 'pending' },
  });

  assert.equal(line.status, 200, 'callcenter must book the dated service line: ' + JSON.stringify(line.json));
  assert.equal(line.json.data.doctor_id, 2);
  assert.equal(line.json.data.scheduled_date, '2026-08-17');
});

// Editing a booking replaces the whole line set: saveLines() cancels the pending
// rows and inserts the current ones. Without the update grant the edit silently
// keeps the old dates.
test('a callcenter user can re-book an existing request', async (t) => {
  const { db, server, base } = await startServer();
  t.after(() => { server.close(); db.close(); });
  const cookie = await login(base, 'operator');
  const req = await dbCall(base, cookie, newRequest);
  await dbCall(base, cookie, {
    table: 'crm_request_services', op: 'insert', returning: true, single: 'single',
    values: { request_id: req.json.data.id, service_id: 1, scheduled_date: '2026-08-17', status: 'pending' },
  });

  const upd = await dbCall(base, cookie, {
    table: 'crm_requests', op: 'update',
    values: { status: 'scheduled', note: 'перенос' },
    filters: [{ col: 'id', op: 'eq', val: req.json.data.id }],
  });
  const cancel = await dbCall(base, cookie, {
    table: 'crm_request_services', op: 'update', values: { status: 'cancelled' },
    filters: [{ col: 'request_id', op: 'eq', val: req.json.data.id }, { col: 'status', op: 'eq', val: 'pending' }],
  });

  assert.equal(upd.status, 200, 'callcenter must update the request: ' + JSON.stringify(upd.json));
  assert.equal(cancel.status, 200, 'callcenter must cancel superseded lines: ' + JSON.stringify(cancel.json));
});

// «Зарегистрировать» in the CRM card creates the patient card from the call.
// It is the same screen and one click away, so denying it would just move the
// identical bare «not allowed» one button over.
test('a callcenter user can register the patient they are talking to', async (t) => {
  const { db, server, base } = await startServer();
  t.after(() => { server.close(); db.close(); });

  const pat = await dbCall(base, await login(base, 'operator'), {
    table: 'patients', op: 'insert', returning: true, single: 'single',
    values: { full_name: 'Пациент Тест', phone: '+998950768008' },
  });

  assert.equal(pat.status, 200, 'callcenter must create the patient card: ' + JSON.stringify(pat.json));
});

// Scope. The call centre books and hands over; it does not open visits, and
// CRM_SCHEDULE_V1 says so in as many words («он не берёт деньги и не оформляет
// визит»). This is what separates the new role from the registrar workaround.
test('a callcenter user cannot open a visit', async (t) => {
  const { db, server, base } = await startServer();
  t.after(() => { server.close(); db.close(); });
  const cookie = await login(base, 'operator');
  const pat = await dbCall(base, cookie, {
    table: 'patients', op: 'insert', returning: true, single: 'single',
    values: { full_name: 'Пациент Тест', phone: '+998950768008' },
  });

  const res = await rpc(base, cookie, 'ensure_visit', { patient_id: pat.json.data.id, date: '2026-08-20' });

  assert.equal(res.status, 403, 'callcenter must not create visits: ' + JSON.stringify(res.json));
});

test('a callcenter user cannot delete a CRM request', async (t) => {
  const { db, server, base } = await startServer();
  t.after(() => { server.close(); db.close(); });
  const cookie = await login(base, 'operator');
  const req = await dbCall(base, cookie, newRequest);

  const res = await dbCall(base, cookie, {
    table: 'crm_requests', op: 'delete',
    filters: [{ col: 'id', op: 'eq', val: req.json.data.id }],
  });

  assert.equal(res.status, 403, 'deleting a request stays admin-only: ' + JSON.stringify(res.json));
});

// The role is useless if an admin cannot assign it in Employees.
test('callcenter is assignable as an employee role', async (t) => {
  const { db, server, base } = await startServer();
  t.after(() => { server.close(); db.close(); });
  db.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)')
    .run('boss', hashPassword('password1'), 'Админ', 'admin');

  const res = await fetch(base + '/api/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: await login(base, 'boss') },
    body: JSON.stringify({ username: 'operator2', password: 'password1', full_name: 'Оператор 2', role: 'callcenter' }),
  });

  assert.equal(res.status, 201, 'admin must be able to create a callcenter employee: ' + await res.text());
});
