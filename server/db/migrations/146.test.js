// STOCK_REQUEST_V1 (mig 146) — отклонённая заявка помнит, когда её отклонили.
//
// Время ставит база (триггер): экран «Заявки» отклоняет прямой записью
// status='rejected', и другого места, где его поставить, нет.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { readableColumns } from '../schema-registry.js';
import { SHIPPED } from '../../services/branch-sync/journal.js';

test('146: отклонение ставит rejected_at; прочие смены статуса — нет; повторное отклонение время не двигает', () => {
  const db = openDb(':memory:');
  migrate(db);
  try {
    const col = db.prepare('PRAGMA table_info(purchase_requisitions)').all().find((c) => c.name === 'rejected_at');
    assert.ok(col, 'нет колонки rejected_at');
    const id = db.prepare("INSERT INTO purchase_requisitions (req_number, status) VALUES ('R1','submitted')").run().lastInsertRowid;
    const at = () => db.prepare('SELECT rejected_at FROM purchase_requisitions WHERE id = ?').get(id).rejected_at;
    db.prepare("UPDATE purchase_requisitions SET status = 'approved' WHERE id = ?").run(id);
    assert.equal(at(), null);
    db.prepare("UPDATE purchase_requisitions SET status = 'rejected' WHERE id = ?").run(id);
    assert.match(at(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    db.prepare("UPDATE purchase_requisitions SET rejected_at = '2020-01-01T00:00:00Z' WHERE id = ?").run(id);
    db.prepare("UPDATE purchase_requisitions SET status = 'rejected', reject_reason = 'ещё раз' WHERE id = ?").run(id);
    assert.equal(at(), '2020-01-01T00:00:00Z', 'повторная запись того же статуса передвинула время отклонения');
  } finally { db.close(); }
});

test('146: колонка только для сервера — не в реестре и не в обмене зданий', () => {
  assert.ok(!readableColumns('purchase_requisitions').includes('rejected_at'));
  for (const [tbl, cols] of Object.entries(SHIPPED)) assert.ok(!cols.includes('rejected_at'), `rejected_at уехал бы в составе ${tbl}`);
  const db = openDb(':memory:');
  migrate(db);
  migrate(db);   // повторный прогон ничего не ломает
  db.close();
});
