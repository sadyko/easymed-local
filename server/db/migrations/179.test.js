// REPORTS_AUDIT_FIX_V1 (mig 179) — штатным кассиру и складу записаны их
// группы отчётов; зарплаты врачей им больше не открываются. Своих ролей
// клиники и уже настроенных штатных ролей миграция не трогает.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { runReport, ownerReport } from '../../services/rpc/reports.js';
import { cashierReport } from '../../services/rpc/cashier-report.js';

const RANGE = { from: '2026-01-01', to: '2026-12-31' };
const grantsOf = (db, role) =>
  (JSON.parse(db.prepare('SELECT permissions FROM role_permissions WHERE role = ?').get(role).permissions).grants) || {};
const is403 = (e) => e && e.status === 403;

test('179: кассир — выручка и касса; склад — закупки и склад; зарплаты врачей — никому из них', () => {
  const db = openDb(':memory:');
  try {
    migrate(db);
    const c = grantsOf(db, 'cashier');
    assert.equal(c['reports.revenue'], 'view');
    assert.equal(c['reports.cashier'], 'view');
    for (const k of ['reports.doctor_pay', 'reports.referrals', 'reports.services', 'reports.stock', 'reports.callcenter']) {
      assert.equal(c[k], 'none', 'кассиру осталась группа ' + k);
    }
    const s = grantsOf(db, 'inventory');
    assert.equal(s['reports.stock'], 'view');
    for (const k of ['reports.revenue', 'reports.cashier', 'reports.doctor_pay', 'reports.referrals', 'reports.services', 'reports.callcenter']) {
      assert.equal(s[k], 'none', 'складу осталась группа ' + k);
    }
    assert.ok(!('reports.telegram' in c) && !('reports.telegram' in s), 'охват бота трогать не надо');

    const cashier = { id: 5, role: 'cashier', extra_roles: [] };
    const stock = { id: 6, role: 'inventory', extra_roles: [] };
    assert.ok(runReport(db, { kind: 'total_revenue', ...RANGE }, cashier));
    assert.ok(ownerReport(db, RANGE, cashier));
    assert.ok(cashierReport(db, RANGE, cashier));
    for (const kind of ['doctor_salaries', 'by_doctors', 'inpatient_share', 'referrals', 'by_services', 'procurement']) {
      assert.throws(() => runReport(db, { kind, ...RANGE }, cashier), is403, 'кассиру открылся «' + kind + '»');
    }
    assert.ok(runReport(db, { kind: 'stock_statement', ...RANGE }, stock));
    for (const kind of ['doctor_salaries', 'total_revenue', 'by_services']) {
      assert.throws(() => runReport(db, { kind, ...RANGE }, stock), is403, 'складу открылся «' + kind + '»');
    }
  } finally { db.close(); }
});

test('179: своя роль клиники и уже настроенная штатная роль — не тронуты; повторный накат ничего не меняет', () => {
  const db = openDb(':memory:');
  try {
    migrate(db);
    db.prepare("INSERT INTO custom_roles (code, name, base_role) VALUES ('kassa2', 'Кассир 2', 'cashier')").run();
    db.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?)')
      .run('kassa2', JSON.stringify({ sections: ['reports-hub'], levels: {} }));
    // Клиника настроила кассира сама: одна группа, остальные ключи не писала.
    const row = JSON.parse(db.prepare("SELECT permissions FROM role_permissions WHERE role = 'cashier'").get().permissions);
    row.grants = { 'reports.doctor_pay': 'view' };
    db.prepare("UPDATE role_permissions SET permissions = ? WHERE role = 'cashier'").run(JSON.stringify(row));
    db.prepare("DELETE FROM schema_migrations WHERE name LIKE '179%'").run();
    migrate(db);
    assert.deepEqual(grantsOf(db, 'cashier'), { 'reports.doctor_pay': 'view' }, 'решение клиники переписано');
    assert.deepEqual(grantsOf(db, 'kassa2'), {}, 'своя роль клиники получила группы');
    const before = db.prepare("SELECT permissions FROM role_permissions WHERE role = 'inventory'").get().permissions;
    db.prepare("DELETE FROM schema_migrations WHERE name LIKE '179%'").run();
    migrate(db);
    assert.equal(db.prepare("SELECT permissions FROM role_permissions WHERE role = 'inventory'").get().permissions, before);
  } finally { db.close(); }
});
