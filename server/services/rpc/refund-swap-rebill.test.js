// REFUND_SWAP_V1 (2026-10-29) — «Вернуть эту услугу и выставить новую»:
// cashier_line_rebill_paid и его предпросмотр cashier_line_rebill_quote.
//
// Владелец: по услуге уже начата работа (взята проба, есть результат,
// документ, идёт приём) — перенести работу на другую услугу нельзя. Одна
// серверная операция убирает старую строку из счёта (работа остаётся в карте,
// врачу не оплачивается — pay_refund_releases), добавляет в тот же визит и
// счёт новую услугу с исполнителем и считает разницу так же, как обычная
// замена: дешевле — возврат сразу (каждый платёж своим способом или на баланс
// пациента), дороже — счёт «частично» с разницей к доплате.
//
// Всё — через настоящие RPC (карта index.js) и SQLite после миграций; права по
// умолчанию — через HTTP (createApp). После каждой денежной операции сумма
// платежей счёта равна «оплачено» по счёту.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { RPC } from './index.js';
import { createInvoiceForVisit, recordPayment } from './billing.js';
import { openCashShift, shiftReport } from './cashier.js';
import { createDeposit, acceptDeposit } from './deposits.js';
import { doctorPaySummary } from './reports.js';
import { walletBalance } from '../domain/wallet.js';
import { hashPassword } from '../auth.js';
import { createApp } from '../../app.js';
import { licensedDataDir } from '../control/licensed-fixture.js';
import { listen } from '../../../control-plane/server/test-helpers/listen.js';

const admin = { id: 1, role: 'admin', full_name: 'Админ' };
const registrar = { id: 7, role: 'registrar', full_name: 'Регистратор' };
const cashier = { id: 9, role: 'cashier', full_name: 'Кассир' };
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
const pays = (db, invoiceId) => db.prepare('SELECT id, amount, method, notes FROM payments WHERE invoice_id = ? ORDER BY id').all(invoiceId);
const itemsOf = (db, invoiceId) => db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY id').all(invoiceId);
const visitLines = (db, vid) => db.prepare('SELECT COUNT(*) n FROM visit_services WHERE visit_id = ?').get(vid).n;
const released = (db, vsId) => !!db.prepare("SELECT 1 FROM pay_refund_releases WHERE kind = 'out' AND line_id = ?").get(vsId);
const call = (name, db, args, user) => RPC[name](db, args, user);
const refused = (fn, re = /./, status = 403) => assert.throws(fn, (e) => e.status === status && re.test(e.message));
const refusedCode = (fn, code) => assert.throws(fn, (e) => e.status === 400 && e.code === code);
const r2 = (n) => Math.round(Number(n) * 100) / 100;
// Правило денег: SUM(payments) по счёту == invoices.paid_amount.
function assertBalanced(db, invoiceId) {
  const s = db.prepare('SELECT COALESCE(SUM(amount), 0) s FROM payments WHERE invoice_id = ?').get(invoiceId).s;
  assert.equal(r2(s), r2(inv(db, invoiceId).paid_amount), 'сумма платежей = оплачено по счёту');
}

// Клиника — как в cashier-paid-swap.test.js: приём 100 000 (у DOC своя цена
// 150 000 и 10 %, у DOC2 — 120 000 и 20 %), УЗИ 80 000 и КТ 200 000
// (процедуры), «Перевязка у хирурга» 50 000 (нужен врач). `grantCashier:
// false` — права по умолчанию (кассир только принимает оплату).
function clinic({ grantCashier = true } = {}) {
  const db = seed();
  const CONS = svc(db, 'Приём терапевта', 100000);
  const USG = svc(db, 'УЗИ', 80000, { type: 'procedure' });
  const CT = svc(db, 'КТ', 200000, { type: 'procedure' });
  const REQ = svc(db, 'Перевязка у хирурга', 50000, { type: 'procedure', requires_doctor: 1 });
  rates(db, DOC, [{ service_id: CONS, price: 150000, pct: 10 }, { service_id: USG, pct: 10 }, { service_id: CT, pct: 10 }]);
  rates(db, DOC2, [{ service_id: CONS, price: 120000, pct: 20 }, { service_id: USG, pct: 20 }, { service_id: CT, pct: 20 }]);
  if (grantCashier) grant(db, 'cashier', { 'cashier.lines': 'edit' });
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
// Оплаченная строка, по которой работа уже начата (статус).
function started(db, pid, serviceId, doctorId, { method = 'cash', status = 'completed' } = {}) {
  const b = billed(db, pid, serviceId, doctorId);
  recordPayment(db, { invoice_id: b.invoiceId, amount: b.invoice.total_amount, method }, cashier);
  db.prepare('UPDATE visit_services SET status = ? WHERE id = ?').run(status, b.vs);
  return b;
}

test('начатая работа: обычная замена — line_performed; возврат с новой услугой — разница наличными, работа в карте, врачу не платится', () => {
  const { db, pid, CONS, USG } = clinic();
  const a = started(db, pid, CONS, DOC);   // 150 000 наличными, приём завершён
  refusedCode(() => call('cashier_line_swap_paid', db, { visit_service_id: a.vs, new_service_id: USG }, cashier), 'line_performed');
  const r = call('cashier_line_rebill_paid', db, { visit_service_id: a.vs, new_service_id: USG, doctor_id: DOC2 }, cashier);
  assert.equal(r.rebill, true);
  assert.equal(r.old_line_id, a.vs);
  assert.deepEqual([r.refunded, r.due], [70000, 0]);
  assert.deepEqual(r.refund_plan.map((x) => [x.refund_method, x.amount]), [['cash', 70000]]);
  // Прежняя строка — в визите, без счёта, со своим статусом; отпущена с возвратом.
  const old = vsRow(db, a.vs);
  assert.deepEqual([old.invoice_item_id, old.status, old.service_id, old.doctor_id], [null, 'completed', CONS, DOC]);
  assert.equal(released(db, a.vs), true);
  // Новая строка — в том же визите и в той же позиции счёта.
  const items = itemsOf(db, a.invoiceId);
  assert.equal(items.length, 1);
  assert.deepEqual([items[0].service_id, items[0].description, items[0].total], [USG, 'УЗИ', 80000]);
  const nl = vsRow(db, r.line.id);
  assert.notEqual(nl.id, a.vs);
  assert.deepEqual([nl.visit_id, nl.service_id, nl.doctor_id, nl.invoice_item_id, nl.status, nl.unit_price],
    [a.vid, USG, DOC2, items[0].id, 'queued', 80000]);
  assert.ok(nl.queue_no != null, 'новая строка в очереди с номером');
  const i = inv(db, a.invoiceId);
  assert.deepEqual([i.total_amount, i.paid_amount, i.status], [80000, 80000, 'paid']);
  assertBalanced(db, a.invoiceId);
  const neg = pays(db, a.invoiceId).filter((p) => p.amount < 0);
  assert.equal(neg.length, 1);
  assert.match(neg[0].notes, /^REFUND#\d+ SWAP#\d+ — Замена услуги — возврат разницы/);
  assert.equal(shiftReport(db, {}, cashier).expected_drawer, 80000);
  const log = db.prepare("SELECT * FROM invoice_audit_log WHERE action = 'line_swap_paid'").all();
  assert.equal(log.length, 1);
  assert.equal(log[0].refund_amount, 70000);
  assert.match(log[0].notes, /Приём терапевта.*работа осталась в визите невыставленной.*→.*УЗИ.*возвращено 70 000/);
  // Касса и окно визита знают прежнюю строку как возвращённую.
  assert.deepEqual(call('visit_refunded_lines', db, { visit_id: a.vid }, cashier).line_ids, [a.vs]);
  // Доля: новому врачу за новую услугу, прежнему — ничего.
  db.prepare("UPDATE visit_services SET status = 'completed' WHERE id = ?").run(nl.id);
  assert.equal(doctorPaySummary(db, { doctor_id: DOC2, from: FROM, to: TO }, admin).outpatient.fee, 16000, '20 % от 80 000');
  assert.equal(doctorPaySummary(db, { doctor_id: DOC, from: FROM, to: TO }, admin).lines.length, 0, 'возвращённая работа врачу не платится');
});

test('карта — на ту же карту; выбор «на баланс пациента» — на баланс, из ящика ничего', () => {
  const { db, pid, CONS, USG } = clinic();
  const a = started(db, pid, CONS, DOC, { method: 'card', status: 'collected' });
  const r = call('cashier_line_rebill_paid', db, { visit_service_id: a.vs, new_service_id: USG }, cashier);
  assert.equal(r.refunded, 70000);
  assert.deepEqual(pays(db, a.invoiceId).filter((p) => p.amount < 0).map((p) => [p.method, p.amount]), [['card', -70000]]);
  assert.equal(vsRow(db, r.line.id).doctor_id, DOC, 'исполнитель не выбран — прежний');
  assertBalanced(db, a.invoiceId);

  const b = started(db, pid, CONS, DOC, { status: 'in_progress' });
  const drawer = shiftReport(db, {}, cashier).expected_drawer;
  const rb = call('cashier_line_rebill_paid', db, { visit_service_id: b.vs, new_service_id: USG, to_balance: true, card_fallback: 'balance' }, cashier);
  assert.equal(rb.to_balance, true);
  assert.equal(walletBalance(db, pid), 70000);
  assert.equal(shiftReport(db, {}, cashier).expected_drawer, drawer, 'наличные из кассы не выданы');
  assert.deepEqual(pays(db, b.invoiceId).filter((p) => p.amount < 0).map((p) => p.method), ['wallet']);
  assertBalanced(db, b.invoiceId);
});

test('с баланса — разница возвращается на баланс', () => {
  const { db, pid, CONS, USG } = clinic();
  const { deposit } = createDeposit(db, { patient_id: pid, amount: 150000 }, registrar);
  acceptDeposit(db, { deposit_id: deposit.id, method: 'cash' }, cashier);
  const a = started(db, pid, CONS, DOC, { method: 'wallet' });
  assert.equal(walletBalance(db, pid), 0);
  const r = call('cashier_line_rebill_paid', db, { visit_service_id: a.vs, new_service_id: USG, doctor_id: DOC2 }, cashier);
  assert.equal(r.refunded, 70000);
  assert.equal(walletBalance(db, pid), 70000);
  assert.equal(pays(db, a.invoiceId).filter((p) => p.amount < 0)[0].method, 'wallet');
  assertBalanced(db, a.invoiceId);
});

test('дороже: счёт «частично» на разницу, новая услуга в работе, доплата закрывает', () => {
  const { db, pid, CONS, CT } = clinic();
  const a = started(db, pid, CONS, DOC2, { status: 'in_progress' });   // 120 000
  const r = call('cashier_line_rebill_paid', db, { visit_service_id: a.vs, new_service_id: CT, doctor_id: DOC2 }, cashier);
  assert.deepEqual([r.refunded, r.due], [0, 80000]);
  const i = inv(db, a.invoiceId);
  assert.deepEqual([i.total_amount, i.paid_amount, i.status], [200000, 120000, 'partial']);
  assert.equal(pays(db, a.invoiceId).filter((p) => p.amount < 0).length, 0, 'денег никто не возвращал');
  assert.equal(vsRow(db, r.line.id).status, 'queued', 'частично оплаченный счёт работу не останавливает');
  assert.equal(vsRow(db, a.vs).status, 'in_progress', 'начатая работа — как была');
  assert.equal(released(db, a.vs), true);
  assertBalanced(db, a.invoiceId);
  recordPayment(db, { invoice_id: a.invoiceId, amount: 80000, method: 'card' }, cashier);
  assert.equal(inv(db, a.invoiceId).status, 'paid');
  assertBalanced(db, a.invoiceId);
});

test('кэшбэк: возврат разницы откатывает его в той же доле', () => {
  const { db, pid, CONS, USG } = clinic();
  db.prepare("INSERT INTO cashback_rules (name, percent, active) VALUES ('Всем', 10, 1)").run();
  const cb = (invoiceId) => db.prepare("SELECT * FROM patient_deposits WHERE kind = 'cashback' AND invoice_id = ?").all(invoiceId);
  const a = started(db, pid, CONS, DOC);
  assert.equal(cb(a.invoiceId)[0].amount, 15000);
  call('cashier_line_rebill_paid', db, { visit_service_id: a.vs, new_service_id: USG, doctor_id: DOC2 }, cashier);
  const row = cb(a.invoiceId)[0];
  assert.equal(row.amount - (row.refund_amount || 0), 8000, 'кэшбэк следует за оставшимися 80 000');
  assertBalanced(db, a.invoiceId);
});

test('ключ повтора: повтор — прежний ответ, вторая строка не заводится; другая форма и другая дверь — 409', () => {
  const { db, pid, CONS, USG, CT } = clinic();
  const a = started(db, pid, CONS, DOC);
  const args = { visit_service_id: a.vs, new_service_id: USG, doctor_id: DOC2, idempotency_key: 'k-rebill-paid-0001' };
  const first = call('cashier_line_rebill_paid', db, args, cashier);
  const again = call('cashier_line_rebill_paid', db, args, cashier);
  assert.equal(again.repeated, true);
  assert.equal(again.line.id, first.line.id);
  assert.equal(again.refunded, first.refunded);
  assert.equal(visitLines(db, a.vid), 2, 'прежняя и одна новая строка');
  assert.equal(pays(db, a.invoiceId).filter((p) => p.amount < 0).length, 1);
  assertBalanced(db, a.invoiceId);
  assert.throws(() => call('cashier_line_rebill_paid', db, { ...args, new_service_id: CT }, cashier), (e) => e.status === 409);
  assert.throws(() => call('cashier_line_swap_paid', db, args, cashier), (e) => e.status === 409);
  assert.equal(visitLines(db, a.vid), 2);
  assertBalanced(db, a.invoiceId);
});

test('отказы: работа не начата, закрытый месяц, регистратура, кассир без права, та же услуга и врач, нужен врач — ничего не тронуто', () => {
  const { db, pid, CONS, USG, REQ } = clinic();
  const fresh = billed(db, pid, CONS, DOC);
  recordPayment(db, { invoice_id: fresh.invoiceId, amount: 150000, method: 'cash' }, cashier);
  refused(() => call('cashier_line_rebill_paid', db, { visit_service_id: fresh.vs, new_service_id: USG }, cashier), /ещё не начата/, 400);
  const a = started(db, pid, CONS, DOC);
  const snap = () => JSON.stringify([inv(db, a.invoiceId), pays(db, a.invoiceId), itemsOf(db, a.invoiceId), visitLines(db, a.vid)]);
  const before = snap();
  db.prepare("INSERT INTO pay_periods (month, closed_by, total, lines) VALUES ('2026-09', 1, 0, 0)").run();
  refused(() => call('cashier_line_rebill_paid', db, { visit_service_id: a.vs, new_service_id: USG }, cashier), /месяц/, 409);
  refused(() => call('cashier_line_rebill_quote', db, { visit_service_id: a.vs, new_service_id: USG }, cashier), /месяц/, 409);
  db.prepare('DELETE FROM pay_periods').run();
  refused(() => call('cashier_line_rebill_paid', db, { visit_service_id: a.vs, new_service_id: USG }, registrar), /касса/);
  grant(db, 'cashier', { 'cashier.lines': 'none' });
  refused(() => call('cashier_line_rebill_paid', db, { visit_service_id: a.vs, new_service_id: USG }, cashier), /Исправлять услуги в счёте/);
  grant(db, 'cashier', { 'cashier.lines': 'edit' });
  refused(() => call('cashier_line_rebill_paid', db, { visit_service_id: a.vs, new_service_id: CONS }, cashier), /совпадают с прежними/, 400);
  refused(() => call('cashier_line_rebill_paid', db, { visit_service_id: a.vs, new_service_id: REQ, no_doctor: true }, cashier), /нужен врач/, 400);
  refused(() => call('cashier_line_rebill_paid', db, { visit_service_id: a.vs, doctor_id: DOC2 }, cashier), /^Выберите новую услугу\.$/, 400);
  assert.equal(snap(), before, 'отказы ничего не тронули');
  assert.equal(released(db, a.vs), false);
  assertBalanced(db, a.invoiceId);
  assertBalanced(db, fresh.invoiceId);
});

test('предпросмотр считает то же самое и ничего не записывает', () => {
  const { db, pid, CONS, USG } = clinic();
  const a = started(db, pid, CONS, DOC);
  const snap = () => JSON.stringify([inv(db, a.invoiceId), pays(db, a.invoiceId), itemsOf(db, a.invoiceId),
    db.prepare('SELECT * FROM visit_services WHERE visit_id = ? ORDER BY id').all(a.vid),
    db.prepare('SELECT COUNT(*) n FROM invoice_audit_log').get(), db.prepare('SELECT COUNT(*) n FROM pay_refund_releases').get()]);
  const before = snap();
  const q = call('cashier_line_rebill_quote', db, { visit_service_id: a.vs, new_service_id: USG, doctor_id: DOC2 }, cashier);
  assert.equal(q.preview, true);
  assert.equal(q.rebill, true);
  assert.deepEqual([q.refunded, q.total_before, q.total_after], [70000, 150000, 80000]);
  assert.equal(snap(), before);
  refused(() => call('cashier_line_rebill_quote', db, { visit_service_id: a.vs, new_service_id: USG }, registrar), /касса/);
});

test('след работы без статуса (документ): обычная замена — line_performed, возврат с новой — можно, документ остаётся у прежней строки', () => {
  const { db, pid, CONS, USG } = clinic();
  const a = billed(db, pid, CONS, DOC);
  recordPayment(db, { invoice_id: a.invoiceId, amount: 150000, method: 'cash' }, cashier);
  db.prepare("UPDATE visit_services SET status = 'queued' WHERE id = ?").run(a.vs);
  const docId = Number(db.prepare("INSERT INTO visit_documents (patient_id, visit_id, visit_service_id, doc_type, title, body, created_by) VALUES (?,?,?,'protocol','Протокол','{}',?)")
    .run(pid, a.vid, a.vs, DOC).lastInsertRowid);
  refusedCode(() => call('cashier_line_swap_quote', db, { visit_service_id: a.vs, new_service_id: USG }, cashier), 'line_performed');
  const r = call('cashier_line_rebill_paid', db, { visit_service_id: a.vs, new_service_id: USG }, cashier);
  assert.equal(r.refunded, 70000);
  assert.equal(db.prepare('SELECT visit_service_id v FROM visit_documents WHERE id = ?').get(docId).v, a.vs);
  assert.equal(vsRow(db, a.vs).invoice_item_id, null);
  assertBalanced(db, a.invoiceId);
});

test('права по умолчанию — как сегодня: старший кассир и администратор — да, кассир без права — 403; через HTTP', async () => {
  const { db, pid, CONS, USG } = clinic({ grantCashier: false });
  const a = started(db, pid, CONS, DOC);
  const b = started(db, pid, CONS, DOC);
  const c = started(db, pid, CONS, DOC);
  const server = await listen(createApp(db, { dataDir: licensedDataDir() }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async (username) => {
    const res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'password1' }) });
    assert.equal(res.status, 200);
    return res.headers.getSetCookie().map((x) => x.split(';')[0]).join('; ');
  };
  const post = async (cookie, name, body) => {
    const res = await fetch(base + '/api/rpc/' + name, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  try {
    const plain = await login('cash2');
    const no = await post(plain, 'cashier_line_rebill_paid', { visit_service_id: a.vs, new_service_id: USG });
    assert.equal(no.status, 403, 'кассиру право не выдано — касса только принимает оплату');
    const head = await login('head');
    const q = await post(head, 'cashier_line_rebill_quote', { visit_service_id: a.vs, new_service_id: USG });
    assert.equal(q.status, 200);
    assert.equal(q.body.data.preview, true);
    assert.equal(q.body.data.refunded, 70000);
    const ok = await post(head, 'cashier_line_rebill_paid', { visit_service_id: a.vs, new_service_id: USG, idempotency_key: 'k-http-rebill-0001' });
    assert.equal(ok.status, 200);
    assert.equal(inv(db, a.invoiceId).total_amount, 80000);
    assertBalanced(db, a.invoiceId);
    const adm = await login('adm');
    const ad = await post(adm, 'cashier_line_rebill_paid', { visit_service_id: b.vs, new_service_id: USG });
    assert.equal(ad.status, 200);
    assertBalanced(db, b.invoiceId);
    // Отказ «работа начата» у обычной замены приходит экрану с кодом.
    const sw = await post(head, 'cashier_line_swap_quote', { visit_service_id: c.vs, new_service_id: USG });
    assert.equal(sw.status, 400);
    assert.equal(sw.body.error.code, 'line_performed');
    assertBalanced(db, c.invoiceId);
  } finally { server.close(); db.close(); }
});

// ─── Сверх плана (поправки A2): талон, «услуга возвращена», доля врача без
// возврата денег, отменённый счёт. ───────────────────────────────────────────

test('талон: возврат с новой оставляет прежней строке её талон (как refund_invoice_line), обычная замена его снимает', () => {
  const { db, pid, CONS, USG } = clinic();
  const ticket = (b) => db.prepare('INSERT INTO service_queue_tickets (visit_service_id, visit_id, service_id, number, queue_key) VALUES (?, ?, ?, 7, ?)')
    .run(b.vs, b.vid, CONS, 'doc:' + DOC + ':2026-09-10');
  const tickets = (vsId) => db.prepare('SELECT COUNT(*) n FROM service_queue_tickets WHERE visit_service_id = ?').get(vsId).n;
  const a = started(db, pid, CONS, DOC);
  ticket(a);
  const had = tickets(a.vs);
  assert.ok(had >= 1);
  const r = call('cashier_line_rebill_paid', db, { visit_service_id: a.vs, new_service_id: USG, doctor_id: DOC2 }, cashier);
  assert.equal(tickets(a.vs), had, 'начатая работа держит свой талон');
  assert.ok(vsRow(db, r.line.id).queue_no != null, 'у новой строки — свой номер');
  assertBalanced(db, a.invoiceId);
  // Неначатая строка, обычная замена — талон прежней очереди снят.
  const b = billed(db, pid, CONS, DOC);
  recordPayment(db, { invoice_id: b.invoiceId, amount: 150000, method: 'cash' }, cashier);
  ticket(b);
  call('cashier_line_swap_paid', db, { visit_service_id: b.vs, new_service_id: USG, doctor_id: DOC2 }, cashier);
  assert.equal(tickets(b.vs), 0);
  assertBalanced(db, b.invoiceId);
});

test('после возврата с новой: прежняя строка — «услуга возвращена» (refunded_lines), новая — обычная строка счёта', () => {
  const { db, pid, CONS, USG } = clinic();
  const a = started(db, pid, CONS, DOC, { status: 'collected' });
  const r = call('cashier_line_rebill_paid', db, { visit_service_id: a.vs, new_service_id: USG, doctor_id: DOC2 }, cashier);
  const nl = vsRow(db, r.line.id);
  assert.deepEqual(call('refunded_lines', db, { line_ids: [a.vs, nl.id] }, cashier).line_ids, [a.vs], 'прежняя — возвращена, новая — нет');
  assert.deepEqual(call('visit_refunded_lines', db, { visit_id: a.vid }, cashier).line_ids, [a.vs]);
  assert.equal(released(db, nl.id), false);
  assert.equal(nl.invoice_item_id, itemsOf(db, a.invoiceId)[0].id);
  // В счёте — одна позиция, и она у новой строки: работы по ней ещё нет.
  const work = call('invoice_line_work', db, { invoice_id: a.invoiceId }, cashier).lines;
  assert.equal(work.length, 1);
  assert.deepEqual([work[0].kind, work[0].status, work[0].performed], ['visit', 'queued', false]);
  // Новую строку можно менять дальше обычной заменой (работа по ней не начата).
  const q = call('cashier_line_swap_quote', db, { visit_service_id: nl.id, doctor_id: DOC }, cashier);
  assert.equal(q.preview, true);
  assertBalanced(db, a.invoiceId);
});

test('врачу не оплачивается и когда денег не вернули: та же цена и дороже (правило владельца)', () => {
  const { db, pid, CONS, CT } = clinic();
  const SAME = svc(db, 'Осмотр хирурга', 150000, { type: 'procedure' });
  // Та же цена: 150 000 → 150 000, денег не двигали.
  const a = started(db, pid, CONS, DOC);
  const r = call('cashier_line_rebill_paid', db, { visit_service_id: a.vs, new_service_id: SAME, doctor_id: DOC2 }, cashier);
  assert.deepEqual([r.refunded, r.due], [0, 0]);
  assert.equal(pays(db, a.invoiceId).filter((p) => p.amount < 0).length, 0);
  assert.equal(inv(db, a.invoiceId).status, 'paid');
  assert.equal(released(db, a.vs), true);
  assert.match(db.prepare("SELECT notes FROM invoice_audit_log WHERE action = 'line_swap_paid' ORDER BY id DESC").get().notes, /врачу не оплачивается.*сумма счёта не изменилась/);
  assertBalanced(db, a.invoiceId);
  // Дороже: 150 000 → 200 000, доплата 50 000.
  const b = started(db, pid, CONS, DOC);
  const rb = call('cashier_line_rebill_paid', db, { visit_service_id: b.vs, new_service_id: CT, doctor_id: DOC2 }, cashier);
  assert.deepEqual([rb.refunded, rb.due], [0, 50000]);
  recordPayment(db, { invoice_id: b.invoiceId, amount: 50000, method: 'cash' }, cashier);
  assert.equal(inv(db, b.invoiceId).status, 'paid');
  assert.equal(released(db, b.vs), true);
  assertBalanced(db, b.invoiceId);
  // Обе прежние строки завершены, но врачу DOC за них ничего.
  assert.equal(doctorPaySummary(db, { doctor_id: DOC, from: FROM, to: TO }, admin).lines.length, 0, 'возвращённая работа врачу не платится');
});

test('отменённый счёт — возврат с новой услугой отказывает, ничего не тронуто', () => {
  const { db, pid, CONS, USG } = clinic();
  const a = started(db, pid, CONS, DOC);
  const snap = () => JSON.stringify([inv(db, a.invoiceId), pays(db, a.invoiceId), itemsOf(db, a.invoiceId), vsRow(db, a.vs), visitLines(db, a.vid)]);
  for (const st of ['void', 'refunded']) {
    // Ворота paidSwapRefusal: строка с работой в отменённом счёте (статус
    // ставится прямо — проверяется сам отказ).
    db.prepare('UPDATE invoices SET status = ? WHERE id = ?').run(st, a.invoiceId);
    const before = snap();
    refused(() => call('cashier_line_rebill_paid', db, { visit_service_id: a.vs, new_service_id: USG }, cashier), /Счёт отменён/, 400);
    refused(() => call('cashier_line_rebill_quote', db, { visit_service_id: a.vs, new_service_id: USG }, cashier), /Счёт отменён/, 400);
    assert.equal(snap(), before);
    assert.equal(released(db, a.vs), false);
    assertBalanced(db, a.invoiceId);
  }
});
