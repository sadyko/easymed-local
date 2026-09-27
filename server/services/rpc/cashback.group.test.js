// CASHBACK_BY_GROUP_V1 (владелец, 2026-09-27, B1) — кэшбэк зависит от группы
// пациента. Правило с группой — только для пациентов этой группы; правило без
// группы — «для всех». Пациент с группой, у которой есть своё правило, получает
// только правила группы (наибольший процент из них); группа без правила и
// пациент без группы — правила «для всех». Всё — через настоящую оплату.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { depositBalance } from './deposits.js';
import { createInvoiceForVisit, recordPayment } from './billing.js';
import { openCashShift } from './cashier.js';
import { cashbackRuleFor } from './cashback.js';

const REG  = { id: 7, role: 'registrar', full_name: 'Каримова' };
const CASH = { id: 9, role: 'cashier', full_name: 'Юлдашева' };

function seed() {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO users (id,username,password_hash,full_name,role) VALUES (7,'r','x','Каримова','registrar')").run();
  db.prepare("INSERT INTO users (id,username,password_hash,full_name,role) VALUES (9,'c','x','Юлдашева','cashier')").run();
  const vip = db.prepare("INSERT INTO patient_categories (name) VALUES ('VIP')").run().lastInsertRowid;
  const staff = db.prepare("INSERT INTO patient_categories (name) VALUES ('Сотрудники')").run().lastInsertRowid;
  const svc = db.prepare("INSERT INTO services (name, price) VALUES ('Кардиолог', 100000)").run().lastInsertRowid;
  openCashShift(db, { opening_float: 0 }, CASH);
  return { db, vip, staff, svc };
}
const patient = (db, cat = null) => db.prepare("INSERT INTO patients (full_name, branch_id, category_id) VALUES ('П', 1, ?)").run(cat).lastInsertRowid;
const rule = (db, percent, cat = null, active = 1) =>
  db.prepare('INSERT INTO cashback_rules (name, percent, active, category_id) VALUES (?, ?, ?, ?)').run('R' + percent, percent, active, cat).lastInsertRowid;
function payVisit(db, pid, svc) {
  const vid = db.prepare("INSERT INTO visits (patient_id, branch_id, visit_date) VALUES (?,1,strftime('%Y-%m-%dT%H:%M:%SZ','now'))").run(pid).lastInsertRowid;
  const vs = db.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status) VALUES (?,?,1,100000,100000,'added')").run(vid, svc).lastInsertRowid;
  const inv = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs] }, REG).invoice;
  recordPayment(db, { invoice_id: inv.id, amount: inv.total_amount, method: 'cash' }, CASH);
  return depositBalance(db, { patient_id: pid }, CASH).balance;
}

test('старые правила без группы — «для всех»: и пациент без группы, и пациент с группой без своего правила получают их', () => {
  const { db, vip, svc } = seed();
  rule(db, 3);
  assert.equal(payVisit(db, patient(db), svc), 3000);
  assert.equal(payVisit(db, patient(db, vip), svc), 3000, 'у VIP своего правила нет — действует общее');
  db.close();
});

test('правило группы — только своей группе; пациент группы получает только правила группы, даже если общее больше', () => {
  const { db, vip, staff, svc } = seed();
  rule(db, 5);            // для всех
  rule(db, 2, vip);       // VIP
  rule(db, 10, staff);    // сотрудники
  assert.equal(payVisit(db, patient(db, vip), svc), 2000, 'VIP — только своё правило, 2 %, а не общие 5 %');
  assert.equal(payVisit(db, patient(db, staff), svc), 10000, 'сотрудники — своё 10 %');
  assert.equal(payVisit(db, patient(db), svc), 5000, 'без группы — только «для всех», чужие 10 % не достаются');
  db.close();
});

test('несколько правил одной группы — наибольший процент; выключенное правило не в счёт', () => {
  const { db, vip, svc } = seed();
  rule(db, 3, vip);
  rule(db, 7, vip);
  rule(db, 50, vip, 0);   // выключено
  assert.equal(payVisit(db, patient(db, vip), svc), 7000);
  db.close();
});

test('правило группы с 0 % — «этой группе кэшбэка нет», общее правило её не догоняет', () => {
  const { db, vip, svc } = seed();
  rule(db, 5);
  rule(db, 0, vip);
  const pid = patient(db, vip);
  assert.equal(payVisit(db, pid, svc), 0);
  assert.equal(cashbackRuleFor(db, pid).percent, 0);
  db.close();
});

test('выключенное правило группы — группа снова получает «для всех»', () => {
  const { db, vip, svc } = seed();
  rule(db, 4);
  rule(db, 9, vip, 0);
  assert.equal(payVisit(db, patient(db, vip), svc), 4000);
  db.close();
});

test('строка кэшбэка называет правило, по которому начислено', () => {
  const { db, vip, svc } = seed();
  rule(db, 5);
  db.prepare("INSERT INTO cashback_rules (name, percent, active, category_id) VALUES ('VIP 8%', 8, 1, ?)").run(vip);
  const pid = patient(db, vip);
  payVisit(db, pid, svc);
  const row = db.prepare("SELECT notes FROM patient_deposits WHERE kind = 'cashback' AND patient_id = ?").get(pid);
  assert.match(row.notes, /VIP 8%/);
  db.close();
});
