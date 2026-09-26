// PACKAGES_V1 (ревью I-3) — пакет вне срока визита отказывается В МИГ, когда
// его ставят на строку визита, а не у кассы.
//
// Счёт по визиту отказывает целиком, если пакет строки не действует в местный
// день визита (billing.js linePackage). Прежде об этом узнавали только у
// кассы, когда строка давно записана; и снять пометку пакета со строки было
// нечем — правка package_id была закрыта. Теперь: вставка с пакетом вне срока —
// 409 словами; package_id правкой только снимается (NULL) и только со строки
// вне счёта; после снятия счёт выставляется без скидки пакета.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { hashPassword } from '../services/auth.js';
import { createApp } from '../app.js';
import { licensedDataDir } from '../services/control/licensed-fixture.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';
import { createInvoiceForVisit } from '../services/rpc/billing.js';

async function startServer() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare('INSERT INTO users (id, username, password_hash, full_name, role) VALUES (1,?,?,?,?)')
    .run('reg', hashPassword('password1'), 'Регистратор', 'registrar');
  db.prepare("INSERT INTO services (id, name, price, type) VALUES (1,'УЗИ',100000,'imaging')").run();
  db.prepare("INSERT INTO patients (id, full_name) VALUES (77,'Пациент Тест')").run();
  // Визит 10.09 — пакет «Август» кончился 31.08, пакет «Осень» действует.
  db.prepare("INSERT INTO visits (id, patient_id, visit_date) VALUES (500,77,'2026-09-10T09:00:00Z')").run();
  db.prepare("INSERT INTO service_templates (id, name, service_ids, discount_percent, valid_from, valid_until) VALUES (1,'Август','[1]',20,'2026-08-01','2026-08-31')").run();
  db.prepare("INSERT INTO service_templates (id, name, service_ids, discount_percent, valid_from, valid_until) VALUES (2,'Осень','[1]',20,'2026-09-01','2026-09-30')").run();
  const server = await listen(createApp(db, { dataDir: licensedDataDir() }));
  return { db, server, base: `http://127.0.0.1:${server.address().port}` };
}

async function login(base) {
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'reg', password: 'password1' }),
  });
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

const call = (base, cookie, desc) => fetch(base + '/api/db', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
  body: JSON.stringify(desc),
});
const addLine = (base, cookie, packageId) => call(base, cookie, {
  table: 'visit_services', op: 'insert',
  values: { visit_id: 500, service_id: 1, quantity: 1, unit_price: 100000, total: 100000, status: 'added', package_id: packageId },
});
const setPackage = (base, cookie, id, val) => call(base, cookie, {
  table: 'visit_services', op: 'update', values: { package_id: val }, filters: [{ col: 'id', op: 'eq', val: id }],
});

test('строку с пакетом вне срока визита не завести — отказ словами, ничего не записано', async () => {
  const { db, server, base } = await startServer();
  try {
    const cookie = await login(base);
    const res = await addLine(base, cookie, 1);
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.match(body.error.message, /Пакет «Август»/);
    assert.match(body.error.message, /10\.09\.2026/);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM visit_services').get().n, 0);
    // Действующий пакет — заводится.
    assert.equal((await addLine(base, cookie, 2)).status, 200);
  } finally { server.close(); db.close(); }
});

test('пакет со строки вне счёта снимается — и счёт выставляется без его скидки', async () => {
  const { db, server, base } = await startServer();
  try {
    const cookie = await login(base);
    // Строка, помеченная пакетом, который потом ушёл из срока (правка пакета
    // после записи): прямо в базу, как было бы до сужения срока.
    const id = db.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status, package_id) VALUES (500,1,1,100000,100000,'added',1)").run().lastInsertRowid;
    assert.throws(() => createInvoiceForVisit(db, { visit_id: 500, visit_service_ids: [id] }, { id: 1, role: 'registrar' }), /Пакет «Август»/);
    // Поставить пакет правкой нельзя…
    assert.equal((await setPackage(base, cookie, id, 2)).status, 403);
    // …снять — можно.
    assert.equal((await setPackage(base, cookie, id, null)).status, 200);
    const out = createInvoiceForVisit(db, { visit_id: 500, visit_service_ids: [id] }, { id: 1, role: 'registrar' });
    assert.equal(out.invoice.discount_amount, 0);
    assert.equal(out.invoice.total_amount, 100000);
    // Со строки в счёте пакет правкой уже не снять — скидка в позиции счёта.
    const inv = db.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status, package_id) VALUES (500,1,1,100000,100000,'added',2)").run().lastInsertRowid;
    createInvoiceForVisit(db, { visit_id: 500, visit_service_ids: [inv] }, { id: 1, role: 'registrar' });
    const res = await setPackage(base, cookie, inv, null);
    assert.equal(res.status, 409);
    assert.equal(db.prepare('SELECT package_id FROM visit_services WHERE id = ?').get(inv).package_id, 2);
  } finally { server.close(); db.close(); }
});
