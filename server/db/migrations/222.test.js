// SUPPLIERS_VAT_V1 (мигр. 222) — ставка НДС у товара, у связи с поставщиком и
// у строки прихода; связи «товар ↔ поставщик» из истории приходов и из
// «основного поставщика», чтобы карточка поставщика с первого дня показывала
// всё, что клиника у него берёт.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';   // TEST_TMPDIR_V1 — папка уберётся сама

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SQL = fs.readFileSync(path.join(DIR, '222_suppliers_vat.sql'), 'utf8');

function dbBefore222() {
  const db = openDb(':memory:');
  const tmp = tmpDir('mig222-');
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.sql') && parseInt(x, 10) < 222)) {
    fs.copyFileSync(path.join(DIR, f), path.join(tmp, f));
  }
  migrate(db, tmp);
  return db;
}

test('222: колонки на месте, по умолчанию пусто («без НДС» / «не указан»), мусор не проходит', () => {
  const db = openDb(':memory:');
  try {
    migrate(db);
    for (const [t, cols] of [['products', ['vat_rate']], ['item_suppliers', ['vat_rate']], ['stock_movements', ['vat_rate', 'vat_amount']]]) {
      const info = db.prepare(`PRAGMA table_info(${t})`).all();
      for (const c of cols) {
        const col = info.find((x) => x.name === c);
        assert.ok(col, t + '.' + c);
        assert.equal(col.dflt_value, null, t + '.' + c + ' — по умолчанию NULL');
      }
    }
    const pid = db.prepare("INSERT INTO products (name) VALUES ('Бинт')").run().lastInsertRowid;
    assert.equal(db.prepare('SELECT vat_rate FROM products WHERE id = ?').get(pid).vat_rate, null);
    db.prepare('UPDATE products SET vat_rate = 12 WHERE id = ?').run(pid);
    assert.throws(() => db.prepare('UPDATE products SET vat_rate = 150 WHERE id = ?').run(pid), /CHECK/);
    assert.throws(() => db.prepare('UPDATE products SET vat_rate = -1 WHERE id = ?').run(pid), /CHECK/);
    assert.throws(() => db.prepare("INSERT INTO stock_movements (product_id, kind, qty, vat_amount) VALUES (?, 'receive', 1, -5)").run(pid), /CHECK/);
  } finally { db.close(); }
});

test('222: связи из истории приходов (с последней ценой за единицу закупки) и из основного поставщика', () => {
  const db = dbBefore222();
  try {
    const sup = (name) => Number(db.prepare('INSERT INTO suppliers (name) VALUES (?)').run(name).lastInsertRowid);
    const A = sup('ООО Аптека'); const B = sup('ООО Бинты'); const C = sup('ООО Шприцы');
    const prod = (name, pack, supplierId = null) => Number(db.prepare(
      "INSERT INTO products (name, base_unit, purchase_unit, pack_factor, supplier_id) VALUES (?, 'таб', 'уп', ?, ?)").run(name, pack, supplierId).lastInsertRowid);
    const para = prod('Парацетамол', 10);          // приходы от A (два) и по заказу от B
    const bint = prod('Бинт', 1, C);               // основной поставщик C, приходов нет
    const shpr = prod('Шприц', 1);                 // приход без поставщика — связи нет
    const mv = db.prepare(`INSERT INTO stock_movements (product_id, kind, qty, unit_cost, reference_type, reference_id, supplier_id)
                           VALUES (?, 'receive', ?, ?, ?, ?, ?)`);
    mv.run(para, 20, 100, 'manual', null, A);       // 100 за таблетку × 10 = 1000 за упаковку
    mv.run(para, 10, 120, 'manual', null, A);       // последний приход от A — 1200 за упаковку
    const po = Number(db.prepare("INSERT INTO purchase_orders (po_number, supplier_id, status) VALUES ('PO-1', ?, 'received')").run(B).lastInsertRowid);
    mv.run(para, 50, 90, 'purchase_order', po, null);
    mv.run(shpr, 5, 700, 'manual', null, null);
    db.prepare("INSERT INTO stock_movements (product_id, kind, qty, unit_cost, reference_type, supplier_id) VALUES (?, 'dispense', -3, 100, 'visit', ?)").run(para, C);
    // Связь, заведённая в карточке, — со своей ценой; её миграция не трогает.
    db.prepare('INSERT INTO item_suppliers (product_id, supplier_id, last_price) VALUES (?, ?, 5555)').run(bint, C);

    db.exec(SQL);
    const links = db.prepare(`SELECT p.name AS product, s.name AS supplier, l.last_price, l.pack_factor, l.purchase_unit, l.vat_rate
                                FROM item_suppliers l JOIN products p ON p.id = l.product_id JOIN suppliers s ON s.id = l.supplier_id
                               ORDER BY p.name, s.name`).all().map((r) => ({ ...r }));
    assert.deepEqual(links, [
      { product: 'Бинт', supplier: 'ООО Шприцы', last_price: 5555, pack_factor: null, purchase_unit: null, vat_rate: null },
      { product: 'Парацетамол', supplier: 'ООО Аптека', last_price: 1200, pack_factor: 10, purchase_unit: 'уп', vat_rate: null },
      { product: 'Парацетамол', supplier: 'ООО Бинты', last_price: 900, pack_factor: 10, purchase_unit: 'уп', vat_rate: null },
    ]);
    // Повтор ничего не меняет (дублей нет: UNIQUE (product_id, supplier_id)).
    for (const stmt of SQL.split(/;\s*\n/).filter((s) => /INSERT OR IGNORE INTO item_suppliers/.test(s))) db.exec(stmt);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM item_suppliers').get().n, 3);
  } finally { db.close(); }
});
