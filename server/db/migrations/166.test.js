// CARD_SALE_V1 (мигр. 166) — карта знает свой счёт продажи; номинал и вид
// проданной карты заморожены; выданная без оплаты правится как раньше.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

test('166: колонки продажи, счётчик номеров, заморозка номинала только у проданной карты', () => {
  const db = openDb(':memory:');
  try {
    migrate(db);
    const cols = new Set(db.prepare('PRAGMA table_info(patient_discounts)').all().map((c) => c.name));
    assert.ok(cols.has('sale_invoice_id') && cols.has('sale_number'));
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'card_sale_counters'").get());
    const free = db.prepare("INSERT INTO patient_discounts (name, kind, amount) VALUES ('Промо', 'gift_card', 1000)").run().lastInsertRowid;
    db.prepare('UPDATE patient_discounts SET amount = 2000 WHERE id = ?').run(free);
    assert.equal(db.prepare('SELECT remaining FROM patient_discounts WHERE id = ?').get(free).remaining, 2000, 'без оплаты — как раньше');
    const pt = db.prepare("INSERT INTO patients (full_name) VALUES ('П')").run().lastInsertRowid;
    const inv = db.prepare("INSERT INTO invoices (invoice_number, patient_id, total_amount, paid_amount, status) VALUES ('CARD-A-26-00001', ?, 1000, 1000, 'paid')").run(pt).lastInsertRowid;
    const sold = db.prepare("INSERT INTO patient_discounts (name, kind, amount, sale_invoice_id, sale_number) VALUES ('К', 'gift_card', 1000, ?, 'CARD-A-26-00001')").run(inv).lastInsertRowid;
    assert.throws(() => db.prepare('UPDATE patient_discounts SET amount = 5000 WHERE id = ?').run(sold), /продана в кассе/);
    assert.throws(() => db.prepare('UPDATE patient_discounts SET sale_invoice_id = NULL WHERE id = ?').run(sold), /продана в кассе/);
    db.prepare('UPDATE patient_discounts SET active = 0, name = ? WHERE id = ?').run('Другое', sold);
    assert.throws(() => db.prepare("INSERT INTO patient_discounts (name, kind, amount, sale_invoice_id) VALUES ('Дубль', 'gift_card', 1, ?)").run(inv), /UNIQUE/);
  } finally { db.close(); }
});
