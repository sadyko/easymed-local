// ROLES_SAVE_TRUTH_V1 (мигр. 230) — ключи, у которых записанный уровень выше
// стандарта основы роли (того, что дают ворота по списку ролей в коде): так их
// мог выдать сам экран «Роли» до этого выпуска — первое же «Сохранить роль»
// писало его догадку настоящим правом. Миграция права НЕ меняет (отличить
// догадку экрана от права, выданного нарочно, нельзя), а записывает такие пары
// в role_grant_reviews; решает в «Ролях» тот, кто вправе менять роль
// (views/roles-grant-review.js: «Убрать эти права» или «Оставить как есть»).
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
import { GATE_FALLBACK, FALLBACK_FN_KEYS, fallbackLevel } from '../../services/gate-fallbacks.js';
import { VALID_ROLES } from '../../services/roles.js';
import { pseudoUserOfRole } from '../../services/rpc/roles-effective.js';
import { MAIN_CLINIC_TABLES } from '../schema-registry.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SQL = fs.readFileSync(path.join(DIR, '230_role_grant_reviews.sql'), 'utf8');

function setup(rows = {}, custom = []) {
  const db = openDb(':memory:');
  migrate(db);
  for (const [code, base] of custom) db.prepare('INSERT INTO custom_roles (code, name, base_role, active) VALUES (?,?,?,1)').run(code, code, base);
  const put = db.prepare('INSERT OR REPLACE INTO role_permissions (role, permissions) VALUES (?, ?)');
  for (const [role, p] of Object.entries(rows)) put.run(role, JSON.stringify(p));
  return db;
}
const rowsOf = (db) => db.prepare('SELECT role, permissions FROM role_permissions ORDER BY role').all();
const reviewsOf = (db) => db.prepare('SELECT role, key, level, standard, resolution FROM role_grant_reviews ORDER BY role, key').all();
const withGrants = (grants) => ({ sections: ['patients'], levels: { patients: 'editor' }, grants });

test('230: таблица стандартов = fallbackLevel для каждой основы × ключа ворот', () => {
  const got = {};
  for (const m of SQL.matchAll(/\('([a-z_]+)', '([a-z._]+)', '(none|view|edit|delete)'\)/g)) got[m[1] + '|' + m[2]] = m[3];
  const db = openDb(':memory:');
  try {
    const want = {};
    for (const base of VALID_ROLES.filter((r) => r !== 'admin')) {
      for (const key of Object.keys(GATE_FALLBACK)) want[base + '|' + key] = fallbackLevel(db, { id: 0, role: base, extra_roles: [] }, key, 'all');
    }
    assert.deepEqual(got, want, 'стандарты миграции разошлись с воротами: пересоберите VALUES по gate-fallbacks.js');
  } finally { db.close(); }
});

test('230: на проверку — ровно расширенные пары (роль, ключ); администратор и роли на его основе пропущены; права не меняются', () => {
  const db = setup({
    registrar: withGrants({ 'crm.all': 'edit', 'inpatient.vitals': 'edit', 'inpatient.services': 'edit', 'crm.calls': 'view', 'inpatient.beds': 'edit', 'crm.dial': 'none' }),
    callcenter: withGrants({ 'crm.all': 'edit', 'crm.recording': 'edit' }),
    nurse: withGrants({ 'inpatient.vitals': 'delete', 'inpatient.prescriptions': 'edit', 'inpatient.marks': 'edit' }),
    lab: withGrants({ 'crm.all': 'admin', 'inpatient.vitals': 7 }),
    admin: withGrants({ 'crm.all': 'edit' }),
    'senior-op': withGrants({ 'crm.all': 'edit' }),
    deputy: withGrants({ 'crm.all': 'edit', 'inpatient.vitals': 'delete' }),
  }, [['senior-op', 'callcenter'], ['deputy', 'admin']]);
  try {
    const before = rowsOf(db);
    db.exec(SQL);
    assert.deepEqual(rowsOf(db), before, 'миграция тронула права');
    assert.deepEqual(reviewsOf(db), [
      { role: 'callcenter', key: 'crm.all', level: 'edit', standard: 'none', resolution: null },
      { role: 'nurse', key: 'inpatient.prescriptions', level: 'edit', standard: 'view', resolution: null },
      { role: 'nurse', key: 'inpatient.vitals', level: 'delete', standard: 'edit', resolution: null },
      { role: 'registrar', key: 'crm.all', level: 'edit', standard: 'none', resolution: null },
      { role: 'registrar', key: 'inpatient.services', level: 'edit', standard: 'view', resolution: null },
      { role: 'registrar', key: 'inpatient.vitals', level: 'edit', standard: 'none', resolution: null },
      { role: 'senior-op', key: 'crm.all', level: 'edit', standard: 'none', resolution: null },
    ]);
  } finally { db.close(); }
});

// Ревью M4 — ключи с воротами-функцией (gate-fallbacks.js FALLBACK_FN). Их
// стандарт — не список ролей основы, а прежняя галочка раздела САМОЙ роли, и
// старый экран выводил их из той же галочки ВЫШЕ ворот: «Оплату врачей» из
// «Отчётов» на «Изменении» — 'edit' (закрыть месяц оплаты врачей; ворота —
// только администратор), «Закупки» из «Склада» на «Изменении» — 'edit'
// (заявки всех отделов; ворота — администратор и снабженец).
test('230 (ревью M4): «Оплата врачей» и «Закупки» выше ворот — на проверке, со стандартом по разделам самой роли', () => {
  const db = setup({
    chief: { sections: ['patients', 'reports-hub'], levels: { patients: 'editor', 'reports-hub': 'editor' }, grants: { 'reports.doctor_pay': 'edit' } },
    'chief-view': { sections: ['reports-hub'], levels: { 'reports-hub': 'viewer' }, grants: { 'reports.doctor_pay': 'view' } },
    'no-reports': { sections: ['patients'], levels: { patients: 'editor' }, grants: { 'reports.doctor_pay': 'delete' } },
    'supply-nurse': { sections: ['inventory'], levels: { inventory: 'editor' }, grants: { procurement: 'edit' } },
    'store-keeper': { sections: ['inventory'], levels: { inventory: 'editor' }, grants: { procurement: 'edit' } },
    deputy: { sections: ['reports-hub'], levels: {}, grants: { 'reports.doctor_pay': 'edit', procurement: 'edit' } },
  }, [['chief', 'doctor'], ['chief-view', 'doctor'], ['no-reports', 'registrar'], ['supply-nurse', 'nurse'], ['store-keeper', 'inventory'], ['deputy', 'admin']]);
  try {
    db.exec(SQL);
    assert.deepEqual(reviewsOf(db), [
      { role: 'chief', key: 'reports.doctor_pay', level: 'edit', standard: 'view', resolution: null },
      { role: 'no-reports', key: 'reports.doctor_pay', level: 'delete', standard: 'none', resolution: null },
      { role: 'supply-nurse', key: 'procurement', level: 'edit', standard: 'view', resolution: null },
    ]);
  } finally { db.close(); }
});

// Стандарт ключа с воротами-функцией миграция считает сама, по строке роли, —
// сверяем его с самими воротами (fallbackLevel для «человека с этой ролью») на
// всех состояниях прежних разделов: раздела нет / «Просмотр» / «Изменение» /
// «Полный» / без уровня / пустой уровень — у каждой основы. «Зонд» пишет «Удаление» во все
// ключи: на проверку попадает каждая пара, и её стандарт виден; «смесь» —
// разные уровни: на проверку попадают ровно те, что выше стандарта.
test('230 (ревью M4): стандарт ключей FALLBACK_FN = fallbackLevel по строке самой роли; на проверке — ровно записанные выше него', () => {
  const bases = VALID_ROLES.filter((r) => r !== 'admin');
  const STATES = [null, 'viewer', 'editor', 'admin', undefined, ''];   // null — раздела нет; undefined — раздел без уровня; '' — пустой уровень
  const SECTIONS = ['custdev', 'settings', 'inventory', 'reports-hub'];
  const STORED = ['delete', 'edit', 'view', 'none', 'admin', 7];
  const rows = {};
  const custom = [];
  for (let i = 0; i < bases.length * STATES.length; i++) {
    const sections = ['patients'];
    const levels = { patients: 'editor' };
    SECTIONS.forEach((s, j) => {
      const st = STATES[(i + j * 2) % STATES.length];
      if (st === null) return;
      sections.push(s);
      if (st !== undefined) levels[s] = st;
    });
    const base = bases[i % bases.length];
    custom.push(['fn-probe-' + i, base], ['fn-mixed-' + i, base]);
    rows['fn-probe-' + i] = { sections, levels, grants: Object.fromEntries(FALLBACK_FN_KEYS.map((k) => [k, 'delete'])) };
    rows['fn-mixed-' + i] = { sections, levels, grants: Object.fromEntries(FALLBACK_FN_KEYS.map((k, j) => [k, STORED[(i + j) % STORED.length]])) };
  }
  custom.push(['fn-deputy', 'admin']);
  rows['fn-deputy'] = { sections: [], levels: {}, grants: Object.fromEntries(FALLBACK_FN_KEYS.map((k) => [k, 'delete'])) };
  const db = setup(rows, custom);
  try {
    db.exec(SQL);
    const got = new Map(db.prepare("SELECT role, key, level, standard FROM role_grant_reviews WHERE role LIKE 'fn-%'").all()
      .map((r) => [r.role + '|' + r.key, { ...r }]));
    const RANK = { view: 1, edit: 2, delete: 3 };
    const want = new Map();
    for (const role of Object.keys(rows)) {
      const pseudo = pseudoUserOfRole(db, role);
      if (pseudo.role === 'admin') continue;
      for (const key of FALLBACK_FN_KEYS) {
        const level = rows[role].grants[key];
        const standard = fallbackLevel(db, pseudo, key, 'all');
        if ((RANK[level] || 0) > (RANK[standard] || 0)) want.set(role + '|' + key, { role, key, level, standard });
      }
    }
    assert.deepEqual(got, want, 'стандарт миграции разошёлся с воротами-функцией (gate-fallbacks.js FALLBACK_FN)');
    for (const role of Object.keys(rows).filter((r) => r.startsWith('fn-probe-'))) {
      for (const key of FALLBACK_FN_KEYS) assert.ok(got.has(role + '|' + key), role + ' · ' + key + ': ключ с воротами-функцией не попал на проверку');
    }
  } finally { db.close(); }
});

test('230: повторный накат ничего не добавляет и решений не сбрасывает; свежая база — ни одной строки', () => {
  const db = setup({ callcenter: withGrants({ 'crm.all': 'edit' }) });
  try {
    db.exec(SQL);
    assert.equal(reviewsOf(db).length, 1);
    db.prepare("UPDATE role_grant_reviews SET resolution = 'kept', resolved_at = '2026-09-29T10:00:00Z'").run();
    db.exec(SQL);
    assert.deepEqual(reviewsOf(db).map((r) => r.resolution), ['kept']);
  } finally { db.close(); }
  const fresh = openDb(':memory:');
  try {
    migrate(fresh);
    assert.equal(fresh.prepare('SELECT COUNT(*) n FROM role_grant_reviews').get().n, 0, 'штатные роли свежей базы попали на проверку');
  } finally { fresh.close(); }
});

// Ревью M3/m1 — плашка только у администратора, и строки проверки тоже только
// его: «Роли: Изменение» мог отметить «Оставить» у СВОЕЙ роли (у записи в
// реестре не было проверки, чья это роль), а «Убрать» ему всё равно откажет
// защита «Ролей».
test('230: строки проверки читает и отмечает только администратор; кто решил — из сессии', async (t) => {
  const db = setup({
    callcenter: withGrants({ 'crm.all': 'edit' }),
    lab: withGrants({ 'settings.roles': 'edit' }),
    inventory: withGrants({ 'settings.roles': 'view' }),
  });
  db.exec(SQL);
  const pw = hashPassword('password1');
  const ids = {};
  for (const [u, role] of [['admin', 'admin'], ['nurse', 'nurse'], ['editor', 'lab'], ['viewer', 'inventory']]) {
    ids[u] = Number(db.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)').run(u, pw, u, role).lastInsertRowid);
  }
  const server = await listen(createApp(db, { dataDir: licensedDataDir() }));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.close(); db.close(); });
  const cookie = {};
  for (const u of Object.keys(ids)) {
    const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: 'password1' }) });
    cookie[u] = r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  }
  const q = async (who, desc) => {
    const r = await fetch(base + '/api/db', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie[who] }, body: JSON.stringify(desc) });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };
  const read = { table: 'role_grant_reviews', op: 'select', columns: 'id,role,key,level,standard,resolution', filters: [] };
  assert.equal((await q('admin', read)).status, 200, 'администратор не читает');
  for (const who of ['editor', 'viewer', 'nurse']) assert.equal((await q(who, read)).status, 403, who + ' читает строки проверки');
  const id = (await q('admin', read)).json.data[0].id;
  const mark = (who) => q(who, { table: 'role_grant_reviews', op: 'update', values: { resolution: 'kept', resolved_at: '2026-09-29T10:00:00Z' }, filters: [{ col: 'id', op: 'in', val: [id] }] });
  for (const who of ['nurse', 'viewer', 'editor']) assert.equal((await mark(who)).status, 403, who + ' отметил решение');
  assert.equal(db.prepare('SELECT resolution FROM role_grant_reviews WHERE id = ?').get(id).resolution, null);
  const ok = await mark('admin');
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  const row = db.prepare('SELECT resolution, resolved_by FROM role_grant_reviews WHERE id = ?').get(id);
  assert.equal(row.resolution, 'kept');
  assert.equal(row.resolved_by, ids.admin, 'кто решил — из сессии');
  assert.equal(typeof MAIN_CLINIC_TABLES.role_grant_reviews, 'string', 'проверку прав решает главная клиника');
});
