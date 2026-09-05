// PROC_PERFORMER_V1 — «процедура приходит тому, кого выбрали».
//
// Проверяется ровно то, что в клинике стоит работы и денег:
//   • медсестру МОЖНО выбрать исполнителем, и выбор переживает круг через базу;
//   • назначенная процедура появляется в списке ЭТОЙ медсестры и не появляется
//     у другой; администратор видит обе;
//   • палатная процедура приходит с палатой и койкой и отличима от кабинетной;
//   • назначение медсестры НЕ ДВИГАЕТ НИ ОДНОГО ЧИСЛА, принадлежащего врачу —
//     проверяется зарплатным отчётом и суммой счёта, а не осмотром колонок;
//   • инвариант «врач узнаётся по is_doctor, а не по role» держится: админ,
//     который ведёт приём, исполнителем быть может; регистратура — нет.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import {
  proceduresList, procedureAssign, procedureComplete,
  canPerformProcedures, scopeOf, RpcError,
} from './procedures.js';
import { runReport } from './reports.js';
import { createInvoiceForVisit, createInvoiceForAdmission } from './billing.js';

// Носители ролей. Надстроечные роли живут только в extra_roles (roles.js).
const ACTOR = {
  admin:     { id: 9, role: 'admin' },
  doctor:    { id: 1, role: 'doctor' },
  nurse:     { id: 2, role: 'nurse' },
  nurse2:    { id: 3, role: 'nurse' },
  registrar: { id: 4, role: 'registrar' },
  cashier:   { id: 5, role: 'cashier' },
  admindoc:  { id: 6, role: 'admin' },   // администратор, который ведёт приём
};

const FROM = '2000-01-01';
const TO   = '2100-01-01';

// Клиника: врач (30% + личная цена), две медсестры, регистратура, касса,
// админ-врач. Услуга-процедура (тип 'procedure') и услуга-приём (консультация).
// Один амбулаторный визит и одна госпитализация на койке.
function seed() {
  const db = openDb(':memory:');
  migrate(db);
  const u = db.prepare(`INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, specialty, service_rates)
                        VALUES (?,?,?,?,?,?,?,?)`);
  u.run(1, 'doc', 'x', 'Иванов И.И.', 'doctor', 1, 'Терапевт', JSON.stringify([
    { service_id: 1, pct: 30, price: 150000 },   // процедура: личная цена врача
    { service_id: 2, pct: 40 },                  // приём
  ]));
  u.run(2, 'nur', 'x', 'Сестрина А.А.', 'nurse', 0, '', '');
  u.run(3, 'nur2', 'x', 'Петрова В.В.', 'nurse', 0, '', '');
  u.run(4, 'reg', 'x', 'Регистратура', 'registrar', 0, '', '');
  u.run(5, 'cash', 'x', 'Касса', 'cashier', 0, '', '');
  // ADMIN_DOCTOR_LIST_V1 — админ БЕЗ specialty и БЕЗ role='doctor', но is_doctor=1.
  u.run(6, 'admdoc', 'x', 'Каримова Д.', 'admin', 1, '', '');
  u.run(9, 'adm', 'x', 'Администратор', 'admin', 0, '', '');

  const pat = db.prepare('INSERT INTO patients (id, mrn, full_name, last_name, first_name, phone) VALUES (?,?,?,?,?,?)');
  pat.run(1, 'P-1', 'Азизов Бахтиёр', 'Азизов', 'Бахтиёр', '+998901112233');
  pat.run(2, 'P-2', 'Юлдашева Нилуфар', 'Юлдашева', 'Нилуфар', '+998901112244');

  db.prepare("INSERT INTO departments (id, name, kind) VALUES (90,'Процедурный','procedure')").run();
  db.prepare("INSERT INTO services (id, name, price, type, tax_rate, department_id) VALUES (1,'Внутривенная инъекция',100000,'procedure',0,90)").run();
  db.prepare("INSERT INTO services (id, name, price, type, tax_rate) VALUES (2,'Приём терапевта',200000,'consultation',0)").run();

  db.prepare("INSERT INTO visits (id, patient_id, visit_date) VALUES (1,1,'2026-09-04T09:00:00Z')").run();

  db.prepare("INSERT INTO wards (id, name) VALUES (1,'Терапия')").run();
  db.prepare("INSERT INTO beds (id, code, ward_id) VALUES (1,'Т-4',1)").run();
  db.prepare(`INSERT INTO admissions (id, patient_id, bed_id, ward_id, doctor_id, attending_doctor_id, status)
              VALUES (1,2,1,1,1,1,'active')`).run();
  return db;
}

// Амбулаторная процедура на визите; исполнитель — как передали (null = ничья).
function outLine(db, { id = 1, doctorId = null, status = 'queued' } = {}) {
  db.prepare(`INSERT INTO visit_services (id, visit_id, service_id, doctor_id, quantity, unit_price, total, status)
              VALUES (?,1,1,?,1,100000,100000,?)`).run(id, doctorId, status);
  return id;
}
// Палатная процедура: doctor_id = ЛЕЧАЩИЙ (деньги), performer_id = исполнитель.
function inLine(db, { id = 1, performerId = null } = {}) {
  db.prepare(`INSERT INTO admission_services (id, admission_id, service_id, doctor_id, performer_id, bed_id, ward_id,
                quantity, unit_price, total, status, billable)
              VALUES (?,1,1,1,?,1,1,1,100000,100000,'added',1)`).run(id, performerId);
  return id;
}
// Оплаченный приём врача — та строка, чьё зарплатное число обязано пережить всё.
function paidConsultation(db) {
  db.prepare(`INSERT INTO visit_services (id, visit_id, service_id, doctor_id, quantity, unit_price, total, status)
              VALUES (99,1,2,1,1,200000,200000,'completed')`).run();
  db.prepare(`INSERT INTO invoices (id, invoice_number, visit_id, patient_id, subtotal, discount_amount, total_amount, paid_amount, status)
              VALUES (1,'INV-1',1,1,200000,0,200000,200000,'paid')`).run();
  db.prepare(`INSERT INTO invoice_items (id, invoice_id, service_id, description, quantity, unit_price, total)
              VALUES (1,1,2,'Приём терапевта',1,200000,200000)`).run();
  db.prepare('UPDATE visit_services SET invoice_item_id = 1 WHERE id = 99').run();
}

// Зарплатный отчёт: {имя врача -> гонорар}. Считает ту же арифметику, что
// печатается владельцу, а не наши предположения о ней.
function salaries(db) {
  const r = runReport(db, { kind: 'doctor_salaries', from: FROM, to: TO }, ACTOR.admin);
  const who = r.columns.indexOf('Врач');
  const fee = r.columns.indexOf('Доля врача (гонорар)');
  const out = {};
  for (const row of r.rows) out[String(row[who])] = row[fee];
  return out;
}

const ids = (res) => res.rows.map((r) => r.kind + ':' + r.id);

// ─── 1. Исполнителем может быть медсестра ───────────────────────────────────

test('медсестру можно назначить исполнителем, и назначение переживает круг через базу', () => {
  const db = seed();
  outLine(db, { id: 1 });
  const res = procedureAssign(db, { kind: 'outpatient', id: 1, performer_id: 2 }, ACTOR.registrar);
  assert.equal(res.performer_id, 2);
  assert.equal(db.prepare('SELECT doctor_id FROM visit_services WHERE id = 1').get().doctor_id, 2);
  const row = proceduresList(db, {}, ACTOR.admin).rows.find((r) => r.id === 1);
  assert.equal(row.performer, 'Сестрина А.А.');
  assert.equal(row.performer_role, 'nurse');
  assert.equal(row.unassigned, false);
});

test('медсестру можно назначить исполнителем ПАЛАТНОЙ процедуры — в свою колонку', () => {
  const db = seed();
  inLine(db, { id: 1 });
  procedureAssign(db, { kind: 'inpatient', id: 1, performer_id: 2 }, ACTOR.registrar);
  const row = db.prepare('SELECT doctor_id, performer_id FROM admission_services WHERE id = 1').get();
  assert.equal(row.performer_id, 2, 'исполнитель — медсестра');
  assert.equal(row.doctor_id, 1, 'лечащий врач НЕ ТРОНУТ');
});

test('касса и склад исполнителями быть не могут', () => {
  const db = seed();
  outLine(db, { id: 1 });
  assert.throws(() => procedureAssign(db, { kind: 'outpatient', id: 1, performer_id: 5 }, ACTOR.admin),
    (e) => e instanceof RpcError && /врач или медсестра/.test(e.message));
});

// ─── 2. Инвариант is_doctor ─────────────────────────────────────────────────

test('is_doctor, а не role: администратор, который ведёт приём, — исполнитель; регистратура — нет', () => {
  // Именно та ошибка, которую чинили в шести фильтрах SPA: у админ-врача
  // role='admin' и specialty пустая, и проверка по роли выкинула бы его.
  assert.equal(canPerformProcedures({ role: 'admin', is_doctor: 1, specialty: '' }), true);
  assert.equal(canPerformProcedures({ role: 'admin', is_doctor: 0 }), false);
  assert.equal(canPerformProcedures({ role: 'registrar', is_doctor: 0 }), false);
  assert.equal(canPerformProcedures({ role: 'nurse', is_doctor: 0 }), true);
  assert.equal(canPerformProcedures({ role: 'doctor', is_doctor: 0 }), true);
  assert.equal(canPerformProcedures({ role: 'lab', is_doctor: 0, extra_roles: '["senior_nurse"]' }), true);
  assert.equal(canPerformProcedures(null), false);

  const db = seed();
  outLine(db, { id: 1 });
  const res = procedureAssign(db, { kind: 'outpatient', id: 1, performer_id: 6 }, ACTOR.admin);
  assert.equal(res.performer, 'Каримова Д.');
  assert.throws(() => procedureAssign(db, { kind: 'outpatient', id: 2, performer_id: 4 }, ACTOR.admin));
});

// ─── 3. Своё против всего ───────────────────────────────────────────────────

test('назначенная процедура приходит ТОЙ медсестре, кого выбрали, и не приходит другой', () => {
  const db = seed();
  outLine(db, { id: 1, doctorId: 2 });   // Сестриной
  outLine(db, { id: 2, doctorId: 3 });   // Петровой
  assert.deepEqual(ids(proceduresList(db, {}, ACTOR.nurse)),  ['outpatient:1']);
  assert.deepEqual(ids(proceduresList(db, {}, ACTOR.nurse2)), ['outpatient:2']);
});

test('администратор видит обе, и его область — «всё»', () => {
  const db = seed();
  outLine(db, { id: 1, doctorId: 2 });
  outLine(db, { id: 2, doctorId: 3 });
  const res = proceduresList(db, {}, ACTOR.admin);
  assert.equal(res.scope, 'all');
  assert.deepEqual(ids(res).sort(), ['outpatient:1', 'outpatient:2']);
  assert.equal(scopeOf(ACTOR.nurse), 'own');
});

test('ничья процедура видна всем — её берёт тот, кто её делает', () => {
  const db = seed();
  outLine(db, { id: 1, doctorId: null });
  assert.deepEqual(ids(proceduresList(db, {}, ACTOR.nurse2)), ['outpatient:1']);
  procedureAssign(db, { kind: 'outpatient', id: 1 }, ACTOR.nurse2);
  assert.deepEqual(ids(proceduresList(db, {}, ACTOR.nurse)), []);
  assert.deepEqual(ids(proceduresList(db, {}, ACTOR.nurse2)), ['outpatient:1']);
});

test('занятую процедуру медсестра у коллеги не отбирает, а администратор переназначает', () => {
  const db = seed();
  outLine(db, { id: 1, doctorId: 2 });
  assert.throws(() => procedureAssign(db, { kind: 'outpatient', id: 1 }, ACTOR.nurse2),
    (e) => e.status === 403);
  procedureAssign(db, { kind: 'outpatient', id: 1, performer_id: 3 }, ACTOR.admin);
  assert.equal(db.prepare('SELECT doctor_id FROM visit_services WHERE id = 1').get().doctor_id, 3);
});

test('не-медицинская роль очередь процедур не читает', () => {
  const db = seed();
  assert.throws(() => proceduresList(db, {}, ACTOR.cashier), (e) => e.status === 403);
});

// ─── 4. Кабинет против палаты ───────────────────────────────────────────────

test('палатная процедура приходит с палатой и койкой и отличима от кабинетной', () => {
  const db = seed();
  outLine(db, { id: 1, doctorId: 2 });
  inLine(db, { id: 1, performerId: 2 });
  const rows = proceduresList(db, {}, ACTOR.nurse).rows;
  const out = rows.find((r) => r.kind === 'outpatient');
  const inp = rows.find((r) => r.kind === 'inpatient');

  assert.ok(out && inp, 'обе половины пришли в один список');
  assert.equal(out.ward, '');
  assert.equal(out.bed, '');
  assert.equal(out.admission_id, null);
  assert.ok(out.visit_id, 'у кабинетной есть визит');

  assert.equal(inp.ward, 'Терапия');
  assert.equal(inp.bed, 'Т-4');
  assert.equal(inp.admission_id, 1);
  assert.equal(inp.visit_id, null);
  assert.equal(inp.patient, 'Юлдашева Нилуфар');
});

test('палатная строка выписанного пациента в очередь не идёт', () => {
  const db = seed();
  inLine(db, { id: 1, performerId: 2 });
  db.prepare("UPDATE admissions SET status = 'discharged' WHERE id = 1").run();
  assert.deepEqual(ids(proceduresList(db, {}, ACTOR.admin)), []);
});

test('услуга-не-процедура (приём) в очередь процедур не попадает', () => {
  const db = seed();
  db.prepare(`INSERT INTO visit_services (id, visit_id, service_id, doctor_id, quantity, unit_price, total, status)
              VALUES (7,1,2,2,1,200000,200000,'queued')`).run();
  assert.deepEqual(ids(proceduresList(db, {}, ACTOR.admin)), []);
});

test('BRANCH_ORIGIN_V1 — приехавшая из соседнего здания строка в очередь не идёт', () => {
  const db = seed();
  outLine(db, { id: 1, doctorId: 2 });
  outLine(db, { id: 2, doctorId: 2 });
  db.prepare("UPDATE visit_services SET sync_origin = 'B' WHERE id = 2").run();
  assert.deepEqual(ids(proceduresList(db, {}, ACTOR.admin)), ['outpatient:1']);
});

// ─── 5. Отметка о выполнении ────────────────────────────────────────────────

test('кабинетную процедуру нельзя провести до кассы, а после — можно, со штампом', () => {
  const db = seed();
  outLine(db, { id: 1, doctorId: 2, status: 'added' });
  assert.throws(() => procedureComplete(db, { kind: 'outpatient', id: 1 }, ACTOR.nurse),
    (e) => /кассой/.test(e.message));
  db.prepare("UPDATE visit_services SET status = 'queued' WHERE id = 1").run();
  procedureComplete(db, { kind: 'outpatient', id: 1, notes: 'в/в, реакции нет' }, ACTOR.nurse);
  const row = db.prepare('SELECT * FROM visit_services WHERE id = 1').get();
  assert.equal(row.status, 'completed');
  assert.equal(row.verified_by, 2);
  assert.equal(row.notes, 'в/в, реакции нет');
  assert.ok(row.verified_at);
});

test('палатная отметка ставит performed_at и НЕ трогает кассовый статус строки', () => {
  const db = seed();
  inLine(db, { id: 1, performerId: 2 });
  procedureComplete(db, { kind: 'inpatient', id: 1, notes: 'сделано' }, ACTOR.nurse);
  const row = db.prepare('SELECT * FROM admission_services WHERE id = 1').get();
  assert.ok(row.performed_at, 'выполнение отмечено');
  assert.equal(row.status, 'added', 'статус принадлежит счёту, а не медсестре');
  assert.equal(row.invoice_item_id, null);
  assert.equal(row.doctor_id, 1);
  const shown = proceduresList(db, {}, ACTOR.nurse).rows[0];
  assert.equal(shown.done, true);
  assert.equal(shown.done_by, 'Сестрина А.А.');
});

test('свободную процедуру, проведённую без «Взять», закрепляет за собой тот, кто её сделал', () => {
  const db = seed();
  outLine(db, { id: 1, doctorId: null, status: 'queued' });
  procedureComplete(db, { kind: 'outpatient', id: 1 }, ACTOR.nurse2);
  assert.equal(db.prepare('SELECT doctor_id FROM visit_services WHERE id = 1').get().doctor_id, 3);
});

// ─── 6. ДЕНЬГИ ──────────────────────────────────────────────────────────────

test('назначение медсестры не двигает гонорар врача в зарплатном отчёте', () => {
  const db = seed();
  paidConsultation(db);
  outLine(db, { id: 1, doctorId: null });
  const before = salaries(db);
  assert.equal(before['Иванов И.И.'], 80000, '40% от 200 000 без налога');

  procedureAssign(db, { kind: 'outpatient', id: 1, performer_id: 2 }, ACTOR.registrar);
  procedureComplete(db, { kind: 'outpatient', id: 1 }, ACTOR.nurse);

  const after = salaries(db);
  assert.deepEqual(after, before,
    'ни одна строка отчёта не изменилась: медсестра без ставок не заработала и у врача не отняла');
});

test('переназначение процедуры с врача на медсестру не трогает ЧУЖИЕ строки врача', () => {
  const db = seed();
  paidConsultation(db);
  outLine(db, { id: 1, doctorId: 1 });
  const before = salaries(db)['Иванов И.И.'];
  procedureAssign(db, { kind: 'outpatient', id: 1, performer_id: 2 }, ACTOR.admin);
  assert.equal(salaries(db)['Иванов И.И.'], before);
});

test('счёт госпитализации после назначения медсестры выставляется на ту же сумму', () => {
  const db = seed();
  inLine(db, { id: 1 });
  procedureAssign(db, { kind: 'inpatient', id: 1, performer_id: 2 }, ACTOR.registrar);
  procedureComplete(db, { kind: 'inpatient', id: 1 }, ACTOR.nurse);
  const { invoice } = createInvoiceForAdmission(db, { admission_id: 1, admission_service_ids: [1] }, ACTOR.admin);
  // Личная цена ЛЕЧАЩЕГО врача (150 000), а не каталожные 100 000: медсестра
  // встала в свою колонку и цену не уронила.
  assert.equal(invoice.subtotal, 150000);
});

test('назначение и отметка не трогают цену и количество строки', () => {
  const db = seed();
  outLine(db, { id: 1, doctorId: null, status: 'queued' });
  const before = db.prepare('SELECT quantity, unit_price, total, invoice_item_id FROM visit_services WHERE id = 1').get();
  procedureAssign(db, { kind: 'outpatient', id: 1, performer_id: 2 }, ACTOR.registrar);
  procedureComplete(db, { kind: 'outpatient', id: 1 }, ACTOR.nurse);
  const after = db.prepare('SELECT quantity, unit_price, total, invoice_item_id FROM visit_services WHERE id = 1').get();
  assert.deepEqual(after, before);
});

test('уже выставленный счёт визита не переоценивается при смене исполнителя', () => {
  const db = seed();
  outLine(db, { id: 1, doctorId: 1, status: 'queued' });
  const { invoice } = createInvoiceForVisit(db, { visit_id: 1, visit_service_ids: [1] }, ACTOR.admin);
  assert.equal(invoice.subtotal, 150000);   // личная цена врача
  procedureAssign(db, { kind: 'outpatient', id: 1, performer_id: 2 }, ACTOR.admin);
  const again = db.prepare('SELECT subtotal, total_amount FROM invoices WHERE id = ?').get(invoice.id);
  assert.equal(again.subtotal, 150000);
  assert.equal(again.total_amount, 150000);
});
