// REFUND_SWAP_V1 (2026-10-29) — замена оплаченной услуги: исполнитель новой
// услуги, талон прежней очереди, отказ «работа начата» с кодом, описание права.
//
// Спецификация 3.19.0, раздел 1: замена услуги без смены врача не проверяла,
// подходит ли врач новой услуге (billing.js swapPaidLineTx), и не удаляла
// строку талона очереди (service_queue_tickets), как это делает возврат
// услуги. Окно замены в «Платежах» выбирает услугу и исполнителя вместе
// («Без врача» — no_doctor) и по коду line_performed узнаёт начатую работу.
//
// Всё — через настоящие RPC (карта index.js) и SQLite после миграций. После
// каждой денежной операции сумма платежей счёта равна «оплачено» по счёту.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { RPC } from './index.js';
import { createInvoiceForVisit, recordPayment } from './billing.js';
import { openCashShift, shiftReport } from './cashier.js';
import { createDeposit, acceptDeposit } from './deposits.js';
import { walletBalance } from '../domain/wallet.js';
import { catalogByKey } from '../../../public/js/shared/permission-catalog.js';

const registrar = { id: 7, role: 'registrar', full_name: 'Регистратор' };
const cashier = { id: 9, role: 'cashier', full_name: 'Кассир' };
const DOC = 20, DOC2 = 21, NURSE = 22;
const DAY = '2026-09-10T05:00:00Z';

function seed() {
  const db = openDb(':memory:'); migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, role, full_name, is_doctor, is_active, extra_roles) VALUES (?,?,?,?,?,?,1,?)');
  u.run(1, 'adm', 'x', 'admin', 'Админ', 0, '[]');
  u.run(7, 'reg', 'x', 'registrar', 'Регистратор', 0, '[]');
  u.run(9, 'cash', 'x', 'cashier', 'Кассир', 0, '[]');
  u.run(DOC, 'doc', 'x', 'doctor', 'Врач Первый', 1, '[]');
  u.run(DOC2, 'doc2', 'x', 'doctor', 'Врач Второй', 1, '[]');
  u.run(NURSE, 'nurse', 'x', 'nurse', 'Медсестра', 0, '[]');
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
const pays = (db, invoiceId) => db.prepare('SELECT id, amount, method, notes FROM payments WHERE invoice_id = ? ORDER BY id').all(invoiceId);
const call = (name, db, args, user) => RPC[name](db, args, user);
const refused = (fn, re = /./, status = 403) => assert.throws(fn, (e) => e.status === status && re.test(e.message));
const refusedCode = (fn, code) => assert.throws(fn, (e) => e.status === 400 && e.code === code && /оказывается/.test(e.message));
const r2 = (n) => Math.round(Number(n) * 100) / 100;
// Правило денег: SUM(payments) по счёту == invoices.paid_amount.
function assertBalanced(db, invoiceId) {
  const s = db.prepare('SELECT COALESCE(SUM(amount), 0) s FROM payments WHERE invoice_id = ?').get(invoiceId).s;
  assert.equal(r2(s), r2(inv(db, invoiceId).paid_amount), 'сумма платежей = оплачено по счёту');
}

// Клиника: приём 100 000 (консультация; у DOC своя цена 150 000, у DOC2 —
// 120 000), УЗИ 80 000 и КТ 200 000 (процедуры), «Перевязка у хирурга»
// 50 000 (процедура, нужен врач). Право «Исправляет услуги в счёте» выдано
// роли «Кассир».
function clinic() {
  const db = seed();
  const CONS = svc(db, 'Приём терапевта', 100000);
  const USG = svc(db, 'УЗИ', 80000, { type: 'procedure' });
  const CT = svc(db, 'КТ', 200000, { type: 'procedure' });
  const REQ = svc(db, 'Перевязка у хирурга', 50000, { type: 'procedure', requires_doctor: 1 });
  rates(db, DOC, [{ service_id: CONS, price: 150000, pct: 10 }, { service_id: USG, pct: 10 }, { service_id: CT, pct: 10 }]);
  rates(db, DOC2, [{ service_id: CONS, price: 120000, pct: 20 }, { service_id: USG, pct: 20 }, { service_id: CT, pct: 20 }]);
  grant(db, 'cashier', { 'cashier.lines': 'edit' });
  openCashShift(db, { opening_float: 0 }, cashier);
  const pid = Number(db.prepare("INSERT INTO patients (full_name) VALUES ('Пациент')").run().lastInsertRowid);
  return { db, CONS, USG, CT, REQ, pid };
}
function billed(db, pid, serviceId, doctorId) {
  const vid = Number(db.prepare('INSERT INTO visits (patient_id, visit_date) VALUES (?, ?)').run(pid, DAY).lastInsertRowid);
  const vs = Number(db.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status) VALUES (?, ?, ?, 1, 0, 0, 'added')")
    .run(vid, serviceId, doctorId).lastInsertRowid);
  const invoice = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs] }, registrar).invoice;
  return { vid, vs, invoiceId: invoice.id, invoice };
}
function paid(db, pid, serviceId, doctorId, method = 'cash') {
  const b = billed(db, pid, serviceId, doctorId);
  recordPayment(db, { invoice_id: b.invoiceId, amount: b.invoice.total_amount, method }, cashier);
  return b;
}

test('смена услуги: исполнитель должен подходить новой услуге — медсестра консультацию не проводит', () => {
  const { db, pid, CONS, USG } = clinic();
  const a = paid(db, pid, USG, NURSE);   // УЗИ у медсестры, 80 000 наличными
  const snap = () => JSON.stringify([inv(db, a.invoiceId), vsRow(db, a.vs), pays(db, a.invoiceId)]);
  const before = snap();
  // Врач не выбран — остаётся прежний исполнитель, и он новой услуге не подходит.
  refused(() => call('cashier_line_swap_paid', db, { visit_service_id: a.vs, new_service_id: CONS }, cashier), /Консультацию проводит врач/, 400);
  refused(() => call('cashier_line_swap_quote', db, { visit_service_id: a.vs, new_service_id: CONS }, cashier), /Консультацию проводит врач/, 400);
  refused(() => call('cashier_line_swap_paid', db, { visit_service_id: a.vs, new_service_id: CONS, doctor_id: NURSE }, cashier), /Консультацию проводит врач/, 400);
  assert.equal(snap(), before, 'отказ ничего не тронул');
  assertBalanced(db, a.invoiceId);
  const r = call('cashier_line_swap_paid', db, { visit_service_id: a.vs, new_service_id: CONS, doctor_id: DOC }, cashier);
  assert.deepEqual([r.refunded, r.due], [0, 70000], 'приём у врача со своей ценой 150 000');
  assert.equal(vsRow(db, a.vs).doctor_id, DOC);
  const i = inv(db, a.invoiceId);
  assert.deepEqual([i.total_amount, i.paid_amount, i.status], [150000, 80000, 'partial']);
  assertBalanced(db, a.invoiceId);
});

test('услуге нужен врач — без врача не заменить; «Без врача» — только когда врач не нужен и вместе с заменой услуги', () => {
  const { db, pid, CONS, USG, REQ } = clinic();
  // УЗИ без исполнителя, оплачено картой, → «Перевязка у хирурга» (нужен врач).
  const a = paid(db, pid, USG, null, 'card');
  refused(() => call('cashier_line_swap_paid', db, { visit_service_id: a.vs, new_service_id: REQ }, cashier), /нужен врач/, 400);
  refused(() => call('cashier_line_swap_paid', db, { visit_service_id: a.vs, new_service_id: REQ, no_doctor: true }, cashier), /нужен врач/, 400);
  assertBalanced(db, a.invoiceId);
  const r = call('cashier_line_swap_paid', db, { visit_service_id: a.vs, new_service_id: REQ, doctor_id: DOC }, cashier);
  assert.equal(r.refunded, 30000);
  assert.deepEqual(pays(db, a.invoiceId).filter((p) => p.amount < 0).map((p) => [p.method, p.amount]), [['card', -30000]]);
  assert.equal(vsRow(db, a.vs).doctor_id, DOC);
  assertBalanced(db, a.invoiceId);

  // Приём врача → УЗИ «Без врача»: исполнитель снят, разница наличными.
  const b = paid(db, pid, CONS, DOC);
  const rb = call('cashier_line_swap_paid', db, { visit_service_id: b.vs, new_service_id: USG, no_doctor: true }, cashier);
  assert.equal(rb.refunded, 70000);
  const lb = vsRow(db, b.vs);
  assert.deepEqual([lb.service_id, lb.doctor_id], [USG, null]);
  assert.match(String(lb.queue_key), /^proc:room:/, 'без врача — общая очередь процедур');
  assertBalanced(db, b.invoiceId);

  // «Без врача» и врач сразу; «Без врача» без смены услуги — отказ словами.
  const c = paid(db, pid, CONS, DOC);
  refused(() => call('cashier_line_swap_paid', db, { visit_service_id: c.vs, new_service_id: USG, doctor_id: DOC2, no_doctor: true }, cashier), /не то и другое/, 400);
  refused(() => call('cashier_line_swap_paid', db, { visit_service_id: c.vs, new_service_id: CONS, no_doctor: true }, cashier), /только вместе с заменой услуги/, 400);
  assert.equal(inv(db, c.invoiceId).total_amount, 150000);
  assertBalanced(db, c.invoiceId);
});

test('замена снимает талон очереди прежней услуги и врача; номер — в новой очереди; предпросмотр талон не трогает', () => {
  const { db, pid, CONS, USG } = clinic();
  const ticket = (b) => db.prepare('INSERT INTO service_queue_tickets (visit_service_id, visit_id, service_id, number, queue_key) VALUES (?, ?, ?, 7, ?)')
    .run(b.vs, b.vid, CONS, 'doc:' + DOC + ':2026-09-10');
  const tickets = (vsId) => db.prepare('SELECT COUNT(*) n FROM service_queue_tickets WHERE visit_service_id = ?').get(vsId).n;
  const a = paid(db, pid, CONS, DOC);
  ticket(a);
  call('cashier_line_swap_paid', db, { visit_service_id: a.vs, new_service_id: USG, doctor_id: DOC2 }, cashier);
  assert.equal(tickets(a.vs), 0, 'талон прежней услуги удалён');
  const line = vsRow(db, a.vs);
  assert.match(String(line.queue_key), new RegExp('^doc:' + DOC2 + ':'), 'номер — в очереди нового врача');
  assert.ok(line.queue_no != null);
  assertBalanced(db, a.invoiceId);
  // Смена одного врача — тоже другая очередь.
  const b = paid(db, pid, CONS, DOC, 'card');
  ticket(b);
  call('cashier_line_swap_paid', db, { visit_service_id: b.vs, doctor_id: DOC2 }, cashier);
  assert.equal(tickets(b.vs), 0);
  assertBalanced(db, b.invoiceId);
  const c = paid(db, pid, CONS, DOC);
  ticket(c);
  call('cashier_line_swap_quote', db, { visit_service_id: c.vs, new_service_id: USG, doctor_id: DOC2 }, cashier);
  assert.equal(tickets(c.vs), 1, 'предпросмотр ничего не записывает');
});

test('с баланса — на баланс; «на баланс пациента» по выбору — из ящика ничего', () => {
  const { db, pid, CONS, USG } = clinic();
  const { deposit } = createDeposit(db, { patient_id: pid, amount: 150000 }, registrar);
  acceptDeposit(db, { deposit_id: deposit.id, method: 'cash' }, cashier);
  const a = paid(db, pid, CONS, DOC, 'wallet');
  assert.equal(walletBalance(db, pid), 0);
  call('cashier_line_swap_paid', db, { visit_service_id: a.vs, new_service_id: USG, doctor_id: DOC2 }, cashier);
  assert.equal(walletBalance(db, pid), 70000);
  assert.equal(pays(db, a.invoiceId).filter((p) => p.amount < 0)[0].method, 'wallet');
  assertBalanced(db, a.invoiceId);
  const b = paid(db, pid, CONS, DOC);
  const drawer = shiftReport(db, {}, cashier).expected_drawer;
  const r = call('cashier_line_swap_paid', db, { visit_service_id: b.vs, new_service_id: USG, doctor_id: DOC2, to_balance: true, card_fallback: 'balance' }, cashier);
  assert.equal(r.to_balance, true);
  assert.equal(walletBalance(db, pid), 140000);
  assert.equal(shiftReport(db, {}, cashier).expected_drawer, drawer, 'наличные из кассы не выданы');
  assertBalanced(db, b.invoiceId);
});

test('кэшбэк: замена с новым исполнителем откатывает его в доле возвращённого', () => {
  const { db, pid, CONS, USG } = clinic();
  db.prepare("INSERT INTO cashback_rules (name, percent, active) VALUES ('Всем', 10, 1)").run();
  const cb = (invoiceId) => db.prepare("SELECT * FROM patient_deposits WHERE kind = 'cashback' AND invoice_id = ?").all(invoiceId);
  const a = paid(db, pid, CONS, DOC);
  assert.equal(cb(a.invoiceId)[0].amount, 15000);
  call('cashier_line_swap_paid', db, { visit_service_id: a.vs, new_service_id: USG, doctor_id: DOC2 }, cashier);
  const row = cb(a.invoiceId)[0];
  assert.equal(row.amount - (row.refund_amount || 0), 8000, 'кэшбэк следует за оставшимися 80 000');
  assertBalanced(db, a.invoiceId);
});

test('ключ повтора: замена с исполнителем по тому же ключу ничего не двигает второй раз; другая форма — 409', () => {
  const { db, pid, CONS, USG, CT } = clinic();
  const a = paid(db, pid, CONS, DOC);
  const args = { visit_service_id: a.vs, new_service_id: USG, doctor_id: DOC2, idempotency_key: 'k-refund-swap-0001' };
  const first = call('cashier_line_swap_paid', db, args, cashier);
  const again = call('cashier_line_swap_paid', db, args, cashier);
  assert.equal(again.repeated, true);
  assert.equal(again.refunded, first.refunded);
  assert.equal(pays(db, a.invoiceId).filter((p) => p.amount < 0).length, 1);
  assertBalanced(db, a.invoiceId);
  assert.throws(() => call('cashier_line_swap_paid', db, { ...args, new_service_id: CT }, cashier), (e) => e.status === 409);
  assertBalanced(db, a.invoiceId);
});

test('закрытый месяц начислений врачам — отказ 409, деньги и строка не тронуты', () => {
  const { db, pid, CONS, USG } = clinic();
  const a = paid(db, pid, CONS, DOC);
  db.prepare("INSERT INTO pay_periods (month, closed_by, total, lines) VALUES ('2026-09', 1, 0, 0)").run();
  const snap = () => JSON.stringify([inv(db, a.invoiceId), vsRow(db, a.vs), pays(db, a.invoiceId)]);
  const before = snap();
  refused(() => call('cashier_line_swap_paid', db, { visit_service_id: a.vs, new_service_id: USG, doctor_id: DOC2 }, cashier), /месяц/, 409);
  refused(() => call('cashier_line_swap_paid', db, { visit_service_id: a.vs, new_service_id: USG, no_doctor: true }, cashier), /месяц/, 409);
  assert.equal(snap(), before);
  assertBalanced(db, a.invoiceId);
});

test('работа начата — отказ замены с кодом line_performed (статус и след работы); другие двери — прежний отказ без кода', () => {
  const { db, pid, CONS, USG } = clinic();
  const a = paid(db, pid, CONS, DOC);
  db.prepare("UPDATE visit_services SET status = 'collected' WHERE id = ?").run(a.vs);
  refusedCode(() => call('cashier_line_swap_paid', db, { visit_service_id: a.vs, new_service_id: USG }, cashier), 'line_performed');
  refusedCode(() => call('cashier_line_swap_quote', db, { visit_service_id: a.vs, new_service_id: USG }, cashier), 'line_performed');
  // След работы при статусе «в очереди» — тот же код.
  const b = paid(db, pid, CONS, DOC);
  db.prepare("UPDATE visit_services SET status = 'queued' WHERE id = ?").run(b.vs);
  db.prepare('INSERT INTO lab_results (visit_service_id, value) VALUES (?, ?)').run(b.vs, '5.1');
  refusedCode(() => call('cashier_line_swap_quote', db, { visit_service_id: b.vs, new_service_id: USG, doctor_id: DOC2 }, cashier), 'line_performed');
  // Неоплаченный счёт: замена у кассы отказывает, как прежде, без кода.
  const c = billed(db, pid, CONS, DOC);
  db.prepare("UPDATE visit_services SET status = 'in_progress' WHERE id = ?").run(c.vs);
  assert.throws(() => call('cashier_line_change_service', db, { visit_service_id: c.vs, new_service_id: USG }, cashier),
    (e) => e.status === 400 && /оказывается/.test(e.message) && e.code === undefined);
  assertBalanced(db, a.invoiceId);
  assertBalanced(db, b.invoiceId);
});

test('описание права «Исправляет услуги в счёте» говорит про замену в окне «Платежи»; по умолчанию — только администратор', () => {
  const row = catalogByKey().get('cashier.lines');
  assert.match(row.desc, /«Заменить услугу» в окне «Платежи»/);
  assert.match(row.desc, /на баланс пациента/);
  assert.match(row.levelDesc.edit, /в оплаченном/);
  assert.equal(row.adminDefault, true, 'выдают в «Ролях»; по умолчанию — как сегодня');
});
