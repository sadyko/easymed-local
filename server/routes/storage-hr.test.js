// HR_STAFF_V1 — корзина `hr-docs`: кадровые документы сотрудников. Читает и
// кладёт только администратор, путь — ровно staff/<id>/<файл>, файл не
// перезаписывается и не удаляется через хранилище.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { hashPassword } from '../services/auth.js';
import { createApp } from '../app.js';
import { licensedDataDir } from '../services/control/licensed-fixture.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';

const ROLES = ['admin', 'registrar', 'doctor'];

async function start(t) {
  const db = openDb(':memory:');
  migrate(db);
  const pw = hashPassword('password1');
  for (const r of ROLES) db.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)').run(r, pw, r, r);
  const dataDir = licensedDataDir({ modules: [] });
  const server = await listen(createApp(db, { dataDir }));
  t.after(() => { server.close(); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = {};
  for (const r of ROLES) {
    const res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: r, password: 'password1' }) });
    cookie[r] = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  }
  return { base, cookie, storage: path.join(dataDir, 'storage'), db };
}

const put = (s, who, obj, body = '%PDF-1.4 scan') => fetch(s.base + '/api/storage/' + obj,
  { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', Cookie: s.cookie[who] }, body: Buffer.from(body) });
const del = (s, who, obj) => fetch(s.base + '/api/storage/' + obj, { method: 'DELETE', headers: { Cookie: s.cookie[who] } });
const get = (s, who, obj) => fetch(s.base + '/api/storage/' + obj, { headers: { Cookie: s.cookie[who] } });

test('hr-docs: кладёт и читает только администратор', async (t) => {
  const s = await start(t);
  const denied = await put(s, 'registrar', 'hr-docs/staff/2/1-passport.pdf');
  assert.equal(denied.status, 403);
  assert.match((await denied.json()).error.message, /администратору/);
  assert.equal((await put(s, 'doctor', 'hr-docs/staff/2/1-passport.pdf')).status, 403);
  assert.equal((await put(s, 'admin', 'hr-docs/staff/2/1-passport.pdf')).status, 200);
  assert.ok(fs.existsSync(path.join(s.storage, 'hr-docs', 'staff', '2', '1-passport.pdf')));
  assert.equal((await get(s, 'admin', 'hr-docs/staff/2/1-passport.pdf')).status, 200);
  assert.equal((await get(s, 'registrar', 'hr-docs/staff/2/1-passport.pdf')).status, 403, 'паспорт коллеги не читается');
  assert.equal((await get(s, 'doctor', 'hr-docs/staff/2/1-passport.pdf')).status, 403);
});

test('hr-docs: только форма staff/<id>/<файл>, без исполняемых, без перезаписи и удаления', async (t) => {
  const s = await start(t);
  for (const bad of ['hr-docs/a.pdf', 'hr-docs/staff/a.pdf', 'hr-docs/staff/x/a.pdf', 'hr-docs/staff/2/sub/a.pdf', 'hr-docs/other/2/a.pdf']) {
    assert.equal((await put(s, 'admin', bad)).status, 400, bad);
  }
  assert.equal((await put(s, 'admin', 'hr-docs/staff/2/evil.exe')).status, 415);
  assert.equal((await put(s, 'admin', 'hr-docs/staff/2/page.html')).status, 415);
  assert.equal((await put(s, 'admin', 'hr-docs/staff/2/c.pdf')).status, 200);
  assert.equal((await put(s, 'admin', 'hr-docs/staff/2/c.pdf', 'подмена')).status, 409, 'приложенный файл не подменяется');
  assert.equal((await del(s, 'admin', 'hr-docs/staff/2/c.pdf')).status, 403);
  assert.ok(fs.existsSync(path.join(s.storage, 'hr-docs', 'staff', '2', 'c.pdf')));
});

// HR_CANDIDATE_DOCS_V1 — папка candidate/<id>/ открыта по строке «Ролей»
// hr_recruiting: «Просмотр» читает, «Изменение» кладёт; staff/ рекрутеру — нет.
test('hr-docs/candidate: право — «Подбор персонала», папка сотрудников рекрутеру закрыта', async (t) => {
  const s = await start(t);
  const setGrant = (lvl) => s.db.prepare('INSERT OR REPLACE INTO role_permissions (role, permissions) VALUES (?, ?)')
    .run('registrar', JSON.stringify({ grants: { hr_recruiting: lvl } }));
  assert.equal((await put(s, 'admin', 'hr-docs/candidate/5/cv.pdf')).status, 200);
  assert.equal((await get(s, 'registrar', 'hr-docs/candidate/5/cv.pdf')).status, 403, 'без строки «Подбор» — нет');
  setGrant('view');
  assert.equal((await get(s, 'registrar', 'hr-docs/candidate/5/cv.pdf')).status, 200);
  assert.equal((await put(s, 'registrar', 'hr-docs/candidate/5/p.pdf')).status, 403, '«Просмотр» не загружает');
  setGrant('edit');
  assert.equal((await put(s, 'registrar', 'hr-docs/candidate/5/p.pdf')).status, 200);
  assert.equal((await put(s, 'registrar', 'hr-docs/staff/2/p.pdf')).status, 403, 'документы сотрудников — по-прежнему только администратору');
  assert.equal((await put(s, 'admin', 'hr-docs/candidate/x/p.pdf')).status, 400);
  assert.equal((await del(s, 'registrar', 'hr-docs/candidate/5/p.pdf')).status, 403);
  assert.equal((await get(s, 'doctor', 'hr-docs/candidate/5/cv.pdf')).status, 403);
});
