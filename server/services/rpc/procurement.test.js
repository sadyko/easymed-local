import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { receiveStockLines, adjustStock, issueStockLines, importProductsExcel } from './procurement.js';

function seed() {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO users (id,username,password_hash,role) VALUES (3,'inv','x','inventory'),(4,'doc','x','doctor')").run();
  // product with a pack_factor: bought in boxes of 10, held/dispensed in tabs
  const prod = db.prepare(`
    INSERT INTO products (name, unit, base_unit, purchase_unit, pack_factor, sale_price, on_hand, avg_cost)
    VALUES ('Paracetamol','tab','tab','box',10,500,0,0)
  `).run().lastInsertRowid;
  return { db, prod };
}
const inv = { id: 3, role: 'inventory' };
const doc = { id: 4, role: 'doctor' };

test('receive_stock_lines converts purchase->base and computes WAC', () => {
  const { db, prod } = seed();

  // receive 2 boxes (purchase) at cost 1000/box -> +20 tabs, cost_per_base 100, avg 100
  const r1 = receiveStockLines(db, {
    lines: [{ product_id: prod, qty: 2, unit: 'purchase', unit_cost: 1000 }],
    note: 'first delivery',
  }, inv);
  assert.equal(r1.received.length, 1);
  assert.equal(r1.received[0].base_qty, 20);
  assert.equal(r1.received[0].on_hand, 20);
  assert.equal(r1.received[0].avg_cost, 100);

  // then receive 10 tabs (base) at cost 120 -> on_hand 30, avg = (100*20 + 120*10)/30 = 106.67
  const r2 = receiveStockLines(db, {
    lines: [{ product_id: prod, qty: 10, unit: 'base', unit_cost: 120 }],
    note: 'top-up',
  }, inv);
  assert.equal(r2.received[0].base_qty, 10);
  assert.equal(r2.received[0].on_hand, 30);
  assert.equal(r2.received[0].avg_cost, 106.67);

  const product = db.prepare('SELECT on_hand, avg_cost FROM products WHERE id=?').get(prod);
  assert.equal(product.on_hand, 30);
  assert.equal(product.avg_cost, 106.67);

  const movements = db.prepare("SELECT qty, unit_cost FROM stock_movements WHERE product_id=? AND kind='receive' ORDER BY id").all(prod);
  assert.equal(movements.length, 2);
  assert.equal(movements[0].qty, 20);
  assert.equal(movements[0].unit_cost, 100);
  assert.equal(movements[1].qty, 10);
  assert.equal(movements[1].unit_cost, 120);
});

test('receive rejects empty lines, bad qty, and non-inventory role', () => {
  const { db, prod } = seed();
  assert.throws(() => receiveStockLines(db, { lines: [] }, inv), /lines/i);
  assert.throws(() => receiveStockLines(db, { lines: [{ product_id: prod, qty: 0, unit: 'base' }] }, inv), /qty/i);
  assert.throws(() => receiveStockLines(db, { lines: [{ product_id: prod, qty: -5, unit: 'base' }] }, inv), /qty/i);
  assert.throws(() => receiveStockLines(db, { lines: [{ product_id: prod, qty: 2_000_000, unit: 'base' }] }, inv), /qty/i);
  assert.throws(() => receiveStockLines(db, { lines: [{ product_id: prod, qty: 1, unit: 'base' }] }, doc), /(role|allow)/i);
  // nothing persisted from the failed attempts
  assert.equal(db.prepare('SELECT on_hand FROM products WHERE id=?').get(prod).on_hand, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM stock_movements').get().n, 0);
});

test('adjust_stock changes on_hand with a signed movement and rejects going negative / missing note / zero', () => {
  const { db, prod } = seed();
  receiveStockLines(db, { lines: [{ product_id: prod, qty: 20, unit: 'base', unit_cost: 100 }] }, inv);

  const down = adjustStock(db, { product_id: prod, qty: -5, note: 'breakage' }, inv);
  assert.equal(down.on_hand, 15);
  const m = db.prepare("SELECT qty, kind, note FROM stock_movements WHERE kind='adjust'").get();
  assert.equal(m.qty, -5);
  assert.equal(m.note, 'breakage');

  const up = adjustStock(db, { product_id: prod, qty: 3, note: 'recount' }, inv);
  assert.equal(up.on_hand, 18);

  assert.throws(() => adjustStock(db, { product_id: prod, qty: -1000, note: 'oops' }, inv), /negative/i);
  assert.throws(() => adjustStock(db, { product_id: prod, qty: -1, note: '' }, inv), /note/i);
  assert.throws(() => adjustStock(db, { product_id: prod, qty: 0, note: 'x' }, inv), /qty|zero/i);
  assert.throws(() => adjustStock(db, { product_id: prod, qty: 1, note: 'x' }, doc), /(role|allow)/i);
  // unchanged after the failed attempts
  assert.equal(db.prepare('SELECT on_hand FROM products WHERE id=?').get(prod).on_hand, 18);
});
test('issue_stock_lines converts consumption->base, decrements stock, records recipient', () => {
  const { db, prod } = seed();
  // held in флаконы; 1 флакон = 50 мл расхода
  db.prepare("UPDATE products SET base_unit='флакон', consumption_unit='мл', consumption_factor=50, on_hand=10, avg_cost=2000 WHERE id=?").run(prod);

  const r = issueStockLines(db, {
    lines: [{ product_id: prod, qty: 100, unit: 'consumption' }],   // 100 мл = 2 флакона
    recipient: 'Процедурный кабинет',
    note: 'капельницы',
  }, inv);
  assert.equal(r.issued.length, 1);
  assert.equal(r.issued[0].base_qty, 2);
  assert.equal(r.issued[0].on_hand, 8);
  assert.equal(db.prepare('SELECT on_hand FROM products WHERE id=?').get(prod).on_hand, 8);

  const m = db.prepare("SELECT * FROM stock_movements WHERE reference_type='issue'").get();
  assert.equal(m.kind, 'dispense');
  assert.equal(m.qty, -2);                      // dispense is negative
  assert.equal(m.unit_cost, 2000);              // costed at avg_cost
  assert.match(m.note, /Процедурный кабинет/);  // recipient lives in the note
  assert.match(m.note, /капельницы/);
  assert.equal(m.created_by, inv.id);

  // qty below half a hundredth of a base unit rounds to 0 -> must be rejected, never a free movement
  assert.throws(() => issueStockLines(db, { lines: [{ product_id: prod, qty: 0.1 }], recipient: 'R' }, inv), /too small/);
});

test('issue_stock_lines: base-unit issue and consumption default when no consumption unit set', () => {
  const { db, prod } = seed();   // Paracetamol: no consumption_unit, factor 1
  receiveStockLines(db, { lines: [{ product_id: prod, qty: 20, unit: 'base', unit_cost: 100 }] }, inv);

  const r1 = issueStockLines(db, { lines: [{ product_id: prod, qty: 5, unit: 'base' }], recipient: 'Лаборатория' }, inv);
  assert.equal(r1.issued[0].base_qty, 5);
  assert.equal(r1.issued[0].on_hand, 15);

  // unit omitted -> 'consumption'; with no consumption_unit the factor is 1
  const r2 = issueStockLines(db, { lines: [{ product_id: prod, qty: 3 }], recipient: 'Лаборатория' }, inv);
  assert.equal(r2.issued[0].base_qty, 3);
  assert.equal(r2.issued[0].on_hand, 12);
});

test('issue_stock_lines rejects overdraw atomically, missing recipient, bad role', () => {
  const { db, prod } = seed();
  receiveStockLines(db, { lines: [{ product_id: prod, qty: 5, unit: 'base', unit_cost: 100 }] }, inv);

  // two lines, second overdraws -> nothing from EITHER line is committed
  assert.throws(() => issueStockLines(db, {
    lines: [{ product_id: prod, qty: 2, unit: 'base' }, { product_id: prod, qty: 100, unit: 'base' }],
    recipient: 'Лаборатория',
  }, inv), /Недостаточно/);
  assert.equal(db.prepare('SELECT on_hand FROM products WHERE id=?').get(prod).on_hand, 5);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM stock_movements WHERE reference_type='issue'").get().n, 0);

  assert.throws(() => issueStockLines(db, { lines: [{ product_id: prod, qty: 1 }], recipient: '' }, inv), /recipient/i);
  assert.throws(() => issueStockLines(db, { lines: [{ product_id: prod, qty: 1 }] }, inv), /recipient/i);
  assert.throws(() => issueStockLines(db, { lines: [], recipient: 'X' }, inv), /lines/i);
  assert.throws(() => issueStockLines(db, { lines: [{ product_id: prod, qty: 1 }], recipient: 'X' }, doc), /(role|allow)/i);
});

test('import_products_excel creates, updates, receives with WAC, auto-creates suppliers', () => {
  const { db } = seed();
  const r1 = importProductsExcel(db, { rows: [
    { name: 'Шприц 5мл', unit: 'шт', qty: 100, unit_cost: 500, reorder_level: 20, supplier: 'ООО Медснаб' },
    { name: 'Бинт 7м', unit: 'шт' },   // catalog-only row: no qty -> no movement
  ] }, inv);
  assert.deepEqual(r1, { created: 2, updated: 0, received: 1 });

  const p = db.prepare("SELECT * FROM products WHERE name='Шприц 5мл'").get();
  assert.equal(p.on_hand, 100);
  assert.equal(p.avg_cost, 500);
  assert.equal(p.reorder_level, 20);
  assert.equal(p.base_unit, 'шт');
  assert.equal(p.active, 1);

  const s = db.prepare("SELECT * FROM suppliers WHERE name='ООО Медснаб'").get();
  assert.ok(s, 'supplier auto-created');
  assert.equal(p.supplier_id, s.id);

  const m = db.prepare("SELECT * FROM stock_movements WHERE reference_type='import'").get();
  assert.equal(m.kind, 'receive');
  assert.equal(m.qty, 100);
  assert.equal(m.unit_cost, 500);

  // re-import same name -> update path, WAC over the top-up, supplier kept
  const r2 = importProductsExcel(db, { rows: [{ name: 'Шприц 5мл', qty: 100, unit_cost: 700 }] }, inv);
  assert.deepEqual(r2, { created: 0, updated: 1, received: 1 });
  const p2 = db.prepare("SELECT * FROM products WHERE name='Шприц 5мл'").get();
  assert.equal(p2.on_hand, 200);
  assert.equal(p2.avg_cost, 600);      // (500*100 + 700*100) / 200
  assert.equal(p2.supplier_id, s.id);  // not resent -> unchanged
  assert.equal(db.prepare('SELECT COUNT(*) n FROM suppliers').get().n, 1);  // no duplicate supplier
});

test('import_products_excel aborts the whole batch on a bad row, names the Excel row number', () => {
  const { db } = seed();
  // data row i has Excel row number i+2 (row 1 is the header)
  assert.throws(() => importProductsExcel(db, { rows: [
    { name: 'Товар А', qty: 5, supplier: 'ООО Тест' },
    { name: '', qty: 3 },
  ] }, inv), /Строка 3/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM products WHERE name='Товар А'").get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM stock_movements').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM suppliers').get().n, 0);   // supplier creation rolled back too

  assert.throws(() => importProductsExcel(db, { rows: [{ name: 'X', qty: -1 }] }, inv), /Строка 2/);
  assert.throws(() => importProductsExcel(db, { rows: [] }, inv), /rows/i);
  assert.throws(() => importProductsExcel(db, { rows: [{ name: 'X' }] }, doc), /(role|allow)/i);

  assert.throws(() => importProductsExcel(db, { rows: [{ name: 'X', qty: [1, 2] }] }, inv), /Кол-во/);
  assert.throws(() => importProductsExcel(db, { rows: [{ name: 'X', qty: '0x10' }] }, inv), /Кол-во/);
  assert.throws(() => importProductsExcel(db, { rows: [{ name: 'Ы'.repeat(201) }] }, inv), /длиннее/);
});

// ---- RECEIVE_EASYMED_V1 -----------------------------------------------------
test('receive_stock_lines stores supplier/batch/expiry on the movement (mig 037)', () => {
  const { db, prod } = seed();
  db.prepare("INSERT INTO suppliers (id, name) VALUES (5,'Aventus')").run();
  receiveStockLines(db, { lines: [
    { product_id: prod, unit: 'purchase', qty: 2, unit_cost: 10000, supplier_id: 5, batch_no: 'B-260807', expiry_date: '2027-01-31' },
  ] }, inv);
  const m = db.prepare("SELECT supplier_id, batch_no, expiry_date FROM stock_movements WHERE kind='receive' ORDER BY id DESC LIMIT 1").get();
  assert.equal(m.supplier_id, 5);
  assert.equal(m.batch_no, 'B-260807');
  assert.equal(m.expiry_date, '2027-01-31');
  // без полей — тоже работает (все опциональны)
  receiveStockLines(db, { lines: [{ product_id: prod, unit: 'base', qty: 1, unit_cost: 500 }] }, inv);
  // мусор отклоняется чисто
  assert.throws(() => receiveStockLines(db, { lines: [{ product_id: prod, unit: 'base', qty: 1, unit_cost: 1, expiry_date: '31.01.2027' }] }, inv), /YYYY-MM-DD/);
  assert.throws(() => receiveStockLines(db, { lines: [{ product_id: prod, unit: 'base', qty: 1, unit_cost: 1, supplier_id: 999 }] }, inv), /supplier not found/);
});
