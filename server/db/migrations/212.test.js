// V3120_FINAL (мигр. 212) — invoices.post_sale_discount: 0 по умолчанию, не
// меньше нуля, и её правка попадает в журнал отправки соседям.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

test('212: invoices.post_sale_discount — 0 по умолчанию, отрицательной не бывает, правка едет в журнал', () => {
  const db = openDb(':memory:');
  try {
    migrate(db);
    db.prepare("INSERT INTO patients (id, mrn, full_name) VALUES (1, 'P-1', 'П')").run();
    const id = db.prepare("INSERT INTO invoices (invoice_number, patient_id, subtotal, discount_amount, total_amount, paid_amount, status) VALUES ('I-1', 1, 100, 0, 100, 100, 'paid')").run().lastInsertRowid;
    assert.equal(db.prepare('SELECT post_sale_discount p FROM invoices WHERE id = ?').get(id).p, 0);
    assert.throws(() => db.prepare('UPDATE invoices SET post_sale_discount = -1 WHERE id = ?').run(id));
    const uid = db.prepare('SELECT uid FROM invoices WHERE id = ?').get(id).uid;
    if (uid != null) {
      db.prepare('DELETE FROM sync_journal').run();
      db.prepare('UPDATE invoices SET post_sale_discount = 20, discount_amount = 20, total_amount = 80 WHERE id = ?').run(id);
      const cols = db.prepare("SELECT cols FROM sync_journal WHERE tbl = 'invoices'").get().cols.split(',');
      assert.ok(cols.includes('post_sale_discount'), cols.join(','));
    }
  } finally { db.close(); }
});
