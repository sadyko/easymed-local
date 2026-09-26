// CARD_BALANCE_V1 (мигр. 158) — остаток карт/сертификатов и журнал его движения.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';
import { readableColumns, writableColumns } from '../schema-registry.js';

const MIGRATIONS = path.dirname(fileURLToPath(import.meta.url));

test('158: выпущенные до миграции карты получают остаток = номинал, промокоды — нет', () => {
  const db = openDb(':memory:');
  try {
    const stage = tmpDir('em-mig158-');
    for (const f of fs.readdirSync(MIGRATIONS)) {
      if (parseInt(f, 10) >= 158 || !f.endsWith('.sql')) continue;
      fs.copyFileSync(path.join(MIGRATIONS, f), path.join(stage, f));
    }
    migrate(db, stage);
    db.prepare("INSERT INTO patient_discounts (name, kind, amount) VALUES ('Карта', 'gift_card', 500000)").run();
    db.prepare("INSERT INTO patient_discounts (name, kind, amount) VALUES ('Серт', 'certificate', 200000)").run();
    db.prepare("INSERT INTO patient_discounts (name, kind, percent) VALUES ('Акция', 'promo', 10)").run();
    migrate(db);
    assert.deepEqual(db.prepare('SELECT kind, remaining FROM patient_discounts ORDER BY id').all().map((r) => [r.kind, r.remaining]),
      [['gift_card', 500000], ['certificate', 200000], ['promo', null]]);
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'card_ledger'").get());
    assert.ok(readableColumns('patient_discounts').includes('remaining'), 'остаток виден экранам');
    assert.ok(!writableColumns('patient_discounts', 'update').includes('remaining'), 'но пишет его только сервер');
  } finally { db.close(); }
});
