// V3120_FIX — стационар и сводка после осмотра 2026-09-27 (d-inpatient).
//
// Что утверждается — поведением на настоящей SQLite, а не формой ответа:
//   • сутки при переводах оцениваются по койке, где пациент провёл большую
//     часть этих суток (20 минут в VIP не стоят VIP-суток, ночь в VIP не
//     бесплатна); число суток — прежнее max(1, floor(часы/24));
//   • дату поступления нельзя сдвинуть позже, если выставленных суток станет
//     больше, чем сам срок;
//   • выписка с долгом доначисляет проживание до времени выписки, и долг под
//     подписью его включает; очередь выписки показывает пропажу и баланс
//     депозита; касса может оплатить с баланса;
//   • выключенный вид записи называется выключенным, а не «неизвестным».
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { billAccommodation, accommodationState } from './accommodation.js';
import { setAdmissionDate } from './admission-date.js';
import { admissionDischargeFinalize, admissionDischargeQueue, admissionPrepareWalletPayment, dischargePatient } from './inpatient.js';
import { createInvoiceForAdmission, recordPayment } from './billing.js';
import { admissionReviewSave } from './inpatient-reviews.js';

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
  u.run(7, 'l', 'x', 'lab', 'Лаборант');
  u.run(9, 'c', 'x', 'cashier', 'Касса');
  const pid = db.prepare("INSERT INTO patients (full_name) VALUES ('Пациент')").run().lastInsertRowid;
  const wA = db.prepare("INSERT INTO wards (name, billing_mode, price_per_day) VALUES ('Общая','daily',100000)").run().lastInsertRowid;
  const wV = db.prepare("INSERT INTO wards (name, billing_mode, price_per_day) VALUES ('VIP','daily',500000)").run().lastInsertRowid;
  const bed = (w, code) => db.prepare("INSERT INTO beds (ward_id, code, status) VALUES (?,?,'free')").run(w, code).lastInsertRowid;
  return { db, pid, wA, wV, A1: bed(wA, 'A1'), A2: bed(wA, 'A2'), V1: bed(wV, 'V1') };
}

/** Пациент лежит с `startMs`; moves — [[время, койка, палата], …]. */
function stay(ctx, startMs, firstBed, firstWard, moves = [], status = 'active') {
  const { db, pid } = ctx;
  const last = moves.length ? moves[moves.length - 1] : [null, firstBed, firstWard];
  const id = db.prepare(`INSERT INTO admissions (patient_id, ward_id, bed_id, doctor_id, attending_doctor_id, status, admitted_at)
                         VALUES (?,?,?,3,3,?,?)`).run(pid, last[2], last[1], status, iso(startMs)).lastInsertRowid;
  let fromBed = firstBed, fromWard = firstWard;
  for (const [t, b, w] of moves) {
    db.prepare(`INSERT INTO admission_transfers (admission_id, from_bed_id, to_bed_id, from_ward_id, to_ward_id, kind, transferred_at)
                VALUES (?,?,?,?,?,'transfer',?)`).run(id, fromBed, b, fromWard, w, iso(t));
    fromBed = b; fromWard = w;
  }
  return id;
}

// ─── 1. Сутки по койке, где прошла большая их часть ─────────────────────────

test('ночь в VIP не бесплатна: 8 ч общая → 12 ч VIP → 5 ч общая = одни сутки по VIP', () => {
  const ctx = seed();
  const s = Date.now() - 25 * H;
  const id = stay(ctx, s, ctx.A1, ctx.wA, [[s + 8 * H, ctx.V1, ctx.wV], [s + 20 * H, ctx.A2, ctx.wA]]);
  const { line } = billAccommodation(ctx.db, { admission_id: id }, NURSE);
  assert.equal(line.quantity, 1, 'сутки — floor(25/24) = 1');
  assert.equal(line.total, 500000, 'из первых 24 ч двенадцать — в VIP');
  ctx.db.close();
});

test('20 минут в VIP через отметку суток не стоят VIP-суток', () => {
  const ctx = seed();
  const s = Date.now() - 49 * H;
  const at = (h, m = 0) => s + h * H + m * 60000;
  const id = stay(ctx, s, ctx.A1, ctx.wA, [[at(23, 50), ctx.V1, ctx.wV], [at(24, 10), ctx.A2, ctx.wA]]);
  const { line } = billAccommodation(ctx.db, { admission_id: id }, NURSE);
  assert.equal(line.quantity, 2);
  assert.equal(line.total, 200000, 'было 600 000: вторые сутки целиком по VIP');
  ctx.db.close();
});

test('поровну — сутки по койке, на которой пациент был позже', () => {
  const ctx = seed();
  const s = Date.now() - 25 * H;
  const id = stay(ctx, s, ctx.A1, ctx.wA, [[s + 12 * H, ctx.V1, ctx.wV]]);
  const st = accommodationState(ctx.db, { admission_id: id }, NURSE);
  assert.equal(st.stay_units, 1);
  assert.equal(st.current.net, 500000);
  ctx.db.close();
});

test('число суток прежнее: 3 сут. 5 ч с переводом — трое суток, каждые по своей койке', () => {
  const ctx = seed();
  const s = Date.now() - (3 * 24 + 5) * H;
  const id = stay(ctx, s, ctx.A1, ctx.wA, [[s + 30 * H, ctx.V1, ctx.wV]]);
  // сутки 0: общая; сутки 1: 6 ч общая, 18 ч VIP → VIP; сутки 2: VIP.
  const st = accommodationState(ctx.db, { admission_id: id }, NURSE);
  assert.equal(st.stay_units, 3);
  assert.equal(st.current.net, 100000 + 500000 + 500000);
  ctx.db.close();
});

test('прямая выписка (v0.8.0) называет сумму тем же правилом, что строка проживания', () => {
  const ctx = seed();
  const s = Date.now() - 49 * H;
  const at = (h, m = 0) => s + h * H + m * 60000;
  const id = stay(ctx, s, ctx.A1, ctx.wA, [[at(23, 50), ctx.V1, ctx.wV], [at(24, 10), ctx.A2, ctx.wA]]);
  ctx.db.prepare("UPDATE admissions SET created_at = '2000-01-01T00:00:00Z' WHERE id = ?").run(id);   // положен до обновления
  const before = accommodationState(ctx.db, { admission_id: id }, NURSE).current;
  const res = dischargePatient(ctx.db, { admission_id: id }, ADMIN);
  assert.equal(res.units, 2);
  assert.equal(res.gross, before.gross, 'ответ выписки и строка проживания — одно число');
  assert.equal(res.gross, 200000);
  ctx.db.close();
});

// ─── 2. Дата поступления позже выставленных суток ───────────────────────────

test('дату поступления нельзя сдвинуть позже, если выставленных суток станет больше срока', () => {
  const ctx = seed();
  const now = Date.now();
  const id = stay(ctx, now - (3 * 24 + 1) * H, ctx.A1, ctx.wA);
  const { line } = billAccommodation(ctx.db, { admission_id: id }, NURSE);
  assert.equal(line.quantity, 3);
  createInvoiceForAdmission(ctx.db, { admission_id: id, admission_service_ids: [line.id] }, CASH);
  const before = ctx.db.prepare('SELECT admitted_at FROM admissions WHERE id = ?').get(id).admitted_at;

  let err = null;
  try { setAdmissionDate(ctx.db, { admission_id: id, admitted_at: iso(now - 30 * H) }, NURSE); } catch (e) { err = e; }
  assert.ok(err, 'правка прошла молча — касса осталась бы с тремя сутками за одни');
  assert.equal(err.status, 400);
  assert.match(err.message, /лишних 2/);
  assert.match(err.message, /касс/);
  assert.equal(ctx.db.prepare('SELECT admitted_at FROM admissions WHERE id = ?').get(id).admitted_at, before, 'дата не сдвинута');
  assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM admission_transfers WHERE admission_id = ? AND kind = 'admitted_at'").get(id).n, 0);

  // Раньше — можно всегда; позже, но не короче выставленного, — тоже.
  setAdmissionDate(ctx.db, { admission_id: id, admitted_at: iso(now - 4 * 24 * H) }, NURSE);
  setAdmissionDate(ctx.db, { admission_id: id, admitted_at: iso(now - (3 * 24 + 2) * H) }, NURSE);
  ctx.db.close();
});

// ─── 3. Выписка с долгом: проживание и депозит ──────────────────────────────

function discharging(ctx, startMs) {
  const id = stay(ctx, startMs, ctx.A1, ctx.wA, [], 'discharging');
  ctx.db.prepare("UPDATE admissions SET discharge_outcome = 'home', discharge_requested_by = 3, discharge_requested_at = ? WHERE id = ?")
    .run(iso(Date.now()), id);
  ctx.db.prepare("INSERT INTO admission_services (admission_id, quantity, unit_price, total, billable, notes) VALUES (?,1,50000,50000,1,'услуга')").run(id);
  return id;
}

test('выписка с долгом: проживание до времени выписки входит в долг под подписью', () => {
  const ctx = seed();
  const now = Date.now();
  const id = discharging(ctx, now - (3 * 24 + 1) * H);
  const at = iso(now - 25 * H);   // выписан сутки назад: срок 2 сут. 0 ч → 2 сут.

  const q = admissionDischargeQueue(ctx.db, {}, SENIOR).rows.find((r) => r.admission_id === id);
  assert.equal(q.balance.balance, 50000);
  assert.equal(q.accommodation_gap.units, 3, 'окно видит пропажу по «сейчас»');
  assert.equal(q.accommodation_gap.amount, 300000);

  let err = null;
  try { admissionDischargeFinalize(ctx.db, { admission_id: id, at }, SENIOR); } catch (e) { err = e; }
  assert.ok(err);
  assert.match(err.message, /250000/, 'сумма под подписью включает проживание: ' + err.message);
  assert.match(err.message, /проживание/);

  const res = admissionDischargeFinalize(ctx.db, { admission_id: id, at, debt_ack: true }, SENIOR);
  assert.equal(res.admission.discharge_debt_amount, 250000);
  const acc = ctx.db.prepare("SELECT * FROM admission_services WHERE admission_id = ? AND notes LIKE 'ACCOMMODATION%'").get(id);
  assert.equal(acc.quantity, 2, 'проживание — до времени выписки, а не до «сейчас»');
  assert.ok(acc.invoice_item_id, 'и собрано в счёт-долг');
  const debt = ctx.db.prepare("SELECT COALESCE(SUM(total_amount - paid_amount),0) s FROM invoices WHERE admission_id = ? AND status = 'debt'").get(id).s;
  assert.equal(debt, 250000);
  ctx.db.close();
});

test('без долга проживание само не выставляется — окно лишь называет пропажу', () => {
  const ctx = seed();
  const id = stay(ctx, Date.now() - 49 * H, ctx.A1, ctx.wA, [], 'discharging');
  const res = admissionDischargeFinalize(ctx.db, { admission_id: id }, SENIOR);
  assert.equal(res.admission.status, 'discharged');
  assert.equal(ctx.db.prepare('SELECT COUNT(*) n FROM admission_services WHERE admission_id = ?').get(id).n, 0);
  ctx.db.close();
});

test('депозит: очередь и отказ называют баланс, касса оплачивает с баланса — долга нет', () => {
  const ctx = seed();
  const id = discharging(ctx, Date.now() - 25 * H);
  // Строку баланса пишет только сервер (ledger_write_token) — как wallet.js.
  const tok = ctx.db.prepare('INSERT INTO ledger_write_token DEFAULT VALUES').run().lastInsertRowid;
  ctx.db.prepare(`INSERT INTO patient_deposits (patient_id, amount, method, status, kind, created_by)
                  VALUES (?, 1000000, 'cash', 'received', 'deposit', 9)`).run(ctx.pid);
  ctx.db.prepare('DELETE FROM ledger_write_token WHERE id = ?').run(tok);

  const q = admissionDischargeQueue(ctx.db, {}, SENIOR).rows.find((r) => r.admission_id === id);
  assert.equal(q.deposit_balance, 1000000);
  assert.throws(() => admissionDischargeFinalize(ctx.db, { admission_id: id }, SENIOR), /На балансе пациента 1000000/);

  assert.throws(() => admissionPrepareWalletPayment(ctx.db, { admission_id: id }, SENIOR), (e) => e.status === 403);
  const prep = admissionPrepareWalletPayment(ctx.db, { admission_id: id }, CASH);
  assert.equal(prep.deposit_balance, 1000000);
  assert.equal(prep.balance.unbilled, 0, 'всё начисленное собрано в счёт');
  const due = prep.invoices.reduce((n, i) => n + i.balance, 0);
  assert.equal(due, 150000, 'услуга 50 000 + сутки 100 000');
  for (const inv of prep.invoices) recordPayment(ctx.db, { invoice_id: inv.id, amount: inv.balance, method: 'wallet' }, CASH);

  const res = admissionDischargeFinalize(ctx.db, { admission_id: id }, SENIOR);
  assert.equal(res.debt_acknowledged, false, 'оплачено с баланса — подпись под долгом не нужна');
  assert.equal(res.admission.discharge_debt_amount, 0);
  ctx.db.close();
});

// ─── 5. Выключенный вид записи ──────────────────────────────────────────────

test('выключенный в настройках вид записи называется выключенным, а не «неизвестным»', () => {
  const ctx = seed();
  const kind = ctx.db.prepare('SELECT kind FROM case_doc_types ORDER BY id LIMIT 1').get().kind;
  ctx.db.prepare('UPDATE case_doc_types SET active = 0 WHERE kind = ?').run(kind);
  assert.throws(() => admissionReviewSave(ctx.db, { admission_id: 1, kind, body: 'x' }, ADMIN), /выключен в настройках/);
  assert.throws(() => admissionReviewSave(ctx.db, { admission_id: 1, kind: 'nosuch', body: 'x' }, ADMIN), /Неизвестный род записи/);
  ctx.db.close();
});
