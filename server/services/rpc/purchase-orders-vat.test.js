// SUPPLIERS_VAT_V1 (2026-09-28) — НДС в заказе на закупку.
//
//   purchase_order_create — строки заказа с ценой без НДС и ставкой НДС: по
//     умолчанию — из связи товара с поставщиком заказа (цена за единицу
//     закупки → за базовую единицу), иначе ставка товара; НДС строки и сумма
//     заказа с НДС считает сервер; право «Закупки: Изменение».
//   receive_purchase_order — приход по заказу пишет ставку и НДС принятого
//     количества, себестоимость — с НДС, связь с поставщиком помнит цену и
//     ставку; строка заказа до НДС — «не указан», как прежде; право —
//     «Закупки: Изменение», как у «Принять товар».
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { getRpc } from './index.js';
import { isReadOnlyRpc } from '../control/gate.js';

const ADMIN = { id: 1, role: 'admin', extra_roles: [] };
const INV = { id: 2, role: 'inventory', extra_roles: [] };
const DOC = { id: 3, role: 'doctor', extra_roles: [] };
const call = (name, db, args, user = INV) => getRpc(name)(db, args, user);

function seed() {
  const db = openDb(':memory:'); migrate(db);
  const u = db.prepare("INSERT INTO users (id, username, password_hash, role, full_name) VALUES (?, ?, 'x', ?, ?)");
  u.run(1, 'adm', 'admin', 'Админ'); u.run(2, 'inv', 'inventory', 'Кладовщик'); u.run(3, 'doc', 'doctor', 'Врач');
  const A = Number(db.prepare("INSERT INTO suppliers (name) VALUES ('ООО Аптека')").run().lastInsertRowid);
  const save = (args) => call('product_save', db, args).product.id;
  // Анальгин: упаковка 10 таблеток, у Аптеки 1 000 за упаковку без НДС, 12 %.
  const anal = save({ name: 'Анальгин', procurement_category: 'medicines', base_unit: 'таб', purchase_unit: 'уп', pack_factor: 10, vat_rate: 0,
    suppliers: [{ supplier_id: A, last_price: 1000, vat_rate: 12 }] });
  // Бинт: связи нет, ставка товара 12 %.
  const bint = save({ name: 'Бинт', procurement_category: 'consumables', vat_rate: 12 });
  // Шприц: связи нет, товар «без НДС».
  const shpr = save({ name: 'Шприц', procurement_category: 'consumables', vat_rate: null });
  return { db, A, anal, bint, shpr };
}
const items = (db, po) => db.prepare('SELECT product_id, qty_ordered, unit_cost, vat_rate, vat_amount, line_total FROM purchase_order_items WHERE po_id = ? ORDER BY id')
  .all(po).map((r) => ({ ...r }));
const link = (db, pid, sid) => ({ ...db.prepare('SELECT last_price, vat_rate FROM item_suppliers WHERE product_id = ? AND supplier_id = ?').get(pid, sid) });

test('purchase_order_create: цена и НДС по умолчанию — из связи с поставщиком, иначе ставка товара; сумма заказа — с НДС', () => {
  const { db, A, anal, bint, shpr } = seed();
  const r = call('purchase_order_create', db, { supplier_id: A, notes: 'срочно', lines: [
    { product_id: anal, qty: 20 },                                    // цена 1 000 / 10 = 100 за таблетку, 12 %
    { product_id: bint, qty: 5, unit_cost: 2000 },                    // ставка товара — 12 %
    { product_id: shpr, qty: 10, unit_cost: 50, vat_rate: null },     // «без НДС» явно
  ] });
  assert.match(r.po_number, /^PO-\d{8}-\d{3}$/);
  assert.deepEqual(items(db, r.po_id), [
    { product_id: anal, qty_ordered: 20, unit_cost: 100, vat_rate: 12, vat_amount: 240, line_total: 2000 },
    { product_id: bint, qty_ordered: 5, unit_cost: 2000, vat_rate: 12, vat_amount: 1200, line_total: 10000 },
    { product_id: shpr, qty_ordered: 10, unit_cost: 50, vat_rate: null, vat_amount: 0, line_total: 500 },
  ]);
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(r.po_id);
  assert.equal(po.total, 13940, 'с НДС: 2 240 + 11 200 + 500');
  assert.equal(po.supplier_id, A);
  assert.equal(po.status, 'draft');
  assert.equal(po.notes, 'срочно');
  assert.equal(po.created_by, INV.id);
  assert.deepEqual([r.net, r.vat, r.total], [12500, 1440, 13940]);
  // Ставка 0 % и явная цена поверх связи.
  const r2 = call('purchase_order_create', db, { supplier_id: A, lines: [{ product_id: anal, qty: 1, unit_cost: 90, vat_rate: 0 }] });
  assert.deepEqual(items(db, r2.po_id)[0], { product_id: anal, qty_ordered: 1, unit_cost: 90, vat_rate: 0, vat_amount: 0, line_total: 90 });
  assert.match(r2.po_number, /-002$/, 'номер по порядку за день');
});

test('purchase_order_create: неверные строки, поставщик и ставка — отказ, ничего не записано; право «Закупки: Изменение»', () => {
  const { db, A, anal } = seed();
  const bad = (args, re, status = 400, user = INV) => assert.throws(() => call('purchase_order_create', db, args, user),
    (e) => e.status === status && re.test(e.message), JSON.stringify(args));
  bad({ supplier_id: A, lines: [] }, /Добавьте хотя бы одну строку/);
  bad({ supplier_id: A, lines: [{ product_id: anal, qty: 0 }] }, /Количество/);
  bad({ supplier_id: A, lines: [{ product_id: anal, qty: 1, vat_rate: 15 }] }, /Ставка НДС — 12 %, 0 % или «без НДС»/);
  bad({ supplier_id: A, lines: [{ product_id: anal, qty: 1, unit_cost: -5 }] }, /Цена закупки — неотрицательное число/);
  bad({ supplier_id: A, lines: [{ product_id: 999, qty: 1 }] }, /Товар №999 не найден/, 404);
  bad({ supplier_id: 999, lines: [{ product_id: anal, qty: 1 }] }, /Поставщик не найден/, 404);
  bad({ supplier_id: A, lines: [{ product_id: anal, qty: 1 }] }, /недоступно вашей роли/, 403, DOC);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM purchase_orders').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM purchase_order_items').get().n, 0);
  assert.equal(isReadOnlyRpc('purchase_order_create'), false);
  // Без поставщика — можно: ставка и цена — товара (цены нет — 0).
  const r = call('purchase_order_create', db, { lines: [{ product_id: anal, qty: 2 }] }, ADMIN);
  assert.deepEqual(items(db, r.po_id)[0], { product_id: anal, qty_ordered: 2, unit_cost: 0, vat_rate: 0, vat_amount: 0, line_total: 0 });
});

test('приход по заказу: НДС принятого количества, себестоимость с НДС, связь помнит цену и ставку', () => {
  const { db, A, anal, shpr } = seed();
  const r = call('purchase_order_create', db, { supplier_id: A, lines: [
    { product_id: anal, qty: 20 }, { product_id: shpr, qty: 10, unit_cost: 50, vat_rate: null }] });
  const [li1] = db.prepare('SELECT id FROM purchase_order_items WHERE po_id = ? ORDER BY id').all(r.po_id).map((x) => x.id);
  // Частично: 5 таблеток анальгина.
  call('receive_purchase_order', db, { po_id: r.po_id, lines: [{ po_item_id: li1, qty: 5 }] });
  let mv = db.prepare("SELECT qty, unit_cost, vat_rate, vat_amount, supplier_id FROM stock_movements WHERE kind = 'receive' ORDER BY id").all().map((x) => ({ ...x }));
  assert.deepEqual(mv, [{ qty: 5, unit_cost: 112, vat_rate: 12, vat_amount: 60, supplier_id: A }]);
  assert.equal(db.prepare('SELECT avg_cost FROM products WHERE id = ?').get(anal).avg_cost, 112, 'себестоимость с НДС: 100 × 1,12');
  // Остальное — «Принять всё».
  call('receive_purchase_order', db, { po_id: r.po_id });
  mv = db.prepare("SELECT product_id, qty, unit_cost, vat_rate, vat_amount FROM stock_movements WHERE kind = 'receive' ORDER BY id").all().map((x) => ({ ...x }));
  assert.deepEqual(mv.slice(1), [
    { product_id: anal, qty: 15, unit_cost: 112, vat_rate: 12, vat_amount: 180 },
    { product_id: shpr, qty: 10, unit_cost: 50, vat_rate: null, vat_amount: 0 },
  ]);
  assert.equal(db.prepare('SELECT status FROM purchase_orders WHERE id = ?').get(r.po_id).status, 'received');
  // Связь: цена за упаковку (100 × 10) и ставка; шприц у Аптеки — новая связь «без НДС».
  assert.deepEqual(link(db, anal, A), { last_price: 1000, vat_rate: 12 });
  assert.deepEqual(link(db, shpr, A), { last_price: 50, vat_rate: null });
  // «Приход по поставщикам» показывает НДС прихода по заказу.
  const rep = getRpc('run_report')(db, { kind: 'procurement', from: '2020-01-01', to: '2099-12-31' }, ADMIN);
  const rows = rep.rows.map((row) => Object.fromEntries(rep.columns.map((c, i) => [c, row[i]])));
  const a = rows.filter((o) => o['Товар'] === 'Анальгин');
  assert.deepEqual(a.map((o) => [o['Ставка НДС'], o['НДС'], o['Сумма без НДС'], o['Сумма с НДС']]).sort(),
    [['12 %', 180, 1500, 1680], ['12 %', 60, 500, 560]]);
  assert.equal(rows.find((o) => o['Товар'] === 'Шприц')['Ставка НДС'], 'без НДС');
});

test('приход по заказу, оформленному до НДС: «не указан», цена — себестоимость, как прежде; ставка связи не стирается', () => {
  const { db, A, anal } = seed();
  const po = db.prepare("INSERT INTO purchase_orders (po_number, supplier_id) VALUES ('PO-OLD', ?)").run(A).lastInsertRowid;
  db.prepare('INSERT INTO purchase_order_items (po_id, product_id, qty_ordered, unit_cost) VALUES (?, ?, 10, 95)').run(po, anal);
  call('receive_purchase_order', db, { po_id: po });
  const mv = db.prepare("SELECT qty, unit_cost, vat_rate, vat_amount FROM stock_movements WHERE kind = 'receive'").get();
  assert.deepEqual({ ...mv }, { qty: 10, unit_cost: 95, vat_rate: null, vat_amount: null });
  assert.deepEqual(link(db, anal, A), { last_price: 950, vat_rate: 12 }, 'цена обновлена, ставка поставщика осталась');
});

test('приход по заказу: право «Закупки: Изменение», как у «Принять товар»', () => {
  const { db, A, anal } = seed();
  const r = call('purchase_order_create', db, { supplier_id: A, lines: [{ product_id: anal, qty: 1 }] });
  assert.throws(() => call('receive_purchase_order', db, { po_id: r.po_id }, DOC), (e) => e.status === 403 && /недоступно вашей роли/.test(e.message));
  db.prepare('INSERT OR REPLACE INTO role_permissions (role, permissions) VALUES (?, ?)')
    .run('inventory', JSON.stringify({ sections: ['inventory'], levels: { inventory: 'viewer' }, grants: { procurement: 'view' } }));
  assert.throws(() => call('receive_purchase_order', db, { po_id: r.po_id }, INV), (e) => e.status === 403);
  assert.throws(() => call('purchase_order_create', db, { supplier_id: A, lines: [{ product_id: anal, qty: 1 }] }, INV), (e) => e.status === 403);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM stock_movements").get().n, 0);
  assert.equal(call('receive_purchase_order', db, { po_id: r.po_id }, ADMIN).status, 'received');
});
