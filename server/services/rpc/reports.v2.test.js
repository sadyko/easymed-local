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
import { receiveStockLines, issueStockLines, adjustStock } from './procurement.js';
import { dispenseFromHolding } from './holdings.js';
import { today as todayOf } from '../domain/day.js';

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

// ─── 2. ПО УСЛУГАМ ───────────────────────────────────────────────────────────

test('по услугам: строка на услугу и место, деньги по строке, аннулированный счёт не входит', () => {
  const { db } = seed();
  const rows = objects(run(db, 'by_services'));
  const cons = rows.find((o) => o['Услуга'] === 'Консультация');
  assert.equal(cons['Группа'], 'Консультации');
  assert.equal(cons['Где'], 'Амбулатория');
  assert.equal(cons['Кол-во'], 2);
  assert.equal(cons['Сумма'], 200000);
  assert.equal(cons['Скидка'], 10000);
  assert.equal(cons['После скидки и налога'], 190000);
  assert.equal(cons['Доля врача'], 57000);            // 30 % от 90 000 + 30 % от 100 000
  assert.equal(cons['Остаток клинике'], 133000);
  assert.equal(cons['Оплачено'], 90000);               // INV-3 не оплачен
  const usi = rows.find((o) => o['Услуга'] === 'УЗИ');
  assert.equal(usi['Кол-во'], 1, 'аннулированный INV-4 посчитан');
  assert.equal(usi['Налог'], 12000);
  assert.equal(usi['Доля врача'], 75200);              // 40 % от 188 000 (после налога)
  const op = rows.find((o) => o['Услуга'] === 'Операция');
  assert.equal(op['Где'], 'Стационар');
  assert.equal(op['Группа'], 'Хирургия');
  assert.equal(op['Доля врача'], 200000);              // стационарная доля 20 %
});

test('по услугам: «Доля врача» сходится с «Общей выручкой», а по оплаченным — с «Зарплатами врачей»', () => {
  const { db } = seed();
  const all = objects(run(db, 'by_services'));
  const revenue = objects(run(db, 'total_revenue'));
  assert.equal(sum(all, 'Доля врача'), sum(revenue, 'Доля врача'));
  assert.equal(sum(all, 'Сумма') - sum(all, 'Скидка'), sum(revenue, 'После скидки'));
  assert.equal(sum(all, 'Налог'), sum(revenue, 'Налог'));
  const paid = objects(run(db, 'by_services', { paid: 'paid' }));
  const salaries = objects(run(db, 'doctor_salaries'));
  assert.equal(sum(paid, 'Доля врача'), sum(salaries, 'Итого к выплате'));
  assert.equal(sum(paid, 'Доля врача'), 302200);
  assert.ok(!paid.some((o) => o['Оплачено'] === 0), 'неоплаченная строка в режиме «Только оплаченные»');
  assert.throws(() => run(db, 'by_services', { paid: 'maybe' }), /paid/);
});

test('по услугам: фильтр по группе', () => {
  const { db } = seed();
  const cons = objects(run(db, 'by_services', { group: 'consultation' }));
  assert.deepEqual(cons.map((o) => o['Услуга']), ['Консультация']);
  const surg = objects(run(db, 'by_services', { group: 'other' }));
  assert.deepEqual(surg.map((o) => o['Услуга']), ['Операция']);
  assert.equal(objects(run(db, 'by_services', { group: 'all' })).length, 3);
  assert.throws(() => run(db, 'by_services', { group: 'bogus' }), /group/);
});

// ─── 3. ПО ВРАЧАМ ────────────────────────────────────────────────────────────

test('по врачам: работа по всем счетам, выплата по оплаченным, вознаграждение как направившему', () => {
  const { db } = seed();
  const rows = objects(run(db, 'by_doctors'));
  const v = rows.find((o) => o['Врач'] === 'Врачев В.В.');
  assert.equal(v['Пациентов'], 1);
  assert.equal(v['Визитов'], 1);
  assert.equal(v['Услуг'], 1, 'аннулированный INV-4 посчитан как работа');
  assert.equal(v['Выставлено'], 200000);
  assert.equal(v['Доля за услуги'], 75200);
  assert.equal(v['Вознаграждение за направления'], 4500);   // направил пациента INV-1
  assert.equal(v['Итого к выплате'], 79700);
  const s = rows.find((o) => o['Врач'] === 'Хирургов Х.Х.');
  assert.equal(s['Пациентов'], 3);
  assert.equal(s['Визитов'], 2);
  assert.equal(s['Госпитализаций'], 1);
  assert.equal(s['Услуг'], 3);
  assert.equal(s['Выставлено'], 1190000);          // 90 000 + 100 000 (не оплачен) + 1 000 000
  assert.equal(s['Оплачено'], 1090000);
  assert.equal(s['Доля за услуги'], 27000);         // неоплаченная консультация доли не даёт
  assert.equal(s['Стационарная доля'], 200000);
  assert.equal(s['Итого к выплате'], 227000);
});

test('по врачам: доли в сумме равны «Зарплатам врачей», итог — они же плюс вознаграждение за направления', () => {
  const { db } = seed();
  const mine = objects(run(db, 'by_doctors'));
  const sal = objects(run(db, 'doctor_salaries'));
  assert.equal(sum(mine, 'Доля за услуги'), sum(sal, 'Доля врача (гонорар)'));
  assert.equal(sum(mine, 'Стационарная доля'), sum(sal, 'Стационар: гонорар'));
  const referral = sum(objects(run(db, 'referrals')).filter((o) => o['Вид'] === 'Внутренний'), 'Вознаграждение');
  assert.equal(sum(mine, 'Вознаграждение за направления'), referral);
  assert.equal(sum(mine, 'Итого к выплате'), sum(sal, 'Итого к выплате') + referral);
  // По каждому врачу — тоже, а не только в сумме.
  for (const o of sal) {
    const m = mine.find((x) => x['Врач'] === o['Врач']);
    assert.equal(m['Доля за услуги'], o['Доля врача (гонорар)'], o['Врач']);
    assert.equal(m['Стационарная доля'], o['Стационар: гонорар'], o['Врач']);
  }
});

test('врач × услуга: разбивка складывается в доли врача', () => {
  const { db } = seed();
  const rows = objects(run(db, 'doctor_services'));
  const cons = rows.find((o) => o['Врач'] === 'Хирургов Х.Х.' && o['Услуга'] === 'Консультация');
  assert.equal(cons['Где'], 'Амбулатория');
  assert.equal(cons['Кол-во'], 2);
  assert.equal(cons['Пациентов'], 2);
  assert.equal(cons['Выставлено'], 190000);
  assert.equal(cons['Оплачено'], 90000);
  assert.equal(cons['Доля врача'], 27000);
  const op = rows.find((o) => o['Врач'] === 'Хирургов Х.Х.' && o['Услуга'] === 'Операция');
  assert.equal(op['Где'], 'Стационар');
  const byDoc = objects(run(db, 'by_doctors'));
  for (const d of byDoc) {
    const own = rows.filter((o) => o['Врач'] === d['Врач']);
    assert.equal(sum(own, 'Доля врача'), d['Доля за услуги'] + d['Стационарная доля'], d['Врач']);
    assert.equal(sum(own, 'Выставлено'), d['Выставлено'], d['Врач']);
  }
});

// ─── 4. ЗАКУПКИ И СКЛАД ──────────────────────────────────────────────────────
//
// Склад заводится НАСТОЯЩИМИ дверями (приход, выдача, списание из отдела и со
// склада, корректировка): ведомость проверяется на тех движениях, которые
// пишет программа, а не на придуманных руками.

const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

function seedStock() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, role, full_name) VALUES (9,'adm','x','admin','Администратор')").run();
  db.prepare("INSERT INTO patients (id, mrn, full_name) VALUES (1,'P-1','Азизов А.')").run();
  db.prepare("INSERT INTO visits (id, patient_id, visit_date) VALUES (1,1,strftime('%Y-%m-%dT%H:%M:%SZ','now'))").run();
  const dep = db.prepare("INSERT INTO departments (name) VALUES ('Хирургия Р')").run().lastInsertRowid;
  db.prepare("INSERT INTO suppliers (id, name) VALUES (1,'ООО МедСнаб')").run();
  db.prepare("INSERT INTO purchase_orders (id, po_number, supplier_id, status) VALUES (1,'PO-1',1,'ordered')").run();
  const p = db.prepare('INSERT INTO products (id, name, unit, base_unit, sale_price, on_hand, avg_cost) VALUES (?,?,?,?,?,0,0)');
  p.run(1, 'Перчатки', 'шт', 'шт', 1500);
  p.run(2, 'Бинт', 'шт', 'шт', 3000);
  p.run(3, 'Шприц', 'шт', 'шт', 500);
  const day = todayOf(db);
  // Январский приход перчаток — ДО периода ведомости (он даёт начальный остаток).
  receiveStockLines(db, { lines: [{ product_id: 1, qty: 100, unit_cost: 1000, supplier_id: 1 }] }, admin);
  db.prepare("UPDATE stock_movements SET created_at = '2026-01-10T08:00:00Z' WHERE product_id = 1").run();
  receiveStockLines(db, { lines: [
    { product_id: 2, qty: 50, unit_cost: 2000, supplier_id: 1, batch_no: 'B-OLD', expiry_date: addDays(day, -5) },
    { product_id: 3, qty: 40, unit_cost: 500, batch_no: 'S-SOON', expiry_date: addDays(day, 10) },
  ] }, admin);
  // Приход без поставщика по строке, но по ЗАКАЗУ: поставщик берётся у заказа.
  db.prepare(`INSERT INTO stock_movements (product_id, kind, qty, unit_cost, reference_type, reference_id, note, created_by, branch_id)
              VALUES (1, 'receive', 20, 1300, 'purchase_order', 1, 'PO PO-1', 9, 1)`).run();
  db.prepare('UPDATE products SET on_hand = on_hand + 20, avg_cost = 1050 WHERE id = 1').run();
  // Выдача в отдел — со склада; расход на пациента — из отдела и со склада.
  issueStockLines(db, { holder: { type: 'department', id: dep }, lines: [{ product_id: 1, qty: 30, unit: 'base' }] }, admin);
  dispenseFromHolding(db, { product_id: 1, quantity: 5, visit_id: 1, holder: { type: 'department', id: dep } }, admin);
  dispenseFromHolding(db, { product_id: 1, quantity: 2, visit_id: 1, holder: { type: 'warehouse' } }, admin);
  adjustStock(db, { product_id: 1, qty: -3, note: 'бой' }, admin);
  return { db, day };
}

test('закупки: поставщик — из supplier_id (или заказа), а не примечание; итоги по поставщикам', () => {
  const { db } = seedStock();
  const r = run(db, 'procurement');
  const rows = objects(r);
  assert.equal(rows.length, 4);
  const byProduct = (n) => rows.filter((o) => o['Товар'] === n);
  assert.deepEqual(byProduct('Перчатки').map((o) => o['Поставщик']).sort(), ['ООО МедСнаб', 'ООО МедСнаб']);
  assert.equal(byProduct('Шприц')[0]['Поставщик'], 'Поставщик не указан');
  assert.equal(byProduct('Бинт')[0]['Партия'], 'B-OLD');
  assert.equal(byProduct('Бинт')[0]['Сумма'], 100000);
  // Примечание движения («PO PO-1») — своей колонкой, а не вместо поставщика.
  assert.ok(rows.some((o) => o['Примечание'] === 'PO PO-1' && o['Поставщик'] === 'ООО МедСнаб'));
  // 100×1000 + 20×1300 + 50×2000 = 226 000 у МедСнаба; шприцы 40×500 = 20 000 без поставщика.
  assert.ok(r.notes.includes('Итого — ООО МедСнаб: 3 позиции, 226 000 сум.'), r.notes.join(' | '));
  assert.ok(r.notes.includes('Итого — Поставщик не указан: 1 позиция, 20 000 сум.'), r.notes.join(' | '));
});

test('расход: выдача в отдел, расход на пациента из отдела и со склада — по себестоимости', () => {
  const { db } = seedStock();
  const lines = objects(run(db, 'stock_consumption'));
  assert.deepEqual(lines.map((o) => o['Вид']).sort(), ['Выдача', 'Расход на пациента', 'Расход на пациента']);
  const issue = lines.find((o) => o['Вид'] === 'Выдача');
  assert.equal(issue['Получатель / откуда'], 'Отдел: Хирургия Р');
  assert.equal(issue['Кол-во'], 30);
  const fromDept = lines.find((o) => o['Вид'] === 'Расход на пациента' && o['Получатель / откуда'] === 'Отдел: Хирургия Р');
  assert.equal(fromDept['Пациент'], 'Азизов А.');
  assert.equal(fromDept['Кол-во'], 5);
  assert.ok(lines.some((o) => o['Получатель / откуда'] === 'Склад' && o['Кол-во'] === 2));
  for (const o of lines) assert.equal(o['Сумма'], Math.round(o['Кол-во'] * o['Себестоимость ед.'] * 100) / 100);

  const holders = objects(run(db, 'stock_consumption', { by: 'holder' }));
  const dept = holders.find((o) => o['Получатель / откуда'] === 'Отдел: Хирургия Р');
  assert.equal(dept['Выдано со склада (себестоимость)'], issue['Сумма']);
  assert.equal(dept['Списано на пациентов (себестоимость)'], fromDept['Сумма']);
  const patients = objects(run(db, 'stock_consumption', { by: 'patient' }));
  assert.equal(patients.length, 1);
  assert.equal(patients[0]['Пациент'], 'Азизов А.');
  assert.equal(patients[0]['Движений'], 2);
  assert.equal(sum(patients, 'Списано (себестоимость)'), sum(lines.filter((o) => o['Вид'] !== 'Выдача'), 'Сумма'));
  assert.throws(() => run(db, 'stock_consumption', { by: 'bogus' }), /by must be/);
});

test('ведомость: начало + приход − выдано − списано ± корректировки = конец; по сегодня сходится с остатком товара', () => {
  const { db, day } = seedStock();
  const r = runReport(db, { kind: 'stock_statement', from: '2026-02-01', to: day }, admin);
  const rows = objects(r);
  const g = rows.find((o) => o['Товар'] === 'Перчатки');
  assert.equal(g['Начало: кол-во'], 100);              // январский приход — до периода
  assert.equal(g['Приход: кол-во'], 20);
  assert.equal(g['Выдано: кол-во'], 30);
  assert.equal(g['Списано на пациентов: кол-во'], 2);  // только со склада; из отдела — не склад
  assert.equal(g['Корректировки: кол-во'], -3);
  assert.equal(g['Конец: кол-во'], 85);
  for (const o of rows) {
    const calc = o['Начало: кол-во'] + o['Приход: кол-во'] - o['Выдано: кол-во'] - o['Списано на пациентов: кол-во'] + o['Корректировки: кол-во'];
    assert.equal(Math.round(calc * 100) / 100, o['Конец: кол-во'], o['Товар']);
    const money = o['Начало: сумма'] + o['Приход: сумма'] - o['Выдано: сумма'] - o['Списано на пациентов: сумма'] + o['Корректировки: сумма'];
    assert.equal(Math.round(money * 100) / 100, o['Конец: сумма'], o['Товар'] + ': деньги');
    const onHand = db.prepare('SELECT on_hand FROM products WHERE name = ?').get(o['Товар']).on_hand;
    assert.equal(o['Конец: кол-во'], onHand, o['Товар'] + ': конец периода по сегодня ≠ остаток товара');
    assert.equal(o['В карточке товара'], onHand);
    assert.equal(o['Расхождение'], 0);
  }
  assert.equal(g['Конец: сумма'], 85 * 1050);          // по средней себестоимости товара
  assert.ok(r.notes.some((n) => n.includes('совпадает с остатком в карточке у всех товаров')), r.notes.join(' | '));
});

test('ведомость: остаток, поправленный мимо журнала, назван расхождением; прошлый период — без сверки', () => {
  const { db, day } = seedStock();
  db.prepare('UPDATE products SET on_hand = on_hand + 7 WHERE id = 1').run();
  const r = runReport(db, { kind: 'stock_statement', from: '2026-02-01', to: day }, admin);
  const g = objects(r).find((o) => o['Товар'] === 'Перчатки');
  assert.equal(g['Расхождение'], -7);
  assert.ok(r.notes.some((n) => n.includes('не совпадает с остатком в карточке')), r.notes.join(' | '));
  const jan = runReport(db, { kind: 'stock_statement', from: '2026-01-01', to: '2026-01-31' }, admin);
  assert.ok(!jan.columns.includes('Расхождение'), 'у прошлого периода сверять не с чем');
  const gj = objects(jan).find((o) => o['Товар'] === 'Перчатки');
  assert.deepEqual([gj['Начало: кол-во'], gj['Приход: кол-во'], gj['Конец: кол-во']], [0, 100, 100]);
});

test('сроки годности: просроченное и истекающее с ценой — расчётом «Сроков годности»', () => {
  const { db } = seedStock();
  const r = run(db, 'stock_expiry');
  const rows = objects(r);
  assert.deepEqual(rows.map((o) => o['Состояние']), ['Просрочено', 'Истекает']);
  const bint = rows[0];
  assert.equal(bint['Товар'], 'Бинт');
  assert.equal(bint['Партия'], 'B-OLD');
  assert.equal(bint['Остаток (расчёт)'], 50);
  assert.equal(bint['Стоимость'], 100000);
  assert.equal(bint['Поставщик'], 'ООО МедСнаб');
  assert.equal(rows[1]['Товар'], 'Шприц');
  assert.equal(rows[1]['Стоимость'], 20000);
  assert.ok(r.notes.some((n) => n.includes('расчёт, а не факт')), 'нет оговорки «это расчёт»');
  // Перчатки без срока в отчёт не попадают.
  assert.ok(!rows.some((o) => o['Товар'] === 'Перчатки'));
});

test('склад не ездит: «только соседнее здание» — пусто во всех четырёх видах', () => {
  const { db } = seedStock();
  db.prepare("INSERT INTO branches (name, letter, active) VALUES ('Чиланзар','B',0)").run();
  for (const kind of ['procurement', 'stock_consumption', 'stock_statement', 'stock_expiry']) {
    const r = run(db, kind, { buildings: ['B'] });
    assert.equal(r.rows.length, 0, kind);
    assert.ok(r.notes.some((n) => n.includes('Складские движения')), kind + ': нет примечания про склад');
  }
});
