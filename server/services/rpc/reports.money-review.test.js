// Ревью денег (26.09) по PAY_BASIS_PERFORMED_V1 / INPATIENT_BONUS_V1 / PACKAGES_V1.
//
// Каждая проверка — одна находка ревью, на настоящих RPC (касса, счёт, отчёты,
// кабинет), а не на выражениях SQL:
//   C1 — отмена счёта не отнимает у врача оплату за сделанную работу, и работу
//        можно выставить заново; анализ со взятым материалом / результатом не
//        откатывается в «добавлена»; строка, уже привязанная к отменённому
//        счёту (старые данные), платит как невыставленная;
//   I1 — лечащий не получает «за направление» за свою госпитализацию: бонус —
//        только явно записанному направившему (admissions.referring_doctor_id);
//   I2 — источник «Кто направил», связанный с сотрудником, платит этому
//        сотруднику по его вкладке «Стационар», один раз на госпитализацию;
//   I4 — фильтр по филиалу не выбрасывает стационар (у счёта госпитализации
//        branch_id пуст — это своё здание);
//   M3 — скидка пакета у невыставленной строки — только в сроке пакета и
//        только для услуги из пакета (как у кассы);
//   скидка счёта, разнесённая на строку, не больше самой строки.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { runReport, doctorPaySummary } from './reports.js';
import { createInvoiceForVisit, createInvoiceForAdmission } from './billing.js';
import { voidInvoice } from './cashier.js';
import { requestAdmission, admissionOrderCreate } from './inpatient.js';

const admin = { id: 9, role: 'admin' };
const FROM = '2026-09-01';
const TO = '2026-09-30';
const DAY = '2026-09-10T09:00:00Z';

// Врач 1 — 30 % за приём (100 000, налог 6 %): одна строка = 28 200.
const ONE = 28200;

function clinic() {
  const db = openDb(':memory:');
  migrate(db);
  const u = db.prepare(`INSERT INTO users (id, username, password_hash, role, full_name, is_doctor, service_rates,
                          inpatient_referral_pct, inpatient_referral_fixed)
                        VALUES (?,?,?,?,?,?,?,?,?)`);
  u.run(1, 'doc', 'x', 'doctor', 'Доктор Д.', 1, JSON.stringify([{ service_id: 1, pct: 30 }]), 0, 0);
  u.run(9, 'adm', 'x', 'admin', 'Администратор', 0, '', 0, 0);
  db.prepare("INSERT INTO patients (id, mrn, full_name) VALUES (1,'P-1','Пациент')").run();
  db.prepare("INSERT INTO services (id, name, price, tax_rate, type) VALUES (1,'Приём',100000,6,'consultation')").run();
  db.prepare("INSERT INTO visits (id, patient_id, branch_id, visit_date, status) VALUES (1,1,NULL,?,'arrived')").run(DAY);
  let seq = 0;
  const line = ({ status = 'completed', service = 1, pkg = null } = {}) => {
    const id = ++seq;
    db.prepare(`INSERT INTO visit_services (id, visit_id, service_id, doctor_id, quantity, unit_price, total, status, package_id)
                VALUES (?,1,?,1,1,100000,100000,?,?)`).run(id, service, status, pkg);
    return id;
  };
  return { db, line };
}
const summary = (db, id = 1, extra = {}) => doctorPaySummary(db, { doctor_id: id, from: FROM, to: TO, ...extra }, admin);
const objects = (r) => r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]])));
const salaries = (db, extra = {}) => objects(runReport(db, { kind: 'doctor_salaries', from: FROM, to: TO, ...extra }, admin));

// ─── C1 ──────────────────────────────────────────────────────────────────────

test('C1: выполненный приём, счёт отменён — доля врача та же, и работу можно выставить заново', () => {
  const { db, line } = clinic();
  const vs = line({ status: 'completed' });
  const inv = createInvoiceForVisit(db, { visit_id: 1, visit_service_ids: [vs] }, admin).invoice;
  assert.equal(summary(db).outpatient.fee, ONE);
  const res = voidInvoice(db, { invoice_id: inv.id }, admin);
  const row = db.prepare('SELECT invoice_item_id, status FROM visit_services WHERE id = ?').get(vs);
  assert.ok(row, 'выполненная строка не удаляется');
  assert.equal(row.invoice_item_id, null, 'выполненная строка отпущена со счёта');
  assert.equal(row.status, 'completed', 'статус работы не трогается');
  assert.equal(res.released_services.length, 1);
  assert.equal(summary(db).outpatient.fee, ONE, 'отмена счёта отняла долю врача');
  const sal = salaries(db).find((o) => o['Врач'] === 'Доктор Д.');
  assert.equal(sal['Доля врача (гонорар)'], ONE);
  // Выставить заново.
  const again = createInvoiceForVisit(db, { visit_id: 1, visit_service_ids: [vs] }, admin).invoice;
  assert.notEqual(again.id, inv.id);
  assert.equal(summary(db).outpatient.fee, ONE);
});

test('C1: анализ со взятым материалом или результатом при отмене счёта не откатывается в «добавлена»', () => {
  const { db, line } = clinic();
  const collected = line({ status: 'collected' });
  const resulted = line({ status: 'resulted' });
  const fresh = line({ status: 'added' });
  const inv = createInvoiceForVisit(db, { visit_id: 1, visit_service_ids: [collected, resulted, fresh] }, admin).invoice;
  voidInvoice(db, { invoice_id: inv.id }, admin);
  const st = (id) => db.prepare('SELECT status, invoice_item_id FROM visit_services WHERE id = ?').get(id);
  assert.deepEqual(st(collected), { status: 'collected', invoice_item_id: null });
  assert.deepEqual(st(resulted), { status: 'resulted', invoice_item_id: null });
  assert.equal(st(fresh), undefined, 'неначатая строка без следа работы уходит вместе со счётом, как прежде');
  assert.equal(summary(db).outpatient.count, 2);
});

test('C1: с keep_services неначатая строка по-прежнему возвращается в «добавлена»', () => {
  const { db, line } = clinic();
  const q = line({ status: 'queued' });
  const inv = createInvoiceForVisit(db, { visit_id: 1, visit_service_ids: [q] }, admin).invoice;
  voidInvoice(db, { invoice_id: inv.id, keep_services: true }, admin);
  assert.deepEqual(db.prepare('SELECT status, invoice_item_id FROM visit_services WHERE id = ?').get(q),
    { status: 'added', invoice_item_id: null });
});

test('C1: старая выполненная строка, привязанная к отменённому счёту, платит как невыставленная', () => {
  const { db, line } = clinic();
  const vs = line({ status: 'completed' });
  db.prepare(`INSERT INTO invoices (id, invoice_number, visit_id, patient_id, subtotal, discount_amount, total_amount, paid_amount, status, created_at)
              VALUES (50,'INV-50',1,1,100000,50000,50000,0,'void',?)`).run(DAY);
  db.prepare("INSERT INTO invoice_items (id, invoice_id, service_id, description, quantity, unit_price, total) VALUES (50,50,1,'Приём',1,100000,100000)").run();
  db.prepare('UPDATE visit_services SET invoice_item_id = 50 WHERE id = ?').run(vs);
  const s = summary(db);
  assert.equal(s.outpatient.fee, ONE, 'скидка отменённого счёта не должна урезать долю');
  assert.equal(s.lines[0].invoiced, false);
  assert.equal(salaries(db).find((o) => o['Врач'] === 'Доктор Д.')['Доля врача (гонорар)'], ONE);
});

// ─── Скидка счёта на строку ─────────────────────────────────────────────────

test('скидка счёта, разнесённая на строку, не больше самой строки — доля не уходит в минус', () => {
  const { db, line } = clinic();
  const vs = line({ status: 'completed' });
  // Испорченный счёт: скидка больше суммы строк (остаток разносится на одну строку).
  db.prepare(`INSERT INTO invoices (id, invoice_number, visit_id, patient_id, subtotal, discount_amount, total_amount, paid_amount, status, created_at)
              VALUES (60,'INV-60',1,1,100000,150000,0,0,'paid',?)`).run(DAY);
  db.prepare("INSERT INTO invoice_items (id, invoice_id, service_id, description, quantity, unit_price, total) VALUES (60,60,1,'Приём',1,100000,100000)").run();
  db.prepare('UPDATE visit_services SET invoice_item_id = 60 WHERE id = ?').run(vs);
  const l = summary(db).lines[0];
  assert.equal(l.discount, 100000);
  assert.equal(l.fee, 0);
});

// ─── M3 ──────────────────────────────────────────────────────────────────────

test('M3: скидка пакета у невыставленной строки — только в сроке пакета и только для услуги пакета', () => {
  const { db, line } = clinic();
  db.prepare("INSERT INTO services (id, name, price, tax_rate, type) VALUES (2,'Анализ',100000,6,'lab')").run();
  db.prepare("UPDATE users SET service_rates = ? WHERE id = 1").run(JSON.stringify([{ service_id: 1, pct: 30 }, { service_id: 2, pct: 30 }]));
  const pk = db.prepare(`INSERT INTO service_templates (name, service_ids, discount_percent, valid_from, valid_until)
                         VALUES (?,?,?,?,?)`);
  const live = pk.run('Действующий', JSON.stringify([1]), 50, '2026-09-01', '2026-09-30').lastInsertRowid;
  const expired = pk.run('Истёк', JSON.stringify([1]), 50, '2026-08-01', '2026-08-31').lastInsertRowid;
  const a = line({ pkg: live });            // в сроке, услуга в пакете → скидка 50 %
  const b = line({ pkg: expired });         // срок прошёл → без скидки пакета
  const c = line({ service: 2, pkg: live }); // услуга не из пакета → без скидки пакета
  const fee = (id) => summary(db).lines.find((l) => l.kind === 'out' && l.id === id).fee;
  assert.equal(fee(a), ONE / 2);
  assert.equal(fee(b), ONE);
  assert.equal(fee(c), ONE);
  // Касса выставляет действующий пакет с той же скидкой.
  createInvoiceForVisit(db, { visit_id: 1, visit_service_ids: [a] }, admin);
  assert.equal(fee(a), ONE / 2);
});

// ─── СТАЦИОНАР: I1 / I2 / I4 ─────────────────────────────────────────────────

// Госпитализация 1: лечащий — врач 3 (он же admissions.doctor_id, как пишет
// назначение лечащего); операция 1 000 000 выполнена и оплачена.
function hospital() {
  const db = openDb(':memory:');
  migrate(db);
  const u = db.prepare(`INSERT INTO users (id, username, password_hash, role, full_name, is_doctor, inpatient_rates,
                          inpatient_referral_pct, inpatient_referral_fixed)
                        VALUES (?,?,?,?,?,?,?,?,?)`);
  u.run(3, 'att', 'x', 'doctor', 'Лечащий Л.', 1, JSON.stringify([{ service_id: 1, pct: 10 }]), 2, 100000);
  u.run(4, 'emp', 'x', 'doctor', 'Сотрудник С.', 1, '', 5, 0);
  u.run(9, 'adm', 'x', 'admin', 'Администратор', 0, '', 0, 0);
  db.prepare("INSERT INTO branches (id, name, letter) VALUES (1, 'Главный', 'A') ON CONFLICT(id) DO UPDATE SET name = excluded.name").run();
  db.prepare('UPDATE branch_identity SET branch_id = 1 WHERE id = 1').run();
  db.prepare("INSERT INTO patients (id, mrn, full_name) VALUES (1,'P-1','Пациент')").run();
  db.prepare("INSERT INTO services (id, name, price, tax_rate, type) VALUES (1,'Операция',1000000,0,'other')").run();
  db.prepare(`INSERT INTO admissions (id, admission_no, patient_id, doctor_id, attending_doctor_id, status)
              VALUES (1,'A-1',1,3,3,'active')`).run();
  db.prepare(`INSERT INTO admission_services (id, admission_id, service_id, doctor_id, performer_id, quantity, unit_price, total, status, billable, performed_at)
              VALUES (1,1,1,3,3,1,1000000,1000000,'added',1,?)`).run(DAY);
  const { invoice } = createInvoiceForAdmission(db, { admission_id: 1, admission_service_ids: [1] }, admin);
  db.prepare("UPDATE invoices SET paid_amount = total_amount, status = 'paid', created_at = ? WHERE id = ?").run(DAY, invoice.id);
  return db;
}

test('I1: лечащий (admissions.doctor_id) за свою госпитализацию «за направление» не получает', () => {
  const db = hospital();
  assert.equal(summary(db, 3).inpatient_referral.reward, 0);
  // Записан направившим явно — получает, даже если это тот же человек.
  db.prepare('UPDATE admissions SET referring_doctor_id = 3 WHERE id = 1').run();
  assert.equal(summary(db, 3).inpatient_referral.reward, 2 * 10000 + 100000);
});

test('I1: направившего пишут заявка врача из кабинета и заявка с явным врачом; без врача — пусто', () => {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (4,'doc','x','doctor'), (2,'reg','x','registrar')").run();
  db.prepare("INSERT INTO patients (id, full_name) VALUES (1,'А'), (2,'Б'), (3,'В')").run();
  const a = requestAdmission(db, { patient_id: 1, doctor_id: 4 }, { id: 4, role: 'doctor' }).admission;
  assert.equal(a.referring_doctor_id, 4);
  const b = admissionOrderCreate(db, { patient_id: 2, doctor_id: 4 }, { id: 2, role: 'registrar' }).admission;
  assert.equal(b.referring_doctor_id, 4);
  const c = admissionOrderCreate(db, { patient_id: 3 }, { id: 2, role: 'registrar' }).admission;
  assert.equal(c.referring_doctor_id, null);
});

test('I2: «Кто направил» — источник сотрудника: платит сотруднику по его вкладке «Стационар», один раз', () => {
  const db = hospital();
  const own = db.prepare('SELECT id FROM referral_sources WHERE doctor_id = 4').get().id;
  db.prepare('UPDATE admissions SET referral_source_id = ? WHERE id = 1').run(own);
  // 5 % от 1 000 000.
  assert.equal(summary(db, 4).inpatient_referral.reward, 50000);
  const refs = objects(runReport(db, { kind: 'referrals', from: FROM, to: TO }, admin))
    .filter((o) => o['Где'] === 'Стационар' && o['Источник'] === 'Сотрудник С.');
  assert.equal(refs.length, 1);
  assert.equal(refs[0]['Вознаграждение'], 50000);
  // Тот же сотрудник записан и направившим врачом — всё равно один раз.
  db.prepare('UPDATE admissions SET referring_doctor_id = 4 WHERE id = 1').run();
  assert.equal(summary(db, 4).inpatient_referral.reward, 50000);
  const detail = objects(runReport(db, { kind: 'referrals_detail', from: FROM, to: TO }, admin))
    .filter((o) => o['Источник'] === 'Сотрудник С.');
  assert.equal(detail.length, 1);
});

test('I4: фильтр по своему филиалу оставляет стационарную долю и «за направление в стационар»', () => {
  const db = hospital();
  db.prepare('UPDATE admissions SET referring_doctor_id = 3 WHERE id = 1').run();
  const all = salaries(db).find((o) => o['Врач'] === 'Лечащий Л.');
  const own = salaries(db, { branch_ids: [1] }).find((o) => o['Врач'] === 'Лечащий Л.');
  assert.ok(own, 'стационар пропал под фильтром филиала');
  assert.equal(own['Стационар: гонорар'], 100000);
  assert.equal(own['Стационар: гонорар'], all['Стационар: гонорар']);
  assert.equal(own['За направление в стационар'], all['За направление в стационар']);
  // Чужой филиал — стационара этой установки там нет.
  db.prepare("INSERT INTO branches (id, name, letter) VALUES (2, 'Второй', 'B')").run();
  assert.ok(!salaries(db, { branch_ids: [2] }).some((o) => o['Врач'] === 'Лечащий Л.'));
});
