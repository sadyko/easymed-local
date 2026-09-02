// STAFF_DELETE_V1 — the rule that decides delete vs deactivate for an employee.
//
// An employee row is the only thing that still names the person on a visit, a
// bill, a cash shift or an audit line. Deleting one who has history would not
// just break a join — it would erase WHO did something to a patient, which is
// exactly what a clinical record exists to preserve. So deletion is allowed only
// for an account nothing points at (the mistyped one created five minutes ago),
// and refused with a breakdown otherwise.
//
// Each blocking table is pinned separately: dropping any one from the list
// silently re-opens the hole for that kind of record.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { hashPassword } from '../services/auth.js';
import { createApp } from '../app.js';
import { staffDeleteGuard } from './users.js';
import { licensedDataDir } from '../services/control/licensed-fixture.js';   // LICENCE_CORE_V1
import { listen } from '../../control-plane/server/test-helpers/listen.js';

async function startServer() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)')
    .run('boss', hashPassword('password1'), 'Boss', 'admin');
  // LICENCE_CORE_V1 — enrolled+active so DELETE /api/users (this file's
  // subject) never trips the write gate; predates licensing.
  const server = await listen(createApp(db, { dataDir: licensedDataDir() }));
  return { db, server, base: `http://127.0.0.1:${server.address().port}` };
}

async function loginAdmin(base) {
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'boss', password: 'password1' }),
  });
  assert.equal(res.status, 200);
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

async function call(base, cookie, path, method = 'GET', body) {
  const res = await fetch(base + '/api/users' + path, {
    method, headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

// A plain employee with no history attached.
async function addStaff(base, cookie, username, role = 'nurse') {
  const res = await call(base, cookie, '', 'POST', {
    username, password: 'ChangeMe123', role, last_name: 'Тестов', first_name: 'Тест',
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json.user;
}

test('deletes an employee nothing references', async (t) => {
  const { db, server, base } = await startServer();
  t.after(() => { server.close(); db.close(); });
  const cookie = await loginAdmin(base);
  const emp = await addStaff(base, cookie, 'n.one');

  const chk = await call(base, cookie, `/${emp.id}/delete-check`);
  assert.equal(chk.status, 200);
  assert.equal(chk.json.deletable, true);
  assert.deepEqual(chk.json.blocking, []);

  const del = await call(base, cookie, `/${emp.id}`, 'DELETE');
  assert.equal(del.status, 200, JSON.stringify(del.json));
  assert.equal(del.json.deleted, true);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM users WHERE id = ?').get(emp.id).n, 0);
});

test('config rows (rates, branches, specialties) go with the employee', async (t) => {
  const { db, server, base } = await startServer();
  t.after(() => { server.close(); db.close(); });
  const cookie = await loginAdmin(base);
  const emp = await addStaff(base, cookie, 'd.one', 'doctor');
  const svc = db.prepare("INSERT INTO services (name, price) VALUES ('Приём', 50000)").run().lastInsertRowid;
  const branch = db.prepare("INSERT INTO branches (name) VALUES ('Главный')").run().lastInsertRowid;
  db.prepare('INSERT INTO doctor_rates (doctor_id, service_id, percent) VALUES (?,?,30)').run(emp.id, svc);
  db.prepare('INSERT INTO user_branches (user_id, branch_id) VALUES (?,?)').run(emp.id, branch);

  assert.equal((await call(base, cookie, `/${emp.id}/delete-check`)).json.deletable, true);
  assert.equal((await call(base, cookie, `/${emp.id}`, 'DELETE')).status, 200);

  assert.equal(db.prepare('SELECT COUNT(*) n FROM doctor_rates WHERE doctor_id = ?').get(emp.id).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM user_branches WHERE user_id = ?').get(emp.id).n, 0);
  // The service itself is untouched — it belongs to the clinic, not the doctor.
  assert.equal(db.prepare('SELECT COUNT(*) n FROM services WHERE id = ?').get(svc).n, 1);
});

test('a doctor who has seen a patient cannot be deleted — the visit keeps naming them', async (t) => {
  const { db, server, base } = await startServer();
  t.after(() => { server.close(); db.close(); });
  const cookie = await loginAdmin(base);
  const emp = await addStaff(base, cookie, 'd.busy', 'doctor');
  const pat = db.prepare("INSERT INTO patients (full_name) VALUES ('Пациент П.')").run().lastInsertRowid;
  db.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date) VALUES (?,?, '2026-08-16')").run(pat, emp.id);

  const chk = await call(base, cookie, `/${emp.id}/delete-check`);
  assert.equal(chk.json.deletable, false);
  assert.deepEqual(chk.json.blocking.map((b) => b.table), ['visits']);

  const del = await call(base, cookie, `/${emp.id}`, 'DELETE');
  assert.equal(del.status, 409);
  assert.match(del.json.error.message, /визиты: 1/);
  assert.match(del.json.error.message, /Отключите/, 'the refusal must point at deactivation');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM users WHERE id = ?').get(emp.id).n, 1);
});

test('a cashier who took money cannot be deleted', async (t) => {
  const { db, server, base } = await startServer();
  t.after(() => { server.close(); db.close(); });
  const cookie = await loginAdmin(base);
  const emp = await addStaff(base, cookie, 'c.one', 'cashier');
  const pat = db.prepare("INSERT INTO patients (full_name) VALUES ('Пациент П.')").run().lastInsertRowid;
  const inv = db.prepare("INSERT INTO invoices (patient_id, total_amount, status) VALUES (?, 50000, 'paid')").run(pat).lastInsertRowid;
  db.prepare("INSERT INTO payments (invoice_id, amount, method, cashier_id) VALUES (?, 50000, 'cash', ?)").run(inv, emp.id);

  const del = await call(base, cookie, `/${emp.id}`, 'DELETE');
  assert.equal(del.status, 409);
  assert.match(del.json.error.message, /платежи: 1/);
});

test('the refusal names every kind of record, not just the first', async (t) => {
  const { db, server, base } = await startServer();
  t.after(() => { server.close(); db.close(); });
  const cookie = await loginAdmin(base);
  const emp = await addStaff(base, cookie, 'd.multi', 'doctor');
  const pat = db.prepare("INSERT INTO patients (full_name, primary_doctor_id) VALUES ('Пациент П.', ?)").run(emp.id).lastInsertRowid;
  db.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date) VALUES (?,?, '2026-08-16')").run(pat, emp.id);

  const chk = await call(base, cookie, `/${emp.id}/delete-check`);
  assert.deepEqual(chk.json.blocking.map((b) => b.table).sort(), ['patients', 'visits']);
  const del = await call(base, cookie, `/${emp.id}`, 'DELETE');
  assert.match(del.json.error.message, /визиты: 1/);
  assert.match(del.json.error.message, /карты пациентов: 1/);
});

test('an admin cannot delete their own account', async (t) => {
  const { db, server, base } = await startServer();
  t.after(() => { server.close(); db.close(); });
  const cookie = await loginAdmin(base);
  const me = db.prepare("SELECT id FROM users WHERE username = 'boss'").get().id;

  const chk = await call(base, cookie, `/${me}/delete-check`);
  assert.equal(chk.json.deletable, false);

  const del = await call(base, cookie, `/${me}`, 'DELETE');
  assert.equal(del.status, 409);
  assert.match(del.json.error.message, /собственную/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM users WHERE id = ?').get(me).n, 1);
});

// Tested against the guard directly, not over HTTP: reaching this case through
// the API would need the acting admin to be inactive, and an inactive account
// cannot hold a session — the request 401s before the guard runs. It is kept as
// defence in depth, mirroring the same guard on PATCH, so a future caller
// (an import, a script) cannot strand the clinic with no way back in.
test('the last active admin cannot be deleted', async (t) => {
  const { db, server } = await startServer();
  t.after(() => { server.close(); db.close(); });

  const onlyAdmin = db.prepare("SELECT * FROM users WHERE username = 'boss'").get();
  const someoneElse = { id: 999, role: 'admin' };
  const guard = staffDeleteGuard(db, onlyAdmin, someoneElse);
  assert.equal(guard.ok, false);
  assert.match(guard.reason, /администратор/);

  // With a second active admin on file the same call is allowed through.
  db.prepare("INSERT INTO users (username, password_hash, full_name, role, is_active) VALUES ('a.two','x','A Two','admin',1)").run();
  assert.equal(staffDeleteGuard(db, onlyAdmin, someoneElse).ok, true);
});

test('an inactive admin is not counted as the last one', async (t) => {
  const { db, server } = await startServer();
  t.after(() => { server.close(); db.close(); });
  db.prepare("INSERT INTO users (username, password_hash, full_name, role, is_active) VALUES ('a.off','x','A Off','admin',0)").run();
  const off = db.prepare("SELECT * FROM users WHERE username = 'a.off'").get();
  // Deleting an already-deactivated admin leaves the active one in place, so
  // there is nothing to guard against.
  assert.equal(staffDeleteGuard(db, off, { id: 1, role: 'admin' }).ok, true);
});

test('deleting an employee ends their sessions', async (t) => {
  const { db, server, base } = await startServer();
  t.after(() => { server.close(); db.close(); });
  const cookie = await loginAdmin(base);
  const emp = await addStaff(base, cookie, 'n.session');

  const logged = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'n.session', password: 'ChangeMe123' }),
  });
  assert.equal(logged.status, 200);
  assert.ok(db.prepare('SELECT COUNT(*) n FROM sessions WHERE user_id = ?').get(emp.id).n > 0);

  assert.equal((await call(base, cookie, `/${emp.id}`, 'DELETE')).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sessions WHERE user_id = ?').get(emp.id).n, 0);
});

test('a non-admin cannot delete anyone, nor run the check', async (t) => {
  const { db, server, base } = await startServer();
  t.after(() => { server.close(); db.close(); });
  const adminCookie = await loginAdmin(base);
  const victim = await addStaff(base, adminCookie, 'n.victim');
  await addStaff(base, adminCookie, 'r.one', 'registrar');

  const logged = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'r.one', password: 'ChangeMe123' }),
  });
  const regCookie = logged.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');

  assert.equal((await call(base, regCookie, `/${victim.id}`, 'DELETE')).status, 403);
  assert.equal((await call(base, regCookie, `/${victim.id}/delete-check`)).status, 403);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM users WHERE id = ?').get(victim.id).n, 1);
});

test('deleting an unknown employee is a 404, not a silent success', async (t) => {
  const { db, server, base } = await startServer();
  t.after(() => { server.close(); db.close(); });
  const cookie = await loginAdmin(base);
  assert.equal((await call(base, cookie, '/999999', 'DELETE')).status, 404);
  assert.equal((await call(base, cookie, '/999999/delete-check')).status, 404);
});
