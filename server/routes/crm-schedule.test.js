// CRM_SCHEDULE_V1 — the call centre books a service for a DATE; the registrar
// picks it up on that date and invoices it.
//
// The call centre's job ends at «услуга + дата» — it does not register, price or
// invoice. So the handover is entirely a query: when the registrar opens
// «Добавить услуги к визиту» for patient P on day D, the picker asks for
// crm_requests where patient_id = P AND scheduled_date = D AND status is still
// open. The date match is the load-bearing part: a request booked for Friday
// must not attach itself to a Tuesday walk-in.
//
// These tests pin that query end-to-end against the real server, plus the
// writes on both sides of it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { hashPassword } from '../services/auth.js';
import { createApp } from '../app.js';

function startServer() {
  const db = openDb(':memory:');
  migrate(db);
  // Two actors on purpose: the catalogue is admin-only to write, but every read
  // and every crm_requests write under test is done by the REGISTRAR — the role
  // that actually runs this workflow. Seeding as admin and then acting as the
  // registrar is what proves the registrar can do their half of it.
  db.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)')
    .run('boss', hashPassword('password1'), 'Admin', 'admin');
  db.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)')
    .run('reg', hashPassword('password1'), 'Registrar', 'registrar');
  return new Promise((resolve) => {
    const server = createApp(db).listen(0, '127.0.0.1', () => {
      resolve({ db, server, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

async function login(base, who = 'reg') {
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: who, password: 'password1' }),
  });
  assert.equal(res.status, 200, `login as ${who} failed`);
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

async function db(base, cookie, desc) {
  const res = await fetch(base + '/api/db', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(desc),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

// Exactly the read prefillFromCrm() issues in service-picker-modal.js.
function prefillQuery(patientId, dayIso) {
  return {
    table: 'crm_requests', op: 'select',
    columns: 'id, service_id, scheduled_date, status, note',
    filters: [
      { col: 'patient_id',     op: 'eq', val: patientId },
      { col: 'scheduled_date', op: 'eq', val: dayIso },
      { col: 'status',         op: 'in', val: ['scheduled', 'approved'] },
    ],
    order: [],
  };
}

// The catalogue and the patient exist before the call ever comes in; seeded as
// admin because `services` is admin-write in the registry.
async function seed(base) {
  const admin = await login(base, 'boss');
  const pRes = await db(base, admin, { table: 'patients', op: 'insert', returning: true, single: 'single',
    values: { full_name: 'Test Test', phone: '+998950768008' } });
  assert.equal(pRes.status, 200, 'patient seed: ' + JSON.stringify(pRes.json));
  const sRes = await db(base, admin, { table: 'services', op: 'insert', returning: true, single: 'single',
    values: { name: 'УЗИ почек', price: 120000 } });
  assert.equal(sRes.status, 200, 'service seed: ' + JSON.stringify(sRes.json));
  return { pat: pRes.json.data, svc: sRes.json.data };
}

test('the call centre write: a request carries the service and the date', async (t) => {
  const { db: sqlite, server, base } = await startServer();
  t.after(() => { server.close(); sqlite.close(); });
  const cookie = await login(base);
  const { pat, svc } = await seed(base);

  // What crm.js persist() sends when «Записать на дату» is pressed.
  const res = await db(base, cookie, {
    table: 'crm_requests', op: 'insert', returning: true, single: 'single',
    values: {
      full_name: 'Test Test', phone: '+998950768008', source: 'call',
      patient_id: pat.id, service_id: svc.id,
      scheduled_date: '2026-08-20', status: 'scheduled', note: 'перезвонить утром',
    },
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.data.scheduled_date, '2026-08-20');
  assert.equal(res.json.data.service_id, svc.id);
  assert.equal(res.json.data.status, 'scheduled', 'a dated request is «Записан», not a raw lead');
});

test('on the scheduled date the registrar gets the service', async (t) => {
  const { db: sqlite, server, base } = await startServer();
  t.after(() => { server.close(); sqlite.close(); });
  const cookie = await login(base);
  const { pat, svc } = await seed(base);
  await db(base, cookie, { table: 'crm_requests', op: 'insert', values: {
    full_name: 'Test Test', phone: '+998950768008', source: 'call',
    patient_id: pat.id, service_id: svc.id, scheduled_date: '2026-08-20', status: 'scheduled' } });

  const hit = await db(base, cookie, prefillQuery(pat.id, '2026-08-20'));
  assert.equal(hit.status, 200, JSON.stringify(hit.json));
  assert.equal(hit.json.data.length, 1);
  assert.equal(hit.json.data[0].service_id, svc.id);
});

test('on ANY OTHER date nothing is prefilled — the picker behaves as before', async (t) => {
  const { db: sqlite, server, base } = await startServer();
  t.after(() => { server.close(); sqlite.close(); });
  const cookie = await login(base);
  const { pat, svc } = await seed(base);
  await db(base, cookie, { table: 'crm_requests', op: 'insert', values: {
    full_name: 'Test Test', phone: '+998950768008', source: 'call',
    patient_id: pat.id, service_id: svc.id, scheduled_date: '2026-08-20', status: 'scheduled' } });

  for (const day of ['2026-08-19', '2026-08-21', '2026-09-20']) {
    const miss = await db(base, cookie, prefillQuery(pat.id, day));
    assert.equal(miss.json.data.length, 0, `a request booked for the 20th must not appear on ${day}`);
  }
});

test('another patient on the same date gets nothing', async (t) => {
  const { db: sqlite, server, base } = await startServer();
  t.after(() => { server.close(); sqlite.close(); });
  const cookie = await login(base);
  const { pat, svc } = await seed(base);
  const other = (await db(base, cookie, { table: 'patients', op: 'insert', returning: true, single: 'single',
    values: { full_name: 'Кто-то Другой' } })).json.data;
  await db(base, cookie, { table: 'crm_requests', op: 'insert', values: {
    full_name: 'Test Test', phone: '+998950768008', source: 'call',
    patient_id: pat.id, service_id: svc.id, scheduled_date: '2026-08-20', status: 'scheduled' } });

  const miss = await db(base, cookie, prefillQuery(other.id, '2026-08-20'));
  assert.equal(miss.json.data.length, 0);
});

test('a closed request is not offered again', async (t) => {
  const { db: sqlite, server, base } = await startServer();
  t.after(() => { server.close(); sqlite.close(); });
  const cookie = await login(base);
  const { pat, svc } = await seed(base);
  for (const status of ['came', 'no_show', 'stopped', 'not_qualified']) {
    await db(base, cookie, { table: 'crm_requests', op: 'insert', values: {
      full_name: 'Test Test', phone: '+998950768008', source: 'call',
      patient_id: pat.id, service_id: svc.id, scheduled_date: '2026-08-20', status } });
  }
  const miss = await db(base, cookie, prefillQuery(pat.id, '2026-08-20'));
  assert.equal(miss.json.data.length, 0, 'only scheduled/approved requests are pending');
});

test('attaching the service closes the request, so the no-show sweep cannot claim it', async (t) => {
  const { db: sqlite, server, base } = await startServer();
  t.after(() => { server.close(); sqlite.close(); });
  const cookie = await login(base);
  const { pat, svc } = await seed(base);
  const req = (await db(base, cookie, { table: 'crm_requests', op: 'insert', returning: true, single: 'single',
    values: { full_name: 'Test Test', phone: '+998950768008', source: 'call',
      patient_id: pat.id, service_id: svc.id, scheduled_date: '2026-08-20', status: 'scheduled' } })).json.data;

  // closeCrmRequests() after the cart is attached.
  const upd = await db(base, cookie, { table: 'crm_requests', op: 'update',
    values: { status: 'came' }, filters: [{ col: 'id', op: 'in', val: [req.id] }] });
  assert.equal(upd.status, 200, JSON.stringify(upd.json));

  // The overnight sweep in crm.js: scheduled/approved with a past date -> no_show.
  await db(base, cookie, { table: 'crm_requests', op: 'update', values: { status: 'no_show' },
    filters: [{ col: 'status', op: 'in', val: ['scheduled', 'approved'] },
              { col: 'scheduled_date', op: 'lt', val: '2026-08-25' }] });

  const after = await db(base, cookie, { table: 'crm_requests', op: 'select', columns: 'id, status',
    filters: [{ col: 'id', op: 'eq', val: req.id }], order: [] });
  assert.equal(after.json.data[0].status, 'came',
    'a patient who attended must not be swept into «Не пришёл»');
});

test('a request the patient never came for IS swept — the sweep still works', async (t) => {
  const { db: sqlite, server, base } = await startServer();
  t.after(() => { server.close(); sqlite.close(); });
  const cookie = await login(base);
  const { pat, svc } = await seed(base);
  const req = (await db(base, cookie, { table: 'crm_requests', op: 'insert', returning: true, single: 'single',
    values: { full_name: 'Test Test', phone: '+998950768008', source: 'call',
      patient_id: pat.id, service_id: svc.id, scheduled_date: '2026-08-20', status: 'scheduled' } })).json.data;

  await db(base, cookie, { table: 'crm_requests', op: 'update', values: { status: 'no_show' },
    filters: [{ col: 'status', op: 'in', val: ['scheduled', 'approved'] },
              { col: 'scheduled_date', op: 'lt', val: '2026-08-25' }] });

  const after = await db(base, cookie, { table: 'crm_requests', op: 'select', columns: 'id, status',
    filters: [{ col: 'id', op: 'eq', val: req.id }], order: [] });
  assert.equal(after.json.data[0].status, 'no_show');
});

// CRM_LINK_ON_REGISTER_V1 — the call centre books people who have no card yet.
// A cold call has a name and a phone and nothing else, so crm_requests.patient_id
// is NULL — and the registrar's prefill matches on patient_id. Without linking at
// registration the booking could never reach them: the patient walks in, gets a
// card, and the services booked for that day stay invisible.
test('a request for someone with no card is linked when the card is created', async (t) => {
  const { db: sqlite, server, base } = await startServer();
  t.after(() => { server.close(); sqlite.close(); });
  const cookie = await login(base);
  const admin = await login(base, 'boss');
  const svc = (await db(base, admin, { table: 'services', op: 'insert', returning: true, single: 'single',
    values: { name: 'УЗИ почек', price: 120000 } })).json.data;

  // Call centre: no patient_id — this person is not in the clinic yet.
  const req = (await db(base, cookie, { table: 'crm_requests', op: 'insert', returning: true, single: 'single',
    values: { full_name: 'Новый Пациент', phone: '+998 90 123 45 67', source: 'call',
      service_id: svc.id, scheduled_date: '2026-08-20', status: 'scheduled' } })).json.data;
  assert.equal(req.patient_id, null, 'the lead starts with no card');

  // The registrar registers them — same human, phone typed WITHOUT the country code.
  const pat = (await db(base, cookie, { table: 'patients', op: 'insert', returning: true, single: 'single',
    values: { full_name: 'Новый Пациент', phone: '901234567' } })).json.data;

  // linkCrmRequestsToPatient(): open, unlinked requests whose phone tail matches.
  const open = await db(base, cookie, { table: 'crm_requests', op: 'select', columns: 'id, phone, patient_id, status',
    filters: [{ col: 'patient_id', op: 'is', val: null },
              { col: 'status', op: 'in', val: ['scheduled', 'approved', 'in_process', 'recall'] }], order: [] });
  assert.equal(open.status, 200, JSON.stringify(open.json));
  const digits = (s) => String(s || '').replace(/\D/g, '');
  const tail = (d) => (d.length > 9 ? d.slice(-9) : d);
  const hits = open.json.data.filter(r => tail(digits(r.phone)) === tail(digits('901234567')));
  assert.equal(hits.length, 1, 'the phone must match across formatting');

  const upd = await db(base, cookie, { table: 'crm_requests', op: 'update',
    values: { patient_id: pat.id }, filters: [{ col: 'id', op: 'in', val: hits.map(r => r.id) }] });
  assert.equal(upd.status, 200, JSON.stringify(upd.json));

  // And now the registrar's prefill finds it on the booked day.
  const found = await db(base, cookie, prefillQuery(pat.id, '2026-08-20'));
  assert.equal(found.json.data.length, 1);
  assert.equal(found.json.data[0].service_id, svc.id);
});

test('a CLOSED lead is not reopened by a namesake registering later', async (t) => {
  const { db: sqlite, server, base } = await startServer();
  t.after(() => { server.close(); sqlite.close(); });
  const cookie = await login(base);
  await db(base, cookie, { table: 'crm_requests', op: 'insert', values: {
    full_name: 'Ушедший', phone: '+998901234567', source: 'call',
    scheduled_date: '2026-01-01', status: 'not_qualified' } });

  const open = await db(base, cookie, { table: 'crm_requests', op: 'select', columns: 'id',
    filters: [{ col: 'patient_id', op: 'is', val: null },
              { col: 'status', op: 'in', val: ['scheduled', 'approved', 'in_process', 'recall'] }], order: [] });
  assert.equal(open.json.data.length, 0, 'closed leads are history, not pending work');
});

test('a request already tied to a card is left alone', async (t) => {
  const { db: sqlite, server, base } = await startServer();
  t.after(() => { server.close(); sqlite.close(); });
  const cookie = await login(base);
  const { pat } = await seed(base);
  await db(base, cookie, { table: 'crm_requests', op: 'insert', values: {
    full_name: 'Test Test', phone: '+998950768008', source: 'call',
    patient_id: pat.id, scheduled_date: '2026-08-20', status: 'scheduled' } });

  const unlinked = await db(base, cookie, { table: 'crm_requests', op: 'select', columns: 'id',
    filters: [{ col: 'patient_id', op: 'is', val: null }], order: [] });
  assert.equal(unlinked.json.data.length, 0, 'the linking pass must not touch it');
});

test('a request with a date but no service is not prefilled', async (t) => {
  const { db: sqlite, server, base } = await startServer();
  t.after(() => { server.close(); sqlite.close(); });
  const cookie = await login(base);
  const { pat } = await seed(base);
  await db(base, cookie, { table: 'crm_requests', op: 'insert', values: {
    full_name: 'Test Test', phone: '+998950768008', source: 'call',
    patient_id: pat.id, scheduled_date: '2026-08-20', status: 'scheduled' } });

  const hit = await db(base, cookie, prefillQuery(pat.id, '2026-08-20'));
  // The row comes back, but the client skips rows with no service_id — assert
  // the shape the client relies on to make that decision.
  assert.equal(hit.json.data.length, 1);
  assert.equal(hit.json.data[0].service_id, null);
});
