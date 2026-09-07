// SURGERY_NEEDS_BED_V1 — операция оформляется ТОЛЬКО на лежащего пациента.
//
// Владелец: «the surgery is bundled so it goes with the hospitalization —
// which means only in bed located patients service bill created».
//
// Проверка бьёт по НАСТОЯЩЕЙ двери /api/db, а не по экрану: строку
// visit_services заводят четыре разных места (кабинет врача, счёт визита и
// окно визита в двух ветках). Правило, поставленное в одном из них,
// соблюдалось бы тремя экранами из четырёх — а цена ошибки тут денежная.
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
    .run('boss', hashPassword('password1'), 'Администратор', 'admin');
  db.prepare("INSERT INTO services (id, name, price, type) VALUES (10,'Аппендэктомия',3000000,'other')").run();
  db.prepare("INSERT INTO services (id, name, price, type) VALUES (11,'Перевязка',50000,'procedure')").run();
  db.prepare("INSERT INTO patients (id, full_name) VALUES (77,'Пациент Тест')").run();
  db.prepare("INSERT INTO visits (id, patient_id, visit_date) VALUES (500,77,'2026-09-07T09:00:00Z')").run();
  const server = await listen(createApp(db, { dataDir: licensedDataDir() }));
  return { db, server, base: `http://127.0.0.1:${server.address().port}` };
}

async function login(base) {
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'boss', password: 'password1' }),
  });
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

const addService = (base, cookie, serviceId) => fetch(base + '/api/db', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
  body: JSON.stringify({
    table: 'visit_services', op: 'insert',
    values: { visit_id: 500, service_id: serviceId, quantity: 1, unit_price: 1, total: 1, status: 'added' },
  }),
});

const admit = (db, status) => db.prepare(
  `INSERT INTO admissions (patient_id, status, admitted_at) VALUES (77, ?, '2026-09-07T08:00:00Z')`).run(status);

test('операцию НЕ добавить пациенту без койки — и отказ объясняет почему', async () => {
  const { db, server, base } = await startServer();
  try {
    const cookie = await login(base);
    const res = await addService(base, cookie, 10);
    assert.equal(res.status, 409, 'операция прошла без госпитализации');
    const body = await res.json();
    assert.match(body.error.message, /госпитализац/i, 'отказ не объясняет, что делать: ' + body.error.message);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM visit_services').get().n, 0, 'строка всё-таки записалась');
  } finally { server.close(); db.close(); }
});

test('лежащему пациенту операция добавляется', async () => {
  const { db, server, base } = await startServer();
  try {
    admit(db, 'admitted');
    const cookie = await login(base);
    const res = await addService(base, cookie, 10);
    assert.equal(res.status, 200, 'операция не прошла лежащему пациенту');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM visit_services').get().n, 1);
  } finally { server.close(); db.close(); }
});

test('ЗАЯВКА на госпитализацию койкой не считается', async () => {
  // 'ordered' — пациент ещё дома. Если считать его лежащим, правило
  // обходится одним нажатием «направить в стационар».
  const { db, server, base } = await startServer();
  try {
    admit(db, 'ordered');
    const cookie = await login(base);
    const res = await addService(base, cookie, 10);
    assert.equal(res.status, 409, 'заявка в стационар открыла дорогу операции');
  } finally { server.close(); db.close(); }
});

test('выписанный пациент операцию больше не получает', async () => {
  const { db, server, base } = await startServer();
  try {
    db.prepare(`INSERT INTO admissions (patient_id, status, admitted_at, discharged_at)
                VALUES (77,'discharged','2026-09-01T08:00:00Z','2026-09-05T08:00:00Z')`).run();
    const cookie = await login(base);
    assert.equal((await addService(base, cookie, 10)).status, 409);
  } finally { server.close(); db.close(); }
});

test('обычная услуга правилом не задета', async () => {
  // Правило про операции не имеет права мешать перевязке у амбулаторного.
  const { db, server, base } = await startServer();
  try {
    const cookie = await login(base);
    assert.equal((await addService(base, cookie, 11)).status, 200, 'процедура заблокирована заодно с операцией');
  } finally { server.close(); db.close(); }
});
