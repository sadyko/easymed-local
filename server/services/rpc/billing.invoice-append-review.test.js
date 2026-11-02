// INVOICE_APPEND_V1 (ревью C1, m1, m2) — В НЕОПЛАЧЕННЫЙ СЧЁТ ДОПИСЫВАЕТСЯ
// ТОЛЬКО ТО, ЧТО ПОТОМ ДЕЛИТСЯ ПО СТРОКАМ ТАК ЖЕ, КАК ДВА ОТДЕЛЬНЫХ СЧЁТА.
//
// Скидка счёта на строки без своей скидки («остаток»: ручная и пол группы
// пациента) одна на весь счёт, и все, кто делит её по строкам, делят
// пропорционально сумме строк: возврат строки (refund_invoice_line), удаление
// строки до оплаты (remove_unpaid_service), доля врача и вознаграждение за
// направление (reports.js, STAGE1_DISCOUNT_SQL). Ревью: ручная скидка одной
// части, слитая в общий остаток, после этого переезжала на чужие строки —
// консультация 100 000 + анализ 40 000, ручные 20 000 на анализ: возврат
// анализа отдавал 34 285,71 вместо 20 000; ручные 30 000 на консультацию:
// возврат анализа — 31 428,57 вместо 40 000, удаление анализа до оплаты
// оставляло консультацию за 78 571,43 вместо 70 000; доли врачей сдвигались.
// И m1: группа пациента подросла после первого счёта — дописывание давало
// новый процент и прежней части.
//
// Правило: дописывается, только когда обе части несут ОДНУ И ТУ ЖЕ долю —
// сегодняшний пол группы и ничего сверх него (у новой части запрошенная скидка
// не больше её пола группы, у прежней остаток = пол группы её строк по
// СЕГОДНЯШНЕМУ проценту). Иначе — новый счёт, как в 3.20.0. Плюс m2: счёт,
// выставленный не сегодня (местный день), не дописывается — отчёты считают
// строки по дню счёта, и новая услуга уехала бы в старый (может быть, уже
// закрытый) месяц.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { today } from '../domain/day.js';
import { createInvoiceForVisit, recordPayment } from './billing.js';
import { performedPayLines, doctorReferralReward } from './reports.js';
import { RPC } from './index.js';

const D1 = 20, D2 = 21, NAPR = 22;
const admin = { id: 1, role: 'admin', full_name: 'Админ' };
const registrar = { id: 7, role: 'registrar', full_name: 'Регистратура' };
const cashier = { id: 9, role: 'cashier', full_name: 'Кассир' };
const doctor = { id: D1, role: 'doctor', full_name: 'Врач' };
const r2 = (n) => Math.round(n * 100) / 100;

function seed({ pct = 0 } = {}) {
  const db = openDb(':memory:'); migrate(db);
  const u = db.prepare(`INSERT INTO users (id, username, password_hash, role, full_name, is_doctor, extra_roles, service_rates, service_rate_default)
                        VALUES (?,?,?,?,?,?,?,?,?)`);
  u.run(1, 'adm', 'x', 'admin', 'Админ', 0, '[]', '', 0);
  u.run(7, 'reg', 'x', 'registrar', 'Регистратура', 0, '[]', '', 0);
  u.run(9, 'cash', 'x', 'cashier', 'Кассир', 0, '[]', '', 0);
  u.run(D1, 'doc', 'x', 'doctor', 'Врач Один', 1, '[]', '', 30);
  u.run(D2, 'doc2', 'x', 'doctor', 'Врач Два', 1, '[]', '', 30);
  u.run(NAPR, 'napr', 'x', 'doctor', 'Направляев', 1, '[]', '', 0);
  const svc = (name, price, lab = 0) => Number(db.prepare('INSERT INTO services (name, price, is_lab, tax_rate) VALUES (?, ?, ?, 0)').run(name, price, lab).lastInsertRowid);
  const CONS = svc('Приём терапевта', 100000);
  const LAB = svc('Анализ крови', 40000, 1);
  const ECG = svc('ЭКГ', 50000);
  // Направивший врач — свой источник, 10 % (как reports.v3120-final.test.js;
  // источник врача заводит сама база).
  let src = db.prepare('SELECT id FROM referral_sources WHERE doctor_id = ?').get(NAPR);
  src = src ? Number(src.id) : Number(db.prepare("INSERT INTO referral_sources (name, doctor_id) VALUES ('Направляев', ?)").run(NAPR).lastInsertRowid);
  db.prepare("UPDATE referral_sources SET reward_mode = 'own', own_percent = 10, own_rates = '[]' WHERE id = ?").run(src);
  const pid = Number(db.prepare("INSERT INTO patients (full_name, referral_source_id) VALUES ('Пациент', ?)").run(src).lastInsertRowid);
  let cat = null;
  if (pct) {
    cat = Number(db.prepare("INSERT INTO patient_categories (name, discount_percent, active) VALUES ('VIP', ?, 1)").run(pct).lastInsertRowid);
    db.prepare('UPDATE patients SET category_id = ? WHERE id = ?').run(cat, pid);
  }
  const vid = newVisit(db, pid);
  return { db, CONS, LAB, ECG, pid, vid, cat };
}
function newVisit(db, pid) {
  return Number(db.prepare("INSERT INTO visits (patient_id, visit_date, created_by) VALUES (?, strftime('%Y-%m-%dT%H:%M:%SZ','now'), 7)").run(pid).lastInsertRowid);
}
function line(db, vid, serviceId, { by = 7, doctorId = null } = {}) {
  return Number(db.prepare(
    "INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, created_by) VALUES (?, ?, ?, 1, 1, 1, 'added', ?)",
  ).run(vid, serviceId, doctorId, by).lastInsertRowid);
}
const bill = (db, vid, ids, user = registrar, extra = {}) =>
  createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: ids, discount_amount: 0, payer_id: null, ...extra }, user);
const inv = (db, id) => db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
const invOfLine = (db, vsId) => db.prepare(`SELECT i.* FROM visit_services vs JOIN invoice_items ii ON ii.id = vs.invoice_item_id
                                              JOIN invoices i ON i.id = ii.invoice_id WHERE vs.id = ?`).get(vsId);
const money = (i) => [i.subtotal, i.discount_amount, i.total_amount];

// Консультация (врач 1) первой регистрацией, анализ (врач 2) — второй.
// mode 'appended' — та же регистрация визита (счёт дописывается, если правило
// пускает); 'separate' — анализ своим визитом, значит своим счётом (3.20.0).
function twoParts(mode, { pct = 0, d1 = 0, d2 = 0 } = {}) {
  const s = seed({ pct });
  const { db, vid, pid } = s;
  const a = line(db, vid, s.CONS, { doctorId: D1 });
  const first = bill(db, vid, [a], registrar, { discount_amount: d1 });
  const v2 = mode === 'separate' ? newVisit(db, pid) : vid;
  const b = line(db, v2, s.LAB, { doctorId: D2 });
  const second = bill(db, v2, [b], registrar, { discount_amount: d2 });
  return { ...s, a, b, first, second };
}
const invoiceIds = (db) => db.prepare('SELECT id FROM invoices ORDER BY id').all().map((r) => r.id);
const payAll = (db) => { for (const id of invoiceIds(db)) { const i = inv(db, id); if (i.total_amount > 0) recordPayment(db, { invoice_id: id, amount: i.total_amount, method: 'cash' }, cashier); } };

// ───────────── скидка сверх пола группы — НОВЫЙ счёт, как в 3.20.0 ─────────────

const FALLBACK = [
  ['ручная 20 000 на новую часть (группа 10 %)', { pct: 10, d2: 20000 }],
  ['ручная 30 000 на прежнюю часть', { d1: 30000 }],
  ['ручная на обе части', { d1: 10000, d2: 7000 }],
  ['новой части запрошено на 0,01 больше её пола группы', { pct: 10, d2: 4000.01 }],
];
for (const [what, opts] of FALLBACK) {
  test(`C1: ${what} — второй вызов выставляет НОВЫЙ счёт, прежний не меняется`, () => {
    const { db, first, second } = twoParts('appended', opts);
    const before = money(first.invoice);
    assert.equal(second.appended, undefined, 'дописано, хотя у части скидка сверх пола группы');
    assert.notEqual(second.invoice.id, first.invoice.id);
    assert.deepEqual(money(inv(db, first.invoice.id)), before, 'прежний счёт изменился');
    const sep = twoParts('separate', opts);
    assert.deepEqual(money(second.invoice), money(sep.second.invoice), 'новый счёт — как отдельный счёт 3.20.0');
  });
}

test('m1: группу пациента подняли после первого счёта — дописывания нет, прежняя часть не получает новый процент', () => {
  for (const [label, user, by] of [['регистратура', registrar, 7], ['врач без денежной роли', doctor, D1]]) {
    const s = seed({ pct: 10 });
    const { db, vid, cat } = s;
    const first = bill(db, vid, [line(db, vid, s.CONS)]);
    assert.deepEqual(money(first.invoice), [100000, 10000, 90000]);
    db.prepare('UPDATE patient_categories SET discount_percent = 30 WHERE id = ?').run(cat);
    const own = line(db, vid, s.LAB, { by });
    const out = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [own] }, user);
    assert.equal(out.appended, undefined, label + ': дописано после смены процента группы');
    assert.deepEqual(money(out.invoice), [40000, 12000, 28000], label + ': новая часть — свои 30 %');
    assert.deepEqual(money(inv(db, first.invoice.id)), [100000, 10000, 90000], label + ': прежняя часть получила 30 %');
  }
});

test('m1: группу пациента сняли после первого счёта — дописывания нет, прежний счёт не меняется', () => {
  const s = seed({ pct: 10 });
  const { db, vid, cat } = s;
  const first = bill(db, vid, [line(db, vid, s.CONS)]);
  db.prepare('UPDATE patient_categories SET discount_percent = 0 WHERE id = ?').run(cat);
  const out = bill(db, vid, [line(db, vid, s.LAB)]);
  assert.equal(out.appended, undefined);
  assert.deepEqual(money(out.invoice), [40000, 0, 40000]);
  assert.deepEqual(money(inv(db, first.invoice.id)), [100000, 10000, 90000]);
});

// ───────────── только пол группы — дописывается, итог = сумма двух счетов ─────────────

test('C1: пол группы у обеих частей (мастер присылает ровно его) — дописано, суммы = два отдельных счёта', () => {
  for (const d2 of [0, 4000]) {
    const app = twoParts('appended', { pct: 10, d2 });
    const sep = twoParts('separate', { pct: 10, d2 });
    assert.equal(app.second.appended, true, 'd2 = ' + d2);
    assert.equal(app.second.invoice.id, app.first.invoice.id);
    assert.equal(app.second.rest_discount, 4000, 'rest_discount — пол группы новой части');
    const sum = [0, 1, 2].map((k) => r2(money(sep.first.invoice)[k] + money(sep.second.invoice)[k]));
    assert.deepEqual(money(app.second.invoice), sum, 'дописанный счёт = сумма двух счетов');
    assert.deepEqual(money(app.second.invoice), [140000, 14000, 126000]);
  }
});

// ───────────── делится по строкам так же, как два отдельных счёта ─────────────
// Сценарии ревью (консультация 100 000 у врача 1 + анализ 40 000 у врача 2):
// там, где правило дописывает (только пол группы), и там, где теперь выходит
// новый счёт (ручная скидка одной из частей), деньги по строкам — как у двух
// отдельных счетов 3.20.0. Ожидаемые числа — у отдельных счетов.

const PARITY = [
  { tag: 'без группы', opts: {}, appended: true, refund: 40000, consult: [100000, 0, 100000], disc: [0, 0], reward: 14000 },
  { tag: 'группа 10 %', opts: { pct: 10 }, appended: true, refund: 36000, consult: [100000, 10000, 90000], disc: [10000, 4000], reward: 12600 },
  { tag: 'ручная 20 000 на анализ', opts: { d2: 20000 }, appended: false, refund: 20000, consult: [100000, 0, 100000], disc: [0, 20000], reward: 12000 },
  { tag: 'ручная 30 000 на консультацию', opts: { d1: 30000 }, appended: false, refund: 40000, consult: [100000, 30000, 70000], disc: [30000, 0], reward: 11000 },
];
for (const P of PARITY) {
  const appendedFlag = (t) => assert.equal(t.second.appended === true, P.appended, 'appended');

  test(`C1 (${P.tag}): возврат анализа после оплаты — столько же, сколько у отдельного счёта`, () => {
    const res = {};
    for (const mode of ['separate', 'appended']) {
      const t = twoParts(mode, P.opts);
      if (mode === 'appended') appendedFlag(t);
      payAll(t.db);
      const item = t.db.prepare('SELECT invoice_item_id FROM visit_services WHERE id = ?').get(t.b).invoice_item_id;
      const out = RPC.refund_invoice_line(t.db, { invoice_item_id: item, reason: 'ревью' }, cashier);
      res[mode] = { refunded: out.refunded, kept: r2(invoiceIds(t.db).reduce((x, id) => x + inv(t.db, id).paid_amount, 0)) };
    }
    assert.deepEqual(res.appended, res.separate);
    assert.equal(res.appended.refunded, P.refund);
  });

  test(`C1 (${P.tag}): анализ убран до оплаты — консультация стоит столько же, сколько своим счётом`, () => {
    const res = {};
    for (const mode of ['separate', 'appended']) {
      const t = twoParts(mode, P.opts);
      if (mode === 'appended') appendedFlag(t);
      RPC.remove_unpaid_service(t.db, { visit_service_id: t.b }, admin);
      res[mode] = money(invOfLine(t.db, t.a));
    }
    assert.deepEqual(res.appended, res.separate);
    assert.deepEqual(res.appended, P.consult);
  });

  test(`C1 (${P.tag}): доля врачей (performedPayLines) и вознаграждение за направление — по строкам, как у двух счетов`, () => {
    const res = {};
    for (const mode of ['separate', 'appended']) {
      const t = twoParts(mode, P.opts);
      if (mode === 'appended') appendedFlag(t);
      payAll(t.db);
      t.db.prepare("UPDATE visit_services SET status = 'completed' WHERE id IN (?, ?)").run(t.a, t.b);
      const day = today(t.db);
      const rng = { from: day.slice(0, 7) + '-01', to: day };
      const pay = performedPayLines(t.db, rng).filter((x) => x.kind === 'out')
        .map((x) => [x.doctor_id, r2(x.amount), r2(x.discount), r2(x.net), r2(x.doctor_fee)])
        .sort((x, y) => x[0] - y[0]);
      const ref = doctorReferralReward(t.db, { doctor_id: NAPR, ...rng }, admin);
      res[mode] = { pay, ref: ref.rows.map((r) => [r.service, r.amount, r.reward]).sort(), reward: ref.reward };
    }
    assert.deepEqual(res.appended, res.separate);
    assert.equal(res.appended.pay.length, 2);
    assert.deepEqual(res.appended.pay.map((x) => x[2]), P.disc);
    assert.equal(res.appended.reward, P.reward);
  });
}

// ───────────── m2: счёт не сегодняшнего дня не дописывается ─────────────

test('m2: неоплаченный счёт визита выставлен вчера (местный день) — новые услуги новым счётом сегодняшним числом', () => {
  const { db, CONS, LAB, vid } = seed();
  const first = bill(db, vid, [line(db, vid, CONS)]);
  db.prepare("UPDATE invoices SET created_at = strftime('%Y-%m-%dT%H:%M:%SZ','now','-1 day') WHERE id = ?").run(first.invoice.id);
  const before = money(inv(db, first.invoice.id));
  const second = bill(db, vid, [line(db, vid, LAB)]);
  assert.equal(second.appended, undefined, 'строка дописана в счёт вчерашнего дня');
  assert.notEqual(second.invoice.id, first.invoice.id);
  assert.deepEqual(money(inv(db, first.invoice.id)), before);
  assert.equal(db.prepare("SELECT date(created_at, 'localtime') d FROM invoices WHERE id = ?").get(second.invoice.id).d, today(db));
});

test('m2: счёт выставлен сегодня (местный день) — дописывается, как прежде', () => {
  const { db, CONS, LAB, vid } = seed();
  const first = bill(db, vid, [line(db, vid, CONS)]);
  const second = bill(db, vid, [line(db, vid, LAB)]);
  assert.equal(second.appended, true);
  assert.equal(second.invoice.id, first.invoice.id);
});
