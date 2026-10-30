// REFUND_ANY_V1 (2026-10-29) — ПОИСК СЧЁТА ЗА ЛЮБОЙ ДЕНЬ.
//
// Владелец: «возврат любой услуги». Сервер возврат выполненной работы не
// запрещает, но до него было не дойти: «Приём оплат» (cashier_invoices) держит
// оплаченные и отменённые счета только за сегодня, и вчерашний счёт касса не
// находила вовсе. Теперь cashier_invoice_search ищет на сервере по всем дням:
// номер счёта, ФИО, телефон (и одними цифрами), номер карты; своё здание;
// без счетов плательщику, депозитов и продажи карт; страницами по 50. По номеру
// (invoice_id) — тот же счёт строкой списка: «История операций» и окно визита
// открывают по нему полное окно «Платежи».
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { createInvoiceForVisit, recordPayment } from './billing.js';
import { cashierInvoices, cashierInvoiceSearch, voidInvoice, openCashShift } from './cashier.js';
import { RPC } from './index.js';
import { isReadOnlyRpc } from '../control/gate.js';

const registrar = { id: 7, role: 'registrar' };
const cashier = { id: 9, role: 'cashier', full_name: 'Кассир' };

function seed() {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, role, full_name) VALUES (7,'reg','x','registrar','Регистратор')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, role, full_name) VALUES (9,'cash','x','cashier','Кассир')").run();
  const p1 = db.prepare("INSERT INTO patients (full_name, phone, branch_id) VALUES ('Рахимов Жасур', '+998 90 111-22-33', 1)").run().lastInsertRowid;
  const p2 = db.prepare("INSERT INTO patients (full_name, phone, branch_id) VALUES ('Каримова Нигора', '+998 97 777-66-55', 1)").run().lastInsertRowid;
  const svc = db.prepare("INSERT INTO services (name, price) VALUES ('Приём терапевта', 100000)").run().lastInsertRowid;
  openCashShift(db, { opening_float: 0 }, cashier);
  return { db, p1, p2, svc };
}
// Оплаченный счёт визита пациента; daysAgo — день счёта и оплаты.
function paidInvoice(s, pid, daysAgo = 0) {
  const vid = s.db.prepare("INSERT INTO visits (patient_id, visit_date) VALUES (?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))").run(pid).lastInsertRowid;
  const vs = s.db.prepare('INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total) VALUES (?, ?, 1, 0, 0)').run(vid, s.svc).lastInsertRowid;
  const inv = createInvoiceForVisit(s.db, { visit_id: vid, visit_service_ids: [vs] }, registrar).invoice;
  recordPayment(s.db, { invoice_id: inv.id, amount: 100000, method: 'cash' }, cashier);
  if (daysAgo) {
    s.db.prepare("UPDATE invoices SET created_at = strftime('%Y-%m-%dT%H:%M:%SZ','now', ?), paid_at = strftime('%Y-%m-%dT%H:%M:%SZ','now', ?) WHERE id = ?")
      .run('-' + daysAgo + ' days', '-' + daysAgo + ' days', inv.id);
  }
  return s.db.prepare('SELECT * FROM invoices WHERE id = ?').get(inv.id);
}
const ids = (out) => out.rows.map((r) => r.id);

test('вчерашний оплаченный счёт в «Приёме оплат» не виден — поиск находит его по номеру, ФИО, телефону и номеру карты', () => {
  const s = seed();
  const old = paidInvoice(s, s.p1, 10);
  const fresh = paidInvoice(s, s.p1, 0);
  const other = paidInvoice(s, s.p2, 3);
  assert.ok(!ids(cashierInvoices(s.db, {}, cashier)).includes(old.id), 'касса показывает оплаченные только за сегодня — вот почему нужен поиск');

  // Номер счёта — и целиком, и хвостом.
  assert.deepEqual(ids(cashierInvoiceSearch(s.db, { q: old.invoice_number }, cashier)), [old.id]);
  assert.ok(ids(cashierInvoiceSearch(s.db, { q: old.invoice_number.slice(-5) }, cashier)).includes(old.id));
  // ФИО — часть, в другом регистре (кириллица); новые счета первыми.
  assert.deepEqual(ids(cashierInvoiceSearch(s.db, { q: 'рахимов' }, cashier)), [fresh.id, old.id]);
  // Телефон — как записан и одними цифрами.
  assert.deepEqual(ids(cashierInvoiceSearch(s.db, { q: '111-22-33' }, cashier)), [fresh.id, old.id]);
  assert.deepEqual(ids(cashierInvoiceSearch(s.db, { q: '901112233' }, cashier)), [fresh.id, old.id]);
  // Номер карты пациента (MRN).
  const mrn = s.db.prepare('SELECT mrn FROM patients WHERE id = ?').get(s.p2).mrn;
  assert.ok(mrn, 'у пациента есть номер карты');
  const byCard = ids(cashierInvoiceSearch(s.db, { q: mrn }, cashier));
  assert.ok(byCard.includes(other.id) && !byCard.includes(old.id), 'по номеру карты — счёт этого пациента: ' + byCard);
  // Строка — та же, что у списка кассы: окно «Платежи» знает пациента и состав.
  const row = cashierInvoiceSearch(s.db, { q: old.invoice_number }, cashier).rows[0];
  for (const k of ['invoice_number', 'status', 'total_amount', 'paid_amount', 'created_at', 'patient_name', 'mrn', 'phone', 'patient_id', 'admission_id', 'visit_id', 'items_count', 'first_item', 'methods']) {
    assert.ok(k in row, 'в строке поиска нет поля ' + k);
  }
  assert.equal(row.patient_name, 'Рахимов Жасур');
  assert.equal(row.first_item, 'Приём терапевта');
  assert.equal(row.methods, 'cash');
});

test('отменённые и частично оплаченные — находятся; плательщик, чужое здание, депозиты и карты — нет', () => {
  const s = seed();
  const paid = paidInvoice(s, s.p1, 5);
  const vid = s.db.prepare("INSERT INTO visits (patient_id, visit_date) VALUES (?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))").run(s.p1).lastInsertRowid;
  const vs = s.db.prepare('INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total) VALUES (?, ?, 1, 0, 0)').run(vid, s.svc).lastInsertRowid;
  const voided = createInvoiceForVisit(s.db, { visit_id: vid, visit_service_ids: [vs] }, registrar).invoice;
  voidInvoice(s.db, { invoice_id: voided.id }, cashier);
  s.db.prepare("UPDATE invoices SET created_at = strftime('%Y-%m-%dT%H:%M:%SZ','now','-7 days'), voided_at = strftime('%Y-%m-%dT%H:%M:%SZ','now','-7 days') WHERE id = ?").run(voided.id);
  const payer = s.db.prepare("INSERT INTO payers (name, kind, active) VALUES ('Страховая', 'insurance', 1)").run().lastInsertRowid;
  const add = s.db.prepare(`INSERT INTO invoices (invoice_number, patient_id, subtotal, total_amount, paid_amount, status, payer_id, sync_origin, created_at)
                            VALUES (?, ?, 100000, 100000, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now','-2 days'))`);
  const partial = add.run('INV-A-26-09001', s.p1, 40000, 'partial', null, null).lastInsertRowid;
  const toPayer = add.run('INV-A-26-09002', s.p1, 0, 'unpaid', payer, null).lastInsertRowid;
  const foreign = add.run('INV-B-26-09003', s.p1, 100000, 'paid', null, 'B').lastInsertRowid;
  const dep = add.run('DEP-A-26-00001', s.p1, 100000, 'paid', null, null).lastInsertRowid;
  const card = add.run('CARD-A-26-00001', s.p1, 100000, 'paid', null, null).lastInsertRowid;
  const found = ids(cashierInvoiceSearch(s.db, { q: 'Рахимов' }, cashier));
  for (const id of [paid.id, voided.id, partial]) assert.ok(found.includes(id), 'найден ' + id);
  for (const id of [toPayer, foreign, dep, card]) assert.ok(!found.includes(id), 'не должен находиться ' + id);
  // По номеру — то же правило.
  assert.deepEqual(ids(cashierInvoiceSearch(s.db, { invoice_id: foreign }, cashier)), []);
  assert.deepEqual(ids(cashierInvoiceSearch(s.db, { invoice_id: dep }, cashier)), []);
  assert.deepEqual(ids(cashierInvoiceSearch(s.db, { invoice_id: voided.id }, cashier)), [voided.id]);
});

test('страницы по 50; короткая строка — ничего не ищет; % и _ — буквы, а не шаблон', () => {
  const s = seed();
  const add = s.db.prepare(`INSERT INTO invoices (invoice_number, patient_id, subtotal, total_amount, paid_amount, status, created_at)
                            VALUES (?, ?, 1000, 1000, 1000, 'paid', strftime('%Y-%m-%dT%H:%M:%SZ','now', ?))`);
  for (let k = 1; k <= 55; k++) add.run('INV-A-25-' + String(k).padStart(5, '0'), s.p2, '-' + k + ' days');
  const first = cashierInvoiceSearch(s.db, { q: 'Каримова' }, cashier);
  assert.equal(first.rows.length, 50);
  assert.equal(first.has_more, true);
  const second = cashierInvoiceSearch(s.db, { q: 'Каримова', offset: 50 }, cashier);
  assert.equal(second.rows.length, 5);
  assert.equal(second.has_more, false);
  assert.equal(new Set([...ids(first), ...ids(second)]).size, 55, 'страницы не повторяют счета');
  const short = cashierInvoiceSearch(s.db, { q: 'К' }, cashier);
  assert.deepEqual([short.rows.length, short.too_short], [0, true]);
  assert.equal(cashierInvoiceSearch(s.db, { q: '%%' }, cashier).rows.length, 0, '% — не «всё подряд»');
  assert.throws(() => cashierInvoiceSearch(s.db, { q: 'x'.repeat(201) }, cashier), (e) => e.status === 400);
  assert.throws(() => cashierInvoiceSearch(s.db, { q: 'Каримова', offset: 'abc' }, cashier), (e) => e.status === 400);
  assert.throws(() => cashierInvoiceSearch(s.db, { invoice_id: 'x' }, cashier), (e) => e.status === 400);
});

test('поиск — касса и администратор; RPC чтения, зарегистрирован', () => {
  const s = seed();
  assert.throws(() => cashierInvoiceSearch(s.db, { q: 'Рахимов' }, registrar), (e) => e.status === 403);
  assert.equal(typeof RPC.cashier_invoice_search, 'function');
  assert.equal(isReadOnlyRpc('cashier_invoice_search'), true);
});
