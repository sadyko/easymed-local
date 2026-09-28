// CASHIER_PAID_SWAP_V1 (2026-09-28) — замена услуги и врача в ОПЛАЧЕННОМ счёте
// с расчётом разницы, и «Возвраты и отмены» в кассе.
//
// Владелец: «Refunded bills in the cashier window disappear completely, so we
// need to see them somewhere so we can change the service. Or paid bills: we
// cannot change the service — [we need to] make a refund or bill more if the
// price is different.»
//
// Всё — через настоящие RPC (карта index.js) и SQLite после миграций; одна
// проверка — через HTTP (createApp).
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { RPC } from './index.js';
import { createInvoiceForVisit, recordPayment, recordPaymentSplit, refundPayment } from './billing.js';
import { openCashShift, shiftReport, voidInvoice } from './cashier.js';
import { createDeposit, acceptDeposit } from './deposits.js';
import { sellCard } from './card-sales.js';
import { doctorPaySummary, runReport } from './reports.js';
import { walletBalance } from '../domain/wallet.js';
import { isReadOnlyRpc } from '../control/gate.js';
import { hashPassword } from '../auth.js';
import { createApp } from '../../app.js';
import { licensedDataDir } from '../control/licensed-fixture.js';
import { listen } from '../../../control-plane/server/test-helpers/listen.js';

const admin = { id: 1, role: 'admin', full_name: 'Админ' };
const registrar = { id: 7, role: 'registrar', full_name: 'Регистратор' };
const cashier = { id: 9, role: 'cashier', full_name: 'Кассир' };
const plain = { id: 10, role: 'cashier', full_name: 'Кассир без права' };
const head = { id: 11, role: 'cashier', extra_roles: ['head_cashier'], full_name: 'Старший кассир' };
const DOC = 20, DOC2 = 21;
const DAY = '2026-09-10T05:00:00Z';
const FROM = '2026-09-01', TO = '2026-09-30';

function seed() {
  const db = openDb(':memory:'); migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, role, full_name, is_doctor, is_active, extra_roles) VALUES (?,?,?,?,?,?,1,?)');
  u.run(1, 'adm', hashPassword('password1'), 'admin', 'Админ', 0, '[]');
  u.run(7, 'reg', hashPassword('password1'), 'registrar', 'Регистратор', 0, '[]');
  u.run(9, 'cash', hashPassword('password1'), 'cashier', 'Кассир', 0, '[]');
  u.run(10, 'cash2', hashPassword('password1'), 'cashier', 'Кассир без права', 0, '[]');
  u.run(11, 'head', hashPassword('password1'), 'cashier', 'Старший кассир', 0, '["head_cashier"]');
  u.run(DOC, 'doc', 'x', 'doctor', 'Врач Первый', 1, '[]');
  u.run(DOC2, 'doc2', 'x', 'doctor', 'Врач Второй', 1, '[]');
  return db;
}
const svc = (db, name, price, extra = {}) => {
  const cols = ['name', 'price', ...Object.keys(extra)];
  return Number(db.prepare(`INSERT INTO services (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(name, price, ...Object.values(extra)).lastInsertRowid);
};
const rates = (db, userId, list) => db.prepare('UPDATE users SET service_rates = ? WHERE id = ?').run(JSON.stringify(list), userId);
function grant(db, role, grants) {
  const row = db.prepare('SELECT permissions FROM role_permissions WHERE role = ?').get(role);
  const perms = row && row.permissions ? JSON.parse(row.permissions) : { sections: [], levels: {} };
  perms.grants = { ...(perms.grants || {}), ...grants };
  if (row) db.prepare('UPDATE role_permissions SET permissions = ? WHERE role = ?').run(JSON.stringify(perms), role);
  else db.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?)').run(role, JSON.stringify(perms));
}
const inv = (db, id) => db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
const vsRow = (db, id) => db.prepare('SELECT * FROM visit_services WHERE id = ?').get(id);
const pays = (db, invoiceId) => db.prepare('SELECT id, amount, method, notes, shift_id, cashier_id FROM payments WHERE invoice_id = ? ORDER BY id').all(invoiceId);
const call = (name, db, args, user) => RPC[name](db, args, user);
const refused = (fn, re = /./, status = 403) => assert.throws(fn, (e) => e.status === status && re.test(e.message));

// Клиника: приём 100 000 (у DOC своя цена 150 000 и 10 %, у DOC2 — 120 000 и
// 20 %), УЗИ 80 000 (процедура, личных цен нет), КТ 200 000 (процедура).
// Право кассы «Исправляет услуги в счёте» выдано роли «Кассир».
function clinic() {
  const db = seed();
  const CONS = svc(db, 'Приём терапевта', 100000);
  const USG = svc(db, 'УЗИ', 80000, { type: 'procedure' });
  const CT = svc(db, 'КТ', 200000, { type: 'procedure' });
  rates(db, DOC, [{ service_id: CONS, price: 150000, pct: 10 }, { service_id: USG, pct: 10 }, { service_id: CT, pct: 10 }]);
  rates(db, DOC2, [{ service_id: CONS, price: 120000, pct: 20 }, { service_id: USG, pct: 20 }, { service_id: CT, pct: 20 }]);
  grant(db, 'cashier', { 'cashier.lines': 'edit' });
  openCashShift(db, { opening_float: 0 }, cashier);
  const pid = Number(db.prepare("INSERT INTO patients (full_name) VALUES ('Пациент')").run().lastInsertRowid);
  return { db, CONS, USG, CT, pid };
}
function billed(db, pid, serviceId, doctorId, { at = DAY } = {}) {
  const vid = Number(db.prepare('INSERT INTO visits (patient_id, visit_date) VALUES (?, ?)').run(pid, at).lastInsertRowid);
  const vs = Number(db.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status) VALUES (?, ?, ?, 1, 0, 0, 'added')")
    .run(vid, serviceId, doctorId).lastInsertRowid);
  const invoice = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs] }, registrar).invoice;
  return { vid, vs, invoiceId: invoice.id, invoice };
}

// ─── Дешевле: разница возвращается сразу, тем же способом ───────────────────

test('дешевле: разница возвращается сразу наличными, счёт остаётся оплаченным, смена и журнал', () => {
  const { db, pid, CONS, USG } = clinic();
  const { vs, invoiceId } = billed(db, pid, CONS, DOC);
  recordPayment(db, { invoice_id: invoiceId, amount: 150000, method: 'cash' }, cashier);
  const r = call('cashier_line_swap_paid', db, { visit_service_id: vs, new_service_id: USG }, cashier);
  assert.equal(r.refunded, 70000);
  assert.equal(r.due, 0);
  assert.deepEqual(r.refund_plan.map((x) => [x.method, x.amount]), [['cash', 70000]]);
  const i = inv(db, invoiceId);
  assert.deepEqual([i.total_amount, i.paid_amount, i.status], [80000, 80000, 'paid']);
  const line = vsRow(db, vs);
  assert.equal(line.service_id, USG);
  assert.equal(line.unit_price, 80000);
  assert.equal(line.status, 'queued');
  assert.ok(line.queue_no != null, 'номер очереди выдан заново');
  const neg = pays(db, invoiceId).filter((p) => p.amount < 0);
  assert.equal(neg.length, 1);
  assert.equal(neg[0].amount, -70000);
  assert.equal(neg[0].method, 'cash');
  assert.match(neg[0].notes, /^REFUND#\d+ SWAP#\d+ — Замена услуги — возврат разницы/);
  // Смена: наличные за вычетом возврата.
  const rep = shiftReport(db, {}, cashier);
  assert.equal(rep.totals.cash, 80000);
  assert.equal(rep.expected_drawer, 80000);
  const log = db.prepare("SELECT * FROM invoice_audit_log WHERE action = 'line_swap_paid'").all();
  assert.equal(log.length, 1);
  assert.equal(log[0].refund_amount, 70000);
  assert.equal(log[0].amount, 80000);
  assert.equal(log[0].actor_user_id, cashier.id);
  assert.match(log[0].notes, /Приём терапевта.*→.*УЗИ.*возвращено 70 000/);
});

test('дешевле при раздельной оплате: возврат с последнего платежа, каждый своим способом', () => {
  const { db, pid, CONS, USG } = clinic();
  const { vs, invoiceId } = billed(db, pid, CONS, DOC);
  recordPaymentSplit(db, { invoice_id: invoiceId, tenders: [{ method: 'cash', amount: 100000 }, { method: 'card', amount: 50000 }] }, cashier);
  const r = call('cashier_line_swap_paid', db, { visit_service_id: vs, new_service_id: USG }, cashier);
  assert.equal(r.refunded, 70000);
  const neg = pays(db, invoiceId).filter((p) => p.amount < 0).map((p) => [p.method, p.amount]);
  assert.deepEqual(neg, [['card', -50000], ['cash', -20000]]);
  assert.equal(inv(db, invoiceId).paid_amount, 80000);
});

test('с баланса — на баланс; кассир может отправить всю разницу на баланс пациента', () => {
  const { db, pid, CONS, USG } = clinic();
  const { deposit } = createDeposit(db, { patient_id: pid, amount: 150000 }, registrar);
  acceptDeposit(db, { deposit_id: deposit.id, method: 'cash' }, cashier);
  const a = billed(db, pid, CONS, DOC);
  recordPayment(db, { invoice_id: a.invoiceId, amount: 150000, method: 'wallet' }, cashier);
  assert.equal(walletBalance(db, pid), 0);
  call('cashier_line_swap_paid', db, { visit_service_id: a.vs, new_service_id: USG }, cashier);
  assert.equal(walletBalance(db, pid), 70000, 'оплата с баланса вернулась на баланс');
  assert.equal(pays(db, a.invoiceId).filter((p) => p.amount < 0)[0].method, 'wallet');

  // Наличная оплата, кассир выбрал «на баланс пациента»: из ящика ничего не выходит.
  const b = billed(db, pid, CONS, DOC);
  recordPayment(db, { invoice_id: b.invoiceId, amount: 150000, method: 'cash' }, cashier);
  const drawer = shiftReport(db, {}, cashier).expected_drawer;
  const r = call('cashier_line_swap_paid', db, { visit_service_id: b.vs, new_service_id: USG, to_balance: true }, cashier);
  assert.equal(r.to_balance, true);
  assert.equal(walletBalance(db, pid), 140000);
  assert.equal(shiftReport(db, {}, cashier).expected_drawer, drawer, 'наличные из кассы не выданы');
});

test('подарочная карта — разница возвращается на ту же карту', () => {
  const { db, pid, CONS, USG } = clinic();
  const buyer = Number(db.prepare("INSERT INTO patients (full_name) VALUES ('Покупатель')").run().lastInsertRowid);
  const sold = sellCard(db, { kind: 'gift_card', amount: 300000, method: 'cash', patient_id: buyer }, cashier);
  const { vs, invoiceId } = billed(db, pid, CONS, DOC);
  recordPayment(db, { invoice_id: invoiceId, amount: 150000, method: 'gift_card', card_id: sold.card.id }, cashier);
  const remain = () => db.prepare('SELECT remaining FROM patient_discounts WHERE id = ?').get(sold.card.id).remaining;
  assert.equal(remain(), 150000);
  const r = call('cashier_line_swap_paid', db, { visit_service_id: vs, new_service_id: USG }, cashier);
  assert.equal(r.refunded, 70000);
  assert.equal(remain(), 220000);
  assert.equal(pays(db, invoiceId).filter((p) => p.amount < 0)[0].method, 'gift_card');
});

// ─── Дороже: счёт «частично», разница к доплате ─────────────────────────────

test('дороже: счёт частично оплачен с точной разницей, доплата его закрывает', () => {
  const { db, pid, CONS, CT } = clinic();
  const { vs, invoiceId } = billed(db, pid, CONS, DOC2);
  recordPayment(db, { invoice_id: invoiceId, amount: 120000, method: 'cash' }, cashier);
  const r = call('cashier_line_swap_paid', db, { visit_service_id: vs, new_service_id: CT }, cashier);
  assert.equal(r.refunded, 0);
  assert.equal(r.due, 80000);
  const i = inv(db, invoiceId);
  assert.deepEqual([i.total_amount, i.paid_amount, i.status], [200000, 120000, 'partial']);
  assert.equal(pays(db, invoiceId).filter((p) => p.amount < 0).length, 0, 'денег никто не возвращал');
  assert.equal(vsRow(db, vs).status, 'queued', 'частично оплаченный счёт работу не останавливает');
  recordPayment(db, { invoice_id: invoiceId, amount: 80000, method: 'card' }, cashier);
  assert.equal(inv(db, invoiceId).status, 'paid');
});

test('та же сумма — деньги не двигаются', () => {
  const { db, pid, CONS } = clinic();
  const EQ = svc(db, 'Осмотр', 150000, { type: 'procedure' });
  const { vs, invoiceId } = billed(db, pid, CONS, DOC);
  recordPayment(db, { invoice_id: invoiceId, amount: 150000, method: 'cash' }, cashier);
  const r = call('cashier_line_swap_paid', db, { visit_service_id: vs, new_service_id: EQ }, cashier);
  assert.deepEqual([r.refunded, r.due], [0, 0]);
  assert.equal(pays(db, invoiceId).length, 1);
  assert.equal(inv(db, invoiceId).status, 'paid');
});

// ─── Доля врача идёт за новой услугой и новым врачом ────────────────────────

test('смена врача в оплаченном счёте: разница вернулась, доля — новому врачу, три отчёта сходятся', () => {
  const { db, pid, CONS } = clinic();
  const { vs, invoiceId } = billed(db, pid, CONS, DOC);
  recordPayment(db, { invoice_id: invoiceId, amount: 150000, method: 'cash' }, cashier);
  const r = call('cashier_line_swap_paid', db, { visit_service_id: vs, doctor_id: DOC2 }, cashier);
  assert.equal(r.refunded, 30000);
  assert.equal(vsRow(db, vs).doctor_id, DOC2);
  assert.equal(vsRow(db, vs).unit_price, 120000);
  db.prepare("UPDATE visit_services SET status = 'completed' WHERE id = ?").run(vs);
  const s2 = doctorPaySummary(db, { doctor_id: DOC2, from: FROM, to: TO }, admin);
  assert.equal(s2.outpatient.fee, 24000, '20 % от 120 000 — возврат разницы долю не режет');
  assert.equal(doctorPaySummary(db, { doctor_id: DOC, from: FROM, to: TO }, admin).lines.length, 0);
  const rows = (kind) => {
    const rep = runReport(db, { kind, from: FROM, to: TO }, admin);
    return rep.rows.map((row) => Object.fromEntries(rep.columns.map((c, k) => [c, row[k]])));
  };
  const bd = rows('by_doctors').find((o) => o['Врач'] === 'Врач Второй');
  assert.equal(bd['Доля за услуги'] + bd['Стационарная доля'], 24000);
  assert.equal(rows('doctor_salaries').find((o) => o['Врач'] === 'Врач Второй')['Итого к выплате'], 24000);
  assert.ok(!db.prepare('SELECT 1 FROM pay_refund_releases WHERE line_id = ?').get(vs), 'строка не отпущена с возвратом');
});

// ─── Кэшбэк ─────────────────────────────────────────────────────────────────

test('кэшбэк: возврат разницы откатывает его в той же доле; доплата второй раз не начисляет', () => {
  const { db, pid, CONS, USG, CT } = clinic();
  db.prepare("INSERT INTO cashback_rules (name, percent, active) VALUES ('Всем', 10, 1)").run();
  const cb = (invoiceId) => db.prepare("SELECT * FROM patient_deposits WHERE kind = 'cashback' AND invoice_id = ?").all(invoiceId);
  const a = billed(db, pid, CONS, DOC);
  recordPayment(db, { invoice_id: a.invoiceId, amount: 150000, method: 'cash' }, cashier);
  assert.equal(cb(a.invoiceId)[0].amount, 15000);
  call('cashier_line_swap_paid', db, { visit_service_id: a.vs, new_service_id: USG }, cashier);
  const row = cb(a.invoiceId)[0];
  assert.equal(row.amount - (row.refund_amount || 0), 8000, 'кэшбэк следует за оставшимися 80 000');

  const b = billed(db, pid, CONS, DOC2);
  recordPayment(db, { invoice_id: b.invoiceId, amount: 120000, method: 'cash' }, cashier);
  assert.equal(cb(b.invoiceId)[0].amount, 12000);
  call('cashier_line_swap_paid', db, { visit_service_id: b.vs, new_service_id: CT }, cashier);
  recordPayment(db, { invoice_id: b.invoiceId, amount: 80000, method: 'cash' }, cashier);
  assert.equal(cb(b.invoiceId).length, 1, 'счёт оценивается один раз');
  assert.equal(cb(b.invoiceId)[0].amount, 12000);
});

// ─── Скидка после продажи ───────────────────────────────────────────────────

test('скидка после продажи ложится снова в той же доле', () => {
  const { db, pid, CONS, USG } = clinic();
  const BIG = svc(db, 'Консультация профессора', 140000, { type: 'procedure' });
  const { vs, invoiceId } = billed(db, pid, BIG, DOC);
  recordPayment(db, { invoice_id: invoiceId, amount: 140000, method: 'cash' }, cashier);
  const p = pays(db, invoiceId)[0];
  refundPayment(db, { payment_id: p.id, amount: 40000, reason: 'уступка' }, cashier);
  assert.deepEqual([inv(db, invoiceId).total_amount, inv(db, invoiceId).post_sale_discount], [100000, 40000]);
  db.prepare('UPDATE services SET price = 70000 WHERE id = ?').run(USG);
  const r = call('cashier_line_swap_paid', db, { visit_service_id: vs, new_service_id: USG }, cashier);
  const i = inv(db, invoiceId);
  assert.equal(i.post_sale_discount, 20000, '40 000 × 70/140');
  assert.equal(i.total_amount, 50000);
  assert.equal(i.paid_amount, 50000);
  assert.equal(r.refunded, 50000);
  void CONS;
});

// ─── Отказы ────────────────────────────────────────────────────────────────

test('отказы: регистратура (деньги), кассир без права, начатая работа, закрытый месяц, плательщик, неоплаченный счёт', () => {
  const { db, pid, CONS, USG } = clinic();
  const { vs, invoiceId } = billed(db, pid, CONS, DOC);
  recordPayment(db, { invoice_id: invoiceId, amount: 150000, method: 'cash' }, cashier);
  refused(() => call('cashier_line_swap_paid', db, { visit_service_id: vs, new_service_id: USG }, registrar), /касса/);
  grant(db, 'cashier', { 'cashier.lines': 'none' });   // касса «только принимает оплату»
  refused(() => call('cashier_line_swap_paid', db, { visit_service_id: vs, new_service_id: USG }, cashier), /Исправлять услуги в счёте/);
  grant(db, 'cashier', { 'cashier.lines': 'edit' });
  db.prepare("UPDATE visit_services SET status = 'in_progress' WHERE id = ?").run(vs);
  refused(() => call('cashier_line_swap_paid', db, { visit_service_id: vs, new_service_id: USG }, cashier), /оказывается/, 400);
  db.prepare("UPDATE visit_services SET status = 'queued' WHERE id = ?").run(vs);
  db.prepare("INSERT INTO pay_periods (month, closed_by, total, lines) VALUES ('2026-09', 1, 0, 0)").run();
  refused(() => call('cashier_line_swap_paid', db, { visit_service_id: vs, new_service_id: USG }, cashier), /месяц/, 409);
  db.prepare("DELETE FROM pay_periods").run();
  // Плательщик.
  const payer = Number(db.prepare("INSERT INTO payers (name, kind, active) VALUES ('Страховая', 'insurance', 1)").run().lastInsertRowid);
  const vid2 = Number(db.prepare('INSERT INTO visits (patient_id, visit_date) VALUES (?, ?)').run(pid, DAY).lastInsertRowid);
  const l2 = Number(db.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status) VALUES (?, ?, ?, 1, 0, 0, 'added')").run(vid2, CONS, DOC).lastInsertRowid);
  createInvoiceForVisit(db, { visit_id: vid2, visit_service_ids: [l2], payer_id: payer }, registrar);
  refused(() => call('cashier_line_swap_paid', db, { visit_service_id: l2, new_service_id: USG }, cashier), /плательщик/, 400);
  // Неоплаченный — обычной правкой.
  const c = billed(db, pid, CONS, DOC);
  refused(() => call('cashier_line_swap_paid', db, { visit_service_id: c.vs, new_service_id: USG }, cashier), /не принято денег/, 400);
  assert.equal(inv(db, invoiceId).total_amount, 150000, 'отказы ничего не тронули');
});

test('ключ повтора: повтор той же формы ничего не возвращает второй раз; другая форма — 409', () => {
  const { db, pid, CONS, USG, CT } = clinic();
  const { vs, invoiceId } = billed(db, pid, CONS, DOC);
  recordPayment(db, { invoice_id: invoiceId, amount: 150000, method: 'cash' }, cashier);
  const args = { visit_service_id: vs, new_service_id: USG, idempotency_key: 'k-swap-paid-00001' };
  const a = call('cashier_line_swap_paid', db, args, cashier);
  const b = call('cashier_line_swap_paid', db, args, cashier);
  assert.equal(b.repeated, true);
  assert.equal(b.refunded, a.refunded);
  assert.equal(pays(db, invoiceId).filter((p) => p.amount < 0).length, 1);
  assert.throws(() => call('cashier_line_swap_paid', db, { ...args, new_service_id: CT }, cashier), (e) => e.status === 409);
});

test('предпросмотр считает то же самое и ничего не записывает', () => {
  const { db, pid, CONS, USG } = clinic();
  const { vs, invoiceId } = billed(db, pid, CONS, DOC);
  recordPaymentSplit(db, { invoice_id: invoiceId, tenders: [{ method: 'cash', amount: 100000 }, { method: 'card', amount: 50000 }] }, cashier);
  const before = JSON.stringify([inv(db, invoiceId), vsRow(db, vs), pays(db, invoiceId), db.prepare('SELECT COUNT(*) n FROM invoice_audit_log').get()]);
  const q = call('cashier_line_swap_quote', db, { visit_service_id: vs, new_service_id: USG }, cashier);
  assert.equal(q.preview, true);
  assert.equal(q.refunded, 70000);
  assert.deepEqual(q.refund_plan.map((x) => [x.method, x.amount]), [['card', 50000], ['cash', 20000]]);
  assert.equal(q.total_before, 150000);
  assert.equal(q.total_after, 80000);
  assert.equal(JSON.stringify([inv(db, invoiceId), vsRow(db, vs), pays(db, invoiceId), db.prepare('SELECT COUNT(*) n FROM invoice_audit_log').get()]), before);
  refused(() => call('cashier_line_swap_quote', db, { visit_service_id: vs, new_service_id: USG }, registrar), /касса/);
});

test('старший кассир — через HTTP, сессия с надстройкой', async () => {
  const { db, pid, CONS, USG } = clinic();
  const { vs, invoiceId } = billed(db, pid, CONS, DOC);
  recordPayment(db, { invoice_id: invoiceId, amount: 150000, method: 'cash' }, cashier);
  const server = await listen(createApp(db, { dataDir: licensedDataDir() }));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'head', password: 'password1' }) });
    const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    const res = await fetch(base + '/api/rpc/cashier_line_swap_paid', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ visit_service_id: vs, new_service_id: USG }) });
    assert.equal(res.status, 200);
    assert.equal(inv(db, invoiceId).total_amount, 80000);
  } finally { server.close(); db.close(); }
});

// ─── «Возвраты и отмены» ───────────────────────────────────────────────────

test('«Возвраты и отмены»: замена с возвратом, возврат услуги, отмена с оставленными услугами; кто видит', () => {
  const { db, pid, CONS, USG } = clinic();
  const today = db.prepare("SELECT date('now', 'localtime') d").get().d;
  // 1. Замена с возвратом разницы.
  const a = billed(db, pid, CONS, DOC);
  recordPayment(db, { invoice_id: a.invoiceId, amount: 150000, method: 'cash' }, cashier);
  call('cashier_line_swap_paid', db, { visit_service_id: a.vs, new_service_id: USG }, cashier);
  // 2. Возврат услуги строкой (последняя строка — счёт отменён).
  const b = billed(db, pid, CONS, DOC);
  recordPayment(db, { invoice_id: b.invoiceId, amount: 150000, method: 'card' }, cashier);
  const item = db.prepare('SELECT id FROM invoice_items WHERE invoice_id = ?').get(b.invoiceId).id;
  call('refund_invoice_line', db, { invoice_item_id: item, reason: 'передумал' }, cashier);
  // 3. Отмена неоплаченного счёта с «Оставить услуги» — строки ждут нового счёта.
  const c = billed(db, pid, CONS, DOC);
  voidInvoice(db, { invoice_id: c.invoiceId, keep_services: true, reason: 'другой врач' }, cashier);
  // 4. Отмена без услуг — только история.
  const d = billed(db, pid, CONS, DOC);
  voidInvoice(db, { invoice_id: d.invoiceId, reason: 'ошибка' }, cashier);
  // Счёт без возвратов в список не попадает.
  const e = billed(db, pid, CONS, DOC);
  recordPayment(db, { invoice_id: e.invoiceId, amount: 150000, method: 'cash' }, cashier);

  const out = call('cashier_refunds', db, { from: today, to: today }, plain);
  const byId = new Map(out.rows.map((r) => [r.invoice_id, r]));
  assert.ok(!byId.has(e.invoiceId));
  const ra = byId.get(a.invoiceId);
  assert.equal(ra.status, 'paid');
  assert.equal(ra.refunded_total, 70000);
  assert.equal(ra.refunds[0].kind, 'swap');
  assert.equal(ra.refunds[0].method, 'cash');
  assert.equal(ra.refunds[0].who, 'Кассир');
  assert.match(ra.refunds[0].reason, /Замена услуги/);
  const rb = byId.get(b.invoiceId);
  assert.equal(rb.status, 'void');
  assert.equal(rb.refunds[0].kind, 'line');
  assert.equal(rb.refunds[0].method, 'card');
  assert.match(rb.refunds[0].reason, /передумал/);
  const rc = byId.get(c.invoiceId);
  assert.equal(rc.status, 'void');
  assert.equal(rc.can_rebill, true);
  assert.equal(rc.rebill_lines.length, 1);
  assert.ok(rc.events.some((ev) => ev.action === 'void' && /другой врач/.test(ev.reason || '')));
  const rd = byId.get(d.invoiceId);
  assert.equal(rd.can_rebill, false, 'строки сняты с визита — только история');
  assert.ok(out.totals.n >= 4);
  assert.equal(out.totals.refunded, 70000 + 150000);
  // Вчера — пусто.
  const y = db.prepare("SELECT date('now', 'localtime', '-1 day') d").get().d;
  assert.equal(call('cashier_refunds', db, { from: y, to: y }, cashier).rows.length, 0);
  refused(() => call('cashier_refunds', db, { from: today, to: today }, registrar));
  assert.equal(isReadOnlyRpc('cashier_refunds'), true);
  assert.ok(call('cashier_refunds', db, {}, head).rows.length >= 4, 'по умолчанию — сегодня');
});

test('«Выставить заново»: отменённые строки меняют услугу и выставляются новым счётом', () => {
  const { db, pid, CONS, USG } = clinic();
  const c = billed(db, pid, CONS, DOC);
  recordPayment(db, { invoice_id: c.invoiceId, amount: 150000, method: 'cash' }, cashier);
  const p = pays(db, c.invoiceId)[0];
  // Полный возврат, счёт отменён, услуги оставлены в визите.
  refundPayment(db, { payment_id: p.id, reason: 'не тот врач', keep_services: true }, cashier);
  assert.equal(inv(db, c.invoiceId).status, 'void');
  assert.equal(vsRow(db, c.vs).invoice_item_id, null);
  // Кассир меняет услугу у невыставленной строки и выставляет её заново.
  call('cashier_line_change_service', db, { visit_service_id: c.vs, new_service_id: USG }, cashier);
  const created = call('create_invoice_for_visit', db, { visit_id: c.vid, visit_service_ids: [c.vs], rebill_refunded: true }, cashier);
  assert.equal(created.invoice.total_amount, 80000);
  recordPayment(db, { invoice_id: created.invoice.id, amount: 80000, method: 'cash' }, cashier);
  assert.equal(inv(db, created.invoice.id).status, 'paid');
});
