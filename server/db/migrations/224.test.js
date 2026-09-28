// SUPPLIERS_VAT_V1 (ревью F3, M9, M3; мигр. 224) — ставка НДС товара записана
// у строки (визита, стационара, счёта) в момент выдачи; сумма прихода без НДС
// — как её ввели. Строки до миграции ставки не получают: прошлое не меняется.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SQL = fs.readFileSync(path.join(DIR, '224_goods_vat_snapshot.sql'), 'utf8');

function dbBefore224() {
  const db = openDb(':memory:');
  const tmp = tmpDir('mig224-');
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.sql') && parseInt(x, 10) < 224)) {
    fs.copyFileSync(path.join(DIR, f), path.join(tmp, f));
  }
  migrate(db, tmp);
  return db;
}

function seedSale(db) {
  db.prepare("INSERT INTO products (id, name, sale_price, vat_rate) VALUES (1, 'Бинт', 56000, 12)").run();
  db.prepare("INSERT INTO patients (id, mrn, full_name) VALUES (1, 'A-1', 'Азизов')").run();
  const v = db.prepare("INSERT INTO visits (patient_id, visit_date, status) VALUES (1, '2026-08-01', 'arrived')").run().lastInsertRowid;
  const vs = db.prepare("INSERT INTO visit_services (visit_id, clinic_item_id, quantity, unit_price, total, status) VALUES (?, 1, 2, 56000, 112000, 'added')").run(v).lastInsertRowid;
  const inv = db.prepare("INSERT INTO invoices (invoice_number, visit_id, patient_id, subtotal, total_amount, status) VALUES ('INV-1', ?, 1, 112000, 112000, 'unpaid')").run(v).lastInsertRowid;
  const ii = db.prepare("INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, total) VALUES (?, 'Бинт', 2, 56000, 112000)").run(inv).lastInsertRowid;
  db.prepare('UPDATE visit_services SET invoice_item_id = ? WHERE id = ?').run(ii, vs);
  return { v, vs, inv, ii };
}

test('224: колонки на месте, по умолчанию пусто, мусор не проходит', () => {
  const db = openDb(':memory:');
  try {
    migrate(db);
    for (const [t, c] of [['visit_services', 'goods_vat_rate'], ['admission_services', 'goods_vat_rate'], ['invoice_items', 'goods_vat_rate'], ['stock_movements', 'net_amount']]) {
      const col = db.prepare(`PRAGMA table_info(${t})`).all().find((x) => x.name === c);
      assert.ok(col, `${t}.${c}`);
      assert.equal(col.dflt_value, null);
    }
    const { ii } = seedSale(db);
    assert.throws(() => db.prepare('UPDATE invoice_items SET goods_vat_rate = 101 WHERE id = ?').run(ii), /CHECK/);
    assert.throws(() => db.prepare("INSERT INTO stock_movements (product_id, kind, qty, net_amount) VALUES (1, 'receive', 1, -1)").run(), /CHECK/);
  } finally { db.close(); }
});

test('224: строки ДО миграции ставки не получают — прошлое считается как в 3.12.1', () => {
  const db = dbBefore224();
  try {
    const { vs, ii } = seedSale(db);
    db.exec(SQL);
    assert.equal(db.prepare('SELECT goods_vat_rate FROM visit_services WHERE id = ?').get(vs).goods_vat_rate, null);
    assert.equal(db.prepare('SELECT goods_vat_rate FROM invoice_items WHERE id = ?').get(ii).goods_vat_rate, null);
  } finally { db.close(); }
});

test('224: выдача записывает ставку товара; выставление переносит её в строку счёта; правка карточки потом её не трогает', () => {
  const db = openDb(':memory:');
  try {
    migrate(db);
    const { vs, ii } = seedSale(db);
    assert.equal(db.prepare('SELECT goods_vat_rate FROM visit_services WHERE id = ?').get(vs).goods_vat_rate, 12);
    assert.equal(db.prepare('SELECT goods_vat_rate FROM invoice_items WHERE id = ?').get(ii).goods_vat_rate, 12);
    db.prepare('UPDATE products SET vat_rate = 0 WHERE id = 1').run();
    assert.equal(db.prepare('SELECT goods_vat_rate FROM invoice_items WHERE id = ?').get(ii).goods_vat_rate, 12);
    // Строка услуги (service_id) ставки товара не получает.
    const sid = db.prepare("INSERT INTO services (name, price) VALUES ('Приём', 100)").run().lastInsertRowid;
    const ii2 = db.prepare("INSERT INTO invoice_items (invoice_id, service_id, description, quantity, unit_price, total) VALUES (1, ?, 'Приём', 1, 100, 100)").run(sid).lastInsertRowid;
    assert.equal(db.prepare('SELECT goods_vat_rate FROM invoice_items WHERE id = ?').get(ii2).goods_vat_rate, null);
    // Строка стационара, вставленная сразу со строкой счёта, — тоже.
    db.prepare("INSERT INTO admissions (id, patient_id, status) VALUES (1, 1, 'active')").run();
    const aii = db.prepare("INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, total) VALUES (1, 'Бинт', 1, 56000, 56000)").run().lastInsertRowid;
    db.prepare('UPDATE products SET vat_rate = 12 WHERE id = 1').run();
    db.prepare("INSERT INTO admission_services (admission_id, clinic_item_id, quantity, unit_price, total, status, invoice_item_id) VALUES (1, 1, 1, 56000, 56000, 'added', ?)").run(aii);
    assert.equal(db.prepare('SELECT goods_vat_rate FROM invoice_items WHERE id = ?').get(aii).goods_vat_rate, 12);
  } finally { db.close(); }
});

test('224: ставка строки счёта журналируется для соседей (M9) — только когда меняется', () => {
  const db = openDb(':memory:');
  try {
    migrate(db);
    const { ii } = seedSale(db);
    db.prepare('DELETE FROM sync_journal').run();
    db.prepare('UPDATE invoice_items SET goods_vat_rate = 0 WHERE id = ?').run(ii);
    assert.deepEqual(db.prepare("SELECT cols FROM sync_journal WHERE tbl = 'invoice_items'").all().map((r) => r.cols), ['goods_vat_rate']);
    db.prepare('DELETE FROM sync_journal').run();
    db.prepare('UPDATE invoice_items SET goods_vat_rate = 0 WHERE id = ?').run(ii);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM sync_journal').get().n, 0, 'то же значение — не правка');
  } finally { db.close(); }
});
