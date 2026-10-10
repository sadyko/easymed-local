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
