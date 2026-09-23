// STOCK_REQUEST_V1 — заявка себе или отделу и автозаявка по минимуму.
//
// Решения владельца (docs/plans/2026-09-23-stock-requests.md):
//   1. автозаявка просит до нормы: норма − остаток − уже запрошено и не выдано;
//   2. одобряет кладовщик в «Заявках», одобрение выдаёт; автозаявка сама ничего
//      не двигает;
//   3. человек просит себе; член отдела — и для отдела;
//   4. минимум ставит каждый себе, заведующая — отделу, кладовщик и
//      администратор — любому.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { issueStockLines, approveRequisitionAndIssue, createRequisition } from './procurement.js';
import { dispenseFromHolding } from './holdings.js';
import { dispenseItem } from './inventory.js';
import { stockMinimumSet, stockMinimumClear, stockMinimumsList, stockRequestCreate, stockRequestsMine } from './stock-requests.js';
import { getRpc } from './index.js';

const ADMIN = { id: 1, role: 'admin' };
const INV = { id: 3, role: 'inventory' };
const HEAD = { id: 4, role: 'doctor' };      // заведующая отделом 9, сама в отделе не числится
const NURSE = { id: 5, role: 'nurse' };      // в отделе 9
const NURSE2 = { id: 6, role: 'nurse' };     // в отделе 10
const REG = { id: 8, role: 'registrar' };

function seed() {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO departments (id, name) VALUES (9, 'Терапия'), (10, 'Хирургия')").run();
  db.prepare(`INSERT INTO users (id,username,password_hash,role,full_name,department_id) VALUES
    (1,'adm','x','admin','Админ',NULL), (3,'inv','x','inventory','Кладовщик',NULL),
    (4,'head','x','doctor','Заведующая Каримова',NULL), (5,'n1','x','nurse','Медсестра Ирина',9),
    (6,'n2','x','nurse','Медсестра Ольга',10), (8,'reg','x','registrar','Регистратор',NULL)`).run();
  db.prepare('UPDATE departments SET head_user_id = 4 WHERE id = 9').run();
  // Перчатки: базовая единица — штука, считают штуками.
  const gloves = Number(db.prepare(`INSERT INTO products (name, unit, base_unit, sale_price, on_hand, avg_cost)
    VALUES ('Перчатки', 'pcs', 'шт', 1000, 100, 500)`).run().lastInsertRowid);
  // Парацетамол: база — упаковка, расход — таблетки, 10 в упаковке.
  const para = Number(db.prepare(`INSERT INTO products (name, unit, base_unit, consumption_unit, consumption_factor, sale_price, on_hand, avg_cost)
    VALUES ('Парацетамол', 'pack', 'уп', 'таб', 10, 5000, 50, 3000)`).run().lastInsertRowid);
  db.prepare("INSERT INTO patients (id, full_name, mrn) VALUES (1, 'Иванов Иван', 'EM-1')").run();
  const visit = Number(db.prepare("INSERT INTO visits (patient_id, visit_date, status) VALUES (1, strftime('%Y-%m-%dT%H:%M:%SZ','now'), 'arrived')").run().lastInsertRowid);
  return { db, gloves, para, visit };
}
const held = (db, type, id, prod) => (db.prepare('SELECT qty FROM stock_holdings WHERE holder_type = ? AND holder_id = ? AND product_id = ?').get(type, id, prod) || { qty: 0 }).qty;
const onHand = (db, id) => db.prepare('SELECT on_hand FROM products WHERE id = ?').get(id).on_hand;
const reqs = (db) => db.prepare(`
  SELECT r.id, r.status, r.holder_type, r.holder_id, r.department_id, r.auto, r.requested_by, r.notes, i.product_id, i.qty
    FROM purchase_requisitions r JOIN purchase_requisition_items i ON i.req_id = r.id ORDER BY r.id, i.id`).all().map((r) => ({ ...r }));
const give = (db, type, id, prod, qty) => issueStockLines(db, { holder: { type, id }, lines: [{ product_id: prod, qty, unit: 'base' }] }, INV);
const forbidden = (e) => e.status === 403;

// --- Решение 4: кто ставит минимум -------------------------------------------

test('минимум: себе — сам; отделу — заведующая; любому — кладовщик и администратор', () => {
  const { db, gloves } = seed();
  try {
    const mine = stockMinimumSet(db, { holder_type: 'staff', holder_id: 5, product_id: gloves, min_qty: 0, target_qty: 0 }, NURSE);
    assert.equal(mine.minimum.min_qty, 0);
    stockMinimumSet(db, { holder_type: 'staff', holder_id: 5, product_id: gloves, min_qty: 0, target_qty: 5 }, NURSE);   // повтор — правка, не вторая строка
    assert.equal(db.prepare("SELECT COUNT(*) n FROM stock_minimums WHERE holder_type='staff' AND holder_id=5").get().n, 1);
    assert.equal(db.prepare("SELECT target_qty FROM stock_minimums WHERE holder_type='staff' AND holder_id=5").get().target_qty, 5);

    stockMinimumSet(db, { holder_type: 'department', holder_id: 9, product_id: gloves, min_qty: 0, target_qty: 10 }, HEAD);
    stockMinimumSet(db, { holder_type: 'staff', holder_id: 6, product_id: gloves, min_qty: 0, target_qty: 3 }, INV);
    stockMinimumSet(db, { holder_type: 'department', holder_id: 10, product_id: gloves, min_qty: 0, target_qty: 3 }, ADMIN);
    const row = db.prepare("SELECT set_by FROM stock_minimums WHERE holder_type='department' AND holder_id=9").get();
    assert.equal(row.set_by, 4, 'кто поставил — помнится');
  } finally { db.close(); }
});

test('минимум: медсестра не ставит чужой, член отдела — не заведующая, регистратор — ничего', () => {
  const { db, gloves } = seed();
  try {
    assert.throws(() => stockMinimumSet(db, { holder_type: 'staff', holder_id: 6, product_id: gloves, min_qty: 1, target_qty: 2 }, NURSE), forbidden);
    assert.throws(() => stockMinimumSet(db, { holder_type: 'department', holder_id: 9, product_id: gloves, min_qty: 1, target_qty: 2 }, NURSE), forbidden,
      'член отдела — не заведующая: минимум отдела ставит руководитель');
    assert.throws(() => stockMinimumSet(db, { holder_type: 'department', holder_id: 10, product_id: gloves, min_qty: 1, target_qty: 2 }, HEAD), forbidden);
    // Регистратор заявок не подаёт — и минимум себе (то есть автозаявку) не ставит.
    assert.throws(() => stockMinimumSet(db, { holder_type: 'staff', holder_id: 8, product_id: gloves, min_qty: 100, target_qty: 1000 }, REG), forbidden,
      'регистратор поставил себе минимум — и через него подал заявку, которую сам подать не вправе');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM stock_minimums').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM purchase_requisitions').get().n, 0);

    // Слова отказа — по-русски и по делу.
    assert.throws(() => stockMinimumSet(db, { holder_type: 'staff', holder_id: 6, product_id: gloves, min_qty: 1, target_qty: 2 }, NURSE), /себе/);
    // Норма меньше минимума, отрицательные числа, кабинет, чужой товар.
    assert.throws(() => stockMinimumSet(db, { holder_type: 'staff', holder_id: 5, product_id: gloves, min_qty: 5, target_qty: 2 }, NURSE), /Норма/);
    assert.throws(() => stockMinimumSet(db, { holder_type: 'staff', holder_id: 5, product_id: gloves, min_qty: -1, target_qty: 2 }, NURSE), (e) => e.status === 400);
    assert.throws(() => stockMinimumSet(db, { holder_type: 'room', holder_id: 5, product_id: gloves, min_qty: 1, target_qty: 2 }, ADMIN), (e) => e.status === 400);
    assert.throws(() => stockMinimumSet(db, { holder_type: 'staff', holder_id: 5, product_id: 999, min_qty: 1, target_qty: 2 }, NURSE), (e) => e.status === 404);
    assert.throws(() => stockMinimumSet(db, { holder_type: 'staff', holder_id: 999, product_id: gloves, min_qty: 1, target_qty: 2 }, ADMIN), (e) => e.status === 404);
  } finally { db.close(); }
});

test('минимум снимается теми же правами, что ставится', () => {
  const { db, gloves } = seed();
  try {
    stockMinimumSet(db, { holder_type: 'staff', holder_id: 6, product_id: gloves, min_qty: 0, target_qty: 3 }, NURSE2);
    const args = { holder_type: 'staff', holder_id: 6, product_id: gloves };
    assert.throws(() => stockMinimumClear(db, args, NURSE), forbidden);
    assert.deepEqual(stockMinimumClear(db, args, NURSE2), { ok: true, removed: 1 });
    assert.deepEqual(stockMinimumClear(db, args, NURSE2), { ok: true, removed: 0 }, 'снять снятое — не ошибка');
  } finally { db.close(); }
});

test('минимум можно задать в единицах расхода — хранится в базовых, как остаток', () => {
  const { db, para } = seed();
  try {
    give(db, 'staff', 5, para, 5);
    const r = stockMinimumSet(db, { holder_type: 'staff', holder_id: 5, product_id: para, min_qty: 20, target_qty: 50, unit: 'consumption' }, NURSE);
    assert.deepEqual([r.minimum.min_qty, r.minimum.target_qty], [2, 5], '20 таб = 2 уп, 50 таб = 5 уп');
    assert.equal(r.request, null, 'на руках 5 уп — не ниже минимума');
  } finally { db.close(); }
});

// --- Список минимумов --------------------------------------------------------

test('список: своё; своих отделов; всё — только складу и администратору', () => {
  const { db, gloves, para } = seed();
  try {
    give(db, 'staff', 5, gloves, 7);
    stockMinimumSet(db, { holder_type: 'staff', holder_id: 5, product_id: gloves, min_qty: 2, target_qty: 10 }, NURSE);
    stockMinimumSet(db, { holder_type: 'staff', holder_id: 6, product_id: gloves, min_qty: 0, target_qty: 4 }, NURSE2);
    stockMinimumSet(db, { holder_type: 'department', holder_id: 9, product_id: para, min_qty: 0, target_qty: 4 }, HEAD);
    stockMinimumSet(db, { holder_type: 'department', holder_id: 10, product_id: para, min_qty: 0, target_qty: 4 }, ADMIN);

    const mine = stockMinimumsList(db, {}, NURSE);
    assert.equal(mine.scope, 'mine');
    assert.deepEqual(mine.rows.map((r) => [r.holder_type, r.holder_id]), [['staff', 5]]);
    const row = mine.rows[0];
    assert.equal(row.product_name, 'Перчатки');
    assert.equal(row.base_unit, 'шт');
    assert.equal(row.held_qty, 7);
    assert.equal(row.min_qty, 2);
    assert.equal(row.target_qty, 10);
    assert.equal(row.below_min, false);
    assert.equal(row.open_request, null);
    assert.equal(row.can_edit, true);
    assert.equal(row.holder_name, 'Медсестра Ирина');

    // Член отдела видит минимумы отдела, но править их может только заведующая.
    const dept = stockMinimumsList(db, { scope: 'department' }, NURSE);
    assert.deepEqual(dept.rows.map((r) => [r.holder_type, r.holder_id, r.can_edit]), [['department', 9, false]]);
    const headView = stockMinimumsList(db, { scope: 'department' }, HEAD);
    assert.deepEqual(headView.rows.map((r) => [r.holder_id, r.can_edit]), [[9, true]]);
    assert.deepEqual(stockMinimumsList(db, { scope: 'department' }, NURSE2).rows.map((r) => r.holder_id), [10]);
    assert.throws(() => stockMinimumsList(db, { scope: 'department', department_id: 10 }, NURSE), forbidden);

    assert.throws(() => stockMinimumsList(db, { scope: 'all' }, NURSE), forbidden);
    const all = stockMinimumsList(db, { scope: 'all' }, INV);
    assert.equal(all.rows.length, 4);
    assert.ok(all.rows.every((r) => r.can_edit));
    assert.throws(() => stockMinimumsList(db, { scope: 'соседи' }, NURSE), (e) => e.status === 400);
  } finally { db.close(); }
});

// --- Решение 3: заявка себе или отделу ---------------------------------------

test('заявка себе: держатель — сам сотрудник, номер общий с заявками отделов', () => {
  const { db, gloves, para } = seed();
  try {
    const first = createRequisition(db, { p_department: 9, p_lines: [{ item_id: gloves, qty: 1 }] }, NURSE);
    const r = stockRequestCreate(db, { for: 'me', lines: [{ product_id: gloves, qty: 5, note: 'на смену' }, { product_id: para, qty: 20, unit: 'consumption' }], notes: 'кончаются' }, NURSE);
    assert.equal(r.status, 'submitted');
    assert.deepEqual([r.holder_type, r.holder_id], ['staff', 5]);
    assert.match(first.req_number, /^REQ-\d{8}-001$/);
    assert.match(r.req_number, /^REQ-\d{8}-002$/, 'номер — одна нумерация на все заявки');
    const rows = reqs(db).filter((x) => x.id === r.req_id);
    assert.deepEqual(rows.map((x) => [x.holder_type, x.holder_id, x.department_id, x.auto, x.requested_by, x.product_id, x.qty]),
      [['staff', 5, null, 0, 5, gloves, 5], ['staff', 5, null, 0, 5, para, 2]]);
    assert.equal(rows[0].notes, 'кончаются');
    // Старый вызов не изменился: заявка отдела — держатель отдел.
    assert.deepEqual([reqs(db)[0].holder_type, reqs(db)[0].holder_id], ['department', 9]);
  } finally { db.close(); }
});

test('заявка отделу: член отдела и заведующая — да; чужой отдел — нет', () => {
  const { db, gloves } = seed();
  try {
    const byMember = stockRequestCreate(db, { for: 'department', lines: [{ product_id: gloves, qty: 3 }] }, NURSE);
    assert.deepEqual([byMember.holder_type, byMember.holder_id], ['department', 9], 'отдел по умолчанию — свой');
    const byHead = stockRequestCreate(db, { for: 'department', department_id: 9, lines: [{ product_id: gloves, qty: 3 }] }, HEAD);
    assert.equal(byHead.holder_id, 9);
    assert.equal(reqs(db).find((x) => x.id === byHead.req_id).department_id, 9);
    assert.ok(db.prepare("SELECT 1 FROM department_events WHERE department_id = 9 AND kind = 'requisition_created'").get(),
      'журнал отдела знает о заявке');

    assert.throws(() => stockRequestCreate(db, { for: 'department', department_id: 10, lines: [{ product_id: gloves, qty: 1 }] }, NURSE), forbidden);
    assert.throws(() => stockRequestCreate(db, { for: 'department', lines: [{ product_id: gloves, qty: 1 }] }, HEAD), /отдел/i,
      'заведующая без своего отдела в карточке называет отдел явно');
    assert.throws(() => stockRequestCreate(db, { for: 'me', lines: [] }, NURSE), /хотя бы одну позицию/);
    assert.throws(() => stockRequestCreate(db, { for: 'кому-то', lines: [{ product_id: gloves, qty: 1 }] }, NURSE), (e) => e.status === 400);
    assert.throws(() => stockRequestCreate(db, { for: 'me', lines: [{ product_id: gloves, qty: 1 }] }, REG), forbidden);
    assert.equal(reqs(db).length, 2);
  } finally { db.close(); }
});

// --- Решение 2: одобрение выдаёт тому, кто в заявке --------------------------

test('одобрение выдаёт держателю заявки: сотруднику — ему на руки, отделу — отделу', () => {
  const { db, gloves } = seed();
  try {
    const mine = stockRequestCreate(db, { for: 'me', lines: [{ product_id: gloves, qty: 6 }] }, NURSE);
    const dept = stockRequestCreate(db, { for: 'department', lines: [{ product_id: gloves, qty: 4 }] }, NURSE);
    approveRequisitionAndIssue(db, { req_id: mine.req_id }, INV);
    assert.equal(held(db, 'staff', 5, gloves), 6);
    assert.equal(held(db, 'department', 9, gloves), 0, 'личная заявка не ушла отделу');
    assert.equal(onHand(db, gloves), 94);
    const mv = db.prepare("SELECT qty, holder_type, holder_id FROM stock_movements WHERE reference_type='requisition' AND reference_id=?").get(mine.req_id);
    assert.deepEqual({ ...mv }, { qty: -6, holder_type: 'staff', holder_id: 5 });
    assert.equal(db.prepare("SELECT COUNT(*) n FROM department_events WHERE kind='issued'").get().n, 0,
      'выдача сотруднику в журнал отдела не пишется');

    approveRequisitionAndIssue(db, { req_id: dept.req_id }, INV);
    assert.equal(held(db, 'department', 9, gloves), 4);
    assert.equal(onHand(db, gloves), 90);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM department_events WHERE kind='issued' AND department_id=9").get().n, 1);
  } finally { db.close(); }
});

// --- Решение 1: автозаявка ---------------------------------------------------

test('автозаявка: остаток упал ниже минимума — ОДНА поданная заявка до нормы; повтор ниже минимума новой не подаёт', () => {
  const { db, gloves, visit } = seed();
  try {
    give(db, 'staff', 5, gloves, 8);
    const set = stockMinimumSet(db, { holder_type: 'staff', holder_id: 5, product_id: gloves, min_qty: 5, target_qty: 20 }, NURSE);
    assert.equal(set.request, null, '8 ≥ 5 — заявки нет');
    assert.equal(reqs(db).length, 0);

    dispenseFromHolding(db, { holder: { type: 'staff', id: 5 }, product_id: gloves, quantity: 4, visit_id: visit }, NURSE);   // 8 → 4
    let rs = reqs(db);
    assert.equal(rs.length, 1);
    assert.deepEqual([rs[0].status, rs[0].auto, rs[0].holder_type, rs[0].holder_id, rs[0].product_id, rs[0].qty, rs[0].requested_by],
      ['submitted', 1, 'staff', 5, gloves, 16, 5], 'норма 20 − остаток 4 = 16');
    assert.match(rs[0].notes, /Автозаявка: остаток 4 шт при минимуме 5 шт/);
    assert.equal(onHand(db, gloves), 92, 'автозаявка сама ничего не выдаёт');

    dispenseFromHolding(db, { holder: { type: 'staff', id: 5 }, product_id: gloves, quantity: 1, visit_id: visit }, NURSE);   // 4 → 3
    assert.equal(reqs(db).length, 1, 'пока автозаявка открыта, вторая не подаётся');

    const listed = stockMinimumsList(db, {}, NURSE).rows[0];
    assert.equal(listed.below_min, true);
    assert.equal(listed.open_request.req_number, getNumber(db, rs[0].id));
    assert.equal(listed.open_request.qty, 16);
    assert.equal(listed.open_request.auto, true);

    // Кладовщик одобрил — выдано на руки; новое пересечение подаёт новую.
    approveRequisitionAndIssue(db, { req_id: rs[0].id }, INV);
    assert.equal(held(db, 'staff', 5, gloves), 19);
    dispenseFromHolding(db, { holder: { type: 'staff', id: 5 }, product_id: gloves, quantity: 15, visit_id: visit }, NURSE);   // 19 → 4
    rs = reqs(db);
    assert.equal(rs.length, 2);
    assert.deepEqual([rs[1].status, rs[1].auto, rs[1].qty], ['submitted', 1, 16]);
  } finally { db.close(); }
});
function getNumber(db, id) { return db.prepare('SELECT req_number FROM purchase_requisitions WHERE id=?').get(id).req_number; }

test('автозаявка вычитает уже запрошенное и не выданное', () => {
  const { db, gloves, visit } = seed();
  try {
    give(db, 'staff', 5, gloves, 8);
    stockRequestCreate(db, { for: 'me', lines: [{ product_id: gloves, qty: 10 }] }, NURSE);
    stockMinimumSet(db, { holder_type: 'staff', holder_id: 5, product_id: gloves, min_qty: 5, target_qty: 20 }, NURSE);
    dispenseFromHolding(db, { holder: { type: 'staff', id: 5 }, product_id: gloves, quantity: 4, visit_id: visit }, NURSE);   // 8 → 4
    const auto = reqs(db).filter((r) => r.auto === 1);
    assert.equal(auto.length, 1);
    assert.equal(auto[0].qty, 6, '20 − 4 − 10 уже запрошенных = 6');

    // Запрошено столько, что до нормы и так хватит, — автозаявки нет.
    const { db: db2, gloves: g2, visit: v2 } = seed();
    try {
      give(db2, 'staff', 5, g2, 8);
      stockRequestCreate(db2, { for: 'me', lines: [{ product_id: g2, qty: 30 }] }, NURSE);
      stockMinimumSet(db2, { holder_type: 'staff', holder_id: 5, product_id: g2, min_qty: 5, target_qty: 20 }, NURSE);
      dispenseFromHolding(db2, { holder: { type: 'staff', id: 5 }, product_id: g2, quantity: 4, visit_id: v2 }, NURSE);
      assert.equal(reqs(db2).filter((r) => r.auto === 1).length, 0);
    } finally { db2.close(); }
  } finally { db.close(); }
});

test('автозаявка округляет до целой единицы расхода', () => {
  const { db, para, visit } = seed();
  try {
    give(db, 'staff', 5, para, 3);   // 30 таб
    stockMinimumSet(db, { holder_type: 'staff', holder_id: 5, product_id: para, min_qty: 2, target_qty: 5 }, NURSE);
    dispenseFromHolding(db, { holder: { type: 'staff', id: 5 }, product_id: para, quantity: 13, visit_id: visit }, NURSE);   // 3 → 1.7 уп
    const [r] = reqs(db);
    assert.equal(r.qty, 3.3, '5 − 1.7 = 3.3 уп = 33 таб — ровно, без дробной таблетки');
    assert.match(r.notes, /остаток 17 таб при минимуме 20 таб/, 'слова — в единицах, которыми считает медсестра');
  } finally { db.close(); }
});

test('установка минимума выше остатка подаёт заявку сразу', () => {
  const { db, gloves } = seed();
  try {
    give(db, 'department', 9, gloves, 2);
    const r = stockMinimumSet(db, { holder_type: 'department', holder_id: 9, product_id: gloves, min_qty: 5, target_qty: 12 }, HEAD);
    assert.ok(r.request, 'заявка не подана при установке минимума');
    assert.equal(r.request.qty, 10);
    const [row] = reqs(db);
    assert.deepEqual([row.holder_type, row.holder_id, row.department_id, row.auto, row.qty, row.requested_by], ['department', 9, 9, 1, 10, 4]);
    // Повторная правка минимума новой заявки не подаёт, пока та открыта.
    const again = stockMinimumSet(db, { holder_type: 'department', holder_id: 9, product_id: gloves, min_qty: 6, target_qty: 15 }, HEAD);
    assert.equal(again.request, null);
    assert.equal(reqs(db).length, 1);
    // Товара нет на руках вовсе — тоже ниже минимума.
    const s = stockMinimumSet(db, { holder_type: 'staff', holder_id: 5, product_id: gloves, min_qty: 1, target_qty: 3 }, NURSE);
    assert.equal(s.request.qty, 3);
  } finally { db.close(); }
});

test('автозаявка отдела через цепочку списания (dispense_item: своё → отдел → склад)', () => {
  const { db, gloves, visit } = seed();
  try {
    give(db, 'department', 9, gloves, 6);
    stockMinimumSet(db, { holder_type: 'department', holder_id: 9, product_id: gloves, min_qty: 4, target_qty: 10 }, HEAD);
    dispenseItem(db, { product_id: gloves, quantity: 3, visit_id: visit }, NURSE);   // из отдела: 6 → 3
    assert.equal(held(db, 'department', 9, gloves), 3);
    const [r] = reqs(db);
    assert.deepEqual([r.holder_type, r.holder_id, r.auto, r.qty, r.requested_by], ['department', 9, 1, 7, 5],
      'подала медсестра, которая списала, — держатель отдел');
  } finally { db.close(); }
});

test('откат списания не оставляет автозаявки', () => {
  const { db, gloves } = seed();
  try {
    give(db, 'staff', 5, gloves, 8);
    stockMinimumSet(db, { holder_type: 'staff', holder_id: 5, product_id: gloves, min_qty: 5, target_qty: 20 }, NURSE);
    assert.throws(() => dispenseFromHolding(db, { holder: { type: 'staff', id: 5 }, product_id: gloves, quantity: 4, visit_id: 999 }, NURSE), /Визит не найден/);
    assert.equal(held(db, 'staff', 5, gloves), 8);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM purchase_requisitions').get().n, 0, 'заявка пережила откат списания');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM purchase_requisition_items').get().n, 0);
  } finally { db.close(); }
});

test('списание никогда не отказывает из-за автозаявки', () => {
  const { db, gloves, visit } = seed();
  try {
    give(db, 'staff', 5, gloves, 8);
    stockMinimumSet(db, { holder_type: 'staff', holder_id: 5, product_id: gloves, min_qty: 5, target_qty: 20 }, NURSE);
    // Заявке не дают родиться — так выглядит любая поломка внутри автозаявки.
    db.exec("CREATE TRIGGER t_boom BEFORE INSERT ON purchase_requisition_items BEGIN SELECT RAISE(ABORT, 'boom'); END");
    const warn = console.warn; const said = [];
    console.warn = (...a) => said.push(a.join(' '));
    let r;
    try {
      r = dispenseFromHolding(db, { holder: { type: 'staff', id: 5 }, product_id: gloves, quantity: 4, visit_id: visit }, NURSE);
    } finally { console.warn = warn; }
    assert.ok(r.line_id, 'списание прошло');
    assert.equal(held(db, 'staff', 5, gloves), 4);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM purchase_requisitions').get().n, 0, 'полузаявка без строк осталась в базе');
    assert.ok(said.some((s) => /boom/.test(s)), 'поломка автозаявки не записана в журнал сервера');
  } finally { db.close(); }
});

test('возврат на руки (отмена списания) автозаявку не подаёт и не трогает', () => {
  const { db, gloves, visit } = seed();
  try {
    give(db, 'staff', 5, gloves, 3);
    stockMinimumSet(db, { holder_type: 'staff', holder_id: 5, product_id: gloves, min_qty: 5, target_qty: 20 }, NURSE);   // сразу: 17
    assert.equal(reqs(db).length, 1);
    const d = dispenseFromHolding(db, { holder: { type: 'staff', id: 5 }, product_id: gloves, quantity: 1, visit_id: visit }, NURSE);
    getRpc('void_holding_dispense')(db, { visit_service_id: d.line_id }, NURSE);
    assert.equal(held(db, 'staff', 5, gloves), 3);
    assert.equal(reqs(db).length, 1);
  } finally { db.close(); }
});

// --- «Мои заявки» (R2) ---------------------------------------------------------

test('мои заявки: открытые — мне и поданные мной для отдела; строки в единицах расхода; чужие и закрытые не видны', () => {
  const { db, gloves, para } = seed();
  try {
    const mine = stockRequestCreate(db, { for: 'me', notes: 'на смену', lines: [{ product_id: para, qty: 20, unit: 'consumption' }] }, NURSE);
    const forDept = stockRequestCreate(db, { for: 'department', lines: [{ product_id: gloves, qty: 3 }] }, NURSE);
    const done = stockRequestCreate(db, { for: 'me', lines: [{ product_id: gloves, qty: 1 }] }, NURSE);
    approveRequisitionAndIssue(db, { req_id: done.req_id }, INV);
    stockRequestCreate(db, { for: 'me', lines: [{ product_id: gloves, qty: 2 }] }, NURSE2);
    // Автозаявка мне: минимум выше остатка.
    const set = stockMinimumSet(db, { holder_type: 'staff', holder_id: 5, product_id: gloves, min_qty: 2, target_qty: 4 }, NURSE);   // на руках 1 — ниже
    assert.ok(set.request);

    const res = stockRequestsMine(db, {}, NURSE);
    assert.deepEqual(res.rows.map((r) => r.req_id), [set.request.req_id, forDept.req_id, mine.req_id], 'новые сверху; выданная и чужая — нет');
    const auto = res.rows[0];
    assert.equal(auto.auto, true);
    assert.deepEqual([auto.holder_type, auto.holder_id, auto.holder_name], ['staff', 5, 'Медсестра Ирина']);
    const dept = res.rows[1];
    assert.deepEqual([dept.holder_type, dept.holder_id, dept.holder_name, dept.auto], ['department', 9, 'Терапия', false]);
    const own = res.rows[2];
    assert.equal(own.status, 'submitted');
    assert.equal(own.notes, 'на смену');
    assert.equal(own.req_number, mine.req_number);
    assert.deepEqual(own.lines, [{ product_id: para, product_name: 'Парацетамол', qty: 2, units: 20, unit: 'таб' }],
      'человек видит таблетки, а не упаковки');

    assert.deepEqual(stockRequestsMine(db, {}, NURSE2).rows.map((r) => r.holder_id), [6]);
    assert.deepEqual(stockRequestsMine(db, {}, REG).rows, []);
  } finally { db.close(); }
});

// --- Регистрация -------------------------------------------------------------

test('вызовы зарегистрированы под своими именами', () => {
  for (const name of ['stock_minimum_set', 'stock_minimum_clear', 'stock_minimums_list', 'stock_request_create', 'stock_requests_mine']) {
    assert.equal(typeof getRpc(name), 'function', `${name} не зарегистрирован`);
  }
});

// --- Разбор ревью (2026-09-23) --------------------------------------------------

function setGrants(db, role, grants) {
  const row = db.prepare('SELECT permissions FROM role_permissions WHERE role = ?').get(role);
  const perms = row && row.permissions ? JSON.parse(row.permissions) : { sections: [], levels: {} };
  perms.grants = { ...(perms.grants || {}), ...grants };
  if (row) db.prepare('UPDATE role_permissions SET permissions = ? WHERE role = ?').run(JSON.stringify(perms), role);
  else db.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?)').run(role, JSON.stringify(perms));
}
const product = (db, name, base, cons, cf, stock = 100) => Number(db.prepare(`INSERT INTO products (name, unit, base_unit, consumption_unit, consumption_factor, sale_price, on_hand, avg_cost)
  VALUES (?, ?, ?, ?, ?, 1000, ?, 100)`).run(name, base, base, cons, cf, stock).lastInsertRowid);
const autoLines = (db) => db.prepare('SELECT i.qty FROM purchase_requisitions r JOIN purchase_requisition_items i ON i.req_id = r.id WHERE r.auto = 1 ORDER BY r.id').all().map((r) => r.qty);

test('ревью 1: кладовщик поставил минимум регистратору или отключённому — автозаявки нет', () => {
  const { db, gloves } = seed();
  try {
    const r = stockMinimumSet(db, { holder_type: 'staff', holder_id: 8, product_id: gloves, min_qty: 5, target_qty: 10 }, INV);
    assert.equal(r.request, null, 'автозаявка подана держателю, который заявок не подаёт');
    db.prepare('UPDATE users SET is_active = 0 WHERE id = 6').run();
    const r2 = stockMinimumSet(db, { holder_type: 'staff', holder_id: 6, product_id: gloves, min_qty: 5, target_qty: 10 }, INV);
    assert.equal(r2.request, null, 'автозаявка подана отключённому сотруднику');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM purchase_requisitions').get().n, 0);
    // Медсестра — может, и её автозаявка подаётся.
    assert.ok(stockMinimumSet(db, { holder_type: 'staff', holder_id: 5, product_id: gloves, min_qty: 5, target_qty: 10 }, NURSE).request);
  } finally { db.close(); }
});

test('ревью 2: минимум хранится без округления; автозаявка — целое число единиц расхода (30, 7, 1000 в упаковке)', () => {
  const { db, visit } = seed();
  try {
    // 30 таблеток в упаковке: минимум 5, норма 20 — ровно, а не «5.1 / 20.1».
    const p30 = product(db, 'Таблетки-30', 'уп', 'таб', 30);
    give(db, 'staff', 5, p30, 1);
    const set = stockMinimumSet(db, { holder_type: 'staff', holder_id: 5, product_id: p30, min_qty: 5, target_qty: 20, unit: 'consumption' }, NURSE);
    assert.ok(Math.abs(set.minimum.min_qty * 30 - 5) < 1e-9, 'минимум округлён при хранении: ' + set.minimum.min_qty);
    const row = stockMinimumsList(db, {}, NURSE).rows.find((x) => x.product_id === p30);
    assert.deepEqual([row.min_units, row.target_units], [5, 20]);
    dispenseFromHolding(db, { holder: { type: 'staff', id: 5 }, product_id: p30, quantity: 27, visit_id: visit }, NURSE);   // 30 → 3 таб
    assert.ok(Math.abs(autoLines(db)[0] * 30 - 17) < 1e-9, 'норма 20 − 3 = 17 таблеток ровно: ' + autoLines(db)[0] * 30);
    // Список отдаёт заявку так, что экран (qty × множитель) покажет 17, а не 17.1.
    const open = stockMinimumsList(db, {}, NURSE).rows.find((x) => x.product_id === p30).open_request;
    assert.equal(open.units, 17);
    assert.ok(Math.abs(open.qty * 30 - 17) < 1e-9, 'qty заявки в списке округлён: ' + open.qty * 30);

    // 7 таблеток в упаковке: 10 таблеток — это 10/7 уп., а не 1.43 (= 10.01 таб).
    const p7 = product(db, 'Таблетки-7', 'уп', 'таб', 7);
    stockMinimumSet(db, { holder_type: 'staff', holder_id: 5, product_id: p7, min_qty: 2, target_qty: 10, unit: 'consumption' }, NURSE);
    assert.ok(Math.abs(autoLines(db)[1] * 7 - 10) < 1e-9, 'заявка не целым числом таблеток: ' + autoLines(db)[1] * 7);

    // Литр и миллилитры: минимум 4 мл не превращается в ноль и срабатывает.
    const pL = product(db, 'Физраствор', 'л', 'мл', 1000);
    const s = stockMinimumSet(db, { holder_type: 'staff', holder_id: 5, product_id: pL, min_qty: 4, target_qty: 10, unit: 'consumption' }, NURSE);
    assert.ok(s.minimum.min_qty > 0, 'минимум 4 мл сохранён нулём');
    assert.ok(s.request, 'минимум 4 мл при пустых руках заявку не подал');
    assert.ok(Math.abs(s.request.qty * 1000 - 10) < 1e-9);

    // Положительное число, которое после перевода стало нулём, — отказ словами.
    assert.throws(() => stockMinimumSet(db, { holder_type: 'staff', holder_id: 5, product_id: pL, min_qty: 5e-324, target_qty: 5e-324, unit: 'consumption' }, NURSE),
      (e) => e.status === 400 && /слишком мал/i.test(e.message));
  } finally { db.close(); }
});

test('ревью 3: кто вправе открыть карточку отдела, видит его минимумы — только для чтения', () => {
  const { db, gloves } = seed();
  try {
    stockMinimumSet(db, { holder_type: 'department', holder_id: 10, product_id: gloves, min_qty: 0, target_qty: 4 }, ADMIN);
    assert.throws(() => stockMinimumsList(db, { scope: 'department', department_id: 10 }, REG), forbidden);
    setGrants(db, 'registrar', { 'settings.departments': 'view' });
    const seen = stockMinimumsList(db, { scope: 'department', department_id: 10 }, REG);
    assert.deepEqual(seen.rows.map((r) => [r.holder_id, r.can_edit]), [[10, false]]);
  } finally { db.close(); }
});

test('ревью 4: отклонённая сегодня автозаявка не подаётся снова в тот же день', () => {
  const { db, gloves, visit } = seed();
  try {
    give(db, 'staff', 5, gloves, 8);
    stockMinimumSet(db, { holder_type: 'staff', holder_id: 5, product_id: gloves, min_qty: 5, target_qty: 20 }, NURSE);
    const d = (q) => dispenseFromHolding(db, { holder: { type: 'staff', id: 5 }, product_id: gloves, quantity: q, visit_id: visit }, NURSE);
    d(4);
    const first = db.prepare('SELECT id FROM purchase_requisitions WHERE auto = 1').get().id;
    // Кладовщик отклонил («на складе пусто») — так пишет экран «Заявки».
    db.prepare("UPDATE purchase_requisitions SET status = 'rejected', reject_reason = 'нет на складе' WHERE id = ?").run(first);
    assert.ok(db.prepare('SELECT rejected_at FROM purchase_requisitions WHERE id = ?').get(first).rejected_at, 'время отклонения не записано');
    d(1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM purchase_requisitions WHERE auto = 1').get().n, 1, 'отклонённая автозаявка подана снова в тот же день');
    // Отклонили позавчера — сегодня подаётся.
    db.prepare("UPDATE purchase_requisitions SET rejected_at = strftime('%Y-%m-%dT%H:%M:%SZ','now','-2 days') WHERE id = ?").run(first);
    d(1);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM purchase_requisitions WHERE auto = 1 AND status = 'submitted'").get().n, 1);
  } finally { db.close(); }
});

test('ревью 5: заявку отключённого сотрудника одобрение не выдаёт — отказ называет человека', () => {
  const { db, gloves } = seed();
  try {
    const r = stockRequestCreate(db, { for: 'me', lines: [{ product_id: gloves, qty: 3 }] }, NURSE);
    db.prepare('UPDATE users SET is_active = 0 WHERE id = 5').run();
    assert.throws(() => approveRequisitionAndIssue(db, { req_id: r.req_id }, INV),
      (e) => e.status === 400 && /Медсестра Ирина/.test(e.message) && /отключ/i.test(e.message));
    assert.equal(onHand(db, gloves), 100, 'склад списан, хотя выдача отказана');
    assert.equal(held(db, 'staff', 5, gloves), 0);
    assert.equal(db.prepare('SELECT status FROM purchase_requisitions WHERE id = ?').get(r.req_id).status, 'submitted');
  } finally { db.close(); }
});

test('ревью 6: номер заявки — по дню клиники и без повторов после удаления', () => {
  const { db, gloves } = seed();
  try {
    const day = db.prepare("SELECT strftime('%Y%m%d','now','localtime') d").get().d;
    const mk = () => stockRequestCreate(db, { for: 'me', lines: [{ product_id: gloves, qty: 1 }] }, NURSE);
    const a = mk(); const b = mk();
    assert.equal(a.req_number, `REQ-${day}-001`, 'дата номера — не день клиники');
    assert.equal(b.req_number, `REQ-${day}-002`);
    db.prepare('DELETE FROM purchase_requisitions WHERE id = ?').run(a.req_id);
    const c = mk();
    assert.equal(c.req_number, `REQ-${day}-003`, 'номер повторился после удаления');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM purchase_requisitions WHERE req_number = ?').get(c.req_number).n, 1);
  } finally { db.close(); }
});
