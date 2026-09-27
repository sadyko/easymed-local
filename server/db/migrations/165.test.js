// CASHBACK_BY_GROUP_V1 (мигр. 165) — у правила кэшбэка есть группа пациентов;
// существующие правила остаются «для всех» (category_id NULL).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';

const MIGRATIONS = path.dirname(fileURLToPath(import.meta.url));

test('165: старые правила — «для всех», новое правило принимает группу; удалённая группа обнуляет ссылку', () => {
  const db = openDb(':memory:');
  try {
    const stage = tmpDir('em-mig165-');
    for (const f of fs.readdirSync(MIGRATIONS)) {
      if (parseInt(f, 10) >= 165 || !f.endsWith('.sql')) continue;
      fs.copyFileSync(path.join(MIGRATIONS, f), path.join(stage, f));
    }
    migrate(db, stage);
    const old = db.prepare("INSERT INTO cashback_rules (name, percent) VALUES ('Старое', 3)").run().lastInsertRowid;
    migrate(db);
    assert.equal(db.prepare('SELECT category_id FROM cashback_rules WHERE id = ?').get(old).category_id, null);
    const cat = db.prepare("INSERT INTO patient_categories (name) VALUES ('VIP')").run().lastInsertRowid;
    const r = db.prepare('INSERT INTO cashback_rules (name, percent, category_id) VALUES (?, 5, ?)').run('VIP', cat).lastInsertRowid;
    assert.equal(db.prepare('SELECT category_id FROM cashback_rules WHERE id = ?').get(r).category_id, cat);
    db.pragma('foreign_keys = ON');
    db.prepare('DELETE FROM patient_categories WHERE id = ?').run(cat);
    assert.equal(db.prepare('SELECT category_id FROM cashback_rules WHERE id = ?').get(r).category_id, null);
  } finally { db.close(); }
});
