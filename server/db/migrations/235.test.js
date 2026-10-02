// JOURNALS_V1_ACCESS (мигр. 235) — «Журналы» и роли.
//
// Группа, которую роль не настраивала, живёт прежним правилом (администратор
// и раздел «Отчёты»). Но роль, у которой группы отчётов уже НАСТРОЕНЫ (есть
// хоть один ключ «reports.…» — тот же признак, что у миграции 179), сузила
// себе «Отчёты» руками: новая группа с диагнозами и паспортами не должна
// открыться ей сама. Ей — «Журналы: Нет», и штатной, и своей роли клиники
// (JOURNALS_V1_RJ1, ревью п. 2). Главному врачу — «Журналы: Просмотр»
// (раздела «Отчёты» у него нет). Уже записанный ключ не трогается; повторный
// накат ничего не меняет.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';
import { canSeeReportKey, requireReportKind } from '../../services/report-access.js';
import { effectiveGrantsOf } from '../../services/rpc/roles-effective.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const grantsOf = (db, role) =>
  (JSON.parse(db.prepare('SELECT permissions FROM role_permissions WHERE role = ?').get(role).permissions).grants) || {};
const permsOf = (db, role) => db.prepare('SELECT permissions FROM role_permissions WHERE role = ?').get(role).permissions;
const KINDS = ['service_journal', 'inpatient_register'];

// JOURNALS_V1_RJ1 — база ровно до 235: свои роли клиники заводятся ДО миграции.
function dbBefore235() {
  const db = openDb(':memory:');
  const tmp = tmpDir('em-mig235-');
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.sql') && parseInt(x, 10) < 235)) {
    fs.copyFileSync(path.join(DIR, f), path.join(tmp, f));
  }
  migrate(db, tmp);
  return db;
}
const addRole = (db, code, base, perms) => {
  db.prepare('INSERT INTO custom_roles (code, name, base_role) VALUES (?, ?, ?)').run(code, code, base);
  db.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?)').run(code, typeof perms === 'string' ? perms : JSON.stringify(perms));
};
const as = (code, base = 'registrar') => ({ id: 70, role: base, extra_roles: [], custom_role_code: code });

test('235: кассир и склад — «Журналы: Нет», главный врач — «Журналы: Просмотр»; роли без групп отчётов не тронуты', () => {
  const db = openDb(':memory:');
  try {
    migrate(db);
    assert.equal(grantsOf(db, 'cashier')['reports.journals'], 'none');
    assert.equal(grantsOf(db, 'inventory')['reports.journals'], 'none');
    assert.equal(grantsOf(db, 'head_doctor')['reports.journals'], 'view');
    assert.equal(grantsOf(db, 'cashier')['reports.cashier'], 'view', 'группы 179 потерялись');
    // JOURNALS_V1_RJ1 — оператор колл-центра настроен 152-й («Колл-центр»): тоже «Нет».
    assert.equal(grantsOf(db, 'callcenter')['reports.journals'], 'none');
    for (const role of ['admin', 'registrar', 'doctor', 'nurse', 'lab', 'senior_nurse', 'head_cashier']) {
      assert.ok(!('reports.journals' in grantsOf(db, role)), role + ': ключ записан роли без настроенных групп отчётов');
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

// JOURNALS_V1_RJ1 (ревью, п. 2) — свои роли клиники с настроенными отчётами.
test('235: свои роли клиники — копия кассира, «только Касса», копия склада — «Журналы: Нет», оба журнала 403; ненастроенная — прежнее правило', () => {
  const db = dbBefore235();
  try {
    addRole(db, 'kassa_copy', 'cashier', permsOf(db, 'cashier'));
    addRole(db, 'kassa_only', 'registrar', { sections: ['reports-hub'], levels: {}, grants: { reports: 'view', 'reports.cashier': 'view' } });
    addRole(db, 'sklad_copy', 'inventory', permsOf(db, 'inventory'));
    addRole(db, 'reports_plain', 'registrar', { sections: ['reports-hub'], levels: { 'reports-hub': 'viewer' } });
    addRole(db, 'journals_set', 'registrar', { sections: ['reports-hub'], levels: {}, grants: { 'reports.cashier': 'view', 'reports.journals': 'view' } });
    migrate(db);
    for (const code of ['kassa_copy', 'kassa_only', 'sklad_copy']) {
      assert.equal(grantsOf(db, code)['reports.journals'], 'none', code);
      for (const kind of KINDS) {
        assert.throws(() => requireReportKind(db, as(code), kind), (e) => e.status === 403, code + ' / ' + kind);
      }
    }
    assert.equal(grantsOf(db, 'kassa_only')['reports.cashier'], 'view', 'чужие ключи роли целы');
    assert.ok(!('reports.journals' in grantsOf(db, 'reports_plain')), 'ненастроенная роль — без ключа');
    // JOURNALS_V1_RJ3 — прежнего правила у «Журналов» больше нет: без явной выдачи — 403 и ненастроенной роли.
    for (const kind of KINDS) assert.throws(() => requireReportKind(db, as('reports_plain'), kind), (e) => e.status === 403, 'ненастроенная — без явной выдачи: ' + kind);
    assert.equal(grantsOf(db, 'journals_set')['reports.journals'], 'view', 'записанный ключ не перезаписан');
    for (const kind of KINDS) assert.doesNotThrow(() => requireReportKind(db, as('journals_set'), kind), 'явная выдача: ' + kind);   // JOURNALS_V1_RJ3
  } finally { db.close(); }
});

test('235: уже записанный ключ — не тронут; повторный накат — ничего', () => {
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
    assert.ok(!('reports.journals' in grantsOf(db, 'kassa2')), 'своя роль без групп отчётов тронута');
  } finally { db.close(); }
});
