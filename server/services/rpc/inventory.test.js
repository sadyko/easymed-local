import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { receiveStock, dispenseItem, voidDispense } from './inventory.js';

function seed() {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO users (id,username,password_hash,role) VALUES (3,'inv','x','inventory'),(4,'doc','x','doctor'),(5,'lab','x','lab')").run();
  const pid = db.prepare("INSERT INTO patients (full_name,branch_id) VALUES ('P',1)").run().lastInsertRowid;
  const vid = db.prepare("INSERT INTO visits (patient_id,branch_id,visit_date) VALUES (?,1,'2026-08-12T09:00:00Z')").run(pid).lastInsertRowid;
  const prod = db.prepare("INSERT INTO products (name,unit,sale_price,on_hand) VALUES ('Paracetamol','box',12000,0)").run().lastInsertRowid;
  return { db, pid, vid, prod };
}
const inv = { id:3, role:'inventory' };
const doc = { id:4, role:'doctor' };
const lab = { id:5, role:'lab' };

test('receive_stock increases on_hand and writes a ledger row', () => {
  const { db, prod } = seed();
  const r = receiveStock(db, { product_id: prod, quantity: 10, unit_cost: 8000 }, inv);
  assert.equal(r.on_hand, 10);
  const m = db.prepare("SELECT kind,qty FROM stock_movements WHERE product_id=?").get(prod);
  assert.equal(m.kind, 'receive'); assert.equal(m.qty, 10);
  assert.throws(() => receiveStock(db, { product_id: prod, quantity: 0 }, inv), /quantity/);
  assert.throws(() => receiveStock(db, { product_id: prod, quantity: 5 }, lab), /(role|allow)/i);
});

test('dispense_item decrements stock, prices from catalog, links a visit line', () => {
  const { db, vid, prod } = seed();
  receiveStock(db, { product_id: prod, quantity: 10 }, inv);
  const r = dispenseItem(db, { product_id: prod, quantity: 3, visit_id: vid }, doc);
  assert.equal(r.on_hand, 7);
  assert.ok(r.visit_service_id);
  const vs = db.prepare('SELECT clinic_item_id, service_id, quantity, unit_price, total, status FROM visit_services WHERE id=?').get(r.visit_service_id);
  assert.equal(vs.clinic_item_id, prod);
  assert.equal(vs.service_id, null);
  assert.equal(vs.unit_price, 12000);          // from product.sale_price, server-stamped
  assert.equal(vs.total, 36000);
  const m = db.prepare("SELECT qty FROM stock_movements WHERE kind='dispense'").get();
  assert.equal(m.qty, -3);
});

test('dispense_item NEVER goes negative (atomic reject on insufficient stock)', () => {
  const { db, vid, prod } = seed();
  receiveStock(db, { product_id: prod, quantity: 2 }, inv);
  // HOLDINGS_FIRST_V1 — отказ теперь по-русски и называет ВСЕ источники цепочки
  // («insufficient stock: on hand 2, requested 5» говорил только про склад и
  // молчал о том, что половина лежит у сотрудника на руках).
  assert.throws(() => dispenseItem(db, { product_id: prod, quantity: 5, visit_id: vid }, doc), /Недостаточно.*на складе 2 из 5/);
  assert.equal(db.prepare('SELECT on_hand FROM products WHERE id=?').get(prod).on_hand, 2); // unchanged
  assert.equal(db.prepare("SELECT COUNT(*) n FROM visit_services").get().n, 0);              // no line
  assert.equal(db.prepare("SELECT COUNT(*) n FROM stock_movements WHERE kind='dispense'").get().n, 0); // no movement
});

test('dispense_item validates qty/product/role; stock-only (no visit) works', () => {
  const { db, prod } = seed();
  receiveStock(db, { product_id: prod, quantity: 10 }, inv);
  assert.throws(() => dispenseItem(db, { product_id: prod, quantity: -1 }, doc), /quantity/);
  assert.throws(() => dispenseItem(db, { product_id: 99999, quantity: 1 }, doc), /not found|product/i);
  assert.throws(() => dispenseItem(db, { product_id: prod, quantity: 1 }, lab), /(role|allow)/i);
  const r = dispenseItem(db, { product_id: prod, quantity: 2 }, inv);  // no visit_id → stock-only
  assert.equal(r.on_hand, 8);
  assert.equal(r.visit_service_id, null);
});

test('void_dispense restores stock and deletes the line; blocked once invoiced', () => {
  const { db, vid, prod } = seed();
  receiveStock(db, { product_id: prod, quantity: 10 }, inv);
  const d = dispenseItem(db, { product_id: prod, quantity: 4, visit_id: vid }, doc);
  const v = voidDispense(db, { visit_service_id: d.visit_service_id }, inv);
  assert.equal(v.on_hand, 10);   // restored
  assert.equal(db.prepare('SELECT COUNT(*) n FROM visit_services WHERE id=?').get(d.visit_service_id).n, 0); // deleted
  assert.equal(db.prepare("SELECT qty FROM stock_movements WHERE kind='void'").get().qty, 4);
  // a fresh dispense that then gets invoiced can't be voided
  const d2 = dispenseItem(db, { product_id: prod, quantity: 1, visit_id: vid }, doc);
  db.prepare("INSERT INTO invoices (patient_id) VALUES (1)").run();
  db.prepare("INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, total) VALUES (1,'x',1,1,1)").run();
  db.prepare("UPDATE visit_services SET invoice_item_id=1 WHERE id=?").run(d2.visit_service_id);
  assert.throws(() => voidDispense(db, { visit_service_id: d2.visit_service_id }, inv), /invoiced/i);
});

test('receive/dispense reject absurdly large quantities (no overflow)', () => {
  const { db, prod } = seed();
  assert.throws(() => receiveStock(db, { product_id: prod, quantity: 1e308 }, inv), /quantity/);
  assert.throws(() => receiveStock(db, { product_id: prod, quantity: 2_000_000 }, inv), /quantity/);
  assert.equal(db.prepare('SELECT on_hand FROM products WHERE id=?').get(prod).on_hand, 0);
});

test('dispense rejects bad visit_id/doctor_id types with 400 not 500', () => {
  const { db, prod } = seed();
  receiveStock(db, { product_id: prod, quantity: 5 }, inv);
  assert.throws(() => dispenseItem(db, { product_id: prod, quantity: 1, visit_id: {} }, doc), /visit_id/);
  assert.throws(() => dispenseItem(db, { product_id: prod, quantity: 1, doctor_id: 'x' }, doc), /doctor_id/);
  assert.equal(db.prepare('SELECT on_hand FROM products WHERE id=?').get(prod).on_hand, 5); // unchanged
});

// BRANCH_MONEY_GUARD_V1 — отмена выдачи УДАЛЯЕТ строку визита, а удаление
// чеканит надгробие (миграция 084) и уезжает соседу. Сегодня приехавшая строка
// сюда не попадает (clinic_item_id — местная ссылка, она не ездит), поэтому
// строку в тесте помечаем чужой руками — так она выглядела бы, начни ездить
// выдачи. Запрет обязан стоять у самого DELETE, а не держаться на том, что
// сегодня до него не доходит.
test('чужая строка: отменить выдачу отсюда нельзя — надгробие стёрло бы её и в том здании', () => {
  const { db, vid, prod } = seed();
  db.prepare("INSERT INTO branches (name, letter) VALUES ('Чиланзар', 'B')").run();
  receiveStock(db, { product_id: prod, quantity: 10 }, inv);
  const d = dispenseItem(db, { product_id: prod, quantity: 2, visit_id: vid }, doc);
  db.prepare("UPDATE visit_services SET sync_origin = 'B' WHERE id = ?").run(d.visit_service_id);

  assert.throws(() => voidDispense(db, { visit_service_id: d.visit_service_id }, inv), /Чиланзар \(B\)/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM visit_services WHERE id = ?').get(d.visit_service_id).n, 1,
    'строка цела');
  assert.equal(db.prepare('SELECT on_hand FROM products WHERE id = ?').get(prod).on_hand, 8,
    'склад не тронут: отказ обязан не менять НИЧЕГО');
});

test('своя выдача отменяется как прежде — запрет касается только чужих строк', () => {
  const { db, vid, prod } = seed();
  receiveStock(db, { product_id: prod, quantity: 10 }, inv);
  const d = dispenseItem(db, { product_id: prod, quantity: 2, visit_id: vid }, doc);
  const v = voidDispense(db, { visit_service_id: d.visit_service_id }, inv);
  assert.equal(v.on_hand, 10);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM visit_services WHERE id = ?').get(d.visit_service_id).n, 0);
});

// =============================================================================
// HOLDINGS_FIRST_V1 — ОДНА ЦЕПОЧКА НА ВСЕ ДВЕРИ: свой подотчёт → кабинет, где
// шёл приём → отдел этого кабинета → склад. До этой задачи кабинет врача,
// окно визита, процедуры и счёт визита брали ВСЕГДА со склада, и выданное
// врачу или в кабинет висело призраком: склад платил за него второй раз.
// =============================================================================
function seedChain() {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO departments (id,name) VALUES (9,'Терапия')").run();
  db.prepare("INSERT INTO rooms (id,name,department_id) VALUES (7,'Каб. 204',9),(8,'Каб. 301',NULL)").run();
  db.prepare(`INSERT INTO users (id,username,password_hash,role,full_name,room_id,department_id)
              VALUES (3,'inv','x','inventory','Кладовщик',NULL,NULL),
                     (4,'doc','x','doctor','Врач Азиз',7,9),
                     (5,'lab','x','lab','Лаборант',NULL,NULL)`).run();
  const pid = db.prepare("INSERT INTO patients (full_name,branch_id) VALUES ('P',1)").run().lastInsertRowid;
  const vid = db.prepare("INSERT INTO visits (patient_id,branch_id,visit_date,room_id) VALUES (?,1,'2026-08-12T09:00:00Z',7)").run(pid).lastInsertRowid;
  const prod = db.prepare("INSERT INTO products (name,unit,base_unit,sale_price,on_hand) VALUES ('Парацетамол','уп','уп',12000,0)").run().lastInsertRowid;
  return { db, pid, vid, prod };
}
const hold = (db, type, id, prod, qty) =>
  db.prepare('INSERT INTO stock_holdings (holder_type,holder_id,product_id,qty) VALUES (?,?,?,?)').run(type, id, prod, qty);
const held = (db, type, id, prod) =>
  (db.prepare('SELECT qty FROM stock_holdings WHERE holder_type=? AND holder_id=? AND product_id=?').get(type, id, prod) || { qty: 0 }).qty;
const onHand = (db, prod) => db.prepare('SELECT on_hand FROM products WHERE id=?').get(prod).on_hand;

test('кабинет врача: сначала СВОЙ подотчёт, склад не трогается (HOLDINGS_FIRST_V1)', () => {
  const { db, vid, prod } = seedChain();
  receiveStock(db, { product_id: prod, quantity: 10 }, inv);
  hold(db, 'staff', 4, prod, 2);

  const r = dispenseItem(db, { product_id: prod, quantity: 2, visit_id: vid }, doc);
  assert.deepEqual(r.sources, [{ type: 'staff', id: 4, qty: 2 }]);
  assert.equal(held(db, 'staff', 4, prod), 0);
  assert.equal(onHand(db, prod), 10, 'склад не тронут — за этот товар уже заплатили при выдаче врачу');
  // Строка визита та же, что и была: цена из каталога, количество как прислали.
  const vs = db.prepare('SELECT clinic_item_id, quantity, unit_price, total FROM visit_services WHERE id=?').get(r.visit_service_id);
  assert.deepEqual(vs, { clinic_item_id: prod, quantity: 2, unit_price: 12000, total: 24000 });
  const mv = db.prepare("SELECT qty, holder_type, holder_id FROM stock_movements WHERE kind='dispense'").get();
  assert.deepEqual(mv, { qty: -2, holder_type: 'staff', holder_id: 4 });
});

test('кабинет: у врача пусто — тратится подотчёт КАБИНЕТА приёма, потом отдела, потом склад', () => {
  const { db, vid, prod } = seedChain();
  receiveStock(db, { product_id: prod, quantity: 10 }, inv);
  hold(db, 'room', 7, prod, 3);        // visits.room_id = 7
  hold(db, 'department', 9, prod, 1);  // rooms.department_id = 9

  const a = dispenseItem(db, { product_id: prod, quantity: 3, visit_id: vid }, doc);
  assert.deepEqual(a.sources, [{ type: 'room', id: 7, qty: 3 }]);
  assert.equal(onHand(db, prod), 10);

  const b = dispenseItem(db, { product_id: prod, quantity: 1, visit_id: vid }, doc);
  assert.deepEqual(b.sources, [{ type: 'department', id: 9, qty: 1 }]);
  assert.equal(onHand(db, prod), 10);

  const c = dispenseItem(db, { product_id: prod, quantity: 4, visit_id: vid }, doc);
  assert.deepEqual(c.sources, [{ type: 'warehouse', id: null, qty: 4 }], 'нигде на руках нет — склад');
  assert.equal(onHand(db, prod), 6);
});

test('частичное покрытие: 1 из кабинета + 4 со склада ОДНОЙ выдачей; отмена вернёт каждую часть своему источнику', () => {
  const { db, vid, prod } = seedChain();
  receiveStock(db, { product_id: prod, quantity: 10 }, inv);
  hold(db, 'room', 7, prod, 1);

  const r = dispenseItem(db, { product_id: prod, quantity: 5, visit_id: vid }, doc);
  assert.deepEqual(r.sources, [{ type: 'room', id: 7, qty: 1 }, { type: 'warehouse', id: null, qty: 4 }]);
  assert.equal(held(db, 'room', 7, prod), 0);
  assert.equal(onHand(db, prod), 6);
  // Одна строка счёта — и ДВА движения с общей ссылкой на неё.
  assert.equal(db.prepare('SELECT COUNT(*) n FROM visit_services').get().n, 1);
  const mvs = db.prepare("SELECT qty, holder_type, holder_id FROM stock_movements WHERE kind='dispense' AND reference_type='visit' AND reference_id=? ORDER BY id").all(r.visit_service_id);
  assert.deepEqual(mvs, [{ qty: -1, holder_type: 'room', holder_id: 7 }, { qty: -4, holder_type: null, holder_id: null }]);

  const v = voidDispense(db, { visit_service_id: r.visit_service_id }, inv);
  assert.deepEqual(v.sources, [{ type: 'room', id: 7, qty: 1 }, { type: 'warehouse', id: null, qty: 4 }]);
  assert.equal(held(db, 'room', 7, prod), 1, 'кабинету — его единица');
  assert.equal(onHand(db, prod), 10, 'складу — его четыре');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM visit_services WHERE id=?').get(r.visit_service_id).n, 0);
});

test('отказ называет нехватку И то, где лежит остальное', () => {
  const { db, vid, prod } = seedChain();
  receiveStock(db, { product_id: prod, quantity: 2 }, inv);
  hold(db, 'staff', 4, prod, 3);
  hold(db, 'department', 9, prod, 1);

  assert.throws(() => dispenseItem(db, { product_id: prod, quantity: 10, visit_id: vid }, doc), (e) => {
    assert.equal(e.status, 400);
    assert.equal(e.message, 'Недостаточно: Парацетамол — на складе 2 из 10 уп; у вас на руках 3, в отделе 1.');
    return true;
  });
  // Отказ не тронул НИЧЕГО.
  assert.equal(onHand(db, prod), 2);
  assert.equal(held(db, 'staff', 4, prod), 3);
  assert.equal(held(db, 'department', 9, prod), 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM visit_services').get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM stock_movements WHERE kind='dispense'").get().n, 0);

  // Нет нигде — отказ говорит и это, не выдумывая цифр.
  db.prepare('DELETE FROM stock_holdings').run();
  db.prepare('UPDATE products SET on_hand = 0 WHERE id = ?').run(prod);
  assert.throws(() => dispenseItem(db, { product_id: prod, quantity: 1, visit_id: vid }, doc),
    /на складе 0 из 1 уп; на руках, в кабинете и в отделе — ничего\./);
});

test('визит без кабинета: цепочка берёт СВОЙ кабинет сотрудника, а не чужой', () => {
  const { db, pid, prod } = seedChain();
  const vid = db.prepare("INSERT INTO visits (patient_id,branch_id,visit_date) VALUES (?,1,'2026-08-12T10:00:00Z')").run(pid).lastInsertRowid;
  receiveStock(db, { product_id: prod, quantity: 10 }, inv);
  hold(db, 'room', 7, prod, 2);   // users.room_id врача = 7
  hold(db, 'room', 8, prod, 5);   // чужой кабинет — не трогаем никогда

  const r = dispenseItem(db, { product_id: prod, quantity: 2, visit_id: vid }, doc);
  assert.deepEqual(r.sources, [{ type: 'room', id: 7, qty: 2 }]);
  assert.equal(held(db, 'room', 8, prod), 5, 'чужой кабинет нетронут');
});
