// SUPPLIERS_VAT_V1 (ревью F2) — ЦЕНА СВЯЗИ «ТОВАР ↔ ПОСТАВЩИК» — ЗА ЕДИНИЦУ
// ЗАКУПКИ СВЯЗИ, А НЕ ТОВАРА.
//
// Карточка товара хранит у каждого поставщика свою упаковку («1 кор = 100
// таб»), и карточка поставщика подписывает цену «сум за кор». А все
// потребители делили цену связи на упаковку ТОВАРА: товар — 10 таб в
// упаковке, связь — 9 000 за коробку из 100, и заказ подставлял 900 за
// таблетку вместо 90 (сумма заказа 90 000 вместо 9 000, себестоимость после
// прихода 1 008 вместо 100,8). И обратно: цена, запомненная после прихода,
// писалась в упаковке товара, а упаковка связи оставалась своей.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { getRpc } from './index.js';

const INV = { id: 2, role: 'inventory', extra_roles: [] };
const call = (name, db, args) => getRpc(name)(db, args, INV);

function seed() {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, role, full_name) VALUES (2, 'inv', 'x', 'inventory', 'Кладовщик')").run();
  const A = Number(db.prepare("INSERT INTO suppliers (name) VALUES ('ООО Аптека')").run().lastInsertRowid);
  const B = Number(db.prepare("INSERT INTO suppliers (name) VALUES ('ООО Бинты')").run().lastInsertRowid);
  // Товар: 10 таб в упаковке; у поставщика A — коробка из 100 таб по 9 000 без НДС, 12 %.
  const P = call('product_save', db, { name: 'Парацетамол', procurement_category: 'medicines', base_unit: 'таб', purchase_unit: 'уп', pack_factor: 10,
    vat_rate: 12, suppliers: [{ supplier_id: A, last_price: 9000, vat_rate: 12, pack_factor: 100, purchase_unit: 'кор' }] }).product.id;
  return { db, A, B, P };
}
const link = (db, P, S) => ({ ...db.prepare('SELECT last_price, vat_rate, pack_factor, purchase_unit FROM item_suppliers WHERE product_id = ? AND supplier_id = ?').get(P, S) });

test('ревью F2: заказ без цены — цена связи ÷ упаковка СВЯЗИ: 9 000 за кор (100) → 90 за таб; сумма 9 000, а не 90 000', () => {
  const { db, A, P } = seed();
  try {
    const r = call('purchase_order_create', db, { supplier_id: A, lines: [{ product_id: P, qty: 100 }] });
    const it = db.prepare('SELECT unit_cost, vat_rate, vat_amount FROM purchase_order_items WHERE po_id = ?').get(r.po_id);
    assert.deepEqual({ ...it }, { unit_cost: 90, vat_rate: 12, vat_amount: 1080 });
    assert.deepEqual({ net: r.net, vat: r.vat, total: r.total }, { net: 9000, vat: 1080, total: 10080 });
    // Приход по заказу: себестоимость с НДС — 100,8 за таблетку, а не 1 008.
    call('receive_purchase_order', db, { po_id: r.po_id });
    assert.equal(db.prepare('SELECT avg_cost FROM products WHERE id = ?').get(P).avg_cost, 100.8);
    // Связь помнит цену в СВОЕЙ упаковке: 90 × 100 = 9 000 за кор; упаковка связи — прежняя.
    assert.deepEqual(link(db, P, A), { last_price: 9000, vat_rate: 12, pack_factor: 100, purchase_unit: 'кор' });
  } finally { db.close(); }
});

test('ревью F2: приход в упаковке товара (уп = 10 таб) по 950 — связь помнит 9 500 за свою кор (100 таб)', () => {
  const { db, A, P } = seed();
  try {
    call('receive_stock_lines', db, { lines: [{ product_id: P, unit: 'purchase', qty: 2, unit_cost: 950, vat_rate: 12, supplier_id: A }] });
    assert.deepEqual(link(db, P, A), { last_price: 9500, vat_rate: 12, pack_factor: 100, purchase_unit: 'кор' });
    // И в базовой единице: 96 за таб → 9 600 за кор.
    call('receive_stock_lines', db, { lines: [{ product_id: P, unit: 'base', qty: 5, unit_cost: 96, vat_rate: 12, supplier_id: A }] });
    assert.equal(link(db, P, A).last_price, 9600);
  } finally { db.close(); }
});

test('ревью F2: новая связь из прихода — в упаковке товара; импорт — в упаковке связи', () => {
  const { db, A, B, P } = seed();
  try {
    call('receive_stock_lines', db, { lines: [{ product_id: P, unit: 'purchase', qty: 1, unit_cost: 800, supplier_id: B }] });
    assert.deepEqual(link(db, P, B), { last_price: 800, vat_rate: null, pack_factor: 10, purchase_unit: 'уп' }, 'связи не было — упаковка товара');
    // Импорт: цена за базовую единицу (таб) → связь A помнит её за свою коробку.
    call('import_products_excel', db, { rows: [{ name: 'Парацетамол', qty: 50, unit_cost: 91, supplier: 'ООО Аптека' }] });
    assert.equal(link(db, P, A).last_price, 9100);
  } finally { db.close(); }
});
