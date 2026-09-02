// DATA_TRANSFER_V1 — the write paths the Excel importer depends on for the
// three roster sections (services, patients, employees).
//
// The importer runs in the browser, so what can actually be tested here is the
// contract it writes against: the exact request shapes it sends, against the
// real app + a real migrated database. That is where the interesting failures
// live — a section pointed at a route this build does not mount, or a template
// column the table does not have, both of which fail *silently* (a 404 swallowed
// into "0 imported", or an unknown key quietly dropped on insert).
//
// Payload shapes below mirror public/js/admin/views/section-import-export.js:
//   services / patients -> POST /api/db  (descriptor, batch insert)
//   users               -> POST|PATCH /api/users  (one row at a time)

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { hashPassword } from '../services/auth.js';
import { createApp } from '../app.js';
import { licensedDataDir } from '../services/control/licensed-fixture.js';   // LICENCE_CORE_V1
import { listen } from '../../control-plane/server/test-helpers/listen.js';

async function startServer() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)')
    .run('boss', hashPassword('password1'), 'Boss', 'admin');
  // LICENCE_CORE_V1 — enrolled+active so the write gate (routes/db.js,
  // routes/rpc.js) never fires; this file predates licensing.
  const server = await listen(createApp(db, { dataDir: licensedDataDir() }));
  return { db, server, base: `http://127.0.0.1:${server.address().port}` };
}

async function loginAdmin(base) {
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'boss', password: 'password1' }),
  });
  assert.equal(res.status, 200, 'admin login should succeed');
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

// One /api/db call, shaped exactly like public/js/db-client.js builds it.
async function db(base, cookie, desc) {
  const res = await fetch(base + '/api/db', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(desc),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

async function usersApi(base, cookie, path, method, body) {
  const res = await fetch(base + '/api/users' + path, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

test('services import: a batch insert lands through /api/db, not the gateway', async (t) => {
  const { db: sqlite, server, base } = await startServer();
  t.after(() => { server.close(); sqlite.close(); });
  const cookie = await loginAdmin(base);

  // The importer omits blank cells so DB defaults fire — hence ragged keys.
  const rows = [
    { name: 'Приём кардиолога', type: 'consultation', price: 250000, tax_rate: 12, duration_minutes: 30, requires_doctor: true, active: true },
    { name: 'Общий анализ крови', type: 'lab', price: 80000, duration_minutes: 15, requires_doctor: false, active: true },
  ];
  const { status, json } = await db(base, cookie, { table: 'services', op: 'insert', values: rows });
  assert.equal(status, 200, 'batch insert should be accepted: ' + JSON.stringify(json));

  const read = await db(base, cookie, { table: 'services', op: 'select', columns: '*', filters: [], order: [{ col: 'name', asc: true }] });
  const names = read.json.data.map((r) => r.name);
  assert.ok(names.includes('Приём кардиолога'));
  assert.ok(names.includes('Общий анализ крови'));
  // The routing column is what sends a service to the lab module vs the cabinet.
  const cbc = read.json.data.find((r) => r.name === 'Общий анализ крови');
  assert.equal(cbc.type, 'lab');
  assert.equal(cbc.duration_minutes, 15);
});

test('services import: FK auto-create targets are writable (service_types, service_categories, departments)', async (t) => {
  const { db: sqlite, server, base } = await startServer();
  t.after(() => { server.close(); sqlite.close(); });
  const cookie = await loginAdmin(base);

  // autoCreatePendingFks() inserts exactly {<keyField>: value, active: true}.
  for (const table of ['service_types', 'service_categories', 'departments']) {
    const { status, json } = await db(base, cookie, {
      table, op: 'insert', values: { name: 'Импорт ' + table, active: true }, returning: true, single: 'single',
    });
    assert.equal(status, 200, `${table} auto-create should be accepted: ` + JSON.stringify(json));
    assert.ok(json.data && json.data.id, `${table} should return the new id`);
  }
});

test('patients import: every template column is a real, writable column', async (t) => {
  const { db: sqlite, server, base } = await startServer();
  t.after(() => { server.close(); sqlite.close(); });
  const cookie = await loginAdmin(base);

  // Mirrors IMPORT_CONFIGS.patients.columns. Unknown keys are silently dropped
  // by the write layer, so this asserts on read-back rather than on the status.
  const payload = {
    last_name: 'Karimova', first_name: 'Aziza', middle_name: 'R.',
    full_name: 'Karimova Aziza R.',
    date_of_birth: '1990-04-12', gender: 'female',
    phone: '+998 90 123 45 67', email: 'aziza.k@example.com',
    national_id: '31204900010011', nationality: 'Uzbek',
    address: 'Amir Temur 12, apt. 47', blood_type: 'A+',
    allergies: 'Penicillin', chronic_conditions: 'Hypertension',
    active: true,
  };
  const ins = await db(base, cookie, { table: 'patients', op: 'insert', values: payload, returning: true, single: 'single' });
  assert.equal(ins.status, 200, 'patient insert should be accepted: ' + JSON.stringify(ins.json));

  const got = ins.json.data;
  for (const [k, v] of Object.entries(payload)) {
    if (k === 'active') continue;              // stored as 0/1
    assert.equal(got[k], v, `column ${k} must round-trip, not be dropped`);
  }
  assert.ok(got.mrn, 'MRN is assigned automatically — that is what makes an export re-importable');
});

test('patients import: columns the table does not have are dropped silently — so none may sit in the template', async (t) => {
  const { db: sqlite, server, base } = await startServer();
  t.after(() => { server.close(); sqlite.close(); });
  const cookie = await loginAdmin(base);

  const ins = await db(base, cookie, {
    table: 'patients', op: 'insert', returning: true, single: 'single',
    values: { full_name: 'Ghost Column', last_name: 'Ghost', first_name: 'Column', passport_number: 'AB1234567', region: 'Tashkent', district: 'Yunusobod' },
  });
  assert.equal(ins.status, 200);
  // This is the trap: the write succeeds and the data is gone. The importer
  // config must therefore not advertise these columns.
  assert.equal(ins.json.data.passport_number, undefined);
  assert.equal(ins.json.data.region, undefined);
  assert.equal(ins.json.data.district, undefined);
});

test('patients export/import round-trip: re-importing by MRN updates instead of duplicating', async (t) => {
  const { db: sqlite, server, base } = await startServer();
  t.after(() => { server.close(); sqlite.close(); });
  const cookie = await loginAdmin(base);

  const ins = await db(base, cookie, {
    table: 'patients', op: 'insert', returning: true, single: 'single',
    values: { full_name: 'Round Trip', last_name: 'Round', first_name: 'Trip', phone: '+998 90 000 00 01' },
  });
  const { id, mrn } = ins.json.data;
  assert.ok(mrn);

  // runImport() resolves the match by reading id + the match fields, then PATCHes.
  const existing = await db(base, cookie, { table: 'patients', op: 'select', columns: 'id, mrn, national_id', filters: [], order: [] });
  const hit = existing.json.data.find((r) => r.mrn === mrn);
  assert.equal(hit.id, id, 'MRN must resolve back to the same row');

  const upd = await db(base, cookie, {
    table: 'patients', op: 'update', values: { phone: '+998 90 000 00 02' },
    filters: [{ col: 'id', op: 'eq', val: id }],
  });
  assert.equal(upd.status, 200, JSON.stringify(upd.json));

  const after = await db(base, cookie, { table: 'patients', op: 'select', columns: '*', filters: [], order: [] });
  assert.equal(after.json.data.length, 1, 're-import must not create a second row');
  assert.equal(after.json.data[0].phone, '+998 90 000 00 02');
});

test('employees import: /api/db refuses users — the importer must use /api/users', async (t) => {
  const { db: sqlite, server, base } = await startServer();
  t.after(() => { server.close(); sqlite.close(); });
  const cookie = await loginAdmin(base);

  const res = await db(base, cookie, {
    table: 'users', op: 'insert', values: { username: 'via.db', full_name: 'Nope', role: 'nurse' },
  });
  assert.notEqual(res.status, 200, 'users must stay read-only through /api/db');
});

test('employees import: insert + update go through /api/users', async (t) => {
  const { db: sqlite, server, base } = await startServer();
  t.after(() => { server.close(); sqlite.close(); });
  const cookie = await loginAdmin(base);

  const dept = await db(base, cookie, { table: 'departments', op: 'insert', values: { name: 'Поликлиника', active: true }, returning: true, single: 'single' });
  const deptId = dept.json.data.id;

  // Exactly what IMPORT_CONFIGS.users builds for a new employee.
  const created = await usersApi(base, cookie, '', 'POST', {
    username: 'a.yusupov', password: 'ChangeMe123', role: 'doctor',
    last_name: 'Юсупов', first_name: 'Азиз', middle_name: 'Рустамович',
    full_name: 'Юсупов Азиз Рустамович',
    staff_type: 'doctor', is_doctor: true, specialty: 'Кардиология', position: 'Врач-кардиолог',
    phone: '+998 90 123 45 67', email: 'a.yusupov@example.uz',
    department_id: deptId, license_number: 'AA-000123', license_expiry_date: '2028-05-01',
    hire_date: '2026-01-15', salary_type: 'percentage', salary_fixed: 0, salary_percent: 30,
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const emp = created.json.user;
  assert.equal(emp.role, 'doctor');
  assert.equal(emp.is_doctor, true);
  assert.equal(emp.department_id, deptId);
  assert.equal(emp.specialty, 'Кардиология');
  assert.equal(emp.salary_percent, 30);

  // Re-import of an exported file: same username, no password column.
  const updated = await usersApi(base, cookie, '/' + emp.id, 'PATCH', {
    role: 'doctor', last_name: 'Юсупов', first_name: 'Азиз', specialty: 'Кардиология и УЗИ', is_active: true,
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.json));
  assert.equal(updated.json.user.specialty, 'Кардиология и УЗИ');

  const list = await usersApi(base, cookie, '', 'GET');
  assert.equal(list.json.users.filter((u) => u.username === 'a.yusupov').length, 1, 'update must not duplicate the employee');
  // The export reads this list; it must never carry password material.
  const exported = list.json.users.find((u) => u.username === 'a.yusupov');
  assert.equal(exported.password, undefined);
  assert.equal(exported.password_hash, undefined);
});

// SERVICE_DELETE_V1 — over HTTP, because the guard is only worth anything if
// the route actually reaches it and the refusal survives as a readable message.
test('service delete: /api/db still refuses DELETE on services — the RPC is the only door', async (t) => {
  const { db: sqlite, server, base } = await startServer();
  t.after(() => { server.close(); sqlite.close(); });
  const cookie = await loginAdmin(base);

  const ins = await db(base, cookie, { table: 'services', op: 'insert', values: { name: 'Через /api/db', price: 1 }, returning: true, single: 'single' });
  const id = ins.json.data.id;

  const del = await db(base, cookie, { table: 'services', op: 'delete', filters: [{ col: 'id', op: 'eq', val: id }] });
  assert.notEqual(del.status, 200, 'the generic delete verb must stay closed');

  const still = await db(base, cookie, { table: 'services', op: 'select', columns: 'id', filters: [{ col: 'id', op: 'eq', val: id }], order: [] });
  assert.equal(still.json.data.length, 1);
});

test('service delete: unused service goes over /api/rpc; a used one is refused with 409', async (t) => {
  const { db: sqlite, server, base } = await startServer();
  t.after(() => { server.close(); sqlite.close(); });
  const cookie = await loginAdmin(base);

  const rpc = async (name, body) => {
    const res = await fetch(base + '/api/rpc/' + name, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };

  const unused = (await db(base, cookie, { table: 'services', op: 'insert', values: { name: 'test lab', price: 1 }, returning: true, single: 'single' })).json.data;
  const used   = (await db(base, cookie, { table: 'services', op: 'insert', values: { name: 'Приём кардиолога', price: 250000 }, returning: true, single: 'single' })).json.data;

  // Give the second one history: a patient's visit line.
  const patient = (await db(base, cookie, { table: 'patients', op: 'insert', values: { full_name: 'Тестов Тест' }, returning: true, single: 'single' })).json.data;
  const visit = (await db(base, cookie, { table: 'visits', op: 'insert', values: { patient_id: patient.id, visit_date: '2026-08-16' }, returning: true, single: 'single' })).json.data;
  const line = await db(base, cookie, { table: 'visit_services', op: 'insert', values: { visit_id: visit.id, service_id: used.id, quantity: 1, unit_price: 250000, total: 250000 } });
  assert.equal(line.status, 200, JSON.stringify(line.json));

  const chk = await rpc('service_delete_check', { p_service_id: unused.id });
  assert.equal(chk.status, 200);
  assert.equal(chk.json.data.deletable, true);

  const gone = await rpc('delete_service', { p_service_id: unused.id });
  assert.equal(gone.status, 200, JSON.stringify(gone.json));
  // Asserted by presence, not by listing the table: migrations seed services of
  // their own, and a seeded row appearing here is not this test's business.
  const after = await db(base, cookie, { table: 'services', op: 'select', columns: 'id, name', filters: [], order: [] });
  const names = after.json.data.map((s) => s.name);
  assert.ok(!names.includes('test lab'), 'the unused service is gone');
  assert.ok(names.includes('Приём кардиолога'), 'the used one is untouched');

  const refused = await rpc('delete_service', { p_service_id: used.id });
  assert.equal(refused.status, 409);
  assert.match(refused.json.error.message, /визиты: 1/);
  assert.match(refused.json.error.message, /Отключите/);
});

test('service delete: a non-admin cannot delete', async (t) => {
  const { db: sqlite, server, base } = await startServer();
  t.after(() => { server.close(); sqlite.close(); });
  const adminCookie = await loginAdmin(base);

  const svc = (await db(base, adminCookie, { table: 'services', op: 'insert', values: { name: 'Не трогать', price: 1 }, returning: true, single: 'single' })).json.data;

  await usersApi(base, adminCookie, '', 'POST', { username: 'reg.one', password: 'ChangeMe123', role: 'registrar', full_name: 'Reg One' });
  const logged = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'reg.one', password: 'ChangeMe123' }),
  });
  const regCookie = logged.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');

  const res = await fetch(base + '/api/rpc/delete_service', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: regCookie },
    body: JSON.stringify({ p_service_id: svc.id }),
  });
  assert.equal(res.status, 403);

  const still = await db(base, adminCookie, { table: 'services', op: 'select', columns: 'id', filters: [{ col: 'id', op: 'eq', val: svc.id }], order: [] });
  assert.equal(still.json.data.length, 1);
});

test('employees import: a new employee without a usable password is rejected', async (t) => {
  const { db: sqlite, server, base } = await startServer();
  t.after(() => { server.close(); sqlite.close(); });
  const cookie = await loginAdmin(base);

  const short = await usersApi(base, cookie, '', 'POST', { username: 'x.short', password: 'abc', role: 'nurse' });
  assert.equal(short.status, 400);
  const none = await usersApi(base, cookie, '', 'POST', { username: 'x.none', role: 'nurse' });
  assert.equal(none.status, 400);
  const badRole = await usersApi(base, cookie, '', 'POST', { username: 'x.role', password: 'ChangeMe123', role: 'wizard' });
  assert.equal(badRole.status, 400);
});
