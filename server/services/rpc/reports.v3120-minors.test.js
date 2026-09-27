// V3120_FIX — мелкие находки проверки отчётов (решения владельца 27.09):
//   • несуществующий день (2026-02-30, 2026-13-01) — отказ по-русски, а не
//     молча пустой отчёт за чужой период;
//   • выбор зданий без единого опознанного здания — ни одной строки, а не все;
//   • сводка reports_overview читает branch_ids;
//   • «пустой филиал — свой» — только у своего счёта (sync_origin пуст);
//   • «Оборотная ведомость»: «В карточке товара» и «Расхождение» не
//     складываются в подвале;
//   • прежние виды: «services» не теряет строки без услуги каталога,
//     «invoices» называет строки вне итога (total_skip_rows);
//   • «Общая выручка»: ставка процентом и фикс — две числовые колонки;
//   • «Отчёт кассира» называет способы оплаты общим словарём;
//   • telephony_operator_stats проверяет период.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { runReport, reportsOverview, summableColumns } from './reports.js';
import { cashierReport } from './cashier-report.js';
import { telephonyOperatorStats } from './telephony.js';

const admin = { id: 9, role: 'admin' };
const FROM = '2026-09-01';
const TO = '2026-09-30';
const DAY = '2026-09-10T09:00:00Z';
const objects = (r) => r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]])));
const sumCol = (r, col) => objects(r).reduce((n, o) => n + (Number(o[col]) || 0), 0);

function clinic() {
  const db = openDb(':memory:');
  migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, role, full_name, is_doctor, service_rates) VALUES (?,?,?,?,?,?,?)');
  u.run(1, 'doc', 'x', 'doctor', 'Доктор Д.', 1, JSON.stringify([{ service_id: 3, fix: 20000 }]));
  u.run(9, 'adm', 'x', 'admin', 'Администратор', 0, '');
  db.prepare("INSERT INTO patients (id, mrn, full_name) VALUES (1,'P-1','Пациент')").run();
  db.prepare("INSERT INTO services (id, name, price, tax_rate, type) VALUES (3,'Приём',100000,0,'consultation')").run();
  return db;
}
let seq = 0;
function invoice(db, { total, paid = total, status = 'paid', branch = null, origin = null, number = null }) {
  seq += 1;
  const id = db.prepare(`INSERT INTO invoices (invoice_number, patient_id, branch_id, subtotal, discount_amount, total_amount, paid_amount, status, created_at, sync_origin)
                         VALUES (?,1,?,?,0,?,?,?,?,?)`)
    .run(number || 'INV-' + seq, branch, total, total, paid, status, DAY, origin).lastInsertRowid;
  if (paid > 0) {
    db.prepare(`INSERT INTO payments (invoice_id, amount, method, paid_at, sync_origin) VALUES (?,?,?,?,?)`).run(id, paid, 'cash', DAY, origin);
  }
  return id;
}
function item(db, inv, { service = 3, total, description = 'Услуга', origin = null }) {
  return db.prepare('INSERT INTO invoice_items (invoice_id, service_id, description, quantity, unit_price, total, sync_origin) VALUES (?,?,?,1,?,?,?)')
    .run(inv, service, description, total, total, origin).lastInsertRowid;
}
const ownBranch = (db) => db.prepare('SELECT COALESCE(bi.branch_id, (SELECT id FROM branches WHERE letter = bi.letter)) AS id FROM branch_identity bi WHERE id = 1').get().id;

test('дата, которой нет в календаре, — отказ по-русски', () => {
  const db = clinic();
  for (const [from, to] of [['2026-02-30', '2026-03-10'], ['2026-09-01', '2026-13-01'], ['2026-09-31', '2026-10-01']]) {
    assert.throws(() => runReport(db, { kind: 'total_revenue', from, to }, admin),
      (e) => e.status === 400 && /такого дня нет в календаре/.test(e.message), from + '…' + to);
  }
  assert.doesNotThrow(() => runReport(db, { kind: 'total_revenue', from: '2028-02-29', to: '2028-03-01' }, admin));
  assert.throws(() => runReport(db, { kind: 'payments', from: '2026-02-30', to: TO }, admin), (e) => e.status === 400);
});

test('здания: выбор без единого опознанного здания — ни одной строки', () => {
  const db = clinic();
  item(db, invoice(db, { total: 100000 }), { total: 100000 });
  assert.equal(runReport(db, { kind: 'total_revenue', from: FROM, to: TO }, admin).rows.length, 1);
  assert.equal(runReport(db, { kind: 'total_revenue', from: FROM, to: TO, buildings: ['№5', 42] }, admin).rows.length, 0);
  assert.equal(runReport(db, { kind: 'invoices', from: FROM, to: TO, buildings: ['№5'] }, admin).rows.length, 0);
});

test('reports_overview читает branch_ids; приехавший счёт без филиала своим не считается', () => {
  const db = clinic();
  const own = ownBranch(db);
  db.prepare("INSERT INTO branches (id, name, active) VALUES (77,'Второй',1)").run();
  db.prepare("INSERT INTO branches (name, letter, active) VALUES ('Соседнее','B',0)").run();
  item(db, invoice(db, { total: 100000, branch: own }), { total: 100000 });
  item(db, invoice(db, { total: 30000, branch: 77 }), { total: 30000 });
  // Счёт соседнего здания без филиала: прежде «пустой филиал — свой» забирал его.
  item(db, invoice(db, { total: 5000, origin: 'B' }), { total: 5000, origin: 'B' });
  const all = reportsOverview(db, { from: FROM, to: TO }, admin);
  assert.equal(all.cash_collected, 135000);
  const mine = reportsOverview(db, { from: FROM, to: TO, branch_ids: [own] }, admin);
  assert.equal(mine.cash_collected, 100000);
  assert.equal(mine.invoices_created, 1);
  assert.equal(reportsOverview(db, { from: FROM, to: TO, branch_ids: [77] }, admin).cash_collected, 30000);
  assert.equal(sumCol(runReport(db, { kind: 'total_revenue', from: FROM, to: TO, branch_ids: [own] }, admin), 'После скидки'), 100000);
  assert.equal(sumCol(runReport(db, { kind: 'invoices_full', from: FROM, to: TO, branch_ids: [own] }, admin), 'Итого'), 100000);
});

test('«Оборотная ведомость»: количества «В карточке товара» и «Расхождение» не складываются', () => {
  const cols = ['Товар', 'Конец: кол-во', 'Конец: сумма', 'В карточке товара', 'Расхождение'];
  assert.deepEqual(summableColumns('stock_statement', cols), ['Товар', 'Конец: сумма']);
});

test('прежние виды: «services» со строкой без услуги каталога; «invoices» — строки вне итога', () => {
  const db = clinic();
  const inv = invoice(db, { total: 150000 });
  item(db, inv, { total: 100000 });
  item(db, inv, { service: null, description: 'Консультация', total: 50000 });
  const svc = runReport(db, { kind: 'services', from: FROM, to: TO }, admin);
  assert.equal(sumCol(svc, 'Revenue'), 150000);
  assert.ok(objects(svc).some((o) => o.Service === 'Консультация'));
  invoice(db, { total: 40000, paid: 0, status: 'void' });
  invoice(db, { total: 20000, number: 'DEP-A-26-00001' });
  const invs = runReport(db, { kind: 'invoices', from: FROM, to: TO }, admin);
  const numbers = objects(invs).map((o) => o['Invoice #']);
  assert.deepEqual(invs.total_skip_rows.map((i) => numbers[i]).sort(), ['DEP-A-26-00001', 'INV-' + (seq - 1)].sort());
});

test('«Общая выручка»: процент и фикс врача — две числовые колонки', () => {
  const db = clinic();
  const inv = invoice(db, { total: 100000 });
  const it = item(db, inv, { total: 100000 });
  db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (1,1,?,'arrived')").run(DAY);
  db.prepare(`INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, invoice_item_id)
              VALUES (1,3,1,1,100000,100000,'completed',?)`).run(it);
  const r = objects(runReport(db, { kind: 'total_revenue', from: FROM, to: TO }, admin))[0];
  assert.equal(r['Ставка врача'], null);
  assert.equal(r['Фикс врача'], 20000);
  assert.equal(r['Доля врача'], 20000);
});

test('«Отчёт кассира» называет способы оплаты общим словарём кассы', () => {
  const db = clinic();
  const inv = invoice(db, { total: 100000, paid: 0, status: 'unpaid' });
  db.prepare('INSERT INTO payments (invoice_id, amount, method, paid_at) VALUES (?,?,?,?)').run(inv, 60000, 'transfer', DAY);
  db.prepare('INSERT INTO payments (invoice_id, amount, method, paid_at) VALUES (?,?,?,?)').run(inv, 40000, 'wallet', DAY);
  const text = JSON.stringify(cashierReport(db, { from: FROM, to: TO }, admin));
  assert.ok(text.includes('Перевод'), 'transfer — «Перевод», как в кассе');
  assert.ok(!text.includes('Перечисление'));
  assert.ok(!/"wallet"/.test(text) || text.includes('Кошелёк'), 'кошелёк — словом, а не кодом');
});

test('telephony_operator_stats: период проверяется', () => {
  const db = clinic();
  const bad = (from, to) => assert.throws(() => telephonyOperatorStats(db, { from, to }, admin), (e) => e.status === 400, from + '…' + to);
  bad('вчера', '2026-09-02T00:00:00Z');
  bad('2026-09-01T00:00:00Z', '2026-02-30');
  bad('2026-09-02T00:00:00Z', '2026-09-01T00:00:00Z');
  bad('', '2026-09-01T00:00:00Z');
  db.prepare(`INSERT INTO calls (general_call_id, started_at, internal_number, billsec, call_type)
              VALUES ('c1', '2026-09-01T10:00:00Z', '101', 30, 0)`).run();
  assert.equal(telephonyOperatorStats(db, { from: '2026-09-01T00:00:00.000Z', to: '2026-09-02T00:00:00.000Z' }, admin)[0].calls, 1);
  assert.equal(telephonyOperatorStats(db, { from: '2026-09-01', to: '2026-09-02' }, admin)[0].calls, 1);
});
