// PATIENT_LIST_LAST_VISIT_V1 — картотека по последнему визиту: сортировка всей
// картотеки (а не страницы), отбор по периоду, те же поиск и дата рождения, что у
// /api/db, и то же правило «визит состоялся», что у колонки «Последний визит».
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { patientListPage } from './patient-list.js';
import { getRpc } from './index.js';

// Местный день N дней назад и визит в полдень этого дня (date(.., 'localtime') — тот же день).
const ymd = (daysAgo) => {
  const d = new Date(); d.setDate(d.getDate() - daysAgo);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};
const atNoon = (daysAgo) => new Date(ymd(daysAgo) + 'T12:00:00').toISOString();

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (1,'adm','x','Админ','admin')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (2,'reg','x','Регистратор','registrar')").run();
  const pat = db.prepare('INSERT INTO patients (id, full_name, last_name, mrn, phone, date_of_birth, registration_date) VALUES (?,?,?,?,?,?,?)');
  pat.run(1, 'Алиев Бобур', 'Алиев', 'A-26-00001', '+998 90 111 22 33', '1990-01-01', atNoon(400));
  pat.run(2, 'Каримова Дилноза', 'Каримова', 'A-26-00002', '998901112244', '1985-05-05', atNoon(300));
  pat.run(3, 'Усмонов Шароф', 'Усмонов', 'A-26-00003', '998901112255', '2000-02-02', atNoon(5));   // визитов нет
  pat.run(4, 'Набиев Ойбек', 'Набиев', 'A-26-00004', '998901112266', '1970-07-07', atNoon(200));
  const vis = db.prepare('INSERT INTO visits (patient_id, visit_date, status) VALUES (?,?,?)');
  vis.run(1, atNoon(0), 'scheduled');     // сегодня — состоялся
  vis.run(2, atNoon(10), 'arrived');      // 10 дней назад, «Пришёл»
  vis.run(2, atNoon(1), 'cancelled');     // отменён — не считается
  vis.run(4, atNoon(30), 'arrived');      // 30 дней назад
  vis.run(4, atNoon(-3), 'scheduled');    // будущая запись — не «последний визит»
  return db;
}
const ADMIN = { id: 1, role: 'admin' };
const ids = (r) => r.rows.map((p) => p.id);

test('сортировка по последнему визиту — вся картотека; без визитов — день регистрации', () => {
  const db = seed();
  // последние визиты: 1 — сегодня, 2 — 10 дн., 4 — 30 дн.; 3 — без визитов, регистрация 5 дн. назад
  assert.deepEqual(ids(patientListPage(db, { sort: 'last_visit_desc' }, ADMIN)), [1, 3, 2, 4]);
  assert.deepEqual(ids(patientListPage(db, { sort: 'last_visit_asc' }, ADMIN)), [4, 2, 3, 1]);
  const page = patientListPage(db, { sort: 'last_visit_desc', limit: 2, offset: 2 }, ADMIN);
  assert.deepEqual(ids(page), [2, 4], 'страница — кусок общего порядка, а не сортировка своих строк');
  assert.equal(page.total, 4);
});

test('отбор по периоду — только по настоящему последнему визиту; отменённые и будущие не в счёт', () => {
  const db = seed();
  const r = patientListPage(db, { sort: 'last_visit_desc', last_from: ymd(15), last_to: ymd(5) }, ADMIN);
  assert.deepEqual(ids(r), [2], 'у Каримовой последний — 10 дней назад: отменённый вчерашний не считается');
  assert.equal(r.total, 1);
  assert.deepEqual(ids(patientListPage(db, { last_from: ymd(40), last_to: ymd(20) }, ADMIN)), [4],
    'будущая запись Набиева не делает его последний визит «будущим»');
  assert.deepEqual(ids(patientListPage(db, { last_from: ymd(6), last_to: ymd(4) }, ADMIN)), [],
    'пациент без визитов в отбор по периоду не попадает');
});

test('поиск, дата рождения и «Дубликаты» — те же правила, что у обычной страницы', () => {
  const db = seed();
  assert.deepEqual(ids(patientListPage(db, { search: 'шароф усмонов' }, ADMIN)), [3], 'слова в любом порядке, регистр кириллицы');
  assert.deepEqual(ids(patientListPage(db, { search: '901112233' }, ADMIN)), [1], 'телефон с пробелами находится цифрами');
  assert.deepEqual(ids(patientListPage(db, { search: 'A-26-00004' }, ADMIN)), [4], 'номер карты');
  assert.deepEqual(ids(patientListPage(db, { dob: '1985-05-05' }, ADMIN)), [2]);
  assert.deepEqual(ids(patientListPage(db, { ids: [2, 4], sort: 'last_visit_desc' }, ADMIN)), [2, 4]);
  assert.deepEqual(patientListPage(db, { ids: [] }, ADMIN), { rows: [], total: 0 });
  assert.deepEqual(ids(patientListPage(db, { search: '100%' }, ADMIN)), [], '% в запросе — буква, а не «что угодно»');
});

test('ответ — читаемые колонки реестра; неверные аргументы — отказ словами; RPC зарегистрирован', () => {
  const db = seed();
  const row = patientListPage(db, { search: 'Алиев' }, ADMIN).rows[0];
  assert.equal(row.full_name, 'Алиев Бобур');
  assert.equal(row.mrn, 'A-26-00001');
  for (const bad of [{ sort: 'нечто' }, { last_from: '07.11.2026' }, { last_from: ymd(1), last_to: ymd(5) }, { ids: 'x' }]) {
    assert.throws(() => patientListPage(db, bad, ADMIN), (e) => e.status === 400, JSON.stringify(bad));
  }
  assert.equal(typeof getRpc('patient_list_page'), 'function');
});
