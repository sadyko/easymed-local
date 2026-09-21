// CRM_REAL_BOOKING_V1 — РАБОТА НАД ПАЦИЕНТОМ ЗАКРЫВАЕТ ЗАЯВКУ КОЛЛ-ЦЕНТРА.
//
// Владелец (2026-09-21): «Пришёл» значит, что пациент ФИЗИЧЕСКИ пришёл. Кнопку
// «Пришёл» при этом в клинике не нажимает никто: на боевой базе ВСЕ 390 визитов
// стоят в 'scheduled' и ни один в 'arrived', при этом 389 счетов оплачены
// (разбор — в шапке server/services/custdev/sync.js). Значит доказательством
// прихода обязаны быть и деньги, и работа над пациентом.
//
// Проверка бьёт по НАСТОЯЩЕЙ двери /api/db, а не по функции: статус услуги
// двигают ЧЕТЫРЕ экрана (кабинет врача, лаборатория, процедуры, счёт визита), и
// двигают они его именно отсюда — колонка открыта на правку в реестре. Правило,
// поставленное в одном экране, соблюдалось бы тремя из четырёх. Тот же довод,
// по которому здесь же стоит запрет хирургии без койки (surgery-needs-bed).
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { hashPassword } from '../services/auth.js';
import { createApp } from '../app.js';
import { licensedDataDir } from '../services/control/licensed-fixture.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';

async function startServer() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare('INSERT INTO users (id, username, password_hash, full_name, role) VALUES (1,?,?,?,?)')
    .run('doc', hashPassword('password1'), 'Врач', 'doctor');
  db.prepare("INSERT INTO services (id, name, price, type) VALUES (30,'Консультация',100000,'consultation')").run();
  db.prepare("INSERT INTO patients (id, full_name) VALUES (77,'Пациент Тест')").run();
  db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (500,77,'2026-08-09T09:00:00Z','scheduled')").run();
  db.prepare("INSERT INTO visit_services (id, visit_id, service_id, status) VALUES (900,500,30,'queued')").run();
  const rid = db.prepare(
    "INSERT INTO crm_requests (full_name, phone, status, patient_id, scheduled_date) VALUES ('Лид','998900000000','scheduled',77,'2026-08-09')",
  ).run().lastInsertRowid;
  const lid = db.prepare(
    "INSERT INTO crm_request_services (request_id, service_id, scheduled_date, status, visit_id) VALUES (?,30,'2026-08-09','pending',500)",
  ).run(rid).lastInsertRowid;
  const server = await listen(createApp(db, { dataDir: licensedDataDir() }));
  return { db, server, base: `http://127.0.0.1:${server.address().port}`, rid, lid };
}

async function login(base) {
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'doc', password: 'password1' }),
  });
  assert.equal(res.status, 200, 'вход врача не прошёл');
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

const setStatus = (base, cookie, status, id = 900) => fetch(base + '/api/db', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
  body: JSON.stringify({
    table: 'visit_services', op: 'update',
    values: { status },
    filters: [{ col: 'id', op: 'eq', val: id }],
  }),
});

const req = (db, id) => db.prepare('SELECT status, scheduled_date FROM crm_requests WHERE id=?').get(id);
const line = (db, id) => db.prepare('SELECT status, visit_id FROM crm_request_services WHERE id=?').get(id);

test('врач начал приём — заявка колл-центра закрывается, статус визита не трогается', async () => {
  const { db, server, base, rid, lid } = await startServer();
  try {
    const cookie = await login(base);
    const res = await setStatus(base, cookie, 'in_progress');
    assert.equal(res.status, 200, 'правка статуса услуги не прошла: ' + await res.text());

    assert.equal(line(db, lid).status, 'done',
      'врач начал приём, а строка заявки так и ждёт — в смете её предложат ещё раз');
    assert.equal(req(db, rid).status, 'came',
      'приём идёт, а заявка висит в «Записан»: ночная автоматика унесёт её в «Не пришёл»');
    // ДОКАЗАТЕЛЬСТВО НЕ ПЕРЕПИСЫВАЕТ САМ ВИЗИТ. visits.status — это то, что
    // поставил человек, и то, что уедет филиалам; хук его только читает.
    assert.equal(db.prepare('SELECT status FROM visits WHERE id=500').get().status, 'scheduled',
      'доказательство прихода переписало статус визита');
  } finally { server.close(); db.close(); }
});

test('внесение услуги в смету заявку не закрывает', async () => {
  const { db, server, base, rid, lid } = await startServer();
  try {
    const cookie = await login(base);
    // 'added' — это «внесли в смету», и происходит оно заочно: регистратура
    // собирает список услуг, пока пациент едет.
    const res = await setStatus(base, cookie, 'added');
    assert.equal(res.status, 200, await res.text());

    assert.equal(line(db, lid).status, 'pending', 'смета выдана за приход');
    assert.equal(req(db, rid).status, 'scheduled');
  } finally { server.close(); db.close(); }
});

test('повторная правка статуса уже закрытую заявку не переписывает', async () => {
  const { db, server, base, rid } = await startServer();
  try {
    const cookie = await login(base);
    await setStatus(base, cookie, 'in_progress');
    const after = req(db, rid);
    const stamp = db.prepare('SELECT updated_at FROM crm_requests WHERE id=?').get(rid).updated_at;

    const res = await setStatus(base, cookie, 'completed');
    assert.equal(res.status, 200, await res.text());

    assert.deepEqual(req(db, rid), after, 'второе доказательство переписало уже закрытую заявку');
    assert.equal(db.prepare('SELECT updated_at FROM crm_requests WHERE id=?').get(rid).updated_at, stamp);
  } finally { server.close(); db.close(); }
});

// Услуга чужого визита не доказывает ничего про этого пациента — правило
// ходит по visit_id строки, а не по «что-то поменялось в базе».
test('работа по чужому визиту заявку не трогает', async () => {
  const { db, server, base, rid, lid } = await startServer();
  try {
    db.prepare("INSERT INTO patients (id, full_name) VALUES (78,'Другой')").run();
    db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (501,78,'2026-08-09T10:00:00Z','scheduled')").run();
    db.prepare("INSERT INTO visit_services (id, visit_id, service_id, status) VALUES (901,501,30,'queued')").run();
    const cookie = await login(base);

    const res = await setStatus(base, cookie, 'completed', 901);
    assert.equal(res.status, 200, await res.text());

    assert.equal(line(db, lid).status, 'pending', 'закрылась строка заявки чужого пациента');
    assert.equal(req(db, rid).status, 'scheduled');
  } finally { server.close(); db.close(); }
});

// M1 (разбор ревью): правило ловило только ПРАВКУ статуса. Строку услуги
// заводят и сразу в рабочем статусе — кабинет врача добавляет услугу «с
// ходу» уже начатой, — и такая вставка проходила мимо доказательства.
test('услуга, заведённая сразу выполненной, тоже закрывает заявку', async () => {
  const { db, server, base, rid, lid } = await startServer();
  try {
    const cookie = await login(base);
    const res = await fetch(base + '/api/db', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        table: 'visit_services', op: 'insert',
        values: { visit_id: 500, service_id: 30, quantity: 1, unit_price: 0, total: 0, status: 'completed' },
      }),
    });
    assert.equal(res.status, 200, await res.text());

    assert.equal(line(db, lid).status, 'done', 'услуга заведена выполненной, а строка заявки так и ждёт');
    assert.equal(req(db, rid).status, 'came');
  } finally { server.close(); db.close(); }
});

test('услуга, заведённая в смету, заявку не трогает', async () => {
  const { db, server, base, rid, lid } = await startServer();
  try {
    const cookie = await login(base);
    const res = await fetch(base + '/api/db', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        table: 'visit_services', op: 'insert',
        values: { visit_id: 500, service_id: 30, quantity: 1, unit_price: 0, total: 0, status: 'added' },
      }),
    });
    assert.equal(res.status, 200, await res.text());

    assert.equal(line(db, lid).status, 'pending');
    assert.equal(req(db, rid).status, 'scheduled');
  } finally { server.close(); db.close(); }
});
