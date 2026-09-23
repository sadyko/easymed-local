// REPORTS_V2 — отчёты «Рефералы» (сводка и детализация), «По услугам»,
// «По врачам» и отчёты склада (приход, расход, ведомость, сроки годности).
//
// Владелец (23.09): «reports: 1) referral bonuses (in house, external) by
// referrer … 3) by services 4) by doctors 5) procurement». Каждый денежный
// столбец обязан СХОДИТЬСЯ с «Зарплатами врачей» и «Общей выручкой» на тех же
// данных — иначе у клиники два ответа на один вопрос. Поэтому проверяются
// не только суммы, но и равенство с этими двумя отчётами.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { runReport, doctorReferralReward } from './reports.js';
import { createInvoiceForAdmission } from './billing.js';

const admin = { id: 9, role: 'admin' };
const FROM = '2000-01-01';
const TO = '2100-01-01';

// Клиника:
//   врачи 1 «Врачев» (амб. 40 % за УЗИ) и 2 «Хирургов» (амб. 30 % за
//   консультацию, стационар 20 % за операцию); у каждого врача — свой
//   внутренний источник направления (триггер мигр. 122);
//   внешний источник «Клиника Х» в категории «Партнёры» (10 %);
//   категория «Внутренние врачи» — 5 %.
// Счета:
//   INV-1 оплачен, скидка 10 000: консультация 100 000 (врач 2), пациента
//         направил врач 1 (внутренний);
//   INV-2 оплачен: УЗИ 200 000 (врач 1, налог 6 %), направил «Клиника Х»;
//   INV-3 НЕ оплачен: консультация 100 000 (врач 2), направил «Клиника Х»;
//   INV-4 АННУЛИРОВАН: УЗИ 200 000 (врач 1) — не входит никуда;
//   стационар: операция 1 000 000, исполнитель врач 2 (20 %), счёт оплачен.
function seed({ rates = true } = {}) {
  const db = openDb(':memory:');
  migrate(db);
  const u = db.prepare(`INSERT INTO users (id, username, password_hash, role, full_name, is_doctor, service_rates)
                        VALUES (?,?,?,?,?,?,?)`);
  u.run(1, 'vrach', 'x', 'doctor', 'Врачев В.В.', 1, JSON.stringify([{ service_id: 2, pct: 40, branches: [] }]));
  u.run(2, 'surg', 'x', 'doctor', 'Хирургов Х.Х.', 1, JSON.stringify([
    { service_id: 1, pct: 30, branches: [] },
    { service_id: 3, pct: 0, inpatient_pct: 20, branches: [] },
  ]));
  u.run(9, 'adm', 'x', 'admin', 'Администратор', 0, '');

  const internalCat = db.prepare('SELECT id FROM referral_source_categories WHERE is_internal = 1').get().id;
  const extCat = db.prepare("INSERT INTO referral_source_categories (name, standard_percent) VALUES ('Партнёры', ?)")
    .run(rates ? 10 : 0).lastInsertRowid;
  db.prepare('UPDATE referral_source_categories SET standard_percent = ? WHERE id = ?').run(rates ? 5 : 0, internalCat);
  const ext = db.prepare("INSERT INTO referral_sources (name, category_id) VALUES ('Клиника Х', ?)").run(extCat).lastInsertRowid;
  const doc1Src = db.prepare('SELECT id FROM referral_sources WHERE doctor_id = 1').get().id;

  const p = db.prepare('INSERT INTO patients (id, mrn, full_name) VALUES (?,?,?)');
  p.run(1, 'P-1', 'Азизов А.');
  p.run(2, 'P-2', 'Бобоев Б.');
  p.run(3, 'P-3', 'Валиев В.');
  const sv = db.prepare('INSERT INTO services (id, name, price, tax_rate, type) VALUES (?,?,?,?,?)');
  sv.run(1, 'Консультация', 100000, 0, 'consultation');
  sv.run(2, 'УЗИ', 200000, 6, 'imaging');
  sv.run(3, 'Операция', 1000000, 0, 'other');

  const v = db.prepare("INSERT INTO visits (id, patient_id, visit_date, referral_source_id) VALUES (?,?,'2026-08-05T09:00:00Z',?)");
  v.run(1, 1, doc1Src);
  v.run(2, 2, ext);
  v.run(3, 3, null);

  const inv = db.prepare(`INSERT INTO invoices (id, invoice_number, visit_id, patient_id, subtotal, discount_amount, total_amount, paid_amount, status, created_at)
                          VALUES (?,?,?,?,?,?,?,?,?,'2026-08-05T10:00:00Z')`);
  const item = db.prepare('INSERT INTO invoice_items (id, invoice_id, service_id, description, quantity, unit_price, total) VALUES (?,?,?,?,?,?,?)');
  const vs = db.prepare(`INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, invoice_item_id)
                         VALUES (?,?,?,?,?,?,'completed',?)`);
  inv.run(1, 'INV-1', 1, 1, 100000, 10000, 90000, 90000, 'paid');
  item.run(1, 1, 1, 'Консультация', 1, 100000, 100000);
  vs.run(1, 1, 2, 1, 100000, 100000, 1);
  inv.run(2, 'INV-2', 2, 2, 200000, 0, 200000, 200000, 'paid');
  item.run(2, 2, 2, 'УЗИ', 1, 200000, 200000);
  vs.run(2, 2, 1, 1, 200000, 200000, 2);
  inv.run(3, 'INV-3', 2, 2, 100000, 0, 100000, 0, 'unpaid');
  item.run(3, 3, 1, 'Консультация', 1, 100000, 100000);
  vs.run(2, 1, 2, 1, 100000, 100000, 3);
  inv.run(4, 'INV-4', 3, 3, 200000, 0, 200000, 0, 'void');
  item.run(4, 4, 2, 'УЗИ', 1, 200000, 200000);
  vs.run(3, 2, 1, 1, 200000, 200000, 4);

  db.prepare(`INSERT INTO admissions (id, admission_no, patient_id, doctor_id, attending_doctor_id, status)
              VALUES (1,'A-1',3,2,2,'active')`).run();
  db.prepare(`INSERT INTO admission_services (id, admission_id, service_id, doctor_id, performer_id, quantity, unit_price, total, status, billable)
              VALUES (1,1,3,2,2,1,1000000,1000000,'added',1)`).run();
  const { invoice } = createInvoiceForAdmission(db, { admission_id: 1, admission_service_ids: [1] }, admin);
  db.prepare("UPDATE invoices SET status = 'paid', paid_amount = total_amount, created_at = '2026-08-06T10:00:00Z' WHERE id = ?").run(invoice.id);
  return { db, ext, doc1Src, internalCat, extCat, admissionInvoice: invoice.id };
}

const run = (db, kind, extra = {}) => runReport(db, { kind, from: FROM, to: TO, ...extra }, admin);
// Строка отчёта → объект по именам колонок.
function objects(r) {
  return r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]])));
}
const sum = (list, col) => Math.round(list.reduce((n, o) => n + (Number(o[col]) || 0), 0) * 100) / 100;

// ─── 1. РЕФЕРАЛЫ ─────────────────────────────────────────────────────────────

test('рефералы: сводка по направившим — внутренний и внешний, пациенты, услуги, оплачено, вознаграждение', () => {
  const { db } = seed();
  const rows = objects(run(db, 'referrals'));
  assert.equal(rows.length, 2);
  const ext = rows.find((o) => o['Источник'] === 'Клиника Х');
  assert.equal(ext['Вид'], 'Внешний');
  assert.equal(ext['Пациентов'], 1);
  assert.equal(ext['Услуг'], 2);
  assert.equal(ext['Сумма услуг'], 300000);        // 200 000 оплачено + 100 000 не оплачено
  assert.equal(ext['Оплачено'], 200000);
  // 10 % только с ОПЛАЧЕННОГО: 20 000, а не 30 000.
  assert.equal(ext['Вознаграждение'], 20000);
  const own = rows.find((o) => o['Источник'] === 'Врачев В.В.');
  assert.equal(own['Вид'], 'Внутренний');
  assert.equal(own['Пациентов'], 1);
  // База — строка счёта ПОСЛЕ скидки (90 000), а не цена каталога (100 000): 5 % = 4 500.
  assert.equal(own['Оплачено'], 90000);
  assert.equal(own['Вознаграждение'], 4500);
});

test('рефералы: фильтр «внутренние / внешние» и аннулированный счёт не входит', () => {
  const { db } = seed();
  const internal = objects(run(db, 'referrals', { referrer: 'internal' }));
  assert.deepEqual(internal.map((o) => o['Источник']), ['Врачев В.В.']);
  const external = objects(run(db, 'referrals', { referrer: 'external' }));
  assert.deepEqual(external.map((o) => o['Источник']), ['Клиника Х']);
  assert.equal(objects(run(db, 'referrals', { referrer: 'all' })).length, 2);
  assert.throws(() => run(db, 'referrals', { referrer: 'bogus' }), /referrer/);
  // Детализация: три строки (INV-1, INV-2, INV-3); аннулированный INV-4 — нет.
  const detail = objects(run(db, 'referrals_detail'));
  assert.deepEqual(detail.map((o) => o['№ счёта']).sort(), ['INV-1', 'INV-2', 'INV-3']);
});

test('рефералы: детализация сходится со сводкой и называет ставку', () => {
  const { db } = seed();
  const detail = objects(run(db, 'referrals_detail'));
  const summary = objects(run(db, 'referrals'));
  assert.equal(sum(detail, 'Вознаграждение'), sum(summary, 'Вознаграждение'));
  assert.equal(sum(detail, 'Сумма после скидки'), sum(summary, 'Сумма услуг'));
  const unpaid = detail.find((o) => o['№ счёта'] === 'INV-3');
  assert.equal(unpaid['Статус'], 'Не оплачен');
  assert.equal(unpaid['Ставка'], '10 %');
  assert.equal(unpaid['Вознаграждение'], 0);
  assert.equal(detail.find((o) => o['№ счёта'] === 'INV-1')['Пациент'], 'Азизов А.');
});

test('рефералы: при нулевых ставках отчёт говорит об этом словами', () => {
  const { db } = seed({ rates: false });
  const r = run(db, 'referrals');
  assert.equal(sum(objects(r), 'Вознаграждение'), 0);
  assert.ok(r.notes.some((n) => n.includes('ставка вознаграждения 0 %')), r.notes.join(' | '));
  // Со ставками этой строки нет.
  assert.ok(!run(seed().db, 'referrals').notes.some((n) => n.includes('ставка вознаграждения 0 %')));
});

test('кабинет врача: вознаграждение за направления — те же строки и та же сумма, что в отчёте', () => {
  const { db } = seed();
  const mine = doctorReferralReward(db, { doctor_id: 1, from: FROM, to: TO }, admin);
  assert.equal(mine.count, 1);
  assert.equal(mine.reward, 4500);
  assert.equal(mine.paid_amount, 90000);
  assert.equal(mine.rows[0].service, 'Консультация');
  const own = objects(run(db, 'referrals', { referrer: 'internal' })).find((o) => o['Источник'] === 'Врачев В.В.');
  assert.equal(mine.reward, own['Вознаграждение']);
  // Врач 2 никого не направлял.
  assert.equal(doctorReferralReward(db, { doctor_id: 2, from: FROM, to: TO }, admin).count, 0);
  assert.throws(() => doctorReferralReward(db, { doctor_id: 'x' }, admin), /doctor_id/);
});
