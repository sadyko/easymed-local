// CLINIC_API_FIX_V1 (2026-10-06) — карточка сотрудника больше не стирает
// узбекские названия и коды специальностей.
//
// Было: routes/users.js writeSpecialties писал в user_specialties только
// specialty_slug + name_ru — name_uz становился NULL, а у старого написания
// («Врач УЗД») слага не было вовсе. Свой профиль врача (rpc/doctor-profile.js)
// пишет слаг, ru и uz по канону (shared/specialty-list.js); теперь и карточка.
//
// users.specialty не меняется: это по-прежнему первое название, как его
// прислали (отчёты, печать и «врач ли это» читают его).

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { hashPassword } from '../services/auth.js';
import { createApp } from '../app.js';
import { licensedDataDir } from '../services/control/licensed-fixture.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';

// Тот же харнесс, что в users.test.js (он своих помощников не экспортирует).
async function startServer() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)')
    .run('boss', hashPassword('password1'), 'Boss', 'admin');
  const server = await listen(createApp(db, { dataDir: licensedDataDir() }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { db, server, base };
}

async function send(base, method, path, body, cookie) {
  return fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
}

async function loginAdmin(base) {
  const res = await send(base, 'POST', '/api/auth/login', { username: 'boss', password: 'password1' });
  return res.headers.get('set-cookie').split(';')[0];
}

// Врач-кардиолог, как его оставил собственный профиль: слаг, ru и uz.
function seedCardiologist(db) {
  const id = Number(db.prepare(
    "INSERT INTO users (username, password_hash, full_name, role, is_doctor, staff_type, specialty, is_active) VALUES ('dr.k', 'x', 'Каримов Алишер', 'doctor', 1, 'doctor', 'Кардиолог', 1)",
  ).run().lastInsertRowid);
  db.prepare("INSERT INTO user_specialties (user_id, specialty_slug, name_ru, name_uz, is_primary) VALUES (?, 'kardiolog', 'Кардиолог', 'Kardiolog', 1)").run(id);
  return id;
}

const rowsOf = (db, id) => db.prepare('SELECT specialty_slug, name_ru, name_uz, is_primary FROM user_specialties WHERE user_id = ? ORDER BY is_primary DESC, id').all(id)
  .map((r) => [r.specialty_slug, r.name_ru, r.name_uz, r.is_primary]);

test('PATCH специальностей из карточки: «Кардиолог» остаётся kardiolog / Кардиолог / Kardiolog — узбекское название не стирается', async () => {
  const { db, server, base } = await startServer();
  try {
    const admin = await loginAdmin(base);
    const id = seedCardiologist(db);
    let res = await send(base, 'PATCH', `/api/users/${id}`, { specialties: ['Кардиолог'] }, admin);
    assert.equal(res.status, 200, await res.text());
    assert.deepEqual(rowsOf(db, id), [['kardiolog', 'Кардиолог', 'Kardiolog', 1]]);
    assert.equal(db.prepare('SELECT specialty FROM users WHERE id = ?').get(id).specialty, 'Кардиолог');

    // Так шлёт карточка: { name, slug }. Вторая — из списка: её uz тоже из канона.
    res = await send(base, 'PATCH', `/api/users/${id}`, { specialties: [{ slug: 'kardiolog', name: 'Кардиолог' }, { slug: 'terapevt', name: 'Терапевт' }] }, admin);
    assert.equal(res.status, 200);
    assert.deepEqual(rowsOf(db, id), [['kardiolog', 'Кардиолог', 'Kardiolog', 1], ['terapevt', 'Терапевт', 'Terapevt', 0]]);

    // Без ключа specialties строки не трогаются (правили только оклад).
    res = await send(base, 'PATCH', `/api/users/${id}`, { salary_fixed: 4000000 }, admin);
    assert.equal(res.status, 200);
    assert.deepEqual(rowsOf(db, id), [['kardiolog', 'Кардиолог', 'Kardiolog', 1], ['terapevt', 'Терапевт', 'Terapevt', 0]]);
  } finally { server.close(); }
});

test('старое написание «Врач УЗД» ложится каноническим: uzi / Врач УЗИ / UTT shifokori, дубль после канона не пишется', async () => {
  const { db, server, base } = await startServer();
  try {
    const admin = await loginAdmin(base);
    const id = seedCardiologist(db);
    const res = await send(base, 'PATCH', `/api/users/${id}`, { specialties: ['Врач УЗД', 'Врач УЗИ'] }, admin);
    assert.equal(res.status, 200, await res.text());
    assert.deepEqual(rowsOf(db, id), [['uzi', 'Врач УЗИ', 'UTT shifokori', 1]]);
  } finally { server.close(); }
});

test('название не из списка: слаг NULL, name_ru как набрано, name_uz NULL — присланному слагу сервер не верит', async () => {
  const { db, server, base } = await startServer();
  try {
    const admin = await loginAdmin(base);
    const id = seedCardiologist(db);
    let res = await send(base, 'PATCH', `/api/users/${id}`, { specialties: [' Косметолог '] }, admin);
    assert.equal(res.status, 200, await res.text());
    assert.deepEqual(rowsOf(db, id), [[null, 'Косметолог', null, 1]]);
    assert.equal(db.prepare('SELECT specialty FROM users WHERE id = ?').get(id).specialty, 'Косметолог');

    res = await send(base, 'PATCH', `/api/users/${id}`, { specialties: [{ slug: 'kardiolog', name: 'Трихолог' }] }, admin);
    assert.equal(res.status, 200);
    assert.deepEqual(rowsOf(db, id), [[null, 'Трихолог', null, 1]], 'слаг чужой специальности прилип к названию не из списка');
  } finally { server.close(); }
});

test('своя старая строка не из списка (слаг и uz от прежнего редактора) переживает пересохранение списка', async () => {
  const { db, server, base } = await startServer();
  try {
    const admin = await loginAdmin(base);
    const id = seedCardiologist(db);
    db.prepare("INSERT INTO user_specialties (user_id, specialty_slug, name_ru, name_uz, is_primary) VALUES (?, 'kosmetolog', 'Косметолог', 'Kosmetolog', 0)").run(id);
    const res = await send(base, 'PATCH', `/api/users/${id}`, { specialties: [{ slug: 'kardiolog', name: 'Кардиолог' }, { slug: null, name: 'Косметолог' }, 'Терапевт'] }, admin);
    assert.equal(res.status, 200, await res.text());
    assert.deepEqual(rowsOf(db, id), [
      ['kardiolog', 'Кардиолог', 'Kardiolog', 1],
      ['kosmetolog', 'Косметолог', 'Kosmetolog', 0],
      ['terapevt', 'Терапевт', 'Terapevt', 0],
    ]);
  } finally { server.close(); }
});

test('POST нового врача: специальности ложатся со слагом и узбекским названием', async () => {
  const { db, server, base } = await startServer();
  try {
    const admin = await loginAdmin(base);
    const res = await send(base, 'POST', '/api/users', {
      username: 'dr.new', password: 'password2', role: 'doctor', staff_type: 'doctor', last_name: 'Ким', first_name: 'Олег',
      specialties: [{ slug: 'nevrolog', name: 'Невролог' }, 'Врач УЗД'],
    }, admin);
    const body = await res.json();
    assert.equal(res.status, 201, JSON.stringify(body));
    assert.deepEqual(rowsOf(db, body.user.id), [['nevrolog', 'Невролог', 'Nevrolog', 1], ['uzi', 'Врач УЗИ', 'UTT shifokori', 0]]);
    assert.equal(body.user.specialty, 'Невролог');
  } finally { server.close(); }
});
