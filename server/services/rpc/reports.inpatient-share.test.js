// INPATIENT_SHARE_V1 — стационарная доля врача.
//
// Владелец: «в карточке сотрудника нужна доля не только за оказанные услуги,
// но и за стационар» + отчёт по стационарной доле. Решение (23.09): отдельный
// «Стационар, %» на каждую услугу в таблице ставок; платится ИСПОЛНИТЕЛЮ
// строки стационара (нет исполнителя — НАЗНАЧИВШЕМУ), только после оплаты
// счёта, тем же порядком, что амбулаторная доля (сумма − скидка − налог) × %.
// Койко-дни и медикаменты/расходники НЕ входят.
//
// Считается ОТЧЁТАМИ (зарплатный, «Общая выручка», «Рентабельность операций»,
// новый «Стационар: доля врачей») и RPC кабинета врача — проверяется здесь
// именно на них, а не на внутренних выражениях SQL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { runReport, doctorInpatientShare, doctorTierPositions } from './reports.js';
import { createInvoiceForAdmission } from './billing.js';

const admin = { id: 9, role: 'admin' };
const FROM = '2000-01-01';
const TO   = '2100-01-01';

// Клиника:
//   1 Хирургов   — амбулаторно 40 % за перевязку; стационар: 20 % операция, 10 % перевязка;
//   2 Исполнитель — стационар 50 % операция (амбулаторной доли нет);
//   3 Безставкин — только амбулаторные 25 % за операцию, стационарной доли НЕТ.
// Услуги: 1 «Операция: аппендэктомия» 1 000 000, налог 6 %; 2 «Перевязка» 100 000, налог 0.
// Госпитализация 1 (№ A-7), строки:
//   1 операция, назначил 1, ИСПОЛНИЛ 2            → 2 получает 50 %;
//   2 перевязка ×2, назначил 1, исполнителя нет  → 1 получает 10 %;
//   3 койко-дни ×3 (service_id NULL, ACCOMMODATION) → никому;
//   4 расходник ×4 (clinic_item_id)                → никому;
//   5 операция, назначил 3, исполнителя нет       → 0: у 3 нет стационарной доли.
function seed({ paid = true, discount = 0, tier = false } = {}) {
  const db = openDb(':memory:');
  migrate(db);
  const u = db.prepare(`INSERT INTO users (id, username, password_hash, role, full_name, is_doctor, service_rates)
                        VALUES (?,?,?,?,?,1,?)`);
  u.run(1, 'surg', 'x', 'doctor', 'Хирургов Х.Х.', JSON.stringify([
    { service_id: 1, pct: 30, inpatient_pct: 20, branches: [] },
    { service_id: 2, pct: 40, inpatient_pct: 10, branches: [] },
  ]));
  u.run(2, 'perf', 'x', 'doctor', 'Исполнитель И.И.', JSON.stringify([
    { service_id: 1, pct: 0, inpatient_pct: 50, branches: [] },
  ]));
  u.run(3, 'nopct', 'x', 'doctor', 'Безставкин Б.Б.', JSON.stringify([
    { service_id: 1, pct: 25, branches: [] },
  ]));
  u.run(9, 'adm', 'x', 'admin', 'Администратор', '');
  db.prepare("UPDATE users SET is_doctor = 0 WHERE id = 9").run();

  db.prepare("INSERT INTO patients (id, mrn, full_name) VALUES (1,'P-1','Азизов Бахтиёр')").run();
  db.prepare("INSERT INTO services (id, name, price, tax_rate) VALUES (1,'Операция: аппендэктомия',1000000,6)").run();
  db.prepare("INSERT INTO services (id, name, price, tax_rate) VALUES (2,'Перевязка',100000,0)").run();
  if (tier) {
    // Ступень на перевязку с ПЕРВОЙ единицы: если бы стационар участвовал в
    // ступенях, вторая перевязка стационара ушла бы по 90 %.
    db.prepare('UPDATE services SET doctor_tier_from = 1, doctor_tier_percent = 90 WHERE id = 2').run();
  }
  db.prepare("INSERT INTO products (id, name, sale_price) VALUES (1,'Бинт',5000)").run();

  db.prepare(`INSERT INTO admissions (id, admission_no, patient_id, doctor_id, attending_doctor_id, status)
              VALUES (1,'A-7',1,1,1,'active')`).run();
  const line = db.prepare(`INSERT INTO admission_services
      (id, admission_id, service_id, clinic_item_id, doctor_id, performer_id, quantity, unit_price, total, status, notes, billable)
      VALUES (?,1,?,?,?,?,?,?,?,'added',?,1)`);
  line.run(1, 1, null, 1, 2, 1, 1000000, 1000000, null);
  line.run(2, 2, null, 1, null, 2, 100000, 200000, null);
  line.run(3, null, null, 1, null, 3, 300000, 900000, 'ACCOMMODATION · 201 · койка 1');
  line.run(4, null, 1, 1, null, 4, 5000, 20000, null);
  line.run(5, 1, null, 3, null, 1, 1000000, 1000000, null);

  const { invoice } = createInvoiceForAdmission(db, { admission_id: 1, admission_service_ids: [1, 2, 3, 4, 5] }, admin);
  assert.equal(invoice.subtotal, 3120000);
  const total = invoice.subtotal - discount;
  db.prepare('UPDATE invoices SET discount_amount = ?, total_amount = ?, paid_amount = ?, status = ? WHERE id = ?')
    .run(discount, total, paid ? total : 0, paid ? 'paid' : 'unpaid', invoice.id);
  return db;
}

// Оплаченный амбулаторный приём врача 1: перевязка 100 000, 40 % → 40 000.
function outpatientVisit(db, { qty = 1 } = {}) {
  db.prepare("INSERT INTO visits (id, patient_id, visit_date) VALUES (1,1,strftime('%Y-%m-%dT%H:%M:%SZ','now'))").run();
  db.prepare(`INSERT INTO visit_services (id, visit_id, service_id, doctor_id, quantity, unit_price, total, status)
              VALUES (1,1,2,1,?,100000,?,'completed')`).run(qty, 100000 * qty);
  db.prepare(`INSERT INTO invoices (id, invoice_number, visit_id, patient_id, subtotal, discount_amount, total_amount, paid_amount, status)
              VALUES (100,'INV-OUT',1,1,?,0,?,?,'paid')`).run(100000 * qty, 100000 * qty, 100000 * qty);
  db.prepare(`INSERT INTO invoice_items (id, invoice_id, service_id, description, quantity, unit_price, total)
              VALUES (100,100,2,'Перевязка',?,100000,?)`).run(qty, 100000 * qty);
  db.prepare('UPDATE visit_services SET invoice_item_id = 100 WHERE id = 1').run();
}

const objectsOf = (r) => r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]])));
const report = (db, kind = 'inpatient_share') => runReport(db, { kind, from: FROM, to: TO }, admin);
const col = (r, name) => {
  const i = r.columns.indexOf(name);
  assert.ok(i >= 0, 'нет колонки «' + name + '»: ' + r.columns.join(' | '));
  return i;
};
// Зарплатный отчёт → { врач: строка по именам колонок }.
function salaries(db) {
  const r = report(db, 'doctor_salaries');
  const out = {};
  for (const row of r.rows) {
    const o = {};
    r.columns.forEach((c, i) => { o[c] = row[i]; });
    out[o['Врач']] = o;
  }
  return { r, out };
}

// ─── 1. КОМУ ПЛАТИТСЯ ───────────────────────────────────────────────────────

test('исполнитель получает свою стационарную долю, а не назначивший врач', () => {
  const { out } = salaries(seed());
  // 1 000 000 − 6 % = 940 000; 50 % = 470 000.
  assert.equal(out['Исполнитель И.И.']['Стационар: гонорар'], 470000);
  assert.equal(out['Исполнитель И.И.']['Стационар: услуг'], 1);
});

test('нет исполнителя — долю получает назначивший врач', () => {
  const { out } = salaries(seed());
  // перевязка ×2 = 200 000, налог 0, 10 % = 20 000.
  assert.equal(out['Хирургов Х.Х.']['Стационар: гонорар'], 20000);
  assert.equal(out['Хирургов Х.Х.']['Стационар: услуг'], 1);
  assert.equal(out['Хирургов Х.Х.']['Стационар: сумма после скидки'], 200000);
});

test('врач без «Стационар, %» на услугу получает 0 — амбулаторный % НЕ подставляется', () => {
  const db = seed();
  // И ставка по умолчанию из карточки тоже не подставляется.
  db.prepare('UPDATE users SET service_rate_default = 35 WHERE id = 3').run();
  const { r, out } = salaries(db);
  // Ревью I1 (владелец): доля остаётся нулём, но нулевой строкой человек не
  // показывается — он назван в примечании с числом таких услуг.
  assert.ok(!out['Безставкин Б.Б.'], 'нулевая строка исполнителя без стационарной ставки');
  assert.ok(r.notes.includes('1 услуга: исполнитель без стационарной ставки — доля не начислена (Безставкин Б.Б. — 1).'),
    r.notes.join(' | '));
  // А по строке стационара ему по-прежнему начислен 0, а не амбулаторные 35 %.
  const line = objectsOf(report(db)).find((o) => o['Врач'] === 'Безставкин Б.Б.');
  assert.equal(line['Начислено врачу'], 0);
  assert.equal(line['Ставка, %'], '—');
});

test('койко-дни и расходники не платят никому', () => {
  const db = seed();
  const r = report(db);
  const services = r.rows.map((x) => x[col(r, 'Услуга')]);
  assert.ok(!services.some((s) => /ACCOMMODATION|Бинт|койк/i.test(String(s))), 'в отчёт попали койко-дни или расходник: ' + services);
  assert.equal(r.rows.length, 3, 'три медицинские строки: операция ×2 и перевязка');
  // И сумма всех гонораров — только три медицинские строки.
  const { r: s } = salaries(db);
  const total = s.rows.reduce((n, row) => n + row[s.columns.indexOf('Итого к выплате')], 0);
  assert.equal(total, 470000 + 20000);
});

test('неоплаченный счёт не платит стационарную долю', () => {
  const db = seed({ paid: false });
  assert.equal(report(db).rows.length, 0);
  assert.equal(report(db, 'doctor_salaries').rows.length, 0);
  assert.equal(doctorInpatientShare(db, { doctor_id: 2, from: FROM, to: TO }, admin).fee, 0);
});

test('скидка и налог вычитаются так же, как у амбулаторной доли', () => {
  // скидка 10 % счёта (312 000) ложится на строки пропорционально:
  //   операция 1 000 000 → 900 000 → −6 % = 846 000 → 50 % = 423 000;
  //   перевязка 200 000 → 180 000 → налог 0 → 10 % = 18 000.
  const { out } = salaries(seed({ discount: 312000 }));
  assert.equal(out['Исполнитель И.И.']['Стационар: гонорар'], 423000);
  assert.equal(out['Хирургов Х.Х.']['Стационар: гонорар'], 18000);
  assert.equal(out['Хирургов Х.Х.']['Стационар: сумма после скидки'], 180000);
});

// ─── 2. ЗАРПЛАТНЫЙ ОТЧЁТ ────────────────────────────────────────────────────

test('«Итого к выплате» = амбулаторная доля + стационарная', () => {
  const db = seed();
  outpatientVisit(db);
  const { r, out } = salaries(db);
  const surg = out['Хирургов Х.Х.'];
  assert.equal(surg['Доля врача (гонорар)'], 40000, 'амбулаторная часть не изменилась');
  assert.equal(surg['Оплаченных услуг'], 1, 'амбулаторный счётчик считает только амбулаторные строки');
  assert.equal(surg['Сумма после скидки'], 100000);
  assert.equal(surg['Средний % врача'], 40);
  assert.equal(surg['Стационар: гонорар'], 20000);
  assert.equal(surg['Итого к выплате'], 60000);
  // Разрез по зданиям несёт полную выплату.
  assert.equal(r.by_building[0].fee, 470000 + 60000);
});

test('ступени (DOCTOR_TIER_V2) к стационару не применяются и стационар не двигает амбулаторный счёт ступени', () => {
  const db = seed({ tier: true });
  outpatientVisit(db);
  const { out } = salaries(db);
  // Стационарная перевязка ×2 идёт по 10 %, а не по ступени 90 %.
  assert.equal(out['Хирургов Х.Х.']['Стационар: гонорар'], 20000);
  // Амбулаторная перевязка — первая единица месяца: порог 1 ещё не перешагнут.
  assert.equal(out['Хирургов Х.Х.']['Доля врача (гонорар)'], 40000);
  const pos = doctorTierPositions(db, { doctor_id: 1, from: '2000-01', to: '2100-12' }, admin);
  assert.equal(pos.rows.length, 1, 'в нумерации ступени только амбулаторная строка');
  assert.equal(pos.rows[0].count_so_far, 1);
});

// ─── 3. ДРУГИЕ ОТЧЁТЫ ───────────────────────────────────────────────────────

test('«Общая выручка»: у строк стационара виден врач, ставка и доля', () => {
  const r = report(seed(), 'total_revenue');
  const rows = r.rows;
  const byService = (re) => rows.filter((x) => re.test(String(x[col(r, 'Услуга')])));
  const ops = byService(/Операция/);
  const perf = ops.find((x) => x[col(r, 'Врач')] === 'Исполнитель И.И.');
  assert.ok(perf, 'у операции указан исполнитель');
  assert.equal(perf[col(r, 'Ставка врача')], 50);
  assert.equal(perf[col(r, 'Доля врача')], 470000);
  const nopct = ops.find((x) => x[col(r, 'Врач')] === 'Безставкин Б.Б.');
  assert.equal(nopct[col(r, 'Доля врача')], 0);
  const dressing = byService(/Перевязка/)[0];
  assert.equal(dressing[col(r, 'Врач')], 'Хирургов Х.Х.');
  assert.equal(dressing[col(r, 'Доля врача')], 20000);
  // Койко-дни и расходник — без врача и без доли.
  for (const x of rows.filter((y) => !/Операция|Перевязка/.test(String(y[col(r, 'Услуга')])))) {
    assert.equal(x[col(r, 'Врач')], '');
    assert.equal(x[col(r, 'Доля врача')], 0);
  }
});

test('«Рентабельность операций»: у стационарной операции есть гонорар хирурга', () => {
  const r = report(seed(), 'surgery_profit');
  const fees = r.rows.map((x) => x[col(r, 'Гонорар хирурга')]).sort((a, b) => a - b);
  assert.deepEqual(fees, [0, 470000]);
});

// ─── 4. НОВЫЙ ОТЧЁТ ─────────────────────────────────────────────────────────

test('«Стационар: доля врачей» — строка на каждую оплаченную медицинскую строку и итоги по врачам', () => {
  const r = report(seed({ discount: 312000 }));
  assert.equal(r.columns[0], 'Здание');
  const find = (who) => r.rows.find((x) => x[col(r, 'Врач')] === who);
  const perf = find('Исполнитель И.И.');
  assert.equal(perf[col(r, '№ госпитализации')], 'A-7');
  assert.equal(perf[col(r, 'Пациент')], 'Азизов Бахтиёр');
  assert.equal(perf[col(r, 'Кол-во')], 1);
  assert.equal(perf[col(r, 'Сумма')], 1000000);
  assert.equal(perf[col(r, 'Скидка')], 100000);
  assert.equal(perf[col(r, 'Налог')], 54000);
  assert.equal(perf[col(r, 'После скидки и налога')], 846000);
  assert.equal(perf[col(r, 'Чей врач')], 'Исполнитель');
  assert.equal(perf[col(r, 'Ставка, %')], 50);
  assert.equal(perf[col(r, 'Начислено врачу')], 423000);

  const surg = find('Хирургов Х.Х.');
  assert.equal(surg[col(r, 'Чей врач')], 'Назначил');
  assert.equal(surg[col(r, 'Кол-во')], 2);
  assert.equal(surg[col(r, 'Начислено врачу')], 18000);

  const none = find('Безставкин Б.Б.');
  assert.equal(none[col(r, 'Ставка, %')], '—', 'нет ставки — прочерк, а не 0 %');
  assert.equal(none[col(r, 'Начислено врачу')], 0);

  // Итоги по врачам — примечаниями над таблицей, по убыванию начисленного.
  const perDoctor = r.notes.filter((n) => n.startsWith('Итого'));
  assert.equal(perDoctor.length, 3);
  assert.ok(perDoctor[0].includes('Исполнитель И.И.') && perDoctor[0].includes('423 000'), perDoctor[0]);
  assert.ok(perDoctor[1].includes('Хирургов Х.Х.') && perDoctor[1].includes('18 000'), perDoctor[1]);
  assert.equal(r.by_building[0].fee, 441000);
  assert.ok(r.pending_items, 'отчёт по строкам счетов говорит о недоехавших позициях');
});

test('период отчёта — по дате счёта, как у «Зарплат врачей»', () => {
  const db = seed();
  db.prepare("UPDATE invoices SET created_at = '2026-01-15T10:00:00Z'").run();
  const inJan = runReport(db, { kind: 'inpatient_share', from: '2026-01-01', to: '2026-01-31' }, admin);
  const inFeb = runReport(db, { kind: 'inpatient_share', from: '2026-02-01', to: '2026-02-28' }, admin);
  assert.equal(inJan.rows.length, 3);
  assert.equal(inFeb.rows.length, 0);
  const sal = runReport(db, { kind: 'doctor_salaries', from: '2026-01-01', to: '2026-01-31' }, admin);
  // Безставкин (только строка стационара без ставки) — примечанием, не строкой (ревью I1).
  assert.equal(sal.rows.length, 2);
});

// ─── 5. КАБИНЕТ ВРАЧА ───────────────────────────────────────────────────────

test('RPC кабинета: те же строки и та же сумма, что в отчёте', () => {
  const db = seed({ discount: 312000 });
  const mine = doctorInpatientShare(db, { doctor_id: 2, from: FROM, to: TO }, admin);
  assert.equal(mine.fee, 423000);
  assert.equal(mine.count, 1);
  assert.equal(mine.rows[0].service, 'Операция: аппендэктомия');
  assert.equal(mine.rows[0].doctor_role, 'performer');
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(mine.rows[0].date));
  // Назначивший, у которого строку исполнил другой, её не получает.
  const surg = doctorInpatientShare(db, { doctor_id: 1, from: FROM, to: TO }, admin);
  assert.equal(surg.count, 1);
  assert.equal(surg.fee, 18000);
  assert.throws(() => doctorInpatientShare(db, { doctor_id: 'x', from: FROM, to: TO }, admin), /doctor_id/);
});

// ─── 6. АМБУЛАТОРИЯ НЕ ДВИГАЕТСЯ ────────────────────────────────────────────

test('амбулаторные числа те же — есть рядом оплаченный стационар или нет', () => {
  const OUT_COLS = ['Оплаченных услуг', 'Сумма после скидки', 'Средний % врача', 'Услуг по фикс. ставке', 'Доля врача (гонорар)'];
  const pick = (db) => {
    const { out } = salaries(db);
    return OUT_COLS.map((c) => out['Хирургов Х.Х.'][c]);
  };
  const revRow = (db) => {
    const r = report(db, 'total_revenue');
    return r.rows.find((x) => x[col(r, '№ счёта')] === 'INV-OUT');
  };
  // Та же амбулатория без единой строки стационара.
  const bare = openDb(':memory:');
  migrate(bare);
  bare.prepare(`INSERT INTO users (id, username, password_hash, role, full_name, is_doctor, service_rates)
                VALUES (1,'surg','x','doctor','Хирургов Х.Х.',1,?)`)
    .run(JSON.stringify([{ service_id: 2, pct: 40, inpatient_pct: 10, branches: [] }]));
  bare.prepare("INSERT INTO patients (id, mrn, full_name) VALUES (1,'P-1','Азизов Бахтиёр')").run();
  bare.prepare("INSERT INTO services (id, name, price, tax_rate) VALUES (2,'Перевязка',100000,0)").run();
  outpatientVisit(bare);

  const withInpatient = seed();
  outpatientVisit(withInpatient);
  assert.deepEqual(pick(withInpatient), pick(bare));
  assert.deepEqual(pick(bare), [1, 100000, 40, 0, 40000]);
  const a = revRow(bare), b = revRow(withInpatient);
  const r = report(bare, 'total_revenue');
  for (const c of ['Врач', 'Ставка врача', 'Доля врача', 'После скидки', 'Налог']) {
    assert.equal(b[col(r, c)], a[col(r, c)], c);
  }
});

// ─── РЕВЬЮ: I1, I2, M5 ──────────────────────────────────────────────────────

test('I1: исполнитель без стационарной ставки назван во всех трёх отчётах; в «По врачам» — не нулевой строкой', () => {
  const db = seed();
  const NOTE = '1 услуга: исполнитель без стационарной ставки — доля не начислена (Безставкин Б.Б. — 1).';
  for (const kind of ['inpatient_share', 'doctor_salaries', 'by_doctors', 'doctor_services']) {
    const r = report(db, kind);
    assert.ok(r.notes.includes(NOTE), kind + ': ' + r.notes.join(' | '));
  }
  const byDoc = objectsOf(report(db, 'by_doctors'));
  assert.ok(!byDoc.some((o) => o['Врач'] === 'Безставкин Б.Б.'), 'нулевая строка в «По врачам»');
  assert.ok(!objectsOf(report(db, 'doctor_services')).some((o) => o['Врач'] === 'Безставкин Б.Б.'));
  // Со ставкой (даже нулевой — это решение клиники) примечания нет.
  db.prepare("UPDATE users SET service_rates = ? WHERE id = 3").run(JSON.stringify([{ service_id: 1, pct: 25, inpatient_pct: 0 }]));
  assert.ok(!report(db).notes.some((n) => n.includes('без стационарной ставки')));
});

test('I1: врач с амбулаторной работой остаётся строкой, даже если его стационар без ставки', () => {
  const db = seed();
  outpatientVisit(db);   // перевязка врача 1 — амбулаторная работа
  db.prepare('UPDATE admission_services SET performer_id = 1 WHERE id = 5').run();   // операция: ставки у 1 есть (20 %)
  db.prepare("UPDATE users SET service_rates = ? WHERE id = 1").run(JSON.stringify([{ service_id: 2, pct: 40, inpatient_pct: 10 }]));
  const { out, r } = salaries(db);
  assert.ok(out['Хирургов Х.Х.'], 'врач с амбулаторной работой пропал');
  assert.ok(r.notes.some((n) => n.includes('Хирургов Х.Х. — 1')), r.notes.join(' | '));
});

test('I2: «Стационар: доля врачей» говорит, что доля идёт по текущему исполнителю', () => {
  const db = seed();
  const note = 'Доля считается по текущему исполнителю строки: если исполнителя поменять после выставления счёта, доля перейдёт к новому.';
  assert.ok(report(db).notes.includes(note));
  // И это правда: смена исполнителя переносит долю.
  db.prepare('UPDATE admission_services SET performer_id = 1 WHERE id = 1').run();
  const { out } = salaries(db);
  assert.equal(out['Хирургов Х.Х.']['Стационар: гонорар'], 20000 + 188000);   // 20 % от 940 000
});

test('M5: строка стационара, связанная со строкой счёта ДРУГОЙ услуги, доли не даёт', () => {
  const db = seed();
  // Строка стационара «операция» ошибочно указывает на строку счёта перевязки.
  const bandage = db.prepare("SELECT invoice_item_id FROM admission_services WHERE id = 2").get().invoice_item_id;
  db.prepare('UPDATE admission_services SET invoice_item_id = ? WHERE id = 5').run(bandage);
  db.prepare('UPDATE admission_services SET invoice_item_id = NULL WHERE id = 2').run();
  const lines = objectsOf(report(db));
  const onBandage = lines.filter((o) => o['Услуга'] === 'Перевязка');
  assert.equal(onBandage.length, 0, 'перевязка получила долю по строке операции: ' + JSON.stringify(onBandage));
});
