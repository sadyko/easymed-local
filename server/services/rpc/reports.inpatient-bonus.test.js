// INPATIENT_BONUS_V1 (владелец, 26.09) — вознаграждение за направление в
// стационар и ставки стационара отдельно от амбулаторных.
//
// Проверяется на ОТЧЁТАХ и RPC кабинета, а не на выражениях SQL:
//   * партнёр без переключателя «Вознаграждение за стационар» за стационар не
//     получает ничего (прежде — обычные ставки групп со всего счёта);
//   * с переключателем: % от оплаченного счёта госпитализации — услуги и
//     койко-дни, БЕЗ товаров (медикаменты/расходники), после доли скидки; фикс —
//     один раз за госпитализацию, с первого оплаченного счёта; неоплаченный
//     счёт — ничего;
//   * кто направил: admissions.referral_source_id, иначе карточка пациента;
//   * направивший врач госпитализации (admissions.referring_doctor_id) — по своей
//     вкладке «Стационар»; источник, связанный с сотрудником, по карточке
//     источника за стационар не платит;
//   * «Рефералы» (сводка = детализация), «По врачам», «Зарплаты врачей» и
//     кабинет (doctor_pay_summary) — одно и то же число для каждого врача;
//   * стационарная ставка врача — % или фикс за единицу (users.inpatient_rates).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { runReport, doctorPaySummary } from './reports.js';
import { createInvoiceForAdmission } from './billing.js';

const admin = { id: 9, role: 'admin' };
const FROM = '2000-01-01';
const TO = '2100-01-01';

// Клиника:
//   врач 1 «Направляев» — направивший (admissions.referring_doctor_id): 2 % + 100 000 за
//     госпитализацию; врач 2 «Хирургов» — исполнитель операции, стационарная
//     ставка 10 %; администратор 9;
//   категория «Партнёры» — обычная ставка 10 % на всё;
//   источник P «Клиника Х» (Партнёры) — стационар ВКЛЮЧЁН: 5 % + 50 000;
//   источник Q «Клиника Y» (Партнёры) — стационар выключен.
//   Пациент 1: в карточке Q; госпитализация 1 записала «направил P».
//   Строки госпитализации 1:
//     1 операция 1 000 000 (налог 6 %, исполнитель 2)  → услуга, в базе;
//     2 проживание 3 × 300 000 = 900 000               → койко-дни, в базе;
//     3 бинт 4 × 5 000 = 20 000                        → товар, НЕ в базе.
function seed({ discount = 0 } = {}) {
  const db = openDb(':memory:');
  migrate(db);
  const u = db.prepare(`INSERT INTO users (id, username, password_hash, role, full_name, is_doctor,
                          service_rates, inpatient_rates, inpatient_referral_pct, inpatient_referral_fixed)
                        VALUES (?,?,?,?,?,?,?,?,?,?)`);
  u.run(1, 'napr', 'x', 'doctor', 'Направляев Н.Н.', 1, '', '', 2, 100000);
  u.run(2, 'surg', 'x', 'doctor', 'Хирургов Х.Х.', 1, '', JSON.stringify([{ service_id: 1, pct: 10 }]), 0, 0);
  u.run(9, 'adm', 'x', 'admin', 'Администратор', 0, '', '', 0, 0);
  const cat = db.prepare("INSERT INTO referral_source_categories (name, standard_percent) VALUES ('Партнёры', 10)").run().lastInsertRowid;
  const src = db.prepare(`INSERT INTO referral_sources (name, category_id, inpatient_bonus_enabled, inpatient_pct, inpatient_fixed)
                          VALUES (?, ?, ?, ?, ?)`);
  const P = src.run('Клиника Х', cat, 1, 5, 50000).lastInsertRowid;
  const Q = src.run('Клиника Y', cat, 0, 0, 0).lastInsertRowid;
  db.prepare("INSERT INTO patients (id, mrn, full_name, referral_source_id) VALUES (1,'P-1','Азизов А.',?)").run(Q);
  db.prepare("INSERT INTO services (id, name, price, tax_rate, type) VALUES (1,'Операция',1000000,6,'other')").run();
  db.prepare("INSERT INTO products (id, name, sale_price) VALUES (1,'Бинт',5000)").run();
  // Ревью I1 — направивший записан ЯВНО (referring_doctor_id, мигр. 156):
  // admissions.doctor_id бонус больше не читает.
  db.prepare(`INSERT INTO admissions (id, admission_no, patient_id, doctor_id, attending_doctor_id, status, referral_source_id, referring_doctor_id)
              VALUES (1,'A-1',1,1,2,'active',?,1)`).run(P);
  const line = db.prepare(`INSERT INTO admission_services
      (id, admission_id, service_id, clinic_item_id, doctor_id, performer_id, quantity, unit_price, total, status, notes, billable, performed_at)
      VALUES (?,1,?,?,?,?,?,?,?,'added',?,1,'2026-08-06T09:00:00Z')`);
  line.run(1, 1, null, 1, 2, 1, 1000000, 1000000, null);
  line.run(2, null, null, 1, null, 3, 300000, 900000, 'ACCOMMODATION · 201 · койка 1');
  line.run(3, null, 1, 1, null, 4, 5000, 20000, null);
  const { invoice } = createInvoiceForAdmission(db, { admission_id: 1, admission_service_ids: [1, 2, 3] }, admin);
  assert.equal(invoice.subtotal, 1920000);
  const total = invoice.subtotal - discount;
  db.prepare(`UPDATE invoices SET discount_amount = ?, total_amount = ?, paid_amount = ?, status = 'paid',
              created_at = '2026-08-06T10:00:00Z' WHERE id = ?`).run(discount, total, total, invoice.id);
  return { db, P, Q, cat, invoiceId: invoice.id };
}

// Ещё один счёт той же госпитализации: проживание 1 × 300 000.
function extraInvoice(db, { paid = true, id = 10 } = {}) {
  db.prepare(`INSERT INTO admission_services
      (id, admission_id, service_id, clinic_item_id, doctor_id, performer_id, quantity, unit_price, total, status, notes, billable)
      VALUES (?,1,NULL,NULL,1,NULL,1,300000,300000,'added','ACCOMMODATION · 201 · койка 1',1)`).run(id);
  const { invoice } = createInvoiceForAdmission(db, { admission_id: 1, admission_service_ids: [id] }, admin);
  db.prepare(`UPDATE invoices SET paid_amount = ?, status = ?, created_at = '2026-08-07T10:00:00Z' WHERE id = ?`)
    .run(paid ? invoice.total_amount : 0, paid ? 'paid' : 'unpaid', invoice.id);
  return invoice.id;
}

const run = (db, kind, extra = {}) => runReport(db, { kind, from: FROM, to: TO, ...extra }, admin);
const objects = (r) => r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]])));
const sum = (list, col) => Math.round(list.reduce((n, o) => n + (Number(o[col]) || 0), 0) * 100) / 100;
const inRows = (db, extra) => objects(run(db, 'referrals', extra)).filter((o) => o['Где'] === 'Стационар');
const pay = (db, id) => doctorPaySummary(db, { doctor_id: id, from: FROM, to: TO }, admin);

// ─── ПАРТНЁР ─────────────────────────────────────────────────────────────────

test('партнёр с переключателем: 5 % от услуг и койко-дней (без товаров) + 50 000 за госпитализацию', () => {
  const { db } = seed();
  const p = inRows(db).find((o) => o['Источник'] === 'Клиника Х');
  // База: 1 000 000 + 900 000 = 1 900 000 (бинт 20 000 не входит); 5 % = 95 000; + фикс 50 000.
  assert.equal(p['Оплачено'], 1900000);
  assert.equal(p['Вознаграждение'], 145000);
  assert.equal(p['Услуг'], 2, 'фикс — не услуга; товар — не в базе');
  assert.equal(p['Вид'], 'Внешний');
  const detail = objects(run(db, 'referrals_detail')).filter((o) => o['Источник'] === 'Клиника Х');
  assert.deepEqual(detail.map((o) => [o['Услуга'], o['Ставка'], o['Вознаграждение']]), [
    ['Операция', '5 %', 50000],
    ['Проживание в палате', '5 %', 45000],
    ['Фикс за госпитализацию', 'фикс 50 000', 50000],
  ]);
  assert.ok(detail.every((o) => o['№ госпитализации'] === 'A-1' && o['Где'] === 'Стационар'));
});

test('партнёр без переключателя за стационар не получает ничего — обычные ставки групп к счёту госпитализации не применяются', () => {
  const { db, P } = seed();
  // Направил тот, у кого стационар выключен (как Q), — вместо P.
  db.prepare('UPDATE referral_sources SET inpatient_bonus_enabled = 0 WHERE id = ?').run(P);
  const p = inRows(db).find((o) => o['Источник'] === 'Клиника Х');
  assert.equal(p['Вознаграждение'], 0, 'выключенный стационар заплатил');
  assert.equal(p['Режим ставок'], 'Стационар выключен');
  // Числа в карточке при выключенном переключателе не читаются.
  assert.equal(sum(objects(run(db, 'referrals_detail')).filter((o) => o['Источник'] === 'Клиника Х'), 'Вознаграждение'), 0);
  // И категория 10 % тоже: строк «Амбулатория» по счёту госпитализации нет.
  assert.ok(!objects(run(db, 'referrals')).some((o) => o['Где'] === 'Амбулатория'));
});

test('кто направил: из госпитализации, а не из карточки пациента; без записи в госпитализации — карточка', () => {
  const { db, Q } = seed();
  assert.ok(!inRows(db).some((o) => o['Источник'] === 'Клиника Y'), 'карточка пациента перебила госпитализацию');
  db.prepare('UPDATE admissions SET referral_source_id = NULL WHERE id = 1').run();
  const q = inRows(db).find((o) => o['Источник'] === 'Клиника Y');
  assert.ok(q, 'госпитализация без направившего не взяла источник из карточки');
  assert.equal(q['Вознаграждение'], 0, 'Q без переключателя');
  db.prepare('UPDATE referral_sources SET inpatient_bonus_enabled = 1, inpatient_pct = 1 WHERE id = ?').run(Q);
  assert.equal(inRows(db).find((o) => o['Источник'] === 'Клиника Y')['Вознаграждение'], 19000);
});

test('скидка счёта ложится на строки: база — после доли скидки', () => {
  // Скидка 192 000 = 10 % от 1 920 000 → каждая строка −10 %: база 1 710 000.
  const { db } = seed({ discount: 192000 });
  const p = inRows(db).find((o) => o['Источник'] === 'Клиника Х');
  assert.equal(p['Оплачено'], 1710000);
  assert.equal(p['Вознаграждение'], 85500 + 50000);
});

test('фикс — один раз за госпитализацию (с первого оплаченного счёта); процент — с каждого оплаченного', () => {
  const { db } = seed();
  extraInvoice(db);
  const p = inRows(db).find((o) => o['Источник'] === 'Клиника Х');
  // 95 000 + 15 000 (5 % от 300 000) + фикс 50 000 ОДИН раз.
  assert.equal(p['Вознаграждение'], 160000);
  const fixed = objects(run(db, 'referrals_detail')).filter((o) => o['Услуга'] === 'Фикс за госпитализацию' && o['Источник'] === 'Клиника Х');
  assert.equal(fixed.length, 1);
  assert.equal(fixed[0]['Дата'], '2026-08-06', 'фикс — по дате первого оплаченного счёта');
  // Период только второго счёта — фикса в нём нет.
  const late = objects(runReport(db, { kind: 'referrals_detail', from: '2026-08-07', to: '2026-08-07' }, admin))
    .filter((o) => o['Источник'] === 'Клиника Х');
  assert.deepEqual(late.map((o) => o['Вознаграждение']), [15000]);
});

test('неоплаченный счёт госпитализации не приносит ничего — ни процента, ни фикса', () => {
  const { db, invoiceId } = seed();
  db.prepare("UPDATE invoices SET status = 'unpaid', paid_amount = 0 WHERE id = ?").run(invoiceId);
  extraInvoice(db, { paid: false });
  assert.equal(sum(inRows(db), 'Вознаграждение'), 0);
  assert.equal(pay(db, 1).inpatient_referral.reward, 0);
  // Первый счёт оплатили — фикс пришёл с него.
  db.prepare("UPDATE invoices SET status = 'paid', paid_amount = total_amount WHERE id = ?").run(invoiceId);
  assert.equal(inRows(db).find((o) => o['Источник'] === 'Клиника Х')['Вознаграждение'], 145000);
});

// ─── НАПРАВИВШИЙ ВРАЧ ────────────────────────────────────────────────────────

test('направивший врач госпитализации: 2 % + 100 000 по своей вкладке — «Рефералы», «По врачам», «Зарплаты», кабинет', () => {
  const { db } = seed();
  extraInvoice(db);
  // 2 % от (1 900 000 + 300 000) = 44 000 + фикс 100 000 = 144 000.
  const mine = pay(db, 1);
  assert.equal(mine.inpatient_referral.reward, 144000);
  assert.equal(mine.inpatient_referral.admissions, 1);
  assert.equal(mine.inpatient_referral.rows.filter((r) => r.kind === 'fixed').length, 1);
  const ref = inRows(db, { referrer: 'internal' }).find((o) => o['Источник'] === 'Направляев Н.Н.');
  assert.equal(ref['Вознаграждение'], 144000);
  assert.equal(ref['Режим ставок'], 'Стационар — карточка сотрудника');
  const byDoc = objects(run(db, 'by_doctors')).find((o) => o['Врач'] === 'Направляев Н.Н.');
  assert.equal(byDoc['За направление в стационар'], 144000);
  assert.equal(byDoc['Итого к выплате'], 144000);
  const sal = objects(run(db, 'doctor_salaries')).find((o) => o['Врач'] === 'Направляев Н.Н.');
  assert.equal(sal['За направление в стационар'], 144000);
  assert.equal(sal['Итого к выплате'], 0, '«Итого» зарплатного отчёта — за работу, без вознаграждений');
  // Внешний отбор врача не показывает.
  assert.ok(!inRows(db, { referrer: 'external' }).some((o) => o['Источник'] === 'Направляев Н.Н.'));
});

test('врач без настроек «За направление в стационар» ничего не получает и строкой не показывается', () => {
  const { db } = seed();
  db.prepare('UPDATE users SET inpatient_referral_pct = 0, inpatient_referral_fixed = 0 WHERE id = 1').run();
  assert.equal(pay(db, 1).inpatient_referral.reward, 0);
  assert.ok(!inRows(db).some((o) => o['Источник'] === 'Направляев Н.Н.'));
  assert.ok(!objects(run(db, 'by_doctors')).some((o) => o['Врач'] === 'Направляев Н.Н.'));
});

test('внутренний источник сотрудника по карточке источника за стационар не платит — платит вкладка сотрудника', () => {
  const { db } = seed();
  const own = db.prepare('SELECT id FROM referral_sources WHERE doctor_id = 1').get().id;
  db.prepare('UPDATE referral_sources SET inpatient_bonus_enabled = 1, inpatient_pct = 50, inpatient_fixed = 999 WHERE id = ?').run(own);
  db.prepare('UPDATE admissions SET referral_source_id = ? WHERE id = 1').run(own);
  // Только своя вкладка: 38 000 + 100 000, а не ещё 50 % по источнику.
  assert.equal(pay(db, 1).inpatient_referral.reward, 138000);
  assert.equal(sum(inRows(db), 'Вознаграждение'), 138000);
});

test('паритет: кабинет = «По врачам» = «Рефералы» по каждому врачу; итог кабинета = «Итого к выплате»', () => {
  const { db } = seed({ discount: 192000 });
  extraInvoice(db);
  extraInvoice(db, { paid: false, id: 11 });
  const byDoc = objects(run(db, 'by_doctors'));
  const sal = objects(run(db, 'doctor_salaries'));
  const refs = objects(run(db, 'referrals'));
  for (const id of [1, 2]) {
    const s = pay(db, id);
    const name = id === 1 ? 'Направляев Н.Н.' : 'Хирургов Х.Х.';
    const b = byDoc.find((o) => o['Врач'] === name) || {};
    const r = sal.find((o) => o['Врач'] === name) || {};
    assert.equal(s.inpatient_referral.reward, b['За направление в стационар'] || 0, name + ': «По врачам»');
    assert.equal(s.inpatient_referral.reward, r['За направление в стационар'] || 0, name + ': «Зарплаты»');
    assert.equal(s.inpatient.fee, b['Стационарная доля'] || 0, name + ': стационарная доля');
    assert.equal(s.total, b['Итого к выплате'] || 0, name + ': итог');
    const inRef = refs.filter((o) => o['Где'] === 'Стационар' && o['Источник'] === name);
    assert.equal(s.inpatient_referral.reward, sum(inRef, 'Вознаграждение'), name + ': «Рефералы»');
  }
  // Сводка = детализация.
  const detail = objects(run(db, 'referrals_detail'));
  assert.equal(sum(detail, 'Вознаграждение'), sum(refs, 'Вознаграждение'));
  assert.equal(sum(detail, 'Сумма после скидки'), sum(refs, 'Сумма услуг'));
});

// ─── СТАВКИ СТАЦИОНАРА ───────────────────────────────────────────────────────

test('стационарная ставка врача — фикс за единицу: без налога и процента, одинаково в отчётах и кабинете', () => {
  const { db } = seed();
  db.prepare('UPDATE users SET inpatient_rates = ? WHERE id = 2').run(JSON.stringify([{ service_id: 1, fix: 120000 }]));
  const s = pay(db, 2);
  assert.equal(s.inpatient.fee, 120000);
  const line = s.lines.find((l) => l.kind === 'in');
  assert.equal(line.fix, 120000);
  assert.equal(line.pct, null);
  const sal = objects(run(db, 'doctor_salaries')).find((o) => o['Врач'] === 'Хирургов Х.Х.');
  assert.equal(sal['Стационар: гонорар'], 120000);
  const share = objects(run(db, 'inpatient_share')).find((o) => o['Врач'] === 'Хирургов Х.Х.');
  assert.equal(share['Ставка, %'], 'фикс 120 000');
  assert.equal(share['Начислено врачу'], 120000);
  // «Общая выручка» (по строкам счетов) — та же доля.
  const rev = objects(run(db, 'total_revenue')).find((o) => o['Врач'] === 'Хирургов Х.Х.');
  assert.equal(rev['Доля врача'], 120000);
  // Процентом: 10 % от 940 000.
  db.prepare('UPDATE users SET inpatient_rates = ? WHERE id = 2').run(JSON.stringify([{ service_id: 1, pct: 10 }]));
  assert.equal(pay(db, 2).inpatient.fee, 94000);
});

test('стационарная ставка не трогает амбулаторную: ставка по умолчанию работает, service_rates пуст', () => {
  const { db } = seed();
  db.prepare('UPDATE users SET service_rate_default = 30 WHERE id = 2').run();
  db.prepare("INSERT INTO visits (id, patient_id, visit_date) VALUES (5,1,'2026-08-05T09:00:00Z')").run();
  db.prepare(`INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status)
              VALUES (5,1,2,1,1000000,1000000,'completed')`).run();
  const s = pay(db, 2);
  // Амбулатория: 30 % по умолчанию от 940 000 = 282 000; стационар — 10 % = 94 000.
  assert.equal(s.outpatient.fee, 282000);
  assert.equal(s.inpatient.fee, 94000);
});
