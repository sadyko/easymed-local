// REFERRAL_FULL_PRICE_V1 (мигр. 283) — момент, с которого вознаграждение за направление
// считается от цены до скидки (владелец 2026-11-08: «с дня обновления»). Записывается
// ОДИН раз и только у клиники, которая обновляется (счета в базе уже есть); у новой базы
// отметки нет — новое правило для всех счетов.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';

const MIGRATIONS = path.dirname(fileURLToPath(import.meta.url));
const cutoff = (db) => db.prepare('SELECT * FROM referral_full_price_from').all();

// База версии до 3.22.0 с этой правкой: все миграции ниже 283.
function before283() {
  const db = openDb(':memory:');
  const stage = tmpDir('em-mig283-');
  for (const f of fs.readdirSync(MIGRATIONS)) {
    if (parseInt(f, 10) >= 283 || !f.endsWith('.sql')) continue;
    fs.copyFileSync(path.join(MIGRATIONS, f), path.join(stage, f));
  }
  migrate(db, stage);
  return db;
}

test('новая база: отметки нет — правило «до скидки» для всех счетов', () => {
  const db = openDb(':memory:');
  try {
    migrate(db);
    assert.deepEqual(cutoff(db), []);
  } finally { db.close(); }
});

test('обновление клиники со счетами: момент обновления записан один раз, в UTC ISO', () => {
  const db = before283();
  try {
    db.prepare("INSERT INTO patients (id, mrn, full_name) VALUES (1, 'P-1', 'П')").run();
    db.prepare("INSERT INTO invoices (invoice_number, patient_id, subtotal, discount_amount, total_amount, paid_amount, status, created_at) VALUES ('I-1', 1, 100, 0, 100, 100, 'paid', '2026-10-01T09:00:00Z')").run();
    const lo = new Date(Date.now() - 2000).toISOString().slice(0, 19) + 'Z';
    migrate(db);
    const hi = new Date(Date.now() + 2000).toISOString().slice(0, 19) + 'Z';
    const rows = cutoff(db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, 1);
    assert.match(rows[0].from_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.ok(rows[0].from_at >= lo && rows[0].from_at <= hi, 'отметка — не момент миграции: ' + rows[0].from_at);
    migrate(db);   // повторный запуск — ничего не меняет
    assert.deepEqual(cutoff(db), rows);
    assert.throws(() => db.prepare("INSERT INTO referral_full_price_from (id, from_at) VALUES (2, '2026-11-09T00:00:00Z')").run(), /CHECK/,
      'вторая отметка невозможна');
  } finally { db.close(); }
});

test('обновление базы без единого счёта — отметки нет, как у новой', () => {
  const db = before283();
  try {
    db.prepare("INSERT INTO patients (id, mrn, full_name) VALUES (1, 'P-1', 'П')").run();
    migrate(db);
    assert.deepEqual(cutoff(db), []);
  } finally { db.close(); }
});
