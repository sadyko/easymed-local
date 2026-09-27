// Ответы владельца 27.09 об оплате врачей — правило целиком, через настоящие
// RPC кассы (выставить, оплатить, вернуть, отменить) и настоящие отчёты:
//
//   D1 PAY_REFUND_V1       — «возврат забирает и долю врача»;
//   D2 PAY_PERIOD_CLOSE_V1 — закрытый месяц заморожен, поздние изменения —
//                            корректировками в первом открытом месяце;
//   D3 PAY_GOODS_NONE_V1   — на товары процента нет;
//   D4 PAY_ALL_EARNINGS_V1 — итог — все начисления, тип зарплаты не влияет;
//   D5                     — отмеченная услуга со ставкой 0 платит 0.
//
// В каждом сценарии — паритет: кабинет врача (doctor_pay_summary.total) =
// «Зарплаты врачей» = «По врачам» (оба «Итого к выплате») = сумма «Доли врача»
// «Детализации» (doctor_lines).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { runReport, doctorPaySummary, payPeriodClose, payPeriodReopen, payPeriodStatus } from './reports.js';
import { createInvoiceForVisit, recordPayment, refundPayment } from './billing.js';
import { voidInvoice } from './cashier.js';
import { RPC } from './index.js';
import { isReadOnlyRpc } from '../control/gate.js';
import { today } from '../domain/day.js';

const admin = { id: 9, role: 'admin' };
const doctorUser = { id: 1, role: 'doctor' };

// Месяцы относительно сегодняшнего дня клиники: закрыть можно только прошедший.
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

// Врач 1 «Доктор Д.» — 30 % за приём (услуга 1), по умолчанию 10 %.
// Приём 100 000, налог 6 % → доля 28 200.
const ONE = 28200;
function clinic() {
  const db = openDb(':memory:');
  migrate(db);
  const u = db.prepare(`INSERT INTO users (id, username, password_hash, role, full_name, is_doctor, service_rates, service_rate_default, salary_type, salary_fixed)
                        VALUES (?,?,?,?,?,1,?,?,?,?)`);
  u.run(1, 'doc', 'x', 'doctor', 'Доктор Д.', JSON.stringify([{ service_id: 1, pct: 30 }, { service_id: 2, pct: 0 }]), 10, 'percentage', 0);
  u.run(9, 'adm', 'x', 'admin', 'Администратор', '', 0, '', 0);
  u.run(5, 'cash', 'x', 'cashier', 'Кассир', '', 0, '', 0);
  db.prepare("INSERT INTO patients (id, mrn, full_name) VALUES (1,'P-1','Пациент')").run();
  db.prepare("INSERT INTO services (id, name, price, tax_rate) VALUES (1,'Приём',100000,6)").run();
  db.prepare("INSERT INTO services (id, name, price, tax_rate) VALUES (2,'Перевязка',50000,0)").run();
  db.prepare("INSERT INTO products (id, name, sale_price) VALUES (1,'Бинт',20000)").run();
  let seq = 0;
  // Выполненная строка визита в день at (без счёта).
  const line = ({ at, service = 1, product = null, status = 'completed', qty = 1 } = {}) => {
    const id = ++seq;
    db.prepare('INSERT INTO visits (id, patient_id, visit_date, status) VALUES (?,1,?,?)').run(id, at, 'scheduled');
    const price = product ? 20000 : (service === 1 ? 100000 : 50000);
    db.prepare(`INSERT INTO visit_services (id, visit_id, service_id, clinic_item_id, doctor_id, quantity, unit_price, total, status)
                VALUES (?,?,?,?,1,?,?,?,?)`).run(id, id, product ? null : service, product, qty, price, price * qty, status);
    return id;
  };
  const bill = (id) => createInvoiceForVisit(db, { visit_id: id, visit_service_ids: [id] }, admin).invoice;
  const pay = (inv, amount = inv.total_amount) => {
    recordPayment(db, { invoice_id: inv.id, amount, method: 'cash' }, admin);
    return db.prepare('SELECT id FROM payments WHERE invoice_id = ? AND amount > 0 ORDER BY id DESC').get(inv.id).id;
  };
  return { db, line, bill, pay };
}

const objects = (r) => r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]])));
const run = (db, kind, rng) => runReport(db, { kind, ...rng }, admin);
const round2 = (n) => Math.round(n * 100) / 100;

// Паритет четырёх мест по врачу; возвращает общее число.
function parity(db, rng, doctorId = 1, name = 'Доктор Д.') {
  const cab = doctorPaySummary(db, { doctor_id: doctorId, ...rng }, admin).total;
  const sal = objects(run(db, 'doctor_salaries', rng)).find((o) => o['Врач'] === name);
  const byd = objects(run(db, 'by_doctors', rng)).find((o) => o['Врач'] === name);
  const det = objects(run(db, 'doctor_lines', rng)).filter((o) => o['Врач'] === name);
  const lines = round2(det.reduce((n, o) => n + o['Доля врача'], 0));
  assert.equal(sal ? sal['Итого к выплате'] : 0, cab, 'кабинет = «Зарплаты врачей»');
  assert.equal(byd ? byd['Итого к выплате'] : 0, cab, 'кабинет = «По врачам»');
  assert.equal(lines, cab, 'кабинет = «Детализация»');
  return cab;
}

// ─── D1. ВОЗВРАТ ЗАБИРАЕТ ДОЛЮ ВРАЧА ─────────────────────────────────────────

test('D1: полный возврат, счёт остался неоплаченным — доля 0', () => {
  const c = clinic();
  const { cur } = months(c.db);
  const id = c.line({ at: cur + '-05T09:00:00Z' });
  const inv = c.bill(id);
  const p = c.pay(inv);
  assert.equal(parity(c.db, range(cur)), ONE);
  refundPayment(c.db, { payment_id: p, void_when_zero: false }, admin);   // BILLING_AUDIT_FIX_V1 (B2): открыт явно
  assert.equal(c.db.prepare('SELECT status FROM invoices WHERE id = ?').get(inv.id).status, 'unpaid');
  assert.equal(parity(c.db, range(cur)), 0);
});

test('D1: возврат и отмена (касса по умолчанию) — строка отпущена, но не платит; выставили заново — платит', () => {
  const c = clinic();
  const { cur } = months(c.db);
  const id = c.line({ at: cur + '-05T09:00:00Z' });
  const inv = c.bill(id);
  const p = c.pay(inv);
  const r = refundPayment(c.db, { payment_id: p, void_when_zero: true }, admin);
  assert.equal(r.voided, true);
  const vs = c.db.prepare('SELECT invoice_item_id, status FROM visit_services WHERE id = ?').get(id);
  assert.equal(vs.invoice_item_id, null, 'касса отпустила строку со счёта');
  assert.equal(vs.status, 'completed');
  assert.equal(parity(c.db, range(cur)), 0, 'отмена после возврата — не «работа без счёта»');
  // Выставили новым счётом — выполненная работа снова платит (и неоплаченной).
  const again = c.bill(id);
  assert.equal(parity(c.db, range(cur)), ONE);
  c.pay(again);
  assert.equal(parity(c.db, range(cur)), ONE);
});

test('D1: обычная отмена неоплаченного счёта — работа остаётся оплачиваемой', () => {
  const c = clinic();
  const { cur } = months(c.db);
  const id = c.line({ at: cur + '-05T09:00:00Z' });
  const inv = c.bill(id);
  voidInvoice(c.db, { invoice_id: inv.id }, admin);
  assert.equal(c.db.prepare('SELECT COUNT(*) n FROM pay_refund_releases').get().n, 0);
  assert.equal(parity(c.db, range(cur)), ONE);
});

test('D1: строка, оставшаяся привязанной к счёту, отменённому после возврата, не платит', () => {
  // Старые данные: отмена ещё не отпускала строки.
  const c = clinic();
  const { cur } = months(c.db);
  const id = c.line({ at: cur + '-05T09:00:00Z' });
  const inv = c.bill(id);
  const p = c.pay(inv);
  refundPayment(c.db, { payment_id: p }, admin);
  c.db.prepare("UPDATE invoices SET status = 'void' WHERE id = ?").run(inv.id);
  assert.equal(parity(c.db, range(cur)), 0);
});

test('D1: частичный возврат — доля в той же пропорции', () => {
  const c = clinic();
  const { cur } = months(c.db);
  const id = c.line({ at: cur + '-05T09:00:00Z' });
  const inv = c.bill(id);
  const p = c.pay(inv);
  refundPayment(c.db, { payment_id: p, amount: 30000 }, admin);   // вернули 30 %
  assert.equal(parity(c.db, range(cur)), round2(ONE * 0.7));
  // Вернули остаток — ноль; доплатили снова полностью — снова вся доля.
  refundPayment(c.db, { payment_id: p, void_when_zero: false }, admin);   // B2: счёт оставлен открытым — его оплатят снова
  assert.equal(parity(c.db, range(cur)), 0);
  c.pay(c.db.prepare('SELECT * FROM invoices WHERE id = ?').get(inv.id), 100000);
  assert.equal(parity(c.db, range(cur)), ONE);
});

test('D1: стационар — строка полностью возвращённого счёта госпитализации не платит', () => {
  const c = clinic();
  const { cur } = months(c.db);
  c.db.prepare(`UPDATE users SET inpatient_rates = ? WHERE id = 1`).run(JSON.stringify([{ service_id: 1, pct: 50 }]));
  c.db.prepare("INSERT INTO admissions (id, patient_id, status) VALUES (1, 1, 'discharged')").run();
  c.db.prepare(`INSERT INTO invoices (id, invoice_number, admission_id, patient_id, subtotal, discount_amount, total_amount, paid_amount, status, created_at)
                VALUES (50, 'INV-ADM', 1, 1, 100000, 0, 100000, 0, 'unpaid', ?)`).run(cur + '-06T09:00:00Z');
  c.db.prepare("INSERT INTO invoice_items (id, invoice_id, service_id, description, quantity, unit_price, total) VALUES (50, 50, 1, 'Приём', 1, 100000, 100000)").run();
  c.db.prepare(`INSERT INTO admission_services (id, admission_id, service_id, doctor_id, quantity, unit_price, total, status, invoice_item_id, performed_at)
                VALUES (1, 1, 1, 1, 1, 100000, 100000, 'completed', 50, ?)`).run(cur + '-06T09:00:00Z');
  const inv = c.db.prepare('SELECT * FROM invoices WHERE id = 50').get();
  const p = c.pay(inv);
  const inFee = () => doctorPaySummary(c.db, { doctor_id: 1, ...range(cur) }, admin).inpatient.fee;
  assert.equal(inFee(), 47000);   // (100 000 − 6 %) × 50 %
  refundPayment(c.db, { payment_id: p }, admin);
  assert.equal(inFee(), 0);
  assert.equal(parity(c.db, range(cur)), 0);
});

// ─── D3. ТОВАРЫ ДОЛИ НЕ ДАЮТ ─────────────────────────────────────────────────

test('D3: строка товара с врачом не платит ни личной ставкой, ни ставкой по умолчанию', () => {
  const c = clinic();
  const { cur } = months(c.db);
  const id = c.line({ at: cur + '-05T09:00:00Z', product: 1 });
  assert.equal(parity(c.db, range(cur)), 0, 'без счёта');
  const inv = c.bill(id);
  c.pay(inv);
  assert.equal(parity(c.db, range(cur)), 0, 'со счётом');
  // «Общая выручка» (доля по строкам счёта) — тоже 0.
  const rev = objects(run(c.db, 'total_revenue', range(cur)));
  assert.equal(round2(rev.reduce((n, o) => n + (o['Доля врача'] || 0), 0)), 0);
  // Услуга рядом платит как обычно.
  c.line({ at: cur + '-06T09:00:00Z' });
  assert.equal(parity(c.db, range(cur)), ONE);
});

// ─── D5. ОТМЕЧЕННАЯ УСЛУГА СО СТАВКОЙ 0 ──────────────────────────────────────

test('D5: отмеченная услуга со ставкой 0 платит 0 — ставка по умолчанию не подставляется', () => {
  const c = clinic();
  const { cur } = months(c.db);
  c.line({ at: cur + '-05T09:00:00Z', service: 2 });
  assert.equal(parity(c.db, range(cur)), 0);
});

// ─── D4. ИТОГ — ВСЕ НАЧИСЛЕНИЯ ───────────────────────────────────────────────

test('D4: врач на окладе — итог кабинета = все начисления, оклад — только сведением', () => {
  const c = clinic();
  const { cur } = months(c.db);
  c.db.prepare("UPDATE users SET salary_type = 'fixed', salary_fixed = 5000000 WHERE id = 1").run();
  c.line({ at: cur + '-05T09:00:00Z' });
  const s = doctorPaySummary(c.db, { doctor_id: 1, ...range(cur) }, admin);
  assert.equal(s.total, ONE);
  assert.equal(s.salary_type, 'fixed');
  assert.equal(s.salary_fixed, 5000000);
  assert.equal(parity(c.db, range(cur)), ONE);
});

test('D4: вознаграждение за направления входит в «Итого к выплате» всех отчётов и кабинета', () => {
  const c = clinic();
  const { cur } = months(c.db);
  // Внутренний источник врача 1 со своими 10 %; пациент пришёл по нему.
  // Внутренний источник врача заводится сам (мигр. 122) — берём его.
  let src = c.db.prepare('SELECT id FROM referral_sources WHERE doctor_id = 1').get();
  if (!src) src = { id: c.db.prepare("INSERT INTO referral_sources (name, doctor_id) VALUES ('Доктор Д.', 1)").run().lastInsertRowid };
  c.db.prepare("UPDATE referral_sources SET reward_mode = 'own', own_percent = 10, own_rates = '[]' WHERE id = ?").run(src.id);
  c.db.prepare('UPDATE patients SET referral_source_id = ? WHERE id = 1').run(src.id);
  c.db.prepare(`INSERT INTO users (id, username, password_hash, role, full_name, is_doctor) VALUES (2, 'd2', 'x', 'doctor', 'Второй', 1)`).run();
  const id = c.line({ at: cur + '-05T09:00:00Z' });
  c.db.prepare('UPDATE visit_services SET doctor_id = 2 WHERE id = ?').run(id);
  c.pay(c.bill(id));
  // 10 % от 100 000 = 10 000 — вся выплата врачу 1.
  assert.equal(parity(c.db, range(cur)), 10000);
  const sal = objects(run(c.db, 'doctor_salaries', range(cur))).find((o) => o['Врач'] === 'Доктор Д.');
  assert.equal(sal['Вознаграждение за направления'], 10000);
});

// ─── D2. ЗАКРЫТЫЙ МЕСЯЦ ──────────────────────────────────────────────────────

test('D2: закрытый месяц показывает запись; поздний возврат — корректировкой в текущем месяце', () => {
  const c = clinic();
  const { cur, prev } = months(c.db);
  const id = c.line({ at: prev + '-10T09:00:00Z' });
  const inv = c.bill(id);
  const p = c.pay(inv);
  const closed = payPeriodClose(c.db, { month: prev }, admin);
  assert.equal(closed.total, ONE);
  assert.equal(parity(c.db, range(prev)), ONE);
  assert.equal(doctorPaySummary(c.db, { doctor_id: 1, ...range(prev) }, admin).lines[0].frozen, true);
  assert.equal(doctorPaySummary(c.db, { doctor_id: 1, ...range(prev) }, admin).closed_months[0].month, prev);

  // Возврат уже после закрытия: август не двигается, минус — в текущем месяце.
  refundPayment(c.db, { payment_id: p }, admin);
  assert.equal(parity(c.db, range(prev)), ONE, 'итог закрытого месяца не меняется');
  assert.equal(parity(c.db, range(cur)), -ONE);
  const adj = doctorPaySummary(c.db, { doctor_id: 1, ...range(cur) }, admin).adjustments;
  assert.equal(adj.count, 1);
  assert.match(adj.rows[0].label, /^Корректировка за /);
  const det = objects(run(c.db, 'doctor_lines', range(cur)));
  assert.equal(det[0]['Где'], 'Корректировка');
  assert.equal(det[0]['Доля врача'], -ONE);
  const sal = objects(run(c.db, 'doctor_salaries', range(cur)))[0];
  assert.equal(sal['Корректировки'], -ONE);
  // Оба месяца вместе — ноль: выплаченное вернулось.
  assert.equal(parity(c.db, { from: range(prev).from, to: range(cur).to }), 0);
});

test('D2: поздно отмеченная работа закрытого месяца — плюс корректировкой; ступень заморожена записью', () => {
  const c = clinic();
  const { cur, prev } = months(c.db);
  c.line({ at: prev + '-10T09:00:00Z' });
  const late = c.line({ at: prev + '-12T09:00:00Z', status: 'queued' });
  payPeriodClose(c.db, { month: prev }, admin);
  assert.equal(parity(c.db, range(prev)), ONE);
  c.db.prepare("UPDATE visit_services SET status = 'resulted' WHERE id = ?").run(late);
  assert.equal(parity(c.db, range(prev)), ONE);
  assert.equal(parity(c.db, range(cur)), ONE);
  // Ставку поменяли задним числом — закрытый месяц не двигается, разница — корректировкой.
  c.db.prepare('UPDATE users SET service_rates = ? WHERE id = 1').run(JSON.stringify([{ service_id: 1, pct: 40 }]));
  assert.equal(parity(c.db, range(prev)), ONE);
  // Живой расчёт августа: 2 × 37 600 = 75 200; записано 28 200 → +47 000.
  assert.equal(parity(c.db, range(cur)), 75200 - ONE);
});

test('D2: корректировки записываются при закрытии следующего месяца и больше не повторяются', () => {
  const c = clinic();
  const { cur, prev, prev2 } = months(c.db);
  const id = c.line({ at: prev2 + '-10T09:00:00Z' });
  const p = c.pay(c.bill(id));
  payPeriodClose(c.db, { month: prev2 }, admin);
  refundPayment(c.db, { payment_id: p }, admin);
  // Первый открытый месяц после prev2 — prev: корректировка там (последним днём).
  assert.equal(parity(c.db, range(prev)), -ONE);
  assert.equal(parity(c.db, range(cur)), 0);
  const closedPrev = payPeriodClose(c.db, { month: prev }, admin);
  assert.equal(closedPrev.adjustments, 1);
  assert.equal(parity(c.db, range(prev)), -ONE, 'корректировка записана в prev');
  assert.equal(parity(c.db, range(cur)), 0, 'и не повторяется в текущем');
  assert.equal(parity(c.db, range(prev2)), ONE);
  // Открыть prev2 нельзя, пока его корректировка лежит в закрытом prev.
  assert.throws(() => payPeriodReopen(c.db, { month: prev2 }, admin), /Сначала откройте/);
  payPeriodReopen(c.db, { month: prev }, admin);
  assert.equal(parity(c.db, range(prev)), -ONE, 'prev открыт — корректировка снова живая');
  payPeriodReopen(c.db, { month: prev2 }, admin);
  assert.equal(parity(c.db, range(prev2)), 0, 'prev2 открыт — живой расчёт');
  assert.equal(parity(c.db, range(prev)), 0);
  const st = payPeriodStatus(c.db, {}, admin);
  assert.equal(st.months.length, 0);
  assert.deepEqual(st.log.map((l) => l.action), ['reopen', 'reopen', 'close', 'close']);
});

test('D2: ворота — текущий месяц не закрыть, дважды не закрыть, врачу нельзя, открыть — только администратор', () => {
  const c = clinic();
  const { cur, prev } = months(c.db);
  assert.throws(() => payPeriodClose(c.db, { month: cur }, admin), /Текущий месяц/);
  assert.throws(() => payPeriodClose(c.db, { month: '2026-13' }, admin), /YYYY-MM|ГГГГ-ММ/);   // REPORTS_AUDIT_FIX_V1 — по-русски
  assert.throws(() => payPeriodClose(c.db, { month: prev }, doctorUser), (e) => e.status === 403);
  payPeriodClose(c.db, { month: prev }, admin);
  assert.throws(() => payPeriodClose(c.db, { month: prev }, admin), /уже закрыт/);
  // Право «Оплата врачей: правка» у роли кассира — закрывает, но не открывает.
  c.db.prepare('DELETE FROM role_permissions WHERE role = ?').run('cashier');
  c.db.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?)')
    .run('cashier', JSON.stringify({ sections: ['reports-hub'], levels: {}, grants: { 'reports.doctor_pay': 'edit' } }));
  const cashier = { id: 5, role: 'cashier' };
  const { prev2 } = months(c.db);
  payPeriodClose(c.db, { month: prev2 }, cashier);
  assert.throws(() => payPeriodReopen(c.db, { month: prev2 }, cashier), (e) => e.status === 403);
  // Врач видит, какие месяцы закрыты, но не суммы клиники.
  const st = payPeriodStatus(c.db, {}, doctorUser);
  assert.equal(st.months.length, 2);
  assert.equal(st.months[0].total, undefined);
  assert.equal(st.can_close, false);
});

test('D2: RPC зарегистрированы; статус — чтение, закрытие и открытие — запись', () => {
  for (const n of ['pay_period_close', 'pay_period_reopen', 'pay_period_status']) assert.equal(typeof RPC[n], 'function', n);
  assert.equal(isReadOnlyRpc('pay_period_status'), true);
  assert.equal(isReadOnlyRpc('pay_period_close'), false);
  assert.equal(isReadOnlyRpc('pay_period_reopen'), false);
});

// ─── FINAL_MONEY_FIX_V1 (C1). КОНСУЛЬТАЦИЯ — УСЛУГА, А НЕ ТОВАР ──────────────
// Строка консультации — service_id NULL + consultation_type_id (visit-line-row.js,
// walk-in-booking.js). Правило «на товары процента нет» читало её как товар
// (строка без услуги) и не платило врачу за приём ничего. Товар — только
// строка продукта (clinic_item_id) или строка вовсе без услуги и без вида приёма.

function consultClinic() {
  const c = clinic();
  c.db.prepare("INSERT INTO consultation_types (id, name, price) VALUES (1, 'Первичный приём', 100000)").run();
  // Строка консультации; в браузере сохранена устаревшая цена 70 000 — выплата
  // обязана считать ту же цену, что поставит касса (цена вида приёма, 100 000).
  c.consult = ({ at, doctor = 1 } = {}) => {
    const id = 1000 + c.db.prepare('SELECT COUNT(*) n FROM visits').get().n;
    c.db.prepare('INSERT INTO visits (id, patient_id, visit_date, status) VALUES (?,1,?,?)').run(id, at, 'scheduled');
    c.db.prepare(`INSERT INTO visit_services (id, visit_id, service_id, consultation_type_id, doctor_id, quantity, unit_price, total, status)
                  VALUES (?,?,NULL,1,?,1,70000,70000,'completed')`).run(id, id, doctor);
    return id;
  };
  return c;
}

test('C1: консультация со ставкой по умолчанию 10 % платит 10 000 — без счёта, со счётом, оплаченная', () => {
  const c = consultClinic();
  const { cur } = months(c.db);
  const id = c.consult({ at: cur + '-05T09:00:00Z' });
  assert.equal(parity(c.db, range(cur)), 10000, 'без счёта — цена вида приёма, не браузерная');
  const inv = c.bill(id);
  assert.equal(inv.total_amount, 100000);
  assert.equal(c.db.prepare('SELECT service_id FROM invoice_items WHERE invoice_id = ?').get(inv.id).service_id, null);
  assert.equal(parity(c.db, range(cur)), 10000, 'со счётом');
  c.pay(inv);
  assert.equal(parity(c.db, range(cur)), 10000, 'оплаченная');
  // «Общая выручка» (доля по строкам счёта) — те же 10 000.
  const rev = objects(run(c.db, 'total_revenue', range(cur)));
  assert.equal(round2(rev.reduce((n, o) => n + (o['Доля врача'] || 0), 0)), 10000);
});

test('C1: товар без услуги и без вида приёма по-прежнему доли не даёт', () => {
  const c = consultClinic();
  const { cur } = months(c.db);
  const id = c.consult({ at: cur + '-05T09:00:00Z' });
  c.db.prepare('UPDATE visit_services SET consultation_type_id = NULL WHERE id = ?').run(id);
  assert.equal(parity(c.db, range(cur)), 0);
});

test('C1: вознаграждение внутреннему направившему за консультацию возвращено', () => {
  const c = consultClinic();
  const { cur } = months(c.db);
  let src = c.db.prepare('SELECT id FROM referral_sources WHERE doctor_id = 1').get();
  if (!src) src = { id: c.db.prepare("INSERT INTO referral_sources (name, doctor_id) VALUES ('Доктор Д.', 1)").run().lastInsertRowid };
  c.db.prepare("UPDATE referral_sources SET reward_mode = 'own', own_percent = 10, own_rates = '[]' WHERE id = ?").run(src.id);
  c.db.prepare('UPDATE patients SET referral_source_id = ? WHERE id = 1').run(src.id);
  c.db.prepare(`INSERT INTO users (id, username, password_hash, role, full_name, is_doctor, service_rate_default) VALUES (2, 'd2', 'x', 'doctor', 'Второй', 1, 0)`).run();
  const id = c.consult({ at: cur + '-05T09:00:00Z', doctor: 2 });
  c.pay(c.bill(id));
  assert.equal(parity(c.db, range(cur)), 10000);
  const sal = objects(run(c.db, 'doctor_salaries', range(cur))).find((o) => o['Врач'] === 'Доктор Д.');
  assert.equal(sal['Вознаграждение за направления'], 10000);
});
