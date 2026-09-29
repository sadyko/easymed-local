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
import { GATE_FALLBACK, fallbackLevel } from '../../services/gate-fallbacks.js';
import { VALID_ROLES } from '../../services/roles.js';
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

test('230: строки проверки читают и отмечают администратор и «Роли: Изменение»; «Просмотр» — только читает; кто решил — из сессии', async (t) => {
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
  for (const who of ['admin', 'editor', 'viewer']) assert.equal((await q(who, read)).status, 200, who + ' не читает');
  assert.equal((await q('nurse', read)).status, 403);
  const id = (await q('admin', read)).json.data[0].id;
  const mark = (who) => q(who, { table: 'role_grant_reviews', op: 'update', values: { resolution: 'kept', resolved_at: '2026-09-29T10:00:00Z' }, filters: [{ col: 'id', op: 'in', val: [id] }] });
  assert.equal((await mark('nurse')).status, 403);
  assert.equal((await mark('viewer')).status, 403, '«Роли: Просмотр» отметил решение');
  const ok = await mark('editor');
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  const row = db.prepare('SELECT resolution, resolved_by FROM role_grant_reviews WHERE id = ?').get(id);
  assert.equal(row.resolution, 'kept');
  assert.equal(row.resolved_by, ids.editor, 'кто решил — из сессии');
  assert.equal(typeof MAIN_CLINIC_TABLES.role_grant_reviews, 'string', 'проверку прав решает главная клиника');
});
