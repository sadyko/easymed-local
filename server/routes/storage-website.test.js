// WEBSITE_V1, этап 2 — корзина `website`: картинки сайта кладёт и удаляет только
// «Веб-сайт: Изменение» при модуле лицензии website; только JPG/PNG/WEBP.
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

const ROLES = ['admin', 'registrar', 'doctor', 'callcenter'];

function grant(db, role, lvl) {
  db.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?) ON CONFLICT(role) DO UPDATE SET permissions = excluded.permissions')
    .run(role, JSON.stringify({ ...JSON.parse(db.prepare('SELECT permissions FROM role_permissions WHERE role = ?').get(role)?.permissions || '{}'), grants: { commerce_website: lvl } }));
}

async function start(t, modules = ['website']) {
  const db = openDb(':memory:');
  migrate(db);
  const pw = hashPassword('password1');
  for (const r of ROLES) db.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)').run(r, pw, r, r);
  grant(db, 'doctor', 'view');
  grant(db, 'callcenter', 'edit');
  const dataDir = licensedDataDir({ modules });
  const server = await listen(createApp(db, { dataDir }));
  t.after(() => { server.close(); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = {};
  for (const r of ROLES) {
    const res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: r, password: 'password1' }) });
    cookie[r] = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  }
  return { db, base, cookie, storage: path.join(dataDir, 'storage') };
}

const put = (s, who, obj, body = 'img') => fetch(s.base + '/api/storage/' + obj,
  { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', Cookie: s.cookie[who] }, body: Buffer.from(body) });
const del = (s, who, obj) => fetch(s.base + '/api/storage/' + obj, { method: 'DELETE', headers: { Cookie: s.cookie[who] } });
const get = (s, who, obj) => fetch(s.base + '/api/storage/' + obj, { headers: { Cookie: s.cookie[who] } });

test('загрузка: без права — 403, «Просмотр» — 403, «Изменение» и администратор — 200', async (t) => {
  const s = await start(t);
  assert.equal((await put(s, 'registrar', 'website/services/a.jpg')).status, 403, 'строка не настроена — только администратор');
  const view = await put(s, 'doctor', 'website/services/a.jpg');
  assert.equal(view.status, 403);
  assert.match((await view.json()).error.message, /Веб-сайт: Изменение/);
  assert.equal((await put(s, 'callcenter', 'website/services/a.jpg')).status, 200);
  assert.equal((await put(s, 'admin', 'website/services/b.webp')).status, 200);
  assert.ok(fs.existsSync(path.join(s.storage, 'website', 'services', 'a.jpg')));
  // чтение через /api/storage — как у других корзин
  assert.equal((await get(s, 'registrar', 'website/services/a.jpg')).status, 200);
});

test('тип: .svg и .pdf — 415, png/jpeg/webp — да', async (t) => {
  const s = await start(t);
  for (const bad of ['x.svg', 'x.pdf', 'x.gif', 'x.html']) {
    const res = await put(s, 'callcenter', 'website/' + bad);
    assert.equal(res.status, 415, bad);
    assert.match((await res.json()).error.message, /JPG, PNG и WEBP/);
  }
  for (const ok of ['x.png', 'x.jpeg', 'X.JPG', 'x.webp']) assert.equal((await put(s, 'callcenter', 'website/' + ok)).status, 200, ok);
});

test('удаление: тот же замок, что у загрузки', async (t) => {
  const s = await start(t);
  assert.equal((await put(s, 'admin', 'website/a.png')).status, 200);
  assert.equal((await del(s, 'doctor', 'website/a.png')).status, 403);
  assert.equal((await del(s, 'registrar', 'website/a.png')).status, 403);
  assert.ok(fs.existsSync(path.join(s.storage, 'website', 'a.png')));
  assert.equal((await del(s, 'callcenter', 'website/a.png')).status, 200);
  assert.ok(!fs.existsSync(path.join(s.storage, 'website', 'a.png')));
});

test('без модуля website — 402 module_missing даже у администратора', async (t) => {
  const s = await start(t, []);
  const up = await put(s, 'admin', 'website/a.png');
  assert.equal(up.status, 402);
  assert.equal((await up.json()).error.code, 'module_missing');
  assert.equal((await del(s, 'admin', 'website/a.png')).status, 402);
});
