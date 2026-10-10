// CLINIC_PROFILE_V1 — договор «Компании» с базой: пустая строка проходит, null — нет.
//
// doc_settings.logo_data_url — TEXT NOT NULL DEFAULT '' (миграция 008). Экран
// «Компания» слал null у клиники без логотипа и после «Удалить логотип», и
// /api/db отвечал 400 «Не заполнено обязательное поле doc_settings.logo_data_url.».
// Поддельные серверы тестов экрана null принимали, поэтому ошибку не ловили.
// Здесь — настоящее приложение по HTTP: «нет логотипа» — это ''.

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

const mkUser = (db, username, name, role) => db
  .prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)')
  .run(username, hashPassword('password1'), name, role).lastInsertRowid;

async function setup() {
  const dataDir = licensedDataDir();
  const db = openDb(path.join(dataDir, 'easymed.db'));
  migrate(db);
  mkUser(db, 'boss', 'Главврач Каримов', 'admin');
  const server = await listen(createApp(db, { dataDir }));
  return {
    db, server, base: `http://127.0.0.1:${server.address().port}`,
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

test('doc_settings: logo_data_url = "" сохраняется, null — 400 с названием колонки', async () => {
  const t = await setup();
  try {
    const cookie = await login(t.base, 'boss');
    const save = (values) => fetch(t.base + '/api/db', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ table: 'doc_settings', op: 'update', values, filters: [{ col: 'id', op: 'eq', val: 1 }] }) });
    assert.equal((await save({ clinic_name: 'Шифо', logo_data_url: '' })).status, 200);
    const bad = await save({ clinic_name: 'Шифо', logo_data_url: null });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error.message, /logo_data_url/);
  } finally { t.stop(); }
});

// CLINIC_PROFILE_V1 (ревью I2) — CHECK миграции 240 — запасной замок; первый —
// /api/db: те же строгие правила, что у экрана (shared/clinic-profile.js
// storedProfileProblems), с понятным переведённым отказом 400.
test('/api/db: путь логотипа с «..», разметка в сайте, чужой хост карты, неприведённые имена — 400, база не тронута', async () => {
  const { STRINGS } = await import('../../public/js/admin/i18n-strings.js');
  const t = await setup();
  try {
    const cookie = await login(t.base, 'boss');
    const save = (values) => fetch(t.base + '/api/db', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ table: 'doc_settings', op: 'update', values, filters: [{ col: 'id', op: 'eq', val: 1 }] }) });
    const before = t.db.prepare('SELECT * FROM doc_settings WHERE id = 1').get();
    for (const values of [
      { logo_square_path: 'square/../../clinic-docs/patients/1/docs/scan.png' },
      { logo_portrait_path: 'portrait/../x.png' },
      { website: 'https://a.uz/"><script>alert(1)</script>' },
      { maps_url: 'https://yandex.evil.com/maps' },
      { telegram_bot: 't.me/klinika_bot' },
      { instagram: '@a b' },
      { clinic_name: 'Шифо', website: 'https://a.uz/<b>' },
    ]) {
      const res = await save(values);
      assert.equal(res.status, 400, JSON.stringify(values));
      const { error } = await res.json();
      assert.equal(error.code, 'bad_request');
      const e = STRINGS[error.message];
      assert.ok(e && e.uz && e.en, 'сообщение переведено: ' + error.message);
    }
    assert.deepEqual(t.db.prepare('SELECT * FROM doc_settings WHERE id = 1').get(), before, 'ни одна запись не прошла');

    const ok = await save({ clinic_name: 'Шифо', website: 'https://shifo.uz', telegram_bot: '@shifo_clinic_bot', instagram: '@shifo.uz',
      maps_url: 'https://yandex.uz/maps/-/CDabc', logo_square_path: 'square/1760000000000-ab12cd.png' });
    assert.equal(ok.status, 200, JSON.stringify(await ok.clone().json()));
  } finally { t.stop(); }
});
