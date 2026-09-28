// CASHIER_HEAD_V1 (2026-09-28) — старший кассир и право кассы «Исправляет
// услуги в счёте» (ключ cashier.lines).
//
// Владелец: «we need to add a head cashier and fix in the roles for the
// cashier, so it can change service and provider for appointed + add service,
// and if created invoice. It should be switchable in the roles so cashier
// either only accepts [payments] or accepts and makes small fixes.»
//
// Всё — через настоящие RPC (карта index.js) и SQLite после миграций; одна
// проверка — через HTTP (createApp): сессия несёт дополнительную роль.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { RPC } from './index.js';
import { createInvoiceForVisit, recordPayment } from './billing.js';
import { cashMove, shiftReport, closeCashShift } from './cashier.js';
import { doctorPaySummary } from './reports.js';
import { isReadOnlyRpc } from '../control/gate.js';
import { VALID_ROLES, EXTRA_ONLY_ROLES, PRIMARY_ROLES } from '../roles.js';
import { hashPassword } from '../auth.js';
import { createApp } from '../../app.js';
import { licensedDataDir } from '../control/licensed-fixture.js';
import { listen } from '../../../control-plane/server/test-helpers/listen.js';

const admin = { id: 1, role: 'admin', full_name: 'Админ' };
const registrar = { id: 7, role: 'registrar', full_name: 'Регистратор' };
const cashier = { id: 9, role: 'cashier', full_name: 'Кассир' };
const cashier2 = { id: 10, role: 'cashier', full_name: 'Кассир 2' };
const head = { id: 11, role: 'cashier', extra_roles: ['head_cashier'], full_name: 'Старший кассир' };
const DOC = 20, DOC2 = 21, NURSE = 22, FIRED = 23;
const DAY = '2026-09-10T05:00:00Z';

function seed() {
  const db = openDb(':memory:'); migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, role, full_name, is_doctor, is_active, extra_roles) VALUES (?,?,?,?,?,?,?,?)');
  u.run(1, 'adm', hashPassword('password1'), 'admin', 'Админ', 0, 1, '[]');
  u.run(7, 'reg', hashPassword('password1'), 'registrar', 'Регистратор', 0, 1, '[]');
  u.run(9, 'cash', hashPassword('password1'), 'cashier', 'Кассир', 0, 1, '[]');
  u.run(10, 'cash2', hashPassword('password1'), 'cashier', 'Кассир 2', 0, 1, '[]');
  u.run(11, 'head', hashPassword('password1'), 'cashier', 'Старший кассир', 0, 1, '["head_cashier"]');
  u.run(DOC, 'doc', 'x', 'doctor', 'Врач Первый', 1, 1, '[]');
  u.run(DOC2, 'doc2', 'x', 'doctor', 'Врач Второй', 1, 1, '[]');
  u.run(NURSE, 'nurse', 'x', 'nurse', 'Медсестра', 0, 1, '[]');
  u.run(FIRED, 'old', 'x', 'doctor', 'Уволенный', 1, 0, '[]');
  return db;
}
const svc = (db, name, price, extra = {}) => {
  const cols = ['name', 'price', ...Object.keys(extra)];
  return Number(db.prepare(`INSERT INTO services (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(name, price, ...Object.values(extra)).lastInsertRowid);
};
function visit(db, { category = null, at = DAY } = {}) {
  const pid = Number(db.prepare('INSERT INTO patients (full_name, category_id) VALUES (?, ?)').run('Пациент', category).lastInsertRowid);
  const vid = Number(db.prepare('INSERT INTO visits (patient_id, visit_date) VALUES (?, ?)').run(pid, at).lastInsertRowid);
  return { pid, vid };
}
const line = (db, vid, serviceId, doctorId = null, extra = {}) => {
  const r = { visit_id: vid, service_id: serviceId, doctor_id: doctorId, quantity: 1, unit_price: 0, total: 0, status: 'added', ...extra };
  const cols = Object.keys(r);
  return Number(db.prepare(`INSERT INTO visit_services (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...Object.values(r)).lastInsertRowid);
};
const rates = (db, userId, list) => db.prepare('UPDATE users SET service_rates = ? WHERE id = ?').run(JSON.stringify(list), userId);
function setGrants(db, role, grants) {
  const row = db.prepare('SELECT permissions FROM role_permissions WHERE role = ?').get(role);
  const perms = row && row.permissions ? JSON.parse(row.permissions) : { sections: [], levels: {} };
  perms.grants = { ...(perms.grants || {}), ...grants };
  if (row) db.prepare('UPDATE role_permissions SET permissions = ? WHERE role = ?').run(JSON.stringify(perms), role);
  else db.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?)').run(role, JSON.stringify(perms));
}
const inv = (db, id) => db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
const vsRow = (db, id) => db.prepare('SELECT * FROM visit_services WHERE id = ?').get(id);
const audit = (db, action) => db.prepare('SELECT * FROM invoice_audit_log WHERE action = ? ORDER BY id').all(action);
const call = (name, db, args, user) => RPC[name](db, args, user);
const refused = (fn, re = /./, status = 403) => assert.throws(fn, (e) => e.status === status && re.test(e.message));

// Типовая клиника: приём 100 000 (у DOC своя цена 150 000, у DOC2 — 120 000),
// УЗИ 80 000, анализ 40 000; счёт по визиту на приём у DOC, не оплачен.
function clinic({ category = null } = {}) {
  const db = seed();
  const CONS = svc(db, 'Приём терапевта', 100000);
  const USG = svc(db, 'УЗИ', 80000);
  const LAB = svc(db, 'Анализ крови', 40000);
  rates(db, DOC, [{ service_id: CONS, price: 150000, pct: 10 }]);
  rates(db, DOC2, [{ service_id: CONS, price: 120000, pct: 20 }, { service_id: USG, pct: 10 }]);
  const { pid, vid } = visit(db, { category });
  const vs = line(db, vid, CONS, DOC);
  const out = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs] }, registrar);
  return { db, CONS, USG, LAB, pid, vid, vs, invoiceId: out.invoice.id };
}

// ─── Право выключено: касса только принимает оплату ────────────────────────

test('право не выдано: кассиру отказаны все четыре исправления, и ничего не меняется', () => {
  const { db, CONS, USG, vid, vs, invoiceId } = clinic();
  const before = JSON.stringify([inv(db, invoiceId), vsRow(db, vs)]);
  const re = /Исправлять услуги в счёте/;
  refused(() => call('cashier_line_change_service', db, { visit_service_id: vs, new_service_id: USG }, cashier), re);
  refused(() => call('cashier_line_set_doctor', db, { visit_service_id: vs, doctor_id: DOC2 }, cashier), re);
  refused(() => call('cashier_line_add', db, { invoice_id: invoiceId, service_id: USG }, cashier), re);
  refused(() => call('cashier_line_remove', db, { visit_service_id: vs }, cashier), re);
  refused(() => call('cashier_line_performers', db, { visit_id: vid, service_id: CONS }, cashier), re);
  // Прежние двери карты пациента — тоже отказ кассиру.
  refused(() => call('change_unpaid_service', db, { visit_service_id: vs, new_service_id: USG }, cashier));
  assert.equal(JSON.stringify([inv(db, invoiceId), vsRow(db, vs)]), before);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM visit_services').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM invoice_audit_log').get().n, 0);
});

test('явное «Нет» в «Ролях» — отказ; «Изменение» — пускает', () => {
  const { db, USG, vs } = clinic();
  setGrants(db, 'cashier', { 'cashier.lines': 'none' });
  refused(() => call('cashier_line_change_service', db, { visit_service_id: vs, new_service_id: USG }, cashier));
  setGrants(db, 'cashier', { 'cashier.lines': 'edit' });
  assert.equal(call('cashier_line_change_service', db, { visit_service_id: vs, new_service_id: USG }, cashier).changed, true);
});

test('закрытый раздел «Касса» закрывает и право внутри него', () => {
  const { db, USG, vs } = clinic();
  setGrants(db, 'cashier', { cashier: 'none', 'cashier.lines': 'edit' });
  refused(() => call('cashier_line_change_service', db, { visit_service_id: vs, new_service_id: USG }, cashier));
});

test('регистратура и администратор сохраняют прежние права без всякой настройки', () => {
  const { db, USG, LAB, vs, invoiceId } = clinic();
  assert.equal(call('cashier_line_change_service', db, { visit_service_id: vs, new_service_id: USG }, registrar).changed, true);
  assert.equal(call('cashier_line_set_doctor', db, { visit_service_id: vs, doctor_id: DOC2 }, admin).line.doctor_id, DOC2);
  const add = call('cashier_line_add', db, { invoice_id: invoiceId, service_id: LAB }, registrar);
  assert.equal(add.invoice.id, invoiceId);
});

// ─── Право включено ────────────────────────────────────────────────────────

test('замена услуги: личная цена врача строки, итоги счёта, журнал', () => {
  const { db, USG, CONS, vs, invoiceId } = clinic();
  setGrants(db, 'cashier', { 'cashier.lines': 'edit' });
  assert.equal(inv(db, invoiceId).total_amount, 150000, 'личная цена DOC за приём');
  // DOC у УЗИ своей цены нет — каталог.
  const r = call('cashier_line_change_service', db, { visit_service_id: vs, new_service_id: USG }, cashier);
  assert.equal(r.line.unit_price, 80000);
  assert.deepEqual([r.invoice.subtotal, r.invoice.discount_amount, r.invoice.total_amount], [80000, 0, 80000]);
  const item = db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ?').get(invoiceId);
  assert.equal(item.service_id, USG);
  assert.equal(item.total, 80000);
  const log = audit(db, 'line_change_service');
  assert.equal(log.length, 1);
  assert.equal(log[0].actor_user_id, cashier.id);
  assert.equal(log[0].invoice_id, invoiceId);
  assert.equal(log[0].amount, 80000);
  assert.match(log[0].notes, /Приём терапевта.*150 000.*→.*УЗИ.*80 000/);
  // Обратно — снова личная цена DOC.
  const back = call('cashier_line_change_service', db, { visit_service_id: vs, new_service_id: CONS }, cashier);
  assert.equal(back.invoice.total_amount, 150000);
});

test('смена врача в неоплаченном счёте: цена нового врача, скидка группы, журнал, доля врача', () => {
  // VIP 10 %: скидка группы — пол, и он же ложится на новую цену.
  const d = seed();
  const cons = svc(d, 'Приём терапевта', 100000);
  rates(d, DOC, [{ service_id: cons, price: 150000, pct: 10 }]);
  rates(d, DOC2, [{ service_id: cons, price: 120000, pct: 20 }]);
  const vip = Number(d.prepare("INSERT INTO patient_categories (name, discount_percent, active) VALUES ('VIP', 10, 1)").run().lastInsertRowid);
  const { vid } = visit(d, { category: vip });
  const vs = line(d, vid, cons, DOC);
  const invoiceId = createInvoiceForVisit(d, { visit_id: vid, visit_service_ids: [vs] }, registrar).invoice.id;
  setGrants(d, 'cashier', { 'cashier.lines': 'edit' });
  assert.deepEqual([inv(d, invoiceId).subtotal, inv(d, invoiceId).discount_amount, inv(d, invoiceId).total_amount], [150000, 15000, 135000]);
  const r = call('cashier_line_set_doctor', d, { visit_service_id: vs, doctor_id: DOC2 }, cashier);
  assert.equal(r.line.doctor_id, DOC2);
  assert.equal(r.line.unit_price, 120000);
  assert.deepEqual([r.invoice.subtotal, r.invoice.discount_amount, r.invoice.total_amount], [120000, 12000, 108000]);
  const log = audit(d, 'line_change_doctor');
  assert.equal(log.length, 1);
  assert.match(log[0].notes, /Врач Первый.*→.*Врач Второй/);
  assert.equal(log[0].amount, 108000);
  // Оплатили, врач принял — доля у НОВОГО врача, от цены после скидки.
  recordPayment(d, { invoice_id: invoiceId, amount: 108000, method: 'cash' }, cashier);
  d.prepare("UPDATE visit_services SET status = 'completed' WHERE id = ?").run(vs);
  const s2 = doctorPaySummary(d, { doctor_id: DOC2, from: '2026-09-01', to: '2026-09-30' }, admin);
  assert.equal(s2.lines.length, 1);
  assert.equal(s2.outpatient.fee, 21600, '20 % от 108 000');
  const s1 = doctorPaySummary(d, { doctor_id: DOC, from: '2026-09-01', to: '2026-09-30' }, admin);
  assert.equal(s1.lines.length, 0, 'прежний врач по этой строке ничего не получает');
});

test('смена врача у строки пакета: скидка пакета пересчитывается от новой цены', () => {
  const db = seed();
  const CONS = svc(db, 'Приём', 100000);
  rates(db, DOC2, [{ service_id: CONS, price: 200000 }]);
  const pkg = Number(db.prepare("INSERT INTO service_templates (name, service_ids, discount_percent) VALUES ('Пакет', ?, 20)").run(JSON.stringify([CONS])).lastInsertRowid);
  const { vid } = visit(db);
  const l = line(db, vid, CONS, DOC, { package_id: pkg });
  const o = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [l] }, registrar);
  assert.equal(o.invoice.total_amount, 80000);
  setGrants(db, 'cashier', { 'cashier.lines': 'edit' });
  const r = call('cashier_line_set_doctor', db, { visit_service_id: l, doctor_id: DOC2 }, cashier);
  assert.deepEqual([r.invoice.subtotal, r.invoice.discount_amount, r.invoice.total_amount], [200000, 40000, 160000]);
  assert.equal(db.prepare('SELECT discount_amount FROM invoice_items WHERE invoice_id = ?').get(o.invoice.id).discount_amount, 40000);
});

test('добавить услугу: ложится в открытый неоплаченный счёт по цене врача и со скидкой группы', () => {
  const base = seed();
  const CONS = svc(base, 'Приём', 100000);
  const USG = svc(base, 'УЗИ', 80000);
  rates(base, DOC2, [{ service_id: USG, price: 90000 }]);
  const vip = Number(base.prepare("INSERT INTO patient_categories (name, discount_percent, active) VALUES ('VIP', 10, 1)").run().lastInsertRowid);
  const { vid } = visit(base, { category: vip });
  const l = line(base, vid, CONS, DOC);
  const o = createInvoiceForVisit(base, { visit_id: vid, visit_service_ids: [l] }, registrar);
  assert.equal(o.invoice.total_amount, 90000);
  setGrants(base, 'cashier', { 'cashier.lines': 'edit' });
  const r = call('cashier_line_add', base, { invoice_id: o.invoice.id, service_id: USG, doctor_id: DOC2 }, cashier);
  assert.equal(r.invoice.id, o.invoice.id);
  assert.equal(r.invoice_created, false);
  assert.equal(r.line.unit_price, 90000, 'личная цена DOC2 за УЗИ');
  assert.equal(r.line.status, 'added', 'в очередь — после оплаты, как обычно');
  assert.equal(r.line.created_by, cashier.id);
  assert.deepEqual([r.invoice.subtotal, r.invoice.discount_amount, r.invoice.total_amount], [190000, 19000, 171000]);
  assert.equal(base.prepare('SELECT COUNT(*) n FROM invoice_items WHERE invoice_id = ?').get(o.invoice.id).n, 2);
  // Оплата ставит обе строки в очередь.
  recordPayment(base, { invoice_id: o.invoice.id, amount: 171000, method: 'cash' }, cashier);
  assert.equal(vsRow(base, r.line.id).status, 'queued');
  const log = audit(base, 'line_add');
  assert.equal(log.length, 1);
  assert.match(log[0].notes, /УЗИ.*Врач Второй.*90 000/);
});

test('добавить услугу, когда счёт уже оплачен: выставляется новый счёт', () => {
  const { db, invoiceId, USG, vid } = clinic();
  setGrants(db, 'cashier', { 'cashier.lines': 'edit' });
  recordPayment(db, { invoice_id: invoiceId, amount: 150000, method: 'cash' }, cashier);
  const r = call('cashier_line_add', db, { invoice_id: invoiceId, service_id: USG }, cashier);
  assert.equal(r.invoice_created, true);
  assert.notEqual(r.invoice.id, invoiceId);
  assert.equal(r.invoice.visit_id, vid);
  assert.equal(r.invoice.total_amount, 80000);
  assert.equal(r.invoice.status, 'unpaid');
  assert.equal(inv(db, invoiceId).total_amount, 150000, 'оплаченный счёт не тронут');
  assert.equal(audit(db, 'line_add')[0].invoice_id, r.invoice.id);
});

test('добавить услугу, которой нужен врач, без врача — отказ; тариф повторного визита спрашивается', () => {
  const { db, invoiceId, vid, pid } = clinic();
  setGrants(db, 'cashier', { 'cashier.lines': 'edit' });
  const NEED = svc(db, 'Операция', 500000, { requires_doctor: 1 });
  refused(() => call('cashier_line_add', db, { invoice_id: invoiceId, service_id: NEED }, cashier), /врач/, 400);
  // Повторный визит: прошлый приём у этого пациента неделю назад.
  const REP = svc(db, 'Осмотр', 100000, { price_repeat: 40000, repeat_days_from: 1, repeat_days_to: 30 });
  const old = Number(db.prepare("INSERT INTO visits (patient_id, visit_date) VALUES (?, '2026-09-03T05:00:00Z')").run(pid).lastInsertRowid);
  line(db, old, REP, null, { status: 'completed' });
  const r = call('cashier_line_add', db, { visit_id: vid, service_id: REP }, cashier);
  assert.equal(r.line.price_tier, 'repeat');
  assert.equal(r.line.unit_price, 40000);
});

test('убрать не начатую неоплаченную строку: счёт пересчитан, журнал', () => {
  const { db, invoiceId, USG, vs } = clinic();
  setGrants(db, 'cashier', { 'cashier.lines': 'edit' });
  const add = call('cashier_line_add', db, { invoice_id: invoiceId, service_id: USG }, cashier);
  assert.equal(add.invoice.total_amount, 230000);
  const r = call('cashier_line_remove', db, { visit_service_id: add.line.id }, cashier);
  assert.equal(r.removed, true);
  assert.equal(inv(db, invoiceId).total_amount, 150000);
  const log = audit(db, 'line_remove');
  assert.equal(log.length, 1);
  assert.equal(log[0].invoice_id, invoiceId);
  // Последняя строка — счёт удаляется, журнал остаётся (без ссылки на удалённый счёт).
  call('cashier_line_remove', db, { visit_service_id: vs }, cashier);
  assert.equal(inv(db, invoiceId), undefined);
  const last = audit(db, 'line_remove')[1];
  assert.equal(last.invoice_id, null);
  assert.match(last.invoice_number, /INV-/);
});

// ─── Всегда отказ ──────────────────────────────────────────────────────────

test('оплаченная и частично оплаченная строка — отказ всем исправлениям (через «Вернуть услугу»)', () => {
  const { db, invoiceId, USG, vs } = clinic();
  setGrants(db, 'cashier', { 'cashier.lines': 'edit' });
  recordPayment(db, { invoice_id: invoiceId, amount: 50000, method: 'cash' }, cashier);   // частично
  const re = /оплачен/;
  refused(() => call('cashier_line_change_service', db, { visit_service_id: vs, new_service_id: USG }, cashier), re, 400);
  refused(() => call('cashier_line_set_doctor', db, { visit_service_id: vs, doctor_id: DOC2 }, cashier), re, 400);
  refused(() => call('cashier_line_remove', db, { visit_service_id: vs }, cashier), re, 400);
  // Добавить в частично оплаченный счёт нельзя — уходит новым счётом.
  const r = call('cashier_line_add', db, { invoice_id: invoiceId, service_id: USG }, cashier);
  assert.equal(r.invoice_created, true);
  assert.equal(inv(db, invoiceId).total_amount, 150000);
});

test('закрытый месяц оплаты врачей — отказ всем четырём исправлениям', () => {
  const { db, invoiceId, USG, vs, vid } = clinic();
  setGrants(db, 'cashier', { 'cashier.lines': 'edit' });
  db.prepare("INSERT INTO pay_periods (month, closed_by, total, lines) VALUES ('2026-09', 1, 0, 0)").run();
  const re = /месяц/;
  refused(() => call('cashier_line_change_service', db, { visit_service_id: vs, new_service_id: USG }, cashier), re, 409);
  refused(() => call('cashier_line_set_doctor', db, { visit_service_id: vs, doctor_id: DOC2 }, cashier), re, 409);
  refused(() => call('cashier_line_add', db, { invoice_id: invoiceId, service_id: USG }, cashier), re, 409);
  refused(() => call('cashier_line_add', db, { visit_id: vid, service_id: USG }, cashier), re, 409);
  refused(() => call('cashier_line_remove', db, { visit_service_id: vs }, cashier), re, 409);
  assert.equal(inv(db, invoiceId).total_amount, 150000);
});

test('исполнитель: работающий, оказывающий услуги; список — с ценами, назначенные первыми', () => {
  const { db, vs, CONS, vid } = clinic();
  setGrants(db, 'cashier', { 'cashier.lines': 'edit' });
  refused(() => call('cashier_line_set_doctor', db, { visit_service_id: vs, doctor_id: FIRED }, cashier), /уволен/, 400);
  refused(() => call('cashier_line_set_doctor', db, { visit_service_id: vs, doctor_id: cashier2.id }, cashier), /врач/, 400);
  refused(() => call('cashier_line_add', db, { visit_id: vid, service_id: svc(db, 'Перевязка', 1, { type: 'procedure' }), doctor_id: cashier2.id }, cashier), /врач, медсестра или лаборант/, 400);
  refused(() => call('cashier_line_set_doctor', db, { visit_service_id: vs, doctor_id: 999 }, cashier), /нет/, 400);
  // Приём — консультация (группа услуг по умолчанию): его ведёт врач.
  refused(() => call('cashier_line_set_doctor', db, { visit_service_id: vs, doctor_id: NURSE }, cashier), /врач/, 400);
  // Список, который экран предлагает, — те же двое, с их ценами.
  const p = call('cashier_line_performers', db, { visit_id: vid, service_id: CONS }, cashier);
  assert.deepEqual(p.performers.map((x) => [x.id, x.unit_price]).sort(), [[DOC, 150000], [DOC2, 120000]]);
  assert.equal(isReadOnlyRpc('cashier_line_performers'), true);
});

test('начатая работа — исполнителя не меняют; товарную строку — тоже', () => {
  const { db, vs } = clinic();
  setGrants(db, 'cashier', { 'cashier.lines': 'edit' });
  db.prepare("UPDATE visit_services SET status = 'in_progress' WHERE id = ?").run(vs);
  refused(() => call('cashier_line_set_doctor', db, { visit_service_id: vs, doctor_id: DOC2 }, cashier), /оказывается/, 400);
});

// ─── Старший кассир ───────────────────────────────────────────────────────

test('старший кассир — дополнительная роль, в «Ролях» есть своя строка прав', () => {
  assert.ok(EXTRA_ONLY_ROLES.includes('head_cashier'));
  assert.ok(VALID_ROLES.includes('head_cashier'));
  assert.ok(!PRIMARY_ROLES.includes('head_cashier'), 'основной ролью не бывает');
  const db = seed();
  const row = db.prepare("SELECT permissions FROM role_permissions WHERE role = 'head_cashier'").get();
  assert.ok(row, 'миграция 218 заводит строку прав');
  const p = JSON.parse(row.permissions);
  assert.ok(p.sections.includes('cashier') && p.sections.includes('cashier-head'));
  assert.equal(p.grants['cashier.lines'], 'edit');
  // Кассиру по умолчанию право не выдано.
  const c = JSON.parse(db.prepare("SELECT permissions FROM role_permissions WHERE role = 'cashier'").get().permissions);
  assert.ok(!(c.grants && c.grants['cashier.lines']));
});

test('старший кассир исправляет услуги без настройки роли кассира', () => {
  const { db, USG, vs } = clinic();
  assert.equal(call('cashier_line_change_service', db, { visit_service_id: vs, new_service_id: USG }, head).changed, true);
  // Клиника закрыла право кассирам — старшему оно остаётся (самая щедрая из ролей).
  setGrants(db, 'cashier', { 'cashier.lines': 'none' });
  assert.equal(call('cashier_line_set_doctor', db, { visit_service_id: vs, doctor_id: DOC2 }, head).line.doctor_id, DOC2);
});

test('старший кассир видит и закрывает чужую смену; обычный кассир — нет', () => {
  const db = seed();
  cashMove(db, { kind: 'in', amount: 5000, note: 'Размен' }, cashier);
  const shift = db.prepare('SELECT * FROM cash_shifts WHERE cashier_id = ?').get(cashier.id);
  refused(() => shiftReport(db, { shift_id: shift.id }, cashier2), /свою/);
  refused(() => closeCashShift(db, { shift_id: shift.id, counted_amount: 5000 }, cashier2), /свою/);
  const rep = shiftReport(db, { shift_id: shift.id }, head);
  assert.equal(rep.shift.id, shift.id);
  assert.equal(rep.expected_drawer, 5000);
  const closed = closeCashShift(db, { shift_id: shift.id, counted_amount: 4000 }, head);
  assert.equal(closed.shift.status, 'closed');
  assert.equal(closed.shift.over_short, -1000);
});

test('«Старший кассир» только на просмотр: смотрит чужую смену, закрыть не может', () => {
  const db = seed();
  const perms = { sections: ['cashier', 'cashier-head'], levels: { cashier: 'editor', 'cashier-head': 'viewer' } };
  db.prepare('UPDATE role_permissions SET permissions = ? WHERE role = ?').run(JSON.stringify(perms), 'head_cashier');
  cashMove(db, { kind: 'in', amount: 1000, note: 'Размен' }, cashier);
  const shift = db.prepare('SELECT * FROM cash_shifts WHERE cashier_id = ?').get(cashier.id);
  assert.equal(shiftReport(db, { shift_id: shift.id }, head).shift.id, shift.id);
  refused(() => closeCashShift(db, { shift_id: shift.id, counted_amount: 1000 }, head), /свою/);
});

test('HTTP: сессия старшего кассира несёт надстройку — исправление проходит, у кассира — 403', async () => {
  const { db, USG, invoiceId } = clinic();
  const server = await listen(createApp(db, { dataDir: licensedDataDir() }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async (username) => {
    const res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'password1' }) });
    return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  };
  const rpc = (cookie, name, args) => fetch(base + '/api/rpc/' + name, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(args) });
  try {
    const c = await login('cash');
    const no = await rpc(c, 'cashier_line_add', { invoice_id: invoiceId, service_id: USG });
    assert.equal(no.status, 403);
    const hc = await login('head');
    const ok = await rpc(hc, 'cashier_line_add', { invoice_id: invoiceId, service_id: USG });
    assert.equal(ok.status, 200);
    assert.equal(inv(db, invoiceId).total_amount, 230000);
  } finally { server.close(); db.close(); }
});

// Ревью ролей (2026-09-28): кассир, сохранённый на старом экране «Роли»
// (до 3.2), несёт levels.cashier 'viewer' и grants.cashier 'view' — выбор
// старого экрана, а не человека. Новая логика не читает это как «касса только
// на просмотр»: оплату такой кассир принимает, как в 3.11, а право
// исправлений по-прежнему решает только cashier.lines.
test('кассир со старым «просмотром» кассы принимает оплату; исправления — только по cashier.lines', () => {
  const { db, invoiceId, USG, vs } = clinic();
  db.prepare('UPDATE role_permissions SET permissions = ? WHERE role = ?')
    .run(JSON.stringify({ sections: ['cashier', 'patients'], levels: { cashier: 'viewer', patients: 'editor' }, grants: { cashier: 'view' } }), 'cashier');
  refused(() => call('cashier_line_change_service', db, { visit_service_id: vs, new_service_id: USG }, cashier));
  setGrants(db, 'cashier', { 'cashier.lines': 'edit' });
  assert.equal(call('cashier_line_change_service', db, { visit_service_id: vs, new_service_id: USG }, cashier).changed, true);
  const paid = call('record_payment', db, { invoice_id: invoiceId, amount: 80000, method: 'cash' }, cashier);
  assert.equal(paid.invoice.status, 'paid');
});

// ═══ Ревью CASHIER_HEAD_V1 (2026-09-28) ═══════════════════════════════════

test('I1: бесплатный счёт стал платным после смены врача — строка снова ждёт кассу, номер очереди снят', () => {
  const db = seed();
  const FREE = svc(db, 'Осмотр', 0);
  rates(db, DOC2, [{ service_id: FREE, price: 50000 }]);
  const { vid } = visit(db);
  const l = line(db, vid, FREE, DOC);
  const o = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [l] }, registrar);
  assert.equal(o.invoice.status, 'paid');
  assert.equal(vsRow(db, l).status, 'queued');
  db.prepare("UPDATE visit_services SET queue_key = 'doc:20:x', queue_no = 3 WHERE id = ?").run(l);
  setGrants(db, 'cashier', { 'cashier.lines': 'edit' });
  const r = call('cashier_line_set_doctor', db, { visit_service_id: l, doctor_id: DOC2 }, cashier);
  assert.equal(r.invoice.status, 'unpaid');
  assert.equal(r.invoice.total_amount, 50000);
  const after = vsRow(db, l);
  assert.equal(after.status, 'added', 'неоплаченная строка не должна стоять в очереди');
  assert.equal(after.queue_key, null);
  assert.equal(after.queue_no, null);
});

test('I2: регистратура с «Услуги: Просмотр» в карте — отказ и в дверях кассы; «Изменение» без «Удаления» — не убирает', () => {
  const { db, USG, vs, invoiceId } = clinic();
  const perms = (tab) => db.prepare('UPDATE role_permissions SET permissions = ? WHERE role = ?')
    .run(JSON.stringify({ sections: ['patients'], levels: { patients: 'admin' }, patient_tabs: { services: tab } }), 'registrar');
  perms('view');
  refused(() => call('cashier_line_change_service', db, { visit_service_id: vs, new_service_id: USG }, registrar));
  refused(() => call('cashier_line_set_doctor', db, { visit_service_id: vs, doctor_id: DOC2 }, registrar));
  refused(() => call('cashier_line_add', db, { invoice_id: invoiceId, service_id: USG }, registrar));
  perms('edit');
  refused(() => call('cashier_line_remove', db, { visit_service_id: vs }, registrar));
  assert.equal(call('cashier_line_set_doctor', db, { visit_service_id: vs, doctor_id: DOC2 }, registrar).changed, true);
  // Кассир с правом кассы вкладкой карты не ограничен: его право — cashier.lines.
  setGrants(db, 'cashier', { 'cashier.lines': 'edit' });
  db.prepare("UPDATE role_permissions SET permissions = json_set(permissions, '$.patient_tabs', json('{\"services\":\"view\"}')) WHERE role = 'cashier'").run();
  assert.equal(call('cashier_line_remove', db, { visit_service_id: vs }, cashier).removed, true);
});

test('I3: ручная скидка счёта считается от того, как её дали: врач A→B→A возвращает прежний итог', () => {
  const { db, vs, vid } = (() => {
    const d = seed();
    const CONS = svc(d, 'Приём', 100000);
    rates(d, DOC, [{ service_id: CONS, price: 150000 }]);
    rates(d, DOC2, [{ service_id: CONS, price: 120000 }]);
    const v = visit(d);
    return { db: d, vs: line(d, v.vid, CONS, DOC), vid: v.vid };
  })();
  const o = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs], discount_amount: 30000 }, registrar);
  assert.equal(o.invoice.total_amount, 120000);
  setGrants(db, 'cashier', { 'cashier.lines': 'edit' });
  // Дешевле врач — скидка в той же доле (30 000 × 120/150 = 24 000), как у
  // убранной строки (FATAL-1); вернули врача — вернулась и скидка.
  assert.equal(call('cashier_line_set_doctor', db, { visit_service_id: vs, doctor_id: DOC2 }, cashier).invoice.total_amount, 96000);
  assert.equal(call('cashier_line_set_doctor', db, { visit_service_id: vs, doctor_id: DOC }, cashier).invoice.total_amount, 120000);
  // Добавили услугу — ручная скидка не растёт сверх данной суммы.
  const extra = svc(db, 'ЭКГ', 50000, { type: 'procedure' });
  assert.equal(call('cashier_line_add', db, { invoice_id: o.invoice.id, service_id: extra }, cashier).invoice.total_amount, 170000);
  // Счёт, выставленный до этой версии (пара не записана): пара выводится из
  // скидки счёта (30 000 на 200 000) и дальше держится так же.
  db.prepare('UPDATE invoices SET manual_discount = NULL, manual_base = NULL WHERE id = ?').run(o.invoice.id);
  assert.equal(call('cashier_line_set_doctor', db, { visit_service_id: vs, doctor_id: DOC2 }, cashier).invoice.total_amount, 144500);
  assert.equal(call('cashier_line_set_doctor', db, { visit_service_id: vs, doctor_id: DOC }, cashier).invoice.total_amount, 170000);
});

test('I4: хирургию без койки касса не добавляет и не подставляет', () => {
  const { db, vs, invoiceId } = clinic();
  setGrants(db, 'cashier', { 'cashier.lines': 'edit' });
  const OP = svc(db, 'Операция', 900000, { type: 'other' });
  refused(() => call('cashier_line_add', db, { invoice_id: invoiceId, service_id: OP, doctor_id: DOC }, cashier), /Хирургия/, 400);
  refused(() => call('cashier_line_change_service', db, { visit_service_id: vs, new_service_id: OP }, cashier), /Хирургия/, 400);
  assert.equal(inv(db, invoiceId).total_amount, 150000);
});

test('I5: номер очереди прежнего врача снимается при смене врача и услуги', () => {
  const { db, vs, USG } = clinic();
  setGrants(db, 'cashier', { 'cashier.lines': 'edit' });
  const q = () => db.prepare("UPDATE visit_services SET queue_key = 'doc:20:2026-09-10', queue_no = 4 WHERE id = ?").run(vs);
  q();
  call('cashier_line_set_doctor', db, { visit_service_id: vs, doctor_id: DOC2 }, cashier);
  assert.deepEqual([vsRow(db, vs).queue_key, vsRow(db, vs).queue_no], [null, null]);
  q();
  call('cashier_line_change_service', db, { visit_service_id: vs, new_service_id: USG }, cashier);
  assert.deepEqual([vsRow(db, vs).queue_key, vsRow(db, vs).queue_no], [null, null]);
});

test('счёт плательщику и счёт, по которому были платежи, — касса строки не правит', () => {
  const db = seed();
  const CONS = svc(db, 'Приём', 100000);
  const USG = svc(db, 'УЗИ', 80000);
  setGrants(db, 'cashier', { 'cashier.lines': 'edit' });
  const payer = Number(db.prepare("INSERT INTO payers (name, kind, active) VALUES ('Страховая', 'insurance', 1)").run().lastInsertRowid);
  const a = visit(db);
  const la = line(db, a.vid, CONS, DOC);
  const ia = createInvoiceForVisit(db, { visit_id: a.vid, visit_service_ids: [la], payer_id: payer }, registrar).invoice.id;
  refused(() => call('cashier_line_set_doctor', db, { visit_service_id: la, doctor_id: DOC2 }, cashier), /плательщик/, 400);
  refused(() => call('cashier_line_change_service', db, { visit_service_id: la, new_service_id: USG }, cashier), /плательщик/, 400);
  refused(() => call('cashier_line_remove', db, { visit_service_id: la }, cashier), /плательщик/, 400);
  refused(() => call('cashier_line_add', db, { invoice_id: ia, service_id: USG }, cashier), /плательщик/, 400);
  // Платежи по счёту были (оплата и её возврат), денег на счёте 0 и статус
  // «не оплачен» — такой остаток бывает у счетов со скидкой после продажи.
  const b = visit(db);
  const lb = line(db, b.vid, CONS, DOC);
  const ib = createInvoiceForVisit(db, { visit_id: b.vid, visit_service_ids: [lb] }, registrar).invoice.id;
  db.prepare("INSERT INTO payments (invoice_id, amount, method) VALUES (?, 100000, 'cash'), (?, -100000, 'cash')").run(ib, ib);
  assert.equal(inv(db, ib).paid_amount, 0);
  assert.equal(inv(db, ib).status, 'unpaid');
  refused(() => call('cashier_line_change_service', db, { visit_service_id: lb, new_service_id: USG }, cashier), /платеж/, 400);
});

test('ключ повтора: второй вызов с тем же ключом ничего не добавляет', () => {
  const { db, invoiceId, USG } = clinic();
  setGrants(db, 'cashier', { 'cashier.lines': 'edit' });
  const args = { invoice_id: invoiceId, service_id: USG, idempotency_key: 'k-cashier-line-0001' };
  const a = call('cashier_line_add', db, args, cashier);
  const b = call('cashier_line_add', db, args, cashier);
  assert.equal(b.repeated, true);
  assert.equal(b.line.id, a.line.id);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM invoice_items WHERE invoice_id = ?').get(invoiceId).n, 2);
  assert.throws(() => call('cashier_line_add', db, { ...args, service_id: svc(db, 'ЭКГ', 1000) }, cashier), (e) => e.status === 409);
});

test('закрытый месяц — по МЕСТНОМУ дню визита: визит 1 октября 01:00 (местное) не заперт закрытым сентябрём', () => {
  const db = seed();
  const CONS = svc(db, 'Приём', 100000);
  const USG = svc(db, 'УЗИ', 80000);
  const { vid } = visit(db, { at: '2026-09-30T20:00:00Z' });   // UTC+5 → 1 октября 01:00
  const l = line(db, vid, CONS, DOC, { created_at: '2026-09-30T20:00:00Z' });
  createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [l] }, registrar);
  db.prepare("INSERT INTO pay_periods (month, closed_by, total, lines) VALUES ('2026-09', 1, 0, 0)").run();
  setGrants(db, 'cashier', { 'cashier.lines': 'edit' });
  const localDay = db.prepare("SELECT date('2026-09-30T20:00:00Z', 'localtime') d").get().d;
  if (localDay.startsWith('2026-10')) {
    assert.equal(call('cashier_line_change_service', db, { visit_service_id: l, new_service_id: USG }, cashier).changed, true);
  } else {
    refused(() => call('cashier_line_change_service', db, { visit_service_id: l, new_service_id: USG }, cashier), /месяц/, 409);
  }
});

test('консультацию ведёт только врач; исполнитель без назначения — любой работающий', () => {
  const { db, vs, vid } = clinic();
  setGrants(db, 'cashier', { 'cashier.lines': 'edit' });
  const ct = Number(db.prepare("INSERT INTO consultation_types (name, price) VALUES ('Первичный приём', 90000)").run().lastInsertRowid);
  const c = line(db, vid, null, DOC, { consultation_type_id: ct });
  db.prepare('UPDATE visit_services SET service_id = NULL WHERE id = ?').run(c);
  refused(() => call('cashier_line_set_doctor', db, { visit_service_id: c, doctor_id: NURSE }, cashier), /врач/, 400);
  // Услуга типа «консультация» — тоже только врачу.
  const CONS2 = svc(db, 'Консультация хирурга', 70000, { type: 'consultation' });
  refused(() => call('cashier_line_add', db, { visit_id: vid, service_id: CONS2, doctor_id: NURSE }, cashier), /врач/, 400);
  // Личная цена одного врача не делает его единственным исполнителем.
  const PROC = svc(db, 'Перевязка', 30000, { type: 'procedure' });
  rates(db, DOC, [{ service_id: PROC, price: 45000 }]);
  const p = call('cashier_line_add', db, { visit_id: vid, service_id: PROC, doctor_id: DOC }, cashier);
  assert.equal(call('cashier_line_set_doctor', db, { visit_service_id: p.line.id, doctor_id: NURSE }, cashier).line.doctor_id, NURSE);
  void vs;
});

test('CRM: смена врача доходит до заявки; добавленная кассой строка попадает в заявку; снятая — снимается', () => {
  const { db, vs, vid, invoiceId, USG, CONS } = clinic();
  setGrants(db, 'cashier', { 'cashier.lines': 'edit' });
  const req = Number(db.prepare("INSERT INTO crm_requests (full_name) VALUES ('Пациент')").run().lastInsertRowid);
  const crmLine = Number(db.prepare(`INSERT INTO crm_request_services (request_id, service_id, status, doctor_id, visit_id, visit_service_id, visit_service_auto)
                                     VALUES (?, ?, 'pending', ?, ?, ?, 0)`).run(req, CONS, DOC, vid, vs).lastInsertRowid);
  call('cashier_line_set_doctor', db, { visit_service_id: vs, doctor_id: DOC2 }, cashier);
  assert.equal(db.prepare('SELECT doctor_id FROM crm_request_services WHERE id = ?').get(crmLine).doctor_id, DOC2);
  const add = call('cashier_line_add', db, { invoice_id: invoiceId, service_id: USG, doctor_id: DOC2 }, cashier);
  const mirrored = db.prepare('SELECT * FROM crm_request_services WHERE visit_service_id = ?').get(add.line.id);
  assert.ok(mirrored, 'строка, добавленная кассой, не дошла до заявки');
  assert.equal(mirrored.request_id, req);
  assert.equal(mirrored.doctor_id, DOC2);
  call('cashier_line_remove', db, { visit_service_id: add.line.id }, cashier);
  const gone = db.prepare('SELECT status, visit_service_id FROM crm_request_services WHERE id = ?').get(mirrored.id);
  assert.ok(!gone || gone.status === 'cancelled' || gone.visit_service_id == null, 'снятая строка осталась в заявке живой');
});

test('журнал: удаление отменённого счёта журнал не стирает; строки журнала кассы не держат пустой визит', async () => {
  const { discardEmptyVisit } = await import('./visits.js');
  const { voidInvoice, deleteInvoice } = await import('./cashier.js');
  const { db, invoiceId, vs, vid } = clinic();
  setGrants(db, 'cashier', { 'cashier.lines': 'edit' });
  call('cashier_line_set_doctor', db, { visit_service_id: vs, doctor_id: DOC2 }, cashier);
  voidInvoice(db, { invoice_id: invoiceId }, admin);
  deleteInvoice(db, { invoice_id: invoiceId }, admin);
  const kept = db.prepare("SELECT invoice_id FROM invoice_audit_log WHERE action = 'line_change_doctor'").all();
  assert.equal(kept.length, 1);
  assert.equal(kept[0].invoice_id, null);
  // Визит без строк, заведённый только что регистратором, удаляется несмотря на запись журнала кассы.
  db.prepare('DELETE FROM visit_services WHERE visit_id = ?').run(vid);
  db.prepare("UPDATE visits SET created_by = ?, status = 'scheduled', created_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?").run(registrar.id, vid);
  db.prepare("DELETE FROM invoice_audit_log WHERE action <> 'line_change_doctor'").run();
  const r = discardEmptyVisit(db, { visit_id: vid }, registrar);
  assert.equal(r.discarded, true);
});

test('«Старший кассир» без уровня — только просмотр: закрыть чужую смену нельзя; кто закрыл — записано', () => {
  const db = seed();
  db.prepare('UPDATE role_permissions SET permissions = ? WHERE role = ?')
    .run(JSON.stringify({ sections: ['cashier', 'cashier-head'] }), 'head_cashier');
  cashMove(db, { kind: 'in', amount: 1000, note: 'Размен' }, cashier);
  const shift = db.prepare('SELECT * FROM cash_shifts WHERE cashier_id = ?').get(cashier.id);
  assert.equal(shiftReport(db, { shift_id: shift.id }, head).shift.id, shift.id);
  refused(() => closeCashShift(db, { shift_id: shift.id, counted_amount: 1000 }, head), /свою/);
  const closed = closeCashShift(db, { shift_id: shift.id, counted_amount: 1000 }, admin);
  assert.equal(closed.shift.closed_by, admin.id);
});

test('касса без базы кассира (своя роль медсестры с правом) добавляет новым счётом и получает цену', () => {
  const { db, invoiceId, USG } = clinic();
  recordPayment(db, { invoice_id: invoiceId, amount: 150000, method: 'cash' }, cashier);
  const nurse = { id: NURSE, role: 'nurse', full_name: 'Медсестра' };
  setGrants(db, 'nurse', { cashier: 'edit', 'cashier.lines': 'edit' });
  const r = call('cashier_line_add', db, { invoice_id: invoiceId, service_id: USG }, nurse);
  assert.equal(r.invoice_created, true);
  assert.equal(r.invoice.total_amount, 80000);
});
