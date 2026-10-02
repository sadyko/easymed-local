// JOURNALS_V1_ACCESS — группа отчётов «Журналы» (reports.journals): журнал услуг
// и реестр стационарных пациентов. Ненастроенная роль — прежнее правило групп
// (администратор и раздел «Отчёты»), настроенная — по своему ключу.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { canSeeReportKey, requireReportKind, reportGroupOf } from './report-access.js';
import { fallbackLevel } from './gate-fallbacks.js';
import { REPORT_GROUP, catalogByKey } from '../../public/js/shared/permission-catalog.js';

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  for (const [code, perms] of [
    ['with_reports', { sections: ['reports-hub'], levels: { 'reports-hub': 'viewer' } }],
    ['no_reports', { sections: ['patients'], levels: { patients: 'viewer' } }],
    ['journals_off', { sections: ['reports-hub'], levels: {}, grants: { reports: 'view', 'reports.journals': 'none' } }],
    ['journals_only', { sections: [], levels: {}, grants: { 'reports.journals': 'view' } }],
    ['section_off', { sections: ['reports-hub'], levels: {}, grants: { reports: 'none', 'reports.journals': 'view' } }],
  ]) {
    db.prepare('INSERT INTO custom_roles (code, name, base_role) VALUES (?, ?, ?)').run(code, code, 'registrar');
    db.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?)').run(code, JSON.stringify(perms));
  }
  return db;
}
const as = (code) => ({ id: 70, role: 'registrar', extra_roles: [], custom_role_code: code });

test('оба вида журналов — группа «Журналы», строка справочника настоящая', () => {
  assert.equal(REPORT_GROUP.service_journal, 'reports.journals');
  assert.equal(REPORT_GROUP.inpatient_register, 'reports.journals');
  assert.equal(reportGroupOf('service_journal'), 'reports.journals');
  const row = catalogByKey().get('reports.journals');
  assert.ok(row, 'нет окна «Журналы» в разделе «Отчёты»');
  assert.equal(row.parent, 'reports');
  assert.equal(row.label, 'Журналы');
  assert.deepEqual(row.levels, ['none', 'view']);
  assert.ok(!row.adminDefault && !row.locked, 'правило перехода — как у прочих групп');
  assert.equal(row.enforced, 'rpc:run_report');
});

test('ненастроенная роль: «Отчёты» выданы — «Журналы» видны, не выданы — нет; администратор — всегда', () => {
  const db = seed();
  try {
    assert.equal(canSeeReportKey(db, as('with_reports'), 'reports.journals'), true);
    assert.equal(canSeeReportKey(db, as('no_reports'), 'reports.journals'), false);
    assert.equal(canSeeReportKey(db, { id: 1, role: 'admin', extra_roles: [] }, 'reports.journals'), true);
    assert.equal(fallbackLevel(db, { id: 0, role: 'registrar', extra_roles: [], custom_role_code: 'with_reports' }, 'reports.journals', 'all'), 'view');
    assert.equal(fallbackLevel(db, { id: 0, role: 'registrar', extra_roles: [], custom_role_code: 'no_reports' }, 'reports.journals', 'all'), 'none');
  } finally { db.close(); }
});

test('настроенная роль — по ключу; закрытый раздел «Отчёты» закрывает и «Журналы»; отказ — 403 до расчёта', () => {
  const db = seed();
  try {
    assert.equal(canSeeReportKey(db, as('journals_off'), 'reports.journals'), false);
    assert.equal(canSeeReportKey(db, as('journals_only'), 'reports.journals'), true);
    assert.equal(canSeeReportKey(db, as('journals_only'), 'reports.revenue'), false, 'ключ «Журналы» открыл деньги');
    assert.equal(canSeeReportKey(db, as('section_off'), 'reports.journals'), false);
    for (const kind of ['service_journal', 'inpatient_register']) {
      assert.throws(() => requireReportKind(db, as('journals_off'), kind), (e) => e.status === 403, kind);
      assert.doesNotThrow(() => requireReportKind(db, as('journals_only'), kind), kind);
    }
  } finally { db.close(); }
});
