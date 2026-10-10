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
import { insertConnectionRow } from '../test-helpers/api-connection-row.js';   // CLINIC_API_STEP7_V1

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

// CLINIC_PROFILE_V1 (ревью M3) — ПРЕЖНИЙ ЛОГОТИП НЕ ЗАТИРАЕТСЯ НЕСКОПИРОВАННЫМ.
// Копия при запуске (services/clinic-logo-legacy.js) могла не лечь: диск,
// права, версия без разбора нужного варианта data URL. Поэтому /api/db
// кладёт копию ещё раз прямо перед тем, как правка заменит или снимет
// прежний логотип (квадратного ещё нет), а копия не легла — правка
// отклоняется 409 с переведённым объяснением: прежний логотип остаётся на
// бланках, новый не применён.
const LEGACY = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg"><text>OLD</text></svg>';
const PRINT_COPY = 'data:image/png;base64,UFJJTlQ=';
const legacyFiles = (t) => {
  const dir = path.join(t.dataDir, 'storage', 'clinic-logos', 'legacy');
  return fs.existsSync(dir) ? fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')) : [];
};
async function saver(t) {
  const cookie = await login(t.base, 'boss');
  return (values) => fetch(t.base + '/api/db', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ table: 'doc_settings', op: 'update', values, filters: [{ col: 'id', op: 'eq', val: 1 }] }) });
}

test('загрузка квадратного: прежний логотип, ещё не скопированный, ложится файлом до замены', async () => {
  const t = await setup();
  try {
    t.db.prepare('UPDATE doc_settings SET logo_data_url = ? WHERE id = 1').run(LEGACY);
    const save = await saver(t);
    const res = await save({ logo_square_path: 'square/1760000000000-ab12cd.png', logo_data_url: PRINT_COPY });
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
    assert.deepEqual(legacyFiles(t), ['<svg xmlns="http://www.w3.org/2000/svg"><text>OLD</text></svg>'], 'копия прежнего логотипа');
    assert.equal(t.db.prepare('SELECT logo_data_url FROM doc_settings').get().logo_data_url, PRINT_COPY);
  } finally { t.stop(); }
});

test('копия не легла (хранилище не пишется) — замена и «Удалить» отклоняются 409, прежний логотип на бланках', async () => {
  const { STRINGS } = await import('../../public/js/admin/i18n-strings.js');
  const t = await setup();
  try {
    t.db.prepare('UPDATE doc_settings SET logo_data_url = ? WHERE id = 1').run(LEGACY);
    fs.mkdirSync(path.join(t.dataDir, 'storage'), { recursive: true });
    fs.writeFileSync(path.join(t.dataDir, 'storage', 'clinic-logos'), 'x');   // на месте папки — файл
    const save = await saver(t);
    for (const values of [
      { logo_square_path: 'square/1760000000000-ab12cd.png', logo_data_url: PRINT_COPY },
      { logo_data_url: '' },
    ]) {
      const res = await save(values);
      assert.equal(res.status, 409, JSON.stringify(values));
      const { error } = await res.json();
      assert.equal(error.code, 'legacy_logo_not_saved');
      const e = STRINGS[error.message];
      assert.ok(e && e.uz && e.en, 'сообщение переведено: ' + error.message);
    }
    const row = t.db.prepare('SELECT logo_data_url, logo_square_path FROM doc_settings').get();
    assert.deepEqual({ ...row }, { logo_data_url: LEGACY, logo_square_path: '' }, 'строка не тронута');

    // Логотип не меняется — правке других полей копия не нужна.
    assert.equal((await save({ clinic_name: 'Шифо', logo_data_url: LEGACY })).status, 200);
    assert.equal((await save({ phone: '+998 71 000 00 00' })).status, 200);
  } finally { t.stop(); }
});

test('квадратный уже загружен — logo_data_url его копия: замена копии не требует сохранения', async () => {
  const t = await setup();
  try {
    t.db.prepare("UPDATE doc_settings SET logo_data_url = ?, logo_square_path = 'square/1-a.png' WHERE id = 1").run(PRINT_COPY);
    fs.mkdirSync(path.join(t.dataDir, 'storage'), { recursive: true });
    fs.writeFileSync(path.join(t.dataDir, 'storage', 'clinic-logos'), 'x');
    const save = await saver(t);
    const res = await save({ logo_square_path: 'square/2-b.png', logo_data_url: 'data:image/png;base64,TkVX' });
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  } finally { t.stop(); }
});

// CLINIC_API_STEP7_V1 — решение владельца 11: пока включено подключение API,
// «Компания» без адреса для партнёров не сохраняется (400 с полем); выключили —
// адрес снова необязателен.
test('/api/db: пока подключение API включено, «Компания» без улицы — 400 partner_address_required; выключено — 200', async () => {
  const t = await setup();
  try {
    t.db.prepare("UPDATE doc_settings SET region_code = 'tashkent-city', district_code = 'yunusobod', street_ru = 'ул. Мира, 1' WHERE id = 1").run();
    insertConnectionRow(t.db);
    const save = await saver(t);
    const bad = await save({ street_ru: '' });
    assert.equal(bad.status, 400);
    const { error } = await bad.json();
    assert.equal(error.code, 'partner_address_required');
    assert.equal(error.field, 'street_ru');
    assert.equal(t.db.prepare('SELECT street_ru FROM doc_settings WHERE id = 1').get().street_ru, 'ул. Мира, 1', 'строка не тронута');
    t.db.prepare('UPDATE api_connections SET active = 0').run();
    const ok = await save({ street_ru: '' });
    assert.equal(ok.status, 200, JSON.stringify(await ok.clone().json()));
  } finally { t.stop(); }
});

// CLINIC_API_STEP7_V1 (ревью №8) — здание, ставшее филиалом с подключением, оставленным
// включённым: адрес для партнёров там не требуется (подключений в филиале нет, а
// выключить его отсюда нельзя — 409 «настраиваются в главном здании»).
// Слияние с шагом 4 (BRANCH_PROFILE_V1): адрес для партнёров и карту филиала ведёт
// главное здание в «Филиалах» — их правка в «Компании» филиала — 409 шага 4, а не
// отказ «адрес обязателен»; адрес, телефон и почта для документов сохраняются и
// при пустом адресе для партнёров.
test('/api/db в филиале: подключение осталось включённым — адрес для партнёров не требуется; документы сохраняются, партнёрские поля — 409 шага 4', async () => {
  const { becomeSecondary } = await import('../services/branch-sync/identity.js');
  const t = await setup();
  try {
    insertConnectionRow(t.db);
    becomeSecondary(t.db, { letter: 'C', name: 'Филиал' });
    t.db.prepare("UPDATE doc_settings SET region_code = '', district_code = '', street_ru = '', street_uz = '', street_en = '' WHERE id = 1").run();
    const save = await saver(t);
    const res = await save({ address: 'Ташкент, Чиланзар, 5', email: 'chilanzar@shifo.uz' });
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
    assert.equal(t.db.prepare('SELECT address FROM doc_settings WHERE id = 1').get().address, 'Ташкент, Чиланзар, 5');
    const partner = await save({ street_ru: 'ул. Новая, 2' });
    const { error } = await partner.json();
    assert.equal(partner.status, 409, JSON.stringify(error));
    assert.equal(error.code, 'conflict', 'партнёрские поля филиала — отказ шага 4, а не «адрес обязателен»');
  } finally { t.stop(); }
});
