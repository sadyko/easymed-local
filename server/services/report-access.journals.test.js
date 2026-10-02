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
import { reportChoices } from './rpc/reports.js';   // JOURNALS_V1_RJ1
// JOURNALS_V1_RJ2 — F1: справочник филиала и экран «Роли»
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from '../test-helpers/tmpdir.js';
import { exportCatalogue, applyCatalogue } from './branch-sync/catalogue.js';
import { becomeSecondary } from './branch-sync/identity.js';
import { effectiveGrantsOf } from './rpc/roles-effective.js';
const MIG_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');

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

// JOURNALS_V1_RJ1 (ревью, п. 10c) — report_choices выдаётся за воротами вида
// отчёта, и журналы его пускали: роль «только Журналы» получала список врачей
// и поставщиков, которых журналам не нужно. Журналу — пустой список.
test('report_choices: журналы не отдают списков врачей и поставщиков; ворота прежние; другим отчётам — как было', () => {
  const db = seed();
  try {
    db.prepare("INSERT INTO users (id, username, password_hash, role, full_name, is_doctor) VALUES (31, 'doc31', 'x', 'doctor', 'Врач Тридцать', 1)").run();
    for (const kind of ['service_journal', 'inpatient_register']) {
      for (const arg of ['doctor_id', 'supplier_id']) {
        assert.deepEqual(reportChoices(db, { kind, arg }, as('journals_only')), { choices: [] }, kind + ' / ' + arg);
      }
    }
    assert.throws(() => reportChoices(db, { kind: 'service_journal', arg: 'doctor_id' }, as('journals_off')), (e) => e.status === 403);
    const ADMIN = { id: 1, role: 'admin', extra_roles: [] };
    assert.ok(reportChoices(db, { kind: 'doctor_lines', arg: 'doctor_id' }, ADMIN).choices.some(([, name]) => name === 'Врач Тридцать'));
  } finally { db.close(); }
});

// ── JOURNALS_V1_RJ2 (финальное ревью, F1) ────────────────────────────────────
// «Журналы: Нет» пропадало, как только права роли переписывали без этого
// ключа: справочник старой главной клиники затирает строки филиала
// (branch-sync/catalogue.js, role_permissions без проверки версии), устаревшая
// вкладка «Роли» сохраняет матрицу без новой строки. Роль, у которой группы
// отчётов настроены, падала в прежнее правило и видела паспорта и диагнозы.
// Правило в КОДЕ, только для «Журналов»: настроена хоть одна группа «reports.…»
// и ни одна роль не записала «Журналы» — это «Нет».
test('F1: устаревшее сохранение «Ролей» без ключа «Журналы» — «Нет», и экран «Роли» показывает «Нет» (повторное сохранение не откроет)', () => {
  const db = seed();
  try {
    db.prepare('INSERT INTO custom_roles (code, name, base_role) VALUES (?, ?, ?)').run('stale_save', 'stale_save', 'registrar');
    db.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?)').run('stale_save', JSON.stringify({
      sections: ['reports-hub'], levels: { 'reports-hub': 'viewer' },
      grants: { reports: 'view', 'reports.revenue': 'none', 'reports.cashier': 'view', 'reports.doctor_pay': 'none' } }));
    assert.equal(canSeeReportKey(db, as('stale_save'), 'reports.journals'), false);
    for (const kind of ['service_journal', 'inpatient_register']) {
      assert.throws(() => requireReportKind(db, as('stale_save'), kind), (e) => e.status === 403, kind);
    }
    assert.equal(canSeeReportKey(db, as('stale_save'), 'reports.cashier'), true, 'настроенная группа — как была');
    assert.equal(canSeeReportKey(db, as('stale_save'), 'reports.services'), true, 'прочие группы без ключа — прежнее правило, как сегодня');
    assert.equal(fallbackLevel(db, { id: 0, role: 'registrar', extra_roles: [], custom_role_code: 'stale_save' }, 'reports.journals', 'all'), 'none');
    assert.equal(effectiveGrantsOf(db, 'stale_save')['reports.journals'], 'none', 'экран «Роли» нарисовал бы «Просмотр» и записал его при сохранении');
    // Ненастроенная роль (ни одного ключа «reports.…») — прежнее правило.
    assert.equal(canSeeReportKey(db, as('with_reports'), 'reports.journals'), true);
    assert.equal(effectiveGrantsOf(db, 'with_reports')['reports.journals'], 'view');
  } finally { db.close(); }
});

// Справочник главной клиники версии ДО миграции 235 (3d58b04) приходит на
// филиал новой версии и затирает role_permissions — настоящими exportCatalogue
// и applyCatalogue (branch-sync/catalogue.js).
function migratedBefore(n) {
  const db = openDb(':memory:');
  const tmp = tmpDir('em-rj2-');
  for (const f of fs.readdirSync(MIG_DIR).filter((x) => x.endsWith('.sql') && parseInt(x, 10) < n)) {
    fs.copyFileSync(path.join(MIG_DIR, f), path.join(tmp, f));
  }
  migrate(db, tmp);
  return db;
}
test('F1: справочник старой главной клиники на новом филиале — кассир, колл-центр и копия кассира журналов не видят', () => {
  const main = migratedBefore(235);
  const branch = openDb(':memory:');
  try {
    migrate(branch);
    becomeSecondary(branch, { letter: 'C', name: 'Чиланзар' });
    const cashierPerms = main.prepare("SELECT permissions FROM role_permissions WHERE role = 'cashier'").get().permissions;
    main.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?)').run('kassa_copy', cashierPerms);
    for (const db of [main, branch]) db.prepare("INSERT INTO custom_roles (code, name, base_role) VALUES ('kassa_copy', 'Касса 2', 'cashier')").run();
    branch.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?)').run('kassa_copy',
      branch.prepare("SELECT permissions FROM role_permissions WHERE role = 'cashier'").get().permissions);
    const user = (role, extra = [], code = null) => ({ id: 80, role, extra_roles: extra, custom_role_code: code });
    const CASHIER = user('cashier');
    const CC = user('callcenter');
    const COPY = user('cashier', [], 'kassa_copy');
    const HEAD = user('doctor', ['head_doctor']);
    for (const u of [CASHIER, CC, COPY]) assert.equal(canSeeReportKey(branch, u, 'reports.journals'), false, 'до справочника');
    assert.equal(canSeeReportKey(branch, HEAD, 'reports.journals'), true, 'до справочника главный врач видит');
    branch.transaction(() => applyCatalogue(branch, exportCatalogue(main)))();
    assert.ok(!branch.prepare("SELECT permissions FROM role_permissions WHERE role = 'cashier'").get().permissions.includes('reports.journals'),
      'стенд не тот: справочник старой главной не затёр «Журналы: Нет»');
    for (const u of [CASHIER, CC, COPY]) {
      assert.equal(canSeeReportKey(branch, u, 'reports.journals'), false, (u.custom_role_code || u.role) + ' увидел журналы после справочника старой главной');
      for (const kind of ['service_journal', 'inpatient_register']) {
        assert.throws(() => requireReportKind(branch, u, kind), (e) => e.status === 403);
      }
    }
    assert.equal(canSeeReportKey(branch, CASHIER, 'reports.cashier'), true, 'касса кассира — как была');
    // Главный врач старой главной клиники журналов не знал — это её политика, не утечка.
    assert.equal(canSeeReportKey(branch, HEAD, 'reports.journals'), false);
  } finally { main.close(); branch.close(); }
});
