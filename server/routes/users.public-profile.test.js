// DOCTOR_PUBLIC_PROFILE_V1 — публичный профиль врача хранится офлайн (мигр. 159)
// и читается обратно: врач пишет его в «Моём профиле» (update_my_doctor_profile),
// админ видит и правит его в карточке сотрудника (PATCH /api/users/:id,
// { public_profile }), экраны читают колонки через реестр. Владелец: «we need to
// add them for building a proper API for partners».

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { hashPassword } from '../services/auth.js';
import { createApp } from '../app.js';
import { licensedDataDir } from '../services/control/licensed-fixture.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';
import { updateMyDoctorProfile } from '../services/rpc/doctor-profile.js';
import { readableColumns } from '../db/schema-registry.js';
import { TABLES as CATALOGUE_TABLES } from '../services/branch-sync/catalogue.js';

async function startServer() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)')
    .run('boss', hashPassword('password1'), 'Boss', 'admin');
  const docId = db.prepare("INSERT INTO users (username, password_hash, full_name, role, is_doctor) VALUES ('doc', 'x', 'Врач', 'doctor', 1)").run().lastInsertRowid;
  const server = await listen(createApp(db, { dataDir: licensedDataDir() }));
  return { db, server, base: `http://127.0.0.1:${server.address().port}`, docId };
}
const req = (base, method, path, body, cookie) => fetch(base + path, {
  method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
  body: body ? JSON.stringify(body) : undefined,
});
async function loginAdmin(base) {
  const res = await req(base, 'POST', '/api/auth/login', { username: 'boss', password: 'password1' });
  return res.headers.get('set-cookie').split(';')[0];
}

test('врач сохранил профиль — карточка сотрудника отдаёт его (списки массивами); админ правит, не стирая остального', async () => {
  const { db, server, base, docId } = await startServer();
  try {
    updateMyDoctorProfile(db, { p: {
      bio_ru: 'Кардиолог', academic_title_ru: 'Кандидат медицинских наук', experience_years: 12,
      education_entries: [{ ru: 'ТашМИ', year_from: '1995', year_to: '2001' }],
      photo_url: '/api/storage/doctor-photos/doctors/2/a.jpg',
    } }, { id: docId, role: 'doctor' });
    const admin = await loginAdmin(base);
    const list = await (await req(base, 'GET', '/api/users', null, admin)).json();
    const card = (list.users || list).find((u) => u.id === docId);
    assert.equal(card.public_profile.bio_ru, 'Кардиолог');
    assert.equal(card.public_profile.experience_years, 12);
    assert.deepEqual(card.public_profile.education_entries, [{ ru: 'ТашМИ', year_from: '1995', year_to: '2001' }]);
    assert.equal(card.public_profile.photo_url, '/api/storage/doctor-photos/doctors/2/a.jpg');

    const res = await req(base, 'PATCH', '/api/users/' + docId, { public_profile: { bio_uz: 'Kardiolog', telegram_url: 'https://t.me/doc' } }, admin);
    assert.equal(res.status, 200, await res.clone().text());
    const row = db.prepare('SELECT bio_ru, bio_uz, telegram_url, education_entries FROM users WHERE id = ?').get(docId);
    assert.equal(row.bio_ru, 'Кардиолог', 'не присланное — не тронуто');
    assert.equal(row.bio_uz, 'Kardiolog');
    assert.equal(row.telegram_url, 'https://t.me/doc');
    assert.deepEqual(JSON.parse(row.education_entries), [{ ru: 'ТашМИ', year_from: '1995', year_to: '2001' }]);

    const bad = await req(base, 'PATCH', '/api/users/' + docId, { public_profile: { instagram_url: 'javascript:alert(1)' } }, admin);
    assert.equal(bad.status, 400, 'те же проверки, что у «Моего профиля»');
    const bad2 = await req(base, 'PATCH', '/api/users/' + docId, { public_profile: { role: 'admin' } }, admin);
    assert.equal(bad2.status, 400, 'ключ вне белого списка');
    assert.equal(db.prepare('SELECT role FROM users WHERE id = ?').get(docId).role, 'doctor');
  } finally { server.close(); db.close(); }
});

test('реестр читает поля профиля; филиалы получают их со справочником сотрудников, кроме фото', () => {
  const cols = readableColumns('users');
  for (const k of ['bio_ru', 'bio_uz', 'bio_en', 'academic_title_ru', 'education_entries', 'experience_years', 'instagram_url', 'photo_url']) {
    assert.ok(cols.includes(k), k);
  }
  const spec = CATALOGUE_TABLES.find((t) => t.name === 'users');
  assert.ok(spec.columns.includes('bio_ru') && spec.columns.includes('prof_dev_entries'));
  assert.ok(!spec.columns.includes('photo_url'), 'файл фото между зданиями не ездит — ссылка была бы мёртвой');
});
