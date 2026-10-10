// CLINIC_PROFILE_V1 — КОРЗИНА ЛОГОТИПОВ КЛИНИКИ (clinic-logos).
//
// Договор корзины, по HTTP через настоящее приложение:
//   • путь — ровно clinic-logos/<square|portrait>/<ключ>.png: вид логотипа —
//     в пути, правило «квадратный — квадратный» проверяется по месту, куда
//     файл ложится; legacy/ пишет только сервер (services/clinic-logo-legacy.js);
//   • пишет администратор или тот, кому выдано «Компания: Изменение»;
//   • PNG с прозрачностью, размеры и вес — те же правила, что у экрана
//     (shared/clinic-logo-rules.js); отказ несёт шаблон и подстановки;
//   • перезаписи нет, DELETE — 403, файл остаётся (Р7);
//   • в филиале запись — 409: логотипы — главного здания;
//   • читает любой вошедший — логотип печатается на бланках.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { hashPassword } from '../services/auth.js';
import { createApp } from '../app.js';
import { licensedDataDir } from '../services/control/licensed-fixture.js';
import { becomeSecondary } from '../services/branch-sync/identity.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';
import { fakePng } from '../test-helpers/fake-png.js';
import { STRINGS } from '../../public/js/admin/i18n-strings.js';

const mkUser = (db, username, name, role) => db
  .prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)')
  .run(username, hashPassword('password1'), name, role).lastInsertRowid;

async function setup({ secondary = false } = {}) {
  const dataDir = licensedDataDir();
  const db = openDb(path.join(dataDir, 'easymed.db'));
  migrate(db);
  if (secondary) becomeSecondary(db, { letter: 'C', name: 'Чиланзар' });
  mkUser(db, 'boss', 'Главврач Каримов', 'admin');
  mkUser(db, 'reg', 'Регистратор Ли', 'registrar');
  mkUser(db, 'lab', 'Лаборант Юсупов', 'lab');
  const server = await listen(createApp(db, { dataDir }));
  return {
    db, server, dataDir, base: `http://127.0.0.1:${server.address().port}`,
    stop() { server.close(); db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); },
  };
}

async function login(base, username) {
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'password1' }),
  });
  assert.equal(res.status, 200, 'вход ' + username);
  return (res.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
}

// Как «Настройки → Роли»: ключи в role_permissions.permissions.grants.
function addGrants(db, role, grants) {
  const row = db.prepare('SELECT permissions FROM role_permissions WHERE role = ?').get(role);
  const perms = row ? JSON.parse(row.permissions) : { sections: [], levels: {} };
  perms.grants = { ...(perms.grants || {}), ...grants };
  if (row) db.prepare('UPDATE role_permissions SET permissions = ? WHERE role = ?').run(JSON.stringify(perms), role);
  else db.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?)').run(role, JSON.stringify(perms));
}

const url = (base, objPath) => base + '/api/storage/' + objPath.split('/').map(encodeURIComponent).join('/');
const put = (base, cookie, objPath, body, type = 'image/png') =>
  fetch(url(base, objPath), { method: 'POST', headers: { 'Content-Type': type, Cookie: cookie }, body });
const get = (base, cookie, objPath) => fetch(url(base, objPath), { headers: { Cookie: cookie } });
const del = (base, cookie, objPath) => fetch(url(base, objPath), { method: 'DELETE', headers: { Cookie: cookie } });
const onDisk = (s, rel) => path.join(s.dataDir, 'storage', 'clinic-logos', ...rel.split('/'));

test('администратор кладёт квадратный логотип; лаборант его читает — PNG внутри страницы', async () => {
  const s = await setup();
  try {
    const boss = await login(s.base, 'boss');
    const png = fakePng(512, 512);
    const up = await put(s.base, boss, 'clinic-logos/square/1-a.png', png);
    assert.equal(up.status, 200, JSON.stringify(await up.clone().json().catch(() => ({}))));
    assert.deepEqual((await up.json()).data, { path: 'square/1-a.png', size: png.length });
    assert.deepEqual(fs.readFileSync(onDisk(s, 'square/1-a.png')), png);

    const lab = await login(s.base, 'lab');
    const got = await get(s.base, lab, 'clinic-logos/square/1-a.png');
    assert.equal(got.status, 200);
    assert.equal(got.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await got.arrayBuffer()), png);

    const portrait = await put(s.base, boss, 'clinic-logos/portrait/1-a.png', fakePng(600, 800));
    assert.equal(portrait.status, 200, 'вертикальный — в свою папку');
  } finally { s.stop(); }
});

test('регистратура без «Компании» — 403; с «Компания: Изменение» — кладёт', async () => {
  const s = await setup();
  try {
    const reg = await login(s.base, 'reg');
    const no = await put(s.base, reg, 'clinic-logos/square/1-a.png', fakePng(512, 512));
    assert.equal(no.status, 403);
    assert.match((await no.json()).error.message, /Компании/);
    assert.equal(fs.existsSync(onDisk(s, 'square/1-a.png')), false);

    addGrants(s.db, 'registrar', { settings: 'edit', 'settings.company': 'edit' });
    const yes = await put(s.base, reg, 'clinic-logos/square/2-b.png', fakePng(512, 512));
    assert.equal(yes.status, 200, JSON.stringify(await yes.json().catch(() => ({}))));
  } finally { s.stop(); }
});

test('отказы правил: непрозрачный, не квадратный, не вертикальный, не PNG, больше 1 МБ — с шаблоном для перевода', async () => {
  const s = await setup();
  try {
    const boss = await login(s.base, 'boss');
    for (const [objPath, body, status, code] of [
      ['clinic-logos/square/a.png', fakePng(512, 512, { colorType: 2 }), 415, 'logo_not_transparent'],
      ['clinic-logos/square/b.png', fakePng(600, 500), 415, 'logo_not_square'],
      ['clinic-logos/portrait/c.png', fakePng(800, 600), 415, 'logo_not_portrait'],
      ['clinic-logos/square/x.jpg', fakePng(512, 512), 415, 'logo_not_png'],
      ['clinic-logos/square/d.png', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>                 '), 415, 'logo_not_png'],
      ['clinic-logos/square/e.png', fakePng(512, 512, { pad: 1024 * 1024 }), 413, 'file_too_large'],
      ['clinic-logos/square/f.png', fakePng(100, 100), 415, 'logo_bad_size'],
    ]) {
      const res = await put(s.base, boss, objPath, body);
      assert.equal(res.status, status, objPath);
      const { error } = await res.json();
      assert.equal(error.code, code, objPath);
      assert.ok(error.template && STRINGS[error.template], objPath + ': шаблон — статья словаря');
      assert.equal(typeof error.params, 'object');
      assert.ok(error.message && !/\{\w+\}/.test(error.message), objPath + ': подстановки сделаны');
      assert.equal(fs.existsSync(onDisk(s, objPath.replace('clinic-logos/', ''))), false, objPath + ': на диск не попал');
    }
  } finally { s.stop(); }
});

test('неверные пути — 400: чужая папка, лишний уровень, legacy/ (его пишет только сервер)', async () => {
  const s = await setup();
  try {
    const boss = await login(s.base, 'boss');
    for (const p of ['clinic-logos/round/a.png', 'clinic-logos/square/a/b.png', 'clinic-logos/legacy/x.png', 'clinic-logos/a.png']) {
      const res = await put(s.base, boss, p, fakePng(512, 512));
      assert.equal(res.status, 400, p);
    }
    assert.equal((await get(s.base, boss, 'clinic-logos/round/a.png')).status, 400, 'и на чтение');
  } finally { s.stop(); }
});

test('перезаписи нет — 409; DELETE — 403, файл на диске остаётся', async () => {
  const s = await setup();
  try {
    const boss = await login(s.base, 'boss');
    const png = fakePng(512, 512);
    assert.equal((await put(s.base, boss, 'clinic-logos/square/1-a.png', png)).status, 200);
    const again = await put(s.base, boss, 'clinic-logos/square/1-a.png', fakePng(600, 600));
    assert.equal(again.status, 409);
    assert.equal((await again.json()).error.code, 'file_exists');
    assert.deepEqual(fs.readFileSync(onDisk(s, 'square/1-a.png')), png, 'прежний файл не подменён');

    const d = await del(s.base, boss, 'clinic-logos/square/1-a.png');
    assert.equal(d.status, 403);
    assert.match((await d.json()).error.message, /не удаляется/);
    assert.ok(fs.existsSync(onDisk(s, 'square/1-a.png')), 'файл остался');
  } finally { s.stop(); }
});

test('филиал: логотипы — главного здания, запись — 409', async () => {
  const s = await setup({ secondary: true });
  try {
    const boss = await login(s.base, 'boss');
    const res = await put(s.base, boss, 'clinic-logos/square/1-a.png', fakePng(512, 512));
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error.message, 'Логотипы клиники меняются в главном здании.');
    assert.equal(fs.existsSync(onDisk(s, 'square/1-a.png')), false);
  } finally { s.stop(); }
});

test('сообщения корзины переведены на ru / uz / en', () => {
  for (const m of [
    'Логотипы клиники меняет администратор или тот, кому выдано изменение «Компании».',
    'Логотипы клиники меняются в главном здании.',
    'Логотип не удаляется — новая загрузка заменяет прежний, а «Удалить» в «Компании» снимает его с бланков.',
  ]) {
    const e = STRINGS[m];
    assert.ok(e && e.ru && e.uz && e.en, 'нет статьи: ' + m);
  }
});
