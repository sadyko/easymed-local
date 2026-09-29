// REFBILL_REVIEW_V1 (2026-09-29) — РЕВЬЮ REFERRAL_BILL_V1: ВРАЧ ВЫСТАВЛЯЕТ СЧЁТ
// ТОЛЬКО ЗА СВОИ НАПРАВЛЕНИЯ И ТОЛЬКО ПО ЦЕНЕ СЕРВЕРА.
//
// Решение владельца 29.09 пустило врача (doctor, head_doctor — без денежной
// роли) в create_invoice_for_visit. Ревью доказало две дыры:
//
//   C1 — счёт считает строку по тем колонкам, что лежат в ней самой
//        (lineUnitPrice: price_tier, doctor_id), а врач пишет их сам через
//        /api/db. «Повторный визит» (0 сум) первичному пациенту, у которого
//        сервер насчитал 200 000, давал счёт на ноль — «оплачен», строка в
//        очереди, касса не видит ни в «Приёме оплат», ни в «Ждут счёта».
//   M4 — врач выставлял ЛЮБОЙ визит: чужую запись регистратуры, отменённый и
//        «не пришёл», отменённую строку, визит закрытого месяца оплаты врачей.
//
// Теперь для врача без денежной роли:
//   • строка — только СВОЯ (created_by ставит сервер из сессии);
//   • визит живой: не отменён и не «не пришёл»; месяц оплаты врачей открыт;
//   • тариф строки = расчёт сервера для ЭТОГО визита (quoteTier — та же
//     котировка, что service_price_quote: пациент, день визита, сам визит
//     исключён);
//   • исполнитель строки — тот, кому услугу оказывать можно (assertPerformer,
//     то же правило, что у кассы при смене врача);
//   • количество услуги — целое, не меньше одной;
// а отменённая строка не выставляется НИКЕМ. Все отказы — до счёта и номера.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { createInvoiceForVisit } from './billing.js';
import { RPC } from './index.js';

const DOC = 20;
const DOC_B = 21;
const doctor = { id: DOC, role: 'doctor', full_name: 'Врач А' };
const doctorB = { id: DOC_B, role: 'doctor', full_name: 'Врач Б' };
const onlyHead = { id: 33, role: 'nurse', extra_roles: ['head_doctor'], full_name: 'Главный врач' };
const doctorCashier = { id: 34, role: 'doctor', extra_roles: ['cashier'], full_name: 'Врач с кассой' };
const admin = { id: 1, role: 'admin', full_name: 'Админ' };
const registrar = { id: 7, role: 'registrar', full_name: 'Регистратура' };
const cashier = { id: 9, role: 'cashier', full_name: 'Кассир' };

function seed() {
  const db = openDb(':memory:'); migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, role, full_name, is_doctor, extra_roles, is_active) VALUES (?,?,?,?,?,?,?,?)');
  u.run(1, 'adm', 'x', 'admin', 'Админ', 0, '[]', 1);
  u.run(7, 'reg', 'x', 'registrar', 'Регистратура', 0, '[]', 1);
  u.run(9, 'cash', 'x', 'cashier', 'Кассир', 0, '[]', 1);
  u.run(DOC, 'docA', 'x', 'doctor', 'Врач А', 1, '[]', 1);
  u.run(DOC_B, 'docB', 'x', 'doctor', 'Врач Б', 1, '[]', 1);
  u.run(30, 'nurse', 'x', 'nurse', 'Медсестра', 0, '[]', 1);
  u.run(31, 'fired', 'x', 'doctor', 'Уволенный врач', 1, '[]', 0);
  u.run(32, 'reg2', 'x', 'registrar', 'Регистратор с ценой', 0, '[]', 1);
  u.run(33, 'head', 'x', 'nurse', 'Главный врач', 0, '["head_doctor"]', 1);
  u.run(34, 'doccash', 'x', 'doctor', 'Врач с кассой', 1, '["cashier"]', 1);
  // Пример владельца (VISIT_TIER_PRICING_V1): первый приём 200 000, второй за
  // 1–6 дней — 60 000, повторный — бесплатно.
  const CARD = Number(db.prepare(`INSERT INTO services (name, price, type, price_secondary, secondary_days_from, secondary_days_to, price_repeat)
                                  VALUES ('Приём кардиолога', 200000, 'consultation', 60000, 1, 6, 0)`).run().lastInsertRowid);
  const LAB = Number(db.prepare("INSERT INTO services (name, price, type) VALUES ('Анализ крови', 40000, 'lab')").run().lastInsertRowid);
  // Своя цена 0 у коллеги (он принимает бесплатно) и у НЕ исполнителя.
  db.prepare('UPDATE users SET service_rates = ? WHERE id IN (?, ?, ?)')
    .run(JSON.stringify([{ service_id: CARD, price: 0, pct: 0 }, { service_id: LAB, price: 0, pct: 0 }]), DOC_B, 31, 32);
  const pid = Number(db.prepare("INSERT INTO patients (full_name) VALUES ('Новый пациент')").run().lastInsertRowid);
  return { db, CARD, LAB, pid };
}

// Местный полдень дня «сегодня + offset» в UTC — день визита считает SQLite
// тем же 'localtime', что и сервер.
const dayAt = (db, offset) => db.prepare(
  "SELECT strftime('%Y-%m-%dT%H:%M:%SZ', date('now', 'localtime', ?) || ' 12:00:00', 'utc') AS t",
).get(`${offset >= 0 ? '+' : ''}${offset} days`).t;
function visit(db, pid, { offset = 0, status = 'scheduled', by = DOC } = {}) {
  return Number(db.prepare('INSERT INTO visits (patient_id, visit_date, status, created_by) VALUES (?, ?, ?, ?)')
    .run(pid, dayAt(db, offset), status, by).lastInsertRowid);
}
function line(db, vid, { service_id, doctor_id = null, by = DOC, tier = null, status = 'added', qty = 1 } = {}) {
  return Number(db.prepare(`INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, created_by, price_tier)
                            VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?)`).run(vid, service_id, doctor_id, qty, status, by, tier).lastInsertRowid);
}
const counters = (db) => JSON.stringify(db.prepare('SELECT year, next_seq FROM invoice_counters ORDER BY year').all());
const invoices = (db) => db.prepare('SELECT COUNT(*) n FROM invoices').get().n;

// Отказ — и ни счёта, ни израсходованного номера, ни привязанной строки.
function refusedClean(db, fn, re, status, lineId) {
  const before = counters(db);
  const n = invoices(db);
  assert.throws(fn, (e) => {
    assert.equal(e.status, status, 'статус отказа: ' + e.status + ' ' + e.message);
    assert.match(e.message, re);
    return true;
  });
  assert.equal(invoices(db), n, 'отказ оставил счёт');
  assert.equal(counters(db), before, 'отказ израсходовал номер счёта');
  if (lineId != null) assert.equal(db.prepare('SELECT invoice_item_id FROM visit_services WHERE id = ?').get(lineId).invoice_item_id, null);
}

// ─── C1: тариф строки ────────────────────────────────────────────────────────
test('C1: «повторный визит» первичному пациенту — врачу 403 до счёта и номера; честная строка — 200 000', () => {
  const { db, CARD, pid } = seed();
  const vid = visit(db, pid);
  const quote = RPC.service_price_quote(db, { patient_id: pid, service_ids: [CARD] }, doctor).quotes[CARD];
  assert.deepEqual([quote.tier, quote.price], ['primary', 200000], 'сервер сам считает пациента первичным');
  for (const tier of ['repeat', 'secondary']) {
    const l = line(db, vid, { service_id: CARD, tier });
    refusedClean(db, () => createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [l], discount_amount: 0, payer_id: null }, doctor),
      /^Тариф визита в строке «Приём кардиолога» не совпадает с расчётом сервера — счёт по ней выставит касса\.$/, 403, l);
    const own = line(db, vid, { service_id: CARD, tier, by: onlyHead.id });
    refusedClean(db, () => RPC.create_invoice_for_visit(db, { visit_id: vid, visit_service_ids: [own] }, onlyHead),
      /не совпадает с расчётом сервера/, 403, own);
  }
  const honest = line(db, vid, { service_id: CARD });
  const out = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [honest], discount_amount: 0, payer_id: null }, doctor);
  assert.equal(out.invoice.total_amount, 200000);
  assert.equal(out.invoice.status, 'unpaid');
});

test('C1: пациент был 3 дня назад — «второй визит» по расчёту сервера выставляется (60 000); иной тариф — отказ', () => {
  const { db, CARD, pid } = seed();
  const before = visit(db, pid, { offset: -3, status: 'arrived', by: 7 });
  line(db, before, { service_id: CARD, by: 7, status: 'completed' });
  // Все строки — в визите СЕГОДНЯ: сам визит расчёт не считает (quoteTier),
  // прошлый — 3 дня назад, окно второго визита 1–6 дней.
  const vid = visit(db, pid);
  const second = line(db, vid, { service_id: CARD, tier: 'secondary' });
  assert.equal(createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [second] }, doctor).invoice.total_amount, 60000);
  for (const tier of ['repeat', null, 'primary']) {
    const l = line(db, vid, { service_id: CARD, tier });
    refusedClean(db, () => createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [l] }, doctor),
      /не совпадает с расчётом сервера/, 403, l);
  }
});

test('C1: исполнитель строки — только тот, кому услугу оказывать можно (assertPerformer); коллега-врач — по его цене', () => {
  const { db, CARD, LAB, pid } = seed();
  const vid = visit(db, pid);
  const fired = line(db, vid, { service_id: CARD, doctor_id: 31 });
  refusedClean(db, () => createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [fired] }, doctor), /уволен или отключён/, 400, fired);
  const clerk = line(db, vid, { service_id: LAB, doctor_id: 32 });
  refusedClean(db, () => createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [clerk] }, doctor),
    /Исполнителем услуги может быть врач, медсестра или лаборант/, 400, clerk);
  const nurseConsult = line(db, vid, { service_id: CARD, doctor_id: 30 });
  refusedClean(db, () => createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [nurseConsult] }, doctor),
    /Консультацию проводит врач/, 400, nurseConsult);
  // Направить к коллеге — то, ради чего направление и существует: строка у
  // коллеги, цена — его своя (DOCTOR_OWN_PRICE_V1), как у кассы.
  const colleague = line(db, vid, { service_id: LAB, doctor_id: DOC_B });
  const out = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [colleague] }, doctor);
  assert.equal(out.items[0].unit_price, 0, 'своя цена коллеги из «Услуг и ставок»');
});

test('C1: количество услуги у врача — целое, не меньше одной', () => {
  const { db, LAB, pid } = seed();
  const vid = visit(db, pid);
  for (const qty of [0.001, 0.5, 1.5]) {
    const l = line(db, vid, { service_id: LAB, qty });
    refusedClean(db, () => createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [l] }, doctor),
      /Количество услуги «Анализ крови» — целое число/, 403, l);
  }
  const two = line(db, vid, { service_id: LAB, qty: 2 });
  assert.equal(createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [two] }, doctor).invoice.total_amount, 80000);
});

// ─── M4: чьи строки и какого визита ──────────────────────────────────────────
test('M4: врач выставляет только СВОИ строки — регистратуры, коллеги и без автора — 403', () => {
  const { db, LAB, pid } = seed();
  const vid = visit(db, pid, { by: 7 });
  const ofRegistrar = line(db, vid, { service_id: LAB, by: 7 });
  const ofColleague = line(db, vid, { service_id: LAB, by: DOC_B });
  const noAuthor = Number(db.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status) VALUES (?, ?, 1, 1, 1, 'added')").run(vid, LAB).lastInsertRowid);
  for (const l of [ofRegistrar, ofColleague, noAuthor]) {
    refusedClean(db, () => createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [l] }, doctor),
      /^Врач выставляет счёт только за услуги, которые добавил сам\. Остальное выставит касса\.$/, 403, l);
  }
  // Смесь своей и чужой — отказ целиком: половина счёта хуже, чем ничего.
  const mine = line(db, vid, { service_id: LAB });
  refusedClean(db, () => createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [mine, ofRegistrar] }, doctor), /добавил сам/, 403, mine);
  // Коллега выставляет своё сам.
  assert.equal(createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [ofColleague] }, doctorB).invoice.created_by, DOC_B);
  // Касса и регистратура — как прежде: любые строки.
  assert.equal(createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [ofRegistrar] }, cashier).invoice.status, 'unpaid');
  assert.equal(createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [noAuthor] }, registrar).invoice.status, 'unpaid');
});

test('M4: визит отменён или «не пришёл» — врачу 403, даже по своей строке', () => {
  const { db, LAB, pid } = seed();
  for (const status of ['cancelled', 'no_show']) {
    const vid = visit(db, pid, { status });
    const l = line(db, vid, { service_id: LAB });
    refusedClean(db, () => createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [l] }, doctor),
      /^Визит отменён или отмечен «Не пришёл» — счёт по нему врач не выставляет\.$/, 403, l);
  }
});

test('M4: отменённая строка — в счёт не ставит НИКТО', () => {
  const { db, LAB, pid } = seed();
  const vid = visit(db, pid);
  for (const who of [doctor, cashier, registrar, admin, doctorCashier]) {
    const l = line(db, vid, { service_id: LAB, status: 'cancelled', by: who.id });
    refusedClean(db, () => createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [l] }, who),
      new RegExp('^Услуга №' + l + ' отменена — в счёт её не ставят\\.$'), 400, l);
  }
});

test('M4: визит закрытого месяца оплаты врачей — врачу отказ', () => {
  const { db, LAB, pid } = seed();
  const vid = visit(db, pid);
  const l = line(db, vid, { service_id: LAB });
  const month = db.prepare("SELECT strftime('%Y-%m', visit_date, 'localtime') m FROM visits WHERE id = ?").get(vid).m;
  db.prepare('INSERT INTO pay_periods (month, closed_by, total, lines) VALUES (?, 1, 0, 0)').run(month);
  refusedClean(db, () => createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [l] }, doctor),
    /^Месяц этого визита закрыт в «Оплате врачей» — счёт по нему выставит касса\.$/, 409, l);
});

test('врач с денежной ролью, касса и регистратура — без границ врача (тариф строки, чужие строки)', () => {
  const { db, CARD, pid } = seed();
  const vid = visit(db, pid, { by: 7 });
  for (const who of [doctorCashier, cashier, registrar, admin]) {
    const l = line(db, vid, { service_id: CARD, by: 7, tier: 'secondary' });
    assert.equal(createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [l] }, who).invoice.total_amount, 60000, who.full_name);
  }
});
