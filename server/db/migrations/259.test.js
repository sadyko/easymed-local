// SOFTPHONE_V1 — миграция 259: номер для телефона Easy-Med назначает администратор.
// Новая колонка users.pbx_extension_assigned; прежние номера назначенными НЕ
// становятся — их могли выбрать себе сами («Моя трубка»).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';
import { readableColumns, canWrite } from '../schema-registry.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
function dirUpTo(max) {
  const tmp = tmpDir('em-mig259-');
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.sql') && parseInt(x, 10) <= max)) {
    fs.copyFileSync(path.join(DIR, f), path.join(tmp, f));
  }
  return tmp;
}

test('мигр. 259: колонка назначенного номера есть, прежний pbx_extension назначенным не становится', () => {
  const db = openDb(':memory:');
  try {
    migrate(db, dirUpTo(258));
    db.prepare("INSERT INTO users (id, username, password_hash, role, pbx_extension) VALUES (5, 'op', 'x', 'registrar', '107')").run();
    migrate(db, dirUpTo(259));
    const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
    assert.ok(cols.includes('pbx_extension_assigned'), 'нет колонки pbx_extension_assigned');
    const row = db.prepare('SELECT pbx_extension, pbx_extension_assigned FROM users WHERE id = 5').get();
    assert.equal(row.pbx_extension, '107', 'миграция тронула выбранный номер');
    assert.equal(row.pbx_extension_assigned, null, 'самовыбранный номер стал назначенным — телефон Easy-Med включился бы на нём');
  } finally { db.close(); }
});

test('мигр. 259: назначенный номер не пишется и не читается через общий доступ к базе', () => {
  const db = openDb(':memory:');
  try {
    migrate(db);
    assert.ok(!readableColumns('users').includes('pbx_extension_assigned'),
      'назначенный номер читается через /api/db — его знает только карточка сотрудника и телефон');
    const ROLES = ['admin', 'registrar', 'doctor', 'cashier', 'lab', 'nurse', 'inventory', 'callcenter'];
    for (const op of ['insert', 'update', 'delete']) {
      assert.deepEqual(ROLES.filter((r) => canWrite('users', op, r)), [], 'сотрудники открылись на запись через /api/db: ' + op);
    }
  } finally { db.close(); }
});
