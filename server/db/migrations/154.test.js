// PACKAGES_V1 (мигр. 154) — пакеты услуг: скидка и срок предложения у
// service_templates, своя скидка строки счёта, пакет строки визита, и
// журнальный триггер позиции счёта с новой колонкой.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

function freshDb() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}
const cols = (db, t) => db.prepare(`PRAGMA table_info(${t})`).all();

test('154: у пакета — скидка (0 по умолчанию) и две необязательные даты', () => {
  const db = freshDb();
  try {
    const c = Object.fromEntries(cols(db, 'service_templates').map((x) => [x.name, x]));
    assert.ok(c.discount_percent && c.valid_from && c.valid_until);
    assert.equal(c.discount_percent.notnull, 1);
    // Прежний шаблон — пакет без скидки и без дат.
    const id = db.prepare("INSERT INTO service_templates (name, service_ids) VALUES ('Шаблон', '[1,2]')").run().lastInsertRowid;
    const row = db.prepare('SELECT * FROM service_templates WHERE id = ?').get(id);
    assert.equal(row.discount_percent, 0);
    assert.equal(row.valid_from, null);
    assert.equal(row.valid_until, null);
  } finally { db.close(); }
});

test('154: скидка 0–100, даты — ГГГГ-ММ-ДД, «по» не раньше «с»', () => {
  const db = freshDb();
  try {
    const ins = db.prepare('INSERT INTO service_templates (name, service_ids, discount_percent, valid_from, valid_until) VALUES (?, ?, ?, ?, ?)');
    ins.run('ok', '[1]', 15, '2026-09-01', '2026-09-30');
    ins.run('ok-open', '[1]', 100, null, '2026-09-30');
    assert.throws(() => ins.run('neg', '[1]', -1, null, null), /CHECK/);
    assert.throws(() => ins.run('over', '[1]', 101, null, null), /CHECK/);
    assert.throws(() => ins.run('bad date', '[1]', 5, '01.09.2026', null), /CHECK/);
    assert.throws(() => ins.run('reversed', '[1]', 5, '2026-09-30', '2026-09-01'), /CHECK/);
  } finally { db.close(); }
});

test('154: invoice_items.discount_amount (0, не отрицательная) и visit_services.package_id (SET NULL)', () => {
  const db = freshDb();
  try {
    const ii = Object.fromEntries(cols(db, 'invoice_items').map((x) => [x.name, x]));
    assert.ok(ii.discount_amount, 'нет invoice_items.discount_amount');
    assert.equal(ii.discount_amount.notnull, 1);
    assert.equal(String(ii.discount_amount.dflt_value), '0');
    assert.ok(cols(db, 'visit_services').some((x) => x.name === 'package_id'));
    const fk = db.prepare('PRAGMA foreign_key_list(visit_services)').all().find((f) => f.from === 'package_id');
    assert.ok(fk, 'нет ссылки package_id');
    assert.equal(fk.table, 'service_templates');
    assert.equal(fk.on_delete, 'SET NULL');
  } finally { db.close(); }
});

test('154: правка скидки строки счёта попадает в журнал синхронизации', () => {
  const db = freshDb();
  try {
    const pid = db.prepare("INSERT INTO patients (full_name) VALUES ('П')").run().lastInsertRowid;
    const inv = db.prepare("INSERT INTO invoices (invoice_number, patient_id, subtotal, total_amount) VALUES ('INV-T-1', ?, 100, 100)").run(pid).lastInsertRowid;
    const item = db.prepare("INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, total) VALUES (?, 'x', 1, 100, 100)").run(inv).lastInsertRowid;
    db.prepare('DELETE FROM sync_journal').run();
    db.prepare('UPDATE invoice_items SET discount_amount = 10 WHERE id = ?').run(item);
    const j = db.prepare("SELECT cols FROM sync_journal WHERE tbl = 'invoice_items'").all();
    assert.equal(j.length, 1);
    assert.equal(j[0].cols, 'discount_amount');
  } finally { db.close(); }
});
