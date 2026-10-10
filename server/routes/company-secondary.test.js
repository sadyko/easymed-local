// CLINIC_PROFILE_V1 — «КОМПАНИЯ» В ФИЛИАЛЕ: общее для клиники приходит из
// главного здания и здесь не правится; адрес, телефон, почта и карта — свои.
//
// Общее (название, описание, логотипы, сайт и соцсети, лицензия, цвет —
// shared/clinic-profile.js COMPANY_CLINIC_WIDE) едет из главного здания
// справочником (branch-sync/catalogue.js), и правка в филиале откатилась бы
// ближайшей синхронизацией — тот же призрак, что закрывает 409 у
// MAIN_CLINIC_TABLES. Отказ — только если общее поле МЕНЯЕТСЯ: прежний экран,
// приславший название как было, сохраняет адрес и телефон своего здания.
//
// BRANCH_PROFILE_V1 (шаг 4) — адрес для партнёров (коды, улица) и карту
// филиала ведёт главное здание в «Филиалах» (одно место на здание): в
// «Компании» филиала они только видны. Своё — адрес, телефон и почта для
// документов этого здания.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { hashPassword } from '../services/auth.js';
import { createApp } from '../app.js';
import { licensedDataDir } from '../services/control/licensed-fixture.js';
import { becomeSecondary } from '../services/branch-sync/identity.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';
import { STRINGS } from '../../public/js/admin/i18n-strings.js';
import { BRANCH_MESSAGES } from '../../public/js/shared/branch-profile.js';   // BRANCH_PROFILE_V1

const COMPANY_MAIN_ONLY = 'Название, описание, логотипы, сайт и соцсети, лицензия и фирменный цвет меняются в главном здании. Здесь — адрес, телефон и почта для документов этого здания.';   // BRANCH_PROFILE_V1

async function startServer({ secondary = false } = {}) {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("UPDATE doc_settings SET clinic_name = 'Клиника Луч', name_uz = 'Luch klinikasi' WHERE id = 1").run();
  if (secondary) becomeSecondary(db, { letter: 'C', name: 'Чиланзар' });
  db.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)')
    .run('boss', hashPassword('password1'), 'Boss', 'admin');
  const server = await listen(createApp(db, { dataDir: licensedDataDir() }));
  return { db, server, base: `http://127.0.0.1:${server.address().port}`, stop() { server.close(); db.close(); } };
}

async function loginAs(base) {
  const res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'boss', password: 'password1' }) });
  return res.headers.get('set-cookie').split(';')[0];
}
const save = (base, cookie, values) => fetch(base + '/api/db', { method: 'POST',
  headers: { 'Content-Type': 'application/json', Cookie: cookie },
  body: JSON.stringify({ table: 'doc_settings', op: 'update', values, filters: [{ col: 'id', op: 'eq', val: 1 }] }) });
const row = (db) => db.prepare('SELECT * FROM doc_settings WHERE id = 1').get();

test('филиал: общее для клиники не меняется — 409 с объяснением; база не тронута', async () => {
  const t = await startServer({ secondary: true });
  try {
    const cookie = await loginAs(t.base);
    for (const values of [
      { clinic_name: 'Другое' },
      { name_uz: 'Boshqa' },
      { website: 'https://other.uz' },
      { logo_square_path: 'square/1-a.png' },
      { license: 'LIC-1', address: 'ул. Филиальная, 7' },
    ]) {
      const res = await save(t.base, cookie, values);
      assert.equal(res.status, 409, JSON.stringify(values));
      const { error } = await res.json();
      assert.equal(error.code, 'conflict');
      assert.equal(error.message, COMPANY_MAIN_ONLY);
    }
    const r = row(t.db);
    assert.deepEqual([r.clinic_name, r.name_uz, r.website, r.logo_square_path, r.license, r.address],
      ['Клиника Луч', 'Luch klinikasi', '', '', '', '']);
  } finally { t.stop(); }
});

test('филиал: адрес, телефон и почта для документов сохраняются', async () => {
  const t = await startServer({ secondary: true });
  try {
    const cookie = await loginAs(t.base);
    const res = await save(t.base, cookie, { address: 'ул. Филиальная, 7', phone: '+998901112233', email: 'c@luch.uz' });
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
    const r = row(t.db);
    assert.deepEqual([r.address, r.phone, r.email], ['ул. Филиальная, 7', '+998901112233', 'c@luch.uz']);
  } finally { t.stop(); }
});

// BRANCH_PROFILE_V1 — адрес филиала для партнёров ведёт главное здание в «Филиалах» (одно место на здание).
test('филиал: коды, улица и карта в «Компании» — 409; неизменённые — не мешают', async () => {
  const t = await startServer({ secondary: true });
  try {
    const cookie = await loginAs(t.base);
    for (const values of [{ region_code: 'tashkent-city' }, { street_ru: 'ул. Филиальная, 7' }, { maps_url: 'https://yandex.uz/maps/-/CDbranch' },
      { country_code: 'UZ' }, { street_en: '7 Filial St' }]) {
      const res = await save(t.base, cookie, values);
      assert.equal(res.status, 409, JSON.stringify(values));
      assert.equal((await res.json()).error.message, BRANCH_MESSAGES.partnerInBranches);
    }
    const r = row(t.db);
    assert.deepEqual([r.region_code, r.street_ru, r.maps_url], ['', '', ''], 'база не тронута');
    const ok = await save(t.base, cookie, { street_ru: '', address: 'ул. Филиальная, 8' });
    assert.equal(ok.status, 200, 'улица как была (пусто) — не отказ');
    assert.equal(row(t.db).address, 'ул. Филиальная, 8');
  } finally { t.stop(); }
});

test('главное здание: адрес для партнёров и карта своего здания — в «Компании», как в шаге 3', async () => {
  const t = await startServer();
  try {
    const cookie = await loginAs(t.base);
    const res = await save(t.base, cookie, { region_code: 'tashkent-city', district_code: 'chilonzor', street_ru: 'ул. Мира, 1',
      maps_url: 'https://yandex.uz/maps/-/CDmain' });
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
    assert.equal(row(t.db).street_ru, 'ул. Мира, 1');
  } finally { t.stop(); }
});

test('филиал: общее прислано как было (прежний экран) — адрес сохраняется', async () => {
  const t = await startServer({ secondary: true });
  try {
    const cookie = await loginAs(t.base);
    const cur = row(t.db);
    const res = await save(t.base, cookie, { clinic_name: cur.clinic_name, name_uz: cur.name_uz, license: cur.license,
      logo_data_url: cur.logo_data_url, accent_color: cur.accent_color, address: 'X' });
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
    assert.equal(row(t.db).address, 'X');
  } finally { t.stop(); }
});

test('главное здание: общее меняется как обычно', async () => {
  const t = await startServer();
  try {
    const cookie = await loginAs(t.base);
    const res = await save(t.base, cookie, { clinic_name: 'Другое', website: 'https://luch.uz', logo_square_path: 'square/1-a.png' });
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
    assert.equal(row(t.db).clinic_name, 'Другое');
  } finally { t.stop(); }
});

test('сообщение филиала переведено на ru / uz / en', () => {
  const e = STRINGS[COMPANY_MAIN_ONLY];
  assert.ok(e && e.ru && e.uz && e.en);
});
