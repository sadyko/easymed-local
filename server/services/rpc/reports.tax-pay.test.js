// REPORTS_TAX_PAY_V1 (владелец, 2026-11-07) — во всех окнах отчётов: сумма без
// НДС / НДС / сумма с НДС, способ оплаты (смешанная оплата делится по
// способам) и фильтры, применённые ДО выгрузки в Excel.
//
// НДС — правило владельца 2026-09-29 (SUPPLIERS_VAT_V1): налог внутри цены,
// сумма после скидки × ставка / 100. 112 000 при 12 % → НДС 13 440, без НДС
// 98 560 (тот же пример, что reports.suppliers-vat.test.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { getRpc } from './index.js';

const ADMIN = { id: 1, role: 'admin', extra_roles: [] };
const FROM = '2026-11-01';
const TO = '2026-11-30';
const AT = '2026-11-05T06:00:00Z';   // 11:00 по Ташкенту
const run = (db, kind, extra = {}, user = ADMIN) => getRpc('run_report')(db, { kind, from: FROM, to: TO, ...extra }, user);
const objects = (r) => r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]])));
const sum = (r, col) => {
  const i = r.columns.indexOf(col);
  assert.ok(i > -1, 'нет колонки «' + col + '»');
  return Math.round(r.rows.reduce((n, row) => n + (Number(row[i]) || 0), 0) * 100) / 100;
};

// Клиника: два врача, два кассира, группа пациентов VIP.
//   INV-1 — анализ (лаборатория, без НДС) 100 000, пациент VIP, врач Лабов:
//           60 000 наличными (кассир А) + 40 000 картой (кассир Б);
//   INV-2 — консультация (12 %) 112 000, врач Терапевтов: перевод 112 000 (кассир А);
//   INV-3 — анализ 50 000, не оплачен.
export function seed() {
  const db = openDb(':memory:'); migrate(db);
  db.prepare(`INSERT INTO users (id, username, password_hash, role, full_name, is_doctor, service_rate_default) VALUES
    (1,'adm','x','admin','Админ',0,0),
    (2,'lab','x','doctor','Лабов',1,10),
    (3,'ter','x','doctor','Терапевтов',1,20),
    (5,'ca','x','cashier','Кассир А',0,0),
    (6,'cb','x','cashier','Кассир Б',0,0)`).run();
  const vip = db.prepare("INSERT INTO patient_categories (name, discount_percent, active) VALUES ('VIP', 0, 1)").run().lastInsertRowid;
  db.prepare('INSERT INTO patients (id, mrn, full_name, category_id) VALUES (1, ?, ?, ?)').run('A-1', 'Азизов А.', vip);
  db.prepare("INSERT INTO patients (id, mrn, full_name) VALUES (2, 'B-2', 'Бобров Б.')").run();
  db.prepare("INSERT INTO services (id, name, price, tax_rate, type, is_lab) VALUES (1, 'Анализ крови', 100000, 0, 'lab', 1)").run();
  db.prepare("INSERT INTO services (id, name, price, tax_rate, type) VALUES (2, 'Консультация', 112000, 12, 'consultation')").run();
  const visit = (pid, doc) => db.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date, status) VALUES (?, ?, ?, 'arrived')").run(pid, doc, AT).lastInsertRowid;
  const inv = (no, vid, pid, total, paid, status) => db.prepare(`INSERT INTO invoices (invoice_number, visit_id, patient_id, subtotal, discount_amount, total_amount, paid_amount, status, created_at)
      VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)`).run(no, vid, pid, total, total, paid, status, AT).lastInsertRowid;
  const line = (invId, vid, sid, doc, price) => {
    const ii = db.prepare('INSERT INTO invoice_items (invoice_id, service_id, description, quantity, unit_price, total) VALUES (?, ?, ?, 1, ?, ?)')
      .run(invId, sid, sid === 1 ? 'Анализ крови' : 'Консультация', price, price).lastInsertRowid;
    db.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, invoice_item_id) VALUES (?, ?, ?, 1, ?, ?, 'completed', ?)")
      .run(vid, sid, doc, price, price, ii);
  };
  const payment = (invId, amount, method, cashier) => db.prepare('INSERT INTO payments (invoice_id, amount, method, cashier_id, paid_at) VALUES (?, ?, ?, ?, ?)')
    .run(invId, amount, method, cashier, AT);
  const v1 = visit(1, 2); const i1 = inv('INV-1', v1, 1, 100000, 100000, 'paid'); line(i1, v1, 1, 2, 100000);
  payment(i1, 60000, 'cash', 5); payment(i1, 40000, 'card', 6);
  const v2 = visit(2, 3); const i2 = inv('INV-2', v2, 2, 112000, 112000, 'paid'); line(i2, v2, 2, 3, 112000);
  payment(i2, 112000, 'transfer', 5);
  const v3 = visit(2, 2); const i3 = inv('INV-3', v3, 2, 50000, 0, 'unpaid'); line(i3, v3, 1, 2, 50000);
  return { db, vip };
}

test('НДС: «Общая выручка» — без НДС / НДС / с НДС; 112 000 при 12 % → 98 560 + 13 440', () => {
  const { db } = seed();
  const r = run(db, 'total_revenue');
  const rows = objects(r);
  const cons = rows.find((o) => o['№ счёта'] === 'INV-2');
  assert.equal(cons['Сумма с НДС'], 112000);
  assert.equal(cons['НДС'], 13440);
  assert.equal(cons['Сумма без НДС'], 98560);
  // Анализ без ставки — НДС 0, обе суммы равны.
  for (const o of rows.filter((x) => x['№ счёта'] !== 'INV-2')) {
    assert.equal(o['НДС'], 0);
    assert.equal(o['Сумма без НДС'], o['Сумма с НДС']);
  }
  // «Итого» складывает все три; без НДС + НДС = с НДС.
  for (const c of ['Сумма без НДС', 'НДС', 'Сумма с НДС']) assert.ok(r.summable_columns.includes(c), c);
  assert.equal(sum(r, 'Сумма с НДС'), 262000);
  assert.equal(sum(r, 'НДС'), 13440);
  assert.equal(sum(r, 'Сумма без НДС') + sum(r, 'НДС'), sum(r, 'Сумма с НДС'));
  // Прежние колонки на месте и сходятся с новыми.
  assert.equal(sum(r, 'После скидки'), sum(r, 'Сумма с НДС'));
  assert.equal(sum(r, 'Налог'), sum(r, 'НДС'));
  db.close();
});

test('НДС: «Счета», «По услугам», «Рентабельность», «Рефералы», врачи и стационар — те же три колонки', () => {
  const { db } = seed();
  const inv = objects(run(db, 'invoices_full'));
  const i2 = inv.filter((o) => o['№ счёта'] === 'INV-2');
  assert.equal(i2.reduce((n, o) => n + o['НДС'], 0), 13440);
  assert.equal(i2.reduce((n, o) => n + o['Сумма с НДС'], 0), 112000);
  assert.equal(i2.reduce((n, o) => n + o['Сумма без НДС'], 0), 98560);
  const bs = objects(run(db, 'by_services'));
  const c = bs.find((o) => o['Услуга'] === 'Консультация');
  assert.deepEqual([c['Сумма без НДС'], c['НДС'], c['Сумма с НДС']], [98560, 13440, 112000]);
  for (const kind of ['doctor_salaries', 'by_doctors', 'doctor_services', 'doctor_lines', 'by_specialty', 'referrals', 'referrals_detail', 'surgery_profit', 'inpatient_share']) {
    const r = run(db, kind);
    for (const col of ['Сумма без НДС', 'НДС', 'Сумма с НДС']) assert.ok(r.columns.includes(col), kind + ': нет «' + col + '»');
  }
  const sal = run(db, 'doctor_salaries');
  assert.equal(sum(sal, 'НДС'), 13440);
  assert.equal(sum(sal, 'Сумма с НДС'), 262000);
  const dl = run(db, 'doctor_lines');
  assert.equal(sum(dl, 'НДС'), 13440);
  assert.equal(sum(dl, 'Сумма без НДС'), 248560);
  db.close();
});

test('НДС: «Отчёт кассира» — НДС платежа в доле НДС его счёта; отчёт владельца — плитки без НДС и НДС', () => {
  const { db } = seed();
  const cr = getRpc('cashier_report')(db, { from: FROM, to: TO }, ADMIN);
  const income = cr.income.rows.map((row) => Object.fromEntries(cr.income.columns.map((c, i) => [c, row[i]])));
  const tr = income.find((o) => o['Счёт'] === 'INV-2');
  assert.deepEqual([tr['Сумма без НДС'], tr['НДС'], tr['Сумма с НДС']], [98560, 13440, 112000]);
  assert.ok(cr.columns.includes('НДС'));
  const own = getRpc('owner_report')(db, { from: FROM, to: TO }, ADMIN);
  assert.equal(own.kpis.revenue, 262000);
  assert.equal(own.kpis.vat, 13440);
  assert.equal(own.kpis.revenue_net, 248560);
  db.close();
});

// ─── СПОСОБ ОПЛАТЫ ───────────────────────────────────────────────────────────

const byInv = (rows, no) => rows.filter((o) => o['№ счёта'] === no);

test('способ оплаты: «Общая выручка» — смешанная оплата 60 000 + 40 000 — две строки, каждая со своей суммой и кассиром', () => {
  const { db } = seed();
  const r = run(db, 'total_revenue');
  assert.ok(r.columns.includes('Способ оплаты') && r.columns.includes('Кассир'));
  const rows = objects(r);
  const i1 = byInv(rows, 'INV-1');
  assert.deepEqual(i1.map((o) => [o['Способ оплаты'], o['Сумма с НДС'], o['Кассир']]),
    [['Наличные', 60000, 'Кассир А'], ['Карта', 40000, 'Кассир Б']]);
  // Количество — у первой части: «Итого» по количеству не удваивается.
  assert.deepEqual(i1.map((o) => o['Кол-во']), [1, null]);
  // Доля врача разделена в той же доле и в сумме не изменилась (10 % от 100 000).
  assert.equal(i1.reduce((n, o) => n + o['Доля врача'], 0), 10000);
  assert.deepEqual(byInv(rows, 'INV-2').map((o) => [o['Способ оплаты'], o['Сумма с НДС'], o['НДС']]), [['Перевод', 112000, 13440]]);
  assert.deepEqual(byInv(rows, 'INV-3').map((o) => [o['Способ оплаты'], o['Сумма с НДС'], o['Кассир']]), [['Не оплачено', 50000, '']]);
  // Деление не меняет итогов.
  assert.equal(sum(r, 'Сумма с НДС'), 262000);
  assert.equal(sum(r, 'Сумма'), 262000);
  assert.equal(sum(r, 'Кол-во'), 3);
  assert.ok(r.notes.some((n) => n.startsWith('«Способ оплаты»')), 'нет примечания о делении');
  db.close();
});

test('способ оплаты: «Счета» — строка на способ; «Оплачено» и «Остаток» по частям, итог счёта сходится', () => {
  const { db } = seed();
  const rows = objects(run(db, 'invoices_full'));
  const i1 = byInv(rows, 'INV-1');
  assert.deepEqual(i1.map((o) => [o['Способ оплаты'], o['Итого'], o['Оплачено'], o['Остаток / долг'], o['Кассир']]),
    [['Наличные', 60000, 60000, 0, 'Кассир А'], ['Карта', 40000, 40000, 0, 'Кассир Б']]);
  assert.deepEqual(byInv(rows, 'INV-3').map((o) => [o['Способ оплаты'], o['Итого'], o['Оплачено'], o['Остаток / долг']]),
    [['Не оплачено', 50000, 0, 50000]]);
  db.close();
});

test('способ оплаты: частично оплаченный счёт — часть способа и часть «Не оплачено»', () => {
  const { db } = seed();
  db.prepare("UPDATE invoices SET paid_amount = 20000, status = 'partial' WHERE invoice_number = 'INV-3'").run();
  db.prepare("INSERT INTO payments (invoice_id, amount, method, cashier_id, paid_at) SELECT id, 20000, 'card', 6, ? FROM invoices WHERE invoice_number = 'INV-3'").run(AT);
  const rows = objects(run(db, 'total_revenue'));
  assert.deepEqual(byInv(rows, 'INV-3').map((o) => [o['Способ оплаты'], o['Сумма с НДС']]), [['Карта', 20000], ['Не оплачено', 30000]]);
  const inv = objects(run(db, 'invoices_full'));
  assert.deepEqual(byInv(inv, 'INV-3').map((o) => [o['Способ оплаты'], o['Итого'], o['Оплачено'], o['Остаток / долг']]),
    [['Карта', 20000, 20000, 0], ['Не оплачено', 30000, 0, 30000]]);
  db.close();
});

test('способ оплаты: «Рентабельность операций» — операция, оплаченная двумя способами, двумя строками', () => {
  const { db } = seed();
  db.prepare("INSERT INTO services (id, name, price, tax_rate, type) VALUES (3, 'Аппендэктомия', 1000000, 0, 'other')").run();
  const v = db.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date, status) VALUES (2, 3, ?, 'arrived')").run(AT).lastInsertRowid;
  const inv = db.prepare(`INSERT INTO invoices (invoice_number, visit_id, patient_id, subtotal, discount_amount, total_amount, paid_amount, status, created_at)
                          VALUES ('INV-4', ?, 2, 1000000, 0, 1000000, 1000000, 'paid', ?)`).run(v, AT).lastInsertRowid;
  db.prepare("INSERT INTO invoice_items (invoice_id, service_id, description, quantity, unit_price, total) VALUES (?, 3, 'Аппендэктомия', 1, 1000000, 1000000)").run(inv);
  db.prepare("INSERT INTO payments (invoice_id, amount, method, cashier_id, paid_at) VALUES (?, 700000, 'cash', 5, ?), (?, 300000, 'acquiring', 5, ?)").run(inv, AT, inv, AT);
  const rows = objects(run(db, 'surgery_profit'));
  assert.deepEqual(rows.map((o) => [o['Способ оплаты'], o['Сумма по счёту']]), [['Наличные', 700000], ['Эквайринг', 300000]]);
  db.close();
});

test('способ оплаты: где строка не делится (выплата врачу, стационар, рефералы, реестр) — способы счёта словами', () => {
  const { db } = seed();
  const dl = objects(run(db, 'doctor_lines'));
  assert.equal(dl.find((o) => o['№ счёта'] === 'INV-1')['Способ оплаты'], 'Наличные, Карта');
  assert.equal(dl.find((o) => o['№ счёта'] === 'INV-3')['Способ оплаты'], '');
  for (const kind of ['inpatient_share', 'referrals_detail']) {
    assert.ok(run(db, kind).columns.includes('Способ оплаты'), kind + ': нет «Способа оплаты»');
  }
  db.close();
});

test('«Отчёт кассира»: разрез по способам совпадает с итогом смены кассира', () => {
  const { db } = seed();
  // Смена кассира А: его платежи в ней.
  const sh = db.prepare("INSERT INTO cash_shifts (cashier_id, status, opened_at) VALUES (5, 'open', ?)").run(AT).lastInsertRowid;
  db.prepare('UPDATE payments SET shift_id = ? WHERE cashier_id = 5').run(sh);
  const shift = getRpc('cash_shift_summary')(db, {}, { id: 5, role: 'cashier', extra_roles: [] });
  const cr = getRpc('cashier_report')(db, { from: FROM, to: TO, cashier_id: 5 }, ADMIN);
  assert.equal(cr.kpi.by_method.cash, shift.totals.cash);
  assert.equal(cr.kpi.by_method.transfer, shift.totals.transfer);
  assert.equal(cr.kpi.income, shift.totals.total);
  // Без фильтра — вся касса периода по способам.
  const all = getRpc('cashier_report')(db, { from: FROM, to: TO }, ADMIN);
  assert.deepEqual(all.kpi.by_method, { cash: 60000, card: 40000, transfer: 112000 });
  // И «Общая выручка» по способам — те же деньги (все счета оплачены в периоде).
  const rev = objects(run(db, 'total_revenue'));
  const byM = (m) => rev.filter((o) => o['Способ оплаты'] === m).reduce((n, o) => n + o['Сумма с НДС'], 0);
  assert.deepEqual([byM('Наличные'), byM('Карта'), byM('Перевод')], [60000, 40000, 112000]);
  db.close();
});

// ─── ФИЛЬТРЫ (до выгрузки в Excel) ───────────────────────────────────────────

test('фильтр «Карта» (пример владельца): «Общая выручка» — только карточная часть, 40 000', () => {
  const { db, vip } = seed();
  const card = run(db, 'total_revenue', { pay_method: 'card' });
  assert.deepEqual(objects(card).map((o) => [o['№ счёта'], o['Способ оплаты'], o['Сумма с НДС']]), [['INV-1', 'Карта', 40000]]);
  assert.equal(sum(card, 'Сумма с НДС'), 40000);
  assert.equal(sum(run(db, 'total_revenue', { pay_method: 'cash' }), 'Сумма с НДС'), 60000);
  assert.equal(sum(run(db, 'total_revenue', { pay_method: 'unpaid' }), 'Сумма с НДС'), 50000);
  assert.equal(sum(run(db, 'total_revenue', { cashier_id: 6 }), 'Сумма с НДС'), 40000);
  assert.equal(sum(run(db, 'total_revenue', { cashier_id: '5' }), 'Сумма с НДС'), 172000);
  assert.equal(sum(run(db, 'total_revenue', { cashier_id: 5, pay_method: 'transfer' }), 'Сумма с НДС'), 112000);
  // Врач, группа услуг, группа пациентов.
  assert.deepEqual(objects(run(db, 'total_revenue', { doctor_id: 3 })).map((o) => o['№ счёта']), ['INV-2']);
  assert.equal(sum(run(db, 'total_revenue', { group: 'lab' }), 'Сумма с НДС'), 150000);
  assert.deepEqual([...new Set(objects(run(db, 'total_revenue', { patient_group: vip })).map((o) => o['№ счёта']))], ['INV-1']);
  // Фильтры складываются: VIP + карта.
  assert.equal(sum(run(db, 'total_revenue', { patient_group: vip, pay_method: 'card' }), 'Сумма с НДС'), 40000);
  db.close();
});

test('фильтры: «Счета», «По услугам», «Рентабельность» — те же правила', () => {
  const { db, vip } = seed();
  const inv = objects(run(db, 'invoices_full', { pay_method: 'card' }));
  assert.deepEqual(inv.map((o) => [o['№ счёта'], o['Итого'], o['Оплачено'], o['Кассир']]), [['INV-1', 40000, 40000, 'Кассир Б']]);
  assert.deepEqual([...new Set(objects(run(db, 'invoices_full', { doctor_id: 3 })).map((o) => o['№ счёта']))], ['INV-2']);
  assert.deepEqual([...new Set(objects(run(db, 'invoices_full', { patient_group: vip })).map((o) => o['№ счёта']))], ['INV-1']);
  assert.deepEqual([...new Set(objects(run(db, 'invoices_full', { group: 'consultation' })).map((o) => o['№ счёта']))], ['INV-2']);
  const bs = objects(run(db, 'by_services', { pay_method: 'card' }));
  assert.deepEqual(bs.map((o) => [o['Услуга'], o['Сумма'], o['Сумма с НДС'], o['Оплачено (доля оплаты счёта)']]), [['Анализ крови', 40000, 40000, 40000]]);
  assert.deepEqual(objects(run(db, 'by_services', { doctor_id: 3 })).map((o) => o['Услуга']), ['Консультация']);
  assert.deepEqual(objects(run(db, 'by_services', { patient_group: vip })).map((o) => [o['Услуга'], o['Сумма']]), [['Анализ крови', 100000]]);
  assert.deepEqual(run(db, 'surgery_profit', { doctor_id: 2, pay_method: 'card' }).rows, []);
  db.close();
});

test('фильтры: выплата врачам — врач; работа — группа услуг и группа пациентов', () => {
  const { db, vip } = seed();
  assert.deepEqual(objects(run(db, 'doctor_salaries', { doctor_id: 3 })).map((o) => o['Врач']), ['Терапевтов']);
  assert.deepEqual(objects(run(db, 'by_doctors', { doctor_id: 2 })).map((o) => o['Врач']), ['Лабов']);
  assert.deepEqual(objects(run(db, 'doctor_lines', { group: 'lab' })).map((o) => o['№ счёта']).sort(), ['INV-1', 'INV-3']);
  assert.deepEqual(objects(run(db, 'doctor_lines', { patient_group: vip })).map((o) => o['№ счёта']), ['INV-1']);
  assert.deepEqual(objects(run(db, 'doctor_services', { group: 'consultation' })).map((o) => o['Услуга']), ['Консультация']);
  assert.deepEqual(objects(run(db, 'by_specialty', { group: 'consultation' })).map((o) => o['Услуга']), ['Консультация']);
  assert.equal(sum(run(db, 'by_specialty', { doctor_id: 2 }), 'Сумма после скидки'), 150000);
  for (const [kind, extra] of [['inpatient_share', { doctor_id: 2, group: 'lab', patient_group: vip }], ['referrals', { group: 'lab', patient_group: vip }],
    ['referrals_detail', { group: 'lab' }]]) {
    assert.doesNotThrow(() => run(db, kind, extra), kind);
  }
  db.close();
});

test('фильтры: «Отчёт кассира» — карта 40 000; группа пациентов, врач и группа услуг — по счёту платежа', () => {
  const { db, vip } = seed();
  const sh = db.prepare("INSERT INTO cash_shifts (cashier_id, status, opened_at) VALUES (5, 'open', ?)").run(AT).lastInsertRowid;
  db.prepare("INSERT INTO cash_movements (shift_id, kind, amount, article, note, created_by, created_at) VALUES (?, 'out', 5000, 'purchase', 'Бумага', 5, ?)").run(sh, AT);
  const cr = (extra) => getRpc('cashier_report')(db, { from: FROM, to: TO, ...extra }, ADMIN);
  const card = cr({ pay_method: 'card' });
  assert.equal(card.kpi.income, 40000);
  assert.deepEqual(card.kpi.by_method, { card: 40000 });
  assert.equal(card.kpi.expense, 0, 'расход кассы — наличные: у фильтра «Карта» его нет');
  assert.equal(cr({ pay_method: 'cash' }).kpi.expense, 5000);
  assert.equal(cr({ patient_group: vip }).kpi.income, 100000);
  assert.equal(cr({ doctor_id: 3 }).kpi.income, 112000);
  assert.equal(cr({ group: 'lab' }).kpi.income, 100000);
  // Плоская выгрузка — те же строки.
  assert.equal(card.rows.length, 1);
  db.close();
});

test('фильтры: мусор — отказ по-русски, а не молча «все»', () => {
  const { db } = seed();
  assert.throws(() => run(db, 'total_revenue', { pay_method: 'bitcoin' }), /Способ оплаты указан неверно/);
  assert.throws(() => run(db, 'total_revenue', { cashier_id: 'x' }), /Кассир указан неверно/);
  assert.throws(() => run(db, 'invoices_full', { patient_group: -1 }), /Группа пациентов указана неверно/);
  assert.throws(() => getRpc('cashier_report')(db, { from: FROM, to: TO, pay_method: 'x' }, ADMIN), /Способ оплаты указан неверно/);
  db.close();
});

test('списки фильтров (report_choices): кассиры и группы пациентов — за воротами отчёта', () => {
  const { db } = seed();
  const choices = (kind, arg, user = ADMIN) => getRpc('report_choices')(db, { kind, arg }, user).choices;
  assert.deepEqual(choices('total_revenue', 'cashier_id'), [['5', 'Кассир А'], ['6', 'Кассир Б']]);
  assert.ok(choices('total_revenue', 'patient_group').some((c) => c[1] === 'VIP'));
  assert.deepEqual(choices('cashier', 'cashier_id').map((c) => c[1]), ['Кассир А', 'Кассир Б']);
  assert.ok(choices('invoices_full', 'doctor_id').some((c) => c[1] === 'Терапевтов'));
  // Без доступа к отчёту — и списка нет (медсестре «Отчёты» не выданы).
  db.prepare("INSERT INTO users (id, username, password_hash, role, full_name) VALUES (9, 'nur', 'x', 'nurse', 'Сестра')").run();
  assert.throws(() => getRpc('report_choices')(db, { kind: 'total_revenue', arg: 'cashier_id' }, { id: 9, role: 'nurse', extra_roles: [] }),
    (e) => e.status === 403);
  db.close();
});

test('V3120_PERF: прежний SQL (без выноса подзапросов) даёт те же строки с НДС и частями оплаты', async () => {
  const { __setReportsPushDown } = await import('./reports.js');
  const { db } = seed();
  const kinds = [['total_revenue', {}], ['invoices_full', {}], ['by_services', { pay_method: 'card' }], ['invoices_full', { pay_method: 'cash' }]];
  const now = kinds.map(([k, x]) => run(db, k, x).rows);
  __setReportsPushDown(false);
  try {
    kinds.forEach(([k, x], i) => assert.deepEqual(run(db, k, x).rows, now[i], k));
    assert.deepEqual(getRpc('cashier_report')(db, { from: FROM, to: TO }, ADMIN).income.rows.length, 3);
  } finally { __setReportsPushDown(true); }
  db.close();
});

// REPORTS_TAX_PAY_V1 (ревью S2 M1) — «По услугам» с фильтром «Кассир»: один кассир принял одну
// услугу двумя способами (60 000 наличными + 40 000 картой) — обе части его, и «Кол-во» считало
// услугу дважды: splitByPayment оставляет количество только первой части (у остальных null), а
// `Number(null) || 1` возвращало единицу.
test('ревью S2 M1: «По услугам» + «Кассир» — услуга, оплаченная одним кассиром двумя способами, — «Кол-во» 1', () => {
  const { db } = seed();
  db.prepare("UPDATE payments SET cashier_id = 5 WHERE method = 'card'").run();   // INV-1: обе части — кассир А
  const pick = (r) => objects(r).map((o) => [o['Услуга'], o['Кол-во'], o['Сумма']]);
  assert.deepEqual(pick(run(db, 'by_services', { cashier_id: 5 })), [['Консультация', 1, 112000], ['Анализ крови', 1, 100000]]);
  assert.deepEqual(pick(run(db, 'by_services', { pay_method: 'card' })), [['Анализ крови', 1, 40000]]);
  // Без фильтра — как прежде: два анализа (INV-1 и неоплаченный INV-3), одна консультация.
  assert.deepEqual(pick(run(db, 'by_services')), [['Консультация', 1, 112000], ['Анализ крови', 2, 150000]]);
  db.close();
});
