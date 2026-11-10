// DISCOUNT_CHANGE_PAID_V1 (3.23.0, решения владельца Q2–Q4 2026-11-10) — «ИЗМЕНИТЬ СКИДКУ»
// ПОСЛЕ ОПЛАТЫ.
//
// Владелец: «in the cashier window, when a discount is applied we should add an option for
// editing the discount of paid services». Прежде скидку кассы давали только до оплаты (409
// «Скидку дают до оплаты»), а у счёта со скидкой 100 % не было ни кнопки, ни окна «Платежи».
// Теперь касса меняет скидку СЧЁТА (не строк) и после оплаты — выше и ниже, 100 % тоже:
//   • сумма стала меньше оплаченного — разница возвращается сразу (по платежам с последнего,
//     каждый своим способом, или вся на баланс пациента; подарочная карта — всегда на карту);
//   • больше — «К доплате N», счёт частично оплачен / не оплачен / долг;
//   • скидки строк (пакет, ставки по услугам) не меняются;
//   • закрытый месяц «Оплаты врачей» — отказ, как у замены услуги;
//   • право — «Кассир может давать скидку» (cashier.discount) и денежная роль.
// Числа владельца (врач 30 %, партнёр 10 %, налог 0): УЗИ 200 000, скидка 20 %, оплачено
// 160 000 → 50 %: сумма 100 000, вернуть 60 000; доля врача 48 000 → 30 000; вознаграждение
// партнёра (полная цена, REFERRAL_FULL_PRICE_V1) — 20 000 и до, и после.
// Всё — через настоящие RPC (карта index.js), настоящие отчёты и SQLite после миграций.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { RPC } from './index.js';
import { isReadOnlyRpc } from '../control/gate.js';
import { doctorPaySummary, runReport } from './reports.js';
import { sellCard } from './card-sales.js';
import { createDeposit, acceptDeposit } from './deposits.js';
import { walletBalance } from '../domain/wallet.js';

const admin = { id: 1, role: 'admin', full_name: 'Админ' };
const registrar = { id: 7, role: 'registrar', full_name: 'Регистратор' };
const cashier = { id: 9, role: 'cashier', full_name: 'Кассир' };
const DOC = 20;
const USG = 30;   // УЗИ 200 000
const CONS = 31;  // Консультация 100 000
const ECG = 32;   // ЭКГ 100 000
const DAY = '2026-11-05T05:00:00Z';
const RANGE = { from: '2026-11-01', to: '2026-11-30' };

function seed() {
  const db = openDb(':memory:'); migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, role, full_name, is_doctor, is_active, service_rates) VALUES (?,?,?,?,?,?,1,?)');
  u.run(1, 'adm', 'x', 'admin', 'Админ', 0, '');
  u.run(7, 'reg', 'x', 'registrar', 'Регистратор', 0, '');
  u.run(9, 'cash', 'x', 'cashier', 'Кассир', 0, '');
  u.run(DOC, 'doc', 'x', 'doctor', 'Врач Узистов', 1, JSON.stringify([{ service_id: USG, pct: 30 }, { service_id: CONS, pct: 30 }, { service_id: ECG, pct: 30 }]));
  db.prepare("INSERT INTO services (id, name, price, tax_rate, type) VALUES (30, 'УЗИ', 200000, 0, 'imaging'), (31, 'Консультация', 100000, 0, 'consultation'), (32, 'ЭКГ', 100000, 0, 'imaging')").run();
  const cat = db.prepare("INSERT INTO referral_source_categories (name, standard_percent) VALUES ('Партнёры', 10)").run().lastInsertRowid;
  const partner = Number(db.prepare("INSERT INTO referral_sources (name, code, category_id) VALUES ('Клиника Х', 'KX', ?)").run(cat).lastInsertRowid);
  RPC.open_cash_shift(db, { opening_float: 0 }, cashier);
  return { db, partner };
}
const call = (name, db, args, user = cashier) => RPC[name](db, args, user);
const inv = (db, id) => db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
const pays = (db, id) => db.prepare('SELECT id, amount, method, notes FROM payments WHERE invoice_id = ? ORDER BY id').all(id);
const vsRow = (db, id) => db.prepare('SELECT * FROM visit_services WHERE id = ?').get(id);
const refused = (fn, re, status) => assert.throws(fn, (e) => (status == null || e.status === status) && re.test(e.message));
function setGrants(db, role, grants) {
  const row = db.prepare('SELECT permissions FROM role_permissions WHERE role = ?').get(role);
  const perms = row && row.permissions ? JSON.parse(row.permissions) : { sections: [], levels: {} };
  perms.grants = { ...(perms.grants || {}), ...grants };
  if (row) db.prepare('UPDATE role_permissions SET permissions = ? WHERE role = ?').run(JSON.stringify(perms), role);
  else db.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?)').run(role, JSON.stringify(perms));
}

// Визит со строками services (id услуг) пациента, направленного партнёром; счёт без скидки.
function visit(db, { services = [USG], patient = null, category = null, partner = null } = {}) {
  const pid = patient || Number(db.prepare('INSERT INTO patients (full_name, category_id, referral_source_id) VALUES (?, ?, ?)').run('Пациент Тестов', category, partner).lastInsertRowid);
  const vid = Number(db.prepare("INSERT INTO visits (patient_id, visit_date, status) VALUES (?, ?, 'arrived')").run(pid, DAY).lastInsertRowid);
  const vs = services.map((sid) => {
    const price = db.prepare('SELECT price FROM services WHERE id = ?').get(sid).price;
    return Number(db.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, created_by) VALUES (?, ?, ?, 1, ?, ?, 'added', 1)")
      .run(vid, sid, DOC, price, price).lastInsertRowid);
  });
  const invoice = call('create_invoice_for_visit', db, { visit_id: vid, visit_service_ids: vs, discount_amount: 0 }, admin).invoice;
  db.prepare('UPDATE invoices SET created_at = ? WHERE id = ?').run(DAY, invoice.id);   // период отчётов — по дате счёта
  return { pid, vid, vs, id: invoice.id };
}
// Числа владельца: УЗИ 200 000, скидка кассы 20 % до оплаты, оплачено 160 000 наличными.
function paid20(db, extra = {}, method = 'cash', payExtra = {}) {
  const v = visit(db, extra);
  call('cashier_invoice_discount', db, { invoice_id: v.id, mode: 'pct', value: 20, reason: 'постоянный пациент' });
  assert.equal(inv(db, v.id).total_amount, 160000);
  call('record_payment', db, { invoice_id: v.id, amount: 160000, method, ...payExtra });
  return v;
}
const doctorFee = (db) => Math.round(doctorPaySummary(db, { doctor_id: DOC, ...RANGE }, admin).outpatient.fee * 100) / 100;
function partnerReward(db) {
  const r = runReport(db, { kind: 'referrals', ...RANGE }, admin);
  const rows = r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]])));
  return Math.round(rows.filter((o) => o['Источник'] === 'Клиника Х').reduce((s, o) => s + (Number(o['Вознаграждение']) || 0), 0) * 100) / 100;
}
const change = (db, id, args, user = cashier) => call('cashier_invoice_discount_change', db, { invoice_id: id, reason: 'решение руководителя', ...args }, user);
const quote = (db, id, args, user = cashier) => call('cashier_invoice_discount_change_quote', db, { invoice_id: id, ...args }, user);

test('RPC зарегистрированы; изменение пишет (не в READ_ONLY_RPCS)', () => {
  assert.equal(typeof RPC.cashier_invoice_discount_change, 'function');
  assert.equal(typeof RPC.cashier_invoice_discount_change_quote, 'function');
  assert.equal(isReadOnlyRpc('cashier_invoice_discount_change'), false);
});

test('числа владельца: 20 % оплачено 160 000 → 50 %: сумма 100 000, вернуть 60 000 наличными; доля врача 48 000 → 30 000; партнёру 20 000 и до, и после', () => {
  const { db, partner } = seed();
  const v = paid20(db, { partner });
  db.prepare("UPDATE visit_services SET status = 'completed' WHERE id = ?").run(v.vs[0]);
  assert.equal(doctorFee(db), 48000, 'до изменения: 30 % от 160 000');
  assert.equal(partnerReward(db), 20000, 'до изменения: 10 % от 200 000');

  // Предпросмотр — те же числа, ничего не меняет.
  const q = quote(db, v.id, { mode: 'pct', value: 50 });
  assert.equal(q.preview, true);
  assert.deepEqual([q.total_before, q.total_after, q.paid_before, q.refunded, q.due], [160000, 100000, 160000, 60000, 0]);
  assert.deepEqual([q.pct_before, q.pct_after, q.discount_before, q.discount_after, q.base], [20, 50, 40000, 100000, 200000]);
  assert.deepEqual(q.refund_plan.map((x) => [x.refund_method, x.amount]), [['cash', 60000]]);
  assert.equal(inv(db, v.id).total_amount, 160000, 'предпросмотр не тронул счёт');
  assert.equal(pays(db, v.id).length, 1, 'предпросмотр не провёл возврат');

  const r = change(db, v.id, { mode: 'pct', value: 50, reason: 'акция' });
  assert.equal(r.changed, true);
  assert.deepEqual([r.refunded, r.due, r.total_after], [60000, 0, 100000]);
  const i = inv(db, v.id);
  assert.deepEqual([i.subtotal, i.discount_amount, i.total_amount, i.paid_amount, i.status], [200000, 100000, 100000, 100000, 'paid']);
  assert.deepEqual([i.manual_discount, i.manual_base, i.doctor_discount_share], [100000, 200000, 1]);
  assert.match(i.discount_note, /Касса: постоянный пациент — 20% — 40 000 сум; Касса после оплаты: акция — было 20% \(40 000 сум\), стало 50% \(100 000 сум\)$/);
  const neg = pays(db, v.id).filter((p) => p.amount < 0);
  assert.equal(neg.length, 1);
  assert.equal(neg[0].amount, -60000);
  assert.equal(neg[0].method, 'cash');
  assert.match(neg[0].notes, new RegExp('^REFUND#' + pays(db, v.id)[0].id + ' DISC#' + v.id + ' — Изменение скидки'));
  const s = db.prepare('SELECT COALESCE(SUM(amount), 0) s FROM payments WHERE invoice_id = ?').get(v.id).s;
  assert.equal(s, i.paid_amount, 'сумма платежей = оплачено по счёту');

  assert.equal(doctorFee(db), 30000, 'после: 30 % от 100 000');
  assert.equal(partnerReward(db), 20000, 'вознаграждение — от полной цены, изменение скидки его не трогает');

  const log = db.prepare("SELECT * FROM invoice_audit_log WHERE invoice_id = ? AND action = 'discount_change'").all(v.id);
  assert.equal(log.length, 1);
  assert.deepEqual([log[0].reason, log[0].refund_amount, log[0].amount, log[0].from_status, log[0].to_status, log[0].actor_user_id], ['акция', 60000, 100000, 'paid', 'paid', cashier.id]);
  assert.match(log[0].notes, /было 20% \(40 000 сум\), стало 50% \(100 000 сум\).*возвращено 60 000 \(наличными 60 000\)/);
});

test('«Возвраты и отмены» кассы: возврат разницы — вид «discount» (Изменение скидки)', () => {
  const { db } = seed();
  const v = paid20(db);
  change(db, v.id, { mode: 'pct', value: 50 });
  const row = call('cashier_refunds', db, {}).rows.find((x) => x.invoice_id === v.id);
  assert.ok(row, 'счёт с возвратом разницы не в списке');
  assert.deepEqual(row.refunds.map((x) => [x.kind, x.amount]), [['discount', 60000]]);
  assert.ok(row.events.some((e) => e.action === 'discount_change'), 'нет события «Изменение скидки»');
});

test('«На баланс пациента»: наличные из кассы не выходят, разница — на баланс', () => {
  const { db } = seed();
  const v = paid20(db);
  const drawer = RPC.shift_report(db, {}, cashier).expected_drawer;
  const r = change(db, v.id, { mode: 'pct', value: 50, to_balance: true, card_fallback: 'balance' });
  assert.equal(r.to_balance, true);
  assert.equal(walletBalance(db, v.pid), 60000);
  assert.equal(pays(db, v.id).filter((p) => p.amount < 0)[0].method, 'wallet');
  assert.equal(RPC.shift_report(db, {}, cashier).expected_drawer, drawer, 'наличные из кассы не выданы');
});

test('подарочная карта: разница всегда возвращается на карту — и при выборе «на баланс»', () => {
  const { db } = seed();
  const buyer = Number(db.prepare("INSERT INTO patients (full_name) VALUES ('Покупатель')").run().lastInsertRowid);
  const sold = sellCard(db, { kind: 'gift_card', amount: 300000, method: 'cash', patient_id: buyer }, cashier);
  const v = paid20(db, {}, 'gift_card', { card_id: sold.card.id });
  const remain = () => db.prepare('SELECT remaining FROM patient_discounts WHERE id = ?').get(sold.card.id).remaining;
  assert.equal(remain(), 140000);
  const q = quote(db, v.id, { mode: 'pct', value: 50, to_balance: true, card_fallback: 'balance' });
  assert.deepEqual(q.refund_plan.map((x) => [x.refund_method, x.to_card, x.amount]), [['gift_card', true, 60000]]);
  change(db, v.id, { mode: 'pct', value: 50, to_balance: true, card_fallback: 'balance' });
  assert.equal(remain(), 200000);
  assert.equal(walletBalance(db, v.pid), 0, 'на баланс пациента ничего не ушло');
  assert.equal(pays(db, v.id).filter((p) => p.amount < 0)[0].method, 'gift_card');
});

test('скидку снизили до 0 %: сумма 200 000, «К доплате 40 000», счёт частично оплачен; доплата закрывает его', () => {
  const { db, partner } = seed();
  const v = paid20(db, { partner });
  const q = quote(db, v.id, { mode: 'pct', value: 0 });
  assert.deepEqual([q.total_after, q.refunded, q.due], [200000, 0, 40000]);
  const r = change(db, v.id, { mode: 'pct', value: 0, reason: 'скидка дана ошибочно' });
  assert.deepEqual([r.refunded, r.due], [0, 40000]);
  const i = inv(db, v.id);
  assert.deepEqual([i.discount_amount, i.total_amount, i.paid_amount, i.status, i.paid_at], [0, 200000, 160000, 'partial', null]);
  assert.equal(i.manual_discount, 0);
  assert.equal(pays(db, v.id).filter((p) => p.amount < 0).length, 0, 'денег никто не возвращал');
  assert.equal(vsRow(db, v.vs[0]).status, 'queued', 'частично оплаченный счёт работу не останавливает');
  assert.match(i.discount_note, /стало 0% \(0 сум\)$/);
  const log = db.prepare("SELECT notes FROM invoice_audit_log WHERE invoice_id = ? AND action = 'discount_change'").get(v.id);
  assert.match(log.notes, /к доплате 40 000/);
  call('record_payment', db, { invoice_id: v.id, amount: 40000, method: 'card' });
  assert.equal(inv(db, v.id).status, 'paid');
  db.prepare("UPDATE visit_services SET status = 'completed' WHERE id = ?").run(v.vs[0]);
  assert.equal(partnerReward(db), 20000);
  assert.equal(doctorFee(db), 60000, 'без скидки: 30 % от 200 000');
});

test('счёт со скидкой 100 % (сумма 0) → 0 %: к оплате 200 000, «не оплачен»; неначатая услуга снова ждёт кассу, начатая работа остаётся', () => {
  const { db } = seed();
  const v = visit(db, { services: [CONS, ECG] });
  call('cashier_invoice_discount', db, { invoice_id: v.id, mode: 'pct', value: 100, reason: 'сотрудник' });
  assert.deepEqual([inv(db, v.id).total_amount, inv(db, v.id).status], [0, 'paid']);
  assert.equal(vsRow(db, v.vs[0]).status, 'queued');
  db.prepare("UPDATE visit_services SET status = 'completed' WHERE id = ?").run(v.vs[1]);
  const r = change(db, v.id, { mode: 'pct', value: 0, reason: 'не сотрудник' });
  assert.deepEqual([r.refunded, r.due, r.total_after], [0, 200000, 200000]);
  const i = inv(db, v.id);
  assert.deepEqual([i.total_amount, i.paid_amount, i.status, i.paid_at], [200000, 0, 'unpaid', null]);
  assert.equal(vsRow(db, v.vs[0]).status, 'added', 'неначатая услуга — снова «ждёт кассу»');
  assert.equal(vsRow(db, v.vs[0]).queue_no, null, 'номер очереди снят — его выдаст оплата');
  assert.equal(vsRow(db, v.vs[1]).status, 'completed', 'сделанная работа остаётся');
});

test('скидку подняли до 100 % после оплаты: вернуть всё оплаченное, счёт закрыт на 0', () => {
  const { db } = seed();
  const v = paid20(db);
  const r = change(db, v.id, { mode: 'pct', value: 100 });
  assert.deepEqual([r.refunded, r.due, r.total_after], [160000, 0, 0]);
  const i = inv(db, v.id);
  assert.deepEqual([i.discount_amount, i.total_amount, i.paid_amount, i.status], [200000, 0, 0, 'paid']);
  assert.equal(vsRow(db, v.vs[0]).status, 'queued', 'услуга остаётся в работе');
});

test('скидка суммой: 70 000 → сумма 130 000, вернуть 30 000; сумма больше строк — не больше их', () => {
  const { db } = seed();
  const v = paid20(db);
  assert.deepEqual([quote(db, v.id, { mode: 'abs', value: 70000 }).total_after, quote(db, v.id, { mode: 'abs', value: 70000 }).refunded], [130000, 30000]);
  const big = quote(db, v.id, { mode: 'abs', value: 900000 });
  assert.deepEqual([big.discount_after, big.total_after, big.clamped], [200000, 0, true]);
});

test('переключатель «Скидка уменьшает долю врача» выключен при повышении: добавленную часть берёт клиника — доля врача прежняя 48 000', () => {
  const { db } = seed();
  const v = paid20(db);
  db.prepare("UPDATE visit_services SET status = 'completed' WHERE id = ?").run(v.vs[0]);
  change(db, v.id, { mode: 'pct', value: 50, reduces_doctor_share: false });
  assert.equal(inv(db, v.id).doctor_discount_share, 0.4, '40 000 уменьшают долю врача, 60 000 — нет');
  assert.equal(doctorFee(db), 48000);
  assert.match(inv(db, v.id).discount_note, /стало 50% \(100 000 сум\) \(доля врача — частично от цены до скидки\)$/);
  // Снизили, переключатель не трогали — прежняя смесь.
  change(db, v.id, { mode: 'pct', value: 30 });
  assert.equal(inv(db, v.id).doctor_discount_share, 0.4);
  // Снизили и сказали явно «уменьшает» — вся оставшаяся скидка уменьшает долю врача.
  const r = change(db, v.id, { mode: 'pct', value: 20, reduces_doctor_share: true });
  assert.equal(inv(db, v.id).doctor_discount_share, 1);
  // Прежнее правило отчётов (PAY_REFUND_V1): по счёту был возврат, и пока доплаты нет, доля
  // врача — в доле оставшихся денег (100 000 из 160 000); доплатили — снова целиком.
  assert.equal(r.due, 60000);
  assert.equal(doctorFee(db), 30000);
  call('record_payment', db, { invoice_id: v.id, amount: 60000, method: 'cash' });
  assert.equal(doctorFee(db), 48000);
});

test('скидка группы VIP 10 % снята до 0 %: пол группы не возвращается и при правке строк — к доплате 10 000', () => {
  const { db } = seed();
  const vip = Number(db.prepare("INSERT INTO patient_categories (name, discount_percent, active) VALUES ('VIP', 10, 1)").run().lastInsertRowid);
  const v = visit(db, { services: [CONS], category: vip });
  assert.equal(inv(db, v.id).total_amount, 90000);
  call('record_payment', db, { invoice_id: v.id, amount: 90000, method: 'cash' });
  const r = change(db, v.id, { mode: 'pct', value: 0 });
  assert.equal(r.due, 10000);
  const i = inv(db, v.id);
  assert.deepEqual([i.total_amount, i.status, i.discount_source], [100000, 'partial', 'none']);
  // Касса меняет врача строки (с расчётом) — скидка счёта остаётся 0, пол группы не ложится снова.
  setGrants(db, 'cashier', { 'cashier.lines': 'edit' });
  db.prepare("INSERT INTO users (id, username, password_hash, role, full_name, is_doctor, is_active, service_rates) VALUES (21, 'doc2', 'x', 'doctor', 'Врач Второй', 1, 1, ?)").run(JSON.stringify([{ service_id: CONS, pct: 20 }]));
  call('cashier_line_swap_paid', db, { visit_service_id: v.vs[0], doctor_id: 21 });
  assert.equal(inv(db, v.id).discount_amount, 0);
});

test('скидки строк не меняются: «Сотрудники» — консультация 100 % по ставке; меняется только скидка счёта на УЗИ', () => {
  const { db } = seed();
  const staff = Number(db.prepare("INSERT INTO patient_categories (name, discount_percent, active, discount_rates) VALUES ('Сотрудники', 0, 1, ?)")
    .run(JSON.stringify({ g: { consultation: 100 } })).lastInsertRowid);
  const v = visit(db, { services: [CONS, USG], category: staff });
  const before = db.prepare('SELECT id, total, discount_amount, discount_rate FROM invoice_items WHERE invoice_id = ? ORDER BY id').all(v.id);
  assert.deepEqual(before.map((x) => x.discount_amount), [100000, 0]);
  assert.equal(inv(db, v.id).total_amount, 200000);
  call('record_payment', db, { invoice_id: v.id, amount: 200000, method: 'cash' });
  const q = quote(db, v.id, { mode: 'pct', value: 50 });
  assert.deepEqual([q.base, q.line_discounts, q.discount_after, q.total_after, q.refunded], [200000, 100000, 100000, 100000, 100000]);
  change(db, v.id, { mode: 'pct', value: 50 });
  const after = db.prepare('SELECT id, total, discount_amount, discount_rate FROM invoice_items WHERE invoice_id = ? ORDER BY id').all(v.id);
  assert.deepEqual(after, before, 'строки счёта не тронуты');
  assert.deepEqual([inv(db, v.id).discount_amount, inv(db, v.id).total_amount], [200000, 100000]);
});

test('все строки со своей скидкой (ставки по услугам) — скидке счёта класть не на что: отказ 409', () => {
  const { db } = seed();
  const staff = Number(db.prepare("INSERT INTO patient_categories (name, discount_percent, active, discount_rates) VALUES ('Сотрудники', 20, 1, ?)")
    .run(JSON.stringify({ g: { consultation: 100 } })).lastInsertRowid);
  const v = visit(db, { services: [CONS, USG], category: staff });
  call('record_payment', db, { invoice_id: v.id, amount: inv(db, v.id).total_amount, method: 'cash' });
  refused(() => change(db, v.id, { mode: 'pct', value: 50 }), /класть не на что/, 409);
});

test('скидка после продажи (уступка деньгами) сохраняется в той же доле', () => {
  const { db } = seed();
  const v = paid20(db);
  const p = pays(db, v.id)[0];
  call('refund_payment', db, { payment_id: p.id, amount: 16000, reason: 'уступка' });
  assert.deepEqual([inv(db, v.id).total_amount, inv(db, v.id).post_sale_discount], [144000, 16000]);
  const r = change(db, v.id, { mode: 'pct', value: 50 });
  const i = inv(db, v.id);
  assert.equal(i.post_sale_discount, 10000, '16 000 × 100 000 / 160 000');
  assert.deepEqual([i.total_amount, i.paid_amount, r.refunded], [90000, 90000, 54000]);
});

test('кэшбэк: возврат разницы откатывает его в той же доле; счёт, ставший оплаченным, получает его один раз', () => {
  const { db } = seed();
  db.prepare("INSERT INTO cashback_rules (name, percent, active) VALUES ('Всем', 10, 1)").run();
  const cb = (id) => db.prepare("SELECT * FROM patient_deposits WHERE kind = 'cashback' AND invoice_id = ?").all(id);
  const a = paid20(db);
  assert.equal(cb(a.id)[0].amount, 16000);
  change(db, a.id, { mode: 'pct', value: 50 });
  const row = cb(a.id)[0];
  assert.equal(row.amount - (row.refund_amount || 0), 10000, 'кэшбэк следует за оставшимися 100 000');

  // Частично оплаченный счёт: скидку подняли — оплаченного хватает, счёт оплачен, кэшбэк начислен.
  const b = visit(db);
  call('record_payment', db, { invoice_id: b.id, amount: 150000, method: 'cash' });
  assert.equal(inv(db, b.id).status, 'partial');
  assert.equal(cb(b.id).length, 0);
  const r = change(db, b.id, { mode: 'abs', value: 50000 });
  assert.deepEqual([r.refunded, r.due, inv(db, b.id).status], [0, 0, 'paid']);
  assert.equal(cb(b.id).length, 1);
  assert.equal(cb(b.id)[0].amount, 15000);
});

test('закрытый месяц «Оплаты врачей» — отказ, и в предпросмотре тоже; счёт не тронут', () => {
  const { db } = seed();
  const v = paid20(db);
  db.prepare("INSERT INTO pay_periods (month, closed_by, total, lines) VALUES ('2026-11', 1, 0, 0)").run();
  refused(() => change(db, v.id, { mode: 'pct', value: 50 }), /Начисления врачам за этот месяц закрыты/, 409);
  refused(() => quote(db, v.id, { mode: 'pct', value: 50 }), /Начисления врачам за этот месяц закрыты/, 409);
  assert.equal(inv(db, v.id).total_amount, 160000);
});

test('право: без «Кассир может давать скидку» — 403; регистратура — 403; строка дана регистратуре, но деньги двигает касса — 403; администратор — да', () => {
  const { db } = seed();
  const a = paid20(db);
  setGrants(db, 'cashier', { 'cashier.discount': 'none' });
  refused(() => change(db, a.id, { mode: 'pct', value: 50 }), /Кассир может давать скидку/, 403);
  refused(() => quote(db, a.id, { mode: 'pct', value: 50 }), /Кассир может давать скидку/, 403);
  refused(() => change(db, a.id, { mode: 'pct', value: 50 }, registrar), /./, 403);
  setGrants(db, 'registrar', { 'cashier.discount': 'edit' });
  refused(() => change(db, a.id, { mode: 'pct', value: 50 }, registrar), /касса: кассир или администратор/, 403);
  const r = change(db, a.id, { mode: 'pct', value: 50 }, admin);
  assert.equal(r.refunded, 60000);
  assert.equal(inv(db, a.id).total_amount, 100000);
});

test('отказы: причина, неверные числа, плательщик, депозит, отменённый, стационар, чужое здание', () => {
  const { db } = seed();
  const v = paid20(db);
  refused(() => change(db, v.id, { mode: 'pct', value: 50, reason: '  ' }), /причину/, 400);
  refused(() => change(db, v.id, { mode: 'pct', value: 101 }), /не больше 100/, 400);
  refused(() => change(db, v.id, { mode: 'pct', value: -5 }), /меньше нуля/, 400);
  refused(() => change(db, v.id, { mode: 'pct' }), /меньше нуля/, 400);
  refused(() => change(db, v.id, { mode: 'x', value: 5 }), /процентом или суммой/, 400);
  const payer = Number(db.prepare("INSERT INTO payers (name, kind, active) VALUES ('Страховая', 'insurance', 1)").run().lastInsertRowid);
  const pv = visit(db);
  db.prepare('UPDATE invoices SET payer_id = ? WHERE id = ?').run(payer, pv.id);
  refused(() => change(db, pv.id, { mode: 'pct', value: 5 }), /плательщику/, 400);
  const { deposit } = createDeposit(db, { patient_id: v.pid, amount: 50000 }, registrar);
  acceptDeposit(db, { deposit_id: deposit.id, method: 'cash' }, cashier);
  const depInv = db.prepare("SELECT id FROM invoices WHERE invoice_number LIKE 'DEP-%' ORDER BY id DESC").get();
  refused(() => change(db, depInv.id, { mode: 'pct', value: 5 }), /счёт депозита/, 400);
  const vv = visit(db);
  RPC.void_invoice(db, { invoice_id: vv.id }, cashier);
  refused(() => change(db, vv.id, { mode: 'pct', value: 5 }), /отменён/, 400);
  const adm = Number(db.prepare("INSERT INTO admissions (patient_id, status) VALUES (?, 'active')").run(v.pid).lastInsertRowid);
  const iv = visit(db);
  db.prepare('UPDATE invoices SET visit_id = NULL, admission_id = ? WHERE id = ?').run(adm, iv.id);
  refused(() => change(db, iv.id, { mode: 'pct', value: 5 }), /при выписке/, 400);
  const ov = visit(db);
  db.prepare("UPDATE invoices SET sync_origin = 'B' WHERE id = ?").run(ov.id);
  refused(() => change(db, ov.id, { mode: 'pct', value: 5 }), /из филиала/, 403);
  assert.equal(inv(db, v.id).total_amount, 160000, 'отказы не тронули счёт');
});

test('та же скидка — «менять нечего», деньги не двигаются; повтор той же формы (ключ повтора) не возвращает дважды', () => {
  const { db } = seed();
  const v = paid20(db);
  const same = change(db, v.id, { mode: 'pct', value: 20 });
  assert.equal(same.changed, false);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM invoice_audit_log WHERE action = 'discount_change'").get().n, 0);
  const args = { mode: 'pct', value: 50, idempotency_key: 'k-disc-change-1' };
  change(db, v.id, args);
  const again = change(db, v.id, args);
  assert.equal(again.repeated, true);
  assert.equal(pays(db, v.id).filter((p) => p.amount < 0).length, 1);
  assert.equal(inv(db, v.id).paid_amount, 100000);
});

test('предпросмотр без значения — нынешнее состояние скидки счёта (окно открывается с ним); причина в предпросмотре не нужна', () => {
  const { db } = seed();
  const v = paid20(db);
  const s = quote(db, v.id, {});
  assert.equal(s.changed, false);
  assert.deepEqual([s.pct_before, s.discount_before, s.share_before, s.base, s.line_discounts, s.total_before, s.paid_before], [20, 40000, 1, 200000, 0, 160000, 160000]);
  refused(() => change(db, v.id, { reason: 'x' }), /меньше нуля/, 400);
});

test('скидка кассы до оплаты: у оплаченного счёта отказ говорит «оплачен», а не «оплачен (частично)», и называет «Изменить скидку»', () => {
  const { db } = seed();
  const v = paid20(db);
  assert.throws(() => call('cashier_invoice_discount', db, { invoice_id: v.id, mode: 'pct', value: 5, reason: 'x' }),
    (e) => e.status === 409 && /счёт уже оплачен\./.test(e.message) && !/частично/.test(e.message) && /Изменить скидку/.test(e.message));
  const p = visit(db);
  call('record_payment', db, { invoice_id: p.id, amount: 1000, method: 'cash' });
  assert.throws(() => call('cashier_invoice_discount', db, { invoice_id: p.id, mode: 'pct', value: 5, reason: 'x' }),
    (e) => e.status === 409 && /счёт уже оплачен частично/.test(e.message));
});
