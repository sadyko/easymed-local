// PAY_BASIS_PERFORMED_V1 — одна база выплаты врачу: ВЫПОЛНЕННЫЕ услуги.
//
// Владелец (26.09): «Кабинет врача считает амбулаторную выплату по выполненным
// услугам, отчёты — по оплаченным счетам, и суммы расходятся. Какую базу брать
// обоим?» — «Выполненные услуги, как кабинет сейчас», и отчёты переходят на
// неё. Вознаграждение внешних партнёров остаётся по ОПЛАЧЕННЫМ счетам.
//
// Здесь — правило целиком, на отчётах и на RPC кабинета: что считается
// выполненным, по какой цене платит строка без счёта (ровно по той, что потом
// поставит счёт — проверяется НАСТОЯЩИМ create_invoice_for_visit), ставка по
// умолчанию, и что doctor_pay_summary равен «Зарплатам врачей» бит в бит.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { runReport, doctorPaySummary } from './reports.js';
import { createInvoiceForVisit } from './billing.js';
import { RPC } from './index.js';
import { isReadOnlyRpc } from '../control/gate.js';

const admin = { id: 9, role: 'admin' };
const FROM = '2026-09-01';
const TO = '2026-09-30';
const DAY = '2026-09-10T09:00:00Z';

// Клиника: врач 1 «Доктор Д.» — 30 % за приём (id 1); врач 2 «Без ставок» —
// только ставка по умолчанию; приём 100 000 с налогом 6 %.
function clinic() {
  const db = openDb(':memory:');
  migrate(db);
  const u = db.prepare(`INSERT INTO users (id, username, password_hash, role, full_name, is_doctor, service_rates, service_rate_default)
                        VALUES (?,?,?,?,?,1,?,?)`);
  u.run(1, 'doc', 'x', 'doctor', 'Доктор Д.', JSON.stringify([{ service_id: 1, pct: 30 }]), 0);
  u.run(2, 'dflt', 'x', 'doctor', 'Без ставок', '', 0);
  u.run(9, 'adm', 'x', 'admin', 'Администратор', '', 0);
  db.prepare("INSERT INTO patients (id, mrn, full_name) VALUES (1,'P-1','Пациент')").run();
  db.prepare("INSERT INTO services (id, name, price, tax_rate) VALUES (1,'Приём',100000,6)").run();
  let seq = 0;
  // Строка визита; invoice: null — без счёта, 'paid' / 'unpaid' / 'void' —
  // счёт с этим статусом (discount — скидка на счёт).
  const line = ({ status = 'completed', doctor = 1, invoice = null, discount = 0, qty = 1, price = 100000,
                  visitStatus = 'scheduled', at = DAY, tier = null } = {}) => {
    const id = ++seq;
    db.prepare('INSERT INTO visits (id, patient_id, visit_date, status) VALUES (?,1,?,?)').run(id, at, visitStatus);
    db.prepare(`INSERT INTO visit_services (id, visit_id, service_id, doctor_id, quantity, unit_price, total, status, price_tier)
                VALUES (?,?,1,?,?,?,?,?,?)`).run(id, id, doctor, qty, price, price * qty, status, tier);
    if (invoice) {
      const sub = price * qty;
      const total = sub - discount;
      db.prepare(`INSERT INTO invoices (id, invoice_number, visit_id, patient_id, subtotal, discount_amount, total_amount, paid_amount, status, created_at)
                  VALUES (?,?,?,1,?,?,?,?,?,?)`).run(id, 'INV-' + id, id, sub, discount, total, invoice === 'paid' ? total : 0, invoice, at);
      db.prepare(`INSERT INTO invoice_items (id, invoice_id, service_id, description, quantity, unit_price, total)
                  VALUES (?,?,1,'Приём',?,?,?)`).run(id, id, qty, price, sub);
      db.prepare('UPDATE visit_services SET invoice_item_id = ? WHERE id = ?').run(id, id);
    }
    return id;
  };
  return { db, line };
}

const salaries = (db, doctor = 'Доктор Д.') => {
  const r = runReport(db, { kind: 'doctor_salaries', from: FROM, to: TO }, admin);
  const row = r.rows.find((x) => x[r.columns.indexOf('Врач')] === doctor);
  if (!row) return { fee: 0, inFee: 0, count: 0, unbilled: 0 };
  const c = (name) => row[r.columns.indexOf(name)];
  return { fee: c('Доля врача (гонорар)'), inFee: c('Стационар: гонорар'), count: c('Выполненных услуг'), unbilled: c('Из них без счёта') };
};
const summary = (db, doctorId = 1) => doctorPaySummary(db, { doctor_id: doctorId, from: FROM, to: TO }, admin);

// 100 000 − 6 % = 94 000; 30 % = 28 200.
const ONE = 28200;

// ─── 1. ЧТО ВЫПОЛНЕНО ────────────────────────────────────────────────────────

test('выполненная, но не оплаченная и даже не выставленная строка платит врачу', () => {
  const c = clinic();
  c.line({ status: 'completed' });                   // без счёта
  assert.equal(salaries(c.db).fee, ONE);
  assert.equal(salaries(c.db).unbilled, 1);
  assert.equal(summary(c.db).outpatient.fee, ONE);
  assert.equal(summary(c.db).outpatient.unbilled, 1);
});

test('начатые строки (в работе, взят материал, есть результат) — тоже выполненные', () => {
  for (const status of ['in_progress', 'collected', 'resulted']) {
    const c = clinic();
    c.line({ status });
    assert.equal(salaries(c.db).fee, ONE, status);
  }
});

test('добавленная или стоящая в очереди строка — не выполнена и не платит, оплачена она или нет', () => {
  for (const status of ['added', 'queued']) {
    const c = clinic();
    c.line({ status });
    c.line({ status, invoice: 'paid' });
    assert.equal(salaries(c.db).count, 0, status);
    assert.equal(summary(c.db).outpatient.fee, 0, status);
  }
});

test('отменённое не платит: отменённый визит, «не пришёл», возвращённый счёт', () => {
  const c = clinic();
  c.line({ visitStatus: 'cancelled' });
  c.line({ visitStatus: 'no_show' });
  c.line({ invoice: 'refunded' });
  assert.equal(salaries(c.db).count, 0);
  assert.equal(summary(c.db).outpatient.count, 0);
  c.line({});   // живая строка рядом — одна
  assert.equal(salaries(c.db).fee, ONE);
});

// Ревью C1 — отмена СЧЁТА работу не отменяет: выполненная строка, оставшаяся
// привязанной к отменённому счёту (старые данные; касса теперь такую строку
// со счёта отпускает), платит как невыставленная — без скидки отменённого счёта.
test('выполненная строка отменённого счёта платит как невыставленная', () => {
  const c = clinic();
  c.line({ invoice: 'void', discount: 50000 });
  assert.equal(salaries(c.db).count, 1);
  assert.equal(salaries(c.db).unbilled, 1);
  assert.equal(salaries(c.db).fee, ONE);
  assert.equal(summary(c.db).outpatient.fee, ONE);
});

// ─── 2. ДЕНЬГИ СТРОКИ СО СЧЁТОМ — КАК ПРЕЖДЕ ─────────────────────────────────

test('оплаченная строка платит ровно как прежде: скидка счёта, затем налог, затем процент', () => {
  const c = clinic();
  c.line({ invoice: 'paid', discount: 20000 });
  // 100 000 − 20 000 = 80 000; −6 % = 75 200; 30 % = 22 560 (reports.doctor-share.test.js).
  assert.equal(salaries(c.db).fee, 22560);
  assert.equal(summary(c.db).outpatient.fee, 22560);
});

test('выполненная строка неоплаченного счёта платит — с его скидкой и налогом', () => {
  const c = clinic();
  c.line({ invoice: 'unpaid', discount: 20000 });
  assert.equal(salaries(c.db).fee, 22560);
  c.line({ invoice: 'partial' });
  assert.equal(salaries(c.db).fee, 22560 + ONE);
});

// ─── 3. СТРОКА БЕЗ СЧЁТА — ПО ЦЕНЕ СЧЁТА ─────────────────────────────────────

// Сравнение с НАСТОЯЩИМ счётом: сколько платит строка до счёта и сколько — после
// create_invoice_for_visit. Если правило цены у кассы и у выплаты разойдётся,
// доля врача изменится в момент выставления счёта — это и ловится.
function feeBeforeAndAfterInvoice(c, lineId) {
  const before = summary(c.db);
  createInvoiceForVisit(c.db, { visit_id: lineId, visit_service_ids: [lineId] }, admin);
  const after = summary(c.db);
  return { before, after };
}

test('без счёта — цена каталога; после выставления счёта доля не меняется', () => {
  const c = clinic();
  const id = c.line({ price: 55555 });   // на строке визита старая цена — счёт возьмёт каталог
  const { before, after } = feeBeforeAndAfterInvoice(c, id);
  assert.equal(before.outpatient.fee, ONE);
  assert.equal(after.outpatient.fee, before.outpatient.fee);
  assert.equal(after.lines[0].invoiced, true);
  assert.equal(before.lines[0].invoiced, false);
});

test('без счёта — скидка категории пациента, как её поставит счёт', () => {
  const c = clinic();
  const cat = c.db.prepare("INSERT INTO patient_categories (name, discount_percent, active) VALUES ('VIP', 10, 1)").run().lastInsertRowid;
  c.db.prepare('UPDATE patients SET category_id = ? WHERE id = 1').run(cat);
  const id = c.line({});
  const { before, after } = feeBeforeAndAfterInvoice(c, id);
  // 100 000 − 10 % = 90 000; −6 % = 84 600; 30 % = 25 380.
  assert.equal(before.outpatient.fee, 25380);
  assert.equal(after.outpatient.fee, before.outpatient.fee);
  assert.equal(before.lines[0].discount, 10000);
});

test('без счёта — своя цена врача, как её поставит счёт', () => {
  const c = clinic();
  c.db.prepare('UPDATE users SET service_rates = ? WHERE id = 1').run(JSON.stringify([{ service_id: 1, pct: 30, price: 150000 }]));
  const id = c.line({});
  const { before, after } = feeBeforeAndAfterInvoice(c, id);
  assert.equal(before.lines[0].amount, 150000);
  assert.equal(before.outpatient.fee, Math.round(150000 * 0.94 * 0.3 * 100) / 100);
  assert.equal(after.outpatient.fee, before.outpatient.fee);
});

test('без счёта — цена повторного визита (ступень цены на строке), как её поставит счёт', () => {
  const c = clinic();
  c.db.prepare('UPDATE services SET price_secondary = 60000, secondary_days_from = 1, secondary_days_to = 6 WHERE id = 1').run();
  const id = c.line({ tier: 'secondary' });
  const { before, after } = feeBeforeAndAfterInvoice(c, id);
  assert.equal(before.lines[0].amount, 60000);
  assert.equal(before.outpatient.fee, Math.round(60000 * 0.94 * 0.3 * 100) / 100);
  assert.equal(after.outpatient.fee, before.outpatient.fee);
});

test('количество: строка на 3 единицы без счёта — цена × 3, фикс — за единицу', () => {
  const c = clinic();
  c.line({ qty: 3 });
  assert.equal(summary(c.db).outpatient.fee, 3 * ONE);
  c.db.prepare('UPDATE users SET service_rates = ? WHERE id = 1').run(JSON.stringify([{ service_id: 1, pct: 30, fix: 15000 }]));
  assert.equal(summary(c.db).outpatient.fee, 45000);
  assert.equal(salaries(c.db).fee, 45000);
});

// ─── 4. СТАВКА ПО УМОЛЧАНИЮ ──────────────────────────────────────────────────

test('ставки на услугу нет — платится ставка по умолчанию из карточки, и кабинет её видит', () => {
  const c = clinic();
  c.line({ doctor: 2 });
  assert.equal(summary(c.db, 2).outpatient.fee, 0, 'без ставки и без умолчания — 0');
  c.db.prepare('UPDATE users SET service_rate_default = 25 WHERE id = 2').run();
  // 94 000 × 25 % = 23 500.
  assert.equal(summary(c.db, 2).outpatient.fee, 23500);
  assert.equal(salaries(c.db, 'Без ставок').fee, 23500);
  assert.equal(summary(c.db, 2).lines[0].pct, 25);
});

// ─── 5. ДАТА ─────────────────────────────────────────────────────────────────

test('период — по дню визита, а не по дате счёта', () => {
  const c = clinic();
  const id = c.line({ at: '2026-09-10T09:00:00Z', invoice: 'paid' });
  c.db.prepare("UPDATE invoices SET created_at = '2026-10-02T09:00:00Z' WHERE id = ?").run(id);
  assert.equal(salaries(c.db).fee, ONE);
  const oct = doctorPaySummary(c.db, { doctor_id: 1, from: '2026-10-01', to: '2026-10-31' }, admin);
  assert.equal(oct.outpatient.count, 0);
});

// ─── 6. СТУПЕНИ ──────────────────────────────────────────────────────────────

test('ступень считает выполненные строки: оплаченная, но не начатая номера не занимает', () => {
  const c = clinic();
  c.db.prepare('UPDATE services SET tax_rate = 0, doctor_tier_from = 2, doctor_tier_percent = 50 WHERE id = 1').run();
  c.line({ status: 'added', invoice: 'paid' });   // не выполнена — не номер
  c.line({});                                      // №1, без счёта
  c.line({ invoice: 'unpaid' });                   // №2
  c.line({ invoice: 'paid' });                     // №3 — по ступени
  // 30 000 + 30 000 + 50 000
  assert.equal(salaries(c.db).fee, 110000);
  assert.equal(summary(c.db).outpatient.fee, 110000);
  assert.deepEqual(summary(c.db).lines.map((l) => l.tier), [false, false, true]);
});

// ─── 7. ВОЗНАГРАЖДЕНИЕ ЗА НАПРАВЛЕНИЯ — ПО-ПРЕЖНЕМУ ПО ОПЛАТЕ ───────────────

test('вознаграждение за направления остаётся по оплаченным счетам', () => {
  const c = clinic();
  const internalCat = c.db.prepare('SELECT id FROM referral_source_categories WHERE is_internal = 1').get().id;
  c.db.prepare('UPDATE referral_source_categories SET standard_percent = 5 WHERE id = ?').run(internalCat);
  const src = c.db.prepare('SELECT id FROM referral_sources WHERE doctor_id = 2').get().id;
  const done = c.line({ invoice: 'unpaid' });    // выполнена, не оплачена
  const paid = c.line({ invoice: 'paid' });
  c.db.prepare('UPDATE visits SET referral_source_id = ? WHERE id IN (?, ?)').run(src, done, paid);
  const s = summary(c.db, 2);
  // Только оплаченная строка: 100 000 × 5 % = 5 000.
  assert.equal(s.referral.reward, 5000);
  assert.equal(s.referral.count, 2);
  assert.equal(s.total, 5000);
  // Та же сумма в «По врачам»; доля за услуги врача 1 — по выполненному (обе).
  const r = runReport(c.db, { kind: 'by_doctors', from: FROM, to: TO }, admin);
  const row = (name) => r.rows.find((x) => x[r.columns.indexOf('Врач')] === name);
  assert.equal(row('Без ставок')[r.columns.indexOf('Вознаграждение за направления')], 5000);
  assert.equal(row('Доктор Д.')[r.columns.indexOf('Доля за услуги')], 2 * ONE);
  assert.ok(r.notes.includes('Вознаграждение за направления — как и прежде, только по оплаченным счетам.'));
});

// ─── 8. КАБИНЕТ = ОТЧЁТ ──────────────────────────────────────────────────────

test('doctor_pay_summary равен «Зарплатам врачей» во всех случаях', () => {
  const c = clinic();
  const cat = c.db.prepare("INSERT INTO patient_categories (name, discount_percent, active) VALUES ('VIP', 7, 1)").run().lastInsertRowid;
  c.db.prepare('UPDATE patients SET category_id = ? WHERE id = 1').run(cat);
  c.db.prepare('UPDATE users SET service_rate_default = 12.5 WHERE id = 2').run();
  c.db.prepare('UPDATE services SET doctor_tier_from = 3, doctor_tier_percent = 45 WHERE id = 1').run();
  c.line({});
  c.line({ status: 'in_progress', qty: 2 });
  c.line({ invoice: 'paid', discount: 3333 });
  c.line({ invoice: 'unpaid' });
  c.line({ status: 'resulted', invoice: 'partial', discount: 1000 });
  c.line({ status: 'queued', invoice: 'paid' });
  c.line({ invoice: 'void' });
  c.line({ doctor: 2 });
  c.line({ doctor: 2, invoice: 'paid', discount: 500 });
  // Стационар: выполненная строка врача 1 без счёта.
  c.db.prepare("INSERT INTO admissions (id, admission_no, patient_id, doctor_id, status) VALUES (1,'A-1',1,1,'active')").run();
  // INPATIENT_BONUS_V1 (мигр. 155) — стационарная ставка живёт в inpatient_rates.
  c.db.prepare('UPDATE users SET service_rates = ?, inpatient_rates = ? WHERE id = 1')
    .run(JSON.stringify([{ service_id: 1, pct: 30 }]), JSON.stringify([{ service_id: 1, pct: 15 }]));
  c.db.prepare(`INSERT INTO admission_services (admission_id, service_id, doctor_id, quantity, unit_price, total, status, billable, performed_at)
                VALUES (1,1,1,1,100000,100000,'added',1,?)`).run(DAY);
  for (const [id, name] of [[1, 'Доктор Д.'], [2, 'Без ставок']]) {
    const s = summary(c.db, id);
    const r = salaries(c.db, name);
    assert.equal(s.outpatient.fee, r.fee, name + ': амбулатория');
    assert.equal(s.inpatient.fee, r.inFee, name + ': стационар');
    assert.equal(s.outpatient.count, r.count, name + ': число услуг');
    // Сумма по строкам ответа = итог (браузер складывает те же числа).
    const byLines = s.lines.reduce((n, l) => n + l.fee, 0);
    assert.ok(Math.abs(byLines - s.outpatient.fee - s.inpatient.fee) < 0.05, name);
  }
  assert.equal(summary(c.db, 1).inpatient.fee, 14100);   // 94 000 × 15 %
  // И «По врачам» — те же доли.
  const b = runReport(c.db, { kind: 'by_doctors', from: FROM, to: TO }, admin);
  const bRow = b.rows.find((x) => x[b.columns.indexOf('Врач')] === 'Доктор Д.');
  assert.equal(bRow[b.columns.indexOf('Доля за услуги')], summary(c.db, 1).outpatient.fee);
});

test('doctor_pay_summary: зарегистрирован, чтение, права как у начислений', () => {
  assert.equal(typeof RPC.doctor_pay_summary, 'function');
  assert.equal(isReadOnlyRpc('doctor_pay_summary'), true);
  const c = clinic();
  c.line({});
  assert.doesNotThrow(() => doctorPaySummary(c.db, { doctor_id: 1, from: FROM, to: TO }, { id: 1, role: 'doctor' }));
  assert.throws(() => doctorPaySummary(c.db, { doctor_id: 2, from: FROM, to: TO }, { id: 1, role: 'doctor' }), (e) => e.status === 403);
  assert.throws(() => doctorPaySummary(c.db, { doctor_id: 'x', from: FROM, to: TO }, admin), /doctor_id/);
  // Строк столько, сколько их есть: предела в 500 (как было в кабинете) нет.
  for (let i = 0; i < 520; i++) c.line({});
  assert.equal(summary(c.db).lines.length, 521);
});

test('каждый отчёт с долей врача говорит, по какой базе она считается', () => {
  const c = clinic();
  c.line({ invoice: 'paid' });
  for (const kind of ['doctor_salaries', 'inpatient_share', 'by_doctors', 'doctor_services', 'total_revenue', 'surgery_profit', 'by_services']) {
    const r = runReport(c.db, { kind, from: FROM, to: TO }, admin);
    assert.ok(r.notes.includes('Доля врача — по выполненным услугам, оплачены они или нет.'), kind);
  }
});
