// V3120_FIX — разбор инспекции склада и медикаментов (2026-09-27).
//
// Каждый тест — находка инспекции, проигранная через НАСТОЯЩИЕ обработчики
// (getRpc), как их зовёт экран:
//   • остаток после пересчёта = остаток сейчас + расхождение ЛИСТА;
//   • таблетка из пачки по 7/30 и миллилитр из литра больше не дрейфуют;
//   • журнал не называет выдачу по заявке расходом на пациента;
//   • отметка о введении дозы считает в единице расхода (ампула из коробки);
//   • приход по заказу помнит поставщика, партию и срок; расход — себестоимость;
//   • отключённый товар: из подотчёта можно, со склада нельзя — во всех дверях;
//   • подотчёт отключённого сотрудника возвращается на склад или передаётся.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { getRpc } from './index.js';
import { treatmentOrderCreate, treatmentAdminMark } from './treatment-orders.js';

const U = {
  admin: { id: 1, role: 'admin' },
  inv: { id: 2, role: 'inventory' },
  nurse: { id: 3, role: 'nurse' },
  nurse2: { id: 4, role: 'nurse' },
  doctor: { id: 5, role: 'doctor' },
};

function seed() {
  const db = openDb(':memory:'); migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, role, full_name) VALUES (?,?,?,?,?)');
  u.run(1, 'admin', 'x', 'admin', 'Админ');
  u.run(2, 'inv', 'x', 'inventory', 'Кладовщик');
  u.run(3, 'nurse', 'x', 'nurse', 'Медсестра Ирина');
  u.run(4, 'nurse2', 'x', 'nurse', 'Медсестра Ольга');
  u.run(5, 'doc', 'x', 'doctor', 'Лечащий');
  db.prepare("INSERT INTO suppliers (id, name) VALUES (1, 'Фарм-Опт')").run();
  const P = db.prepare(`INSERT INTO products (id, name, unit, base_unit, consumption_unit, consumption_factor, sale_price, on_hand, avg_cost, is_drug)
                        VALUES (?,?,?,?,?,?,?,?,?,1)`);
  P.run(1, 'Аспирин 30', 'уп', 'уп', 'таб', 30, 30000, 10, 12000);
  P.run(2, 'Физраствор 1л', 'л', 'л', 'мл', 1000, 10000, 10, 4000);
  P.run(3, 'Витамин 7', 'уп', 'уп', 'таб', 7, 7000, 10, 3500);
  P.run(4, 'Кеторол', 'уп', 'уп', 'амп', 10, 50000, 10, 20000);
  P.run(5, 'Бинт', 'шт', 'шт', null, 1, 5000, 10, 2000);
  db.prepare("INSERT INTO patients (id, full_name, mrn) VALUES (1, 'Иванов Иван', 'EM-1')").run();
  db.prepare("INSERT INTO wards (id, name) VALUES (1, 'Палата 1')").run();
  db.prepare("INSERT INTO beds (id, code, ward_id) VALUES (1, '1-1', 1)").run();
  db.prepare("INSERT INTO services (id, name, price) VALUES (1, 'Инъекция', 20000)").run();
  return db;
}
const rpc = (db, name, args, user) => getRpc(name)(db, args, user);
const onHand = (db, id) => db.prepare('SELECT on_hand FROM products WHERE id = ?').get(id).on_hand;
const held = (db, type, id, pid) => (db.prepare('SELECT qty FROM stock_holdings WHERE holder_type = ? AND holder_id = ? AND product_id = ?').get(type, id, pid) || { qty: 0 }).qty;
const visit = (db) => Number(db.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date, status) VALUES (1, 5, strftime('%Y-%m-%dT%H:%M:%SZ','now'), 'arrived')").run().lastInsertRowid);
const admission = (db) => Number(db.prepare("INSERT INTO admissions (patient_id, status, ward_id, bed_id, doctor_id, attending_doctor_id) VALUES (1, 'active', 1, 1, 5, 5)").run().lastInsertRowid);
const issueTo = (db, userId, productId, units) => rpc(db, 'issue_stock_lines', { holder: { type: 'staff', id: userId }, lines: [{ product_id: productId, qty: units, unit: 'consumption' }] }, U.inv);

// ─── Округление: пачка по 7 и по 30, литр по миллилитру ───────────────────────

test('пачка по 7: семь таблеток по одной — на руках ровно ноль, строки нет', () => {
  const db = seed();
  const v = visit(db);
  issueTo(db, 3, 3, 7);
  for (let i = 0; i < 7; i++) rpc(db, 'dispense_from_holding', { holder: { type: 'staff', id: 3 }, product_id: 3, quantity: 1, visit_id: v }, U.nurse);
  assert.equal(held(db, 'staff', 3, 3), 0);
  const mine = rpc(db, 'holdings_list', { mine: true }, U.nurse).holdings;
  assert.equal(mine.filter((h) => h.product_id === 3).length, 0, 'пустой подотчёт не висит строкой');
  // V3120_FIX — восьмая таблетка не берётся из «пыли» на руках: своя полка
  // пуста, и цепочка честно идёт на склад (свой подотчёт → … → склад).
  const eighth = rpc(db, 'dispense_from_holding', { holder: { type: 'staff', id: 3 }, product_id: 3, quantity: 1, visit_id: v }, U.nurse);
  assert.deepEqual(eighth.sources.map((s) => s.type), ['warehouse']);
});

test('пачка по 30: тридцать первую таблетку из тридцати не выдать', () => {
  const db = seed();
  const v = visit(db);
  issueTo(db, 3, 1, 30);
  for (let i = 0; i < 30; i++) rpc(db, 'dispense_from_holding', { holder: { type: 'staff', id: 3 }, product_id: 1, quantity: 1, visit_id: v }, U.nurse);
  assert.equal(held(db, 'staff', 3, 1), 0);
  // Склад отдал ровно одну пачку — и журнал склада это же и говорит.
  assert.equal(onHand(db, 1), 9);
  // V3120_FIX — тридцать первая не берётся с пустых рук: своя полка пуста,
  // цепочка идёт на склад, и склад отдаёт ровно 1/30 пачки.
  const r31 = rpc(db, 'dispense_from_holding', { holder: { type: 'staff', id: 3 }, product_id: 1, quantity: 1, visit_id: v }, U.nurse);
  assert.deepEqual(r31.sources.map((s) => s.type), ['warehouse']);
  assert.equal(onHand(db, 1), 8.966667);
  assert.equal(held(db, 'staff', 3, 1), 0);
});

test('литр: 4 мл выдаются, 5 мл списывают ровно 0.005 л', () => {
  const db = seed();
  const v = visit(db);
  const r = issueTo(db, 3, 2, 4);
  assert.equal(r.issued[0].base_qty, 0.004);
  assert.equal(held(db, 'staff', 3, 2), 0.004);
  assert.equal(onHand(db, 2), 9.996);
  // V3120_FIX — выбран «Склад», но 4 мл лежат у неё на руках: цепочка берёт
  // сначала своё (4 мл), со склада — только недостающий 1 мл.
  const give = rpc(db, 'dispense_from_holding', { holder: { type: 'warehouse' }, product_id: 2, quantity: 5, visit_id: v }, U.nurse);
  assert.deepEqual(give.sources, [{ type: 'staff', id: 3, qty: 0.004 }, { type: 'warehouse', id: null, qty: 0.001 }]);
  assert.equal(held(db, 'staff', 3, 2), 0);
  assert.equal(onHand(db, 2), 9.995);
  const mv = db.prepare("SELECT SUM(qty) s FROM stock_movements WHERE product_id = 2 AND reference_type = 'visit'").get();
  assert.equal(Math.round(mv.s * 1e6) / 1e6, -0.005);
});

test('одобрение заявки на 5 таблеток: движение, склад и подотчёт — одно и то же число', () => {
  const db = seed();
  const rq = rpc(db, 'stock_request_create', { for: 'me', lines: [{ product_id: 1, qty: 5, unit: 'consumption' }] }, U.nurse2);
  rpc(db, 'approve_requisition_and_issue', { req_id: rq.req_id }, U.inv);
  const mv = db.prepare("SELECT qty FROM stock_movements WHERE reference_type = 'requisition'").get();
  const h = held(db, 'staff', 4, 1);
  assert.equal(-mv.qty, h, 'журнал = подотчёт');
  assert.equal(Math.round((10 - onHand(db, 1)) * 1e6) / 1e6, h, 'склад отдал столько же');
  assert.ok(Math.abs(h * 30 - 5) < 1e-4, `5 таблеток, а не ${h * 30}`);
});

test('дверь койки (цепочка) на 1/30 пачки списывает 1/30, а не 0.03', () => {
  const db = seed();
  const adm = admission(db);
  rpc(db, 'dispense_admission_item', { p_admission_id: adm, p_item_id: 1, p_qty: 1 / 30 }, U.nurse);
  assert.equal(onHand(db, 1), 9.966667);
});

// ─── Пересчёт: расхождение листа, а не живой остаток ─────────────────────────

function countSheet(db, productId, systemQty, countedQty) {
  const cid = Number(db.prepare("INSERT INTO stock_counts (count_number, status) VALUES ('SC-1', 'counting')").run().lastInsertRowid);
  db.prepare('INSERT INTO stock_count_items (count_id, product_id, system_qty, counted_qty) VALUES (?,?,?,?)').run(cid, productId, systemQty, countedQty);
  return cid;
}

test('пересчёт: товар ушёл после листа — остаток = сейчас + расхождение листа', () => {
  const db = seed();
  const cid = countSheet(db, 5, 10, 10);   // лист сошёлся: расхождения нет
  rpc(db, 'dispense_item', { product_id: 5, quantity: 2, visit_id: visit(db) }, U.nurse);
  const r = rpc(db, 'post_stock_count', { count_id: cid }, U.inv);
  assert.equal(onHand(db, 5), 8, 'выданные после листа 2 шт не воскресают');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM stock_movements WHERE reference_type = 'stock_count'").get().n, 0);
  assert.equal(r.adjustments[0].delta, 0);
  assert.ok(r.warnings.length === 1 && /после пересчёта/.test(r.warnings[0].message), JSON.stringify(r.warnings));
});

test('пересчёт: недостача по листу списывается с живого остатка, журнал = лист', () => {
  const db = seed();
  const cid = countSheet(db, 5, 10, 9);    // на полке на 1 меньше
  rpc(db, 'dispense_item', { product_id: 5, quantity: 2, visit_id: visit(db) }, U.nurse);
  rpc(db, 'post_stock_count', { count_id: cid }, U.inv);
  assert.equal(onHand(db, 5), 7);
  const mv = db.prepare("SELECT qty, note FROM stock_movements WHERE reference_type = 'stock_count'").get();
  assert.equal(mv.qty, -1, 'движение = расхождение листа');
  const variance = db.prepare('SELECT variance FROM stock_count_items WHERE count_id = ?').get(cid).variance;
  assert.equal(mv.qty, variance);
});

test('пересчёт без движений после листа — как прежде', () => {
  const db = seed();
  const cid = countSheet(db, 5, 10, 12);
  const r = rpc(db, 'post_stock_count', { count_id: cid }, U.inv);
  assert.equal(onHand(db, 5), 12);
  assert.deepEqual(r.warnings, []);
});

// ─── Журнал: выдача по заявке — это выдача ────────────────────────────────────

test('журнал: выдача по заявке — вид «issue», не расход на пациента', () => {
  const db = seed();
  const rq = rpc(db, 'stock_request_create', { for: 'me', lines: [{ product_id: 5, qty: 2 }] }, U.nurse2);
  rpc(db, 'approve_requisition_and_issue', { req_id: rq.req_id }, U.inv);
  rpc(db, 'dispense_item', { product_id: 5, quantity: 1, visit_id: visit(db) }, U.nurse);
  const issues = rpc(db, 'stock_movements_list', { kind: 'issue' }, U.admin).movements;
  assert.ok(issues.some((m) => m.reference_type === 'requisition' && m.view_kind === 'issue'));
  const disp = rpc(db, 'stock_movements_list', { kind: 'dispense' }, U.admin).movements;
  assert.ok(!disp.some((m) => m.reference_type === 'requisition'));
  assert.ok(disp.some((m) => m.reference_type === 'visit'));
});

// ─── Лист назначений: единица расхода ─────────────────────────────────────────

function marOrder(db, adm, dose, extra = {}) {
  return treatmentOrderCreate(db, {
    admission_id: adm, kind: 'med', name: 'Кеторол', dose, route: 'в/м', freq_code: '1x',
    starts_on: '2026-09-04', days: 1, service_id: 1, stock_item_id: 4, ...extra,
  }, U.doctor).order;
}
const markGiven = (db, o) => treatmentAdminMark(db, { order_id: o.id, date: '2026-09-04', slot: 10, status: 'given' }, U.nurse);
const doseLine = (db, adm) => db.prepare("SELECT * FROM admission_services WHERE admission_id = ? AND clinic_item_id = 4").get(adm);

for (const dose of ['1', '1 амп', '1 амп.']) {
  test(`отметка «дала» при дозе «${dose}»: одна ампула из коробки по 10 — 5 000, а не 50 000`, () => {
    const db = seed();
    const adm = admission(db);
    const r = markGiven(db, marOrder(db, adm, dose));
    assert.equal(r.stock.status, 'ok', JSON.stringify(r.warnings));
    assert.equal(onHand(db, 4), 9.9);
    const line = doseLine(db, adm);
    assert.equal(line.total, 5000);
    assert.equal(line.quantity, 1, 'строка счёта — в ампулах');
    assert.equal(line.unit_price, 5000);
  });
}

test('отметка «дала» при дозе «1 уп» списывает целую коробку', () => {
  const db = seed();
  const adm = admission(db);
  markGiven(db, marOrder(db, adm, '1 уп'));
  assert.equal(onHand(db, 4), 9);
  assert.equal(doseLine(db, adm).total, 50000);
});

test('отметка «дала» с непереводимой дозой: отметка есть, списания нет, отказ по-русски с единицей', () => {
  const db = seed();
  const adm = admission(db);
  const r = markGiven(db, marOrder(db, adm, '30 мг'));
  assert.equal(r.administration.status, 'given');
  assert.equal(r.stock.status, 'skipped');
  assert.equal(onHand(db, 4), 10);
  const w = r.warnings.find((x) => x.code === 'quantity');
  assert.ok(w && /амп/.test(w.message) && /не списано/.test(w.message), JSON.stringify(r.warnings));
});

// ─── Приход по заказу, себестоимость расхода ─────────────────────────────────

test('приход по заказу пишет поставщика заказа, партию и срок строки', () => {
  const db = seed();
  const po = Number(db.prepare("INSERT INTO purchase_orders (po_number, status, supplier_id) VALUES ('PO-1', 'ordered', 1)").run().lastInsertRowid);
  const it = Number(db.prepare('INSERT INTO purchase_order_items (po_id, product_id, qty_ordered, unit_cost) VALUES (?, 5, 6, 1200)').run(po).lastInsertRowid);
  rpc(db, 'receive_purchase_order', { po_id: po, lines: [{ po_item_id: it, qty: 5, batch_no: 'B-77', expiry_date: '2027-03-01' }] }, U.inv);
  const mv = db.prepare("SELECT supplier_id, batch_no, expiry_date FROM stock_movements WHERE reference_type = 'purchase_order'").get();
  assert.deepEqual({ ...mv }, { supplier_id: 1, batch_no: 'B-77', expiry_date: '2027-03-01' });
  assert.throws(() => rpc(db, 'receive_purchase_order', { po_id: po, lines: [{ po_item_id: it, qty: 1, expiry_date: '01.03.2027' }] }, U.inv),
    (e) => e.status === 400 && /ГГГГ-ММ-ДД/.test(e.message));
});

test('расход на визит и на койку пишет себестоимость (avg_cost)', () => {
  const db = seed();
  rpc(db, 'dispense_item', { product_id: 5, quantity: 1, visit_id: visit(db) }, U.nurse);
  rpc(db, 'dispense_admission_item', { p_admission_id: admission(db), p_item_id: 5, p_qty: 1 }, U.nurse);
  const costs = db.prepare("SELECT unit_cost FROM stock_movements WHERE product_id = 5 AND kind = 'dispense'").all().map((r) => r.unit_cost);
  assert.deepEqual(costs, [2000, 2000]);
});

// ─── Отключённый товар ───────────────────────────────────────────────────────

test('отключённый товар: из подотчёта выдаётся во всех дверях, со склада — нет', () => {
  const db = seed();
  issueTo(db, 3, 5, 2);
  db.prepare('UPDATE products SET active = 0 WHERE id = 5').run();
  const v = visit(db);
  // Цепочка (подотчёт первым) — можно: товар уже на руках.
  rpc(db, 'dispense_item', { product_id: 5, quantity: 1, visit_id: v }, U.nurse);
  rpc(db, 'dispense_from_holding', { holder: { type: 'staff', id: 3 }, product_id: 5, quantity: 1, visit_id: v }, U.nurse);
  assert.equal(held(db, 'staff', 3, 5), 0);
  // Подотчёт кончился — дальше пришлось бы брать со склада: отказ, по-русски.
  assert.throws(() => rpc(db, 'dispense_item', { product_id: 5, quantity: 1, visit_id: v }, U.nurse),
    (e) => e.status === 400 && /отключ/i.test(e.message));
  assert.throws(() => rpc(db, 'dispense_admission_item', { p_admission_id: admission(db), p_item_id: 5, p_qty: 1 }, U.nurse),
    (e) => e.status === 400 && /отключ/i.test(e.message));
  assert.throws(() => rpc(db, 'dispense_from_holding', { holder: { type: 'warehouse' }, product_id: 5, quantity: 1, visit_id: v }, U.nurse),
    (e) => e.status === 400 && /отключ/i.test(e.message));
});

// ─── Подотчёт отключённого сотрудника ────────────────────────────────────────

test('подотчёт отключённого сотрудника возвращается на склад целиком', () => {
  const db = seed();
  issueTo(db, 3, 1, 15);                     // полпачки
  db.prepare('UPDATE users SET is_active = 0 WHERE id = 3').run();
  const r = rpc(db, 'holding_return', { holder: { type: 'staff', id: 3 }, product_id: 1 }, U.admin);
  assert.equal(held(db, 'staff', 3, 1), 0);
  assert.equal(onHand(db, 1), 10);
  assert.equal(r.returned_base, 0.5);
  const mv = db.prepare("SELECT kind, qty, reference_type, holder_type, holder_id, note FROM stock_movements ORDER BY id DESC").get();
  assert.equal(mv.qty, 0.5);
  assert.equal(mv.reference_type, 'issue');
  assert.equal(mv.holder_id, 3);
  assert.match(mv.note, /Возврат на склад/);
});

test('подотчёт отключённого сотрудника передаётся другой медсестре', () => {
  const db = seed();
  issueTo(db, 3, 1, 15);
  db.prepare('UPDATE users SET is_active = 0 WHERE id = 3').run();
  rpc(db, 'holding_return', { holder: { type: 'staff', id: 3 }, product_id: 1, to: { type: 'staff', id: 4 } }, U.inv);
  assert.equal(held(db, 'staff', 3, 1), 0);
  assert.equal(held(db, 'staff', 4, 1), 0.5);
  assert.equal(onHand(db, 1), 9.5, 'склад не изменился: передача мимо него');
});

test('возврат подотчёта: только администратор и кладовщик; отключённому не передают', () => {
  const db = seed();
  issueTo(db, 3, 1, 15);
  assert.throws(() => rpc(db, 'holding_return', { holder: { type: 'staff', id: 3 }, product_id: 1 }, U.nurse), (e) => e.status === 403);
  db.prepare('UPDATE users SET is_active = 0 WHERE id = 4').run();
  assert.throws(() => rpc(db, 'holding_return', { holder: { type: 'staff', id: 3 }, product_id: 1, to: { type: 'staff', id: 4 } }, U.admin),
    (e) => e.status === 400 && /отключ/.test(e.message));
  assert.throws(() => rpc(db, 'holding_return', { holder: { type: 'staff', id: 3 }, product_id: 1, quantity: 99 }, U.admin),
    (e) => e.status === 400);
});

test('список подотчёта называет отключённого держателя', () => {
  const db = seed();
  issueTo(db, 3, 1, 15);
  db.prepare('UPDATE users SET is_active = 0 WHERE id = 3').run();
  const row = rpc(db, 'holdings_list', {}, U.admin).holdings.find((h) => h.holder_id === 3);
  assert.equal(row.holder_inactive, true);
});

// ─── Журнал: границы дня по местному времени, через индекс ────────────────────

test('журнал по датам: местный день целиком, соседний — нет', () => {
  const db = seed();
  const ins = db.prepare("INSERT INTO stock_movements (product_id, kind, qty, created_at) VALUES (5, 'adjust', ?, strftime('%Y-%m-%dT%H:%M:%SZ', ?, 'utc'))");
  ins.run(1, '2026-09-10 00:00:30');   // местная полночь с половиной минуты
  ins.run(2, '2026-09-10 23:59:30');
  ins.run(3, '2026-09-09 23:59:30');
  ins.run(4, '2026-09-11 00:00:10');
  const got = rpc(db, 'stock_movements_list', { from: '2026-09-10', to: '2026-09-10' }, U.admin).movements.map((m) => m.qty).sort();
  assert.deepEqual(got, [1, 2]);
  const fromOnly = rpc(db, 'stock_movements_list', { from: '2026-09-11' }, U.admin).movements.map((m) => m.qty);
  assert.deepEqual(fromOnly.filter((q) => q <= 4), [4]);
  const toOnly = rpc(db, 'stock_movements_list', { to: '2026-09-09' }, U.admin).movements.map((m) => m.qty);
  assert.deepEqual(toOnly, [3]);
});

test('индексы журнала склада на месте, и запрос по датам их берёт', () => {
  const db = seed();
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'stock_movements'").all().map((r) => r.name);
  for (const n of ['idx_stock_movements_created', 'idx_stock_movements_receipts', 'idx_stock_movements_reference', 'idx_stock_movements_holder']) {
    assert.ok(names.includes(n), `нет ${n}: ${names}`);
  }
  const plan = db.prepare("EXPLAIN QUERY PLAN SELECT id FROM stock_movements m WHERE m.created_at >= '2026-09-01' AND m.created_at < '2026-09-02'").all()
    .map((r) => r.detail).join(' | ');
  assert.match(plan, /idx_stock_movements_created/);
});
