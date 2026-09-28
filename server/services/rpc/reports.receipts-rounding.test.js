// SUPPLIERS_VAT_V1 (ревью M3) — «ПРИХОД ПО ПОСТАВЩИКАМ» СХОДИТСЯ СО СЧЁТОМ-ФАКТУРОЙ.
//
// Сумма строки считалась как количество × себестоимость ЕДИНИЦЫ, а она
// округлена до тийина после деления на упаковку. Проба ревью: 100 коробок по
// 3 шт по 100 000 без НДС, 12 % — отчёт давал 9 999 999 / 11 199 999, а в
// счёте-фактуре поставщика 10 000 000 / 11 200 000. Теперь приход хранит
// сумму строки без НДС так, как её ввели (stock_movements.net_amount, мигр.
// 224), а отчёт складывает её и записанный НДС.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { getRpc } from './index.js';

const ADMIN = { id: 1, role: 'admin', extra_roles: [] };
const call = (name, db, args) => getRpc(name)(db, args, ADMIN);
const objects = (r) => r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]])));
const report = (db) => call('run_report', db, { kind: 'procurement', from: '2020-01-01', to: '2099-12-31' });

function seed() {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, role, full_name) VALUES (1, 'adm', 'x', 'admin', 'Админ')").run();
  const S = Number(db.prepare("INSERT INTO suppliers (name) VALUES ('ООО Аптека')").run().lastInsertRowid);
  const P = call('product_save', db, { name: 'Перчатки', procurement_category: 'consumables', base_unit: 'пара', purchase_unit: 'кор', pack_factor: 3, vat_rate: 12 }).product.id;
  return { db, S, P };
}

test('ревью M3: 100 кор по 3 шт по 100 000 без НДС, 12 % — 10 000 000 / 1 200 000 / 11 200 000, как в счёте-фактуре', () => {
  const { db, S, P } = seed();
  try {
    call('receive_stock_lines', db, { lines: [{ product_id: P, unit: 'purchase', qty: 100, unit_cost: 100000, vat_rate: 12, supplier_id: S }] });
    const r = report(db);
    const row = objects(r)[0];
    assert.deepEqual([row['Сумма без НДС'], row['НДС'], row['Сумма с НДС']], [10000000, 1200000, 11200000]);
    assert.ok(r.notes.includes('Итого за период: без НДС 10 000 000 сум, НДС 1 200 000 сум, с НДС 11 200 000 сум.'), r.notes.join(' | '));
    assert.ok(r.notes.some((n) => n.startsWith('Итого — ООО Аптека: 1 позиция, 11 200 000 сум')), r.notes.join(' | '));
  } finally { db.close(); }
});

test('ревью M3: «без НДС», приход по заказу и импорт — тоже сумма как введена', () => {
  const { db, S, P } = seed();
  try {
    call('receive_stock_lines', db, { lines: [{ product_id: P, unit: 'purchase', qty: 100, unit_cost: 100000, vat_rate: null, supplier_id: S }] });
    // Заказ: цена за единицу выдачи 33 333,33 × 300 = 9 999 999 — так и в заказе, так и в отчёте.
    const po = call('purchase_order_create', db, { supplier_id: S, lines: [{ product_id: P, qty: 300, unit_cost: 33333.33, vat_rate: 12 }] });
    call('receive_purchase_order', db, { po_id: po.po_id });
    call('import_products_excel', db, { rows: [{ name: 'Перчатки', qty: 7, unit_cost: 1000.01, receipt_vat_rate: '12%', supplier: 'ООО Аптека' }] });
    const rows = objects(report(db));
    const net = rows.map((o) => [o['Сумма без НДС'], o['НДС'], o['Сумма с НДС']]);
    assert.deepEqual(net.find((x) => x[1] === 0), [10000000, 0, 10000000], '«без НДС»');
    assert.deepEqual(net.find((x) => x[0] === po.net), [po.net, po.vat, po.total], 'заказ: те же суммы, что в самом заказе');
    assert.deepEqual([po.net, po.vat, po.total], [9999999, 1199999.88, 11199998.88]);
    assert.deepEqual(net.find((x) => x[0] === 7000.07), [7000.07, 840.01, 7840.08], 'импорт');
  } finally { db.close(); }
});
