// V3120_FINAL (C1) — ЧАСТИЧНЫЙ ВОЗВРАТ «СКИДКОЙ ПОСЛЕ ПРОДАЖИ» ДОХОДИТ ДО
// КАЖДОЙ СТРОКИ СЧЁТА, В ТОМ ЧИСЛЕ ДО СТРОК ПАКЕТА И ДО ФИКСИРОВАННЫХ СТАВОК.
//
// Частичный возврат по оплаченному счёту уменьшает сумму счёта (скидка после
// продажи, billing.js refundPayment). Прежде эта скидка ложилась только на
// строки без своей скидки: у счёта из одних строк пакета она не доходила ни до
// одной строки (доля врача не менялась вовсе), у смешанного счёта её забирала
// обычная строка до нуля, а хвост терялся; фиксированная ставка врача и фикс
// вознаграждения не уменьшались совсем (коэффициент возврата после «сумма =
// оплачено» равен 1). Теперь скидка после продажи хранится у счёта
// (invoices.post_sale_discount) и делится на ВСЕ строки пропорционально их
// сумме после своих скидок; фикс умножается на ту же долю — ровно то же, что
// при возврате «с доплатой» (reopen_balance) или на койке.
//
// Всё — через настоящие RPC кассы и настоящие отчёты.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { runReport, doctorPaySummary, doctorReferralReward, payPeriodClose } from './reports.js';
import { createInvoiceForVisit, createInvoiceForAdmission, recordPayment, refundPayment, refundInvoiceLine } from './billing.js';
import { today } from '../domain/day.js';

const admin = { id: 9, role: 'admin' };
const round2 = (n) => Math.round(n * 100) / 100;
const objects = (r) => r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]])));
const sum = (list, col) => round2(list.reduce((n, o) => n + (Number(o[col]) || 0), 0));

// Врач 1 — исполнитель: 30 % на услуги 1, 2, 3 (или фикс — rates). Врач 2 —
// сотрудник-направивший, свой источник 10 %. Налога нет — числа круглые.
// Пакет [1, 2] — 20 %. Услуга 3 (50 000) — вне пакета.
function clinic({ rates = null, refRates = '[]' } = {}) {
  const db = openDb(':memory:');
  migrate(db);
  const day = today(db);
  const at = day + 'T09:00:00Z';
  const rng = { from: day.slice(0, 7) + '-01', to: day };
  const u = db.prepare(`INSERT INTO users (id, username, password_hash, role, full_name, is_doctor, service_rates, service_rate_default)
                        VALUES (?,?,?,?,?,?,?,0)`);
  u.run(1, 'doc', 'x', 'doctor', 'Доктор Д.', 1, JSON.stringify(rates || [1, 2, 3].map((id) => ({ service_id: id, pct: 30 }))));
  u.run(2, 'napr', 'x', 'doctor', 'Направляев Н.', 1, '');
  u.run(9, 'adm', 'x', 'admin', 'Администратор', 0, '');
  db.prepare("INSERT INTO services (id, name, price, tax_rate, type) VALUES (1,'УЗИ',100000,0,'imaging')").run();
  db.prepare("INSERT INTO services (id, name, price, tax_rate, type) VALUES (2,'ЭКГ',100000,0,'procedure')").run();
  db.prepare("INSERT INTO services (id, name, price, tax_rate, type) VALUES (3,'Анализ',50000,0,'lab')").run();
  let src = db.prepare('SELECT id FROM referral_sources WHERE doctor_id = 2').get();
  if (!src) src = { id: db.prepare("INSERT INTO referral_sources (name, doctor_id) VALUES ('Направляев Н.', 2)").run().lastInsertRowid };
  db.prepare("UPDATE referral_sources SET reward_mode = 'own', own_percent = 10, own_rates = ? WHERE id = ?").run(refRates, src.id);
  db.prepare("INSERT INTO patients (id, mrn, full_name, referral_source_id) VALUES (1, 'P-1', 'Пациент', ?)").run(src.id);
  const pkg = db.prepare(`INSERT INTO service_templates (name, service_ids, discount_percent, active)
                          VALUES ('Осень', '[1,2]', 20, 1)`).run().lastInsertRowid;
  const visit = db.prepare("INSERT INTO visits (patient_id, visit_date, status) VALUES (1, ?, 'scheduled')").run(at).lastInsertRowid;
  const line = (serviceId, inPackage) => {
    const price = serviceId === 3 ? 50000 : 100000;
    return db.prepare(`INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, package_id)
                       VALUES (?,?,1,1,?,?,'completed',?)`).run(visit, serviceId, price, price, inPackage ? pkg : null).lastInsertRowid;
  };
  const bill = (ids) => createInvoiceForVisit(db, { visit_id: visit, visit_service_ids: ids }, admin);
  const pay = (inv) => {
    recordPayment(db, { invoice_id: inv.id, amount: inv.total_amount, method: 'cash' }, admin);
    return db.prepare('SELECT id FROM payments WHERE invoice_id = ? AND amount > 0 ORDER BY id DESC').get(inv.id).id;
  };
  return { db, rng, line, bill, pay };
}

// Все денежные числа, которые показывают отчёты и кабинет.
function money(c) {
  const fee = doctorPaySummary(c.db, { doctor_id: 1, ...c.rng }, admin).outpatient.fee;
  const referral = doctorReferralReward(c.db, { doctor_id: 2, ...c.rng }, admin).reward;
  const rev = objects(runReport(c.db, { kind: 'total_revenue', ...c.rng }, admin));
  const svc = objects(runReport(c.db, { kind: 'by_services', ...c.rng }, admin));
  const sal = objects(runReport(c.db, { kind: 'doctor_salaries', ...c.rng }, admin));
  const doc = sal.find((o) => o['Врач'] === 'Доктор Д.') || {};
  const napr = sal.find((o) => o['Врач'] === 'Направляев Н.') || {};
  return {
    fee,
    referral,
    revenue: sum(rev, 'После скидки'),
    revenueFee: sum(rev, 'Доля врача'),
    byServices: round2(sum(svc, 'Сумма') - sum(svc, 'Скидка')),
    byServicesFee: sum(svc, 'Доля врача'),
    salaryFee: Number(doc['Доля врача (гонорар)']) || 0,
    salaryReferral: Number(napr['Вознаграждение за направления']) || 0,
  };
}
const invoiceTotals = (db) => round2(db.prepare("SELECT COALESCE(SUM(total_amount), 0) s FROM invoices WHERE status NOT IN ('void','refunded')").get().s);

// Сумма строк после скидки по счёту — тем же отчётом, что читает бухгалтер.
function linesAfterDiscount(c, invoiceNumber) {
  const rev = objects(runReport(c.db, { kind: 'total_revenue', ...c.rng }, admin)).filter((o) => o['№ счёта'] === invoiceNumber);
  return sum(rev, 'После скидки');
}

test('C1: счёт из одних строк пакета — скидка после продажи уменьшает долю врача, вознаграждение и выручку', () => {
  const c = clinic();
  const { invoice } = c.bill([c.line(1, true), c.line(2, true)]);
  assert.equal(invoice.total_amount, 160000);
  const p = c.pay(invoice);
  const before = money(c);
  assert.equal(before.fee, 48000);
  assert.equal(before.referral, 16000);
  refundPayment(c.db, { payment_id: p, amount: 40000, reason: 'уступка' }, admin);
  const inv = c.db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoice.id);
  assert.equal(inv.total_amount, 120000);
  assert.equal(inv.status, 'paid');
  const m = money(c);
  assert.equal(m.fee, 36000, 'врачу — 30 % от 120 000, а не прежние 48 000');
  assert.equal(m.referral, 12000, 'направившему — 10 % от 120 000');
  assert.equal(m.revenue, 120000, '«После скидки» = сумма счёта');
  assert.equal(m.revenueFee, 36000);
  assert.equal(m.byServices, 120000);
  assert.equal(m.byServicesFee, 36000);
  assert.equal(m.salaryFee, 36000);
  assert.equal(m.salaryReferral, 12000);
  assert.equal(linesAfterDiscount(c, inv.invoice_number), inv.total_amount, 'сумма строк после скидки = сумма счёта');
});

test('C1: смешанный счёт (пакет + обычная строка) — скидка после продажи делится пропорционально, ничего не теряется', () => {
  const c = clinic();
  const { invoice } = c.bill([c.line(1, true), c.line(3, false)]);
  assert.equal(invoice.total_amount, 130000);   // 80 000 + 50 000
  const p = c.pay(invoice);
  assert.equal(money(c).fee, 39000);
  refundPayment(c.db, { payment_id: p, amount: 60000, reason: 'уступка' }, admin);
  const m = money(c);
  assert.equal(m.fee, 21000, '30 % от 70 000 — пропорционально (−18 000), а не −15 000');
  assert.equal(m.referral, 7000);
  assert.equal(m.revenue, 70000);
  assert.equal(m.byServices, 70000);
  assert.equal(m.salaryFee, 21000);
  assert.equal(m.revenue, invoiceTotals(c.db), '«После скидки» = суммы счетов');
  const rev = objects(runReport(c.db, { kind: 'total_revenue', ...c.rng }, admin));
  assert.equal(round2(rev.find((o) => o['Услуга'] === 'Анализ')['После скидки']), round2(50000 * 70000 / 130000),
    'обычная строка несёт свою долю уступки, а не всю');
  assert.equal(round2(rev.find((o) => o['Услуга'] === 'УЗИ')['После скидки']), round2(80000 * 70000 / 130000),
    'строка пакета — тоже');
});

test('C1: скидка после продажи = возврат «с доплатой» — у процента и у фикса врача, у процента и фикса направившего', () => {
  // Врач: УЗИ — фикс 10 000, анализ — 30 %. Направившему: фикс 5 000 за УЗИ.
  const rates = [{ service_id: 1, fix: 10000 }, { service_id: 3, pct: 30 }];
  const refRates = JSON.stringify([{ group: 'imaging', unit: 'fix', value: 5000 }]);
  const run = (reopen) => {
    const c = clinic({ rates, refRates });
    const { invoice } = c.bill([c.line(1, true), c.line(3, false)]);   // 80 000 + 50 000
    const p = c.pay(invoice);
    refundPayment(c.db, { payment_id: p, amount: 32500, reason: 'уступка', ...(reopen ? { reopen_balance: true } : {}) }, admin);
    return money(c);
  };
  const reopen = run(true);
  const post = run(false);
  // Оставшиеся деньги — 75 %: врачу (10 000 + 15 000) × 0,75.
  assert.equal(reopen.fee, 18750);
  assert.equal(post.fee, reopen.fee, 'фикс врача уменьшается так же, как при возврате с доплатой');
  assert.equal(post.salaryFee, reopen.salaryFee);
  assert.equal(post.referral, reopen.referral, 'фикс и процент направившего — так же');
  assert.equal(post.salaryReferral, reopen.salaryReferral);
});

test('C1: возврат строки после скидки после продажи возвращает её долю, а не прежнюю сумму', () => {
  const c = clinic();
  const { invoice, items } = c.bill([c.line(1, true), c.line(2, true)]);
  const p = c.pay(invoice);
  refundPayment(c.db, { payment_id: p, amount: 40000, reason: 'уступка' }, admin);
  const r = refundInvoiceLine(c.db, { invoice_item_id: items[0].id, reason: 'отказ' }, admin);
  assert.equal(r.refunded, 60000, 'строка 80 000 после уступки 25 % стоит 60 000');
  const inv = c.db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoice.id);
  assert.equal(inv.total_amount, 60000);
  assert.equal(inv.paid_amount, 60000);
  assert.equal(linesAfterDiscount(c, inv.invoice_number), 60000);
  assert.equal(money(c).fee, 18000, '30 % от оставшихся 60 000');
});

// ─── СТАЦИОНАР: ВОЗВРАТ НА КОЙКЕ И ПОСЛЕ ВЫПИСКИ — ОДНИ ДЕНЬГИ ──────────────

function inpatient(status) {
  const db = openDb(':memory:');
  migrate(db);
  const day = today(db);
  const rng = { from: day.slice(0, 7) + '-01', to: day };
  const u = db.prepare(`INSERT INTO users (id, username, password_hash, role, full_name, is_doctor, service_rates, inpatient_rates)
                        VALUES (?,?,?,?,?,?,?,?)`);
  u.run(1, 'doc', 'x', 'doctor', 'Доктор Д.', 1, '', JSON.stringify([{ service_id: 1, fix: 10000 }, { service_id: 2, pct: 5 }]));
  u.run(9, 'adm', 'x', 'admin', 'Администратор', 0, '', '');
  db.prepare("INSERT INTO services (id, name, price, tax_rate, type) VALUES (1,'Массаж',80000,0,'procedure')").run();
  db.prepare("INSERT INTO services (id, name, price, tax_rate, type) VALUES (2,'Рентген',120000,0,'imaging')").run();
  const cat = db.prepare("INSERT INTO referral_source_categories (name, standard_percent) VALUES ('Партнёры', 0)").run().lastInsertRowid;
  const partner = db.prepare(`INSERT INTO referral_sources (name, code, category_id, reward_mode, own_percent, own_rates,
                                inpatient_bonus_enabled, inpatient_pct, inpatient_fixed)
                              VALUES ('Клиника Х', 'KX', ?, 'own', 0, '[]', 1, 10, 50000)`).run(cat).lastInsertRowid;
  db.prepare("INSERT INTO patients (id, mrn, full_name) VALUES (1, 'P-1', 'Пациент')").run();
  db.prepare(`INSERT INTO admissions (id, admission_no, patient_id, doctor_id, status, referral_source_id)
              VALUES (1, 'A-1', 1, 1, 'active', ?)`).run(partner);
  const at = day + 'T09:00:00Z';
  const ins = db.prepare(`INSERT INTO admission_services (id, admission_id, service_id, doctor_id, performer_id, quantity, unit_price, total, status, billable, performed_at, notes)
                          VALUES (?, 1, ?, 1, 1, ?, ?, ?, 'added', 1, ?, ?)`);
  ins.run(1, 1, 1, 80000, 80000, at, null);
  ins.run(2, 2, 1, 120000, 120000, at, null);
  ins.run(3, null, 2, 200000, 400000, at, 'ACCOMMODATION:bed');
  const { invoice } = createInvoiceForAdmission(db, { admission_id: 1, admission_service_ids: [1, 2, 3] }, admin);
  recordPayment(db, { invoice_id: invoice.id, amount: invoice.total_amount, method: 'cash' }, admin);
  const p = db.prepare('SELECT id FROM payments WHERE invoice_id = ? AND amount > 0').get(invoice.id).id;
  db.prepare('UPDATE admissions SET status = ? WHERE id = 1').run(status);
  refundPayment(db, { payment_id: p, amount: 150000, reason: 'часть' }, admin);
  const inRef = objects(runReport(db, { kind: 'referrals', ...rng }, admin)).filter((o) => o['Где'] === 'Стационар');
  return {
    total: db.prepare('SELECT total_amount t FROM invoices WHERE id = ?').get(invoice.id).t,
    fee: doctorPaySummary(db, { doctor_id: 1, ...rng }, admin).inpatient.fee,
    referral: sum(inRef, 'Вознаграждение'),
  };
}

test('C1: стационар — возврат после выписки даёт те же долю врача и вознаграждение, что возврат на койке', () => {
  const inBed = inpatient('active');
  const after = inpatient('discharged');
  assert.equal(inBed.total, 600000, 'на койке счёт ждёт доплаты');
  assert.equal(after.total, 450000, 'после выписки — скидка после продажи');
  assert.equal(inBed.fee, 12000, '(10 000 + 6 000) × 0,75');
  assert.equal(after.fee, inBed.fee, 'фикс врача — та же доля');
  assert.equal(inBed.referral, 82500, '(60 000 + 50 000) × 0,75');
  assert.equal(after.referral, inBed.referral, 'фикс вознаграждения — та же доля');
});

// ─── I2. ЗАКРЫТЫЙ МЕСЯЦ: ПРАВКА НАЛОГА УСЛУГИ ЕГО НЕ ПЕРЕОЦЕНИВАЕТ ──────────
//
// Запись закрытого месяца хранит налог строки; корректировка пересчитывает
// строку по ставкам месяца (payFeeAtMonthRate), но сумму после налога брала
// живую — а налог отчёт читает из services.tax_rate сегодня. Налог 12 % → 0 %
// давал корректировку +12 % доли по каждой строке месяца. Теперь у записанной
// строки налог — её записанная доля (tax / (сумма − скидка)), приложенная к
// сегодняшней сумме после скидки.
function taxClinic() {
  const db = openDb(':memory:');
  migrate(db);
  const cur = today(db).slice(0, 7);
  let y = Number(cur.slice(0, 4)); let m = Number(cur.slice(5, 7)) - 1;
  if (m < 1) { m = 12; y -= 1; }
  const prev = y + '-' + String(m).padStart(2, '0');
  const lastDay = (mm) => mm + '-' + String(new Date(Date.UTC(Number(mm.slice(0, 4)), Number(mm.slice(5, 7)), 0)).getUTCDate()).padStart(2, '0');
  const u = db.prepare(`INSERT INTO users (id, username, password_hash, role, full_name, is_doctor, service_rates, inpatient_rates, service_rate_default)
                        VALUES (?,?,?,?,?,?,?,?,0)`);
  u.run(1, 'doc', 'x', 'doctor', 'Доктор Д.', 1, JSON.stringify([{ service_id: 1, pct: 30 }]), JSON.stringify([{ service_id: 1, pct: 10 }]));
  u.run(9, 'adm', 'x', 'admin', 'Администратор', 0, '', '');
  db.prepare("INSERT INTO services (id, name, price, tax_rate, type) VALUES (1,'Процедура',100000,12,'procedure')").run();
  db.prepare("INSERT INTO patients (id, mrn, full_name) VALUES (1, 'P-1', 'Пациент')").run();
  const at = prev + '-10T09:00:00Z';
  // Амбулаторная строка со счётом.
  db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (1, 1, ?, 'scheduled')").run(at);
  db.prepare(`INSERT INTO visit_services (id, visit_id, service_id, doctor_id, quantity, unit_price, total, status)
              VALUES (1, 1, 1, 1, 1, 100000, 100000, 'completed')`).run();
  const out = createInvoiceForVisit(db, { visit_id: 1, visit_service_ids: [1] }, admin).invoice;
  db.prepare('UPDATE invoices SET created_at = ? WHERE id = ?').run(at, out.id);
  recordPayment(db, { invoice_id: out.id, amount: out.total_amount, method: 'cash' }, admin);
  // Строка стационара со счётом.
  db.prepare(`INSERT INTO admissions (id, admission_no, patient_id, doctor_id, status) VALUES (1, 'A-1', 1, 1, 'discharged')`).run();
  db.prepare(`INSERT INTO admission_services (id, admission_id, service_id, doctor_id, performer_id, quantity, unit_price, total, status, billable, performed_at)
              VALUES (1, 1, 1, 1, 1, 1, 100000, 100000, 'added', 1, ?)`).run(at);
  const inp = createInvoiceForAdmission(db, { admission_id: 1, admission_service_ids: [1] }, admin).invoice;
  db.prepare('UPDATE invoices SET created_at = ? WHERE id = ?').run(at, inp.id);
  recordPayment(db, { invoice_id: inp.id, amount: inp.total_amount, method: 'cash' }, admin);
  const payId = (inv) => db.prepare('SELECT id FROM payments WHERE invoice_id = ? AND amount > 0').get(inv.id).id;
  return { db, prev, cur: { from: cur + '-01', to: lastDay(cur) }, prevRange: { from: prev + '-01', to: lastDay(prev) }, out, inp, payId };
}

test('I2: закрытый месяц с налогом 12 % — налог сняли (0 %), корректировок нет ни по амбулатории, ни по стационару', () => {
  const t = taxClinic();
  const cab = (rng) => doctorPaySummary(t.db, { doctor_id: 1, ...rng }, admin);
  assert.equal(cab(t.prevRange).outpatient.fee, 26400, '30 % от 88 000');
  assert.equal(cab(t.prevRange).inpatient.fee, 8800, '10 % от 88 000');
  payPeriodClose(t.db, { month: t.prev }, admin);
  t.db.prepare('UPDATE services SET tax_rate = 0 WHERE id = 1').run();
  const adj = cab(t.cur).adjustments;
  assert.equal(adj.count, 0, JSON.stringify(adj.rows));
  assert.equal(adj.fee, 0);
});

test('I2: после смены налога поздний возврат по закрытому месяцу корректирует по налогу месяца', () => {
  const t = taxClinic();
  payPeriodClose(t.db, { month: t.prev }, admin);
  t.db.prepare('UPDATE services SET tax_rate = 0 WHERE id = 1').run();
  refundPayment(t.db, { payment_id: t.payId(t.out), amount: 25000, reason: 'после закрытия', reopen_balance: true }, admin);
  const adj = doctorPaySummary(t.db, { doctor_id: 1, ...t.cur }, admin).adjustments;
  assert.equal(adj.count, 1);
  assert.equal(adj.fee, -6600, '−25 % от 26 400 (налог месяца 12 %), а не 30 000 × 0,75 − 26 400');
});
