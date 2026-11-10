// CASHIER_DISCOUNT_V1 (решение владельца 2026-11-07, п. 2) — скидка кассы при оплате:
// любой кассир, любая сумма (процент или сумма), с причиной, до приёма денег; строка
// роли «Кассир может давать скидку» (cashier.discount) выключает её у роли.
// Всё — через настоящие RPC (карта index.js) и SQLite после миграций; деньги — числами.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { RPC } from './index.js';
import { isReadOnlyRpc } from '../control/gate.js';

const admin = { id: 1, role: 'admin', full_name: 'Админ' };
const registrar = { id: 7, role: 'registrar', full_name: 'Регистратор' };
const cashier = { id: 9, role: 'cashier', full_name: 'Кассир' };
const DOC = 20;
const DAY = '2026-11-05T05:00:00Z';

function seed() {
  const db = openDb(':memory:'); migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, role, full_name, is_doctor, is_active) VALUES (?,?,?,?,?,?,1)');
  u.run(1, 'adm', 'x', 'admin', 'Админ', 0);
  u.run(7, 'reg', 'x', 'registrar', 'Регистратор', 0);
  u.run(9, 'cash', 'x', 'cashier', 'Кассир', 0);
  u.run(DOC, 'doc', 'x', 'doctor', 'Врач', 1);
  return db;
}
const call = (name, db, args, user) => RPC[name](db, args, user);
function bill(db, { price = 100000, category = null, payer = null } = {}) {
  const sid = Number(db.prepare('INSERT INTO services (name, price) VALUES (?, ?)').run('УЗИ', price).lastInsertRowid);
  const pid = Number(db.prepare('INSERT INTO patients (full_name, category_id) VALUES (?, ?)').run('Пациент', category).lastInsertRowid);
  const vid = Number(db.prepare('INSERT INTO visits (patient_id, visit_date) VALUES (?, ?)').run(pid, DAY).lastInsertRowid);
  const vs = Number(db.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status) VALUES (?, ?, ?, 1, ?, ?, 'added')")
    .run(vid, sid, DOC, price, price).lastInsertRowid);
  const out = call('create_invoice_for_visit', db, { visit_id: vid, visit_service_ids: [vs], discount_amount: 0, payer_id: payer }, admin);
  return { inv: out.invoice, vid, vs, pid };
}
const inv = (db, id) => db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
function setGrants(db, role, grants) {
  const row = db.prepare('SELECT permissions FROM role_permissions WHERE role = ?').get(role);
  const perms = row && row.permissions ? JSON.parse(row.permissions) : { sections: [], levels: {} };
  perms.grants = { ...(perms.grants || {}), ...grants };
  if (row) db.prepare('UPDATE role_permissions SET permissions = ? WHERE role = ?').run(JSON.stringify(perms), role);
  else db.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?)').run(role, JSON.stringify(perms));
}
const vip = (db, pct = 10, reduces = 1) => Number(db.prepare('INSERT INTO patient_categories (name, discount_percent, active, reduces_doctor_share) VALUES (?, ?, 1, ?)').run('VIP', pct, reduces).lastInsertRowid);

test('RPC зарегистрирован и пишет (не в READ_ONLY_RPCS)', () => {
  assert.equal(typeof RPC.cashier_invoice_discount, 'function');
  assert.equal(isReadOnlyRpc('cashier_invoice_discount'), false);
});

test('VIP 10 %: 100 000 → 90 000; касса даёт ещё 5 % от суммы к оплате — 4 500, к оплате 85 500; причина в счёте и в журнале', () => {
  const db = seed();
  const { inv: i } = bill(db, { category: vip(db, 10) });
  assert.equal(i.total_amount, 90000);
  const r = call('cashier_invoice_discount', db, { invoice_id: i.id, mode: 'pct', value: 5, reason: 'постоянный пациент' }, cashier);
  assert.equal(r.discount, 4500);
  const after = inv(db, i.id);
  assert.deepEqual([after.subtotal, after.discount_amount, after.total_amount, after.status], [100000, 14500, 85500, 'unpaid']);
  assert.deepEqual([after.manual_discount, after.manual_base], [14500, 100000], 'ручная часть «как её дали» — вся скидка остатка');
  assert.equal(after.doctor_discount_share, 1);
  assert.match(after.discount_note, /Скидка группы «VIP» — 10%; Касса: постоянный пациент — 5% — 4 500 сум/);
  const log = db.prepare("SELECT * FROM invoice_audit_log WHERE action = 'discount'").all();
  assert.equal(log.length, 1);
  assert.equal(log[0].reason, 'постоянный пациент');
  assert.equal(log[0].amount, 85500);
  assert.equal(log[0].actor_user_id, cashier.id);
});

test('сумма 30 000 без группы, «скидка уменьшает долю врача» выключена: к оплате 70 000, доля скидки для врача 0', () => {
  const db = seed();
  const { inv: i } = bill(db);
  call('cashier_invoice_discount', db, { invoice_id: i.id, mode: 'abs', value: 30000, reason: 'жалоба', reduces_doctor_share: false }, cashier);
  const after = inv(db, i.id);
  assert.deepEqual([after.discount_amount, after.total_amount, after.doctor_discount_share], [30000, 70000, 0]);
  assert.match(after.discount_note, /доля врача — от цены до скидки/);
});

test('группа (уменьшает) 10 000 + касса (не уменьшает) 30 000 — доля врача уменьшается на 10 000 из 40 000 (0,25)', () => {
  const db = seed();
  const { inv: i } = bill(db, { category: vip(db, 10) });
  call('cashier_invoice_discount', db, { invoice_id: i.id, mode: 'abs', value: 30000, reason: 'акция', reduces_doctor_share: false }, cashier);
  assert.equal(inv(db, i.id).doctor_discount_share, 0.25);
});

test('скидка больше остатка — не больше суммы к оплате; 100 % — счёт закрыт на 0, строка в очереди', () => {
  const db = seed();
  const { inv: i, vs } = bill(db);
  const r = call('cashier_invoice_discount', db, { invoice_id: i.id, mode: 'abs', value: 500000, reason: 'благотворительность' }, cashier);
  assert.equal(r.discount, 100000);
  const after = inv(db, i.id);
  assert.deepEqual([after.discount_amount, after.total_amount, after.status], [100000, 0, 'paid']);
  assert.equal(db.prepare('SELECT status FROM visit_services WHERE id = ?').get(vs).status, 'queued');
  assert.throws(() => call('cashier_invoice_discount', db, { invoice_id: i.id, mode: 'pct', value: 10, reason: 'ещё' }, cashier), /до оплаты/);
});

test('отказы: без причины, процент > 100, ноль, счёт плательщику, частично оплачен, закрытый месяц', () => {
  const db = seed();
  const { inv: i } = bill(db);
  assert.throws(() => call('cashier_invoice_discount', db, { invoice_id: i.id, mode: 'pct', value: 5, reason: '  ' }, cashier), /причину/);
  assert.throws(() => call('cashier_invoice_discount', db, { invoice_id: i.id, mode: 'pct', value: 101, reason: 'x' }, cashier), /не больше 100/);
  assert.throws(() => call('cashier_invoice_discount', db, { invoice_id: i.id, mode: 'abs', value: 0, reason: 'x' }, cashier), /больше нуля/);
  const payer = Number(db.prepare("INSERT INTO payers (name, kind, active) VALUES ('Страховая', 'insurance', 1)").run().lastInsertRowid);
  const { inv: p } = bill(db, { payer });
  assert.throws(() => call('cashier_invoice_discount', db, { invoice_id: p.id, mode: 'pct', value: 5, reason: 'x' }, cashier), /плательщику/);
  const { inv: part } = bill(db);
  call('record_payment', db, { invoice_id: part.id, amount: 10000, method: 'cash' }, cashier);
  assert.throws(() => call('cashier_invoice_discount', db, { invoice_id: part.id, mode: 'pct', value: 5, reason: 'x' }, cashier), /до оплаты/);
  const { inv: closed } = bill(db);
  db.prepare("INSERT INTO pay_periods (month, closed_by, total, lines) VALUES ('2026-11', 1, 0, 0)").run();
  assert.throws(() => call('cashier_invoice_discount', db, { invoice_id: closed.id, mode: 'pct', value: 5, reason: 'x' }, cashier), /закрыты/);
  assert.equal(inv(db, i.id).discount_amount, 0, 'отказ не тронул счёт');
});

test('роль: кассир и администратор — да по умолчанию; «Кассир может давать скидку: Нет» — 403; регистратура без кассы — 403', () => {
  const db = seed();
  const { inv: a } = bill(db);
  call('cashier_invoice_discount', db, { invoice_id: a.id, mode: 'pct', value: 5, reason: 'x' }, admin);
  setGrants(db, 'cashier', { 'cashier.discount': 'none' });
  const { inv: b } = bill(db);
  assert.throws(() => call('cashier_invoice_discount', db, { invoice_id: b.id, mode: 'pct', value: 5, reason: 'x' }, cashier),
    (e) => e.status === 403 && /Кассир может давать скидку/.test(e.message));
  setGrants(db, 'cashier', { 'cashier.discount': 'edit' });
  call('cashier_invoice_discount', db, { invoice_id: b.id, mode: 'pct', value: 5, reason: 'x' }, cashier);
  const { inv: c } = bill(db);
  assert.throws(() => call('cashier_invoice_discount', db, { invoice_id: c.id, mode: 'pct', value: 5, reason: 'x' }, registrar), (e) => e.status === 403);
});

test('повтор той же формы (ключ повтора) скидку не удваивает', () => {
  const db = seed();
  const { inv: i } = bill(db);
  const args = { invoice_id: i.id, mode: 'abs', value: 10000, reason: 'x', idempotency_key: 'k-disc-1' };
  call('cashier_invoice_discount', db, args, cashier);
  call('cashier_invoice_discount', db, args, cashier);
  assert.equal(inv(db, i.id).total_amount, 90000);
});

test('после скидки кассы касса убирает услугу — скидка счёта уменьшается в той же доле (ручная часть «как её дали»)', () => {
  const db = seed();
  const sid = Number(db.prepare("INSERT INTO services (name, price) VALUES ('ЭКГ', 50000)").run().lastInsertRowid);
  const { inv: i, vid } = bill(db);   // 100 000
  call('cashier_line_add', db, { invoice_id: i.id, service_id: sid, doctor_id: DOC }, admin);
  assert.equal(inv(db, i.id).total_amount, 150000);
  call('cashier_invoice_discount', db, { invoice_id: i.id, mode: 'abs', value: 30000, reason: 'x' }, cashier);   // 20 % от 150 000
  const ecg = db.prepare('SELECT id FROM visit_services WHERE visit_id = ? AND service_id = ?').get(vid, sid).id;
  call('cashier_line_remove', db, { visit_service_id: ecg }, admin);
  const after = inv(db, i.id);
  assert.deepEqual([after.subtotal, after.discount_amount, after.total_amount], [100000, 20000, 80000]);
});

// DISCOUNT_CHANGE_PAID_V1 (3.23.0) — отказ скидки до оплаты называет статус как есть: у
// оплаченного счёта прежде было «оплачен (частично)»; и говорит, где скидку меняют после оплаты.
test('DISCOUNT_CHANGE_PAID_V1: отказ «до оплаты» — «оплачен» / «оплачен частично» / «переведён в долг» и «Изменить скидку»', () => {
  const db = seed();
  const { inv: full } = bill(db);
  call('record_payment', db, { invoice_id: full.id, amount: 100000, method: 'cash' }, cashier);
  const { inv: part } = bill(db);
  call('record_payment', db, { invoice_id: part.id, amount: 10000, method: 'cash' }, cashier);
  const { inv: debt } = bill(db);
  call('mark_invoice_debt', db, { invoice_id: debt.id }, cashier);
  const said = (id) => { try { call('cashier_invoice_discount', db, { invoice_id: id, mode: 'pct', value: 5, reason: 'x' }, cashier); } catch (e) { return [e.status, e.message]; } return null; };
  assert.deepEqual(said(full.id), [409, 'Скидку дают до оплаты: счёт уже оплачен. После оплаты скидку меняют кнопкой «Изменить скидку».']);
  assert.match(said(part.id)[1], /счёт уже оплачен частично\./);
  assert.match(said(debt.id)[1], /счёт уже переведён в долг\./);
});
