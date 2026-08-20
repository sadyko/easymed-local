// FREE_SERVICE_V1 — услуга за 0 сум: не в кассу и в очередь как все.
//
// Живой случай: «Бесплатная консультация» выставлялась отдельным счётом на 0,
// счёт автоматически становился 'paid', строка визита оставалась в 'added' — и
// доска очереди показывала пациента как «ожидает оплату», хотя платить нечего.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { createInvoiceForVisit } from './billing.js';
import { cashierInvoices } from './cashier.js';
import { issueQueueNumbers, queueBoard } from './queue.js';

const REG = { id: 7, role: 'registrar' };
const CASH = { id: 9, role: 'cashier' };

function seed() {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (7,'r','x','Reg','registrar')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (9,'c','x','Cash','cashier')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (2,'d','x','Др. Азиза','doctor',1)").run();
  const free = db.prepare("INSERT INTO services (name, price, type) VALUES ('Бесплатная консультация', 0, 'consultation')").run().lastInsertRowid;
  const paid = db.prepare("INSERT INTO services (name, price, type) VALUES ('Консультация ЛОРа', 60000, 'consultation')").run().lastInsertRowid;
  const pid = db.prepare("INSERT INTO patients (full_name) VALUES ('Пациент')").run().lastInsertRowid;
  const vid = db.prepare("INSERT INTO visits (patient_id, visit_date) VALUES (?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))").run(pid).lastInsertRowid;
  return { db, free, paid, pid, vid };
}
function line(db, vid, svc, price, doctor = 2) {
  return db.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status) VALUES (?,?,?,1,?,?,'added')")
    .run(vid, svc, doctor, price, price).lastInsertRowid;
}
const statusOf = (db, id) => db.prepare('SELECT status FROM visit_services WHERE id = ?').get(id).status;

test('счёт на ноль сразу отпускает услугу в очередь, а не держит в «ожидает оплату»', () => {
  const { db, free, vid } = seed();
  const l = line(db, vid, free, 0);
  assert.equal(statusOf(db, l), 'added', 'до счёта — как обычно');
  const { invoice } = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [l] }, REG);
  assert.equal(invoice.total_amount, 0);
  assert.equal(invoice.status, 'paid', 'платить нечего — счёт закрыт сразу');
  assert.equal(statusOf(db, l), 'queued', 'строка в очереди, а не в ожидании кассы');
});

test('платная услуга по-прежнему ждёт кассу', () => {
  const { db, paid, vid } = seed();
  const l = line(db, vid, paid, 60000);
  createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [l] }, REG);
  assert.equal(statusOf(db, l), 'added', 'деньги не приняты — строка ждёт');
});

test('счёт на ноль не попадает в «Приём оплат»', () => {
  const { db, free, paid, vid } = seed();
  const lFree = line(db, vid, free, 0);
  const lPaid = line(db, vid, paid, 60000);
  createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [lFree] }, REG);
  createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [lPaid] }, REG);
  const list = cashierInvoices(db, {}, CASH);
  const rows = Array.isArray(list) ? list : (list.invoices || list.rows || []);
  const totals = rows.map(r => r.total_amount);
  assert.ok(!totals.includes(0), 'нулевых счетов в кассе нет: ' + JSON.stringify(totals));
  assert.ok(totals.includes(60000), 'платный счёт кассир видит');
});

test('на доске бесплатная услуга — обычное ожидание, даже если счёта не было вовсе', () => {
  const { db, free, vid } = seed();
  const l = line(db, vid, free, 0);          // счёт НЕ выставляли
  issueQueueNumbers(db, { p_ids: [l] }, REG);
  db.prepare("UPDATE role_permissions SET permissions = json_set(json_insert(permissions,'$.sections[#]','queue'),'$.levels.queue','admin') WHERE role = 'registrar' AND json_valid(permissions) AND permissions NOT LIKE '%\"queue\"%'").run();
  const board = queueBoard(db, {}, REG);
  const tickets = board.groups.flatMap(g => g.tickets);
  assert.equal(tickets.length, 1);
  assert.equal(tickets[0].state, 'waiting', 'не «ожидает оплату»');
});

test('бесплатная услуга занимает обычное место в очереди — после предыдущих', () => {
  const { db, free, paid, vid } = seed();
  const first = line(db, vid, paid, 60000);
  const second = line(db, vid, free, 0);
  const t = issueQueueNumbers(db, { p_ids: [first, second] }, REG);
  const by = new Map(t.map(x => [x.visit_service_id, x]));
  // Один пациент у одного врача — один номер; порядок не ломается.
  assert.equal(by.get(second).number, by.get(first).number);
  assert.equal(by.get(first).number, 1);
});
