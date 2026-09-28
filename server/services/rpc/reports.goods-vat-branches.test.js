// SUPPLIERS_VAT_V1 (ревью M9) — НДС ТОВАРА В СЧЁТЕ СОСЕДНЕГО ЗДАНИЯ.
//
// Строка счёта соседа приезжает БЕЗ строки визита: invoice_item_id — местная
// ссылка и не ездит (journal.js). Первая версия искала ставку товара через
// строку визита, поэтому товары соседа в сводной «Общей выручке» давали налог
// 0, и «в т.ч. НДС (товары)» по сети недосчитывал. Ставка, записанная у строки
// при выдаче (мигр. 224, ревью F3), теперь едет в самой строке счёта
// (invoice_items.goods_vat_rate в SHIPPED и в журнальном триггере).
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { buildBatch } from '../branch-sync/journal.js';
import { applyBatch } from '../branch-sync/records.js';
import { getRpc } from './index.js';

const ADMIN = { id: 1, role: 'admin', extra_roles: [] };
const objects = (r) => r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]])));

function node() {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, role, full_name, is_doctor) VALUES (1, 'adm', 'x', 'admin', 'Админ', 1)").run();
  return db;
}

test('ревью M9: ставка НДС товара едет со строкой счёта; у соседа «Общая выручка» считает её так же, как дома', () => {
  const A = node(); const B = node();
  try {
    // Здание A: бинт при 12 %, продан на 112 000.
    A.prepare("INSERT INTO products (id, name, sale_price, vat_rate, procurement_category) VALUES (1, 'Бинт', 56000, 12, 'consumables')").run();
    A.prepare("INSERT INTO patients (id, mrn, full_name) VALUES (1, 'A-1', 'Азизов А.')").run();
    const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    const v = A.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date, status) VALUES (1, 1, ?, 'arrived')").run(now).lastInsertRowid;
    const vs = A.prepare("INSERT INTO visit_services (visit_id, clinic_item_id, doctor_id, quantity, unit_price, total, status) VALUES (?, 1, 1, 2, 56000, 112000, 'added')").run(v).lastInsertRowid;
    const inv = A.prepare(`INSERT INTO invoices (invoice_number, visit_id, patient_id, subtotal, discount_amount, total_amount, paid_amount, status, created_at)
                           VALUES ('INV-A1', ?, 1, 112000, 0, 112000, 0, 'unpaid', ?)`).run(v, now).lastInsertRowid;
    const ii = A.prepare("INSERT INTO invoice_items (invoice_id, service_id, description, quantity, unit_price, total) VALUES (?, NULL, 'Бинт', 2, 56000, 112000)").run(inv).lastInsertRowid;
    A.prepare('UPDATE visit_services SET invoice_item_id = ? WHERE id = ?').run(ii, vs);
    assert.equal(A.prepare('SELECT goods_vat_rate FROM invoice_items WHERE id = ?').get(ii).goods_vat_rate, 12);

    const batch = buildBatch(A, { self: 'A', peer: 'B' });
    const rec = batch.records.find((r) => r.tbl === 'invoice_items');
    assert.ok(rec, 'строка счёта уехала');
    assert.equal(rec.data.goods_vat_rate, 12, 'ставка едет со строкой счёта');

    applyBatch(B, batch.records, { self: 'B' });
    const got = B.prepare("SELECT goods_vat_rate, sync_origin FROM invoice_items WHERE description = 'Бинт'").get();
    assert.deepEqual({ ...got }, { goods_vat_rate: 12, sync_origin: 'A' });

    // Сводная выручка у соседа: налог товара — НДС внутри цены, как у A.
    const line = objects(getRpc('run_report')(B, { kind: 'total_revenue', from: '2020-01-01', to: '2099-12-31' }, ADMIN))
      .find((o) => o['№ счёта'] === 'INV-A1');
    assert.ok(line, 'счёт соседа в сводной выручке');
    assert.deepEqual([line['Налог %'], line['Налог'], line['в т.ч. НДС (товары)']], [12, 12000, 12000]);
    // «По услугам» (строки соседа идут отдельной выборкой) — тот же налог.
    const bint = objects(getRpc('run_report')(B, { kind: 'by_services', from: '2020-01-01', to: '2099-12-31' }, ADMIN))
      .filter((o) => o['Услуга'] === 'Бинт');
    assert.equal(bint.reduce((s, o) => s + (o['Налог'] || 0), 0), 12000);
  } finally { A.close(); B.close(); }
});
