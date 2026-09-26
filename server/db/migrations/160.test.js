// DEPOSIT_WALLET_V1, ревью I1 (мигр. 160) — журнал баланса защищён самой базой;
// кэшбэк прежнего экрана становится строкой вида 'cashback' со ссылкой на счёт.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';

const MIGRATIONS = path.dirname(fileURLToPath(import.meta.url));

test('160: старый кэшбэк получает вид cashback и счёт; ждущий депозит правится и удаляется, принятый — нет', () => {
  const db = openDb(':memory:');
  try {
    const stage = tmpDir('em-mig160-');
    for (const f of fs.readdirSync(MIGRATIONS)) {
      if (parseInt(f, 10) >= 160 || !f.endsWith('.sql')) continue;
      fs.copyFileSync(path.join(MIGRATIONS, f), path.join(stage, f));
    }
    migrate(db, stage);
    const pt = db.prepare("INSERT INTO patients (full_name) VALUES ('П')").run().lastInsertRowid;
    const inv = db.prepare("INSERT INTO invoices (invoice_number, patient_id, total_amount, paid_amount, status) VALUES ('INV-A-26-00001', ?, 100, 100, 'paid')").run(pt).lastInsertRowid;
    db.prepare("INSERT INTO patient_deposits (patient_id, amount, method, status, notes, created_by_name) VALUES (?, 5, 'other', 'received', ?, 'Cashback')")
      .run(pt, 'Cashback 5% on INV-A-26-00001 · cashback:' + inv);
    const pend = db.prepare("INSERT INTO patient_deposits (patient_id, amount, status) VALUES (?, 50, 'pending')").run(pt).lastInsertRowid;
    const got = db.prepare("INSERT INTO patient_deposits (patient_id, amount, status) VALUES (?, 70, 'received')").run(pt).lastInsertRowid;
    migrate(db);
    const cb = db.prepare("SELECT kind, invoice_id FROM patient_deposits WHERE created_by_name = 'Cashback'").get();
    assert.deepEqual(cb, { kind: 'cashback', invoice_id: inv });
    db.prepare('UPDATE patient_deposits SET amount = 60 WHERE id = ?').run(pend);
    assert.throws(() => db.prepare('UPDATE patient_deposits SET amount = 700 WHERE id = ?').run(got), /журнал[а-я]* баланса/);
    assert.throws(() => db.prepare('DELETE FROM patient_deposits WHERE id = ?').run(got), /журнал[а-я]* баланса/);
    db.prepare('DELETE FROM patient_deposits WHERE id = ?').run(pend);
  } finally { db.close(); }
});
