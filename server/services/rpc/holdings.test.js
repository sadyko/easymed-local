// HOLDINGS_V1 — warehouse → holder → patient, counted once.
//
// The defect this guards: «Выдать со склада» to a nurse deducted the
// warehouse, and the nurse's later dispense to a patient deducted it again.
// Now an issue with a holder MOVES stock, and a dispense from a holding takes
// it from the holder only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { issueStockLines } from './procurement.js';
import { holdingsList, dispenseFromHolding, voidHoldingDispense, outpatientsToday, visitItems, resolveHolder } from './holdings.js';
import { getRpc } from './index.js';
import { dispenseAdmissionItemCore, voidDispensedAdmissionItemCore } from './inventory.js';

const inv = { id: 3, role: 'inventory' };
const nurse = { id: 5, role: 'nurse' };
const cashier = { id: 6, role: 'cashier' };

function seed() {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO users (id,username,password_hash,role,full_name) VALUES (3,'inv','x','inventory','Кладовщик'),(5,'nurse','x','nurse','Медсестра Ирина'),(6,'cash','x','cashier','Кассир')").run();
  db.prepare("INSERT INTO rooms (id, name) VALUES (7, 'Процедурный')").run();
  db.prepare("INSERT INTO departments (id, name) VALUES (9, 'Терапия')").run();
  // Bought in boxes of 10, base unit = pack? No: base 'pack', dispensed in tabs (10 per pack).
  const prod = db.prepare(`
    INSERT INTO products (name, unit, base_unit, consumption_unit, consumption_factor, sale_price, on_hand, avg_cost)
    VALUES ('Парацетамол', 'pack', 'pack', 'таб', 10, 5000, 20, 3000)`).run().lastInsertRowid;
  db.prepare("INSERT INTO patients (id, full_name, mrn) VALUES (1, 'Иванов Иван', 'EM-1')").run();
  const visit = db.prepare("INSERT INTO visits (patient_id, visit_date, status) VALUES (1, strftime('%Y-%m-%dT%H:%M:%SZ','now'), 'arrived')").run().lastInsertRowid;
  return { db, prod, visit };
}
const onHand = (db, id) => db.prepare('SELECT on_hand FROM products WHERE id = ?').get(id).on_hand;
const held = (db, type, id, prod) => (db.prepare('SELECT qty FROM stock_holdings WHERE holder_type = ? AND holder_id = ? AND product_id = ?').get(type, id, prod) || { qty: 0 }).qty;

test('issue with a holder MOVES stock: warehouse −, nurse +; the journal names the holder', () => {
  const { db, prod } = seed();
  const r = issueStockLines(db, { holder: { type: 'staff', id: 5 }, lines: [{ product_id: prod, qty: 30, unit: 'consumption' }] }, inv);
  assert.equal(r.issued[0].base_qty, 3, '30 таб = 3 упаковки');
  assert.equal(onHand(db, prod), 17);
  assert.equal(held(db, 'staff', 5, prod), 3);
  const mv = db.prepare("SELECT qty, holder_type, holder_id, note FROM stock_movements WHERE reference_type = 'issue'").get();
  assert.equal(mv.qty, -3); assert.equal(mv.holder_type, 'staff'); assert.equal(mv.holder_id, 5);
  assert.equal(mv.note, 'Медсестра Ирина', 'recipient text comes from the holder when not typed');

  // Rooms and departments hold too.
  issueStockLines(db, { holder: { type: 'room', id: 7 }, lines: [{ product_id: prod, qty: 1, unit: 'base' }] }, inv);
  issueStockLines(db, { holder: { type: 'department', id: 9 }, lines: [{ product_id: prod, qty: 2, unit: 'base' }], note: 'на неделю' }, inv);
  assert.equal(onHand(db, prod), 14);
  const list = holdingsList(db, {}, nurse).holdings;
  assert.deepEqual(list.map((h) => [h.holder_type, h.holder_name, h.qty_base, h.qty_units]),
    [['department', 'Терапия', 2, 20], ['room', 'Процедурный', 1, 10], ['staff', 'Медсестра Ирина', 3, 30]]);
  assert.equal(list[0].consumption_unit, 'таб');

  // A free-text recipient without a holder is the old plain write-off — no holding.
  issueStockLines(db, { recipient: 'Уборщица', lines: [{ product_id: prod, qty: 1, unit: 'base' }] }, inv);
  assert.equal(onHand(db, prod), 13);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM stock_holdings').get().n, 3);

  assert.throws(() => issueStockLines(db, { holder: { type: 'staff', id: 999 }, lines: [{ product_id: prod, qty: 1 }] }, inv), (e) => e.status === 404);
  assert.throws(() => resolveHolder(db, { type: 'cabinet', id: 7 }), (e) => e.status === 400);
});

test('dispense from a holding to an outpatient visit: holder −, warehouse untouched, line billed per tablet', () => {
  const { db, prod, visit } = seed();
  issueStockLines(db, { holder: { type: 'staff', id: 5 }, lines: [{ product_id: prod, qty: 30, unit: 'consumption' }] }, inv);
  const r = dispenseFromHolding(db, { holder: { type: 'staff', id: 5 }, product_id: prod, quantity: 4, visit_id: visit }, nurse);
  assert.equal(r.item_name, 'Парацетамол');
  assert.equal(r.unit_price, 500, '5000 per pack of 10 → 500 per tablet');
  assert.equal(r.total, 2000);
  assert.equal(r.left_units, 26);
  assert.equal(onHand(db, prod), 17, 'the warehouse was deducted at issue time only');
  assert.equal(held(db, 'staff', 5, prod), 2.6);
  const line = db.prepare('SELECT clinic_item_id, quantity, unit_price, total, created_by FROM visit_services WHERE id = ?').get(r.line_id);
  assert.deepEqual(line, { clinic_item_id: prod, quantity: 4, unit_price: 500, total: 2000, created_by: 5 });
  const mv = db.prepare("SELECT qty, holder_type, holder_id FROM stock_movements WHERE reference_type = 'visit' AND reference_id = ?").get(r.line_id);
  assert.deepEqual(mv, { qty: -0.4, holder_type: 'staff', holder_id: 5 });

  const items = visitItems(db, { visit_id: visit }, nurse).items;
  assert.equal(items.length, 1);
  assert.equal(items[0].product_name, 'Парацетамол'); assert.equal(items[0].unit, 'таб');
  assert.equal(items[0].from_holding, true); assert.equal(items[0].invoiced, false);
  assert.equal(items[0].created_by_name, 'Медсестра Ирина');

  // Not billable: the line is on the visit at zero, stock still moves.
  const free = dispenseFromHolding(db, { holder: { type: 'staff', id: 5 }, product_id: prod, quantity: 1, visit_id: visit, billable: false }, nurse);
  assert.equal(db.prepare('SELECT total FROM visit_services WHERE id = ?').get(free.line_id).total, 0);

  // Overdraw is refused with the human number.
  assert.throws(() => dispenseFromHolding(db, { holder: { type: 'staff', id: 5 }, product_id: prod, quantity: 100, visit_id: visit }, nurse),
    (e) => e.status === 400 && /Недостаточно на руках/.test(e.message) && /25 таб/.test(e.message));
  // The room holds nothing of it.
  assert.throws(() => dispenseFromHolding(db, { holder: { type: 'room', id: 7 }, product_id: prod, quantity: 1, visit_id: visit }, nurse), /Недостаточно/);
  assert.throws(() => dispenseFromHolding(db, { holder: { type: 'staff', id: 5 }, product_id: prod, quantity: 1, visit_id: visit }, cashier), (e) => e.status === 403);
  assert.throws(() => dispenseFromHolding(db, { holder: { type: 'staff', id: 5 }, product_id: prod, quantity: 1 }, nurse), /визит или госпитализацию/);
});

test('void returns the quantity to the holder it came from and removes the line; an invoiced line stays', () => {
  const { db, prod, visit } = seed();
  issueStockLines(db, { holder: { type: 'room', id: 7 }, lines: [{ product_id: prod, qty: 10, unit: 'consumption' }] }, inv);
  const r = dispenseFromHolding(db, { holder: { type: 'room', id: 7 }, product_id: prod, quantity: 3, visit_id: visit }, nurse);
  assert.equal(held(db, 'room', 7, prod), 0.7);
  voidHoldingDispense(db, { visit_service_id: r.line_id }, nurse);
  assert.equal(held(db, 'room', 7, prod), 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM visit_services WHERE id = ?').get(r.line_id).n, 0);
  assert.equal(onHand(db, prod), 19, 'warehouse untouched either way');

  const r2 = dispenseFromHolding(db, { holder: { type: 'room', id: 7 }, product_id: prod, quantity: 2, visit_id: visit }, nurse);
  const invId = db.prepare("INSERT INTO invoices (patient_id, visit_id) VALUES (1, ?)").run(visit).lastInsertRowid;
  const itemId = db.prepare("INSERT INTO invoice_items (invoice_id, description) VALUES (?, 'x')").run(invId).lastInsertRowid;
  db.prepare('UPDATE visit_services SET invoice_item_id = ? WHERE id = ?').run(itemId, r2.line_id);
  assert.throws(() => voidHoldingDispense(db, { visit_service_id: r2.line_id }, nurse), /уже в счёте/);
});

test('outpatients_today lists today\'s outpatient visits with patient, doctor and counts — not cancelled, not inpatient', () => {
  const { db, prod, visit } = seed();
  db.prepare("INSERT INTO users (id, username, password_hash, role, full_name, is_doctor) VALUES (8, 'doc', 'x', 'doctor', 'Врач Азиз', 1)").run();
  db.prepare('UPDATE visits SET doctor_id = 8 WHERE id = ?').run(visit);
  db.prepare("INSERT INTO visits (patient_id, visit_date, status) VALUES (1, strftime('%Y-%m-%dT%H:%M:%SZ','now'), 'cancelled')").run();
  db.prepare("INSERT INTO visits (patient_id, visit_date, status, visit_type) VALUES (1, strftime('%Y-%m-%dT%H:%M:%SZ','now'), 'arrived', 'inpatient')").run();
  db.prepare("INSERT INTO visits (patient_id, visit_date, status) VALUES (1, strftime('%Y-%m-%dT%H:%M:%SZ','now','-2 days'), 'arrived')").run();
  issueStockLines(db, { holder: { type: 'staff', id: 5 }, lines: [{ product_id: prod, qty: 10, unit: 'consumption' }] }, inv);
  dispenseFromHolding(db, { holder: { type: 'staff', id: 5 }, product_id: prod, quantity: 1, visit_id: visit }, nurse);
  const r = outpatientsToday(db, {}, nurse);
  assert.equal(r.visits.length, 1);
  assert.equal(r.visits[0].id, visit);
  assert.equal(r.visits[0].patient_name, 'Иванов Иван');
  assert.equal(r.visits[0].doctor_name, 'Врач Азиз');
  assert.equal(r.visits[0].item_count, 1);
  assert.match(r.date, /^\d{4}-\d{2}-\d{2}$/);
  for (const name of ['holdings_list', 'dispense_from_holding', 'void_holding_dispense', 'outpatients_today', 'visit_items']) {
    assert.equal(typeof getRpc(name), 'function', name);
  }
});

test('the warehouse is a source too: a nurse with nothing issued dispenses from the general stock; void returns it there', () => {
  const { db, prod, visit } = seed();
  const r = dispenseFromHolding(db, { holder: { type: 'warehouse' }, product_id: prod, quantity: 5, visit_id: visit }, nurse);
  assert.equal(r.source, 'warehouse');
  assert.equal(r.unit_price, 500); assert.equal(r.total, 2500);
  assert.equal(onHand(db, prod), 19.5, '5 tablets = half a pack off the warehouse');
  assert.equal(r.left_units, 195);
  const mv = db.prepare("SELECT qty, holder_type FROM stock_movements WHERE reference_type = 'visit' AND reference_id = ?").get(r.line_id);
  assert.deepEqual(mv, { qty: -0.5, holder_type: null });
  const items = visitItems(db, { visit_id: visit }, nurse).items;
  assert.equal(items[0].from_holding, false); assert.equal(items[0].can_void, true);
  voidHoldingDispense(db, { visit_service_id: r.line_id }, nurse);
  assert.equal(onHand(db, prod), 20);
  assert.throws(() => dispenseFromHolding(db, { holder: { type: 'warehouse' }, product_id: prod, quantity: 500, visit_id: visit }, nurse), /Недостаточно на складе/);
});

// =============================================================================
// HOLDINGS_FIRST_V1 — цепочка у койки: свой подотчёт → свой кабинет → отдел
// палаты → склад, ВСЕГДА и без флага, с частичным покрытием.
//
// Палата не лежит в кабинете (в wards нет room_id — только floor_id и
// department_id), поэтому «кабинет» здесь — собственный кабинет сотрудника
// (users.room_id): процедурная, где медсестра набирает дозу.
// =============================================================================
function seedWard() {
  const { db, prod } = seed();
  db.prepare('UPDATE users SET room_id = 7, department_id = 9 WHERE id = 5').run();   // процедурная + свой отдел
  db.prepare("INSERT INTO wards (id, name, department_id) VALUES (3, 'Палата 3', 9)").run();
  const adm = db.prepare("INSERT INTO admissions (patient_id, status, ward_id, created_at) VALUES (1, 'active', 3, '2026-09-14T00:00:00Z')").run().lastInsertRowid;
  return { db, prod, adm };
}

test('койка: подотчёт → кабинет → отдел → склад, по порядку и с частичным покрытием (HOLDINGS_FIRST_V1)', () => {
  const { db, prod, adm } = seedWard();
  issueStockLines(db, { holder: { type: 'staff', id: 5 }, lines: [{ product_id: prod, qty: 1, unit: 'base' }] }, inv);
  issueStockLines(db, { holder: { type: 'room', id: 7 }, lines: [{ product_id: prod, qty: 2, unit: 'base' }] }, inv);
  issueStockLines(db, { holder: { type: 'department', id: 9 }, lines: [{ product_id: prod, qty: 3, unit: 'base' }] }, inv);
  assert.equal(onHand(db, prod), 14, '20 − 1 − 2 − 3');

  // 1 уп. — у медсестры ровно одна: её.
  const a = dispenseAdmissionItemCore(db, { admission_id: adm, product_id: prod, quantity: 1 }, nurse);
  assert.deepEqual(a.sources, [{ type: 'staff', id: 5, qty: 1 }]);
  assert.equal(onHand(db, prod), 14, 'склад не тронут');

  // 2 уп. — своего нет, идёт кабинет.
  const b = dispenseAdmissionItemCore(db, { admission_id: adm, product_id: prod, quantity: 2 }, nurse);
  assert.deepEqual(b.sources, [{ type: 'room', id: 7, qty: 2 }]);

  // 3 уп. — кабинет пуст, идёт отдел палаты.
  const c = dispenseAdmissionItemCore(db, { admission_id: adm, product_id: prod, quantity: 3 }, nurse);
  assert.deepEqual(c.sources, [{ type: 'department', id: 9, qty: 3 }]);
  assert.equal(onHand(db, prod), 14);

  // ЧАСТИЧНОЕ ПОКРЫТИЕ одной выдачей: у отдела осталось 0, всё со склада.
  const d = dispenseAdmissionItemCore(db, { admission_id: adm, product_id: prod, quantity: 2 }, nurse);
  assert.deepEqual(d.sources, [{ type: 'warehouse', id: null, qty: 2 }]);
  assert.equal(onHand(db, prod), 12);
});

test('частичное покрытие: 1 из подотчёта + 4 со склада ОДНОЙ дозой; отмена возвращает каждую часть своему источнику', () => {
  const { db, prod, adm } = seedWard();
  issueStockLines(db, { holder: { type: 'staff', id: 5 }, lines: [{ product_id: prod, qty: 1, unit: 'base' }] }, inv);
  assert.equal(onHand(db, prod), 19);

  const r = dispenseAdmissionItemCore(db, { admission_id: adm, product_id: prod, quantity: 5 }, nurse);
  assert.deepEqual(r.sources, [{ type: 'staff', id: 5, qty: 1 }, { type: 'warehouse', id: null, qty: 4 }]);
  assert.equal(held(db, 'staff', 5, prod), 0);
  assert.equal(onHand(db, prod), 15);
  // Одна строка счёта, два движения с общей ссылкой на неё.
  assert.equal(db.prepare('SELECT COUNT(*) n FROM admission_services').get().n, 1);
  const mvs = db.prepare("SELECT qty, holder_type, holder_id FROM stock_movements WHERE kind='dispense' AND reference_type='admission' AND reference_id=? ORDER BY id").all(r.line_id);
  assert.deepEqual(mvs, [{ qty: -1, holder_type: 'staff', holder_id: 5 }, { qty: -4, holder_type: null, holder_id: null }]);

  voidDispensedAdmissionItemCore(db, { line_id: r.line_id }, nurse);
  assert.equal(held(db, 'staff', 5, prod), 1, 'медсестре — её упаковка');
  assert.equal(onHand(db, prod), 19, 'складу — его четыре');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM admission_services WHERE id=?').get(r.line_id).n, 0);
  const voids = db.prepare("SELECT qty, holder_type FROM stock_movements WHERE kind='void' AND reference_id=? ORDER BY id").all(r.line_id);
  assert.deepEqual(voids, [{ qty: 1, holder_type: 'staff' }, { qty: 4, holder_type: null }]);
});

test('склад пуст, а в отделении лекарство есть — доза ВЫДАЁТСЯ (баг владельца)', () => {
  const { db, prod, adm } = seedWard();
  issueStockLines(db, { holder: { type: 'department', id: 9 }, lines: [{ product_id: prod, qty: 20, unit: 'base' }] }, inv);
  assert.equal(onHand(db, prod), 0, 'склад пуст: всё уехало в отделение');

  const r = dispenseAdmissionItemCore(db, { admission_id: adm, product_id: prod, quantity: 2 }, nurse);
  assert.deepEqual(r.sources, [{ type: 'department', id: 9, qty: 2 }]);
  assert.equal(held(db, 'department', 9, prod), 18);
  assert.equal(onHand(db, prod), 0, 'склад по-прежнему пуст и в минус не ушёл');
  // Строка счёта на месте — деньги считаются как раньше.
  const line = db.prepare('SELECT clinic_item_id, quantity, unit_price, total, billable FROM admission_services WHERE id=?').get(r.line_id);
  assert.deepEqual(line, { clinic_item_id: prod, quantity: 2, unit_price: 5000, total: 10000, billable: 1 });
});

test('нет нигде: отказ называет и нехватку, и каждый источник цепочки', () => {
  const { db, prod, adm } = seedWard();
  db.prepare('UPDATE products SET on_hand = 2 WHERE id = ?').run(prod);
  db.prepare("INSERT INTO stock_holdings (holder_type,holder_id,product_id,qty) VALUES ('staff',5,?,3),('room',7,?,1),('department',9,?,1)").run(prod, prod, prod);

  assert.throws(() => dispenseAdmissionItemCore(db, { admission_id: adm, product_id: prod, quantity: 10 }, nurse), (e) => {
    assert.equal(e.status, 400);
    assert.equal(e.message, 'Недостаточно: Парацетамол — на складе 2 из 10 pack; у вас на руках 3, в кабинете 1, в отделе 1.');
    return true;
  });
  // Отказ не тронул ни остатка, ни подотчётов, ни счёта.
  assert.equal(onHand(db, prod), 2);
  assert.equal(held(db, 'staff', 5, prod), 3);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM admission_services').get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM stock_movements WHERE kind='dispense' AND reference_type='admission'").get().n, 0);
});

test('счёт не изменился: billable=false пишет строку ровно как раньше, а строку в счёте отменить нельзя', () => {
  const { db, prod, adm } = seedWard();
  issueStockLines(db, { holder: { type: 'staff', id: 5 }, lines: [{ product_id: prod, qty: 4, unit: 'base' }] }, inv);

  // Койка: billable=0 — флаг, цена каталога на строке остаётся (поведение не тронуто).
  const free = dispenseAdmissionItemCore(db, { admission_id: adm, product_id: prod, quantity: 1, billable: false }, nurse);
  assert.deepEqual(db.prepare('SELECT quantity, unit_price, total, billable FROM admission_services WHERE id=?').get(free.line_id),
    { quantity: 1, unit_price: 5000, total: 5000, billable: 0 });

  // Амбулаторная дверь: billable=false — нулевая цена, как и была.
  const visit = db.prepare("INSERT INTO visits (patient_id, visit_date, status) VALUES (1, strftime('%Y-%m-%dT%H:%M:%SZ','now'), 'arrived')").run().lastInsertRowid;
  const zero = dispenseFromHolding(db, { holder: { type: 'staff', id: 5 }, product_id: prod, quantity: 1, visit_id: visit, billable: false }, nurse);
  assert.deepEqual(db.prepare('SELECT unit_price, total FROM visit_services WHERE id=?').get(zero.line_id), { unit_price: 0, total: 0 });

  // Выставленную в счёт строку по-прежнему не отменить.
  const billed = dispenseAdmissionItemCore(db, { admission_id: adm, product_id: prod, quantity: 1 }, nurse);
  const invId = db.prepare("INSERT INTO invoices (patient_id) VALUES (1)").run().lastInsertRowid;
  const itemId = db.prepare("INSERT INTO invoice_items (invoice_id, description) VALUES (?, 'x')").run(invId).lastInsertRowid;
  db.prepare('UPDATE admission_services SET invoice_item_id = ? WHERE id = ?').run(itemId, billed.line_id);
  assert.throws(() => voidDispensedAdmissionItemCore(db, { line_id: billed.line_id }, nurse), /invoiced/i);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM admission_services WHERE id=?').get(billed.line_id).n, 1);
});

test('призрак исчез: выдали 100 в отдел, списали 10 у койки — в отделе 90, склад не тронут дважды', () => {
  const { db, prod, adm } = seedWard();
  db.prepare('UPDATE products SET on_hand = 500 WHERE id = ?').run(prod);
  issueStockLines(db, { holder: { type: 'department', id: 9 }, lines: [{ product_id: prod, qty: 100, unit: 'base' }] }, inv);
  assert.equal(onHand(db, prod), 400, 'выдача в отдел — ПЕРЕКЛАДЫВАНИЕ, склад списан один раз');
  assert.equal(held(db, 'department', 9, prod), 100);

  dispenseAdmissionItemCore(db, { admission_id: adm, product_id: prod, quantity: 10 }, nurse);
  assert.equal(held(db, 'department', 9, prod), 90, 'из отдела ушло 10');
  assert.equal(onHand(db, prod), 400, 'склад НЕ списан второй раз — это и был призрак');
  // Всё купленное и не израсходованное = склад + держатели.
  const total = onHand(db, prod) + db.prepare('SELECT COALESCE(SUM(qty),0) s FROM stock_holdings WHERE product_id = ?').get(prod).s;
  assert.equal(total, 490, '500 − 10 израсходованных на пациента');
});

// MY_STOCK_V1 — «МОИ ЗАПАСЫ» СПРАШИВАЕТ У СЕРВЕРА «МОЁ», А НЕ ВЕСЬ РЕЕСТР.
//
// До этого аргумента у экрана было два пути, и оба плохие: попросить весь
// список и отфильтровать своё в браузере (чужие остатки уже приехали — их
// видно в консоли и в сети) или назвать себя держателем самому (тогда любой
// назовёт держателем кого угодно). Поэтому область считает сервер: имя берётся
// из сессии, а holder_type/holder_id при `mine` не читаются вовсе.
test('mine: только свой подотчёт, имя из сессии — чужого не показать даже подставив держателя', () => {
  const { db, prod } = seed();
  issueStockLines(db, { holder: { type: 'staff', id: 5 }, lines: [{ product_id: prod, qty: 30, unit: 'consumption' }] }, inv);
  issueStockLines(db, { holder: { type: 'staff', id: 3 }, lines: [{ product_id: prod, qty: 2, unit: 'base' }] }, inv);
  issueStockLines(db, { holder: { type: 'department', id: 9 }, lines: [{ product_id: prod, qty: 5, unit: 'base' }] }, inv);

  const mine = holdingsList(db, { mine: true }, nurse).holdings;
  assert.deepEqual(mine.map((h) => [h.holder_type, h.holder_id, h.qty_base, h.qty_units]), [['staff', 5, 3, 30]],
    'в «Моих запасах» оказалось не только своё');
  assert.equal(mine[0].product_name, 'Парацетамол');
  assert.equal(mine[0].consumption_unit, 'таб');

  // Подставленный держатель не читается: ответ всё равно про вошедшего.
  const forged = holdingsList(db, { mine: true, holder_type: 'staff', holder_id: 3 }, nurse).holdings;
  assert.deepEqual(forged.map((h) => h.holder_id), [5], 'чужой подотчёт открылся подстановкой holder_id');

  // Тому, у кого на руках ничего нет, — пустой список, а не отказ.
  assert.deepEqual(holdingsList(db, { mine: true }, cashier).holdings, []);
});

test('mine: роли, которых нет в списке склада, видят СВОЙ подотчёт — иначе заведующая получит 403 на самой себе', () => {
  const { db, prod } = seed();
  db.prepare("INSERT INTO users (id,username,password_hash,role,full_name) VALUES (11,'head','x','head_doctor','Заведующая Юсупова'),(12,'senior','x','senior_nurse','Старшая Каримова')").run();
  issueStockLines(db, { holder: { type: 'staff', id: 11 }, lines: [{ product_id: prod, qty: 1, unit: 'base' }] }, inv);

  const head = { id: 11, role: 'head_doctor' };
  const senior = { id: 12, role: 'senior_nurse' };
  assert.equal(holdingsList(db, { mine: true }, head).holdings.length, 1);
  assert.deepEqual(holdingsList(db, { mine: true }, senior).holdings, []);
  // А общий список им по-прежнему не положен — «моё» никого не расширяет.
  assert.throws(() => holdingsList(db, {}, head), (e) => e.status === 403);
  assert.throws(() => holdingsList(db, { mine: true }, { id: 0, role: 'nurse' }), (e) => e.status === 401);
});
