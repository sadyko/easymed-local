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
import { licensedDataDir } from '../services/control/licensed-fixture.js';   // LICENCE_CORE_V1
import { listen } from '../../control-plane/server/test-helpers/listen.js';

async function startServer() {
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
  // LICENCE_CORE_V1 — enrolled+active so the write gate (routes/db.js,
  // routes/rpc.js) never fires; this file predates licensing.
  const server = await listen(createApp(db, { dataDir: licensedDataDir() }));
  return { db, server, base: `http://127.0.0.1:${server.address().port}` };
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

// Scope. CRM_REAL_BOOKING_V1 (2026-09-21) MOVED THIS LINE, deliberately.
//
// Прежде здесь стояло «оператор не заводит визит»: CRM_SCHEDULE_V1 обещал, что
// он «не берёт деньги и не оформляет визит», и «Сохранить и записать» писало
// только услугу и дату. Владелец (2026-09-21) решил иначе: запись колл-центра —
// это НАСТОЯЩИЙ слот в календаре, иначе время у врача не держит никто, и в день
// приёма о записи узнаёт только смета. Значит оператор обязан уметь спросить
// свободное время и занять его — той же дверью, что регистратура
// (ensure_visit + calendar_slots/calendar_book).
//
// Граница роли осталась там же, где была, и проходит по ДЕНЬГАМ и КАРТОЧКЕ
// визита: оформляет приём, берёт оплату и правит визит по-прежнему
// регистратура — visits.update в реестре так и открыт admin/registrar/doctor.
test('a callcenter user books a real slot: the visit is theirs to open', async (t) => {
  const { db, server, base } = await startServer();
  t.after(() => { server.close(); db.close(); });
  const cookie = await login(base, 'operator');
  const pat = await dbCall(base, cookie, {
    table: 'patients', op: 'insert', returning: true, single: 'single',
    values: { full_name: 'Пациент Тест', phone: '+998950768008' },
  });
  const doctorId = db.prepare("SELECT id FROM users WHERE username = 'cardio'").get().id;

  // Сначала «что свободно» — без этого оператору нечего назвать пациенту.
  const slots = await rpc(base, cookie, 'calendar_slots', { doctor_id: doctorId, date: '2026-08-20' });
  assert.equal(slots.status, 200, 'callcenter must see free slots: ' + JSON.stringify(slots.json));
  assert.ok(slots.json.data.slots.length, 'у врача нет ни одного свободного начала');
  const start = slots.json.data.slots[0].start_iso;

  // И запись — одним вызовом, тем же, что у мастера визита.
  const res = await rpc(base, cookie, 'ensure_visit', {
    patient_id: pat.json.data.id, date: '2026-08-20',
    book: { doctor_id: doctorId, start },
  });

  assert.equal(res.status, 200, 'callcenter must create the visit it booked: ' + JSON.stringify(res.json));
  assert.equal(res.json.data.booked, true, 'визит заведён, но слот не занят — время у врача не держит никто');
  const visit = db.prepare('SELECT doctor_id, status FROM visits WHERE id = ?').get(res.json.data.visit.id);
  assert.equal(visit.doctor_id, doctorId);
  assert.equal(visit.status, 'scheduled', '«Пришёл» ставит приход, а не запись');
});

// Граница роли: оформление визита деньгами и карточкой осталось у регистратуры.
test('a callcenter user still cannot edit the visit card', async (t) => {
  const { db, server, base } = await startServer();
  t.after(() => { server.close(); db.close(); });
  const cookie = await login(base, 'operator');
  const pat = await dbCall(base, cookie, {
    table: 'patients', op: 'insert', returning: true, single: 'single',
    values: { full_name: 'Пациент Тест', phone: '+998950768009' },
  });
  const made = await rpc(base, cookie, 'ensure_visit', { patient_id: pat.json.data.id, date: '2026-08-21' });
  assert.equal(made.status, 200, JSON.stringify(made.json));

  const res = await dbCall(base, cookie, {
    table: 'visits', op: 'update', values: { notes: 'правка оператора' },
    filters: [{ col: 'id', op: 'eq', val: made.json.data.visit.id }],
  });

  assert.equal(res.status, 403, 'карточка визита осталась за регистратурой: ' + JSON.stringify(res.json));
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
