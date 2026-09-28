// CRM_VIEW_LEVEL_RESTORE (мигр. 214) — уровень «просмотр» у CRM, записанный
// старым экраном «Роли» (до 3.12 уровней у CRM не было), поднимается до
// «изменение»: роли колл-центра снова ведут заявки.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { canEditCrm } from '../../services/crm/booking-mirror-db.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SQL = fs.readFileSync(path.join(DIR, '214_crm_view_level_restore.sql'), 'utf8');

function perms(db, role) {
  return JSON.parse(db.prepare('SELECT permissions FROM role_permissions WHERE role = ?').get(role).permissions);
}

test('214: CRM «viewer» от старого экрана → «editor»; остальное не тронуто; повтор — без изменений', () => {
  const db = openDb(':memory:');
  try {
    migrate(db);
    const up = db.prepare('INSERT OR REPLACE INTO role_permissions (role, permissions) VALUES (?, ?)');
    up.run('cc_head', JSON.stringify({ sections: ['crm', 'dashboard'], levels: { crm: 'viewer', dashboard: 'viewer' }, grants: { 'crm.calls': 'view' } }));
    up.run('cc_grant', JSON.stringify({ sections: ['crm'], grants: { crm: 'view' } }));
    up.run('cc_admin', JSON.stringify({ sections: ['crm'], levels: { crm: 'admin' } }));

    db.exec(SQL);
    const head = perms(db, 'cc_head');
    assert.equal(head.levels.crm, 'editor');
    assert.equal(head.levels.dashboard, 'viewer', 'уровни других разделов не трогаем');
    assert.equal(head.grants['crm.calls'], 'view', 'ключи crm.* не трогаем');
    assert.equal(perms(db, 'cc_grant').grants.crm, 'edit');
    assert.equal(perms(db, 'cc_admin').levels.crm, 'admin', 'удаление не отнимаем');

    const before = db.prepare('SELECT role, permissions FROM role_permissions ORDER BY role').all();
    db.exec(SQL);
    assert.deepEqual(db.prepare('SELECT role, permissions FROM role_permissions ORDER BY role').all(), before);
  } finally { db.close(); }
});

test('214: пользователь роли, сохранённой старым экраном, снова может вести заявки', () => {
  const db = openDb(':memory:');
  try {
    migrate(db);
    db.prepare('INSERT OR REPLACE INTO role_permissions (role, permissions) VALUES (?, ?)')
      .run('callcenter', JSON.stringify({ sections: ['crm'], levels: { crm: 'viewer' } }));
    const user = { id: 1, role: 'callcenter', extra_roles: [] };
    assert.equal(canEditCrm(db, user), false, 'до поправки — «только просмотр»');
    db.exec(SQL);
    assert.equal(canEditCrm(db, user), true);
  } finally { db.close(); }
});
