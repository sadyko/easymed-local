// OWN_SHELF_ONLY_V1 (ревью F5, F6; мигр. 226) — переключатель клиники «Только со
// своих полок» (ВЫКЛЮЧЕН у каждой клиники, старой и новой) с журналом, кто и
// когда его менял, и очередь «не списано со склада» для отметок «введено».
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));

function dbBefore226() {
  const db = openDb(':memory:');
  const tmp = tmpDir('mig226-');
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.sql') && parseInt(x, 10) < 226)) {
    fs.copyFileSync(path.join(DIR, f), path.join(tmp, f));
  }
  migrate(db, tmp);
  return db;
}

test('226: новая клиника — переключатель есть, одна строка, ВЫКЛЮЧЕН, журнал пуст', () => {
  const db = openDb(':memory:');
  try {
    migrate(db);
    assert.deepEqual(db.prepare('SELECT id, own_shelf_only, changed_by, changed_at FROM stock_settings').all(),
      [{ id: 1, own_shelf_only: 0, changed_by: null, changed_at: null }]);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM stock_settings_log').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM stock_pending_writeoffs').get().n, 0);
  } finally { db.close(); }
});

test('226: клиника, которая уже работает, — после обновления тоже ВЫКЛЮЧЕН (всё как в 3.12.1)', () => {
  const db = dbBefore226();
  try {
    // Клиника с данными: полки, выдачи — ничего из этого переключатель не включает.
    db.prepare("INSERT INTO products (id, name, on_hand) VALUES (1, 'Бинт', 10)").run();
    db.prepare("INSERT INTO stock_holdings (holder_type, holder_id, product_id, qty) VALUES ('staff', 1, 1, 5)").run();
    assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name = 'stock_settings'").get().n, 0);
    migrate(db);
    assert.equal(db.prepare('SELECT own_shelf_only FROM stock_settings WHERE id = 1').get().own_shelf_only, 0);
  } finally { db.close(); }
});

test('226: вторая строка настроек и мусор в переключателе — не проходят', () => {
  const db = openDb(':memory:');
  try {
    migrate(db);
    assert.throws(() => db.prepare('INSERT INTO stock_settings (id, own_shelf_only) VALUES (2, 1)').run(), /CHECK/);
    assert.throws(() => db.prepare('UPDATE stock_settings SET own_shelf_only = 2 WHERE id = 1').run(), /CHECK/);
    assert.throws(() => db.prepare('INSERT INTO stock_settings_log (own_shelf_only) VALUES (5)').run(), /CHECK/);
    const id = db.prepare('INSERT INTO stock_settings_log (own_shelf_only) VALUES (1)').run().lastInsertRowid;
    const row = db.prepare('SELECT changed_at, missing FROM stock_settings_log WHERE id = ?').get(id);
    assert.match(row.changed_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, 'когда — пишет сама база');
    assert.equal(row.missing, '[]');
  } finally { db.close(); }
});

function seedLine(db) {
  db.prepare("INSERT INTO patients (id, mrn, full_name) VALUES (1, 'A-1', 'Азизов')").run();
  db.prepare("INSERT INTO products (id, name, on_hand) VALUES (1, 'Кеторол', 10)").run();
  const adm = db.prepare("INSERT INTO admissions (patient_id, status) VALUES (1, 'active')").run().lastInsertRowid;
  const line = (n) => db.prepare("INSERT INTO admission_services (admission_id, clinic_item_id, quantity, unit_price, total) VALUES (?, 1, ?, 1000, ?)")
    .run(adm, n, n * 1000).lastInsertRowid;
  return { adm, line };
}

test('226: «не списано со склада» — одна запись на строку начисления, количество больше нуля, статусы — свои', () => {
  const db = openDb(':memory:');
  try {
    migrate(db);
    const { adm, line } = seedLine(db);
    const l1 = line(1);
    const ins = db.prepare('INSERT INTO stock_pending_writeoffs (admission_service_id, admission_id, product_id, base_qty, qty, kind, status) VALUES (?, ?, 1, ?, ?, ?, ?)');
    ins.run(l1, adm, 0.1, 1, 'dose', 'pending');
    assert.throws(() => ins.run(l1, adm, 0.1, 1, 'dose', 'pending'), /UNIQUE/, 'одна строка — одно списание');
    const l2 = line(2);
    assert.throws(() => ins.run(l2, adm, 0, 1, 'dose', 'pending'), /CHECK/);
    assert.throws(() => ins.run(l2, adm, 0.2, 0, 'dose', 'pending'), /CHECK/);
    assert.throws(() => ins.run(l2, adm, 0.2, 2, 'другое', 'pending'), /CHECK/);
    assert.throws(() => ins.run(l2, adm, 0.2, 2, 'dose', 'потеряно'), /CHECK/);
    assert.throws(() => db.prepare("UPDATE stock_pending_writeoffs SET settled_from_type = 'шкаф' WHERE admission_service_id = ?").run(l1), /CHECK/);
    const row = db.prepare('SELECT status, given_at, cancel_note FROM stock_pending_writeoffs WHERE admission_service_id = ?').get(l1);
    assert.equal(row.status, 'pending');
    assert.match(row.given_at, /Z$/);
    assert.equal(row.cancel_note, '');
  } finally { db.close(); }
});

test('226: строку начисления удалили любым путём — ожидающее списание закрыто; списанное не трогается', () => {
  const db = openDb(':memory:');
  try {
    migrate(db);
    const { adm, line } = seedLine(db);
    const pendingLine = line(1);
    const settledLine = line(1);
    const ins = db.prepare('INSERT INTO stock_pending_writeoffs (admission_service_id, admission_id, product_id, base_qty, qty, status) VALUES (?, ?, 1, 0.1, 1, ?)');
    ins.run(pendingLine, adm, 'pending');
    ins.run(settledLine, adm, 'settled');
    db.prepare('DELETE FROM admission_services WHERE id IN (?, ?)').run(pendingLine, settledLine);
    const byLine = (id) => db.prepare('SELECT status, cancelled_at, cancel_note FROM stock_pending_writeoffs WHERE admission_service_id = ?').get(id);
    const p = byLine(pendingLine);
    assert.equal(p.status, 'cancelled');
    assert.match(p.cancelled_at, /Z$/);
    assert.equal(p.cancel_note, 'строка начисления удалена');
    assert.equal(byLine(settledLine).status, 'settled', 'списанное уже прошло журналом — отмена вернёт его обычным путём');
  } finally { db.close(); }
});
