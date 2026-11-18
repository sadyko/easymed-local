// VISIT_TIER_ATTENDED_V1 (доводка) — ЦЕНА ВИЗИТА, КОТОРУЮ РЕШИТ СЧЁТ, ВИДНА ДО
// СЧЁТА ВЕЗДЕ.
//
// С 3.25.0 касса решает ярус невыставленной строки («второй» / «повторный»
// визит) заново в миг счёта (service-price-quote.js billingTiers): прошлый
// визит — только тот, на который пациент пришёл и который выставлен. Записанный
// при записи ярус мог устареть. Здесь — места, которые до счёта ещё брали
// ЗАПИСАННЫЙ ярус и расходились со счётом:
//   1. доля врача за выполненную, ещё не выставленную строку (reports.js,
//      PAY_BASIS_PERFORMED_V1) — прыгала в миг счёта;
//   2. окно «Выставить счёт» показывало записанную цену строки, а счёт брал
//      другую — сервер теперь называет цену счёта каждой невыставленной строки
//      визита (cashier_line_tiers по visit_id, поле unbilled);
//   3. смета мастера на будущий день = счёт: будущий день, выставленный заранее
//      после сегодняшнего выставленного визита той же услуги, — второй визит, и
//      смета на тот день (service_price_quote с date) называет то же.
// Выставленные строки не меняются: доля и цена — по позиции счёта, как прежде.
//
// Даты — только сдвигами от сегодняшнего местного дня (полдень по SQLite
// 'localtime'); правило сравнивает только местные дни — время запуска не важно.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { createInvoiceForVisit } from './billing.js';
import { cashierLineTiers, voidInvoice } from './cashier.js';
import { doctorPaySummary, runReport } from './reports.js';
import { quoteServicePrices } from './service-price-quote.js';
import { markBilled } from '../../test-helpers/billed-line.js';

const admin = { id: 9, role: 'admin', full_name: 'Администратор' };
const cashier = { id: 8, role: 'cashier', full_name: 'Кассир' };
const PRICE = 100000, SECOND = 60000, REPEAT = 30000;
const SVC = 1;   // приём: второй визит 60 000 на 1–6 день, повторный 30 000 на 1–10 день
const LAB = 2;   // анализ без цен визитов

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  const u = db.prepare(`INSERT INTO users (id, username, password_hash, role, full_name, is_doctor, service_rates, service_rate_default)
                        VALUES (?,?,?,?,?,?,?,0)`);
  u.run(1, 'doc', 'x', 'doctor', 'Доктор Д.', 1, JSON.stringify([{ service_id: SVC, pct: 30 }, { service_id: LAB, pct: 10 }]));
  u.run(2, 'doc2', 'x', 'doctor', 'Другой врач', 1, JSON.stringify([{ service_id: SVC, pct: 20 }]));
  u.run(8, 'kassa', 'x', 'cashier', 'Кассир', 0, '');
  u.run(9, 'adm', 'x', 'admin', 'Администратор', 0, '');
  db.prepare(`INSERT INTO services (id, name, price, tax_rate, price_secondary, secondary_days_from, secondary_days_to, price_repeat, repeat_days_from, repeat_days_to)
              VALUES (?, 'Приём', ?, 0, ?, 1, 6, ?, 1, 10)`).run(SVC, PRICE, SECOND, REPEAT);
  db.prepare("INSERT INTO services (id, name, price, tax_rate) VALUES (?, 'Анализ', 40000, 0)").run(LAB);
  for (const id of [1, 2, 3]) db.prepare('INSERT INTO patients (id, mrn, full_name) VALUES (?,?,?)').run(id, 'P-' + id, 'Пациент ' + id);
  return db;
}

// Местный полдень дня «сегодня + offset» (день визита сервер считает тем же 'localtime').
const dayAt = (db, offset) => db.prepare(
  "SELECT strftime('%Y-%m-%dT%H:%M:%SZ', date('now', 'localtime', ?) || ' 12:00:00', 'utc') AS t",
).get(`${offset >= 0 ? '+' : ''}${offset} days`).t;
const localDay = (db, offset) => db.prepare("SELECT date('now', 'localtime', ?) AS d").get(`${offset >= 0 ? '+' : ''}${offset} days`).d;

function visit(db, patient, offset, status = 'arrived') {
  return Number(db.prepare('INSERT INTO visits (patient_id, doctor_id, visit_date, status) VALUES (?, 1, ?, ?)')
    .run(patient, dayAt(db, offset), status).lastInsertRowid);
}
function line(db, vid, { service = SVC, doctor = 1, tier = null, status = 'completed', unit = PRICE, qty = 1 } = {}) {
  return Number(db.prepare(`INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, price_tier)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(vid, service, doctor, qty, unit, unit * qty, status, tier).lastInsertRowid);
}
// Прошлый приём у ДРУГОГО врача (в долю «Доктора Д.» не идёт): пришёл, выполнен,
// выставлен (счёт оплачен; 'unpaid' — выставлен, денег ещё нет: такой счёт отменяют).
function history(db, patient, offset, { tier = 'primary', status = 'paid' } = {}) {
  const v = visit(db, patient, offset);
  return { vid: v, invoiceId: markBilled(db, line(db, v, { doctor: 2, tier }), { status }) };
}

const period = (db) => ({ from: localDay(db, -20), to: localDay(db, 0) });
const summary = (db) => doctorPaySummary(db, { doctor_id: 1, ...period(db) }, admin);
const lineOf = (s, vsId) => s.lines.find((l) => l.kind === 'out' && l.id === vsId);
const salariesFee = (db) => {
  const r = runReport(db, { kind: 'doctor_salaries', ...period(db) }, admin);
  const row = r.rows.find((x) => x[r.columns.indexOf('Врач')] === 'Доктор Д.');
  return row ? row[r.columns.indexOf('Доля врача (гонорар)')] : 0;
};
const itemUnit = (db, vsId) => db.prepare(`SELECT ii.unit_price FROM invoice_items ii JOIN visit_services vs ON vs.invoice_item_id = ii.id
                                           WHERE vs.id = ?`).get(vsId).unit_price;

// ─── 1. Доля врача за выполненную, ещё не выставленную строку ──────────────

test('доля врача до счёта: записан «второй визит», а прошлого выставленного визита нет — цена счёта (обычная), и счёт долю не двигает', () => {
  const db = seed();
  const v = visit(db, 1, 0);
  const vs = line(db, v, { tier: 'secondary', unit: SECOND });
  const before = summary(db);
  assert.equal(lineOf(before, vs).amount, PRICE, 'до счёта строка платит по цене, которую поставит счёт');
  assert.equal(lineOf(before, vs).fee, PRICE * 0.3);
  createInvoiceForVisit(db, { visit_id: v, visit_service_ids: [vs] }, admin);
  assert.equal(itemUnit(db, vs), PRICE, 'счёт решил ярус заново — обычная цена');
  const after = summary(db);
  assert.equal(lineOf(after, vs).invoiced, true);
  assert.equal(lineOf(after, vs).fee, lineOf(before, vs).fee, 'доля в миг счёта не сдвинулась');
  assert.equal(after.outpatient.fee, before.outpatient.fee);
});

test('доля врача до счёта: записан «первичный», а прошлый визит был и выставлен — цена второго визита, как поставит счёт', () => {
  const db = seed();
  history(db, 1, -3);
  const v = visit(db, 1, 0);
  const vs = line(db, v, { tier: 'primary', unit: PRICE });
  const before = summary(db);
  assert.equal(lineOf(before, vs).amount, SECOND);
  assert.equal(salariesFee(db), SECOND * 0.3, '«Зарплаты врачей» — то же правило');
  createInvoiceForVisit(db, { visit_id: v, visit_service_ids: [vs] }, admin);
  assert.equal(itemUnit(db, vs), SECOND);
  assert.equal(lineOf(summary(db), vs).fee, lineOf(before, vs).fee);
});

test('доля врача: в одном отчёте у каждого визита своё решение (пациент с прошлым визитом и без); строка без цен визитов — как прежде', () => {
  const db = seed();
  history(db, 1, -2);
  const v1 = visit(db, 1, 0);
  const a = line(db, v1, { tier: 'secondary', unit: SECOND });
  const lab = line(db, v1, { service: LAB, unit: 40000 });
  const v2 = visit(db, 2, -1);
  const b = line(db, v2, { tier: 'secondary', unit: SECOND });
  const s = summary(db);
  assert.deepEqual([lineOf(s, a).amount, lineOf(s, b).amount, lineOf(s, lab).amount], [SECOND, PRICE, 40000]);
  assert.equal(salariesFee(db), s.outpatient.fee, 'кабинет и «Зарплаты врачей» сходятся');
  createInvoiceForVisit(db, { visit_id: v1, visit_service_ids: [a, lab] }, admin);
  createInvoiceForVisit(db, { visit_id: v2, visit_service_ids: [b] }, admin);
  assert.equal(summary(db).outpatient.fee, s.outpatient.fee, 'счета долю не сдвинули');
});

test('выставленная строка — по позиции счёта, как прежде: отмена счёта прошлого визита её долю не меняет', () => {
  const db = seed();
  const h = history(db, 1, -3, { status: 'unpaid' });
  const v = visit(db, 1, 0);
  const vs = line(db, v, { tier: 'secondary', unit: SECOND });
  createInvoiceForVisit(db, { visit_id: v, visit_service_ids: [vs] }, admin);
  assert.equal(itemUnit(db, vs), SECOND, 'прошлый визит выставлен — второй визит');
  const before = lineOf(summary(db), vs);
  assert.equal(before.amount, SECOND);
  voidInvoice(db, { invoice_id: h.invoiceId, keep_services: true }, admin);
  const after = lineOf(summary(db), vs);
  assert.deepEqual([after.invoiced, after.amount, after.fee], [true, SECOND, before.fee]);
});

// ─── 2. «Выставить счёт»: цена счёта у каждой невыставленной строки ───────

test('cashier_line_tiers по визиту называет цену счёта каждой невыставленной строки — ровно ту, что выставит счёт', () => {
  const db = seed();
  history(db, 1, -2);
  db.prepare("UPDATE services SET price = 45000 WHERE id = ?").run(LAB);   // каталог правили после записи строки
  const v = visit(db, 1, 0);
  const second = line(db, v, { tier: 'primary', unit: PRICE, status: 'added' });   // записано «первым», счёт решит «второй»
  const lab = line(db, v, { service: LAB, unit: 40000, qty: 2, status: 'added' });
  const v2 = visit(db, 2, 0);
  const stale = line(db, v2, { tier: 'secondary', unit: SECOND, status: 'added' });   // «второй» без прошлого визита

  const out = cashierLineTiers(db, { visit_id: v }, cashier);
  assert.deepEqual(out.unbilled, [
    { visit_service_id: second, tier: 'secondary', price: SECOND, quantity: 1, total: SECOND },
    { visit_service_id: lab, tier: null, price: 45000, quantity: 2, total: 90000 },
  ]);
  const out2 = cashierLineTiers(db, { visit_id: v2 }, cashier);
  assert.deepEqual(out2.unbilled, [{ visit_service_id: stale, tier: 'primary', price: PRICE, quantity: 1, total: PRICE }]);
  assert.deepEqual(out2.lines, [], 'чипа «Второй визит» нет — счёт выставит обычную цену');

  createInvoiceForVisit(db, { visit_id: v, visit_service_ids: [second, lab] }, cashier);
  createInvoiceForVisit(db, { visit_id: v2, visit_service_ids: [stale] }, cashier);
  assert.deepEqual([itemUnit(db, second), itemUnit(db, lab), itemUnit(db, stale)], [SECOND, 45000, PRICE], 'счёт — те же цены');
  assert.deepEqual(cashierLineTiers(db, { visit_id: v }, cashier).unbilled, [], 'выставленные строки в unbilled не попадают');
});

// ─── 3. Будущий день, выставленный заранее: смета = счёт ───────────────────

test('будущий день той же услуги, выставленный сегодня после сегодняшнего выставленного визита, — второй визит; смета на тот день называет то же', () => {
  const db = seed();
  const today = visit(db, 3, 0);
  const t = line(db, today, { status: 'added' });
  createInvoiceForVisit(db, { visit_id: today, visit_service_ids: [t] }, cashier);
  assert.equal(itemUnit(db, t), PRICE, 'сегодня — первый визит');
  const q = quoteServicePrices(db, { patient_id: 3, service_ids: [SVC], date: localDay(db, 3) }).quotes[SVC];
  assert.deepEqual([q.tier, q.price, q.days_since], ['secondary', SECOND, 3], 'смета на день через три дня');
  const future = visit(db, 3, 3, 'scheduled');
  const f = line(db, future, { status: 'added', tier: q.tier, unit: q.price });
  createInvoiceForVisit(db, { visit_id: future, visit_service_ids: [f] }, cashier);
  assert.equal(itemUnit(db, f), q.price, 'счёт будущего дня = смета');
});
