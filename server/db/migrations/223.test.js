// SUPPLIERS_VAT_V1 (мигр. 223) — ставка и сумма НДС у строки заказа на
// закупку. Пусто в обеих — строка до этой версии («не указан»).
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

test('223: vat_rate и vat_amount у строки заказа; по умолчанию пусто; мусор не проходит; line_total прежний', () => {
  const db = openDb(':memory:');
  try {
    migrate(db);
    const info = db.prepare('PRAGMA table_xinfo(purchase_order_items)').all();
    for (const c of ['vat_rate', 'vat_amount']) {
      const col = info.find((x) => x.name === c);
      assert.ok(col, c);
      assert.equal(col.dflt_value, null, c + ' — по умолчанию NULL');
    }
    const p = db.prepare("INSERT INTO products (name) VALUES ('Бинт')").run().lastInsertRowid;
    const po = db.prepare("INSERT INTO purchase_orders (po_number) VALUES ('PO-1')").run().lastInsertRowid;
    const li = db.prepare('INSERT INTO purchase_order_items (po_id, product_id, qty_ordered, unit_cost) VALUES (?, ?, 10, 100)').run(po, p).lastInsertRowid;
    const row = db.prepare('SELECT vat_rate, vat_amount, line_total FROM purchase_order_items WHERE id = ?').get(li);
    assert.deepEqual({ ...row }, { vat_rate: null, vat_amount: null, line_total: 1000 });
    db.prepare('UPDATE purchase_order_items SET vat_rate = 12, vat_amount = 120 WHERE id = ?').run(li);
    assert.throws(() => db.prepare('UPDATE purchase_order_items SET vat_rate = 101 WHERE id = ?').run(li), /CHECK/);
    assert.throws(() => db.prepare('UPDATE purchase_order_items SET vat_amount = -1 WHERE id = ?').run(li), /CHECK/);
  } finally { db.close(); }
});
