// SERVICES_PACKAGES_V1 — ДЕНЬГИ ПАКЕТА ОТ ЗАПИСИ ДО ВОЗВРАТА: показанное = счёт
// = база доли врача.
//
// Пакет макета «Check-up базовый»: ОАК 45 000, глюкоза 25 000, ОАМ 35 000,
// ЭКГ 60 000, УЗИ 180 000 = 345 000; скидка 15 % → цена пакета 293 000;
// раскладка 38 200 / 21 200 / 29 700 / 51 000 / 152 900 (shared/package-price.js).
// Строки заводятся так же, как их заводит дверь /api/db (test-helpers/package-line.js
// → domain/package-lines.js) — это единственная дверь строки с пакетом: окно
// записи, мастер визита, быстрая регистрация, окно визита и кабинет врача шлют
// туда package_id, сервер ставит цену сам.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { createInvoiceForVisit, recordPayment, refundInvoiceLine } from './billing.js';
import { doctorPaySummary } from './reports.js';
import { cashierUnbilled } from './cashier.js';
import { today } from '../domain/day.js';
import { insertVisitLine } from '../../test-helpers/package-line.js';
import { buildBatch } from '../branch-sync/journal.js';
import { packageCalc, packageTerms, packageItems } from '../../../public/js/shared/package-price.js';

const admin = { id: 9, role: 'admin' };
const registrar = { id: 7, role: 'registrar' };
const cashier = { id: 8, role: 'cashier' };
const PRICE = { 1: 45000, 2: 25000, 6: 35000, 8: 60000, 7: 180000, 20: 50000 };
const PKG_IDS = [1, 2, 6, 8, 7];
const IN_PKG = { 1: 38200, 2: 21200, 6: 29700, 8: 51000, 7: 152900 };

function clinic({ categoryPct = 0 } = {}) {
  const db = openDb(':memory:');
  migrate(db);
  const day = today(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, role, full_name, is_doctor, service_rates, service_rate_default) VALUES (?,?,?,?,?,?,?,0)');
  u.run(1, 'doc', 'x', 'doctor', 'Доктор Д.', 1, JSON.stringify(Object.keys(PRICE).map((id) => ({ service_id: Number(id), pct: 30 }))));
  u.run(7, 'reg', 'x', 'registrar', 'Регистратор', 0, '');
  u.run(8, 'kas', 'x', 'cashier', 'Кассир', 0, '');
  u.run(9, 'adm', 'x', 'admin', 'Администратор', 0, '');
  let cat = null;
  if (categoryPct) cat = db.prepare("INSERT INTO patient_categories (name, discount_percent, active) VALUES ('VIP', ?, 1)").run(categoryPct).lastInsertRowid;
  db.prepare("INSERT INTO patients (id, mrn, full_name, category_id) VALUES (1, 'P-1', 'Пациент', ?)").run(cat);
  const s = db.prepare("INSERT INTO services (id, name, price, tax_rate, type, code) VALUES (?, ?, ?, 0, 'lab', ?)");
  for (const [id, price] of Object.entries(PRICE)) s.run(Number(id), 'Услуга ' + id, price, 'S-' + id);
  const pkg = db.prepare(`INSERT INTO service_templates (name, service_ids, is_package, discount_mode, discount_value, discount_percent)
                          VALUES ('Check-up базовый', ?, 1, 'percent', 15, 15)`).run(JSON.stringify(PKG_IDS)).lastInsertRowid;
  const tpl = db.prepare("INSERT INTO service_templates (name, service_ids, is_package) VALUES ('Смета', ?, 0)").run(JSON.stringify(PKG_IDS)).lastInsertRowid;
  const visitId = db.prepare("INSERT INTO visits (patient_id, visit_date, status) VALUES (1, ?, 'arrived')").run(day + 'T09:00:00Z').lastInsertRowid;
  const line = (serviceId, packageId = null, status = 'completed') => insertVisitLine(db, { visit_id: visitId, service_id: serviceId, doctor_id: 1,
    quantity: 1, unit_price: PRICE[serviceId], total: PRICE[serviceId], status, package_id: packageId });
  const range = { from: day.slice(0, 7) + '-01', to: day };
  const fee = () => doctorPaySummary(db, { doctor_id: 1, ...range }, admin).outpatient.fee;
  return { db, pkg, tpl, visitId, line, fee, day };
}
const items = (db, invoiceId) => db.prepare('SELECT service_id, unit_price, total, discount_amount FROM invoice_items WHERE invoice_id = ? ORDER BY id').all(invoiceId);

test('окно пакета = запись строки = счёт: цены в пакете, ровно 293 000, своя скидка каждой строки', () => {
  const c = clinic();
  const services = c.db.prepare('SELECT id, price, active FROM services').all();
  const tplRow = c.db.prepare('SELECT * FROM service_templates WHERE id = ?').get(c.pkg);
  const quote = packageCalc(packageTerms(tplRow), packageItems(tplRow, services).items);   // то, что показывают окно пакета и смета
  const ids = PKG_IDS.map((sid) => c.line(sid, c.pkg));
  const stamped = c.db.prepare(`SELECT service_id, package_price FROM visit_services WHERE id IN (${ids.join(',')}) ORDER BY id`).all();
  assert.deepEqual(stamped.map((r) => r.package_price), quote.lines.map((l) => l.price));
  assert.deepEqual(stamped.map((r) => r.package_price), PKG_IDS.map((sid) => IN_PKG[sid]));
  const res = createInvoiceForVisit(c.db, { visit_id: c.visitId, visit_service_ids: ids }, registrar);
  assert.deepEqual([res.invoice.subtotal, res.invoice.discount_amount, res.invoice.total_amount], [345000, 52000, 293000]);
  assert.deepEqual(items(c.db, res.invoice.id).map((i) => i.total - i.discount_amount), PKG_IDS.map((sid) => IN_PKG[sid]));
});

test('решение 1: скидка группы и ручная скидка на пакет не ложатся; на остальные — как прежде', () => {
  const c = clinic({ categoryPct: 30 });
  const ids = [...PKG_IDS.map((sid) => c.line(sid, c.pkg)), c.line(20)];
  const res = createInvoiceForVisit(c.db, { visit_id: c.visitId, visit_service_ids: ids, discount_amount: 10000 }, registrar);
  // Пакет — 293 000; строка вне пакета 50 000 — пол группы 30 % (15 000) больше ручной 10 000.
  assert.equal(res.invoice.total_amount, 293000 + 35000);
  assert.equal(res.rest_discount, 15000);
});

test('доля врача по строкам пакета — от цены в пакете; до счёта = после счёта = после оплаты', () => {
  const c = clinic({ categoryPct: 30 });
  const ids = PKG_IDS.map((sid) => c.line(sid, c.pkg));
  const want = Math.round(293000 * 0.3);
  assert.equal(Math.round(c.fee()), want, 'до счёта');
  const res = createInvoiceForVisit(c.db, { visit_id: c.visitId, visit_service_ids: ids }, registrar);
  assert.equal(Math.round(c.fee()), want, 'после счёта');
  recordPayment(c.db, { invoice_id: res.invoice.id, amount: 293000, method: 'cash' }, cashier);
  assert.equal(Math.round(c.fee()), want, 'после оплаты');
});

test('«Ждут счёта» показывает цену пакета — ту, что выставит счёт', () => {
  const c = clinic();
  PKG_IDS.forEach((sid) => c.line(sid, c.pkg, 'added'));
  c.line(20, null, 'added');
  const row = cashierUnbilled(c.db, {}, cashier).rows.find((r) => r.visit_id === c.visitId);
  assert.equal(row.total, 293000 + 50000);
});

test('решение 2: возврат одной услуги — её цена в пакете; остальные — по цене пакета; доля врача по остальным та же', () => {
  const c = clinic();
  const ids = PKG_IDS.map((sid) => c.line(sid, c.pkg));
  const res = createInvoiceForVisit(c.db, { visit_id: c.visitId, visit_service_ids: ids }, registrar);
  recordPayment(c.db, { invoice_id: res.invoice.id, amount: 293000, method: 'cash' }, cashier);
  const uzi = c.db.prepare('SELECT invoice_item_id i FROM visit_services WHERE id = ?').get(ids[4]).i;
  const out = refundInvoiceLine(c.db, { invoice_item_id: uzi, reason: 'отказ от УЗИ' }, cashier);
  assert.equal(out.refunded, 152900, 'вернули цену УЗИ в пакете');
  assert.equal(out.invoice.total_amount, 293000 - 152900);
  assert.deepEqual(items(c.db, res.invoice.id).map((i) => i.total - i.discount_amount), [38200, 21200, 29700, 51000]);
  assert.equal(Math.round(c.fee()), Math.round((293000 - 152900) * 0.3));
});

test('цена записана при записи: прайс подешевел и пакет поменяли — счёт тот же; выставили возвращённое заново — та же цена в пакете', () => {
  const c = clinic();
  const ids = PKG_IDS.map((sid) => c.line(sid, c.pkg));
  c.db.prepare('UPDATE services SET price = price / 2').run();
  c.db.prepare("UPDATE service_templates SET discount_value = 40, discount_percent = 40 WHERE id = ?").run(c.pkg);
  const res = createInvoiceForVisit(c.db, { visit_id: c.visitId, visit_service_ids: ids }, registrar);
  assert.equal(res.invoice.total_amount, 293000);
  recordPayment(c.db, { invoice_id: res.invoice.id, amount: 293000, method: 'cash' }, cashier);
  const uzi = c.db.prepare('SELECT invoice_item_id i FROM visit_services WHERE id = ?').get(ids[4]).i;
  refundInvoiceLine(c.db, { invoice_item_id: uzi }, cashier);
  const again = createInvoiceForVisit(c.db, { visit_id: c.visitId, visit_service_ids: [ids[4]], rebill_refunded: true }, registrar);
  assert.equal(again.invoice.total_amount, 152900);
});

test('«Повторный визит» и своя цена врача: строка пакета — по цене в пакете (счёт и доля врача до и после счёта); обычная строка — по ярусу, как прежде', () => {
  const c = clinic();
  // УЗИ (180 000) на втором визите стоит 120 000; у врача своя цена ОАК — 60 000.
  c.db.prepare('UPDATE services SET price_secondary = 120000, secondary_days_from = 0, secondary_days_to = 30 WHERE id = 7').run();
  c.db.prepare('UPDATE users SET service_rates = ? WHERE id = 1').run(JSON.stringify(Object.keys(PRICE).map((id) => (
    Number(id) === 1 ? { service_id: 1, pct: 30, price: 60000 } : { service_id: Number(id), pct: 30 }))));
  const ids = PKG_IDS.map((sid) => c.line(sid, c.pkg));
  const plain = c.line(7);
  c.db.prepare(`UPDATE visit_services SET price_tier = 'secondary' WHERE visit_id = ?`).run(c.visitId);
  assert.equal(Math.round(c.fee()), Math.round((293000 + 120000) * 0.3), 'до счёта');
  const res = createInvoiceForVisit(c.db, { visit_id: c.visitId, visit_service_ids: [...ids, plain] }, registrar);
  assert.equal(res.invoice.total_amount, 293000 + 120000, 'пакет — 293 000 при любом ярусе и своей цене; УЗИ вне пакета — цена второго визита');
  assert.deepEqual(items(c.db, res.invoice.id).slice(0, 5).map((i) => i.total - i.discount_amount), PKG_IDS.map((sid) => IN_PKG[sid]));
  assert.equal(Math.round(c.fee()), Math.round((293000 + 120000) * 0.3), 'после счёта');
});

test('шаблон сметы — обычные строки: скидка группы ложится, «пакета» нет', () => {
  const c = clinic({ categoryPct: 10 });
  const ids = PKG_IDS.map((sid) => c.line(sid, c.tpl));
  assert.equal(c.db.prepare(`SELECT COUNT(*) n FROM visit_services WHERE package_full IS NOT NULL`).get().n, 0);
  const res = createInvoiceForVisit(c.db, { visit_id: c.visitId, visit_service_ids: ids }, registrar);
  assert.equal(res.invoice.total_amount, 345000 * 0.9);
});

test('счёт плательщику: скидка пакета остаётся, скидки группы нет', () => {
  const c = clinic({ categoryPct: 30 });
  const payer = c.db.prepare("INSERT INTO payers (name, kind, active) VALUES ('Страховая', 'insurance', 1)").run().lastInsertRowid;
  const ids = [...PKG_IDS.map((sid) => c.line(sid, c.pkg)), c.line(20)];
  const res = createInvoiceForVisit(c.db, { visit_id: c.visitId, visit_service_ids: ids, payer_id: payer }, admin);
  assert.equal(res.invoice.total_amount, 293000 + 50000);
});

test('соседнему зданию уезжает документ: скидка каждой позиции счёта; цена пакета строки визита остаётся дома', () => {
  const c = clinic();
  c.db.prepare('DELETE FROM sync_journal').run();
  c.db.prepare("INSERT OR IGNORE INTO sync_peers (node, sent_seq, last_ok) VALUES ('C', 0, ?)").run(new Date().toISOString());
  const ids = PKG_IDS.map((sid) => c.line(sid, c.pkg));
  createInvoiceForVisit(c.db, { visit_id: c.visitId, visit_service_ids: ids }, registrar);
  const recs = buildBatch(c.db, { self: 'B', peer: 'C' }).records;
  const itemsOut = recs.filter((r) => r.tbl === 'invoice_items').map((r) => r.data.total - r.data.discount_amount).sort((a, b) => a - b);
  assert.deepEqual(itemsOut, Object.values(IN_PKG).sort((a, b) => a - b));
  for (const r of recs.filter((x) => x.tbl === 'visit_services')) {
    assert.equal('package_full' in r.data || 'package_price' in r.data, false, 'деньги строки визита не ездят (journal.js)');
  }
});

// SERVICES_PACKAGES_V1 (ревью шага 6, C1) — строка, записанная до мигр. 244
// (package_legacy): её цена названа пациенту со скидкой его группы. «Ждут
// счёта» скидку группы не показывает ни у одной строки (её считает счёт) — у
// такой строки там только скидка пакета: столько выставит счёт плательщику,
// пациенту счёт даст ещё и группу.
test('«Ждут счёта»: строка до 244 — по скидке пакета, столько же выставит счёт плательщику', () => {
  const c = clinic({ categoryPct: 30 });
  const id = c.line(7, c.pkg, 'added');   // УЗИ 180 000, пакет 15 %
  c.db.prepare('UPDATE visit_services SET package_price = 126000, package_legacy = 15 WHERE id = ?').run(id);   // как бэкфилл 244: 30 % группы, пакет был 15 %
  c.db.prepare('UPDATE service_templates SET discount_percent = 15.1 WHERE id = ?').run(c.pkg);   // пересохранили окном: процент раскладки — заморожённый не двигается
  const row = cashierUnbilled(c.db, {}, cashier).rows.find((r) => r.visit_id === c.visitId);
  assert.equal(row.total, 153000, '180 000 − 15 % пакета; группу посчитает счёт');
  const payer = c.db.prepare("INSERT INTO payers (name, kind, active) VALUES ('Страховая', 'insurance', 1)").run().lastInsertRowid;
  const res = createInvoiceForVisit(c.db, { visit_id: c.visitId, visit_service_ids: [id], payer_id: payer }, admin);
  assert.equal(res.invoice.total_amount, row.total, 'счёт плательщику = «Ждут счёта»');
});

// SERVICES_PACKAGES_V1 (ревью шага 6, C3) — состав пакета поменяли после записи
// (УЗИ убрали из «Check-up»): строки, уже записанные с ценой пакета, держат её
// (Р4) — счёт выставляется, и он равен «Ждут счёта» и базе доли врача. Строку
// без записанной цены, чья услуга не в пакете, счёт по-прежнему не выставляет.
test('ревью C3: услугу убрали из пакета после записи — счёт по записанной цене = «Ждут счёта» = доля врача', () => {
  const c = clinic();
  const ids = PKG_IDS.map((sid) => c.line(sid, c.pkg, 'completed'));
  c.db.prepare("UPDATE service_templates SET service_ids = '[1,2,6,8]' WHERE id = ?").run(c.pkg);
  const waiting = cashierUnbilled(c.db, {}, cashier).rows.find((r) => r.visit_id === c.visitId).total;
  const feeBefore = Math.round(c.fee());
  const res = createInvoiceForVisit(c.db, { visit_id: c.visitId, visit_service_ids: ids }, registrar);
  assert.deepEqual([res.invoice.total_amount, waiting], [293000, 293000]);
  assert.deepEqual([feeBefore, Math.round(c.fee())], [Math.round(293000 * 0.3), Math.round(293000 * 0.3)]);
  // Строка до 244 (бэкфилл без проверки состава) — тоже по записанной цене.
  const c2 = clinic();
  const old = c2.line(7, c2.pkg, 'completed');
  c2.db.prepare("UPDATE visit_services SET package_legacy = 15 WHERE id = ?").run(old);
  c2.db.prepare("UPDATE service_templates SET service_ids = '[1]' WHERE id = ?").run(c2.pkg);
  assert.equal(createInvoiceForVisit(c2.db, { visit_id: c2.visitId, visit_service_ids: [old] }, registrar).invoice.total_amount, 152900);
  // Без записанной цены (строку завели в обход двери) — состав проверяется, как прежде.
  const c3 = clinic();
  const raw = Number(c3.db.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, package_id) VALUES (?, 20, 1, 1, 50000, 50000, 'completed', ?)").run(c3.visitId, c3.pkg).lastInsertRowid);
  assert.throws(() => createInvoiceForVisit(c3.db, { visit_id: c3.visitId, visit_service_ids: [raw] }, registrar), /не входит в пакет/);
});

// SERVICES_PACKAGES_V1 (ревью шага 6, C6) — день визита вне срока пакета (визит
// перенесли или срок пакета сузили после записи): счёт такую строку не
// выставляет, доля врача считается от цены без скидки пакета — «Ждут счёта»
// показывает то же, а не цену в пакете.
test('ревью C6: день визита за сроком пакета — «Ждут счёта» по цене без скидки, как база доли врача', () => {
  const c = clinic();
  const id = c.line(7, c.pkg, 'completed');   // УЗИ: 180 000 → в пакете 152 900
  const waiting = () => cashierUnbilled(c.db, {}, cashier).rows.find((r) => r.visit_id === c.visitId).total;
  assert.equal(waiting(), 152900, 'в сроке — цена в пакете');
  c.db.prepare("UPDATE service_templates SET valid_until = date(?, '-1 day') WHERE id = ?").run(c.day, c.pkg);
  assert.equal(waiting(), 180000, 'срок кончился вчера — цена без скидки пакета');
  assert.equal(Math.round(c.fee()), Math.round(180000 * 0.3), 'доля врача — от той же суммы');
  assert.throws(() => createInvoiceForVisit(c.db, { visit_id: c.visitId, visit_service_ids: [id] }, registrar), /действует/);
  // Строка до 244 — так же.
  c.db.prepare('UPDATE visit_services SET package_legacy = 15 WHERE id = ?').run(id);
  assert.equal(waiting(), 180000);
});
