// V3120_FINAL — финальная проверка стационара (2026-09-28).
//
//   I4  дату поступления сдвинули ПОЗЖЕ — открытая (ещё не выставленная)
//       строка проживания пересчитывается, а не уходит в счёт устаревшей;
//   M2  выписка задним числом раньше уже выставленных суток — отказ «лишних N»,
//       открытые сутки ужимаются до времени выписки;
//   m1  дату поступления выписанного пациента правит только администратор;
//   m2  после полного возврата и отмены счёта отпущенные строки не «к оплате»
//       ни на обзоре, ни в акте, ни в остатке — как у кассы и журнала;
//   m3  акт показывает скидку счёта (в том числе «после продажи»): акт = счёт.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { billAccommodation } from './accommodation.js';
import { setAdmissionDate } from './admission-date.js';
import { generateAdmissionBill } from './admission-bill.js';
import { admissionDischargeFinalize, admissionPrepareWalletPayment, admissionBalance } from './inpatient.js';
import { createInvoiceForAdmission, recordPayment, refundPayment } from './billing.js';
import { admissionOverview } from './case-overview.js';
import { admissionCharges } from './admission-charges.js';
import { admissionsRegister } from './admissions-register.js';

const H = 3600000;
const NURSE = { id: 2, role: 'nurse', full_name: 'Медсестра' };
const SENIOR = { id: 5, role: 'nurse', extra_roles: ['senior_nurse'], full_name: 'Старшая' };
const ADMIN = { id: 1, role: 'admin', full_name: 'Админ' };
const CASH = { id: 9, role: 'cashier', full_name: 'Касса' };
const iso = (ms) => new Date(ms).toISOString().slice(0, 19) + 'Z';

function seed() {
  const db = openDb(':memory:'); migrate(db);
  const u = db.prepare('INSERT INTO users (id,username,password_hash,role,full_name) VALUES (?,?,?,?,?)');
  u.run(1, 'a', 'x', 'admin', 'Админ');
  u.run(2, 'n', 'x', 'nurse', 'Медсестра');
  u.run(3, 'd', 'x', 'doctor', 'Врач');
  u.run(5, 's', 'x', 'nurse', 'Старшая');
  u.run(9, 'c', 'x', 'cashier', 'Касса');
  const pid = db.prepare("INSERT INTO patients (full_name) VALUES ('Пациент')").run().lastInsertRowid;
  const w = db.prepare("INSERT INTO wards (name, billing_mode, price_per_day) VALUES ('Общая','daily',200000)").run().lastInsertRowid;
  const bed = db.prepare("INSERT INTO beds (ward_id, code, status) VALUES (?,?,'occupied')").run(w, 'A1').lastInsertRowid;
  return { db, pid, w, bed };
}
function stay(ctx, startMs, status = 'active') {
  return ctx.db.prepare(`INSERT INTO admissions (patient_id, ward_id, bed_id, doctor_id, attending_doctor_id, status, admitted_at)
                         VALUES (?,?,?,3,3,?,?)`).run(ctx.pid, ctx.w, ctx.bed, status, iso(startMs)).lastInsertRowid;
}
const accLines = (db, id) => db.prepare("SELECT * FROM admission_services WHERE admission_id = ? AND notes LIKE 'ACCOMMODATION%' ORDER BY id").all(id);
const invoiceAndPay = (db, id, lineIds) => {
  const { invoice } = createInvoiceForAdmission(db, { admission_id: id, admission_service_ids: lineIds }, CASH);
  recordPayment(db, { invoice_id: invoice.id, amount: invoice.total_amount, method: 'cash' }, CASH);
  return invoice;
};
/** Первые сутки выставлены и оплачены, сутки спустя вторые внесены открытой строкой. */
function dayOnePaidDayTwoOpen(ctx) {
  const now = Date.now();
  const id = stay(ctx, now - 25 * H);
  const first = billAccommodation(ctx.db, { admission_id: id }, NURSE).line;
  invoiceAndPay(ctx.db, id, [first.id]);
  ctx.db.prepare('UPDATE admissions SET admitted_at = ? WHERE id = ?').run(iso(now - 49 * H), id);   // прошли сутки
  const open = billAccommodation(ctx.db, { admission_id: id }, NURSE).line;
  assert.equal(open.quantity, 1);
  assert.equal(open.total, 200000);
  return { id, now };
}

// ─── I4 ─────────────────────────────────────────────────────────────────────

test('I4: дата сдвинута позже — открытая строка проживания снимается, в счёт уходят только настоящие сутки', () => {
  const ctx = seed();
  const { id, now } = dayOnePaidDayTwoOpen(ctx);
  setAdmissionDate(ctx.db, { admission_id: id, admitted_at: iso(now - 30 * H) }, NURSE);   // срок теперь 1 сут.
  assert.equal(accLines(ctx.db, id).filter((l) => !l.invoice_item_id).length, 0, 'устаревшие открытые сутки убраны');
  assert.equal(admissionBalance(ctx.db, id).balance, 0);
  const bill = generateAdmissionBill(ctx.db, id, ADMIN);
  assert.equal(bill, null, 'выставлять нечего — сутки уже оплачены');
  ctx.db.close();
});

test('I4: открытая строка без правки даты (срок сократился иначе) не выставляется устаревшей — счёт при выписке, касса, долг', () => {
  for (const path of ['bill', 'wallet', 'debt']) {
    const ctx = seed();
    const { id, now } = dayOnePaidDayTwoOpen(ctx);
    // Старая дата правится прямо в базе (как будто правка прошла до исправления).
    ctx.db.prepare('UPDATE admissions SET admitted_at = ? WHERE id = ?').run(iso(now - 30 * H), id);
    if (path === 'bill') {
      generateAdmissionBill(ctx.db, id, ADMIN);
    } else if (path === 'wallet') {
      admissionPrepareWalletPayment(ctx.db, { admission_id: id }, CASH);
    } else {
      ctx.db.prepare("UPDATE admissions SET status = 'discharging', discharge_outcome = 'home', discharge_requested_by = 3, discharge_requested_at = ? WHERE id = ?").run(iso(now), id);
      ctx.db.prepare("INSERT INTO admission_services (admission_id, quantity, unit_price, total, billable, notes) VALUES (?,1,50000,50000,1,'услуга')").run(id);
      admissionDischargeFinalize(ctx.db, { admission_id: id, debt_ack: true }, SENIOR);
    }
    const stayInvoiced = ctx.db.prepare(`SELECT COALESCE(SUM(ii.total),0) s FROM admission_services s
      JOIN invoice_items ii ON ii.id = s.invoice_item_id WHERE s.admission_id = ? AND s.notes LIKE 'ACCOMMODATION%'`).get(id).s;
    assert.equal(stayInvoiced, 200000, path + ': выставлены только одни сутки, а не 400 000');
    ctx.db.close();
  }
});

test('I4: сдвиг раньше обновляет открытую строку до нового срока, но сам строку не заводит', () => {
  const ctx = seed();
  const now = Date.now();
  const id = stay(ctx, now - 25 * H);
  setAdmissionDate(ctx.db, { admission_id: id, admitted_at: iso(now - 50 * H) }, NURSE);
  assert.equal(accLines(ctx.db, id).length, 0, 'не внесли — не выставили');
  billAccommodation(ctx.db, { admission_id: id }, NURSE);
  setAdmissionDate(ctx.db, { admission_id: id, admitted_at: iso(now - 74 * H) }, NURSE);
  const [line] = accLines(ctx.db, id);
  assert.equal(line.quantity, 3);
  assert.equal(line.total, 600000);
  ctx.db.close();
});

// ─── M2 ─────────────────────────────────────────────────────────────────────

test('M2: выписка задним числом раньше выставленных суток — отказ «лишних 1»', () => {
  const ctx = seed();
  const now = Date.now();
  const start = now - 49 * H;
  const id = stay(ctx, start, 'discharging');
  ctx.db.prepare("UPDATE admissions SET discharge_outcome = 'home', discharge_requested_by = 3, discharge_requested_at = ? WHERE id = ?").run(iso(now), id);
  const prep = admissionPrepareWalletPayment(ctx.db, { admission_id: id }, CASH);
  assert.equal(prep.invoices[0].balance, 400000);
  recordPayment(ctx.db, { invoice_id: prep.invoices[0].id, amount: 400000, method: 'cash' }, CASH);
  let err = null;
  try { admissionDischargeFinalize(ctx.db, { admission_id: id, at: iso(start + 47 * H) }, SENIOR); } catch (e) { err = e; }
  assert.ok(err, 'выписка за 47 ч при оплаченных 2 сутках прошла молча');
  assert.equal(err.status, 400);
  assert.match(err.message, /лишних 1/);
  assert.match(err.message, /касс/);
  assert.equal(ctx.db.prepare('SELECT status FROM admissions WHERE id = ?').get(id).status, 'discharging');
  // Время не раньше выставленного — проходит.
  const ok = admissionDischargeFinalize(ctx.db, { admission_id: id, at: iso(start + 48 * H) }, SENIOR);
  assert.equal(ok.admission.status, 'discharged');
  ctx.db.close();
});

test('M2: открытые сутки ужимаются до времени выписки — долг под подписью за 1 сутки, а не 2', () => {
  const ctx = seed();
  const now = Date.now();
  const start = now - 49 * H;
  const id = stay(ctx, start, 'discharging');
  ctx.db.prepare("UPDATE admissions SET discharge_outcome = 'home', discharge_requested_by = 3, discharge_requested_at = ? WHERE id = ?").run(iso(now), id);
  billAccommodation(ctx.db, { admission_id: id }, NURSE);   // 2 сут. открытой строкой
  const at = iso(start + 47 * H);
  assert.throws(() => admissionDischargeFinalize(ctx.db, { admission_id: id, at }, SENIOR), /остаток — 200000/);
  const res = admissionDischargeFinalize(ctx.db, { admission_id: id, at, debt_ack: true }, SENIOR);
  assert.equal(res.admission.discharge_debt_amount, 200000);
  const [line] = accLines(ctx.db, id);
  assert.equal(line.quantity, 1);
  ctx.db.close();
});

// ─── m1 ─────────────────────────────────────────────────────────────────────

test('m1: дату поступления выписанного пациента правит только администратор', () => {
  const ctx = seed();
  const now = Date.now();
  const id = stay(ctx, now - 30 * H, 'discharged');
  ctx.db.prepare('UPDATE admissions SET discharged_at = ? WHERE id = ?').run(iso(now - 2 * H), id);
  assert.throws(() => setAdmissionDate(ctx.db, { admission_id: id, admitted_at: iso(now - 80 * H) }, NURSE),
    (e) => e.status === 403 && /выписан/.test(e.message));
  const r = setAdmissionDate(ctx.db, { admission_id: id, admitted_at: iso(now - 80 * H) }, ADMIN);
  assert.equal(r.admission.admitted_at, iso(now - 80 * H));
  ctx.db.close();
});

// ─── m2 ─────────────────────────────────────────────────────────────────────

test('m2: после полного возврата и отмены счёта обзор, акт и журнал говорят одно — к оплате 0', () => {
  const ctx = seed();
  const now = Date.now();
  const id = stay(ctx, now - 49 * H);
  const acc = billAccommodation(ctx.db, { admission_id: id }, NURSE).line;   // 400 000
  const svc = ctx.db.prepare("INSERT INTO admission_services (admission_id, quantity, unit_price, total, billable, status, notes) VALUES (?,1,80000,80000,1,'completed','услуга')").run(id).lastInsertRowid;
  const inv = invoiceAndPay(ctx.db, id, [acc.id, svc]);
  assert.equal(inv.total_amount, 480000);
  ctx.db.prepare("UPDATE admissions SET status = 'discharged', discharged_at = ? WHERE id = ?").run(iso(now), id);
  const pay = ctx.db.prepare('SELECT id FROM payments WHERE invoice_id = ? AND amount > 0').get(inv.id).id;
  const r = refundPayment(ctx.db, { payment_id: pay, void_when_zero: true }, CASH);
  assert.equal(r.voided, true);

  assert.equal(admissionBalance(ctx.db, id).balance, 0, 'остаток госпитализации');
  const ov = admissionOverview(ctx.db, { admission_id: id }, ADMIN);
  assert.equal(ov.bill.debt, 0, 'обзор');
  assert.equal(ov.bill.unbilled, 0);
  const act = admissionCharges(ctx.db, { admission_id: id }, ADMIN);
  assert.equal(act.totals.pending, 0, 'акт: к выставлению');
  assert.equal(act.totals.refunded, 480000, 'акт называет возвращённое');
  const reg = admissionsRegister(ctx.db, {}, ADMIN).rows.find((x) => x.id === id);
  assert.equal(reg.balance, 0, 'журнал');
  // Проживание не выставляется заново кнопкой: возвращённые сутки — не «новые».
  assert.throws(() => billAccommodation(ctx.db, { admission_id: id }, NURSE), /уже выставлено/);
  ctx.db.close();
});

// ─── m3 ─────────────────────────────────────────────────────────────────────

test('m3: акт показывает скидку после продажи — итог акта равен счёту', () => {
  const ctx = seed();
  const now = Date.now();
  const id = stay(ctx, now - 73 * H);
  const acc = billAccommodation(ctx.db, { admission_id: id }, NURSE).line;   // 600 000
  const inv = invoiceAndPay(ctx.db, id, [acc.id]);
  ctx.db.prepare("UPDATE admissions SET status = 'discharged', discharged_at = ? WHERE id = ?").run(iso(now), id);
  const pay = ctx.db.prepare('SELECT id FROM payments WHERE invoice_id = ? AND amount > 0').get(inv.id).id;
  const r = refundPayment(ctx.db, { payment_id: pay, amount: 150000 }, CASH);
  assert.equal(r.post_sale_discount, 150000);
  const act = admissionCharges(ctx.db, { admission_id: id }, ADMIN);
  assert.equal(act.totals.accrued, 600000);
  assert.equal(act.totals.discount, 150000);
  assert.equal(act.totals.due, 450000, 'акт = счёт');
  ctx.db.close();
});
