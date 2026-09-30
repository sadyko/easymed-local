// OWN_PRICE_TIER_RATIO_V1 (2026-09-30) — СВОЯ ЦЕНА ВРАЧА СО СКИДКОЙ ЯРУСА.
//
// Владелец (2026-09-30), заменяет правило 3.14.0 (OWN_PRICE_REPEAT_V1: своя цена
// на любом ярусе как есть): своя цена получает ТУ ЖЕ скидку, что и каталог на
// втором и повторном визите. Каталог 200 000 первый, 60 000 второй, повторный
// бесплатно; врач со своей ценой 300 000 → 300 000, 90 000 (30 % своей), 0.
// Исходное требование ярусов (2026-09-14, шапка visit-tier.js) — «второй визит
// 60 000 … повторный, например, бесплатно»: повторные визиты дешевле и у врача со
// своей ценой.
//
// Правило (public/js/shared/own-price-rule.js serviceLinePrice):
//   • своей цены нет — цена яруса, как прежде (tierUnitPrice, с откатами ярусов);
//   • своя цена и первичный ярус (или у услуги нет ярусов, или стационар без
//     ярусов) — своя цена;
//   • своя цена и второй / повторный — своя × (цена яруса ÷ каталог первичного),
//     цена яруса — та, что вернул priceForTier после откатов; бесплатный ярус —
//     0; ярус дороже первичного — дороже в той же доле; каталог первичного ≤ 0 —
//     долю не посчитать, своя цена; округление — до 0,01, как у строк и счетов.
// Ярус строки (price_tier) пишется как прежде; выставленные счета не
// пересчитываются.
//
// Здесь — серверные двери, через настоящие RPC и SQLite после миграций:
// котировка, выставление счёта, «Ждут счёта» кассы, «Добавить» кассы, замена
// услуги и врача в неоплаченном счёте, исполнители строки, замена в
// оплаченном счёте, счёт врача по своим строкам (REFBILL), строка
// колл-центра, доля врача от суммы строки, строка стационара. Экранные двери
// (мастер визита, Калькулятор, окно визита, «Добавить» окна счёта и кабинета
// врача) — в public/js/admin/__tests__.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { RPC } from './index.js';
import { createInvoiceForVisit, recordPayment } from './billing.js';
import { openCashShift, cashierUnbilled } from './cashier.js';
import { doctorPaySummary } from './reports.js';
import { priceFor } from '../crm/booking-mirror.js';
import { doctorPriceFor, doctorPriceLookup, lineUnitPrice } from '../domain/pricing.js';
import { tierUnitPrice } from '../domain/visit-tier.js';
import { serviceLinePrice, ownPriceValue, ownPriceFromRates } from '../../../public/js/shared/own-price-rule.js';

const admin = { id: 1, role: 'admin', full_name: 'Админ' };
const registrar = { id: 7, role: 'registrar', full_name: 'Регистратура' };
const cashier = { id: 9, role: 'cashier', full_name: 'Кассир' };
const OWN = 20;      // своя цена 300 000 на приём, 10 %
const PLAIN = 21;    // своей цены нет, 10 %
const doctorOwn = { id: OWN, role: 'doctor', full_name: 'Врач со своей ценой' };

// Пример владельца: приём 200 000, второй за 1–6 дней — 60 000, повторный — бесплатно.
function seed({ ownPrice = 300000 } = {}) {
  const db = openDb(':memory:'); migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, role, full_name, is_doctor, extra_roles, is_active) VALUES (?,?,?,?,?,?,?,1)');
  u.run(1, 'adm', 'x', 'admin', 'Админ', 0, '[]');
  u.run(7, 'reg', 'x', 'registrar', 'Регистратура', 0, '[]');
  u.run(9, 'cash', 'x', 'cashier', 'Кассир', 0, '[]');
  u.run(OWN, 'own', 'x', 'doctor', 'Врач со своей ценой', 1, '[]');
  u.run(PLAIN, 'plain', 'x', 'doctor', 'Врач без своей цены', 1, '[]');
  const CONS = Number(db.prepare(`INSERT INTO services (name, price, tax_rate, type, price_secondary, secondary_days_from, secondary_days_to, price_repeat)
                                  VALUES ('Приём терапевта', 200000, 0, 'consultation', 60000, 1, 6, 0)`).run().lastInsertRowid);
  const USG = Number(db.prepare("INSERT INTO services (name, price, tax_rate, type) VALUES ('УЗИ', 80000, 0, 'imaging')").run().lastInsertRowid);
  setOwn(db, CONS, USG, ownPrice);
  db.prepare('UPDATE users SET service_rates = ? WHERE id = ?').run(JSON.stringify([
    { service_id: CONS, pct: 10, branches: [] }, { service_id: USG, pct: 10, branches: [] }]), PLAIN);
  const grant = db.prepare('SELECT permissions FROM role_permissions WHERE role = ?').get('cashier');
  const perms = grant && grant.permissions ? JSON.parse(grant.permissions) : { sections: [], levels: {} };
  perms.grants = { ...(perms.grants || {}), 'cashier.lines': 'edit' };
  if (grant) db.prepare('UPDATE role_permissions SET permissions = ? WHERE role = ?').run(JSON.stringify(perms), 'cashier');
  else db.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?)').run('cashier', JSON.stringify(perms));
  const pid = Number(db.prepare("INSERT INTO patients (full_name) VALUES ('Пациент Повторный')").run().lastInsertRowid);
  return { db, CONS, USG, pid };
}
function setOwn(db, CONS, USG, ownPrice) {
  db.prepare('UPDATE users SET service_rates = ? WHERE id = ?').run(JSON.stringify([
    { service_id: CONS, pct: 10, price: ownPrice, branches: [] }, { service_id: USG, pct: 10, branches: [] }]), OWN);
}

// Местный полдень дня «сегодня + offset» — день визита сервер считает тем же
// 'localtime' (как в billing.refbill-review.test.js).
const dayAt = (db, offset) => db.prepare(
  "SELECT strftime('%Y-%m-%dT%H:%M:%SZ', date('now', 'localtime', ?) || ' 12:00:00', 'utc') AS t",
).get(`${offset >= 0 ? '+' : ''}${offset} days`).t;
const dayOf = (db, offset) => db.prepare("SELECT date('now', 'localtime', ?) AS d").get(`${offset >= 0 ? '+' : ''}${offset} days`).d;

function visit(db, pid, offset, { status = 'arrived', by = 7 } = {}) {
  return Number(db.prepare('INSERT INTO visits (patient_id, visit_date, status, created_by) VALUES (?, ?, ?, ?)')
    .run(pid, dayAt(db, offset), status, by).lastInsertRowid);
}
function line(db, vid, { service_id, doctor_id, tier = null, status = 'added', by = 7 }) {
  return Number(db.prepare(`INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, created_by, price_tier)
                            VALUES (?, ?, ?, 1, 0, 0, ?, ?, ?)`).run(vid, service_id, doctor_id, status, by, tier).lastInsertRowid);
}
const patient = (db) => Number(db.prepare("INSERT INTO patients (full_name) VALUES ('Пациент Второй')").run().lastInsertRowid);
// Прошлый приём этой услуги у пациента: первичный (или указанный ярус), выполнен.
function history(db, pid, serviceId, offset, tier = 'primary') {
  const v = visit(db, pid, offset);
  line(db, v, { service_id: serviceId, doctor_id: PLAIN, tier, status: 'completed' });
  return v;
}
const quote = (db, pid, serviceId, offset, doctorId) => RPC.service_price_quote(db, {
  patient_id: pid, service_ids: [serviceId], date: dayOf(db, offset), ...(doctorId ? { doctor_id: doctorId } : {}),
}, registrar).quotes[serviceId];
const vsRow = (db, id) => db.prepare('SELECT * FROM visit_services WHERE id = ?').get(id);
const inv = (db, id) => db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
const billOne = (db, pid, serviceId, doctorId, tier) => {
  const v = visit(db, pid, 0);
  const l = line(db, v, { service_id: serviceId, doctor_id: doctorId, tier });
  return createInvoiceForVisit(db, { visit_id: v, visit_service_ids: [l] }, registrar).invoice.total_amount;
};

// ─── правило ─────────────────────────────────────────────────────────────────
test('правило: своя цена × (ярус ÷ каталог первичного); своей нет — цена яруса; края доли и округление', () => {
  // Пример владельца.
  assert.equal(serviceLinePrice(300000, 200000, 200000), 300000, 'первичный — своя цена');
  assert.equal(serviceLinePrice(300000, 60000, 200000), 90000, 'второй — 30 % своей');
  assert.equal(serviceLinePrice(300000, 0, 200000), 0, 'повторный бесплатно — 0');
  // Своей цены нет — цена яруса как есть.
  assert.equal(serviceLinePrice(null, 60000, 200000), 60000);
  assert.equal(serviceLinePrice(undefined, 0, 200000), 0);
  // Ярус дороже первичного — дороже в той же доле, без зажима.
  assert.equal(serviceLinePrice(200000, 150000, 100000), 300000);
  // Каталог первичного ≤ 0 или его нет — долю не посчитать: своя цена.
  assert.equal(serviceLinePrice(70000, 50000, 0), 70000);
  assert.equal(serviceLinePrice(70000, 50000, null), 70000);
  assert.equal(serviceLinePrice(70000, 50000, -5), 70000);
  // Своя 0 — настоящая бесплатная цена на любом ярусе.
  assert.equal(serviceLinePrice(0, 60000, 200000), 0);
  // Округление — до 0,01, как у строк и счетов (billing.js round2).
  assert.equal(serviceLinePrice(175000, 60000, 200000), 52500);
  assert.equal(serviceLinePrice(123457, 60000, 200000), 37037.1);
  assert.equal(serviceLinePrice(100000, 1, 3), 33333.33);
  assert.equal(serviceLinePrice(100000, 2, 3), 66666.67);
});

test('правило: разбор своей цены — строки, как у сервера', () => {
  assert.equal(ownPriceValue('80000'), 80000);
  assert.equal(ownPriceValue(''), null);
  assert.equal(ownPriceValue('abc'), null);
  assert.equal(ownPriceValue(-5), null);
  assert.equal(ownPriceValue(null), null);
  // При дублях услуги — запись С ЦЕНОЙ (FINAL_MONEY_FIX_V1 M4, как у сервера).
  assert.equal(ownPriceFromRates([{ service_id: 5, pct: 30 }, { service_id: '5', price: 90000 }], 5), 90000);
  assert.equal(ownPriceFromRates([{ service_id: 5, price: '' }], 5), null);
  assert.equal(ownPriceFromRates(null, 5), null);
});

// Ревью 1 — экран разбирает сохранённую цену РОВНО как сервер: любая строка,
// которую сервер прочтёт как свою цену, экраном читается тем же числом, а
// отброшенная сервером — отброшена и экраном. Иначе смета мастера или
// Калькулятора назвала бы одну сумму, а счёт выставил бы другую.
test('правило: разбор своей цены на экране = разбор сервера (OWN_PRICE_ENTRY + CAST), в том числе кривые строки', () => {
  const db = openDb(':memory:'); migrate(db);
  const RAW = [80000, 80000.5, 0, -1, '80000', '80000.5', ' 80000 ', '80.000.5', '80.', '80..5', '1.2.3', '0',
    '', ' ', 'abc', '80 000', '80,5', '.5', '-5', '\t80', '80\t', '1e3', null, true, false, '٣٠'];
  const ins = db.prepare("INSERT INTO users (id, username, password_hash, role, service_rates) VALUES (?, ?, 'x', 'doctor', ?)");
  RAW.forEach((price, i) => ins.run(100 + i, 'd' + i, JSON.stringify([{ service_id: 7, pct: 10, price }])));
  const lookup = doctorPriceLookup(db, RAW.map((_, i) => 100 + i));
  const got = RAW.map((price, i) => ({ price, server: doctorPriceFor(db, 100 + i, 7), batch: lookup(100 + i, 7), screen: ownPriceFromRates([{ service_id: 7, pct: 10, price }], 7) }));
  for (const g of got) {
    assert.equal(g.screen, g.server, 'цена ' + JSON.stringify(g.price) + ': экран ' + g.screen + ', сервер ' + g.server);
    assert.equal(g.batch, g.server, 'цена ' + JSON.stringify(g.price) + ': выборка кассы ' + g.batch + ', сервер ' + g.server);
  }
  // Прямо — то, что нашло ревью: '80.000.5' сервер читает как 80.
  assert.equal(ownPriceValue('80.000.5'), 80);
  assert.equal(doctorPriceFor(db, 100 + RAW.indexOf('80.000.5'), 7), 80);
});

// Экран и сервер считают цену строки ОДНОЙ функцией. Экран (мастер визита,
// Калькулятор) берёт цену яруса из котировки без врача и свою цену врача из его
// ставок; сервер — lineUnitPrice по строке. Матрица: услуги с ярусами и без,
// с откатом ярусов, с бесплатным и с дорогим ярусом, с нулевым каталогом;
// своя цена — нет, круглая, некруглая, 0; ярусы — все три.
test('правило: цена строки на экране = цена строки на сервере (матрица услуг, своих цен и ярусов)', () => {
  const db = openDb(':memory:'); migrate(db);
  const SERVICES = [
    { id: 1, price: 200000, price_secondary: 60000, price_repeat: 0 },          // пример владельца
    { id: 2, price: 200000, price_secondary: 60000, price_repeat: null },       // повторный → откат на второй
    { id: 3, price: 200000, price_secondary: null, price_repeat: 30000 },       // второй → откат на повторный
    { id: 4, price: 100000, price_secondary: 150000, price_repeat: null },      // ярус дороже первичного
    { id: 5, price: 0, price_secondary: 50000, price_repeat: null },            // каталог первичного 0
    { id: 6, price: 200000, price_secondary: null, price_repeat: null },        // ярусов нет
    { id: 7, price: 300000, price_secondary: 100000, price_repeat: 70000 },     // доля 1/3 — нужна копейка
  ];
  const insS = db.prepare('INSERT INTO services (id, name, price, price_secondary, price_repeat) VALUES (?, ?, ?, ?, ?)');
  for (const s of SERVICES) insS.run(s.id, 'S' + s.id, s.price, s.price_secondary, s.price_repeat);
  const OWNS = [null, 300000, 123457, 175000, 0];
  const insU = db.prepare("INSERT INTO users (id, username, password_hash, role, service_rates) VALUES (?, ?, 'x', 'doctor', ?)");
  OWNS.forEach((own, i) => insU.run(50 + i, 'o' + i, JSON.stringify(SERVICES.map((s) => (own === null ? { service_id: s.id, pct: 10 } : { service_id: s.id, pct: 10, price: own })))));
  let n = 0;
  for (const s of SERVICES) {
    const svc = db.prepare('SELECT * FROM services WHERE id = ?').get(s.id);
    for (const [i, own] of OWNS.entries()) {
      const rates = JSON.parse(db.prepare('SELECT service_rates FROM users WHERE id = ?').get(50 + i).service_rates);
      for (const tier of ['primary', 'secondary', 'repeat']) {
        const server = lineUnitPrice(db, { service_id: s.id, doctor_id: 50 + i, price_tier: tier }, { service: svc });
        const screen = serviceLinePrice(ownPriceFromRates(rates, s.id), tierUnitPrice(svc, tier, Number(svc.price)), Number(svc.price));
        assert.equal(screen, server, `услуга ${s.id}, своя ${own}, ярус ${tier}: экран ${screen}, сервер ${server}`);
        n++;
      }
    }
  }
  assert.equal(n, 105);
  // Точки матрицы, названные владельцем и ревью.
  const at = (sid, doc, tier) => lineUnitPrice(db, { service_id: sid, doctor_id: doc, price_tier: tier }, { service: db.prepare('SELECT * FROM services WHERE id = ?').get(sid) });
  assert.deepEqual(['primary', 'secondary', 'repeat'].map((t) => at(1, 51, t)), [300000, 90000, 0]);
  assert.deepEqual(['primary', 'secondary', 'repeat'].map((t) => at(1, 50, t)), [200000, 60000, 0]);
  assert.equal(at(2, 51, 'repeat'), 90000, 'повторного нет — откат на второй, доля второго');
  assert.equal(at(3, 51, 'secondary'), 45000, 'второго нет — откат на повторный, доля повторного');
  assert.equal(at(4, 51, 'secondary'), 450000, 'ярус дороже первичного — дороже в той же доле');
  assert.equal(at(5, 51, 'secondary'), 300000, 'каталог первичного 0 — своя цена');
  assert.equal(at(6, 51, 'secondary'), 300000, 'ярусов нет — своя цена');
  assert.equal(at(7, 50 + OWNS.indexOf(123457), 'secondary'), 41152.33, '123 457 × 1/3 — до 0,01');
});

// ─── пример владельца: котировка = счёт ──────────────────────────────────────
test('пример владельца: 300 000 → 90 000 → 0 — котировка и счёт; без своей цены 200 000 → 60 000 → 0', () => {
  const { db, CONS, pid } = seed();
  // Первый визит.
  const q1 = quote(db, pid, CONS, 0, OWN);
  assert.deepEqual([q1.tier, q1.price, q1.base_price], ['primary', 300000, 300000]);
  assert.equal(billOne(db, patient(db), CONS, OWN, 'primary'), 300000);
  // Второй визит (3 дня спустя).
  history(db, pid, CONS, -3);
  const q2 = quote(db, pid, CONS, 0, OWN);
  assert.equal(q2.tier, 'secondary', 'ярус считается как прежде');
  assert.equal(q2.price, 90000, 'котировка: 30 % своей цены');
  assert.equal(q2.own_price, 300000);
  assert.equal(q2.base_price, 300000, 'зачёркнутая цена первого визита — своя');
  const plain = quote(db, pid, CONS, 0, PLAIN);
  assert.deepEqual([plain.tier, plain.price], ['secondary', 60000], 'без своей цены — как прежде');
  assert.equal(quote(db, pid, CONS, 0, null).price, 60000, 'без врача — цена яруса');
  const v = visit(db, pid, 0);
  const own = line(db, v, { service_id: CONS, doctor_id: OWN, tier: q2.tier });
  const out = createInvoiceForVisit(db, { visit_id: v, visit_service_ids: [own] }, registrar);
  assert.equal(out.invoice.total_amount, q2.price, 'котировка ≠ счёт');
  assert.equal(vsRow(db, own).price_tier, 'secondary', 'ярус строки не пропал');
  // Третий визит (повторный) — бесплатно и у врача со своей ценой.
  const pid3 = patient(db);
  history(db, pid3, CONS, -5);
  history(db, pid3, CONS, -2, 'secondary');
  const q3 = quote(db, pid3, CONS, 0, OWN);
  assert.deepEqual([q3.tier, q3.price], ['repeat', 0]);
  assert.equal(quote(db, pid3, CONS, 0, PLAIN).price, 0);
  assert.equal(billOne(db, pid3, CONS, OWN, 'repeat'), 0);
});

// ─── края правила через котировку и счёт ─────────────────────────────────────
test('каталог первичного 0 — долю не посчитать: второй визит по своей цене; без своей — цена яруса', () => {
  const { db, pid } = seed();
  const FREE = Number(db.prepare(`INSERT INTO services (name, price, tax_rate, type, price_secondary, secondary_days_from, secondary_days_to)
                                  VALUES ('Осмотр по акции', 0, 0, 'consultation', 50000, 1, 6)`).run().lastInsertRowid);
  db.prepare('UPDATE users SET service_rates = ? WHERE id = ?').run(JSON.stringify([{ service_id: FREE, pct: 10, price: 70000 }]), OWN);
  db.prepare('UPDATE users SET service_rates = ? WHERE id = ?').run(JSON.stringify([{ service_id: FREE, pct: 10 }]), PLAIN);
  history(db, pid, FREE, -3);
  const q = quote(db, pid, FREE, 0, OWN);
  assert.deepEqual([q.tier, q.price], ['secondary', 70000]);
  // (котировки — до счёта: строка сегодняшнего визита для сервера — «слишком рано»)
  assert.equal(quote(db, pid, FREE, 0, PLAIN).price, 50000);
  assert.equal(billOne(db, pid, FREE, OWN, 'secondary'), 70000);
});

test('ярус дороже первичного — своя цена дороже в той же доле, без зажима', () => {
  const { db, pid } = seed();
  const DEAR = Number(db.prepare(`INSERT INTO services (name, price, tax_rate, type, price_secondary, secondary_days_from, secondary_days_to)
                                  VALUES ('Повторная консультация с разбором', 100000, 0, 'consultation', 150000, 1, 6)`).run().lastInsertRowid);
  db.prepare('UPDATE users SET service_rates = ? WHERE id = ?').run(JSON.stringify([{ service_id: DEAR, pct: 10, price: 200000 }]), OWN);
  history(db, pid, DEAR, -3);
  const q = quote(db, pid, DEAR, 0, OWN);
  assert.deepEqual([q.tier, q.price], ['secondary', 300000]);
  assert.equal(billOne(db, pid, DEAR, OWN, 'secondary'), 300000);
});

test('округление: своя 175 000 → 52 500; своя 123 457 → 37 037,1 — котировка = счёт = «Ждут счёта», доля от неё', () => {
  for (const [ownPrice, want] of [[175000, 52500], [123457, 37037.1]]) {
    const { db, CONS, USG, pid } = seed({ ownPrice });
    setOwn(db, CONS, USG, ownPrice);
    history(db, pid, CONS, -3);
    const q = quote(db, pid, CONS, 0, OWN);
    assert.equal(q.price, want, 'котировка');
    const v = visit(db, pid, 0);
    const l = line(db, v, { service_id: CONS, doctor_id: OWN, tier: 'secondary' });
    assert.equal(cashierUnbilled(db, {}, cashier).rows.find((r) => r.visit_id === v).total, want, '«Ждут счёта»');
    const out = createInvoiceForVisit(db, { visit_id: v, visit_service_ids: [l] }, registrar);
    assert.equal(out.invoice.total_amount, want, 'счёт');
    assert.equal(vsRow(db, l).unit_price, want, 'цена строки');
    openCashShift(db, { opening_float: 0 }, cashier);
    recordPayment(db, { invoice_id: out.invoice.id, amount: want, method: 'cash' }, cashier);
    db.prepare("UPDATE visit_services SET status = 'completed' WHERE id = ?").run(l);
    const fee = doctorPaySummary(db, { doctor_id: OWN, from: dayOf(db, -30), to: dayOf(db, 1) }, admin).outpatient.fee;
    assert.equal(fee, Math.round(want * 0.1 * 100) / 100, 'доля 10 % от выставленной суммы');
  }
});

test('строка стационара (без ярусов, tiered: false) — своя цена как прежде, даже со словом яруса', () => {
  const { db, CONS } = seed();
  const svc = db.prepare('SELECT * FROM services WHERE id = ?').get(CONS);
  for (const tier of [null, 'primary', 'secondary', 'repeat']) {
    assert.equal(lineUnitPrice(db, { service_id: CONS, doctor_id: OWN, price_tier: tier }, { service: svc, tiered: false }), 300000);
    assert.equal(lineUnitPrice(db, { service_id: CONS, doctor_id: PLAIN, price_tier: tier }, { service: svc, tiered: false }), 200000);
  }
});

// ─── доля врача от суммы со скидкой яруса ────────────────────────────────────
test('доля врача за второй визит — от 90 000: выставленная и оплаченная строка, и выполненная без счёта', () => {
  const { db, CONS, pid } = seed();
  history(db, pid, CONS, -3);
  const v = visit(db, pid, 0);
  const l = line(db, v, { service_id: CONS, doctor_id: OWN, tier: 'secondary' });
  const out = createInvoiceForVisit(db, { visit_id: v, visit_service_ids: [l] }, registrar);
  assert.equal(out.invoice.total_amount, 90000);
  openCashShift(db, { opening_float: 0 }, cashier);
  recordPayment(db, { invoice_id: out.invoice.id, amount: out.invoice.total_amount, method: 'cash' }, cashier);
  db.prepare("UPDATE visit_services SET status = 'completed' WHERE id = ?").run(l);
  const range = { doctor_id: OWN, from: dayOf(db, -30), to: dayOf(db, 1) };
  assert.equal(doctorPaySummary(db, range, admin).outpatient.fee, 9000, '10 % от 90 000');

  // Выполнено, счёта ещё нет: доля считается от той цены, что выставит касса.
  const v2 = visit(db, pid, 0);
  line(db, v2, { service_id: CONS, doctor_id: OWN, tier: 'secondary', status: 'completed' });
  assert.equal(doctorPaySummary(db, range, admin).outpatient.fee, 18000);
});

// ─── «Ждут счёта» кассы ──────────────────────────────────────────────────────
test('«Ждут счёта»: второй приём — 90 000 у врача со своей ценой; 60 000 без неё', () => {
  const { db, CONS, pid } = seed();
  history(db, pid, CONS, -3);
  const v = visit(db, pid, 0);
  line(db, v, { service_id: CONS, doctor_id: OWN, tier: 'secondary' });
  const pid2 = patient(db);
  history(db, pid2, CONS, -3);
  const v2 = visit(db, pid2, 0);
  line(db, v2, { service_id: CONS, doctor_id: PLAIN, tier: 'secondary' });
  const rows = cashierUnbilled(db, {}, cashier).rows;
  assert.equal(rows.find((r) => r.visit_id === v).total, 90000);
  assert.equal(rows.find((r) => r.visit_id === v2).total, 60000);
});

// ─── правки кассы ────────────────────────────────────────────────────────────
test('касса «Добавить» в счёт второго визита: 90 000 у врача со своей ценой, ярус «второй»; без своей — 60 000', () => {
  const { db, CONS, pid } = seed();
  history(db, pid, CONS, -3);
  const v = visit(db, pid, 0);
  const r = RPC.cashier_line_add(db, { visit_id: v, service_id: CONS, doctor_id: OWN }, cashier);
  const row = db.prepare('SELECT * FROM visit_services WHERE visit_id = ? AND service_id = ?').get(v, CONS);
  assert.ok(r);
  assert.deepEqual([row.unit_price, row.price_tier], [90000, 'secondary']);
  // Другой пациент: у первого сегодняшний приём уже есть, и следующий в тот же
  // день для сервера — снова первичный (окно «от 1 дня»).
  const pid2 = patient(db);
  history(db, pid2, CONS, -3);
  const v2 = visit(db, pid2, 0);
  RPC.cashier_line_add(db, { visit_id: v2, service_id: CONS, doctor_id: PLAIN }, cashier);
  const row2 = db.prepare('SELECT * FROM visit_services WHERE visit_id = ? AND service_id = ?').get(v2, CONS);
  assert.deepEqual([row2.unit_price, row2.price_tier], [60000, 'secondary']);
});

test('касса: замена услуги в неоплаченном счёте на приём второго визита — 90 000 у врача строки со своей ценой', () => {
  const { db, CONS, USG, pid } = seed();
  history(db, pid, CONS, -3);
  const v = visit(db, pid, 0);
  const l = line(db, v, { service_id: USG, doctor_id: OWN });
  const out = createInvoiceForVisit(db, { visit_id: v, visit_service_ids: [l] }, registrar);
  const res = RPC.cashier_line_change_service(db, { visit_service_id: l, new_service_id: CONS }, cashier);
  assert.deepEqual([res.line.unit_price, res.line.price_tier], [90000, 'secondary']);
  assert.equal(inv(db, out.invoice.id).total_amount, 90000);
});

test('касса: смена врача в неоплаченной строке второго визита — цена нового врача (60 000 ↔ 90 000)', () => {
  const { db, CONS, pid } = seed();
  history(db, pid, CONS, -3);
  const v = visit(db, pid, 0);
  const l = line(db, v, { service_id: CONS, doctor_id: PLAIN, tier: 'secondary' });
  const out = createInvoiceForVisit(db, { visit_id: v, visit_service_ids: [l] }, registrar);
  assert.equal(out.invoice.total_amount, 60000);
  RPC.cashier_line_set_doctor(db, { visit_service_id: l, doctor_id: OWN }, cashier);
  assert.deepEqual([vsRow(db, l).unit_price, vsRow(db, l).price_tier], [90000, 'secondary']);
  assert.equal(inv(db, out.invoice.id).total_amount, 90000);
  RPC.cashier_line_set_doctor(db, { visit_service_id: l, doctor_id: PLAIN }, cashier);
  assert.equal(inv(db, out.invoice.id).total_amount, 60000);
});

test('касса: исполнители строки второго визита — у каждого его цена по правилу', () => {
  const { db, CONS, pid } = seed();
  history(db, pid, CONS, -3);
  const v = visit(db, pid, 0);
  const l = line(db, v, { service_id: CONS, doctor_id: PLAIN, tier: 'secondary' });
  const r = RPC.cashier_line_performers(db, { visit_service_id: l }, cashier);
  assert.equal(r.tier, 'secondary');
  assert.equal(r.performers.find((p) => p.id === OWN).unit_price, 90000);
  assert.equal(r.performers.find((p) => p.id === PLAIN).unit_price, 60000);
});

test('касса: замена в ОПЛАЧЕННОМ счёте на приём второго визита — доплата до 90 000; без своей — возврат до 60 000', () => {
  const { db, CONS, USG, pid } = seed();
  openCashShift(db, { opening_float: 0 }, cashier);
  history(db, pid, CONS, -3);
  const pay = (patientId, serviceId, doctorId) => {
    const v = visit(db, patientId, 0);
    const l = line(db, v, { service_id: serviceId, doctor_id: doctorId });
    const out = createInvoiceForVisit(db, { visit_id: v, visit_service_ids: [l] }, registrar);
    recordPayment(db, { invoice_id: out.invoice.id, amount: out.invoice.total_amount, method: 'cash' }, cashier);
    return { l, invoiceId: out.invoice.id };
  };
  const a = pay(pid, USG, OWN);   // оплачено 80 000
  const preview = RPC.cashier_line_swap_quote(db, { visit_service_id: a.l, new_service_id: CONS }, cashier);
  assert.equal(preview.due, 10000, 'предпросмотр: доплата до 90 000');
  const r = RPC.cashier_line_swap_paid(db, { visit_service_id: a.l, new_service_id: CONS }, cashier);
  assert.equal(r.due, 10000);
  assert.deepEqual([vsRow(db, a.l).unit_price, vsRow(db, a.l).price_tier], [90000, 'secondary']);
  assert.equal(inv(db, a.invoiceId).total_amount, 90000);

  const pid2 = patient(db);   // у первого пациента сегодняшний приём уже есть
  history(db, pid2, CONS, -3);
  const b = pay(pid2, USG, PLAIN);   // оплачено 80 000
  const r2 = RPC.cashier_line_swap_paid(db, { visit_service_id: b.l, new_service_id: CONS }, cashier);
  assert.equal(r2.refunded, 20000, 'без своей цены — цена яруса 60 000, как прежде');
  assert.equal(inv(db, b.invoiceId).total_amount, 60000);
});

// ─── счёт врача по своим строкам (REFBILL) ───────────────────────────────────
test('REFBILL: врач выставляет свой второй приём — ярус сверяется с сервером, цена — 90 000', () => {
  const { db, CONS, pid } = seed();
  history(db, pid, CONS, -3);
  const v = visit(db, pid, 0, { status: 'scheduled', by: OWN });
  const l = line(db, v, { service_id: CONS, doctor_id: OWN, tier: 'secondary', by: OWN });
  const out = createInvoiceForVisit(db, { visit_id: v, visit_service_ids: [l], discount_amount: 0, payer_id: null }, doctorOwn);
  assert.equal(out.invoice.total_amount, 90000);
  // Ярус по-прежнему сверяется: «первичный» при втором визите — отказ.
  const bad = line(db, v, { service_id: CONS, doctor_id: OWN, tier: 'primary', by: OWN });
  assert.throws(() => createInvoiceForVisit(db, { visit_id: v, visit_service_ids: [bad], discount_amount: 0, payer_id: null }, doctorOwn),
    (e) => e.status === 403 && /не совпадает с расчётом сервера/.test(e.message));
});

// ─── строка колл-центра / зеркало записи ─────────────────────────────────────
test('колл-центр: строка второго визита — 90 000 у врача со своей ценой, ярус «второй»', () => {
  const { db, CONS, pid } = seed();
  history(db, pid, CONS, -3);
  const v = visit(db, pid, 0, { status: 'scheduled' });
  assert.deepEqual(priceFor(db, { patientId: pid, visitId: v, day: dayOf(db, 0), serviceId: CONS, doctorId: OWN }), { unit: 90000, tier: 'secondary' });
  assert.deepEqual(priceFor(db, { patientId: pid, visitId: v, day: dayOf(db, 0), serviceId: CONS, doctorId: PLAIN }), { unit: 60000, tier: 'secondary' });
});
