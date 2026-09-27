// FINAL_MONEY_FIX_V1 (2026-09-27) — находки финального денежного ревью,
// каждая — через настоящие RPC кассы и настоящую SQLite после миграций.
//
//   I1 — возвращённая пациенту услуга (refund_invoice_line / отмена после
//        возврата) по умолчанию снова выставлялась: окно визита отмечает все
//        невыставленные строки, и регистратор брал с пациента второй раз.
//        Теперь сервер знает такие строки (visit_refunded_lines), а
//        create_invoice_for_visit их без явного rebill_refunded не берёт;
//   I2 — возврат услуги, оплаченной картой, чей остаток уже вернули
//        покупателю: деньги уходили на мёртвую карту, и выдать их было
//        нечем. Теперь — только деньгами или на баланс, по явному выбору;
//   M2 — возврат строки, после которой в счёте остались только бесплатные
//        услуги: счёт отменялся целиком и снимал их с визита;
//   M5 — замена консультации на услугу оставляла на строке вид приёма.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import {
  createInvoiceForVisit, recordPayment, refundPayment, refundInvoiceLine, changeUnpaidService,
  visitRefundedLines,
} from './billing.js';
import { voidInvoice, openCashShift } from './cashier.js';
import { sellCard, refundCardSale } from './card-sales.js';
import { walletBalance } from '../domain/wallet.js';
import { RPC } from './index.js';
import { isReadOnlyRpc } from '../control/gate.js';

const registrar = { id: 7, role: 'registrar' };
const cashier = { id: 9, role: 'cashier', full_name: 'Кассир' };
const DOC = 20;

function seed() {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, role, full_name) VALUES (7,'reg','x','registrar','Регистратор')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, role, full_name) VALUES (9,'cash','x','cashier','Кассир')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, role, full_name, is_doctor) VALUES (?,'doc','x','doctor','Врач',1)").run(DOC);
  const pid = db.prepare("INSERT INTO patients (full_name, branch_id) VALUES ('Пациент', 1)").run().lastInsertRowid;
  const vid = db.prepare("INSERT INTO visits (patient_id, visit_date) VALUES (?, '2026-09-27T05:00:00Z')").run(pid).lastInsertRowid;
  openCashShift(db, { opening_float: 0 }, cashier);
  return { db, pid, vid };
}
const addService = (db, name, price) => db.prepare('INSERT INTO services (name, price) VALUES (?, ?)').run(name, price).lastInsertRowid;
const addLine = (db, vid, row) => {
  const r = { quantity: 1, unit_price: 0, total: 0, ...row, visit_id: vid };
  const cols = Object.keys(r);
  return db.prepare(`INSERT INTO visit_services (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(...Object.values(r)).lastInsertRowid;
};
const itemOf = (db, vs) => db.prepare('SELECT invoice_item_id i FROM visit_services WHERE id = ?').get(vs).i;
const inv = (db, id) => db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);

// ─── I1 ─────────────────────────────────────────────────────────────────────
// Приём 100 000 (сделан) + перевязка 50 000; оплачено 150 000; приём вернули.
function refundedVisit() {
  const s = seed();
  const a = addService(s.db, 'Приём', 100000);
  const b = addService(s.db, 'Перевязка', 50000);
  const vsA = addLine(s.db, s.vid, { service_id: a, doctor_id: DOC, status: 'completed' });
  const vsB = addLine(s.db, s.vid, { service_id: b });
  const out = createInvoiceForVisit(s.db, { visit_id: s.vid, visit_service_ids: [vsA, vsB] }, registrar);
  recordPayment(s.db, { invoice_id: out.invoice.id, amount: 150000, method: 'cash' }, cashier);
  return { ...s, vsA, vsB, invoice: out.invoice };
}

test('I1: возвращённая строкой услуга не выставляется снова без явного выбора', () => {
  const f = refundedVisit();
  const r = refundInvoiceLine(f.db, { invoice_item_id: itemOf(f.db, f.vsA) }, cashier);
  assert.equal(r.refunded, 100000);
  assert.equal(itemOf(f.db, f.vsA), null, 'сделанная работа осталась в визите невыставленной');
  // Сервер называет её возвращённой — окно визита не отмечает её по умолчанию.
  assert.deepEqual(visitRefundedLines(f.db, { visit_id: f.vid }, registrar).line_ids, [f.vsA]);
  // Выставить «всё невыставленное» — отказ словами, а не второй счёт на 100 000.
  assert.throws(() => createInvoiceForVisit(f.db, { visit_id: f.vid, visit_service_ids: [f.vsA] }, registrar),
    (e) => e.status === 409 && /вернули деньги/.test(e.message));
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM invoices WHERE status <> 'void'").get().n, 1, 'второго счёта нет');
  // Явный выбор — можно (пациент передумал и снова платит).
  const again = createInvoiceForVisit(f.db, { visit_id: f.vid, visit_service_ids: [f.vsA], rebill_refunded: true }, registrar);
  assert.equal(again.invoice.total_amount, 100000);
  assert.deepEqual(visitRefundedLines(f.db, { visit_id: f.vid }, registrar).line_ids, [], 'выставлена — больше не «возвращено»');
});

test('I1: отмена счёта после полного возврата — сделанная работа тоже помечена возвращённой', () => {
  const f = refundedVisit();
  const pay = f.db.prepare('SELECT id FROM payments WHERE invoice_id = ? AND amount > 0').get(f.invoice.id).id;
  const r = refundPayment(f.db, { payment_id: pay, void_when_zero: true }, cashier);
  assert.equal(r.voided, true);
  assert.deepEqual(visitRefundedLines(f.db, { visit_id: f.vid }, registrar).line_ids, [f.vsA]);
  assert.throws(() => createInvoiceForVisit(f.db, { visit_id: f.vid, visit_service_ids: [f.vsA] }, registrar),
    (e) => e.status === 409);
});

test('I1: обычная отмена неоплаченного счёта строку возвращённой не делает', () => {
  const { db, vid } = seed();
  const a = addService(db, 'Приём', 100000);
  const vs = addLine(db, vid, { service_id: a, doctor_id: DOC, status: 'completed' });
  const out = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs] }, registrar);
  voidInvoice(db, { invoice_id: out.invoice.id }, cashier);
  assert.deepEqual(visitRefundedLines(db, { visit_id: vid }, registrar).line_ids, []);
  assert.equal(createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs] }, registrar).invoice.total_amount, 100000);
});

test('I1: visit_refunded_lines — RPC чтения, зарегистрирован', () => {
  assert.equal(typeof RPC.visit_refunded_lines, 'function');
  assert.equal(isReadOnlyRpc('visit_refunded_lines'), true);
  const { db } = seed();
  assert.throws(() => visitRefundedLines(db, { visit_id: 'x' }, registrar), (e) => e.status === 400);
});

// ─── I2 ─────────────────────────────────────────────────────────────────────
// Карта на 100 000; услугой потрачено 60 000; остаток 40 000 вернули
// покупателю — карта выключена. Потом пациенту вернули и саму услугу.
function deadCard() {
  const s = seed();
  const card = sellCard(s.db, { kind: 'gift_card', amount: 100000, method: 'cash', patient_id: s.pid }, cashier).card;
  const svc = addService(s.db, 'УЗИ', 60000);
  const vs = addLine(s.db, s.vid, { service_id: svc });
  const out = createInvoiceForVisit(s.db, { visit_id: s.vid, visit_service_ids: [vs] }, registrar);
  recordPayment(s.db, { invoice_id: out.invoice.id, amount: 60000, method: 'gift_card', card_id: card.id }, cashier);
  const back = refundCardSale(s.db, { card_id: card.id }, cashier);
  assert.equal(back.refunded, 40000);
  const pay = s.db.prepare("SELECT id FROM payments WHERE invoice_id = ? AND method = 'gift_card'").get(out.invoice.id).id;
  return { ...s, card, vs, invoice: out.invoice, pay, item: itemOf(s.db, vs) };
}
const cardRow = (db, id) => db.prepare('SELECT * FROM patient_discounts WHERE id = ?').get(id);

test('I2: возврат услуги на карту, чей остаток уже вернули, — отказ; деньги на мёртвую карту не уходят', () => {
  const f = deadCard();
  assert.throws(() => refundInvoiceLine(f.db, { invoice_item_id: f.item }, cashier),
    (e) => e.status === 409 && /Остаток карты «.*» уже возвращён покупателю/.test(e.message) && /на баланс/.test(e.message));
  assert.throws(() => refundPayment(f.db, { payment_id: f.pay }, cashier), (e) => e.status === 409);
  assert.equal(cardRow(f.db, f.card.id).remaining, 0, 'на выключенную карту ничего не легло');
  assert.equal(inv(f.db, f.invoice.id).paid_amount, 60000, 'транзакция откатилась целиком');
});

test('I2: такой возврат — деньгами из кассы по явному выбору', () => {
  const f = deadCard();
  const r = refundInvoiceLine(f.db, { invoice_item_id: f.item, card_fallback: 'cash' }, cashier);
  assert.equal(r.refunded, 60000);
  const back = f.db.prepare('SELECT * FROM payments WHERE invoice_id = ? AND amount < 0').get(f.invoice.id);
  assert.equal(back.method, 'cash');
  assert.equal(back.amount, -60000);
  assert.equal(cardRow(f.db, f.card.id).remaining, 0);
});

test('I2: такой возврат — на баланс пациента по явному выбору (и через refund_payment)', () => {
  const f = deadCard();
  refundPayment(f.db, { payment_id: f.pay, card_fallback: 'balance' }, cashier);
  assert.equal(walletBalance(f.db, f.pid), 60000);
  assert.equal(f.db.prepare('SELECT method FROM payments WHERE invoice_id = ? AND amount < 0').get(f.invoice.id).method, 'wallet');
  assert.equal(cardRow(f.db, f.card.id).remaining, 0);
  assert.throws(() => refundPayment(f.db, { payment_id: f.pay, card_fallback: 'bogus' }, cashier));
});

test('I2: живая карта — возврат по-прежнему на ту же карту, card_fallback не мешает', () => {
  const s = seed();
  const card = sellCard(s.db, { kind: 'gift_card', amount: 100000, method: 'cash', patient_id: s.pid }, cashier).card;
  const svc = addService(s.db, 'УЗИ', 60000);
  const vs = addLine(s.db, s.vid, { service_id: svc });
  const out = createInvoiceForVisit(s.db, { visit_id: s.vid, visit_service_ids: [vs] }, registrar);
  recordPayment(s.db, { invoice_id: out.invoice.id, amount: 60000, method: 'gift_card', card_id: card.id }, cashier);
  refundInvoiceLine(s.db, { invoice_item_id: itemOf(s.db, vs), card_fallback: 'cash' }, cashier);
  assert.equal(cardRow(s.db, card.id).remaining, 100000);
  assert.equal(s.db.prepare('SELECT method FROM payments WHERE invoice_id = ? AND amount < 0').get(out.invoice.id).method, 'gift_card');
});

// ─── M2 ─────────────────────────────────────────────────────────────────────
// Приём 100 000 + бесплатная услуга (не начата); оплачено 100 000; приём вернули.
function withFreeSibling() {
  const s = seed();
  const a = addService(s.db, 'Приём', 100000);
  const free = addService(s.db, 'Осмотр (бесплатно)', 0);
  const vsA = addLine(s.db, s.vid, { service_id: a });
  const vsF = addLine(s.db, s.vid, { service_id: free });
  const out = createInvoiceForVisit(s.db, { visit_id: s.vid, visit_service_ids: [vsA, vsF] }, registrar);
  recordPayment(s.db, { invoice_id: out.invoice.id, amount: 100000, method: 'cash' }, cashier);
  return { ...s, vsA, vsF, invoice: out.invoice };
}

test('M2: остались только бесплатные строки — счёт не отменяется, бесплатная услуга остаётся в счёте', () => {
  const f = withFreeSibling();
  const r = refundInvoiceLine(f.db, { invoice_item_id: itemOf(f.db, f.vsA) }, cashier);
  assert.equal(r.refunded, 100000);
  assert.equal(r.voided, false);
  const after = inv(f.db, f.invoice.id);
  assert.equal(after.status, 'paid', 'счёт на ноль — расчёт закрыт, как бесплатный при выставлении');
  assert.equal(after.total_amount, 0);
  assert.equal(after.paid_amount, 0);
  const free = f.db.prepare('SELECT invoice_item_id FROM visit_services WHERE id = ?').get(f.vsF);
  assert.ok(free, 'бесплатная услуга снята с визита');
  assert.ok(free.invoice_item_id, 'бесплатная услуга отпущена со счёта');
});

test('M2: то же с void_when_zero:false — счёт не висит «не оплачен» на нуле', () => {
  const f = withFreeSibling();
  refundInvoiceLine(f.db, { invoice_item_id: itemOf(f.db, f.vsA), void_when_zero: false }, cashier);
  assert.equal(inv(f.db, f.invoice.id).status, 'paid');
});

// ─── M5 ─────────────────────────────────────────────────────────────────────
test('M5: замена консультации на услугу снимает со строки вид приёма', () => {
  const { db, vid } = seed();
  const ct = db.prepare("INSERT INTO consultation_types (name, price) VALUES ('Первичный', 90000)").run().lastInsertRowid;
  const svc = addService(db, 'УЗИ', 120000);
  const vs = addLine(db, vid, { service_id: null, consultation_type_id: ct, doctor_id: DOC });
  createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs] }, registrar);
  const res = changeUnpaidService(db, { visit_service_id: vs, new_service_id: svc }, registrar);
  assert.equal(res.line.service_id, svc);
  assert.equal(res.line.consultation_type_id, null, 'строка услуги с видом приёма — химера');
  assert.equal(res.invoice.total_amount, 120000);
});
