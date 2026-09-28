// CASHIER_HEAD_V1, ревью (мигр. 219) — invoices.manual_discount (ручная часть
// скидки суммой, местная колонка) и cash_shifts.closed_by (кто закрыл смену).
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { SHIPPED } from '../../services/branch-sync/journal.js';

test('219: колонки на месте; manual_discount в соседнее здание не едет', () => {
  const db = openDb(':memory:');
  try {
    migrate(db);
    const inv = db.prepare('PRAGMA table_info(invoices)').all().find((c) => c.name === 'manual_discount');
    assert.ok(inv, 'invoices.manual_discount');
    assert.equal(inv.dflt_value, null, 'NULL — счёт до 219, ручная часть выводится при первой правке');
    const sh = db.prepare('PRAGMA table_info(cash_shifts)').all().find((c) => c.name === 'closed_by');
    assert.ok(sh, 'cash_shifts.closed_by');
    const fk = db.prepare('PRAGMA foreign_key_list(cash_shifts)').all().find((f) => f.from === 'closed_by');
    assert.equal(fk && fk.table, 'users');
    assert.ok(!SHIPPED.invoices.includes('manual_discount'));
    assert.ok(db.prepare('PRAGMA table_info(invoices)').all().some((c) => c.name === 'manual_base'));
    assert.ok(!SHIPPED.invoices.includes('manual_base'));
    assert.throws(() => db.prepare("INSERT INTO invoices (invoice_number, patient_id, subtotal, total_amount, manual_discount) VALUES ('X', 1, 0, 0, -1)").run());
  } finally { db.close(); }
});
