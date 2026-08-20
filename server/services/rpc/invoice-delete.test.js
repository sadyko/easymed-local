// INVOICE_DELETE_V1 — удалить отменённый счёт может ТОЛЬКО главный админ.
//
// Отмена (void) оставляет документ в списке навсегда: у клиники за день
// набирается два десятка отменённых счетов, и «Приём оплат» превращается в
// свалку. Удаление — это уборка мусора, а не исправление денег, поэтому:
//   • только status='void' и только без единого платежа;
//   • 'refunded' НЕ удаляется никогда — за ним стоит движение денег, а payments
//     кормят итоги смены и X-отчёт;
//   • оплаченный, неоплаченный, долг, частичный — не трогаются вовсе.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { createInvoiceForVisit, recordPayment } from './billing.js';
import { voidInvoice, openCashShift, deleteInvoice } from './cashier.js';

const ADMIN = { id: 1, role: 'admin', full_name: 'Главный' };
const CASH  = { id: 9, role: 'cashier', full_name: 'Касса' };
const REG   = { id: 7, role: 'registrar', full_name: 'Регистратура' };

function seed() {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO users (id,username,password_hash,role,full_name) VALUES (1,'a','x','admin','Главный')").run();
  db.prepare("INSERT INTO users (id,username,password_hash,role,full_name) VALUES (7,'r','x','registrar','Регистратура')").run();
  db.prepare("INSERT INTO users (id,username,password_hash,role,full_name) VALUES (9,'c','x','cashier','Касса')").run();
  const pid = db.prepare("INSERT INTO patients (full_name) VALUES ('Пациент')").run().lastInsertRowid;
  const vid = db.prepare("INSERT INTO visits (patient_id, visit_date) VALUES (?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))").run(pid).lastInsertRowid;
  const sid = db.prepare("INSERT INTO services (name, price) VALUES ('Консультация', 100000)").run().lastInsertRowid;
  const vs = db.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status) VALUES (?,?,1,100000,100000,'added')").run(vid, sid).lastInsertRowid;
  const { invoice } = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs] }, REG);
  return { db, pid, vid, vs, invoice };
}
const count = (db, sql, ...p) => db.prepare(sql).get(...p).n;

test('главный админ удаляет отменённый счёт — документ и его строки исчезают', () => {
  const { db, invoice } = seed();
  voidInvoice(db, { invoice_id: invoice.id }, CASH);
  const out = deleteInvoice(db, { invoice_id: invoice.id }, ADMIN);
  assert.equal(out.deleted, true);
  assert.equal(out.invoice_number, invoice.invoice_number);
  assert.equal(count(db, 'SELECT COUNT(*) n FROM invoices WHERE id = ?', invoice.id), 0);
  assert.equal(count(db, 'SELECT COUNT(*) n FROM invoice_items WHERE invoice_id = ?', invoice.id), 0);
  db.close();
});

test('услуга визита остаётся и снова доступна к выставлению', () => {
  const { db, invoice, vs } = seed();
  voidInvoice(db, { invoice_id: invoice.id }, CASH);
  deleteInvoice(db, { invoice_id: invoice.id }, ADMIN);
  const line = db.prepare('SELECT * FROM visit_services WHERE id = ?').get(vs);
  assert.ok(line, 'сама услуга не удаляется вместе со счётом');
  assert.equal(line.invoice_item_id, null, 'ссылка на удалённую строку счёта снята');
  db.close();
});

test('никто, кроме админа: касса и регистратура получают отказ', () => {
  const { db, invoice } = seed();
  voidInvoice(db, { invoice_id: invoice.id }, CASH);
  assert.throws(() => deleteInvoice(db, { invoice_id: invoice.id }, CASH), /not allowed/);
  assert.throws(() => deleteInvoice(db, { invoice_id: invoice.id }, REG), /not allowed/);
  assert.equal(count(db, 'SELECT COUNT(*) n FROM invoices WHERE id = ?', invoice.id), 1, 'счёт на месте');
  db.close();
});

test('неотменённый счёт не удаляется ни в каком статусе', () => {
  const { db, invoice } = seed();
  assert.throws(() => deleteInvoice(db, { invoice_id: invoice.id }, ADMIN), /отмен/i);
  for (const st of ['paid', 'partial', 'debt']) {
    db.prepare('UPDATE invoices SET status = ? WHERE id = ?').run(st, invoice.id);
    assert.throws(() => deleteInvoice(db, { invoice_id: invoice.id }, ADMIN), /отмен/i, st);
  }
  db.close();
});

test('счёт с возвратом не удаляется: за ним движение денег и итоги смены', () => {
  const { db, invoice } = seed();
  openCashShift(db, { opening_float: 0 }, CASH);
  recordPayment(db, { invoice_id: invoice.id, amount: 100000, method: 'cash' }, CASH);
  db.prepare("UPDATE invoices SET status = 'refunded' WHERE id = ?").run(invoice.id);
  // Отказать может любая из двух защит — статус не 'void' и наличие платежей.
  // Тесту важно, что счёт УЦЕЛЕЛ, а не какая из них сработала первой.
  assert.throws(() => deleteInvoice(db, { invoice_id: invoice.id }, ADMIN), /отмен|платеж|возврат|касс/i);
  assert.equal(count(db, 'SELECT COUNT(*) n FROM invoices WHERE id = ?', invoice.id), 1);
  assert.equal(count(db, 'SELECT COUNT(*) n FROM payments WHERE invoice_id = ?', invoice.id), 1, 'платёж на месте');
  db.close();
});

test('отменённый, но с платежами в истории — тоже не удаляется', () => {
  const { db, invoice } = seed();
  openCashShift(db, { opening_float: 0 }, CASH);
  recordPayment(db, { invoice_id: invoice.id, amount: 100000, method: 'cash' }, CASH);
  db.prepare("UPDATE invoices SET status = 'void' WHERE id = ?").run(invoice.id);
  assert.throws(() => deleteInvoice(db, { invoice_id: invoice.id }, ADMIN), /платеж/i);
  db.close();
});

test('соседние счета не затрагиваются', () => {
  const { db, vid, invoice } = seed();
  const sid2 = db.prepare("INSERT INTO services (name, price) VALUES ('УЗИ', 50000)").run().lastInsertRowid;
  const vs2 = db.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status) VALUES (?,?,1,50000,50000,'added')").run(vid, sid2).lastInsertRowid;
  const other = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs2] }, REG).invoice;
  voidInvoice(db, { invoice_id: invoice.id }, CASH);
  deleteInvoice(db, { invoice_id: invoice.id }, ADMIN);
  assert.equal(count(db, 'SELECT COUNT(*) n FROM invoices WHERE id = ?', other.id), 1);
  assert.equal(count(db, 'SELECT COUNT(*) n FROM invoice_items WHERE invoice_id = ?', other.id), 1);
  db.close();
});

test('ссылка госпитализации на счёт снимается, сама госпитализация цела', () => {
  const { db, invoice, pid } = seed();
  const wid = db.prepare("INSERT INTO wards (name, price_per_day) VALUES ('П1', 1000)").run().lastInsertRowid;
  const bid = db.prepare("INSERT INTO beds (ward_id, code, status) VALUES (?,'B1','occupied')").run(wid).lastInsertRowid;
  const aid = db.prepare("INSERT INTO admissions (patient_id, ward_id, bed_id, admitted_at, status, invoice_id) VALUES (?,?,?,strftime('%Y-%m-%dT%H:%M:%SZ','now'),'discharged',?)")
    .run(pid, wid, bid, invoice.id).lastInsertRowid;
  voidInvoice(db, { invoice_id: invoice.id }, CASH);
  deleteInvoice(db, { invoice_id: invoice.id }, ADMIN);
  const adm = db.prepare('SELECT * FROM admissions WHERE id = ?').get(aid);
  assert.ok(adm, 'госпитализация не удаляется');
  assert.equal(adm.invoice_id, null);
  db.close();
});

test('несуществующий счёт — понятная ошибка, а не падение', () => {
  const { db } = seed();
  assert.throws(() => deleteInvoice(db, { invoice_id: 999999 }, ADMIN), /not found/);
  assert.throws(() => deleteInvoice(db, { invoice_id: 0 }, ADMIN), /positive integer/);
  db.close();
});
