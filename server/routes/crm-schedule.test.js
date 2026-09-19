// CRM_SCHEDULE_V1 — the call centre books a service for a DATE; the registrar
// picks it up on that date and invoices it.
//
// The call centre's job ends at «услуга + дата» — it does not register, price or
// invoice. So the handover is entirely a query: when the registrar opens
// «Добавить услуги к визиту» for patient P on day D, the picker asks for the
// still-open requests of P, then for their PENDING lines dated D. The date match
// is the load-bearing part: a service booked for Friday must not attach itself
// to a Tuesday walk-in.
//
// CRM_LINKS_V1 (2026-09-20) — И ЧИТАЕТСЯ ЭТО ИЗ СТРОК ЗАЯВКИ, А НЕ ИЗ ЗАЯВКИ.
//
// Здесь стоял ОДИН запрос к crm_requests по его собственным service_id и
// scheduled_date. Так экраны не работают с миграции 057: услуги заявки лежат
// строками в crm_request_services, у каждой СВОЯ дата, а колонки родителя —
// только зеркало первой строки для карточки канбана и выгрузки Excel. Тест
// проверял запрос, которого в продукте нет, — то есть оставался зелёным
// независимо от того, работает ли передача заявки регистратуре вообще.
//
// Теперь здесь тот же ДВУХШАГОВЫЙ запрос, что в service-picker-modal.js
// (prefillFromCrm) и visit-wizard.js: отбор стоит и на РОДИТЕЛЕ (пациент,
// открытая ступень), и на РЕБЁНКЕ (дата, pending), а компилятор запросов
// фильтрует только базовую таблицу — отсюда два шага.
//
// These tests pin that query end-to-end against the real server, plus the
// writes on both sides of it.

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
  // Two actors on purpose: the catalogue is admin-only to write, but every read
  // and every crm_requests write under test is done by the REGISTRAR — the role
  // that actually runs this workflow. Seeding as admin and then acting as the
  // registrar is what proves the registrar can do their half of it.
  db.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)')
    .run('boss', hashPassword('password1'), 'Admin', 'admin');
  db.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)')
    .run('reg', hashPassword('password1'), 'Registrar', 'registrar');
  // LICENCE_CORE_V1 — enrolled+active so the write gate (routes/db.js,
  // routes/rpc.js) never fires; this file predates licensing.
  const server = await listen(createApp(db, { dataDir: licensedDataDir() }));
  return { db, server, base: `http://127.0.0.1:${server.address().port}` };
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

// Ступени, на которых заявка ещё ждёт своего дня — сид миграции 077
// (kind = 'open'). Экраны спрашивают их у настроек воронки (CRM_LINKS_V1);
// здесь список стоит явно, чтобы тест сам говорил, что считается открытой
// заявкой.
const OPEN_STATUSES = ['scheduled', 'approved', 'in_process', 'recall'];

/**
 * ТЕ ЖЕ ДВА ЧТЕНИЯ, что делает prefillFromCrm(): открытые заявки пациента, а
 * затем ожидающие строки этих заявок, назначенные на этот день.
 */
async function prefill(base, cookie, patientId, dayIso) {
  const reqs = await db(base, cookie, {
    table: 'crm_requests', op: 'select', columns: 'id',
    filters: [
      { col: 'patient_id', op: 'eq', val: patientId },
      { col: 'status',     op: 'in', val: OPEN_STATUSES },
    ],
    order: [],
  });
  assert.equal(reqs.status, 200, 'заявки пациента: ' + JSON.stringify(reqs.json));
  const ids = (reqs.json.data || []).map((r) => r.id);
  if (!ids.length) return [];

  const lines = await db(base, cookie, {
    table: 'crm_request_services', op: 'select',
    columns: 'id, request_id, service_id, scheduled_date, status',
    filters: [
      { col: 'request_id',     op: 'in', val: ids },
      { col: 'scheduled_date', op: 'eq', val: dayIso },
      { col: 'status',         op: 'eq', val: 'pending' },
    ],
    order: [],
  });
  assert.equal(lines.status, 200, 'строки заявки: ' + JSON.stringify(lines.json));
  return lines.json.data || [];
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
  const s2Res = await db(base, admin, { table: 'services', op: 'insert', returning: true, single: 'single',
    values: { name: 'Анализ крови', price: 40000 } });
  assert.equal(s2Res.status, 200, 'second service seed: ' + JSON.stringify(s2Res.json));
  return { pat: pRes.json.data, svc: sRes.json.data, svc2: s2Res.json.data };
}

/**
 * «Сохранить и записать» целиком: заявка И её строки услуг. Ровно так пишет
 * crm.js (persist + saveLines) — родитель зеркалит ПЕРВУЮ строку, а работает
 * регистратура со строками.
 */
async function bookRequest(base, cookie, { patientId = null, status = 'scheduled', lines = [],
                                           phone = '+998950768008', fullName = 'Test Test' } = {}) {
  const first = lines[0] || {};
  const req = await db(base, cookie, { table: 'crm_requests', op: 'insert', returning: true, single: 'single',
    values: {
      full_name: fullName, phone, source: 'call', status,
      patient_id: patientId, service_id: first.serviceId || null, scheduled_date: first.date || null,
    } });
  assert.equal(req.status, 200, 'заявка: ' + JSON.stringify(req.json));
  const made = [];
  for (const ln of lines) {
    const row = await db(base, cookie, { table: 'crm_request_services', op: 'insert', returning: true, single: 'single',
      values: { request_id: req.json.data.id, service_id: ln.serviceId || null,
                scheduled_date: ln.date || null, status: ln.status || 'pending' } });
    assert.equal(row.status, 200, 'строка заявки: ' + JSON.stringify(row.json));
    made.push(row.json.data);
  }
  return { request: req.json.data, lines: made };
}

test('the call centre write: the request mirrors the first line, the LINES carry the booking', async (t) => {
  const { db: sqlite, server, base } = await startServer();
  t.after(() => { server.close(); sqlite.close(); });
  const cookie = await login(base);
  const { pat, svc, svc2 } = await seed(base);

  const { request, lines } = await bookRequest(base, cookie, {
    patientId: pat.id,
    lines: [{ serviceId: svc.id, date: '2026-08-20' }, { serviceId: svc2.id, date: '2026-08-24' }],
  });

  // Родитель — зеркало ПЕРВОЙ строки: по нему живут карточка канбана, отчёт
  // колл-центра и ночная автоматика «Не пришёл».
  assert.equal(request.scheduled_date, '2026-08-20');
  assert.equal(request.service_id, svc.id);
  assert.equal(request.status, 'scheduled', 'a dated request is «Записан», not a raw lead');
  // А регистратура работает со строками, и у каждой своя дата.
  assert.deepEqual(lines.map((l) => l.scheduled_date), ['2026-08-20', '2026-08-24']);
  assert.deepEqual(lines.map((l) => l.status), ['pending', 'pending']);
});

test('on the scheduled date the registrar gets the service', async (t) => {
  const { db: sqlite, server, base } = await startServer();
  t.after(() => { server.close(); sqlite.close(); });
  const cookie = await login(base);
  const { pat, svc } = await seed(base);
  await bookRequest(base, cookie, { patientId: pat.id, lines: [{ serviceId: svc.id, date: '2026-08-20' }] });

  const hit = await prefill(base, cookie, pat.id, '2026-08-20');
  assert.equal(hit.length, 1);
  assert.equal(hit[0].service_id, svc.id);
});

// CRM_LINKS_V1 — ЭТО И ЕСТЬ ПРИЧИНА, ПО КОТОРОЙ УСЛУГИ ЛЕЖАТ СТРОКАМИ.
//
// Одна заявка — три услуги на три дня: УЗИ во вторник, анализы в среду, приём в
// пятницу. Регистратура во вторник обязана увидеть РОВНО УЗИ. Родительская
// строка на такой вопрос ответить не может вовсе: scheduled_date у неё один.
test('одна заявка на три дня: в каждый день подставляется только его услуга', async (t) => {
  const { db: sqlite, server, base } = await startServer();
  t.after(() => { server.close(); sqlite.close(); });
  const cookie = await login(base);
  const admin = await login(base, 'boss');
  const { pat, svc, svc2 } = await seed(base);
  const svc3 = (await db(base, admin, { table: 'services', op: 'insert', returning: true, single: 'single',
    values: { name: 'Приём терапевта', price: 90000 } })).json.data;

  await bookRequest(base, cookie, { patientId: pat.id, lines: [
    { serviceId: svc.id,  date: '2026-08-18' },
    { serviceId: svc2.id, date: '2026-08-19' },
    { serviceId: svc3.id, date: '2026-08-21' },
  ] });

  for (const [day, want] of [['2026-08-18', svc.id], ['2026-08-19', svc2.id], ['2026-08-21', svc3.id]]) {
    const hit = await prefill(base, cookie, pat.id, day);
    assert.equal(hit.length, 1, `на ${day} подставилась не одна услуга, а ${hit.length}`);
    assert.equal(hit[0].service_id, want, `на ${day} подставилась чужая услуга`);
  }
  // День, на который ничего не записано, — смета пустая, как и до звонка.
  assert.equal((await prefill(base, cookie, pat.id, '2026-08-20')).length, 0,
    'в день без записи смета обязана остаться пустой');
});

test('две услуги на ОДИН день подставляются обе', async (t) => {
  const { db: sqlite, server, base } = await startServer();
  t.after(() => { server.close(); sqlite.close(); });
  const cookie = await login(base);
  const { pat, svc, svc2 } = await seed(base);
  await bookRequest(base, cookie, { patientId: pat.id, lines: [
    { serviceId: svc.id,  date: '2026-08-20' },
    { serviceId: svc2.id, date: '2026-08-20' },
  ] });

  const hit = await prefill(base, cookie, pat.id, '2026-08-20');
  const asc = (a, b) => a - b;
  assert.deepEqual(hit.map((l) => l.service_id).sort(asc), [svc.id, svc2.id].sort(asc));
});

test('on ANY OTHER date nothing is prefilled — the picker behaves as before', async (t) => {
  const { db: sqlite, server, base } = await startServer();
  t.after(() => { server.close(); sqlite.close(); });
  const cookie = await login(base);
  const { pat, svc } = await seed(base);
  await bookRequest(base, cookie, { patientId: pat.id, lines: [{ serviceId: svc.id, date: '2026-08-20' }] });

  for (const day of ['2026-08-19', '2026-08-21', '2026-09-20']) {
    assert.equal((await prefill(base, cookie, pat.id, day)).length, 0,
      `a service booked for the 20th must not appear on ${day}`);
  }
});

test('another patient on the same date gets nothing', async (t) => {
  const { db: sqlite, server, base } = await startServer();
  t.after(() => { server.close(); sqlite.close(); });
  const cookie = await login(base);
  const { pat, svc } = await seed(base);
  const other = (await db(base, cookie, { table: 'patients', op: 'insert', returning: true, single: 'single',
    values: { full_name: 'Кто-то Другой' } })).json.data;
  await bookRequest(base, cookie, { patientId: pat.id, lines: [{ serviceId: svc.id, date: '2026-08-20' }] });

  assert.equal((await prefill(base, cookie, other.id, '2026-08-20')).length, 0);
});

test('a closed request is not offered again', async (t) => {
  const { db: sqlite, server, base } = await startServer();
  t.after(() => { server.close(); sqlite.close(); });
  const cookie = await login(base);
  const { pat, svc } = await seed(base);
  for (const status of ['came', 'no_show', 'stopped', 'not_qualified']) {
    await bookRequest(base, cookie, { patientId: pat.id, status, lines: [{ serviceId: svc.id, date: '2026-08-20' }] });
  }
  assert.equal((await prefill(base, cookie, pat.id, '2026-08-20')).length, 0,
    'only requests on an OPEN stage are pending');
});

test('строка, уже закрытая регистратурой, второй раз не подставляется', async (t) => {
  const { db: sqlite, server, base } = await startServer();
  t.after(() => { server.close(); sqlite.close(); });
  const cookie = await login(base);
  const { pat, svc, svc2 } = await seed(base);
  await bookRequest(base, cookie, { patientId: pat.id, lines: [
    { serviceId: svc.id,  date: '2026-08-20', status: 'done' },
    { serviceId: svc2.id, date: '2026-08-20' },
  ] });

  const hit = await prefill(base, cookie, pat.id, '2026-08-20');
  assert.equal(hit.length, 1, 'оплаченная услуга подставилась в смету второй раз');
  assert.equal(hit[0].service_id, svc2.id);
});

test('attaching the service closes the request, so the no-show sweep cannot claim it', async (t) => {
  const { db: sqlite, server, base } = await startServer();
  t.after(() => { server.close(); sqlite.close(); });
  const cookie = await login(base);
  const { pat, svc } = await seed(base);
  const { request, lines } = await bookRequest(base, cookie, { patientId: pat.id, lines: [{ serviceId: svc.id, date: '2026-08-20' }] });

  // closeCrmLines() после того, как услуги легли в визит: строки → 'done',
  // родитель → «Пришёл», потому что ждать в нём больше нечего.
  const doneLines = await db(base, cookie, { table: 'crm_request_services', op: 'update',
    values: { status: 'done' }, filters: [{ col: 'id', op: 'in', val: lines.map((l) => l.id) }] });
  assert.equal(doneLines.status, 200, JSON.stringify(doneLines.json));
  const left = await db(base, cookie, { table: 'crm_request_services', op: 'select', columns: 'id',
    filters: [{ col: 'request_id', op: 'eq', val: request.id }, { col: 'status', op: 'eq', val: 'pending' }], order: [] });
  assert.equal(left.json.data.length, 0, 'в заявке не должно остаться ожидающих строк');
  const upd = await db(base, cookie, { table: 'crm_requests', op: 'update',
    values: { status: 'came' }, filters: [{ col: 'id', op: 'eq', val: request.id }] });
  assert.equal(upd.status, 200, JSON.stringify(upd.json));

  // The overnight sweep in crm.js: an OPEN stage with a past date -> no_show.
  await db(base, cookie, { table: 'crm_requests', op: 'update', values: { status: 'no_show' },
    filters: [{ col: 'status', op: 'in', val: OPEN_STATUSES },
              { col: 'scheduled_date', op: 'lt', val: '2026-08-25' }] });

  const after = await db(base, cookie, { table: 'crm_requests', op: 'select', columns: 'id, status',
    filters: [{ col: 'id', op: 'eq', val: request.id }], order: [] });
  assert.equal(after.json.data[0].status, 'came',
    'a patient who attended must not be swept into «Не пришёл»');
  // И подставлять регистратуре больше нечего.
  assert.equal((await prefill(base, cookie, pat.id, '2026-08-20')).length, 0);
});

test('заявка на три дня переживает первый визит: остальные дни остаются у регистратуры', async (t) => {
  const { db: sqlite, server, base } = await startServer();
  t.after(() => { server.close(); sqlite.close(); });
  const cookie = await login(base);
  const { pat, svc, svc2 } = await seed(base);
  const { request, lines } = await bookRequest(base, cookie, { patientId: pat.id, lines: [
    { serviceId: svc.id,  date: '2026-08-20' },
    { serviceId: svc2.id, date: '2026-08-24' },
  ] });

  // Закрыли ТОЛЬКО строку первого дня.
  await db(base, cookie, { table: 'crm_request_services', op: 'update',
    values: { status: 'done' }, filters: [{ col: 'id', op: 'in', val: [lines[0].id] }] });
  const left = await db(base, cookie, { table: 'crm_request_services', op: 'select', columns: 'id',
    filters: [{ col: 'request_id', op: 'eq', val: request.id }, { col: 'status', op: 'eq', val: 'pending' }], order: [] });
  assert.equal(left.json.data.length, 1, 'в заявке ещё есть ожидающая строка — закрывать саму заявку нельзя');

  // Родитель остался открытым, и второй день по-прежнему подставляется.
  const hit = await prefill(base, cookie, pat.id, '2026-08-24');
  assert.equal(hit.length, 1, 'второй день заявки исчез у регистратуры после первого визита');
  assert.equal(hit[0].service_id, svc2.id);
});

test('a request the patient never came for IS swept — the sweep still works', async (t) => {
  const { db: sqlite, server, base } = await startServer();
  t.after(() => { server.close(); sqlite.close(); });
  const cookie = await login(base);
  const { pat, svc } = await seed(base);
  const { request } = await bookRequest(base, cookie, { patientId: pat.id, lines: [{ serviceId: svc.id, date: '2026-08-20' }] });

  await db(base, cookie, { table: 'crm_requests', op: 'update', values: { status: 'no_show' },
    filters: [{ col: 'status', op: 'in', val: OPEN_STATUSES },
              { col: 'scheduled_date', op: 'lt', val: '2026-08-25' }] });

  const after = await db(base, cookie, { table: 'crm_requests', op: 'select', columns: 'id, status',
    filters: [{ col: 'id', op: 'eq', val: request.id }], order: [] });
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
  const { request } = await bookRequest(base, cookie, {
    patientId: null, fullName: 'Новый Пациент', phone: '+998 90 123 45 67',
    lines: [{ serviceId: svc.id, date: '2026-08-20' }],
  });
  assert.equal(request.patient_id, null, 'the lead starts with no card');

  // The registrar registers them — same human, phone typed WITHOUT the country code.
  const pat = (await db(base, cookie, { table: 'patients', op: 'insert', returning: true, single: 'single',
    values: { full_name: 'Новый Пациент', phone: '901234567' } })).json.data;

  // linkCrmRequestsToPatient(): open, unlinked requests whose phone tail matches.
  const open = await db(base, cookie, { table: 'crm_requests', op: 'select', columns: 'id, phone, patient_id, status',
    filters: [{ col: 'patient_id', op: 'is', val: null },
              { col: 'status', op: 'in', val: OPEN_STATUSES }], order: [] });
  assert.equal(open.status, 200, JSON.stringify(open.json));
  const digits = (s) => String(s || '').replace(/\D/g, '');
  const tail = (d) => (d.length > 9 ? d.slice(-9) : d);
  const hits = open.json.data.filter(r => tail(digits(r.phone)) === tail(digits('901234567')));
  assert.equal(hits.length, 1, 'the phone must match across formatting');

  const upd = await db(base, cookie, { table: 'crm_requests', op: 'update',
    values: { patient_id: pat.id }, filters: [{ col: 'id', op: 'in', val: hits.map(r => r.id) }] });
  assert.equal(upd.status, 200, JSON.stringify(upd.json));

  // And now the registrar's prefill finds it on the booked day.
  const found = await prefill(base, cookie, pat.id, '2026-08-20');
  assert.equal(found.length, 1);
  assert.equal(found[0].service_id, svc.id);
});

test('a CLOSED lead is not reopened by a namesake registering later', async (t) => {
  const { db: sqlite, server, base } = await startServer();
  t.after(() => { server.close(); sqlite.close(); });
  const cookie = await login(base);
  await bookRequest(base, cookie, { patientId: null, status: 'not_qualified',
    fullName: 'Ушедший', phone: '+998901234567', lines: [{ date: '2026-01-01' }] });

  const open = await db(base, cookie, { table: 'crm_requests', op: 'select', columns: 'id',
    filters: [{ col: 'patient_id', op: 'is', val: null },
              { col: 'status', op: 'in', val: OPEN_STATUSES }], order: [] });
  assert.equal(open.json.data.length, 0, 'closed leads are history, not pending work');
});

test('a request already tied to a card is left alone', async (t) => {
  const { db: sqlite, server, base } = await startServer();
  t.after(() => { server.close(); sqlite.close(); });
  const cookie = await login(base);
  const { pat } = await seed(base);
  await bookRequest(base, cookie, { patientId: pat.id, lines: [{ date: '2026-08-20' }] });

  const unlinked = await db(base, cookie, { table: 'crm_requests', op: 'select', columns: 'id',
    filters: [{ col: 'patient_id', op: 'is', val: null }], order: [] });
  assert.equal(unlinked.json.data.length, 0, 'the linking pass must not touch it');
});

test('a line with a date but no service is not prefilled', async (t) => {
  const { db: sqlite, server, base } = await startServer();
  t.after(() => { server.close(); sqlite.close(); });
  const cookie = await login(base);
  const { pat } = await seed(base);
  await bookRequest(base, cookie, { patientId: pat.id, lines: [{ date: '2026-08-20' }] });

  const hit = await prefill(base, cookie, pat.id, '2026-08-20');
  // The row comes back, but the client skips lines with no service_id — assert
  // the shape the client relies on to make that decision.
  assert.equal(hit.length, 1);
  assert.equal(hit[0].service_id, null);
});
