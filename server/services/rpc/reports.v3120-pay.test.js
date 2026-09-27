// V3120_FIX — оплата врачей, вознаграждения за направления и закрытый месяц
// (решения владельца 27.09, docs/plans/2026-09-27-owner-answers.md):
//
//   R1 — частичный возврат уменьшает вознаграждение за направление
//        ПРОПОРЦИОНАЛЬНО (как долю врача, PAY_REFUND_V1), а не обнуляет его;
//   R2 — «Рефералы» закрытого месяца — из записи месяца: строки партнёров
//        записываются при закрытии, поздние изменения — корректировками по
//        источнику; строки сотрудников = «Зарплаты врачей»;
//   F  — ставки меняются только ВПЕРЁД: правка ставок врача, ступеней, скидки
//        категории, ставок источника не переоценивает закрытый месяц;
//        корректировки — только от событий строки (возврат, поздняя отметка,
//        отмена, новый счёт).
//
// Всё — через настоящие RPC кассы и настоящие отчёты.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { runReport, doctorPaySummary, payPeriodClose, payPeriodReopen } from './reports.js';
import { createInvoiceForVisit, createInvoiceForAdmission, recordPayment, refundPayment } from './billing.js';
import { today } from '../domain/day.js';

const admin = { id: 9, role: 'admin' };

function months(db) {
  const cur = today(db).slice(0, 7);
  const back = (m) => {
    let y = Number(m.slice(0, 4)); let mm = Number(m.slice(5, 7)) - 1;
    if (mm < 1) { mm = 12; y -= 1; }
    return y + '-' + String(mm).padStart(2, '0');
  };
  const prev = back(cur);
  return { cur, prev, prev2: back(prev) };
}
const lastDay = (m) => m + '-' + String(new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).getUTCDate()).padStart(2, '0');
const range = (m) => ({ from: m + '-01', to: lastDay(m) });
const objects = (r) => r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]])));
const run = (db, kind, rng, extra = {}) => runReport(db, { kind, ...rng, ...extra }, admin);
const round2 = (n) => Math.round(n * 100) / 100;
const sum = (list, col) => round2(list.reduce((n, o) => n + (Number(o[col]) || 0), 0));

// Врач 1 «Доктор Д.» — исполнитель, 30 % за услугу 1 (налога нет — числа
// круглые). Врач 2 «Направляев» — сотрудник-направивший: его внутренний
// источник, 10 %. Партнёр «Клиника Х» — внешний источник, 5 %.
function clinic() {
  const db = openDb(':memory:');
  migrate(db);
  const u = db.prepare(`INSERT INTO users (id, username, password_hash, role, full_name, is_doctor, service_rates, service_rate_default)
                        VALUES (?,?,?,?,?,?,?,?)`);
  u.run(1, 'doc', 'x', 'doctor', 'Доктор Д.', 1, JSON.stringify([{ service_id: 1, pct: 30 }]), 0);
  u.run(2, 'napr', 'x', 'doctor', 'Направляев Н.', 1, '', 0);
  u.run(9, 'adm', 'x', 'admin', 'Администратор', 0, '', 0);
  db.prepare("INSERT INTO services (id, name, price, tax_rate, type) VALUES (1,'Процедура',100000,0,'procedure')").run();
  let own = db.prepare('SELECT id FROM referral_sources WHERE doctor_id = 2').get();
  if (!own) own = { id: db.prepare("INSERT INTO referral_sources (name, doctor_id) VALUES ('Направляев Н.', 2)").run().lastInsertRowid };
  db.prepare("UPDATE referral_sources SET reward_mode = 'own', own_percent = 10, own_rates = '[]' WHERE id = ?").run(own.id);
  const cat = db.prepare("INSERT INTO referral_source_categories (name, standard_percent) VALUES ('Партнёры', 0)").run().lastInsertRowid;
  const partner = db.prepare(`INSERT INTO referral_sources (name, code, category_id, reward_mode, own_percent, own_rates)
                              VALUES ('Клиника Х', 'KX', ?, 'own', 5, '[]')`).run(cat).lastInsertRowid;
  const pt = db.prepare('INSERT INTO patients (id, mrn, full_name, referral_source_id) VALUES (?,?,?,?)');
  pt.run(1, 'P-1', 'Пациент партнёра', partner);
  pt.run(2, 'P-2', 'Пациент врача', own.id);
  pt.run(3, 'P-3', 'Пациент без направления', null);
  let seq = 0;
  // Выполненная строка визита пациента patient в день at (без счёта).
  const line = ({ at, patient = 3, qty = 1, status = 'completed' } = {}) => {
    const id = ++seq;
    db.prepare('INSERT INTO visits (id, patient_id, visit_date, status) VALUES (?,?,?,?)').run(id, patient, at, 'scheduled');
    db.prepare(`INSERT INTO visit_services (id, visit_id, service_id, doctor_id, quantity, unit_price, total, status)
                VALUES (?,?,1,1,?,100000,?,?)`).run(id, id, qty, 100000 * qty, status);
    return id;
  };
  // Счёт на строку, датированный днём строки (период «Рефералов» — по дате счёта).
  const bill = (id, at) => {
    const inv = createInvoiceForVisit(db, { visit_id: id, visit_service_ids: [id] }, admin).invoice;
    if (at) db.prepare('UPDATE invoices SET created_at = ? WHERE id = ?').run(at, inv.id);
    return inv;
  };
  const pay = (inv, amount = inv.total_amount) => {
    recordPayment(db, { invoice_id: inv.id, amount, method: 'cash' }, admin);
    return db.prepare('SELECT id FROM payments WHERE invoice_id = ? AND amount > 0 ORDER BY id DESC').get(inv.id).id;
  };
  return { db, line, bill, pay, partner, own: own.id };
}

const refRows = (db, rng, extra) => objects(run(db, 'referrals', rng, extra));
const rewardOf = (rows, source, where) => sum(rows.filter((o) => o['Источник'] === source && (!where || o['Где'] === where)), 'Вознаграждение');
const salaryReferral = (db, rng, name = 'Направляев Н.') => {
  const o = objects(run(db, 'doctor_salaries', rng)).find((x) => x['Врач'] === name);
  return o ? o['Вознаграждение за направления'] : 0;
};

// ─── R1. ЧАСТИЧНЫЙ ВОЗВРАТ — ВОЗНАГРАЖДЕНИЕ ПРОПОРЦИОНАЛЬНО ──────────────────

test('R1: частичный возврат уменьшает вознаграждение партнёру и сотруднику в той же доле', () => {
  const c = clinic();
  const { cur } = months(c.db);
  const at = cur + '-02T09:00:00Z';
  const pPartner = c.pay(c.bill(c.line({ at, patient: 1 }), at));
  const pDoctor = c.pay(c.bill(c.line({ at, patient: 2 }), at));
  let rows = refRows(c.db, range(cur));
  assert.equal(rewardOf(rows, 'Клиника Х'), 5000);
  assert.equal(rewardOf(rows, 'Направляев Н.'), 10000);
  // Вернули четверть денег по каждому счёту: партнёрский счёт кассир оставил
  // открытым (reopen_balance — «Частично оплачен», сумма счёта прежняя), счёт
  // сотрудника — обычным возвратом (сумма счёта уменьшается вместе с оплатой).
  refundPayment(c.db, { payment_id: pPartner, amount: 25000, reason: 'часть', reopen_balance: true }, admin);
  refundPayment(c.db, { payment_id: pDoctor, amount: 25000, reason: 'часть' }, admin);
  rows = refRows(c.db, range(cur));
  assert.equal(rewardOf(rows, 'Клиника Х'), 3750, 'партнёру — 75 % от 5 000, а не 0');
  assert.equal(rewardOf(rows, 'Направляев Н.'), 7500, 'сотруднику — 75 % от 10 000');
  assert.equal(rows.find((o) => o['Источник'] === 'Клиника Х')['Оплачено'], 75000, '«Оплачено» — оставшиеся деньги');
  // Кабинет и «Зарплаты врачей» — то же число.
  assert.equal(salaryReferral(c.db, range(cur)), 7500);
  assert.equal(doctorPaySummary(c.db, { doctor_id: 2, ...range(cur) }, admin).referral.reward, 7500);
  const det = objects(run(c.db, 'referrals_detail', range(cur)));
  assert.equal(sum(det, 'Вознаграждение'), 11250, 'детализация = сводка');
});

test('R1: неоплаченный и полностью возвращённый счёт — вознаграждения нет, как прежде', () => {
  const c = clinic();
  const { cur } = months(c.db);
  const at = cur + '-02T09:00:00Z';
  const inv = c.bill(c.line({ at, patient: 1 }), at);
  c.pay(inv, 40000);   // частично оплачен, возвратов нет
  assert.equal(rewardOf(refRows(c.db, range(cur)), 'Клиника Х'), 0);
  c.pay(inv, 60000);
  assert.equal(rewardOf(refRows(c.db, range(cur)), 'Клиника Х'), 5000);
  const inv2 = c.bill(c.line({ at, patient: 1 }), at);
  const p2 = c.pay(inv2, 50000);
  refundPayment(c.db, { payment_id: p2, amount: 10000, reason: 'часть' }, admin);
  assert.equal(rewardOf(refRows(c.db, range(cur)), 'Клиника Х'), 5000, 'возврат по так и не оплаченному счёту — 0');
});

test('R1: стационар — процент и фикс партнёра после частичного возврата уменьшаются в той же доле', () => {
  const c = clinic();
  const { cur } = months(c.db);
  c.db.prepare('UPDATE referral_sources SET inpatient_bonus_enabled = 1, inpatient_pct = 5, inpatient_fixed = 50000 WHERE id = ?').run(c.partner);
  c.db.prepare(`INSERT INTO admissions (id, admission_no, patient_id, doctor_id, status, referral_source_id)
                VALUES (1, 'A-1', 3, 1, 'active', ?)`).run(c.partner);
  c.db.prepare(`INSERT INTO admission_services (id, admission_id, service_id, doctor_id, performer_id, quantity, unit_price, total, status, billable, performed_at)
                VALUES (1, 1, 1, 1, 1, 10, 100000, 1000000, 'added', 1, ?)`).run(cur + '-02T09:00:00Z');
  const { invoice } = createInvoiceForAdmission(c.db, { admission_id: 1, admission_service_ids: [1] }, admin);
  const p = c.pay(invoice);
  const inRows = () => refRows(c.db, range(cur)).filter((o) => o['Где'] === 'Стационар');
  assert.equal(rewardOf(inRows(), 'Клиника Х'), 100000, '5 % от 1 000 000 + фикс 50 000');
  refundPayment(c.db, { payment_id: p, amount: 100000, reason: 'часть' }, admin);
  assert.equal(rewardOf(inRows(), 'Клиника Х'), 90000, '90 % от 50 000 + 90 % от 50 000');
});

// ─── R2. «РЕФЕРАЛЫ» ЗАКРЫТОГО МЕСЯЦА — ИЗ ЗАПИСИ ─────────────────────────────

test('R2: закрытый месяц «Рефералов» не двигается; поздний возврат — корректировкой по источнику; сотрудник = «Зарплаты врачей»', () => {
  const c = clinic();
  const { cur, prev, prev2 } = months(c.db);
  const at = prev2 + '-10T09:00:00Z';
  const pPartner = c.pay(c.bill(c.line({ at, patient: 1 }), at));
  const pDoctor = c.pay(c.bill(c.line({ at, patient: 2 }), at));
  const closed = payPeriodClose(c.db, { month: prev2 }, admin);
  assert.ok(closed.partner_lines >= 1, 'строки партнёров записаны');
  const before = refRows(c.db, range(prev2));
  assert.equal(rewardOf(before, 'Клиника Х'), 5000);
  assert.equal(rewardOf(before, 'Направляев Н.'), 10000);
  assert.equal(rewardOf(before, 'Направляев Н.'), salaryReferral(c.db, range(prev2)));

  // После закрытия: партнёру вернули четверть (счёт оставлен открытым), по счёту
  // сотрудника — обычный возврат четверти.
  refundPayment(c.db, { payment_id: pPartner, amount: 25000, reason: 'после закрытия', reopen_balance: true }, admin);
  refundPayment(c.db, { payment_id: pDoctor, amount: 25000, reason: 'после закрытия' }, admin);
  const after = refRows(c.db, range(prev2));
  assert.equal(rewardOf(after, 'Клиника Х'), 5000, 'закрытый месяц партнёра не двигается');
  assert.equal(rewardOf(after, 'Направляев Н.'), 10000);
  assert.equal(rewardOf(after, 'Направляев Н.'), salaryReferral(c.db, range(prev2)), 'сотрудник в «Рефералах» = «Зарплаты врачей»');
  assert.ok(after.every((o) => o['Где'] !== 'Корректировка'));

  // Корректировки — в первом открытом месяце (prev), по получателю.
  const adj = refRows(c.db, range(prev)).filter((o) => o['Где'] === 'Корректировка');
  assert.equal(rewardOf(adj, 'Клиника Х'), -1250);
  assert.equal(rewardOf(adj, 'Направляев Н.'), -2500);
  const sal = objects(run(c.db, 'doctor_salaries', range(prev))).find((o) => o['Врач'] === 'Направляев Н.');
  assert.equal(sal['Корректировки'], -2500, 'у сотрудника — та же корректировка в «Зарплатах врачей»');
  assert.equal(sal['Вознаграждение за направления'], 0);
  const det = objects(run(c.db, 'referrals_detail', range(prev)));
  assert.equal(sum(det, 'Вознаграждение'), -3750, 'детализация = сводка');
  assert.match(det[0]['Услуга'], /^Корректировка за /);
  // Внешние / внутренние — корректировка идёт со своим получателем.
  assert.equal(rewardOf(refRows(c.db, range(prev), { referrer: 'external' }), 'Клиника Х'), -1250);
  assert.equal(refRows(c.db, range(prev), { referrer: 'external' }).filter((o) => o['Источник'] === 'Направляев Н.').length, 0);

  // Закрыли prev — корректировки записаны в него и больше не повторяются.
  payPeriodClose(c.db, { month: prev }, admin);
  assert.equal(rewardOf(refRows(c.db, range(prev)), 'Клиника Х'), -1250);
  assert.equal(refRows(c.db, range(cur)).length, 0);
  assert.throws(() => payPeriodReopen(c.db, { month: prev2 }, admin), /Сначала откройте/);
  // Открыли оба — снова живой расчёт.
  payPeriodReopen(c.db, { month: prev }, admin);
  payPeriodReopen(c.db, { month: prev2 }, admin);
  assert.equal(rewardOf(refRows(c.db, range(prev2)), 'Клиника Х'), 3750);
});

test('R2: месяц, закрытый до миграции 202 (без партнёров), у партнёров остаётся живым и корректировок им не даёт', () => {
  const c = clinic();
  const { prev, prev2 } = months(c.db);
  const at = prev2 + '-10T09:00:00Z';
  const p = c.pay(c.bill(c.line({ at, patient: 1 }), at));
  payPeriodClose(c.db, { month: prev2 }, admin);
  // Имитация старой записи: партнёров в ней нет.
  c.db.prepare('DELETE FROM pay_period_lines WHERE doctor_id IS NULL').run();
  c.db.prepare('UPDATE pay_periods SET partners = 0').run();
  refundPayment(c.db, { payment_id: p, amount: 25000, reason: 'после закрытия', reopen_balance: true }, admin);
  assert.equal(rewardOf(refRows(c.db, range(prev2)), 'Клиника Х'), 3750, 'живой, как прежде');
  assert.equal(refRows(c.db, range(prev)).length, 0, 'и без корректировки — иначе вычли бы дважды');
});

// ─── F. СТАВКИ МЕНЯЮТСЯ ТОЛЬКО ВПЕРЁД ────────────────────────────────────────

const cab = (db, rng, doctorId = 1) => doctorPaySummary(db, { doctor_id: doctorId, ...rng }, admin);

test('F: правка ставки врача и ставок источников после закрытия не даёт корректировок', () => {
  const c = clinic();
  const { cur, prev } = months(c.db);
  const at = prev + '-10T09:00:00Z';
  c.pay(c.bill(c.line({ at, patient: 1 }), at));
  c.pay(c.bill(c.line({ at, patient: 2 }), at));
  payPeriodClose(c.db, { month: prev }, admin);
  assert.equal(cab(c.db, range(prev)).total, 60000);
  c.db.prepare('UPDATE users SET service_rates = ?, service_rate_default = 50 WHERE id = 1').run(JSON.stringify([{ service_id: 1, pct: 40 }]));
  c.db.prepare('UPDATE referral_sources SET own_percent = 30 WHERE doctor_id = 2').run();
  c.db.prepare('UPDATE referral_sources SET own_percent = 20 WHERE id = ?').run(c.partner);
  c.db.prepare('INSERT INTO doctor_rates (doctor_id, service_id, percent, active) VALUES (1, 1, 60, 1)').run();
  assert.equal(cab(c.db, range(cur)).adjustments.count, 0);
  assert.equal(cab(c.db, range(cur), 2).adjustments.count, 0);
  assert.equal(refRows(c.db, range(cur)).length, 0);
  assert.equal(cab(c.db, range(prev)).total, 60000);
});

test('F: ступень — правка порога и процента не переоценивает; возврат, сдвинувший место в ступени, — переоценивает', () => {
  const c = clinic();
  const { cur, prev } = months(c.db);
  c.db.prepare('UPDATE services SET doctor_tier_from = 3, doctor_tier_percent = 50 WHERE id = 1').run();
  const pays = [];
  for (let d = 3; d <= 6; d += 1) {
    const at = prev + '-0' + d + 'T09:00:00Z';
    pays.push(c.pay(c.bill(c.line({ at }), at)));
  }
  assert.equal(cab(c.db, range(prev)).total, 30000 * 3 + 50000);
  payPeriodClose(c.db, { month: prev }, admin);
  // Правка ступени после закрытия — ничего.
  c.db.prepare('UPDATE services SET doctor_tier_from = 1, doctor_tier_percent = 70 WHERE id = 1').run();
  assert.equal(cab(c.db, range(cur)).adjustments.count, 0);
  c.db.prepare('UPDATE services SET doctor_tier_from = 3, doctor_tier_percent = 50 WHERE id = 1').run();
  // Возврат первой строки: она −30 000, и четвёртая опускается ниже порога: −20 000.
  refundPayment(c.db, { payment_id: pays[0], reason: 'после закрытия' }, admin);
  assert.equal(cab(c.db, range(cur)).adjustments.fee, -50000);
  // Ступень потом сняли с услуги — места строки больше не видно: четвёртая как записана.
  c.db.prepare('UPDATE services SET doctor_tier_from = 0, doctor_tier_percent = 0 WHERE id = 1').run();
  assert.equal(cab(c.db, range(cur)).adjustments.fee, -30000);
  assert.equal(cab(c.db, range(prev)).total, 140000);
});

test('F: строка без счёта — правка цены и скидки категории после закрытия не переоценивает; новый счёт — событие', () => {
  const c = clinic();
  const { cur, prev } = months(c.db);
  const cat = c.db.prepare("INSERT INTO patient_categories (name, discount_percent, active) VALUES ('Льгота', 10, 1)").run().lastInsertRowid;
  c.db.prepare('UPDATE patients SET category_id = ? WHERE id = 3').run(cat);
  const id = c.line({ at: prev + '-10T09:00:00Z' });
  assert.equal(cab(c.db, range(prev)).total, 27000, '100 000 − 10 % = 90 000 × 30 %');
  payPeriodClose(c.db, { month: prev }, admin);
  c.db.prepare('UPDATE patient_categories SET discount_percent = 50 WHERE id = ?').run(cat);
  c.db.prepare('UPDATE services SET price = 200000 WHERE id = 1').run();
  assert.equal(cab(c.db, range(cur)).adjustments.count, 0);
  // Выставили счёт — это событие строки: доля по деньгам счёта, ставка месяца.
  const inv = c.bill(id);
  c.db.prepare('UPDATE users SET service_rates = ? WHERE id = 1').run(JSON.stringify([{ service_id: 1, pct: 90 }]));
  const net = c.db.prepare('SELECT total_amount FROM invoices WHERE id = ?').get(inv.id).total_amount;
  assert.equal(cab(c.db, range(cur)).adjustments.fee, round2(net * 0.3 - 27000));
});

test('F: стационар — ставка сотрудника-направившего, поднятая с нуля после закрытия, закрытый месяц не переоценивает', () => {
  const c = clinic();
  const { cur, prev } = months(c.db);
  c.db.prepare(`INSERT INTO admissions (id, admission_no, patient_id, doctor_id, status, referring_doctor_id)
                VALUES (1, 'A-1', 3, 1, 'discharged', 2)`).run();
  c.db.prepare(`INSERT INTO admission_services (id, admission_id, service_id, doctor_id, performer_id, quantity, unit_price, total, status, billable, performed_at)
                VALUES (1, 1, 1, 1, 1, 1, 100000, 100000, 'added', 1, ?)`).run(prev + '-10T09:00:00Z');
  const { invoice } = createInvoiceForAdmission(c.db, { admission_id: 1, admission_service_ids: [1] }, admin);
  c.db.prepare('UPDATE invoices SET created_at = ? WHERE id = ?').run(prev + '-10T10:00:00Z', invoice.id);
  c.pay(invoice);
  payPeriodClose(c.db, { month: prev }, admin);
  c.db.prepare('UPDATE users SET inpatient_referral_pct = 5, inpatient_referral_fixed = 70000 WHERE id = 2').run();
  assert.equal(cab(c.db, range(cur), 2).adjustments.count, 0);
  assert.equal(refRows(c.db, range(prev)).filter((o) => o['Источник'] === 'Направляев Н.').length, 0, 'строки с нулевой ставкой в отчёт не выходят');
});
