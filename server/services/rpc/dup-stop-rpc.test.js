// DUP_STOP_V1 (2026-11-02) — двери RPC, которые заводят или меняют строку визита:
// касса добавляет услугу (cashier_line_add), заменяет услугу или врача в неоплаченном
// счёте (cashier_line_change_service, change_unpaid_service, cashier_line_set_doctor,
// patient_card_set_doctor), в оплаченном (cashier_line_swap_paid / _quote), возврат с новой
// услугой (cashier_line_rebill_paid), повторное выставление возвращённой строки
// (create_invoice_for_visit + rebill_refunded); и проверка экранов visit_dup_check.
// Всё — через настоящую карту RPC (index.js) и SQLite после миграций.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { RPC } from './index.js';
import { createInvoiceForVisit, recordPayment } from './billing.js';
import { openCashShift } from './cashier.js';
import { hashPassword } from '../auth.js';

const admin = { id: 1, role: 'admin', extra_roles: [], full_name: 'Админ' };
const registrar = { id: 7, role: 'registrar', extra_roles: [], full_name: 'Регистратор' };
const cashier = { id: 9, role: 'cashier', extra_roles: [], full_name: 'Кассир' };
const callcenter = { id: 8, role: 'callcenter', extra_roles: [], full_name: 'Оператор' };
const DOC = 20, DOC2 = 21;
const DAY = '2026-09-10T05:00:00Z';

function clinic() {
  const db = openDb(':memory:'); migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, role, full_name, is_doctor, is_active, extra_roles) VALUES (?,?,?,?,?,?,1,?)');
  u.run(1, 'adm', hashPassword('password1'), 'admin', 'Админ', 0, '[]');
  u.run(7, 'reg', 'x', 'registrar', 'Регистратор', 0, '[]');
  u.run(8, 'cc', 'x', 'callcenter', 'Оператор', 0, '[]');
  u.run(9, 'cash', 'x', 'cashier', 'Кассир', 0, '[]');
  u.run(DOC, 'doc', 'x', 'doctor', 'Врач Первый', 1, '[]');
  u.run(DOC2, 'doc2', 'x', 'doctor', 'Врач Второй', 1, '[]');
  const s = db.prepare('INSERT INTO services (id, name, price, type, requires_doctor) VALUES (?,?,?,?,?)');
  s.run(30, 'Приём терапевта', 100000, 'consultation', 1);
  s.run(40, 'Анализ крови', 40000, 'lab', 0);
  s.run(50, 'УЗИ', 80000, 'imaging', 0);
  s.run(60, 'Капельница', 30000, 'procedure', 0);
  db.prepare("INSERT INTO consultation_types (id, name, name_ru, price, active) VALUES (5, 'Первичный', 'Первичный приём', 90000, 1)").run();
  const perms = JSON.stringify({ sections: [], levels: {}, grants: { 'cashier.lines': 'edit' } });
  db.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?) ON CONFLICT(role) DO UPDATE SET permissions = excluded.permissions').run('cashier', perms);
  openCashShift(db, { opening_float: 0 }, cashier);
  const pid = Number(db.prepare("INSERT INTO patients (full_name) VALUES ('Пациент')").run().lastInsertRowid);
  const vid = Number(db.prepare('INSERT INTO visits (patient_id, visit_date) VALUES (?, ?)').run(pid, DAY).lastInsertRowid);
  return { db, pid, vid };
}
const line = (db, vid, r) => {
  const row = { visit_id: vid, quantity: 1, unit_price: 0, total: 0, status: 'added', created_by: 7, ...r };
  const cols = Object.keys(row);
  return Number(db.prepare(`INSERT INTO visit_services (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...Object.values(row)).lastInsertRowid);
};
const call = (name, db, args, user) => RPC[name](db, args, user);
const dup = (fn) => assert.throws(fn, (e) => e.status === 409 && e.code === 'duplicate_order' && /уже назначена в этом визите/.test(e.message));
const count = (db, vid, svc) => db.prepare("SELECT COUNT(*) n FROM visit_services WHERE visit_id = ? AND service_id = ? AND status <> 'cancelled'").get(vid, svc).n;

test('DUP_STOP_V1: cashier_line_add — услуга уже в визите — 409, строки и счёта не прибавилось; процедура — можно', () => {
  const { db, vid } = clinic();
  line(db, vid, { service_id: 40 });
  const invBefore = db.prepare('SELECT COUNT(*) n FROM invoices').get().n;
  dup(() => call('cashier_line_add', db, { visit_id: vid, service_id: 40 }, cashier));
  assert.equal(count(db, vid, 40), 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM invoices').get().n, invBefore, 'отказ не выставил счёт');
  line(db, vid, { service_id: 60 });
  assert.ok(call('cashier_line_add', db, { visit_id: vid, service_id: 60 }, cashier).line, 'процедура второй раз');
  assert.ok(call('cashier_line_add', db, { visit_id: vid, service_id: 50 }, cashier).line, 'новая услуга');
});

test('DUP_STOP_V1: cashier_line_add — администратор с причиной назначает повтор, журнал счёта помнит; кассир с причиной — 409', () => {
  const { db, vid } = clinic();
  line(db, vid, { service_id: 40 });
  dup(() => call('cashier_line_add', db, { visit_id: vid, service_id: 40, __repeat_reason: 'контрольный анализ' }, cashier));
  const out = call('cashier_line_add', db, { visit_id: vid, service_id: 40, __repeat_reason: 'контрольный анализ' }, admin);
  assert.ok(out.line);
  assert.equal(count(db, vid, 40), 2);
  const log = db.prepare("SELECT * FROM invoice_audit_log WHERE action = 'line_repeat_order'").all();
  assert.deepEqual(log.map((r) => [r.visit_id, r.reason]), [[vid, 'контрольный анализ']]);
});

test('DUP_STOP_V1: замена услуги в неоплаченном счёте на уже назначенную — 409; на новую — можно', () => {
  const { db, vid } = clinic();
  line(db, vid, { service_id: 40 });
  const usg = line(db, vid, { service_id: 50 });
  createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [usg] }, registrar);
  dup(() => call('cashier_line_change_service', db, { visit_service_id: usg, new_service_id: 40 }, cashier));
  dup(() => call('change_unpaid_service', db, { visit_service_id: usg, new_service_id: 40 }, admin));
  assert.equal(db.prepare('SELECT service_id FROM visit_services WHERE id = ?').get(usg).service_id, 50, 'строка не изменилась');
  assert.equal(call('cashier_line_change_service', db, { visit_service_id: usg, new_service_id: 60 }, cashier).changed, true);
});

test('DUP_STOP_V1: смена врача консультации на врача, у которого этот вид уже назначен, — 409 (касса и карта пациента)', () => {
  const { db, vid } = clinic();
  line(db, vid, { service_id: null, consultation_type_id: 5, doctor_id: DOC });
  const b = line(db, vid, { service_id: null, consultation_type_id: 5, doctor_id: DOC2 });
  dup(() => call('cashier_line_set_doctor', db, { visit_service_id: b, doctor_id: DOC }, cashier));
  dup(() => call('patient_card_set_doctor', db, { visit_service_id: b, doctor_id: DOC }, admin));
  assert.equal(db.prepare('SELECT doctor_id FROM visit_services WHERE id = ?').get(b).doctor_id, DOC2);
  // Анализ у другого исполнителя — тот же ключ (врач не входит): правка проходит.
  const lab = line(db, vid, { service_id: 40, doctor_id: DOC });
  line(db, vid, { service_id: 40, doctor_id: DOC2, status: 'cancelled' });
  assert.equal(call('patient_card_set_doctor', db, { visit_service_id: lab, doctor_id: DOC2 }, admin).doctor_id, DOC2);
});

test('DUP_STOP_V1: замена в оплаченном счёте и её предпросмотр — новая услуга уже в визите — 409, деньги не двигались', () => {
  const { db, vid } = clinic();
  line(db, vid, { service_id: 40 });
  const usg = line(db, vid, { service_id: 50 });
  const invoice = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [usg] }, registrar).invoice;
  recordPayment(db, { invoice_id: invoice.id, amount: invoice.total_amount, method: 'cash' }, cashier);
  dup(() => call('cashier_line_swap_quote', db, { visit_service_id: usg, new_service_id: 40 }, cashier));
  dup(() => call('cashier_line_swap_paid', db, { visit_service_id: usg, new_service_id: 40 }, cashier));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM payments WHERE amount < 0').get().n, 0, 'возврата не было');
});

test('DUP_STOP_V1: возврат с новой услугой — новая уже в визите — 409; та же услуга у другого врача — можно (прежняя строка отпущена)', () => {
  const { db, vid } = clinic();
  line(db, vid, { service_id: 40 });
  const usg = line(db, vid, { service_id: 50, doctor_id: DOC });
  const invoice = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [usg] }, registrar).invoice;
  recordPayment(db, { invoice_id: invoice.id, amount: invoice.total_amount, method: 'cash' }, cashier);
  db.prepare("UPDATE visit_services SET status = 'completed' WHERE id = ?").run(usg);
  dup(() => call('cashier_line_rebill_quote', db, { visit_service_id: usg, new_service_id: 40 }, cashier));
  dup(() => call('cashier_line_rebill_paid', db, { visit_service_id: usg, new_service_id: 40 }, cashier));
  const r = call('cashier_line_rebill_paid', db, { visit_service_id: usg, new_service_id: 50, doctor_id: DOC2 }, cashier);
  assert.equal(r.rebill, true);
  assert.equal(count(db, vid, 50), 2, 'прежняя строка в визите (отпущена с возвратом) и новая');
});

test('DUP_STOP_V1: возвращённую строку снова выставляют (rebill_refunded) — если та же услуга уже назначена заново, 409', () => {
  const { db, vid } = clinic();
  const old = line(db, vid, { service_id: 40, status: 'collected' });
  db.prepare("INSERT INTO pay_refund_releases (kind, line_id, invoice_id) VALUES ('out', ?, 1)").run(old);
  const fresh = line(db, vid, { service_id: 40 });   // назначили заново — можно: прежняя отпущена
  dup(() => call('create_invoice_for_visit', db, { visit_id: vid, visit_service_ids: [old], rebill_refunded: true }, registrar));
  assert.ok(call('create_invoice_for_visit', db, { visit_id: vid, visit_service_ids: [fresh] }, registrar).invoice);
});

test('DUP_STOP_V1 (К1): «Вернуть услугу» — возвращённая строка с начатой работой больше не мешает назначить ту же услугу снова', () => {
  const { db, vid } = clinic();
  const lab = line(db, vid, { service_id: 40 });
  const invoice = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [lab] }, registrar).invoice;
  recordPayment(db, { invoice_id: invoice.id, amount: invoice.total_amount, method: 'cash' }, cashier);
  db.prepare("UPDATE visit_services SET status = 'collected' WHERE id = ?").run(lab);   // проба взята — строка останется в визите
  dup(() => call('cashier_line_add', db, { visit_id: vid, service_id: 40 }, cashier));   // пока не возвращена — повтор
  const item = db.prepare('SELECT invoice_item_id FROM visit_services WHERE id = ?').get(lab).invoice_item_id;
  call('refund_invoice_line', db, { invoice_item_id: item, reason: 'пациент отказался' }, cashier);
  assert.ok(db.prepare('SELECT 1 FROM visit_services WHERE id = ?').get(lab), 'начатая работа осталась в визите');
  assert.ok(call('cashier_line_add', db, { visit_id: vid, service_id: 40 }, cashier).line, 'возвращённая строка мешает назначить анализ снова');
  assert.equal(count(db, vid, 40), 2);
});

test('DUP_STOP_V1: visit_dup_check — визит дня пациента, назначенное, повторы, поблажки и право обхода', () => {
  const { db, pid, vid } = clinic();
  const day = db.prepare("SELECT date(visit_date, 'localtime') d FROM visits WHERE id = ?").get(vid).d;
  line(db, vid, { service_id: 40, created_by: DOC });
  line(db, vid, { service_id: 60 });
  line(db, vid, { service_id: 50, status: 'cancelled' });
  const out = call('visit_dup_check', db, { patient_id: pid, date: day, lines: [{ service_id: 40 }, { service_id: 50 }, { service_id: 60 }] }, registrar);
  assert.equal(out.visit_id, vid);
  assert.deepEqual(out.ordered.map((o) => [o.service_id, o.key, o.who]), [[40, 's:40', 'Врач Первый']], 'процедура и отменённая — не назначение');
  assert.deepEqual(out.duplicates.map((d) => d.index), [0]);
  assert.match(out.duplicates[0].message, /«Анализ крови» — Врач Первый/);
  assert.ok(out.duplicates[0].template && out.duplicates[0].params);
  assert.equal(out.can_override, false);
  assert.equal(call('visit_dup_check', db, { visit_id: vid, lines: [] }, admin).can_override, true);
  assert.deepEqual(call('visit_dup_check', db, { patient_id: pid, date: '2030-01-01', lines: [{ service_id: 40 }] }, registrar),
    { visit_id: null, ordered: [], duplicates: [], can_override: false }, 'визита в этот день нет — повторов нет');
  assert.equal(call('visit_dup_check', db, { visit_id: vid, lines: [{ service_id: 40 }], exclude_ids: [out.ordered[0].id] }, registrar).duplicates.length, 0, 'строку, которую экран снимет сам, не считаем');
  assert.throws(() => call('visit_dup_check', db, { lines: [] }, registrar), (e) => e.status === 400);
  assert.throws(() => call('visit_dup_check', db, { visit_id: vid }, { id: 99, role: 'lab', extra_roles: [] }), (e) => e.status === 403);
});

test('DUP_STOP_V1 (ревью M2): visit_dup_check — роли без строк визита (колл-центр) — ни назначенного, ни кем/когда/счёта: только «уже назначена»', () => {
  const { db, pid, vid } = clinic();
  const day = db.prepare("SELECT date(visit_date, 'localtime') d FROM visits WHERE id = ?").get(vid).d;
  const lab = line(db, vid, { service_id: 40, created_by: DOC });
  const inv = Number(db.prepare("INSERT INTO invoices (invoice_number, visit_id, patient_id, subtotal, total_amount, status) VALUES ('INV-A-26-00001', ?, ?, 40000, 40000, 'unpaid')").run(vid, pid).lastInsertRowid);
  const item = Number(db.prepare("INSERT INTO invoice_items (invoice_id, service_id, description, quantity, unit_price, total) VALUES (?, 40, 'Анализ крови', 1, 40000, 40000)").run(inv).lastInsertRowid);
  db.prepare('UPDATE visit_services SET invoice_item_id = ? WHERE id = ?').run(item, lab);
  for (const args of [{ visit_id: vid }, { patient_id: pid, date: day }]) {
    const out = call('visit_dup_check', db, { ...args, lines: [{ service_id: 40 }, { service_id: 50 }] }, callcenter);
    assert.equal(out.visit_id, vid);
    assert.deepEqual(out.ordered, [], 'колл-центру — строки визита, которые /api/db ему не отдаёт');
    assert.equal(out.duplicates.length, 1);
    const d = out.duplicates[0];
    assert.equal(d.message, 'Эта услуга уже назначена в этом визите: «Анализ крови».');
    assert.deepEqual(d.params, { service: 'Анализ крови' }, 'кем, когда и номер счёта — данные пациента');
    assert.equal(d.line_id, null);
    assert.ok(!/Врач Первый|INV-/.test(JSON.stringify(out)), JSON.stringify(out));
  }
  // регистратуре — как прежде, с подробностями
  const reg = call('visit_dup_check', db, { visit_id: vid, lines: [{ service_id: 40 }] }, registrar);
  assert.equal(reg.ordered.length, 1);
  assert.match(reg.duplicates[0].message, /«Анализ крови» — Врач Первый, .+, счёт № INV-A-26-00001\.$/);
});

test('DUP_STOP_V1 (ревью M2): visit_dup_check — визит соседнего здания по номеру — отказ, как у дверей записи', () => {
  const { db, pid } = clinic();
  const far = Number(db.prepare("INSERT INTO visits (patient_id, visit_date, status, sync_origin) VALUES (?, ?, 'arrived', 'B')").run(pid, DAY).lastInsertRowid);
  line(db, far, { service_id: 40 });
  assert.throws(() => call('visit_dup_check', db, { visit_id: far, lines: [{ service_id: 40 }] }, registrar),
    (e) => e.status === 403 && /Визит из филиала/.test(e.message));
  assert.deepEqual(call('visit_dup_check', db, { visit_id: 999999, lines: [{ service_id: 40 }] }, registrar),
    { visit_id: null, ordered: [], duplicates: [], can_override: false }, 'визита нет — повторов нет');
});

test('DUP_STOP_V1: visit_dup_check — строка записи колл-центра — не «уже назначено»: строка регистратуры займёт её место', () => {
  const { db, pid } = clinic();
  const future = new Date(); future.setDate(future.getDate() + 3); future.setHours(10, 0, 0, 0);
  const v = Number(db.prepare("INSERT INTO visits (patient_id, visit_date, status) VALUES (?, ?, 'scheduled')").run(pid, future.toISOString()).lastInsertRowid);
  const added = call('booking_lines_add', db, { visit_id: v, lines: [{ service_id: 40 }] }, callcenter).added;
  assert.equal(added.length, 1);
  const out = call('visit_dup_check', db, { visit_id: v, lines: [{ service_id: 40 }] }, registrar);
  assert.deepEqual(out.ordered, []);
  assert.deepEqual(out.duplicates, []);
});
