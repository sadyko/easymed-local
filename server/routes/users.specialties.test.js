// CLINIC_API_FIX_V1 (2026-10-06) — карточка сотрудника больше не стирает
// узбекские названия и коды специальностей.
//
// Было: routes/users.js writeSpecialties писал в user_specialties только
// specialty_slug + name_ru — name_uz становился NULL, а у старого написания
// («Врач УЗД») слага не было вовсе. Свой профиль врача (rpc/doctor-profile.js)
// пишет слаг, ru и uz по канону (shared/specialty-list.js); теперь и карточка.
//
// users.specialty — первое название (отчёты, печать и «врач ли это» читают
// его). Ревью итога CLINIC_API_FIX_V1: в том же написании, что основная
// строка user_specialties, — каноническом из списка («Врач УЗД» → «Врач
// УЗИ»); не из списка — как прислано. Так же пишет свой профиль врача
// (rpc/doctor-profile.js).

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

// Названия «не из списка» здесь нарочно вымышленные: «Косметолог» и «Трихолог»
// войдут в список (REFERENCE_LISTS_V1), и тест не должен от этого ломаться.
test('название не из списка: слаг NULL, name_ru как набрано, name_uz NULL — присланному слагу сервер не верит', async () => {
  const { db, server, base } = await startServer();
  try {
    const admin = await loginAdmin(base);
    const id = seedCardiologist(db);
    let res = await send(base, 'PATCH', `/api/users/${id}`, { specialties: [' Консультант клиники '] }, admin);
    assert.equal(res.status, 200, await res.text());
    assert.deepEqual(rowsOf(db, id), [[null, 'Консультант клиники', null, 1]]);
    assert.equal(db.prepare('SELECT specialty FROM users WHERE id = ?').get(id).specialty, 'Консультант клиники');

    res = await send(base, 'PATCH', `/api/users/${id}`, { specialties: [{ slug: 'kardiolog', name: 'Эксперт клиники' }] }, admin);
    assert.equal(res.status, 200);
    assert.deepEqual(rowsOf(db, id), [[null, 'Эксперт клиники', null, 1]], 'слаг чужой специальности прилип к названию не из списка');
  } finally { server.close(); }
});

test('своя старая строка не из списка (слаг и uz от прежнего редактора) переживает пересохранение списка', async () => {
  const { db, server, base } = await startServer();
  try {
    const admin = await loginAdmin(base);
    const id = seedCardiologist(db);
    db.prepare("INSERT INTO user_specialties (user_id, specialty_slug, name_ru, name_uz, is_primary) VALUES (?, 'konsultant-legacy', 'Консультант клиники', 'Klinika maslahatchisi', 0)").run(id);
    const res = await send(base, 'PATCH', `/api/users/${id}`, { specialties: [{ slug: 'kardiolog', name: 'Кардиолог' }, { slug: null, name: 'Консультант клиники' }, 'Терапевт'] }, admin);
    assert.equal(res.status, 200, await res.text());
    assert.deepEqual(rowsOf(db, id), [
      ['kardiolog', 'Кардиолог', 'Kardiolog', 1],
      ['konsultant-legacy', 'Консультант клиники', 'Klinika maslahatchisi', 0],
      ['terapevt', 'Терапевт', 'Terapevt', 0],
    ]);
  } finally { server.close(); }
});

// Ревью 5a6da51 — у своей строки не из списка сохраняется только НЕканонический
// (старый) слаг. Канонический слаг при чужом названии — это слаг, когда-то
// принятый от клиента (прежний writeSpecialties писал присланный): он и его uz
// не переживают пересохранения.
test('своя строка «kardiolog / Эксперт клиники» (чужой канонический слаг) пересохраняется без слага и uz; старый неканонический — остаётся', async () => {
  const { db, server, base } = await startServer();
  try {
    const admin = await loginAdmin(base);
    const id = seedCardiologist(db);
    db.prepare('DELETE FROM user_specialties WHERE user_id = ?').run(id);
    db.prepare("INSERT INTO user_specialties (user_id, specialty_slug, name_ru, name_uz, is_primary) VALUES (?, 'kardiolog', 'Эксперт клиники', 'Kardiolog', 1)").run(id);
    db.prepare("INSERT INTO user_specialties (user_id, specialty_slug, name_ru, name_uz, is_primary) VALUES (?, 'konsultant-legacy', 'Консультант клиники', 'Klinika maslahatchisi', 0)").run(id);
    const res = await send(base, 'PATCH', `/api/users/${id}`, { specialties: ['Эксперт клиники', 'Консультант клиники'] }, admin);
    assert.equal(res.status, 200, await res.text());
    assert.deepEqual(rowsOf(db, id), [
      [null, 'Эксперт клиники', null, 1],
      ['konsultant-legacy', 'Консультант клиники', 'Klinika maslahatchisi', 0],
    ]);
  } finally { server.close(); }
});

// Ревью 5a6da51 — название ищется в списке без учёта регистра и лишних пробелов
// (specialtyGroupName — тот же, что группирует отчёт). users.specialty — каноническое
// название основной строки (ревью итога CLINIC_API_FIX_V1).
test('«кардиолог», « Врач  узи », «лор» — находятся в списке со слагом и uz; users.specialty — как основная строка', async () => {
  const { db, server, base } = await startServer();
  try {
    const admin = await loginAdmin(base);
    const id = seedCardiologist(db);
    let res = await send(base, 'PATCH', `/api/users/${id}`, { specialties: ['кардиолог', ' Врач  узи ', 'лор'] }, admin);
    assert.equal(res.status, 200, await res.text());
    assert.deepEqual(rowsOf(db, id), [
      ['kardiolog', 'Кардиолог', 'Kardiolog', 1],
      ['uzi', 'Врач УЗИ', 'UTT shifokori', 0],
      ['lor', 'Отоларинголог (ЛОР)', 'Otolaringolog (LOR)', 0],
    ]);
    assert.equal(db.prepare('SELECT specialty FROM users WHERE id = ?').get(id).specialty, 'Кардиолог', 'users.specialty — не как основная строка');

    // одна специальность двумя написаниями — одна строка
    res = await send(base, 'PATCH', `/api/users/${id}`, { specialties: [' Кардиолог ', 'КАРДИОЛОГ'] }, admin);
    assert.equal(res.status, 200);
    assert.deepEqual(rowsOf(db, id), [['kardiolog', 'Кардиолог', 'Kardiolog', 1]]);
  } finally { server.close(); }
});

// Ревью 5a6da51 — UPDATE users и DELETE + INSERT специальностей — одна
// транзакция: сбой на середине не оставляет ни стёртого списка, ни новой
// основной специальности в users.specialty.
function failOnTherapist(db) {
  db.exec("CREATE TRIGGER t_fail_spec BEFORE INSERT ON user_specialties WHEN NEW.name_ru = 'Терапевт' BEGIN SELECT RAISE(ABORT, 'boom'); END;");
}

test('PATCH: сбой вставки специальности — прежние строки и прежний users.specialty на месте', async () => {
  const { db, server, base } = await startServer();
  try {
    const admin = await loginAdmin(base);
    const id = seedCardiologist(db);
    failOnTherapist(db);
    const phoneBefore = db.prepare('SELECT phone FROM users WHERE id = ?').get(id).phone;
    const res = await send(base, 'PATCH', `/api/users/${id}`, { specialties: ['Невролог', 'Терапевт'], phone: '+998901234567' }, admin);
    assert.ok(res.status >= 500, 'сбой должен дойти до ответа: ' + res.status);
    assert.deepEqual(rowsOf(db, id), [['kardiolog', 'Кардиолог', 'Kardiolog', 1]], 'список стёрт или записан наполовину');
    const u = db.prepare('SELECT specialty, phone FROM users WHERE id = ?').get(id);
    assert.equal(u.specialty, 'Кардиолог', 'users.specialty сменился, а список — нет');
    assert.equal(u.phone, phoneBefore, 'UPDATE users прошёл без специальностей');
  } finally { server.close(); }
});

test('POST: сбой вставки специальности — сотрудник не заводится наполовину', async () => {
  const { db, server, base } = await startServer();
  try {
    const admin = await loginAdmin(base);
    failOnTherapist(db);
    const res = await send(base, 'POST', '/api/users', {
      username: 'dr.half', password: 'password2', role: 'doctor', staff_type: 'doctor', last_name: 'Ким', first_name: 'Олег',
      specialties: ['Невролог', 'Терапевт'],
    }, admin);
    assert.ok(res.status >= 500, 'сбой должен дойти до ответа: ' + res.status);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM users WHERE username = 'dr.half'").get().n, 0, 'сотрудник заведён без специальностей');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM user_specialties').get().n, 0);
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

// CLINIC_API_FIX_V1 (ревью итога) — users.specialty и основная строка
// user_specialties — одно и то же название. Было: строка — каноническая
// («Врач УЗИ»), а users.specialty — как прислано («Врач УЗД»): отчёт, печать и
// карточка показывали одного врача двумя написаниями.
const specialtyOf = (db, id) => db.prepare('SELECT specialty FROM users WHERE id = ?').get(id).specialty;

test('PATCH «Врач УЗД»: users.specialty — «Врач УЗИ», как основная строка', async () => {
  const { db, server, base } = await startServer();
  try {
    const admin = await loginAdmin(base);
    const id = seedCardiologist(db);
    let res = await send(base, 'PATCH', `/api/users/${id}`, { specialties: ['Врач УЗД'] }, admin);
    assert.equal(res.status, 200, await res.text());
    assert.deepEqual(rowsOf(db, id), [['uzi', 'Врач УЗИ', 'UTT shifokori', 1]]);
    assert.equal(specialtyOf(db, id), 'Врач УЗИ', 'users.specialty — как прислано, а строка — каноническая');

    // { name, slug } от карточки — то же правило; ответ сервера — тоже каноническое.
    res = await send(base, 'PATCH', `/api/users/${id}`, { specialties: [{ slug: null, name: ' лор ' }, 'Врач УЗД'] }, admin);
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(rowsOf(db, id)[0][1], 'Отоларинголог (ЛОР)');
    assert.equal(specialtyOf(db, id), 'Отоларинголог (ЛОР)');
    assert.equal(body.user ? body.user.specialty : body.specialty, 'Отоларинголог (ЛОР)');

    // Не из списка — как прислано (без крайних пробелов), как и строка.
    res = await send(base, 'PATCH', `/api/users/${id}`, { specialties: ['  Консультант клиники', 'Врач УЗД'] }, admin);
    assert.equal(res.status, 200);
    assert.equal(rowsOf(db, id)[0][1], 'Консультант клиники');
    assert.equal(specialtyOf(db, id), 'Консультант клиники');

    // Пустой список — пусто, как и было.
    res = await send(base, 'PATCH', `/api/users/${id}`, { specialties: [] }, admin);
    assert.equal(res.status, 200);
    assert.deepEqual(rowsOf(db, id), []);
    assert.equal(specialtyOf(db, id), '');
  } finally { server.close(); }
});

test('POST нового врача со старым написанием: users.specialty — каноническое, как основная строка', async () => {
  const { db, server, base } = await startServer();
  try {
    const admin = await loginAdmin(base);
    const res = await send(base, 'POST', '/api/users', {
      username: 'dr.uzi', password: 'password2', role: 'doctor', staff_type: 'doctor', last_name: 'Ким', first_name: 'Олег',
      specialties: ['Врач УЗД', 'Невролог'],
    }, admin);
    const body = await res.json();
    assert.equal(res.status, 201, JSON.stringify(body));
    assert.deepEqual(rowsOf(db, body.user.id)[0], ['uzi', 'Врач УЗИ', 'UTT shifokori', 1]);
    assert.equal(specialtyOf(db, body.user.id), 'Врач УЗИ');
    assert.equal(body.user.specialty, 'Врач УЗИ');
  } finally { server.close(); }
});
