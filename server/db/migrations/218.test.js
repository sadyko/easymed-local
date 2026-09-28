// CASHIER_HEAD_V1 (мигр. 218) — строка прав надстроечной роли «Старший
// кассир»: разделы «Касса» и «Старший кассир» на «Изменение» и право
// «Исправляет услуги в счёте». Кассиру право не выдаётся.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SQL = fs.readFileSync(path.join(DIR, '218_head_cashier_role.sql'), 'utf8');
const perms = (db, role) => {
  const row = db.prepare('SELECT permissions FROM role_permissions WHERE role = ?').get(role);
  return row ? JSON.parse(row.permissions) : null;
};

test('218: строка head_cashier заведена, кассир не тронут, повтор и ручная роль — без изменений', () => {
  const db = openDb(':memory:');
  try {
    migrate(db);
    const hc = perms(db, 'head_cashier');
    assert.deepEqual(hc.sections, ['cashier', 'cashier-head']);
    assert.deepEqual(hc.levels, { cashier: 'editor', 'cashier-head': 'editor' });
    assert.equal(hc.grants['cashier.lines'], 'edit');
    assert.equal(hc.grants.cashier_head, 'edit');
    const c = perms(db, 'cashier');
    assert.ok(!c.grants || !('cashier.lines' in c.grants), 'кассиру право не выдано');

    // Клиника настроила роль сама — повторный накат её не трогает.
    const own = JSON.stringify({ sections: ['cashier-head'], levels: { 'cashier-head': 'viewer' } });
    db.prepare('UPDATE role_permissions SET permissions = ? WHERE role = ?').run(own, 'head_cashier');
    db.exec(SQL);
    assert.equal(db.prepare("SELECT permissions FROM role_permissions WHERE role = 'head_cashier'").get().permissions, own);
  } finally { db.close(); }
});
