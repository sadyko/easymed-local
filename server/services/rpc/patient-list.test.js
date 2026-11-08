// PATIENT_LIST_LAST_VISIT_V1 — картотека по последнему визиту: сортировка всей
// картотеки (а не страницы), отбор по периоду, те же поиск и дата рождения, что у
// /api/db, и то же правило «визит состоялся», что у колонки «Последний визит».
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { patientListPage } from './patient-list.js';
import { getRpc } from './index.js';
// PATIENT_LIST_ONE_PASS_V1 — эталон: прежний запрос страницы (ниже, referencePage).
import { visitsWithHappenedSql } from '../domain/visit-summary.js';
import { localDate, today as clinicToday } from '../domain/day.js';
import { searchTokens, loosePhonePattern } from '../../../public/js/admin/patient-search.js';
import { readableColumns } from '../../db/schema-registry.js';

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

// PATIENT_LIST_ONE_PASS_V1 (3.22.0, ревью) — «последний визит» — это агрегат по ВСЕМ
// визитам клиники (двумя EXISTS на визит), и сервер синхронный: пока он считается,
// ждут все. Прежде страница считала его дважды — для COUNT и для самой страницы — даже
// без отбора по периоду (0,6–1,7 с на 100 000 пациентов). Теперь: без периода счётчик
// визитов не трогает, а страница — только при сортировке по последнему визиту; с периодом
// агрегат один на вызов (итог — COUNT(*) OVER () той же выборки). Ответ — тот же самый:
// эталон ниже — прежний запрос дословно.
function referencePage(db, a) {   // прежний patientListPage (до PATIENT_LIST_ONE_PASS_V1), без проверок аргументов
  const sort = a.sort || 'recent';
  const limit = Math.min(200, Math.max(1, Number.parseInt(a.limit, 10) || 30));
  const offset = Math.max(0, Number.parseInt(a.offset, 10) || 0);
  const ids = a.ids ? [...new Set(a.ids.map(Number))] : null;
  const branchIds = a.branch_ids ? [...new Set(a.branch_ids.map(Number))] : null;
  if (ids && !ids.length) return { rows: [], total: 0 };
  const where = [];
  const params = [];
  for (const token of searchTokens(a.search)) {
    const pat = `%${token}%`;
    const terms = ["lower_uni(p.full_name) LIKE lower_uni(?) ESCAPE '\\'", "lower_uni(p.mrn) LIKE lower_uni(?) ESCAPE '\\'",
      "lower_uni(p.phone) LIKE lower_uni(?) ESCAPE '\\'"];
    params.push(pat, pat, pat);
    const loose = loosePhonePattern(token);
    if (loose) { terms.push('p.phone LIKE ?'); params.push(loose); }
    where.push('(' + terms.join(' OR ') + ')');
  }
  if (a.dob) { where.push('p.date_of_birth = ?'); params.push(a.dob); }
  if (ids) { where.push('p.id IN (SELECT value FROM json_each(?))'); params.push(JSON.stringify(ids)); }
  if (branchIds) { where.push('p.branch_id IN (SELECT value FROM json_each(?))'); params.push(JSON.stringify(branchIds)); }
  if (a.last_from || a.last_to) {
    where.push('lv.last_jd IS NOT NULL');
    if (a.last_from) { where.push(`${localDate('lv.last_jd')} >= ?`); params.push(a.last_from); }
    if (a.last_to) { where.push(`${localDate('lv.last_jd')} <= ?`); params.push(a.last_to); }
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const regJd = "julianday(COALESCE(NULLIF(p.registration_date, ''), p.created_at))";
  const order = {
    recent: 'p.registration_date DESC, p.created_at DESC, p.id DESC',
    az: 'p.last_name IS NULL, p.last_name ASC, p.id ASC',
    mrn: 'p.mrn IS NULL, p.mrn ASC, p.id ASC',
    last_visit_desc: `COALESCE(lv.last_jd, ${regJd}) DESC, p.id DESC`,
    last_visit_asc: `COALESCE(lv.last_jd, ${regJd}) ASC, p.id ASC`,
  }[sort];
  const day = clinicToday(db);
  const lvSql = `SELECT pid, MAX(CASE WHEN ok = 1 THEN jd END) AS last_jd FROM (${visitsWithHappenedSql()}) GROUP BY pid`;
  const from = `FROM patients p LEFT JOIN (${lvSql}) lv ON lv.pid = p.id ${whereSql}`;
  const cols = readableColumns('patients').map((c) => 'p.' + c).join(', ');
  const total = db.prepare(`SELECT COUNT(*) AS n ${from}`).get(day, day, ...params).n;
  const rows = db.prepare(`SELECT ${cols} ${from} ORDER BY ${order} LIMIT ? OFFSET ?`).all(day, day, ...params, limit, offset);
  return { rows, total: Number(total) || 0 };
}

// Картотека из 240 пациентов: визиты прошлые, сегодняшние и будущие, «Пришёл»,
// отменённые и неявки, с выполненной строкой и с оплатой, без визитов; двойники
// дат регистрации и фамилий (порядок решает номер), пустые фамилии и номера карт.
function bigSeed() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (1,'adm','x','Админ','admin')").run();
  db.prepare("INSERT INTO services (id, name, price) VALUES (1,'Приём',1000)").run();
  db.prepare("INSERT OR IGNORE INTO branches (id, name) VALUES (1, 'Главное'), (2, 'Филиал 2')").run();
  const pat = db.prepare('INSERT INTO patients (id, full_name, last_name, mrn, phone, date_of_birth, registration_date, branch_id) VALUES (?,?,?,?,?,?,?,?)');
  const vis = db.prepare('INSERT INTO visits (patient_id, visit_date, status) VALUES (?,?,?)');
  const line = db.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status) VALUES (?,1,1,1000,1000,?)");
  const inv = db.prepare("INSERT INTO invoices (patient_id, visit_id, invoice_number, subtotal, total_amount, paid_amount, status) VALUES (?,?,?,1000,1000,?,?)");
  const STATUSES = ['scheduled', 'arrived', 'cancelled', 'no_show', 'scheduled', 'confirmed'];
  let seq = 0;
  db.transaction(() => {
    for (let id = 1; id <= 240; id++) {
      const last = id % 11 === 0 ? '' : ['Алиев', 'Каримова', 'Усмонов', 'Набиев', 'Иванов'][id % 5];
      pat.run(id, (last || 'Безфамильный') + ' ' + id, last, id % 13 === 0 ? null : 'A-26-' + String(id).padStart(5, '0'),
        '99890' + String(1000000 + id * 37).slice(-7), id % 9 === 0 ? '1990-01-01' : '1985-05-' + String(1 + (id % 28)).padStart(2, '0'),
        atNoon(id % 17 === 0 ? 400 : (id * 7) % 500), 1 + (id % 2));
      const n = id % 6;   // 0 — визитов нет
      for (let k = 0; k < n; k++) {
        const daysAgo = ((id * 31 + k * 53) % 420) - 20;   // и будущие
        const vid = Number(vis.run(id, atNoon(daysAgo), STATUSES[(id + k) % STATUSES.length]).lastInsertRowid);
        if ((id + k) % 3 === 0) line.run(vid, (id + k) % 2 ? 'completed' : 'added');
        if ((id + k) % 4 === 0) inv.run(id, vid, 'INV-' + (++seq), (id + k) % 8 === 0 ? 1000 : 0, (id + k) % 8 === 0 ? 'paid' : 'unpaid');
      }
    }
  })();
  return db;
}

test('PATIENT_LIST_ONE_PASS_V1: ответ тот же, что у прежнего запроса — сортировки, отборы, поиск, страницы', () => {
  const db = bigSeed();
  const filters = [
    {}, { last_from: ymd(200) }, { last_to: ymd(30) }, { last_from: ymd(300), last_to: ymd(60) }, { last_from: ymd(0), last_to: ymd(0) },
    { search: 'алиев' }, { search: 'Каримова', last_from: ymd(400) }, { dob: '1990-01-01' }, { ids: [3, 5, 8, 13, 21, 34, 55, 89, 144, 233] },
    { branch_ids: [2] }, { branch_ids: [1], last_to: ymd(100) }, { search: 'нет такого' }, { ids: [1, 2], last_from: ymd(5000), last_to: ymd(4000) },
  ];
  const pages = [{}, { limit: 7, offset: 7 }, { limit: 30, offset: 200 }, { limit: 30, offset: 10000 }, { limit: 200 }];
  let n = 0;
  for (const sort of ['recent', 'az', 'mrn', 'last_visit_desc', 'last_visit_asc']) {
    for (const f of filters) {
      for (const p of pages) {
        const args = { sort, ...f, ...p };
        assert.deepEqual(patientListPage(db, args, ADMIN), referencePage(db, args), JSON.stringify(args));
        n++;
      }
    }
  }
  assert.equal(n, 5 * filters.length * pages.length);
  // Отбор по периоду правда отбирает (иначе сравнение выше ничего бы не доказало).
  const all = patientListPage(db, { limit: 1 }, ADMIN).total;
  const some = patientListPage(db, { last_from: ymd(300), last_to: ymd(60), limit: 1 }, ADMIN).total;
  assert.ok(some > 0 && some < all, `период: ${some} из ${all}`);
  db.close();
});

test('PATIENT_LIST_ONE_PASS_V1: визиты агрегируются не больше одного раза на вызов; без периода счётчик их не трогает', () => {
  const db = bigSeed();
  const orig = db.prepare.bind(db);
  let seen = [];
  db.prepare = (sql) => { seen.push(sql); return orig(sql); };
  const aggregates = (args) => {
    seen = [];
    const r = patientListPage(db, args, ADMIN);
    return { n: seen.filter((s) => /FROM visits v/.test(s)).length, r };
  };
  assert.equal(aggregates({ sort: 'recent' }).n, 0, 'без периода и без сортировки по визиту — визиты не нужны вовсе');
  assert.equal(aggregates({ sort: 'az', search: 'алиев' }).n, 0);
  assert.equal(aggregates({ sort: 'last_visit_desc' }).n, 1, 'сортировка по визиту — один агрегат на страницу, счётчик без него');
  assert.equal(aggregates({ sort: 'last_visit_asc', offset: 30 }).n, 1);
  const withPeriod = aggregates({ sort: 'recent', last_from: ymd(300), last_to: ymd(60) });
  assert.equal(withPeriod.n, 1, 'с периодом — один агрегат: и строки, и итог');
  assert.ok(withPeriod.r.total > 0 && withPeriod.r.rows.length > 0);
  assert.deepEqual(Object.keys(withPeriod.r.rows[0]), readableColumns('patients'), 'колонки ответа — ровно читаемые колонки реестра (без служебной колонки итога)');
  // Страница за концом выборки с периодом — итог отдельным счётом (редкий случай).
  const beyond = aggregates({ sort: 'last_visit_desc', last_from: ymd(300), last_to: ymd(60), offset: 100000 });
  assert.equal(beyond.r.rows.length, 0);
  assert.equal(beyond.r.total, withPeriod.r.total);
  assert.ok(beyond.n <= 2);
  db.prepare = orig;
  db.close();
});
