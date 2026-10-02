// JOURNALS_V1_RJ2 (финальное ревью, F1/F3) — ПРАВА «ЖУРНАЛОВ»: СЕРВЕР И ОБОЛОЧКА
// ОТВЕЧАЮТ ОДИНАКОВО.
//
// Сервер решает отчёты в services/report-access.js (canSeeReportKey), оболочка —
// в permissions.js (reportGroupAllowed: плитки хаба, пункт меню, маршрут).
// Правило «Журналов» у них обязано быть ОДНО: разойдись они — человек видел бы
// плитку, которая отвечает 403, или не видел бы выданного. Поэтому одна и та же
// матрица ролей прогоняется через оба места, по КАЖДОЙ группе отчётов.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = { localStorage: { getItem: () => 'ru', setItem() {}, removeItem() {} }, location: { hostname: 'localhost' } };
globalThis.localStorage = globalThis.window.localStorage;

const perms = await import('../permissions.js');
const { openDb } = await import('../../../../server/db/connection.js');
const { migrate } = await import('../../../../server/db/migrate.js');
const { canSeeReportKey } = await import('../../../../server/services/report-access.js');
const { REPORT_GROUP } = await import('../../shared/permission-catalog.js');

const GROUP_KEYS = [...new Set(Object.values(REPORT_GROUP))].filter((k) => k !== 'reports');
const J = 'reports.journals';

function clinic() { const db = openDb(':memory:'); migrate(db); return db; }
const permsOf = (db, role) => JSON.parse(db.prepare('SELECT permissions FROM role_permissions WHERE role = ?').get(role).permissions);
const writePerms = (db, role, p) => db.prepare('UPDATE role_permissions SET permissions = ? WHERE role = ?').run(JSON.stringify(p), role);
function customRole(db, code, base, p) {
  db.prepare('INSERT INTO custom_roles (code, name, base_role) VALUES (?, ?, ?)').run(code, code, base);
  db.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?)').run(code, JSON.stringify(p));
}
// Права роли без ключа «Журналы» — как их оставляет справочник старой главной
// клиники или устаревшая вкладка «Роли».
function withoutJournals(db, role) {
  const p = permsOf(db, role);
  delete p.grants[J];
  writePerms(db, role, p);
}

// Один человек глазами обоих мест: основа, дополнительные роли, своя роль клиники.
function both(db, { role, extra = [], code = null }) {
  const user = { id: 90, role, extra_roles: extra, custom_role_code: code };
  const rows = (code ? [code] : [role, ...extra]).map((r) => ({ name: r, permissions: permsOf(db, r) }));
  window.easymed = { state: { user: { id: 90, role, extra_roles: extra } } };
  perms.setEffectiveFromRoles(rows);
  try {
    return {
      client: Object.fromEntries(GROUP_KEYS.map((k) => [k, perms.reportGroupAllowed(k)])),
      server: Object.fromEntries(GROUP_KEYS.map((k) => [k, canSeeReportKey(db, user, k)])),
      hub: perms.isModuleAllowed('reports-hub') && perms.isRouteAllowed('reports-hub'),
    };
  } finally { perms.setFullAccess('Admin'); delete window.easymed; }
}

test('F1: матрица ролей — сервер и оболочка отвечают одинаково по каждой группе; «Журналы» — по правилу настроенных ролей', () => {
  const db = clinic();
  try {
    withoutJournals(db, 'callcenter');   // оператор после справочника старой главной клиники
    customRole(db, 'kassa_stale', 'cashier', (() => { const p = permsOf(db, 'cashier'); delete p.grants[J]; return p; })());
    customRole(db, 'stale_save', 'registrar', { sections: ['reports-hub'], levels: { 'reports-hub': 'viewer' },
      grants: { reports: 'view', 'reports.revenue': 'none', 'reports.cashier': 'view', 'reports.doctor_pay': 'none' } });
    customRole(db, 'plain_reports', 'registrar', { sections: ['reports-hub'], levels: { 'reports-hub': 'viewer' } });
    customRole(db, 'one_group', 'registrar', { sections: ['reports-hub'], levels: { 'reports-hub': 'viewer' }, grants: { 'reports.cashier': 'view' } });
    const cases = [
      { name: 'кассир (миграция 235)', who: { role: 'cashier' }, journals: false },
      { name: 'копия кассира без ключа', who: { role: 'cashier', code: 'kassa_stale' }, journals: false },
      { name: 'колл-центр без ключа', who: { role: 'callcenter' }, journals: false },
      { name: 'устаревшее сохранение «Ролей»', who: { role: 'registrar', code: 'stale_save' }, journals: false },
      { name: 'ненастроенная своя роль с «Отчётами»', who: { role: 'registrar', code: 'plain_reports' }, journals: true },
      { name: 'одна настроенная группа', who: { role: 'registrar', code: 'one_group' }, journals: false },
      { name: 'врач + главный врач (Просмотр)', who: { role: 'doctor', extra: ['head_doctor'] }, journals: true },
      { name: 'врач', who: { role: 'doctor' }, journals: false },
    ];
    for (const c of cases) {
      const r = both(db, c.who);
      assert.deepEqual(r.client, r.server, c.name + ': оболочка и сервер разошлись');
      assert.equal(r.server[J], c.journals, c.name + ': «Журналы»');
    }
    // Прочие группы F1 не трогает: настроенная роль без ключа старой группы — прежнее правило.
    assert.equal(both(db, { role: 'registrar', code: 'one_group' }).server['reports.revenue'], true);
    assert.equal(both(db, { role: 'registrar', code: 'plain_reports' }).server['reports.revenue'], true);
  } finally { db.close(); }
});
