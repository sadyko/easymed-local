// INPATIENT_MONEY_FIX_V1 (D7) — строки стационара через /api/db больше не
// переписывают деньги и склад.
//
// Аудит (27.09) показал три пути мимо RPC:
//   • медсестра стёрла invoice_item_id у оплаченной строки — строка вернулась
//     в «к оплате» и вошла в следующий счёт второй раз;
//   • врач удалил выданный товар — строка исчезла, склад не вернулся;
//   • медсестра завела строку «50 шт. по 1 сум» на ЗАКРЫТУЮ госпитализацию —
//     без движения склада.
// Теперь: заводят строки только RPC (услуга — admission_service_add с ценой
// сервера, товар — выдача), invoice_item_id и status табличным путём не
// пишутся, а правка «в счёт / в учёт» и удаление — только у невыставленной
// строки, удаление — только не-товарной строки открытой госпитализации.
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
  const u = db.prepare('INSERT INTO users (id, username, password_hash, full_name, role) VALUES (?,?,?,?,?)');
  u.run(1, 'nurse', hashPassword('password1'), 'Медсестра', 'nurse');
  u.run(2, 'doc', hashPassword('password1'), 'Врач', 'doctor');
  db.prepare("INSERT INTO patients (id, full_name) VALUES (1,'Пациент')").run();
  db.prepare("INSERT INTO wards (id, name, price_per_day) VALUES (1,'Палата',100000)").run();
  db.prepare("INSERT INTO beds (id, code, ward_id, status) VALUES (1,'B-1',1,'occupied')").run();
  db.prepare("INSERT INTO services (id, name, price) VALUES (1,'Перевязка',50000)").run();
  db.prepare("INSERT INTO products (id, name, sale_price, on_hand) VALUES (1,'Бинт',1000,10)").run();
  db.prepare("INSERT INTO admissions (id, patient_id, bed_id, ward_id, status, admitted_at) VALUES (1,1,1,1,'active',strftime('%Y-%m-%dT%H:%M:%SZ','now'))").run();
  db.prepare("INSERT INTO admissions (id, patient_id, status, discharged_at) VALUES (2,1,'discharged',strftime('%Y-%m-%dT%H:%M:%SZ','now'))").run();
  const line = db.prepare(`INSERT INTO admission_services (admission_id, service_id, clinic_item_id, quantity, unit_price, total, status, billable)
                           VALUES (?,?,?,?,?,?,'added',1)`);
  const svc = line.run(1, 1, null, 1, 50000, 50000).lastInsertRowid;          // невыставленная услуга
  const item = line.run(1, null, 1, 3, 1000, 3000).lastInsertRowid;           // выданный товар
  const closed = line.run(2, 1, null, 1, 50000, 50000).lastInsertRowid;       // услуга закрытой госпитализации
  // Оплаченная строка: счёт + позиция.
  const inv = db.prepare("INSERT INTO invoices (invoice_number, admission_id, patient_id, subtotal, total_amount, paid_amount, status) VALUES ('I-1',1,1,50000,50000,50000,'paid')").run().lastInsertRowid;
  const it = db.prepare("INSERT INTO invoice_items (invoice_id, service_id, description, quantity, unit_price, total) VALUES (?,1,'Перевязка',1,50000,50000)").run(inv).lastInsertRowid;
  const paid = line.run(1, 1, null, 1, 50000, 50000).lastInsertRowid;
  db.prepare('UPDATE admission_services SET invoice_item_id = ? WHERE id = ?').run(it, paid);
  const server = await listen(createApp(db, { dataDir: licensedDataDir() }));
  return { db, server, base: `http://127.0.0.1:${server.address().port}`, ids: { svc, item, closed, paid } };
}

async function login(base, username) {
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'password1' }),
  });
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}
const call = (base, cookie, desc) => fetch(base + '/api/db', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(desc),
});
const byId = (id) => [{ col: 'id', op: 'eq', val: id }];

test('D7: медсестра не стирает invoice_item_id и не меняет status оплаченной строки', async () => {
  const { db, server, base, ids } = await startServer();
  try {
    const cookie = await login(base, 'nurse');
    const r1 = await call(base, cookie, { table: 'admission_services', op: 'update', values: { invoice_item_id: null }, filters: byId(ids.paid) });
    assert.notEqual(r1.status, 200);
    const r2 = await call(base, cookie, { table: 'admission_services', op: 'update', values: { status: 'added' }, filters: byId(ids.paid) });
    assert.notEqual(r2.status, 200);
    assert.ok(db.prepare('SELECT invoice_item_id FROM admission_services WHERE id = ?').get(ids.paid).invoice_item_id, 'строка осталась в счёте');
    // «В учёт» у выставленной строки — тоже нет: за ней деньги.
    const r3 = await call(base, cookie, { table: 'admission_services', op: 'update', values: { billable: 0 }, filters: byId(ids.paid) });
    assert.equal(r3.status, 409);
    assert.equal(db.prepare('SELECT billable FROM admission_services WHERE id = ?').get(ids.paid).billable, 1);
    // А у невыставленной — можно, как и раньше.
    const ok = await call(base, cookie, { table: 'admission_services', op: 'update', values: { billable: 0 }, filters: byId(ids.svc) });
    assert.equal(ok.status, 200);
  } finally { server.close(); db.close(); }
});

test('D7: врач не удаляет выданный товар мимо возврата на склад', async () => {
  const { db, server, base, ids } = await startServer();
  try {
    const cookie = await login(base, 'doc');
    const res = await call(base, cookie, { table: 'admission_services', op: 'delete', filters: byId(ids.item) });
    assert.equal(res.status, 409);
    assert.ok(db.prepare('SELECT 1 FROM admission_services WHERE id = ?').get(ids.item), 'строка товара на месте');
    // Выставленную и чужую закрытую — тоже нет.
    assert.equal((await call(base, cookie, { table: 'admission_services', op: 'delete', filters: byId(ids.paid) })).status, 409);
    assert.equal((await call(base, cookie, { table: 'admission_services', op: 'delete', filters: byId(ids.closed) })).status, 409);
    // Невыставленную услугу открытой госпитализации — можно (кнопка «Убрать» у койки).
    assert.equal((await call(base, cookie, { table: 'admission_services', op: 'delete', filters: byId(ids.svc) })).status, 200);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM admission_services WHERE id = ?').get(ids.svc).n, 0);
  } finally { server.close(); db.close(); }
});

test('D7: строку не завести табличным путём — «50 шт. по 1 сум» на закрытую госпитализацию', async () => {
  const { db, server, base } = await startServer();
  try {
    const cookie = await login(base, 'nurse');
    const before = db.prepare('SELECT COUNT(*) n FROM admission_services').get().n;
    const res = await call(base, cookie, { table: 'admission_services', op: 'insert',
      values: { admission_id: 2, clinic_item_id: 1, quantity: 50, unit_price: 1, total: 50, status: 'added', billable: 1 } });
    assert.notEqual(res.status, 200);
    const res2 = await call(base, cookie, { table: 'admission_services', op: 'insert',
      values: { admission_id: 1, service_id: 1, quantity: 1, unit_price: 1, total: 1, status: 'added', billable: 1 } });
    assert.notEqual(res2.status, 200);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM admission_services').get().n, before);
    assert.equal(db.prepare('SELECT on_hand FROM products WHERE id = 1').get().on_hand, 10);
  } finally { server.close(); db.close(); }
});
