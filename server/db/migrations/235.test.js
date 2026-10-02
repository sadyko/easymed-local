// JOURNALS_V1_ACCESS (мигр. 235) — «Журналы» штатным ролям: кассиру и складу
// «Нет» (диагнозы и паспорта им не нужны, «Отчёты» у них ради кассы и склада),
// главному врачу «Просмотр». Своих ролей клиники и уже записанный ключ
// миграция не трогает; повторный накат ничего не меняет.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { canSeeReportKey } from '../../services/report-access.js';
import { effectiveGrantsOf } from '../../services/rpc/roles-effective.js';

const grantsOf = (db, role) =>
  (JSON.parse(db.prepare('SELECT permissions FROM role_permissions WHERE role = ?').get(role).permissions).grants) || {};

test('235: кассир и склад — «Журналы: Нет», главный врач — «Журналы: Просмотр»; прочее не тронуто', () => {
  const db = openDb(':memory:');
  try {
    migrate(db);
    assert.equal(grantsOf(db, 'cashier')['reports.journals'], 'none');
    assert.equal(grantsOf(db, 'inventory')['reports.journals'], 'none');
    assert.equal(grantsOf(db, 'head_doctor')['reports.journals'], 'view');
    assert.equal(grantsOf(db, 'cashier')['reports.cashier'], 'view', 'группы 179 потерялись');
    for (const role of ['admin', 'registrar', 'doctor', 'nurse', 'lab', 'callcenter', 'senior_nurse', 'head_cashier']) {
      assert.ok(!('reports.journals' in grantsOf(db, role)), role + ': ключ записан роли, которую миграция не трогает');
    }
    const CASHIER = { id: 5, role: 'cashier', extra_roles: [] };
    const STOCK = { id: 6, role: 'inventory', extra_roles: [] };
    const HEAD = { id: 7, role: 'head_doctor', extra_roles: [] };
    assert.equal(canSeeReportKey(db, CASHIER, 'reports.journals'), false);
    assert.equal(canSeeReportKey(db, CASHIER, 'reports.cashier'), true);
    assert.equal(canSeeReportKey(db, STOCK, 'reports.journals'), false);
    assert.equal(canSeeReportKey(db, HEAD, 'reports.journals'), true);
    assert.equal(canSeeReportKey(db, HEAD, 'reports.revenue'), false, 'главному врачу открылись деньги');
    assert.equal(effectiveGrantsOf(db, 'cashier')['reports.journals'], 'none');
    assert.equal(effectiveGrantsOf(db, 'head_doctor')['reports.journals'], 'view');
  } finally { db.close(); }
});

test('235: уже записанный ключ и своя роль клиники — не тронуты; повторный накат — ничего', () => {
  const db = openDb(':memory:');
  try {
    migrate(db);
    db.prepare("INSERT INTO custom_roles (code, name, base_role) VALUES ('kassa2', 'Кассир 2', 'cashier')").run();
    db.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?)')
      .run('kassa2', JSON.stringify({ sections: ['reports-hub'], levels: {} }));
    const row = JSON.parse(db.prepare("SELECT permissions FROM role_permissions WHERE role = 'cashier'").get().permissions);
    row.grants['reports.journals'] = 'view';   // клиника открыла кассиру журналы сама
    db.prepare("UPDATE role_permissions SET permissions = ? WHERE role = 'cashier'").run(JSON.stringify(row));
    const snap = db.prepare('SELECT role, permissions FROM role_permissions ORDER BY role').all();
    db.prepare("DELETE FROM schema_migrations WHERE name LIKE '235%'").run();
    migrate(db);
    assert.deepEqual(db.prepare('SELECT role, permissions FROM role_permissions ORDER BY role').all(), snap);
    assert.ok(!('reports.journals' in grantsOf(db, 'kassa2')), 'своя роль клиники тронута');
  } finally { db.close(); }
});
