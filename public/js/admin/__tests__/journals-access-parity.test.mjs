// JOURNALS_V1_RJ2 (финальное ревью, F1/F3) — ПРАВА «ЖУРНАЛОВ»: СЕРВЕР И ОБОЛОЧКА
// ОТВЕЧАЮТ ОДИНАКОВО.
//
// Сервер решает отчёты в services/report-access.js (canSeeReportKey), оболочка —
// в permissions.js (reportGroupAllowed: плитки хаба, пункт меню, маршрут).
// Правило «Журналов» у них обязано быть ОДНО: разойдись они — человек видел бы
// плитку, которая отвечает 403, или не видел бы выданного. Поэтому одна и та же
// матрица ролей прогоняется через оба места, по КАЖДОЙ группе отчётов.
//
// JOURNALS_V1_RJ3 — правило «Журналов» стало ЯВНЫМ: администратор и роли, которым
// выдано «Журналы: Просмотр»; по умолчанию — ни у кого. Оболочка получает права
// ролей так, как их раскладывает admin.js applyActorPermissions (у
// администратора — и его дополнительные роли: setActorRoleGrants).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
const permsOf = (db, role) => { const r = db.prepare('SELECT permissions FROM role_permissions WHERE role = ?').get(role); return r ? JSON.parse(r.permissions) : null; };
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
// Права без ЕДИНОГО ключа «reports.…» — копия, сделанная до миграции 179.
const pre179 = (p) => ({ ...p, grants: Object.fromEntries(Object.entries(p.grants || {}).filter(([k]) => !k.startsWith('reports.'))) });
const grantsOfRow = (p) => (p && p.grants) || {};

// Оболочка — так, как права раскладывает admin.js applyActorPermissions.
function applyClient(db, { role, extra = [], code = null }) {
  window.easymed = { state: { user: { id: 90, role, extra_roles: extra } } };
  const own = code ? permsOf(db, code) : null;
  if (role === 'admin') {
    perms.setFullAccess('Администратор клиники');
    perms.setOwnCustomGrants(own && own.grants);
    const names = [own ? code : role, ...extra];
    perms.setActorRoleGrants(names.map((n) => grantsOfRow(permsOf(db, n))), own ? grantsOfRow(own) : null);
    return;
  }
  const rows = [own ? code : role, ...extra].map((r) => ({ name: r, permissions: permsOf(db, r) })).filter((r) => r.permissions);
  perms.setEffectiveFromRoles(rows);
  perms.setActorRoleGrants(rows.map((r) => grantsOfRow(r.permissions)), own ? grantsOfRow(own) : null);
}

// Один человек глазами обоих мест: основа, дополнительные роли, своя роль клиники.
function both(db, who) {
  const { role, extra = [], code = null } = who;
  const user = { id: 90, role, extra_roles: extra, custom_role_code: code };
  applyClient(db, who);
  try {
    return {
      client: Object.fromEntries(GROUP_KEYS.map((k) => [k, perms.reportGroupAllowed(k)])),
      server: Object.fromEntries(GROUP_KEYS.map((k) => [k, canSeeReportKey(db, user, k)])),
      hub: perms.isModuleAllowed('reports-hub') && perms.isRouteAllowed('reports-hub'),
      kinds: Object.keys(REPORT_GROUP).filter((k) => perms.reportKindAllowed(k)),
    };
  } finally { perms.setFullAccess('Admin'); delete window.easymed; }
}

test('F1: матрица ролей — сервер и оболочка отвечают одинаково по каждой группе; «Журналы» — только явно', () => {
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
      { name: 'ненастроенная своя роль с «Отчётами»', who: { role: 'registrar', code: 'plain_reports' }, journals: false },   // JOURNALS_V1_RJ3
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

// JOURNALS_V1_RJ2 (F3) — «Отчёты» закрыты роли «Врач», «Журналы» выданы надстройке
// «Главный врач»: журналы видны, хаб и маршрут открыты, плитки — только журналов.
test('F3: врач с закрытыми «Отчётами» + «Главный врач» — журналы, хаб и только плитки журналов; сервер = оболочка', () => {
  const db = clinic();
  try {
    const p = permsOf(db, 'doctor');
    p.grants = { ...(p.grants || {}), reports: 'none' };
    writePerms(db, 'doctor', p);
    const r = both(db, { role: 'doctor', extra: ['head_doctor'] });
    assert.deepEqual(r.client, r.server, 'оболочка и сервер разошлись');
    assert.deepEqual(Object.keys(r.server).filter((k) => r.server[k]), [J], 'видна ровно группа «Журналы»');
    assert.equal(r.hub, true, 'пункт меню и маршрут «Отчётов» закрыты — выданные журналы недостижимы');
    assert.deepEqual(r.kinds, ['service_journal', 'inpatient_register']);
    applyClient(db, { role: 'doctor', extra: ['head_doctor'] });
    try {
      assert.equal(perms.isRouteAllowed('reports'), false, '«Обзор владельца» — это выручка');
      // previewRole не оставляет чужих прав ролей.
      perms.previewRole({ name: 'cashier', permissions: permsOf(db, 'cashier') }, () => assert.equal(perms.reportGroupAllowed(J), false));
      assert.equal(perms.reportGroupAllowed(J), true, 'после предпросмотра права вернулись');
    } finally { perms.setFullAccess('Admin'); delete window.easymed; }
    // Закрыла «Отчёты» сама роль «Главный врач» — её «Журналы» не открываются.
    const h = permsOf(db, 'head_doctor');
    h.grants = { ...h.grants, reports: 'none' };
    writePerms(db, 'head_doctor', h);
    const r2 = both(db, { role: 'doctor', extra: ['head_doctor'] });
    assert.deepEqual(r2.client, r2.server);
    assert.equal(r2.server[J], false);
  } finally { db.close(); }
});

// JOURNALS_V1_RJ3 — матрица проверки доступа (c68e837): каждый случай — сервер =
// оболочка по каждой группе, «Журналы» — по явному правилу, хаб — когда видна
// хоть одна группа.
test('RJ3: матрица проверки доступа — сервер = оболочка; «Журналы» только явно, администратор — пока своя роль не закрыла', () => {
  const cases = [
    ['администратор', null, { role: 'admin' }, true],
    ['администратор + кассир', null, { role: 'admin', extra: ['cashier'] }, true],
    ['администратор-врач', null, { role: 'doctor', extra: ['admin'] }, true],
    ['администратор-врач + главный врач, врачу «Отчёты: Нет»', (db) => { const p = permsOf(db, 'doctor'); p.grants = { ...(p.grants || {}), reports: 'none' }; writePerms(db, 'doctor', p); },
      { role: 'doctor', extra: ['admin', 'head_doctor'] }, true],
    ['своя роль на основе администратора, «Журналы: Нет»', (db) => customRole(db, 'deputy', 'admin', { sections: ['reports-hub'], levels: {}, grants: { [J]: 'none' } }), { role: 'admin', code: 'deputy' }, false],
    ['… и надстройка «Главный врач»', (db) => customRole(db, 'deputy', 'admin', { sections: ['reports-hub'], levels: {}, grants: { [J]: 'none' } }), { role: 'admin', code: 'deputy', extra: ['head_doctor'] }, true],
    ['своя роль на основе администратора, «Отчёты: Нет»', (db) => customRole(db, 'deputy', 'admin', { sections: ['reports-hub'], levels: {}, grants: { reports: 'none' } }), { role: 'admin', code: 'deputy' }, false],
    ['… и надстройка «Главный врач»', (db) => customRole(db, 'deputy', 'admin', { sections: ['reports-hub'], levels: {}, grants: { reports: 'none' } }), { role: 'admin', code: 'deputy', extra: ['head_doctor'] }, true],
    ['своя роль на основе администратора, закрыта «Выручка»', (db) => customRole(db, 'deputy', 'admin', { sections: ['reports-hub'], levels: {}, grants: { 'reports.revenue': 'none' } }), { role: 'admin', code: 'deputy' }, true],
    ['копия кассира до 179', (db) => customRole(db, 'kassa_old', 'cashier', pre179(permsOf(db, 'cashier'))), { role: 'cashier', code: 'kassa_old' }, false],
    ['копия склада до 179', (db) => customRole(db, 'sklad_old', 'inventory', pre179(permsOf(db, 'inventory'))), { role: 'inventory', code: 'sklad_old' }, false],
    ['кассир после справочника главной ниже 179', (db) => writePerms(db, 'cashier', pre179(permsOf(db, 'cashier'))), { role: 'cashier' }, false],
    ['склад после справочника главной ниже 179', (db) => writePerms(db, 'inventory', pre179(permsOf(db, 'inventory'))), { role: 'inventory' }, false],
    ['ненастроенная роль с «Отчётами»', (db) => customRole(db, 'reg_hub', 'registrar', { ...permsOf(db, 'registrar'), sections: [...permsOf(db, 'registrar').sections, 'reports-hub'] }), { role: 'registrar', code: 'reg_hub' }, false],
    ['«Отчёты» + сохранена другая группа', (db) => customRole(db, 'reg_saved', 'registrar', { sections: ['reports-hub'], levels: { 'reports-hub': 'viewer' }, grants: { 'reports.cashier': 'view' } }), { role: 'registrar', code: 'reg_saved' }, false],
    ['главный врач (надстройка)', null, { role: 'doctor', extra: ['head_doctor'] }, true],
    ['врач («Отчёты: Нет») + главный врач', (db) => { const p = permsOf(db, 'doctor'); p.grants = { ...(p.grants || {}), reports: 'none' }; writePerms(db, 'doctor', p); }, { role: 'doctor', extra: ['head_doctor'] }, true],
    ['своя роль: «Журналы: Просмотр» явно', (db) => customRole(db, 'jview', 'registrar', { sections: [], levels: {}, grants: { [J]: 'view' } }), { role: 'registrar', code: 'jview' }, true],
    ['своя роль: «Журналы: Просмотр», но «Отчёты: Нет»', (db) => customRole(db, 'rnj', 'registrar', { sections: ['reports-hub'], levels: {}, grants: { reports: 'none', [J]: 'view' } }), { role: 'registrar', code: 'rnj' }, false],
    ['своя роль без строки прав (основа — кассир)', (db) => db.prepare("INSERT INTO custom_roles (code, name, base_role) VALUES ('ghost', 'ghost', 'cashier')").run(), { role: 'cashier', code: 'ghost' }, false],
  ];
  for (const [name, prep, who, journals] of cases) {
    const db = clinic();
    try {
      if (prep) prep(db);
      const r = both(db, who);
      assert.deepEqual(r.client, r.server, name + ': оболочка и сервер разошлись');
      assert.equal(r.server[J], journals, name + ': «Журналы»');
      assert.equal(r.hub, Object.values(r.client).some(Boolean), name + ': хаб не совпал с видимыми группами');
      assert.equal(r.kinds.includes('service_journal'), journals, name + ': плитка журнала');
    } finally { db.close(); }
  }
});

// JOURNALS_V1_RJ3 — прочие группы не тронуты: ответы — те же, что на 9f84fc6
// (снято проверкой доступа: verify-journals-access/base.json).
test('RJ3: прочие группы отчётов — как на 9f84fc6', () => {
  const ALL = { 'reports.revenue': true, 'reports.cashier': true, 'reports.doctor_pay': true, 'reports.referrals': true,
    'reports.services': true, 'reports.stock': true, 'reports.callcenter': true, 'reports.telegram': false };
  const NONE = Object.fromEntries(Object.keys(ALL).map((k) => [k, false]));
  const cases = [
    ['кассир', null, { role: 'cashier' }, { ...NONE, 'reports.revenue': true, 'reports.cashier': true }],
    ['регистратор', null, { role: 'registrar' }, NONE],
    ['врач + главный врач', null, { role: 'doctor', extra: ['head_doctor'] }, NONE],
    ['копия регистратора с «Отчётами»', (db) => customRole(db, 'reg2', 'registrar', { ...permsOf(db, 'registrar'), sections: [...permsOf(db, 'registrar').sections, 'reports-hub'] }), { role: 'registrar', code: 'reg2' }, ALL],
    ['своя роль «Отчёты: Просмотр» с разделом', (db) => customRole(db, 'rv', 'registrar', { sections: ['reports-hub'], levels: {}, grants: { reports: 'view' } }), { role: 'registrar', code: 'rv' }, ALL],
    ['своя роль на основе администратора, закрыта «Выручка»', (db) => customRole(db, 'deputy', 'admin', { sections: ['reports-hub'], levels: {}, grants: { 'reports.revenue': 'none' } }), { role: 'admin', code: 'deputy' },
      { ...ALL, 'reports.revenue': false, 'reports.telegram': true }],
  ];
  for (const [name, prep, who, want] of cases) {
    const db = clinic();
    try {
      if (prep) prep(db);
      const r = both(db, who);
      const others = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== J));
      assert.deepEqual(others(r.server), want, name + ': сервер');
      assert.deepEqual(others(r.client), want, name + ': оболочка');
    } finally { db.close(); }
  }
});

// JOURNALS_V1_RJ3 — admin.js отдаёт оболочке права КАЖДОЙ роли в силе, у
// администратора — с его дополнительными ролями (прежде их не читали вовсе:
// надстройка «Главный врач» у администратора на экране не открывала журналов).
test('RJ3: admin.js — у администратора читаются дополнительные роли, права ролей уходят в setActorRoleGrants', () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'admin.js'), 'utf8');
  const start = src.indexOf('async function applyActorPermissions(');
  const body = src.slice(start, src.indexOf('\n}\n', start));
  const adminBranch = body.slice(body.indexOf('if (actor.is_admin)'), body.indexOf('if (actor.role)'));
  assert.match(adminBranch, /extra_roles/, 'ветка администратора не читает дополнительные роли');
  assert.match(adminBranch, /setActorRoleGrants\(/, 'ветка администратора не отдаёт права ролей оболочке');
  assert.match(body.slice(body.indexOf('if (actor.role)')), /setActorRoleGrants\(/, 'ветка ролей не называет свою роль клиники');
});
