// JOURNALS_V1_ACCESS — группа отчётов «Журналы» (reports.journals): журнал услуг
// и реестр стационарных пациентов.
// JOURNALS_V1_RJ3 — доступ ЯВНЫЙ: администратор и роли, которым в «Ролях»
// выдано «Журналы: Просмотр»; по умолчанию — ни у кого (прежнего правила групп
// у «Журналов» нет). Прочие группы — как были.
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

test('JOURNALS_V1_RJ3 — ключ не выдан: «Нет» и с разделом «Отчёты», и без; экран «Роли» — «Нет»; администратор — всегда', () => {
  const db = seed();
  try {
    assert.equal(canSeeReportKey(db, as('with_reports'), 'reports.journals'), false, 'раздел «Отчёты» журналов не открывает');
    assert.equal(canSeeReportKey(db, as('no_reports'), 'reports.journals'), false);
    assert.equal(canSeeReportKey(db, { id: 1, role: 'admin', extra_roles: [] }, 'reports.journals'), true);
    assert.equal(canSeeReportKey(db, as('with_reports'), 'reports.revenue'), true, 'прочие группы — прежнее правило');
    assert.equal(fallbackLevel(db, { id: 0, role: 'registrar', extra_roles: [], custom_role_code: 'with_reports' }, 'reports.journals', 'all'), 'none');
    assert.equal(fallbackLevel(db, { id: 0, role: 'registrar', extra_roles: [], custom_role_code: 'no_reports' }, 'reports.journals', 'all'), 'none');
    assert.equal(fallbackLevel(db, { id: 0, role: 'admin', extra_roles: [] }, 'reports.journals', 'all'), 'view');
    assert.equal(effectiveGrantsOf(db, 'with_reports')['reports.journals'], 'none');
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
    // JOURNALS_V1_RJ3 — и ненастроенная роль (ни одного ключа «reports.…») — «Нет»: доступ только явный.
    assert.equal(canSeeReportKey(db, as('with_reports'), 'reports.journals'), false);
    assert.equal(effectiveGrantsOf(db, 'with_reports')['reports.journals'], 'none');
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

// JOURNALS_V1_RJ2 (финальное ревью, F3) — клиника закрыла «Отчёты» роли «Врач»
// (reports: none), а главный врач — врач с надстройкой «Главный врач»
// («Журналы: Просмотр»). Самый щедрый уровень раздела по ролям — «Нет» (у
// надстройки раздела нет), и закрытый раздел запирал выданные журналы.
// Теперь ЯВНАЯ выдача «Журналов» роли, у которой «Отчёты» не закрыты самой
// этой ролью, открывает журналы — и только их.
test('F3: «Отчёты» закрыты врачу, главному врачу выданы «Журналы» — журналы видны, прочие отчёты — нет', () => {
  const db = seed();
  try {
    const doc = JSON.parse(db.prepare("SELECT permissions FROM role_permissions WHERE role = 'doctor'").get().permissions);
    doc.grants = { ...(doc.grants || {}), reports: 'none' };
    db.prepare("UPDATE role_permissions SET permissions = ? WHERE role = 'doctor'").run(JSON.stringify(doc));
    const HEAD = { id: 81, role: 'doctor', extra_roles: ['head_doctor'] };
    const DOC = { id: 82, role: 'doctor', extra_roles: [] };
    assert.equal(canSeeReportKey(db, HEAD, 'reports.journals'), true);
    for (const kind of ['service_journal', 'inpatient_register']) assert.doesNotThrow(() => requireReportKind(db, HEAD, kind), kind);
    for (const key of ['reports.revenue', 'reports.cashier', 'reports.doctor_pay', 'reports.services', 'reports.stock']) {
      assert.equal(canSeeReportKey(db, HEAD, key), false, key + ' открылся «Журналами»');
    }
    assert.throws(() => requireReportKind(db, HEAD, 'total_revenue'), (e) => e.status === 403);
    assert.equal(canSeeReportKey(db, DOC, 'reports.journals'), false, 'врачу без надстройки — нет');
    // Своя роль «Главный врач», которой клиника САМА закрыла «Отчёты»: её «Журналы» — нет.
    const head = JSON.parse(db.prepare("SELECT permissions FROM role_permissions WHERE role = 'head_doctor'").get().permissions);
    head.grants = { ...head.grants, reports: 'none' };
    db.prepare("UPDATE role_permissions SET permissions = ? WHERE role = 'head_doctor'").run(JSON.stringify(head));
    assert.equal(canSeeReportKey(db, HEAD, 'reports.journals'), false, 'закрытый ЭТОЙ ролью раздел закрывает и её журналы');
  } finally { db.close(); }
});

// ── JOURNALS_V1_RJ3 — ЯВНЫЙ ДОСТУП (проверка доступа на c68e837) ─────────────────
// Эвристика «роль настроена» давала дыры на каждом краю: копии кассира и склада,
// сделанные до миграции 179 (custom-roles.js копирует строку основы, а 179
// правила только штатные), — ни одного ключа «reports.…», «ненастроены» —
// открывали оба журнала; то же — справочник главной клиники ниже 179 на новом
// филиале. Правило «Журналов» теперь — только явная выдача.
test('RJ3: копии кассира и склада, сделанные до миграции 179, после обновления журналов не видят (оба журнала — 403)', () => {
  const db = migratedBefore(179);
  try {
    for (const [code, base] of [['kassa_old', 'cashier'], ['sklad_old', 'inventory']]) {
      db.prepare('INSERT INTO custom_roles (code, name, base_role) VALUES (?, ?, ?)').run(code, code, base);
      db.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?)').run(code,
        db.prepare('SELECT permissions FROM role_permissions WHERE role = ?').get(base).permissions);
    }
    migrate(db);
    for (const [code, base] of [['kassa_old', 'cashier'], ['sklad_old', 'inventory']]) {
      const u = { id: 83, role: base, extra_roles: [], custom_role_code: code };
      assert.ok(!db.prepare('SELECT permissions FROM role_permissions WHERE role = ?').get(code).permissions.includes('"reports.'), 'стенд не тот: у копии есть ключи «reports.…»');
      assert.equal(canSeeReportKey(db, u, 'reports.journals'), false, code);
      for (const kind of ['service_journal', 'inpatient_register']) assert.throws(() => requireReportKind(db, u, kind), (e) => e.status === 403, code + ' / ' + kind);
      assert.equal(effectiveGrantsOf(db, code)['reports.journals'], 'none', code + ': экран «Роли»');
    }
  } finally { db.close(); }
});

test('RJ3: справочник главной клиники ниже 179 на новом филиале — кассир, склад и их копии журналов не видят', () => {
  const main = migratedBefore(179);
  const branch = openDb(':memory:');
  try {
    migrate(branch);
    becomeSecondary(branch, { letter: 'C', name: 'Чиланзар' });
    for (const [code, base] of [['kassa_copy', 'cashier'], ['sklad_copy', 'inventory']]) {
      main.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?)').run(code,
        main.prepare('SELECT permissions FROM role_permissions WHERE role = ?').get(base).permissions);
      for (const db of [main, branch]) db.prepare('INSERT INTO custom_roles (code, name, base_role) VALUES (?, ?, ?)').run(code, code, base);
      branch.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?)').run(code,
        branch.prepare('SELECT permissions FROM role_permissions WHERE role = ?').get(base).permissions);
    }
    branch.transaction(() => applyCatalogue(branch, exportCatalogue(main)))();
    assert.ok(!branch.prepare("SELECT permissions FROM role_permissions WHERE role = 'cashier'").get().permissions.includes('"reports.'),
      'стенд не тот: справочник главной ниже 179 не затёр группы кассира');
    const U = (role, code = null) => ({ id: 84, role, extra_roles: [], custom_role_code: code });
    for (const u of [U('cashier'), U('inventory'), U('cashier', 'kassa_copy'), U('inventory', 'sklad_copy')]) {
      assert.equal(canSeeReportKey(branch, u, 'reports.journals'), false, u.custom_role_code || u.role);
      for (const kind of ['service_journal', 'inpatient_register']) assert.throws(() => requireReportKind(branch, u, kind), (e) => e.status === 403);
    }
    assert.equal(canSeeReportKey(branch, U('cashier'), 'reports.cashier'), true, 'касса кассира — прежнее правило');
  } finally { main.close(); branch.close(); }
});

test('RJ3: «Отчёты» есть, сохранили другую группу — «Журналы» как были «Нет», и сервер, и экран «Роли»', () => {
  const db = seed();
  try {
    const before = [canSeeReportKey(db, as('with_reports'), 'reports.journals'), effectiveGrantsOf(db, 'with_reports')['reports.journals']];
    const p = { sections: ['reports-hub'], levels: { 'reports-hub': 'viewer' }, grants: { 'reports.cashier': 'view' } };   // «Роли»: выдали «Кассу»
    db.prepare("UPDATE role_permissions SET permissions = ? WHERE role = 'with_reports'").run(JSON.stringify(p));
    const after = [canSeeReportKey(db, as('with_reports'), 'reports.journals'), effectiveGrantsOf(db, 'with_reports')['reports.journals']];
    assert.deepEqual(before, [false, 'none']);
    assert.deepEqual(after, before, 'сохранение другой группы перевернуло «Журналы»');
  } finally { db.close(); }
});

test('RJ3: явное «Журналы: Просмотр» своей роли — видно; главный врач (надстройка) — видно; врач без неё — нет', () => {
  const db = seed();
  try {
    assert.equal(canSeeReportKey(db, as('journals_only'), 'reports.journals'), true);
    assert.equal(canSeeReportKey(db, { id: 85, role: 'doctor', extra_roles: ['head_doctor'] }, 'reports.journals'), true);
    assert.equal(canSeeReportKey(db, { id: 86, role: 'doctor', extra_roles: [] }, 'reports.journals'), false);
  } finally { db.close(); }
});

// Администратор: «Журналы» видны, пока СВОЯ роль клиники на основе администратора
// их не закрыла (ключом или разделом «Отчёты»). Дополнительная роль, явно
// выдавшая «Журналы», — прибавка: открывает и тогда.
test('RJ3: администратор — видит; своя роль на основе администратора закрыла — нет; + «Главный врач» — видит', () => {
  const db = seed();
  try {
    const addDeputy = (code, grants) => {
      db.prepare('INSERT INTO custom_roles (code, name, base_role) VALUES (?, ?, ?)').run(code, code, 'admin');
      db.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?)').run(code, JSON.stringify({ sections: ['reports-hub'], levels: {}, grants }));
    };
    addDeputy('dep_j_none', { 'reports.journals': 'none' });
    addDeputy('dep_r_none', { reports: 'none' });
    addDeputy('dep_rev_none', { 'reports.revenue': 'none' });
    const A = (code, extra = []) => ({ id: 87, role: 'admin', extra_roles: extra, custom_role_code: code });
    assert.equal(canSeeReportKey(db, A(null), 'reports.journals'), true);
    assert.equal(canSeeReportKey(db, { id: 88, role: 'doctor', extra_roles: ['admin'] }, 'reports.journals'), true, 'администратор-врач');
    assert.equal(canSeeReportKey(db, A('dep_j_none'), 'reports.journals'), false);
    assert.equal(canSeeReportKey(db, A('dep_r_none'), 'reports.journals'), false);
    assert.equal(canSeeReportKey(db, A('dep_rev_none'), 'reports.journals'), true, 'закрыта другая группа — журналы видны');
    assert.equal(canSeeReportKey(db, A('dep_j_none', ['head_doctor']), 'reports.journals'), true, 'надстройка «Главный врач» — прибавка');
    assert.equal(canSeeReportKey(db, A('dep_r_none', ['head_doctor']), 'reports.journals'), true);
    assert.equal(canSeeReportKey(db, A(null, ['cashier']), 'reports.journals'), true, '«Нет» чужой (дополнительной) роли администратору не закрывает');
  } finally { db.close(); }
});
