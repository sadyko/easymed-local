// V3121_ROLES (мигр. 215) — роли, сохранённые на экране «действиями» (v0.9–3.0,
// раздел без своих действий записывался как «viewer») и пересохранённые на
// матрице (3.1+), получили явный «Просмотр» на всех действиях стационара и
// склада: медсестра с 3.2 не пишет измерения, склад не выдаёт со склада.
//
// Отличить такую строку от НАМЕРЕННОГО «только просмотр», выставленного на
// нынешнем экране, нельзя — байты те же. Поэтому миграция права НЕ меняет, а
// записывает совпавшие строки в role_permission_reviews; администратор в
// «Ролях» решает: «Вернуть права по умолчанию» (shared/old-screen-view.js
// restoreOldScreenArea) или «Оставить как есть».
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { hashPassword } from '../../services/auth.js';
import { createApp } from '../../app.js';
import { licensedDataDir } from '../../services/control/licensed-fixture.js';
import { listen } from '../../../control-plane/server/test-helpers/listen.js';
import { grantAllows, grantLevel } from '../../services/grants.js';
import { grantsFromLegacy, catalogRows, CATALOG } from '../../../public/js/shared/permission-catalog.js';
import { OLD_SCREEN_AREAS, matchesOldScreen, restoreOldScreenArea } from '../../../public/js/shared/old-screen-view.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SQL = fs.readFileSync(path.join(DIR, '215_old_screen_view_review.sql'), 'utf8');

// Строка, как её сохраняет матрица «Ролей» (3.1+): grants выведены
// grantsFromLegacy из старых полей, а collectGrants убрал невыбранное «Нет» у
// разделов и строки «только администратор». Из старого «viewer» она выводит
// отпечаток старого экрана; ТОТ ЖЕ результат даёт «Просмотр», выставленный на
// всех строках раздела руками на нынешнем экране.
function matrixSaved(sections, levels, extraGrants = {}) {
  const g = grantsFromLegacy({ sections, levels });
  for (const r of catalogRows()) if (r.adminDefault && g[r.key] === 'none') delete g[r.key];
  for (const s of CATALOG) if (g[s.key] === 'none') delete g[s.key];
  return { sections, levels, patient_tabs: {}, grants: { ...g, ...extraGrants } };
}

const NURSE = matrixSaved(['patients', 'labs', 'dashboard', 'procedures', 'queue', 'beds'],
  { patients: 'editor', labs: 'viewer', dashboard: 'viewer', procedures: 'viewer', queue: 'viewer', beds: 'viewer' },
  { 'crm.calls': 'none', 'crm.dial': 'none', 'crm.recording': 'none', 'crm.convert': 'none' });
const STOCK = matrixSaved(['inventory', 'dashboard', 'reports-hub'],
  { inventory: 'viewer', dashboard: 'viewer', 'reports-hub': 'viewer' });

function setup(rows) {
  const db = openDb(':memory:');
  migrate(db);
  const up = db.prepare('INSERT OR REPLACE INTO role_permissions (role, permissions) VALUES (?, ?)');
  for (const [role, p] of Object.entries(rows)) up.run(role, JSON.stringify(p));
  return db;
}
const perms = (db, role) => JSON.parse(db.prepare('SELECT permissions FROM role_permissions WHERE role = ?').get(role).permissions);
const nurse = { id: 1, role: 'nurse', extra_roles: [] };
const stock = { id: 2, role: 'inventory', extra_roles: [] };

const rowsOf = (db) => db.prepare('SELECT role, permissions FROM role_permissions ORDER BY role').all();
const reviewsOf = (db) => db.prepare('SELECT role, area, resolution FROM role_permission_reviews ORDER BY role, area').all();

test('215: строка старого экрана — права не меняются, роль записана на проверку', () => {
  const db = setup({ nurse: NURSE, inventory: STOCK });
  try {
    const before = rowsOf(db);
    db.exec(SQL);
    assert.deepEqual(rowsOf(db), before, 'миграция прав не трогает');
    assert.deepEqual(reviewsOf(db), [
      { role: 'inventory', area: 'procurement', resolution: null },
      { role: 'nurse', area: 'inpatient', resolution: null },
    ]);
    assert.equal(grantAllows(db, nurse, 'inpatient.vitals', 'edit', ['nurse']), false, 'пока администратор не решил — как было');
  } finally { db.close(); }
});

test('215: «Вернуть права по умолчанию» — медсестра пишет измерения и отмечает введение, не выше основы; склад выдаёт', () => {
  const db = setup({ nurse: NURSE, inventory: STOCK });
  try {
    db.exec(SQL);
    const put = db.prepare('UPDATE role_permissions SET permissions = ? WHERE role = ?');
    put.run(JSON.stringify(restoreOldScreenArea(perms(db, 'nurse'), 'inpatient')), 'nurse');
    put.run(JSON.stringify(restoreOldScreenArea(perms(db, 'inventory'), 'procurement')), 'inventory');
    for (const k of Object.keys(OLD_SCREEN_AREAS.inpatient.keys)) assert.equal(grantLevel(db, nurse, k), null, k + ' — решает правило основы');
    assert.equal(grantAllows(db, nurse, 'inpatient.vitals', 'edit', ['nurse', 'senior_nurse', 'doctor', 'admin']), true);
    assert.equal(grantAllows(db, nurse, 'inpatient.marks', 'edit', ['nurse', 'senior_nurse', 'admin']), true);
    assert.equal(grantAllows(db, nurse, 'inpatient.prescriptions', 'edit', ['doctor', 'head_doctor', 'admin']), false, 'не выше основы');
    assert.equal(grantAllows(db, nurse, 'inpatient.vitals', 'delete', ['admin']), false);
    const p = perms(db, 'nurse');
    assert.equal(p.levels.beds, 'editor');
    assert.equal(p.levels.procedures, 'viewer', 'остальные уровни не трогаем');
    assert.equal(p.grants.labs, 'view');
    assert.equal(p.grants['crm.dial'], 'none');
    assert.equal(grantsFromLegacy(p)['inpatient.vitals'], 'edit', 'пересохранение на матрице не вернёт «Просмотр»');
    assert.equal(matchesOldScreen(p, 'inpatient'), false);
    assert.equal(grantAllows(db, stock, 'procurement.issue', 'edit', ['admin', 'inventory']), true);
    assert.equal(perms(db, 'inventory').grants['reports.stock'], 'view', 'отчёты не трогаем');
  } finally { db.close(); }
});

test('215: намеренный «только просмотр» с нынешнего экрана миграция не снимает — «Оставить как есть» его сохраняет', () => {
  // Администратор открыл штатную роль (Стационар и Закупки «editor») и выставил
  // «Просмотр» на всех строках стационара и «Нет» у выписки; складу —
  // «Просмотр» и «Нет» у выдачи. Строка совпадает с отпечатком старого экрана.
  const shipped = matrixSaved(['patients', 'beds', 'inventory'], { patients: 'editor', beds: 'editor', inventory: 'editor' });
  const g = { ...shipped.grants };
  for (const [k, v] of Object.entries({ ...OLD_SCREEN_AREAS.inpatient.keys, ...OLD_SCREEN_AREAS.procurement.keys })) g[k] = v;
  const chosen = { ...shipped, levels: { ...shipped.levels, beds: 'viewer', inventory: 'viewer' }, grants: g };
  const db = setup({ ward_viewer: chosen });
  try {
    const before = rowsOf(db);
    db.exec(SQL);
    assert.deepEqual(rowsOf(db), before, 'намеренный выбор миграция не трогает');
    assert.equal(reviewsOf(db).length, 2, 'и показывает его администратору — решает он');
    db.prepare("UPDATE role_permission_reviews SET resolution = 'kept', resolved_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')").run();
    db.exec(SQL);
    assert.deepEqual(rowsOf(db), before);
    assert.deepEqual(reviewsOf(db).map((r) => r.resolution), ['kept', 'kept'], 'повторный накат решения не сбрасывает');
  } finally { db.close(); }
});

test('215: смешанная строка, собранная руками, на проверку не попадает; отпечаток SQL = отпечаток экрана', () => {
  const partial = { ...NURSE, grants: { ...NURSE.grants } };
  delete partial.grants['inpatient.reviews'];
  const rows = {
    nurse: NURSE, inventory: STOCK,
    a: { ...NURSE, grants: { ...NURSE.grants, 'inpatient.vitals': 'edit' } },
    b: { ...NURSE, grants: { ...NURSE.grants, 'inpatient.marks': 'none' } },
    c: partial,
    d: { ...NURSE, levels: { ...NURSE.levels, beds: 'editor' } },
    e: { ...STOCK, grants: { ...STOCK.grants, 'procurement.issue': 'edit' } },
    f: matrixSaved(['beds', 'inventory'], { beds: 'editor', inventory: 'editor' }),
  };
  const db = setup(rows);
  try {
    db.exec(SQL);
    const got = reviewsOf(db).map((r) => r.role + ':' + r.area).sort();
    const want = [];
    for (const [role, p] of Object.entries(rows)) for (const area of Object.keys(OLD_SCREEN_AREAS)) if (matchesOldScreen(p, area)) want.push(role + ':' + area);
    assert.deepEqual(got, want.sort());
    assert.deepEqual(got, ['inventory:procurement', 'nurse:inpatient']);
  } finally { db.close(); }
});

test('215: штатные роли свежей базы на проверку не попадают, повторный накат ничего не меняет', () => {
  const db = openDb(':memory:');
  try {
    migrate(db);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM role_permission_reviews').get().n, 0);
    const before = rowsOf(db);
    db.exec(SQL);
    assert.deepEqual(rowsOf(db), before);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM role_permission_reviews').get().n, 0);
  } finally { db.close(); }
});

test('215: записи проверки видит и решает только администратор (/api/db), кто решил — из сессии', async (t) => {
  const db = setup({ nurse: NURSE });
  db.exec(SQL);
  const pw = hashPassword('password1');
  const ids = {};
  for (const [u, role] of [['admin', 'admin'], ['nurse', 'nurse']]) {
    ids[u] = Number(db.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)').run(u, pw, u, role).lastInsertRowid);
  }
  const server = await listen(createApp(db, { dataDir: licensedDataDir() }));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.close(); db.close(); });
  const cookie = {};
  for (const u of ['admin', 'nurse']) {
    const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: 'password1' }) });
    cookie[u] = r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  }
  const q = async (who, desc) => {
    const r = await fetch(base + '/api/db', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie[who] }, body: JSON.stringify(desc) });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };
  const list = await q('admin', { table: 'role_permission_reviews', op: 'select', columns: 'id,role,area,resolution', filters: [] });
  assert.equal(list.status, 200, JSON.stringify(list.json));
  assert.equal(list.json.data.length, 1);
  const denied = await q('nurse', { table: 'role_permission_reviews', op: 'select', columns: 'id', filters: [] });
  assert.equal(denied.status, 403);
  const id = list.json.data[0].id;
  const upNurse = await q('nurse', { table: 'role_permission_reviews', op: 'update', values: { resolution: 'kept', resolved_at: '2026-09-28T10:00:00Z' }, filters: [{ col: 'id', op: 'eq', val: id }] });
  assert.equal(upNurse.status, 403);
  const up = await q('admin', { table: 'role_permission_reviews', op: 'update', values: { resolution: 'restored', resolved_at: '2026-09-28T10:00:00Z' }, filters: [{ col: 'id', op: 'eq', val: id }], returning: true });
  assert.equal(up.status, 200, JSON.stringify(up.json));
  const row = db.prepare('SELECT resolution, resolved_by FROM role_permission_reviews WHERE id = ?').get(id);
  assert.equal(row.resolution, 'restored');
  assert.equal(row.resolved_by, ids.admin, 'кто решил — из сессии');
});
