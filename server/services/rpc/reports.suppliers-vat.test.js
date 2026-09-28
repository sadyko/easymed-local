// SUPPLIERS_VAT_V1 (2026-09-28) — НДС в отчётах.
//
//   1. Строка счёта с ТОВАРОМ: налог — НДС, ВКЛЮЧЁННЫЙ в цену продажи товара
//      (сумма после скидки × ставка / (100 + ставка); 112 000 при 12 % → НДС
//      12 000, без НДС 100 000) — и у визита, и у стационара, и у строки без
//      счёта. Услуги — как прежде (сумма после скидки × ставка / 100), доля
//      врача не меняется, с товара она 0. Прежний SQL (__setReportsPushDown
//      (false)) и нынешний дают один ответ (V3120_PERF).
//   2. «Приход по поставщикам»: категория, цена без НДС, ставка и сумма НДС,
//      суммы без и с НДС, цена продажи; фильтр по поставщику; итог периода с НДС
//      и без; приход без записанного НДС — «не указан».
//   3. Выбор поставщика в хабе (report_choices) — за воротами отчёта.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { getRpc } from './index.js';
import { __setReportsPushDown, summableColumns } from './reports.js';
import { isReadOnlyRpc } from '../control/gate.js';

const ADMIN = { id: 1, role: 'admin', extra_roles: [] };
const INV = { id: 3, role: 'inventory', extra_roles: [] };
const NURSE = { id: 4, role: 'nurse', extra_roles: [] };
const FROM = '2020-01-01';
const TO = '2099-12-31';
const run = (db, kind, extra = {}, user = ADMIN) => getRpc('run_report')(db, { kind, from: FROM, to: TO, ...extra }, user);
const objects = (r) => r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]])));

function seedRevenue() {
  const db = openDb(':memory:'); migrate(db);
  db.prepare(`INSERT INTO users (id, username, password_hash, role, full_name, is_doctor, service_rate_default) VALUES
    (1,'adm','x','admin','Админ',0,0), (2,'doc','x','doctor','Хирургов',1,20), (3,'inv','x','inventory','Склад',0,0), (4,'nur','x','nurse','Сестра',0,0)`).run();
  db.prepare("INSERT INTO services (id, name, price, tax_rate, type) VALUES (1, 'Перевязка', 100000, 12, 'procedure')").run();
  db.prepare(`INSERT INTO products (id, name, sale_price, vat_rate, procurement_category) VALUES
    (1, 'Бинт', 56000, 12, 'consumables'), (2, 'Шприц', 1000, NULL, 'consumables'), (3, 'Маска', 800, 0, 'consumables')`).run();
  db.prepare("INSERT INTO patients (id, mrn, full_name) VALUES (1, 'A-1', 'Азизов А.')").run();
  const now = new Date().toISOString();
  const visit = () => db.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date, status) VALUES (1, 2, ?, 'arrived')").run(now).lastInsertRowid;
  const v = visit();
  const vs = db.prepare('INSERT INTO visit_services (visit_id, service_id, clinic_item_id, doctor_id, quantity, unit_price, total, status) VALUES (?,?,?,?,?,?,?,?)');
  const l1 = vs.run(v, 1, null, 2, 1, 100000, 100000, 'completed').lastInsertRowid;
  const l2 = vs.run(v, null, 1, 2, 2, 56000, 112000, 'added').lastInsertRowid;
  const l3 = vs.run(v, null, 2, 2, 1, 1000, 1000, 'added').lastInsertRowid;
  const l4 = vs.run(v, null, 3, 2, 1, 800, 800, 'added').lastInsertRowid;
  // Скидка счёта 10 %: налог — от суммы ПОСЛЕ скидки и у услуги, и у товара.
  const inv = db.prepare(`INSERT INTO invoices (invoice_number, visit_id, patient_id, subtotal, discount_amount, total_amount, paid_amount, status, created_at, paid_at)
                          VALUES ('INV-1', ?, 1, 213800, 21380, 192420, 192420, 'paid', ?, ?)`).run(v, now, now).lastInsertRowid;
  const ii = db.prepare('INSERT INTO invoice_items (invoice_id, service_id, description, quantity, unit_price, total) VALUES (?,?,?,?,?,?)');
  const link = db.prepare('UPDATE visit_services SET invoice_item_id = ? WHERE id = ?');
  link.run(ii.run(inv, 1, 'Перевязка', 1, 100000, 100000).lastInsertRowid, l1);
  link.run(ii.run(inv, null, 'Бинт', 2, 56000, 112000).lastInsertRowid, l2);
  link.run(ii.run(inv, null, 'Шприц', 1, 1000, 1000).lastInsertRowid, l3);
  link.run(ii.run(inv, null, 'Маска', 1, 800, 800).lastInsertRowid, l4);
  db.prepare("INSERT INTO payments (invoice_id, amount, method, paid_at, cashier_id) VALUES (?, 192420, 'cash', ?, 1)").run(inv, now);
  // Второй визит — бинт на 112 000 без скидки: НДС 12 000, без НДС 100 000.
  const v2 = visit();
  const l5 = vs.run(v2, null, 1, 2, 2, 56000, 112000, 'added').lastInsertRowid;
  const inv2 = db.prepare(`INSERT INTO invoices (invoice_number, visit_id, patient_id, subtotal, discount_amount, total_amount, paid_amount, status, created_at)
                           VALUES ('INV-2', ?, 1, 112000, 0, 112000, 0, 'unpaid', ?)`).run(v2, now).lastInsertRowid;
  link.run(ii.run(inv2, null, 'Бинт', 2, 56000, 112000).lastInsertRowid, l5);
  // Третий визит — бинт выдан и строка завершена, счёта ещё нет (строка
  // выплаты без счёта: её деньги считает payLineMoney, а не SQL счёта).
  vs.run(visit(), null, 1, 2, 2, 56000, 112000, 'completed');
  // Стационар: бинт в счёте госпитализации.
  const adm = db.prepare("INSERT INTO admissions (patient_id, doctor_id, status, admission_no, admitted_at) VALUES (1, 2, 'active', 'A-1', ?)").run(now).lastInsertRowid;
  const ainv = db.prepare(`INSERT INTO invoices (invoice_number, patient_id, admission_id, subtotal, discount_amount, total_amount, paid_amount, status, created_at)
                           VALUES ('ADM-1', 1, ?, 112000, 0, 112000, 0, 'unpaid', ?)`).run(adm, now).lastInsertRowid;
  const aii = ii.run(ainv, null, 'Бинт', 2, 56000, 112000).lastInsertRowid;
  db.prepare(`INSERT INTO admission_services (admission_id, clinic_item_id, doctor_id, quantity, unit_price, total, status, billable, invoice_item_id, performed_at)
              VALUES (?, 1, 2, 2, 56000, 112000, 'added', 1, ?, ?)`).run(adm, aii, now);
  return db;
}

test('налог строки товара — НДС, включённый в цену: 112 000 при 12 % → НДС 12 000, без НДС 100 000; услуги — как прежде', () => {
  const db = seedRevenue();
  const rev = run(db, 'total_revenue');
  const rows = objects(rev);
  const line = (inv, name) => rows.find((o) => o['№ счёта'] === inv && o['Услуга'] === name);
  // Товар без скидки — ровно пример владельца.
  assert.equal(line('INV-2', 'Бинт')['Налог %'], 12);
  assert.equal(line('INV-2', 'Бинт')['Налог'], 12000, '112 000 × 12 / 112');
  assert.equal(line('INV-2', 'Бинт')['в т.ч. НДС (товары)'], 12000);
  assert.equal(line('ADM-1', 'Бинт')['Налог'], 12000, 'товар в счёте госпитализации');
  // Со скидкой счёта 10 %: 100 800 × 12 / 112 = 10 800.
  assert.equal(line('INV-1', 'Бинт')['После скидки'], 100800);
  assert.equal(line('INV-1', 'Бинт')['Налог'], 10800);
  assert.equal(line('INV-1', 'Бинт')['Доля врача'], 0);
  assert.equal(line('INV-1', 'Шприц')['Налог %'], 0, '«без НДС»');
  assert.equal(line('INV-1', 'Шприц')['Налог'], 0);
  assert.equal(line('INV-1', 'Шприц')['в т.ч. НДС (товары)'], null, '«без НДС» — НДС нет вовсе');
  assert.equal(line('INV-1', 'Маска')['Налог'], 0, '0 %');
  assert.equal(line('INV-1', 'Маска')['в т.ч. НДС (товары)'], 0);
  // Услуга — прежняя формула (× ставка / 100), доля врача та же: (90 000 − 10 800) × 20 %.
  assert.equal(line('INV-1', 'Перевязка')['Налог %'], 12);
  assert.equal(line('INV-1', 'Перевязка')['Налог'], 10800, '(100 000 − 10 %) × 12 / 100');
  assert.equal(line('INV-1', 'Перевязка')['в т.ч. НДС (товары)'], null);
  assert.equal(line('INV-1', 'Перевязка')['Доля врача'], 15840);
  assert.ok(rev.notes.includes('У товаров «Налог» — НДС, включённый в цену продажи: сумма после скидки × ставка / (100 + ставка), при 12 % — 12/112 суммы; он же — в колонке «в т.ч. НДС (товары)». У услуг «Налог» считается, как прежде: сумма после скидки × ставка.'),
    rev.notes.join(' | '));
  assert.ok(rev.summable_columns.includes('в т.ч. НДС (товары)'));
  // «По услугам»: у бинта без НДС остаётся 90 000 + 100 000 (амбулатория) и 100 000 (стационар).
  const bySvc = run(db, 'by_services');
  const bint = objects(bySvc).filter((o) => o['Услуга'] === 'Бинт');
  const out = bint.find((o) => o['Где'] === 'Амбулатория');
  const inp = bint.find((o) => o['Где'] === 'Стационар');
  assert.deepEqual([out['Налог'], out['После скидки и налога'], out['Остаток клинике']], [22800, 190000, 190000]);
  assert.deepEqual([inp['Налог'], inp['После скидки и налога']], [12000, 100000]);
  assert.ok(bint.every((o) => o['Доля врача'] === 0));
  assert.ok(bySvc.notes.some((n) => n.startsWith('У товаров «Налог» — НДС, включённый в цену продажи')));
  // Строка без счёта (выдано, счёта нет) — тот же НДС: кабинет врача показывает её деньги.
  const pay = getRpc('doctor_pay_summary')(db, { doctor_id: 2, from: FROM, to: TO }, ADMIN);
  const unbilled = pay.lines.find((l) => !l.invoiced && l.service === 'Бинт');
  assert.ok(unbilled, 'строка без счёта в кабинете');
  assert.deepEqual([unbilled.amount, unbilled.tax, unbilled.net, unbilled.fee], [112000, 12000, 100000, 0]);
  db.close();
});

test('прежний и нынешний SQL отчётов дают один ответ и с товарами под НДС (V3120_PERF)', () => {
  const db = seedRevenue();
  const kinds = ['total_revenue', 'by_services', 'surgery_profit', 'doctor_salaries', 'by_doctors', 'doctor_services', 'doctor_lines',
    'by_specialty', 'referrals', 'referrals_detail', 'inpatient_share'];
  for (const kind of kinds) {
    const out = [];
    for (const on of [false, true]) {
      __setReportsPushDown(on);
      try { out.push(run(db, kind)); } finally { __setReportsPushDown(true); }
    }
    assert.deepEqual(out[1], out[0], kind);
  }
  const owner = [false, true].map((on) => { __setReportsPushDown(on); try { return getRpc('owner_report')(db, { from: FROM, to: TO }, ADMIN); } finally { __setReportsPushDown(true); } });
  assert.deepEqual(owner[1], owner[0]);
  const pay = [false, true].map((on) => { __setReportsPushDown(on); try { return getRpc('doctor_pay_summary')(db, { doctor_id: 2, from: FROM, to: TO }, ADMIN); } finally { __setReportsPushDown(true); } });
  assert.deepEqual(pay[1], pay[0]);
  db.close();
});

// ---------------------------------------------------------------------------
// Приход по поставщикам
// ---------------------------------------------------------------------------
function seedReceipts() {
  const db = openDb(':memory:'); migrate(db);
  db.prepare(`INSERT INTO users (id, username, password_hash, role, full_name) VALUES
    (1,'adm','x','admin','Админ'), (3,'inv','x','inventory','Склад'), (4,'nur','x','nurse','Сестра')`).run();
  const sup = (name, active = 1) => Number(db.prepare('INSERT INTO suppliers (name, active) VALUES (?, ?)').run(name, active).lastInsertRowid);
  const A = sup('ООО Аптека'); const B = sup('ООО Бинты'); const OLD = sup('ООО Старый', 0); sup('ООО Без приходов');
  const save = (args) => getRpc('product_save')(db, args, INV).product.id;
  const para = save({ name: 'Парацетамол', procurement_category: 'medicines', base_unit: 'таб', purchase_unit: 'уп', pack_factor: 10, sale_price: 200, vat_rate: 12 });
  const bint = save({ name: 'Бинт', procurement_category: 'consumables', sale_price: 3000, vat_rate: null });
  const recv = (lines) => getRpc('receive_stock_lines')(db, { lines }, INV);
  recv([{ product_id: para, unit: 'purchase', qty: 2, unit_cost: 1000, vat_rate: 12, supplier_id: A, batch_no: 'P-1' }]);
  recv([{ product_id: bint, unit: 'base', qty: 10, unit_cost: 2000, vat_rate: null, supplier_id: B }]);
  recv([{ product_id: bint, unit: 'base', qty: 5, unit_cost: 1900, supplier_id: OLD }]);   // старый вызов: НДС не указан
  return { db, A, B, OLD, para, bint };
}

test('приход по поставщикам: тип, цена без НДС, ставка и сумма НДС, суммы без и с НДС, цена продажи', () => {
  const { db } = seedReceipts();
  const r = run(db, 'procurement');
  for (const c of ['Категория', 'Цена за ед. без НДС', 'Ставка НДС', 'Сумма без НДС', 'НДС', 'Сумма с НДС', 'Цена продажи']) {
    assert.ok(r.columns.includes(c), c);
  }
  const rows = objects(r);
  const para = rows.find((o) => o['Товар'] === 'Парацетамол');
  assert.equal(para['Поставщик'], 'ООО Аптека');
  assert.equal(para['Категория'], 'Медикаменты');
  assert.equal(para['Количество'], 20);
  assert.equal(para['Ед.'], 'таб');
  assert.equal(para['Цена за ед. без НДС'], 100, 'упаковка 1000 без НДС = 100 за таблетку');
  assert.equal(para['Ставка НДС'], '12 %');
  assert.equal(para['Сумма без НДС'], 2000);
  assert.equal(para['НДС'], 240);
  assert.equal(para['Сумма с НДС'], 2240);
  assert.equal(para['Цена продажи'], 200);
  assert.equal(para['Партия'], 'P-1');
  const bintB = rows.find((o) => o['Поставщик'] === 'ООО Бинты');
  assert.deepEqual([bintB['Ставка НДС'], bintB['НДС'], bintB['Сумма без НДС'], bintB['Сумма с НДС'], bintB['Категория']], ['без НДС', 0, 20000, 20000, 'Расходники']);
  const bintOld = rows.find((o) => o['Поставщик'] === 'ООО Старый');
  assert.deepEqual([bintOld['Ставка НДС'], bintOld['НДС'], bintOld['Сумма без НДС'], bintOld['Сумма с НДС']], ['не указан', null, 9500, 9500]);
  assert.ok(r.notes.includes('Итого за период: без НДС 31 500 сум, НДС 240 сум, с НДС 31 740 сум.'), r.notes.join(' | '));
  assert.ok(r.notes.some((n) => n.startsWith('Ставка «не указан»')), 'объяснение «не указан»');
  assert.equal(r.by_building[0].total, 31740, 'итог здания — сколько заплачено (с НДС)');
  // Шаблон итога едет рядом — экран переводит его на язык интерфейса.
  const i = r.notes.indexOf('Итого за период: без НДС 31 500 сум, НДС 240 сум, с НДС 31 740 сум.');
  assert.deepEqual(r.notes_t[i], { template: 'Итого за период: без НДС {net} сум, НДС {vat} сум, с НДС {gross} сум.', params: { net: '31 500', vat: '240', gross: '31 740' } });
  // «Итого» под таблицей складывает деньги, но не цены за единицу и не ставку.
  assert.deepEqual(r.summable_columns.filter((c) => ['Сумма без НДС', 'НДС', 'Сумма с НДС', 'Цена за ед. без НДС', 'Цена продажи', 'Ставка НДС', 'Количество'].includes(c)).sort(),
    ['НДС', 'Сумма без НДС', 'Сумма с НДС']);
  assert.deepEqual(summableColumns('procurement', ['Цена за ед. без НДС', 'Цена продажи', 'Ставка НДС', 'НДС']), ['НДС']);
  db.close();
});

test('приход по поставщикам: отбор по поставщику и по типу; итог и примечание — по отобранному', () => {
  const { db, A, B } = seedReceipts();
  const onlyB = run(db, 'procurement', { supplier_id: String(B) });
  assert.deepEqual(objects(onlyB).map((o) => o['Поставщик']), ['ООО Бинты']);
  assert.equal(onlyB.by_building[0].total, 20000);
  assert.ok(onlyB.notes.includes('Поставщик: «ООО Бинты» — приходы других поставщиков в отчёт и итоги не вошли.'), onlyB.notes.join(' | '));
  assert.ok(onlyB.notes.includes('Итого за период: без НДС 20 000 сум, НДС 0 сум, с НДС 20 000 сум.'), onlyB.notes.join(' | '));
  assert.ok(!onlyB.notes.some((n) => n.startsWith('Ставка «не указан»')));
  const med = run(db, 'procurement', { category: 'medicines' });
  assert.deepEqual(objects(med).map((o) => o['Товар']), ['Парацетамол']);
  const both = run(db, 'procurement', { category: 'consumables', supplier_id: A });
  assert.equal(both.rows.length, 0, 'у Аптеки нет расходников');
  for (const bad of ['x', -1, 1.5, {}]) assert.throws(() => run(db, 'procurement', { supplier_id: bad }), (e) => e.status === 400, JSON.stringify(bad));
  assert.doesNotThrow(() => run(db, 'procurement', { supplier_id: '' }));
  db.close();
});

test('выбор поставщика в хабе: действующие и те, от кого был приход; за воротами отчёта; только чтение', () => {
  const { db } = seedReceipts();
  const r = getRpc('report_choices')(db, { kind: 'procurement', arg: 'supplier_id' }, ADMIN);
  assert.deepEqual(r.choices.map(([, name]) => name), ['ООО Аптека', 'ООО Без приходов', 'ООО Бинты', 'ООО Старый']);
  assert.ok(r.choices.every(([id]) => typeof id === 'string'));
  assert.throws(() => getRpc('report_choices')(db, { kind: 'procurement', arg: 'supplier_id' }, NURSE), (e) => e.status === 403);
  assert.equal(isReadOnlyRpc('report_choices'), true);
  db.close();
});

test('ведомость остатков — с категорией товара', () => {
  const { db } = seedReceipts();
  const rows = objects(run(db, 'stock_statement'));
  assert.equal(rows.find((o) => o['Товар'] === 'Парацетамол')['Категория'], 'Медикаменты');
  assert.equal(rows.find((o) => o['Товар'] === 'Бинт')['Категория'], 'Расходники');
  db.close();
});
