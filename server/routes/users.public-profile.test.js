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
import { readableColumns, REGISTRY } from '../db/schema-registry.js';
import { TABLES as CATALOGUE_TABLES } from '../services/branch-sync/catalogue.js';
import { DOCTOR_PUBLIC_MESSAGES } from '../../public/js/shared/doctor-public.js';   // DOCTOR_PROFILE_V1
import { PROFILE_LINK_MESSAGES } from '../services/rpc/doctor-profile.js';   // DOCTOR_PROFILE_V1 (ревью шага 5, №11)

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
      // CLINIC_API_FIX_V1 — фото только из папки самого врача: путь строится от его id.
      photo_url: '/api/storage/doctor-photos/doctors/' + docId + '/a.jpg',
    } }, { id: docId, role: 'doctor' });
    const admin = await loginAdmin(base);
    const list = await (await req(base, 'GET', '/api/users', null, admin)).json();
    const card = (list.users || list).find((u) => u.id === docId);
    assert.equal(card.public_profile.bio_ru, 'Кардиолог');
    assert.equal(card.public_profile.experience_years, 12);
    assert.deepEqual(card.public_profile.education_entries, [{ ru: 'ТашМИ', year_from: '1995', year_to: '2001' }]);
    assert.equal(card.public_profile.photo_url, '/api/storage/doctor-photos/doctors/' + docId + '/a.jpg');

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

// ---------------------------------------------------------------------------
// CLINIC_API_FIX_V1 — ФОТО ВРАЧА ТОЛЬКО ИЗ ЕГО ПАПКИ — и в карточке сотрудника.
// «Мой профиль» это уже требует (rpc/doctor-profile.js); PATCH /api/users/:id
// принимал любую папку корзины doctor-photos, то есть фото врача Y можно было
// поставить врачу X. Новому сотруднику (POST) фото не ставится вовсе: папки
// doctors/0/ не бывает (routes/storage.js photoTarget требует id > 0), а своей
// папки у него ещё нет.
// ---------------------------------------------------------------------------
const OWN_PHOTO_MSG = 'Поставить можно только своё фото — загруженное в «Моём профиле».';

test('CLINIC_API_FIX_V1: карточка сотрудника — фото врача только из его папки; новому сотруднику фото не ставится', async () => {
  const { db, server, base, docId } = await startServer();
  try {
    const otherId = db.prepare("INSERT INTO users (username, password_hash, full_name, role, is_doctor) VALUES ('doc2', 'x', 'Врач Два', 'doctor', 1)").run().lastInsertRowid;
    const P = '/api/storage/doctor-photos/doctors/';
    const admin = await loginAdmin(base);

    const foreign = await req(base, 'PATCH', '/api/users/' + docId, { public_profile: { photo_url: P + otherId + '/a.jpg' } }, admin);
    assert.equal(foreign.status, 400, 'фото другого врача принято');
    assert.equal((await foreign.json()).error.message, OWN_PHOTO_MSG);
    assert.equal(db.prepare('SELECT photo_url FROM users WHERE id = ?').get(docId).photo_url, null);

    const own = await req(base, 'PATCH', '/api/users/' + docId, { public_profile: { photo_url: P + docId + '/a.jpg' } }, admin);
    assert.equal(own.status, 200, await own.clone().text());
    assert.equal(db.prepare('SELECT photo_url FROM users WHERE id = ?').get(docId).photo_url, P + docId + '/a.jpg');

    const created = await req(base, 'POST', '/api/users', { username: 'newdoc', password: 'password9', full_name: 'Новый врач', role: 'doctor',
      public_profile: { photo_url: P + docId + '/a.jpg' } }, admin);
    assert.equal(created.status, 400, 'новому сотруднику поставлено чужое фото');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM users WHERE username = 'newdoc'").get().n, 0);
    const plain = await req(base, 'POST', '/api/users', { username: 'newdoc', password: 'password9', full_name: 'Новый врач', role: 'doctor',
      public_profile: { bio_ru: 'Терапевт' } }, admin);
    assert.equal(plain.status, 201, 'остальной профиль при создании сохраняется: ' + await plain.clone().text());
  } finally { server.close(); db.close(); }
});

// CLINIC_API_FIX_V1 — «Мой профиль» читает is_local, чтобы врач из главного
// здания сразу видел, что здесь профиль только смотрят. Колонка — только для
// чтения: пишут её синхронизация справочника и миграция 086, не /api/db.
test('CLINIC_API_FIX_V1: is_local читается через реестр, но не пишется', () => {
  assert.ok(readableColumns('users').includes('is_local'));
  const w = REGISTRY.users.write;
  assert.deepEqual([w.insert.roles, w.update.roles, w.delete.roles], [[], [], []]);
});

// ===========================================================================
// DOCTOR_PROFILE_V1 (мигр. 243) — показ врача на сайте и у партнёров меняет
// только администратор; показываемый — с ФИО на русском и специальностью;
// срок записи — 7/14/30; «работает с» пишет и стаж; карточка всё это отдаёт.
// ===========================================================================
function addGrants(db, role, grants) {
  const row = db.prepare('SELECT permissions FROM role_permissions WHERE role = ?').get(role);
  const perms = row ? JSON.parse(row.permissions) : { sections: [], levels: {} };
  perms.grants = { ...(perms.grants || {}), ...grants };
  if (row) db.prepare('UPDATE role_permissions SET permissions = ? WHERE role = ?').run(JSON.stringify(perms), role);
  else db.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?)').run(role, JSON.stringify(perms));
}
async function loginAs(base, username) {
  const res = await req(base, 'POST', '/api/auth/login', { username, password: 'password1' });
  return res.headers.get('set-cookie').split(';')[0];
}

test('DOCTOR_PROFILE_V1: без ФИО на русском и специальности врача не показать; с ними — показ включается; стереть их у показываемого нельзя', async () => {
  const { db, server, base, docId } = await startServer();
  try {
    const admin = await loginAdmin(base);
    const patch = (body) => req(base, 'PATCH', '/api/users/' + docId, body, admin);
    let res = await patch({ is_public: true });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.message, DOCTOR_PUBLIC_MESSAGES.nameRu);
    res = await patch({ is_public: true, public_profile: { full_name_ru: 'Иванов Иван' } });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.message, DOCTOR_PUBLIC_MESSAGES.specialty);
    assert.equal(db.prepare('SELECT is_public FROM users WHERE id = ?').get(docId).is_public, 0, 'отказ ничего не пишет');
    res = await patch({ is_public: true, public_profile: { full_name_ru: 'Иванов Иван' }, specialties: [{ name: 'Кардиолог', slug: 'kardiolog' }] });
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal((await res.json()).user.is_public, true);
    res = await patch({ public_profile: { full_name_ru: '' } });
    assert.equal(res.status, 400, 'показываемому нельзя стереть ФИО на русском');
    res = await patch({ specialties: [] });
    assert.equal(res.status, 400, 'и все специальности');
    res = await patch({ salary_fixed: 3000000 });
    assert.equal(res.status, 200, 'проверка не держит сохранение оклада');
  } finally { server.close(); db.close(); }
});

test('DOCTOR_PROFILE_V1: показ меняет только администратор — «Сотрудники: Изменение» получает 403; неизменённое проходит', async () => {
  const { db, server, base, docId } = await startServer();
  try {
    db.prepare("INSERT INTO users (username, password_hash, full_name, role, is_doctor) VALUES ('chief', ?, 'Главврач', 'doctor', 1)").run(hashPassword('password1'));
    addGrants(db, 'doctor', { settings: 'view', 'settings.employees': 'edit' });
    const chief = await loginAs(base, 'chief');
    let res = await req(base, 'PATCH', '/api/users/' + docId, { is_public: true }, chief);
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error.message, DOCTOR_PUBLIC_MESSAGES.adminOnly);
    res = await req(base, 'PATCH', '/api/users/' + docId, { is_public: false, booking_days: 30 }, chief);
    assert.equal(res.status, 200, 'значение не меняется — не отказ; срок записи правит и не администратор');
    assert.equal(db.prepare('SELECT booking_days, is_public FROM users WHERE id = ?').get(docId).booking_days, 30);
  } finally { server.close(); db.close(); }
});

test('DOCTOR_PROFILE_V1: срок записи 7/14/30, отметки — да/нет, языки, «работает с»; карточка отдаёт их', async () => {
  const { db, server, base, docId } = await startServer();
  try {
    const admin = await loginAdmin(base);
    const patch = (body) => req(base, 'PATCH', '/api/users/' + docId, body, admin);
    for (const [body, msg] of [
      [{ booking_days: 10 }, DOCTOR_PUBLIC_MESSAGES.bookingDays], [{ show_queue_count: 1 }, DOCTOR_PUBLIC_MESSAGES.flag],
      [{ is_public: 'да' }, DOCTOR_PUBLIC_MESSAGES.flag], [{ public_profile: { languages: [] } }, DOCTOR_PUBLIC_MESSAGES.oneLanguage],
      [{ public_profile: { practice_since: 1800 } }, DOCTOR_PUBLIC_MESSAGES.since],
    ]) {
      const res = await patch(body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal((await res.json()).error.message, msg);
    }
    const year = new Date().getFullYear();
    const res = await patch({ booking_days: 7, show_queue_count: true, public_profile: { practice_since: year - 6, languages: ['uz', 'ru'] } });
    assert.equal(res.status, 200, await res.clone().text());
    const row = db.prepare('SELECT booking_days, show_queue_count, practice_since, experience_years, languages FROM users WHERE id = ?').get(docId);
    assert.deepEqual({ ...row }, { booking_days: 7, show_queue_count: 1, practice_since: year - 6, experience_years: 6, languages: '["ru","uz"]' });
    const list = await (await req(base, 'GET', '/api/users', null, admin)).json();
    const card = list.users.find((u) => u.id === docId);
    assert.deepEqual([card.is_public, card.booking_days, card.show_queue_count], [false, 7, true]);
    assert.deepEqual(card.public_profile.languages, ['ru', 'uz']);
    assert.equal(card.public_profile.practice_since, year - 6);
  } finally { server.close(); db.close(); }
});

// DOCTOR_PROFILE_V1 (ревью шага 5, укрепление) — одно прежнее поле specialty
// (без списка specialties) тоже проверяется: показываемый врач без строк
// списка не остаётся без специальности. Считается как specialtyCountOf:
// строки списка, а без них — текст (новый, если прислан).
test('DOCTOR_PROFILE_V1: показываемому врачу не стереть специальность и прежним полем specialty; строки списка его держат', async () => {
  const { db, server, base, docId } = await startServer();
  try {
    const admin = await loginAdmin(base);
    const patch = (body) => req(base, 'PATCH', '/api/users/' + docId, body, admin);
    db.prepare("UPDATE users SET is_public = 1, full_name_ru = 'Иванов Иван', specialty = 'Кардиолог' WHERE id = ?").run(docId);
    let res = await patch({ specialty: '' });
    assert.equal(res.status, 400, 'строк списка нет — пустой текст оставил бы врача без специальности');
    assert.equal((await res.json()).error.message, DOCTOR_PUBLIC_MESSAGES.specialty);
    assert.equal(db.prepare('SELECT specialty FROM users WHERE id = ?').get(docId).specialty, 'Кардиолог', 'отказ ничего не пишет');
    res = await patch({ specialty: 'Терапевт' });
    assert.equal(res.status, 200, await res.clone().text());
    db.prepare("INSERT INTO user_specialties (user_id, specialty_slug, name_ru, is_primary) VALUES (?, 'kardiolog', 'Кардиолог', 1)").run(docId);
    res = await patch({ specialty: '' });
    assert.equal(res.status, 200, 'строка списка есть — специальность у врача остаётся');
    res = await req(base, 'POST', '/api/users', { username: 'newdoc', password: 'password9', role: 'doctor', is_public: true,
      public_profile: { full_name_ru: 'Петров Пётр' }, specialty: 'Невролог' }, admin);
    assert.equal(res.status, 201, 'новый с текстом специальности — как specialtyCountOf: ' + await res.clone().text());
    res = await req(base, 'POST', '/api/users', { username: 'newdoc2', password: 'password9', role: 'doctor', is_public: true,
      public_profile: { full_name_ru: 'Сидоров Сидор' }, specialty: '  ' }, admin);
    assert.equal(res.status, 400);
  } finally { server.close(); db.close(); }
});

// DOCTOR_PROFILE_V1 (ревью шага 5, №11) — отказ ссылки соцсети называет поле и в
// карточке сотрудника (PATCH), и в «Моём профиле» (RPC): экран ставит его под полем.
test('DOCTOR_PROFILE_V1: ссылка соцсети не с http(s) — 400 с русским текстом и полем в карточке и в «Моём профиле»', async () => {
  const { db, server, base, docId } = await startServer();
  try {
    const admin = await loginAdmin(base);
    let res = await req(base, 'PATCH', '/api/users/' + docId, { public_profile: { telegram_url: '@dr_karimov' } }, admin);
    assert.equal(res.status, 400);
    let j = await res.json();
    assert.deepEqual([j.error.message, j.error.field], [PROFILE_LINK_MESSAGES.telegram_url.scheme, 'telegram_url']);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword('password1'), docId);
    const login = await req(base, 'POST', '/api/auth/login', { username: 'doc', password: 'password1' });
    const docCookie = login.headers.get('set-cookie').split(';')[0];
    res = await req(base, 'POST', '/api/rpc/update_my_doctor_profile', { p: { instagram_url: 'instagram.com/doc' } }, docCookie);
    assert.equal(res.status, 400);
    j = await res.json();
    assert.deepEqual([j.error.message, j.error.field], [PROFILE_LINK_MESSAGES.instagram_url.scheme, 'instagram_url']);
  } finally { server.close(); db.close(); }
});
