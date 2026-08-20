import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { hashPassword } from '../services/auth.js';
import { createApp } from '../app.js';
import { parseEmployeeFields } from './users.js';
import { licensedDataDir } from '../services/control/licensed-fixture.js';   // LICENCE_CORE_V1

// Mirrors server/app.test.js's harness (startServer/post) since that file
// does not export its helpers.
function startServer() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)')
    .run('boss', hashPassword('password1'), 'Boss', 'admin');
  return new Promise((resolve) => {
    // LICENCE_CORE_V1 — enrolled+active so the write gate on POST/PATCH/DELETE
    // /api/users (this file's whole subject) never fires; predates licensing.
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

async function patch(base, path, body, cookie) {
  return fetch(base + path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
}

async function loginAdmin(base) {
  const res = await post(base, '/api/auth/login', { username: 'boss', password: 'password1' });
  return res.headers.get('set-cookie').split(';')[0];
}

test('POST /api/users stores full employee data and derives full_name', async () => {
  const { server, base } = await startServer();
  try {
    const admin = await loginAdmin(base);
    const res = await post(base, '/api/users', {
      username: 'dr.ivanov', password: 'password2', role: 'doctor',
      last_name: 'Ivanov', first_name: 'Petr', middle_name: 'Sergeevich',
      phone: '+998901234567', email: 'ivanov@example.com',
      is_doctor: true, specialty: 'Cardiology', doctor_category: 'first',
      hire_date: '2020-01-15', license_number: 'LIC-001',
      employment_type: 'official', salary_type: 'fixed', salary_fixed: 5000000,
    }, admin);
    assert.equal(res.status, 201);
    const u = (await res.json()).user;
    assert.equal(u.full_name, 'Ivanov Petr Sergeevich');
    assert.equal(u.is_doctor, true);
    assert.equal(u.salary_fixed, 5000000);
    assert.equal(u.department_id, null);
    assert.equal(u.phone, '+998901234567');
    assert.equal(u.doctor_category, 'first');
    assert.equal(u.employment_type, 'official');
    assert.equal(u.salary_type, 'fixed');
    assert.equal(u.hire_date, '2020-01-15');
    assert.equal(u.license_number, 'LIC-001');
  } finally { server.close(); }
});

test('PATCH /api/users/:id updates employee fields without touching omitted full_name parts', async () => {
  const { server, base } = await startServer();
  try {
    const admin = await loginAdmin(base);
    let res = await post(base, '/api/users', {
      username: 'nursea', password: 'password2', role: 'nurse',
      last_name: 'Petrova', first_name: 'Anna', middle_name: '',
      phone: '+998900000000',
    }, admin);
    const created = (await res.json()).user;
    assert.equal(created.full_name, 'Petrova Anna');

    res = await patch(base, `/api/users/${created.id}`, {
      phone: '+998911111111', salary_type: 'percentage', salary_percent: 20,
    }, admin);
    assert.equal(res.status, 200);
    const updated = (await res.json()).user;
    assert.equal(updated.phone, '+998911111111');
    assert.equal(updated.salary_type, 'percentage');
    assert.equal(updated.salary_percent, 20);
    assert.equal(updated.full_name, 'Petrova Anna', 'full_name unchanged when name parts omitted');
  } finally { server.close(); }
});

test('employee field validation: doctor_category, salary_percent range, unknown department', async () => {
  const { server, base } = await startServer();
  try {
    const admin = await loginAdmin(base);

    let res = await post(base, '/api/users', {
      username: 'baduser1', password: 'password2', role: 'doctor', doctor_category: 'bogus',
    }, admin);
    assert.equal(res.status, 400);

    res = await post(base, '/api/users', {
      username: 'baduser2', password: 'password2', role: 'doctor', salary_percent: 150,
    }, admin);
    assert.equal(res.status, 400);

    res = await post(base, '/api/users', {
      username: 'baduser3', password: 'password2', role: 'doctor', department_id: 999999,
    }, admin);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.message, 'Unknown department.');

    // create a valid user, then re-run the same validations via PATCH
    res = await post(base, '/api/users', { username: 'okuser', password: 'password2', role: 'doctor' }, admin);
    const ok = (await res.json()).user;

    res = await patch(base, `/api/users/${ok.id}`, { doctor_category: 'bogus' }, admin);
    assert.equal(res.status, 400);
    res = await patch(base, `/api/users/${ok.id}`, { salary_percent: 150 }, admin);
    assert.equal(res.status, 400);
    res = await patch(base, `/api/users/${ok.id}`, { department_id: 999999 }, admin);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.message, 'Unknown department.');

    // no cookie -> 401
    res = await post(base, '/api/users', { username: 'x', password: 'password2', role: 'doctor' });
    assert.equal(res.status, 401);

    // non-admin -> 403
    res = await post(base, '/api/users', { username: 'reguser', password: 'password2', role: 'registrar' }, admin);
    assert.equal(res.status, 201);
    res = await post(base, '/api/auth/login', { username: 'reguser', password: 'password2' });
    const regCookie = res.headers.get('set-cookie').split(';')[0];
    res = await post(base, '/api/users', { username: 'y', password: 'password2', role: 'doctor' }, regCookie);
    assert.equal(res.status, 403);
  } finally { server.close(); }
});

test('POST /api/users with staff_type:doctor derives is_doctor:true and stores category fields', async () => {
  const { server, base } = await startServer();
  try {
    const admin = await loginAdmin(base);
    const res = await post(base, '/api/users', {
      username: 'dr.doctorov', password: 'password2', role: 'doctor',
      staff_type: 'doctor', scheduling_mode: 'live_queue', service_rate_default: 30,
    }, admin);
    assert.equal(res.status, 201);
    const u = (await res.json()).user;
    assert.equal(u.staff_type, 'doctor');
    assert.equal(u.is_doctor, true);
    assert.equal(u.scheduling_mode, 'live_queue');
    assert.equal(u.service_rate_default, 30);
  } finally { server.close(); }
});

test('staff_type:admin_staff derives is_doctor:false even if is_doctor:true is also sent (POST and PATCH)', async () => {
  const { server, base } = await startServer();
  try {
    const admin = await loginAdmin(base);
    let res = await post(base, '/api/users', {
      username: 'admin.staffer', password: 'password2', role: 'registrar',
      staff_type: 'admin_staff', is_doctor: true,
    }, admin);
    assert.equal(res.status, 201);
    let u = (await res.json()).user;
    assert.equal(u.staff_type, 'admin_staff');
    assert.equal(u.is_doctor, false, 'server overrides client-sent is_doctor:true');

    // create a doctor-flagged user, then PATCH staff_type to admin_staff with is_doctor:true still sent
    res = await post(base, '/api/users', {
      username: 'was.doctor', password: 'password2', role: 'doctor', staff_type: 'doctor',
    }, admin);
    const created = (await res.json()).user;
    assert.equal(created.is_doctor, true);

    res = await patch(base, `/api/users/${created.id}`, { staff_type: 'admin_staff', is_doctor: true }, admin);
    assert.equal(res.status, 200);
    u = (await res.json()).user;
    assert.equal(u.staff_type, 'admin_staff');
    assert.equal(u.is_doctor, false, 'PATCH also overrides is_doctor from staff_type');
  } finally { server.close(); }
});

test('staff category validation: staff_type, scheduling_mode, branch_id, service_rate_default', async () => {
  const { server, base } = await startServer();
  try {
    const admin = await loginAdmin(base);

    let res = await post(base, '/api/users', {
      username: 'badcat1', password: 'password2', role: 'doctor', staff_type: 'bogus',
    }, admin);
    assert.equal(res.status, 400);

    res = await post(base, '/api/users', {
      username: 'badcat2', password: 'password2', role: 'doctor', scheduling_mode: 'nope',
    }, admin);
    assert.equal(res.status, 400);

    res = await post(base, '/api/users', {
      username: 'badcat3', password: 'password2', role: 'doctor', branch_id: 999999,
    }, admin);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.message, 'Unknown branch.');

    res = await post(base, '/api/users', {
      username: 'badcat4', password: 'password2', role: 'doctor', service_rate_default: 150,
    }, admin);
    assert.equal(res.status, 400);

    // re-run via PATCH against a valid user
    res = await post(base, '/api/users', { username: 'okcat', password: 'password2', role: 'doctor' }, admin);
    const ok = (await res.json()).user;

    res = await patch(base, `/api/users/${ok.id}`, { staff_type: 'bogus' }, admin);
    assert.equal(res.status, 400);
    res = await patch(base, `/api/users/${ok.id}`, { scheduling_mode: 'nope' }, admin);
    assert.equal(res.status, 400);
    res = await patch(base, `/api/users/${ok.id}`, { branch_id: 999999 }, admin);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.message, 'Unknown branch.');
    res = await patch(base, `/api/users/${ok.id}`, { referral_rate_default: -1 }, admin);
    assert.equal(res.status, 400);
  } finally { server.close(); }
});

test('PATCH working_hours round-trips a JSON string via GET', async () => {
  const { server, base } = await startServer();
  try {
    const admin = await loginAdmin(base);
    let res = await post(base, '/api/users', { username: 'hoursguy', password: 'password2', role: 'doctor' }, admin);
    const created = (await res.json()).user;
    assert.equal(created.working_hours, '');

    const hours = JSON.stringify({ mon: ['09:00', '18:00'], tue: ['09:00', '18:00'] });
    res = await patch(base, `/api/users/${created.id}`, { working_hours: hours }, admin);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).user.working_hours, hours);

    res = await fetch(base + '/api/users', { headers: { Cookie: admin } });
    assert.equal(res.status, 200);
    const list = (await res.json()).users;
    const found = list.find(u => u.id === created.id);
    assert.equal(found.working_hours, hours);
  } finally { server.close(); }
});

test('POST /api/users stores extra_roles as an array', async () => {
  const { server, base } = await startServer();
  try {
    const admin = await loginAdmin(base);
    const res = await post(base, '/api/users', {
      username: 'multi.role1', password: 'password2', role: 'registrar',
      extra_roles: ['cashier', 'lab'],
    }, admin);
    assert.equal(res.status, 201);
    const u = (await res.json()).user;
    assert.deepEqual(u.extra_roles, ['cashier', 'lab']);
  } finally { server.close(); }
});

test('extra_roles never contains the primary role: filtered on POST, and duplicates deduped', async () => {
  const { server, base } = await startServer();
  try {
    const admin = await loginAdmin(base);
    let res = await post(base, '/api/users', {
      username: 'multi.role2', password: 'password2', role: 'registrar',
      extra_roles: ['registrar', 'cashier', 'cashier'],
    }, admin);
    assert.equal(res.status, 201);
    const u = (await res.json()).user;
    assert.deepEqual(u.extra_roles, ['cashier']);

    res = await patch(base, `/api/users/${u.id}`, {
      role: 'registrar', extra_roles: ['registrar', 'lab', 'lab'],
    }, admin);
    assert.equal(res.status, 200);
    const updated = (await res.json()).user;
    assert.deepEqual(updated.extra_roles, ['lab']);
  } finally { server.close(); }
});

test('extra_roles validation: must be an array of known roles', async () => {
  const { server, base } = await startServer();
  try {
    const admin = await loginAdmin(base);

    let res = await post(base, '/api/users', {
      username: 'badroles1', password: 'password2', role: 'doctor', extra_roles: 'cashier',
    }, admin);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.message, 'extra_roles must be an array.');

    res = await post(base, '/api/users', {
      username: 'badroles2', password: 'password2', role: 'doctor', extra_roles: ['bogus'],
    }, admin);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.message, 'Unknown role in extra_roles.');

    // same validations via PATCH
    res = await post(base, '/api/users', { username: 'okroles', password: 'password2', role: 'doctor' }, admin);
    const ok = (await res.json()).user;

    res = await patch(base, `/api/users/${ok.id}`, { extra_roles: 'cashier' }, admin);
    assert.equal(res.status, 400);
    res = await patch(base, `/api/users/${ok.id}`, { extra_roles: ['bogus'] }, admin);
    assert.equal(res.status, 400);
  } finally { server.close(); }
});

test('POST /api/users stores service_rates as an array with branches defaulted', async () => {
  const { server, base } = await startServer();
  try {
    const admin = await loginAdmin(base);
    const res = await post(base, '/api/users', {
      username: 'rate.doc1', password: 'password2', role: 'doctor',
      service_rates: [
        { service_id: 1, pct: 20, branches: [1] },
        { service_id: 2, pct: 15 },
      ],
    }, admin);
    assert.equal(res.status, 201);
    const u = (await res.json()).user;
    assert.equal(u.service_rates.length, 2);
    assert.deepEqual(u.service_rates[0], { service_id: 1, pct: 20, branches: [1] });
    assert.equal(u.service_rates[1].pct, 15);
    assert.deepEqual(u.service_rates[1].branches, []);
  } finally { server.close(); }
});

test('service_rates pct is clamped to 0-100', async () => {
  const { server, base } = await startServer();
  try {
    const admin = await loginAdmin(base);
    const res = await post(base, '/api/users', {
      username: 'rate.doc2', password: 'password2', role: 'doctor',
      service_rates: [
        { service_id: 1, pct: 150 },
        { service_id: 2, pct: -5 },
      ],
    }, admin);
    assert.equal(res.status, 201);
    const u = (await res.json()).user;
    assert.equal(u.service_rates.find(r => r.service_id === 1).pct, 100);
    assert.equal(u.service_rates.find(r => r.service_id === 2).pct, 0);
  } finally { server.close(); }
});

test('service_rates dedupes by service_id, last wins', async () => {
  const { server, base } = await startServer();
  try {
    const admin = await loginAdmin(base);
    const res = await post(base, '/api/users', {
      username: 'rate.doc3', password: 'password2', role: 'doctor',
      service_rates: [
        { service_id: 1, pct: 10 },
        { service_id: 1, pct: 40 },
      ],
    }, admin);
    assert.equal(res.status, 201);
    const u = (await res.json()).user;
    assert.equal(u.service_rates.length, 1);
    assert.equal(u.service_rates[0].pct, 40);
  } finally { server.close(); }
});

test('service_rates/referral_rates validation: must be array of valid entries', async () => {
  const { server, base } = await startServer();
  try {
    const admin = await loginAdmin(base);

    let res = await post(base, '/api/users', {
      username: 'badrate1', password: 'password2', role: 'doctor', service_rates: 'x',
    }, admin);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.message, 'service_rates must be an array.');

    res = await post(base, '/api/users', {
      username: 'badrate2', password: 'password2', role: 'doctor', service_rates: [{ pct: 10 }],
    }, admin);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.message, 'Invalid rate entry.');

    res = await post(base, '/api/users', {
      username: 'badrate3', password: 'password2', role: 'doctor',
      referral_rates: [{ service_id: 'a', pct: 5 }],
    }, admin);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.message, 'Invalid rate entry.');
  } finally { server.close(); }
});

test('PATCH referral_rates round-trips an array via GET', async () => {
  const { server, base } = await startServer();
  try {
    const admin = await loginAdmin(base);
    let res = await post(base, '/api/users', { username: 'rate.doc4', password: 'password2', role: 'doctor' }, admin);
    const created = (await res.json()).user;
    assert.deepEqual(created.referral_rates, []);

    res = await patch(base, `/api/users/${created.id}`, {
      referral_rates: [{ service_id: 3, pct: 5 }],
    }, admin);
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).user.referral_rates, [{ service_id: 3, pct: 5, branches: [] }]);

    res = await fetch(base + '/api/users', { headers: { Cookie: admin } });
    assert.equal(res.status, 200);
    const list = (await res.json()).users;
    const found = list.find(u => u.id === created.id);
    assert.deepEqual(found.referral_rates, [{ service_id: 3, pct: 5, branches: [] }]);
  } finally { server.close(); }
});

test('PATCH extra_roles with no role in body filters against the EXISTING primary role', async () => {
  const { server, base } = await startServer();
  try {
    const admin = await loginAdmin(base);
    const res = await post(base, '/api/users', {
      username: 'multi.role3', password: 'password2', role: 'registrar',
    }, admin);
    const created = (await res.json()).user;
    assert.equal(created.role, 'registrar');

    let patched = await patch(base, `/api/users/${created.id}`, { extra_roles: ['nurse'] }, admin);
    assert.equal(patched.status, 200);
    let u = (await patched.json()).user;
    assert.deepEqual(u.extra_roles, ['nurse']);

    // extra_roles now includes the user's existing primary ('registrar') ->
    // must be filtered out even though `role` isn't in this PATCH body.
    patched = await patch(base, `/api/users/${created.id}`, { extra_roles: ['registrar'] }, admin);
    assert.equal(patched.status, 200);
    u = (await patched.json()).user;
    assert.deepEqual(u.extra_roles, []);
  } finally { server.close(); }
});

// RATE_LOAD_V2 — the rate entry's key set IS a contract with the editor.
//
// employees.js rebuilds each entry field-by-field when it loads a card, so any
// key the server persists but the editor does not copy across is silently
// dropped on OPEN — and written away for good by the next save. That is exactly
// how a fixed rate could be entered, reported saved, and be gone later: the
// value was in the database the whole time, the editor just stopped carrying it.
//
// If this test fails because a new optional key was added, add it to
// OPTIONAL_RATE_KEYS in public/js/admin/views/employees.js too.
test('rate entries expose exactly the keys the editor knows how to carry', () => {
  const db = openDb(':memory:');
  migrate(db);

  // Every optional key at once, on both lists.
  const svc = parseEmployeeFields({
    service_rates: [{ service_id: 1, pct: 30, price: 75000, fix: 50000, branches: [2] }],
  }, db);
  assert.ok(svc.ok, svc.message);
  assert.deepEqual(
    Object.keys(JSON.parse(svc.fields.service_rates)[0]).sort(),
    ['branches', 'fix', 'pct', 'price', 'service_id'],
  );

  const ref = parseEmployeeFields({
    referral_rates: [{ service_id: 1, pct: 10, fixed: 25000, fix: 5000, branches: [] }],
  }, db);
  assert.ok(ref.ok, ref.message);
  assert.deepEqual(
    Object.keys(JSON.parse(ref.fields.referral_rates)[0]).sort(),
    ['branches', 'fix', 'fixed', 'pct', 'service_id'],
  );

  // The union is what the editor must carry through untouched.
  const CARRIED_BY_EDITOR = ['price', 'fix', 'fixed'];
  const emitted = new Set([
    ...Object.keys(JSON.parse(svc.fields.service_rates)[0]),
    ...Object.keys(JSON.parse(ref.fields.referral_rates)[0]),
  ]);
  for (const k of ['service_id', 'pct', 'branches']) emitted.delete(k);   // always copied
  assert.deepEqual([...emitted].sort(), [...CARRIED_BY_EDITOR].sort(),
    'server persists an optional rate key the editor does not carry — it will be lost on reopen');
});

// DOCTOR_OWN_PRICE_V1 — the contract the employees editor actually speaks.
// The editor sends `percentage` (not `pct`) and an optional `price`; both used
// to be dropped, which is why every saved rate came back as 0% with no price.
test('service_rates round-trip: own price and percentage survive a save', async () => {
  const { db, server, base } = await startServer();
  try {
    const admin = await loginAdmin(base);
    db.prepare("INSERT INTO services (id, name, price) VALUES (11,'Consultation',50000),(12,'X-ray',80000)").run();

    const res = await post(base, '/api/users', {
      username: 'doc1', password: 'password1', role: 'doctor', staff_type: 'doctor', last_name: 'Petrov',
      service_rates: [
        { service_id: 11, price: 75000, percentage: 30, branches: [] },   // own price
        { service_id: 12, percentage: 20, branches: [] },                 // catalog price
      ],
    }, admin);
    assert.equal(res.status, 201);
    const created = (await res.json()).user;

    const byId = Object.fromEntries(created.service_rates.map((r) => [r.service_id, r]));
    assert.equal(byId[11].price, 75000);
    assert.equal(byId[11].pct, 30, 'the editor\'s `percentage` must land as canonical `pct`');
    assert.ok(!('price' in byId[12]), 'a service with no own price must not gain one');
    assert.equal(byId[12].pct, 20);

    // Clearing the field (empty string, as the input sends) removes the override.
    let patched = await patch(base, `/api/users/${created.id}`, {
      service_rates: [{ service_id: 11, price: '', percentage: 30, branches: [] }],
    }, admin);
    assert.equal(patched.status, 200);
    let rates = (await patched.json()).user.service_rates;
    assert.ok(!('price' in rates[0]), 'an emptied price must clear the override, not store 0');

    // A deliberate 0 is a real free-of-charge price and must be kept.
    patched = await patch(base, `/api/users/${created.id}`, {
      service_rates: [{ service_id: 11, price: 0, percentage: 30, branches: [] }],
    }, admin);
    rates = (await patched.json()).user.service_rates;
    assert.equal(rates[0].price, 0);

    // Nonsense is refused outright rather than coerced into a bill.
    const bad = await patch(base, `/api/users/${created.id}`, {
      service_rates: [{ service_id: 11, price: -5 }],
    }, admin);
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error.message, /price/i);
  } finally { server.close(); }
});
