// PATIENT_PHOTO_V1 — «ФОТО НЕ ЗАГРУЖАЕТСЯ».
//
// Три кнопки продукта — съёмка с веб-камеры и выбор файла в окне заведения
// пациента, «Моё фото» в профиле врача — отвечали 400 «Invalid storage path».
// Всегда, с самого переезда с Supabase. Причина одна на всех и лежит в одной
// строке: routes/storage.js раздавал доступ по списку корзин, а `patient-photos`
// и `doctor-photos` в списке не значились, хотя приложение грузило именно в них.
//
// Поэтому первая проверка ниже — самая грубая: фотография ЗАГРУЖАЕТСЯ И
// ОТКРЫВАЕТСЯ, по HTTP, через настоящее приложение. Остальное — то, чего у
// фотографий не было вовсе и без чего «работает» значило бы «принимает что
// угодно от кого угодно»:
//
//   • ФОРМА ПУТИ — часть договора. В корзину нельзя положить путь другой
//     формы, а значит нельзя и обойти право, переставив сегменты;
//   • ПРАВО. Фото пациента ставит тот, кому разрешено менять карту пациента;
//     фото врача — сам врач (или администратор клиники). Лаборант, который
//     карту только смотрит, чужое лицо не перепишет;
//   • ПРЕДЕЛ И ФОРМАТ. Word, PDF и HEIC — не фотографии, и отказ называет
//     причину, а не «ошибка загрузки»;
//   • РЕЗЕРВНАЯ КОПИЯ. Проверяется НАСТОЯЩИМ createBackup (services/backup.js),
//     а не пересказом: фотография обязана попасть в снимок вместе с базой;
//   • ЗАМЕНА. Новое фото заменяет старое, прежний файл остаётся на диске, а
//     удалить фотографию нельзя — как нельзя удалить документ пациента.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { hashPassword } from '../services/auth.js';
import { createApp } from '../app.js';
import { licensedDataDir } from '../services/control/licensed-fixture.js';
import { createBackup } from '../services/backup.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';
import { MAX_PATIENT_PHOTO_BYTES } from '../../public/js/shared/patient-file-limits.js';

// ---------------------------------------------------------------------------
const mkUser = (db, username, name, role) => db
  .prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)')
  .run(username, hashPassword('password1'), name, role).lastInsertRowid;

async function setup() {
  const dataDir = licensedDataDir();
  const db = openDb(path.join(dataDir, 'easymed.db'));
  migrate(db);
  const ids = {
    boss:   mkUser(db, 'boss', 'Главврач Каримов', 'admin'),
    reg:    mkUser(db, 'reg', 'Регистратор Ли', 'registrar'),
    lab:    mkUser(db, 'lab', 'Лаборант Юсупов', 'lab'),
    doc:    mkUser(db, 'doc', 'Врач Абдуллаев', 'doctor'),
    doc2:   mkUser(db, 'doc2', 'Врач Соатова', 'doctor'),
  };
  const server = await listen(createApp(db, { dataDir }));
  return {
    db, ids, server, dataDir, base: `http://127.0.0.1:${server.address().port}`,
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

const url = (base, objPath) => base + '/api/storage/' + objPath.split('/').map(encodeURIComponent).join('/');
const put = (base, cookie, objPath, body, type = 'image/jpeg') =>
  fetch(url(base, objPath), { method: 'POST', headers: { 'Content-Type': type, Cookie: cookie }, body });
const get = (base, cookie, objPath) => fetch(url(base, objPath), { headers: { Cookie: cookie } });
const del = (base, cookie, objPath) => fetch(url(base, objPath), { method: 'DELETE', headers: { Cookie: cookie } });

const patientPhoto = (name = '1757000000000-abc123-photo.jpg') => `patient-photos/patients/${name}`;
const doctorPhoto = (id, name = '1757000000000-abc123-photo.jpg') => `doctor-photos/doctors/${id}/${name}`;

// Закрыть роли вкладку карты пациента — тем же способом, каким это делает
// «Настройки → Роли» (JSON в role_permissions).
const setTabs = (db, role, tabs) => {
  const row = db.prepare('SELECT permissions FROM role_permissions WHERE role = ?').get(role);
  const p = JSON.parse(row.permissions);
  p.patient_tabs = tabs;
  db.prepare('UPDATE role_permissions SET permissions = ? WHERE role = ?').run(JSON.stringify(p), role);
};

// ===========================================================================
test('фото пациента загружается и открывается — та самая кнопка, что отвечала 400', async () => {
  const s = await setup();
  try {
    const cookie = await login(s.base, 'reg');
    const p = patientPhoto();
    const up = await put(s.base, cookie, p, Buffer.from('JPEG-PORTRET'));
    assert.equal(up.status, 200, JSON.stringify(await up.json().catch(() => ({}))));

    // Байты на диске клиники — в её же папке данных, внутри своей корзины.
    const abs = path.join(s.dataDir, 'storage', 'patient-photos', 'patients', '1757000000000-abc123-photo.jpg');
    assert.ok(fs.existsSync(abs), 'файл лежит в <dataDir>/storage/patient-photos/patients/…');

    // …и отдаётся по своей ссылке — той самой, которую окно кладёт в photo_url.
    const got = await get(s.base, cookie, p);
    assert.equal(got.status, 200);
    assert.equal(got.headers.get('content-type'), 'image/jpeg', 'тип по расширению, иначе <img> не покажет');
    assert.equal(await got.text(), 'JPEG-PORTRET');
  } finally { s.stop(); }
});

test('фото врача загружается, открывается и лежит под id этого врача', async () => {
  const s = await setup();
  try {
    const cookie = await login(s.base, 'doc');
    const p = doctorPhoto(s.ids.doc);
    const up = await put(s.base, cookie, p, Buffer.from('JPEG-VRACH'));
    assert.equal(up.status, 200, JSON.stringify(await up.json().catch(() => ({}))));

    const abs = path.join(s.dataDir, 'storage', 'doctor-photos', 'doctors', String(s.ids.doc), '1757000000000-abc123-photo.jpg');
    assert.ok(fs.existsSync(abs), 'файл лежит в <dataDir>/storage/doctor-photos/doctors/<id>/…');

    const got = await get(s.base, cookie, p);
    assert.equal(got.status, 200);
    assert.equal(await got.text(), 'JPEG-VRACH');
  } finally { s.stop(); }
});

// ---------------------------------------------------------------------------
// Форма пути. Право проверяется ПО ПУТИ, поэтому путь другой формы обязан быть
// не «файлом без правил», а несуществующим путём.
// ---------------------------------------------------------------------------
test('в фотокорзину нельзя положить путь другой формы — иначе право обходится перестановкой сегментов', async () => {
  const s = await setup();
  try {
    const cookie = await login(s.base, 'boss');
    const bad = [
      'patient-photos/photo.jpg',                    // без папки
      'patient-photos/patients/1/photo.jpg',         // лишний уровень
      'patient-photos/docs/photo.jpg',               // чужая папка
      `doctor-photos/doctors/photo.jpg`,             // без id врача — «чьё фото?» без ответа
      'doctor-photos/doctors/abc/photo.jpg',         // id не число
      'doctor-photos/doctors/0/photo.jpg',           // id не бывает нулевым
      `doctor-photos/doctors/${s.ids.doc}/a/b.jpg`,  // лишний уровень
    ];
    for (const p of bad) {
      const res = await put(s.base, cookie, p, Buffer.from('X'));
      assert.equal(res.status, 400, 'приняли путь неверной формы: ' + p);
      const j = await res.json();
      assert.equal(j.error.code, 'bad_request');
      assert.ok(!fs.existsSync(path.join(s.dataDir, 'storage', ...p.split('/'))), 'файл всё же записан: ' + p);
    }
  } finally { s.stop(); }
});

// ---------------------------------------------------------------------------
// Право.
// ---------------------------------------------------------------------------
test('лаборант карту только смотрит — чужое лицо он не перепишет', async () => {
  const s = await setup();
  try {
    // Сначала фотография от того, кому положено, — чтобы отказ ниже нельзя
    // было спутать с «в корзине ничего нет».
    const regCookie = await login(s.base, 'reg');
    assert.equal((await put(s.base, regCookie, patientPhoto(), Buffer.from('LICO'))).status, 200);

    const labCookie = await login(s.base, 'lab');
    const res = await put(s.base, labCookie, patientPhoto('9-9-drugoe.jpg'), Buffer.from('PODMENA'));
    assert.equal(res.status, 403, 'лаборант загрузил фото пациента');
    const j = await res.json();
    assert.equal(j.error.code, 'forbidden');
    assert.match(j.error.message, /карту пациента/, 'отказ обязан называть право, а не просто «нельзя»');

    // Смотреть при этом он может: раздел «Пациенты» ему выдан.
    assert.equal((await get(s.base, labCookie, patientPhoto())).status, 200);
  } finally { s.stop(); }
});

test('закрытая вкладка «Детали» закрывает и фотографию — прямой ссылкой её не обойти', async () => {
  const s = await setup();
  try {
    const regCookie = await login(s.base, 'reg');
    assert.equal((await put(s.base, regCookie, patientPhoto(), Buffer.from('LICO'))).status, 200);

    setTabs(s.db, 'lab', { details: 'none' });
    const labCookie = await login(s.base, 'lab');
    const res = await get(s.base, labCookie, patientPhoto());
    assert.equal(res.status, 403, 'фото открылось при закрытой вкладке «Детали»');

    // И запись тоже: закрытая вкладка, обходимая POST-ом, — не закрытая вкладка.
    setTabs(s.db, 'registrar', { details: 'view' });
    const reg2 = await login(s.base, 'reg');
    assert.equal((await put(s.base, reg2, patientPhoto('9-9-x.jpg'), Buffer.from('X'))).status, 403);
  } finally { s.stop(); }
});

test('своё фото врач меняет сам; чужое — только администратор клиники', async () => {
  const s = await setup();
  try {
    const docCookie = await login(s.base, 'doc');
    assert.equal((await put(s.base, docCookie, doctorPhoto(s.ids.doc), Buffer.from('MOE'))).status, 200);

    // Чужое — нет. Это всё правило целиком, и работает оно только потому, что
    // id врача стоит в ПУТИ, а не в теле запроса.
    const res = await put(s.base, docCookie, doctorPhoto(s.ids.doc2), Buffer.from('CHUZHOE'));
    assert.equal(res.status, 403, 'врач переписал лицо коллеги');
    assert.match((await res.json()).error.message, /Моём профиле/);

    // Администратор клиники — может: карточки врачей заводит он.
    const bossCookie = await login(s.base, 'boss');
    assert.equal((await put(s.base, bossCookie, doctorPhoto(s.ids.doc2), Buffer.from('ADMIN-POSTAVIL'))).status, 200);

    // Регистратор — не администратор: раздела «Настройки» у него нет.
    const regCookie = await login(s.base, 'reg');
    assert.equal((await put(s.base, regCookie, doctorPhoto(s.ids.doc2), Buffer.from('NELZYA'))).status, 403);

    // Читают фото врача все: карточка публична по назначению.
    assert.equal((await get(s.base, regCookie, doctorPhoto(s.ids.doc))).status, 200);
  } finally { s.stop(); }
});

// ---------------------------------------------------------------------------
// Предел и формат.
// ---------------------------------------------------------------------------
test('слишком большая фотография отбивается с РАЗМЕРОМ и ПРЕДЕЛОМ, а не «ошибкой загрузки»', async () => {
  const s = await setup();
  try {
    const cookie = await login(s.base, 'reg');
    const big = Buffer.alloc(MAX_PATIENT_PHOTO_BYTES + 1024, 0x41);
    const res = await put(s.base, cookie, patientPhoto('9-9-ogromnoe.jpg'), big);
    assert.equal(res.status, 413);
    const j = await res.json();
    assert.equal(j.error.code, 'file_too_large');
    assert.match(j.error.message, /8 МБ/, 'отказ обязан назвать предел');
    assert.match(j.error.message, /8\.0 МБ/, 'отказ обязан назвать размер файла');
    assert.ok(!fs.existsSync(path.join(s.dataDir, 'storage', 'patient-photos', 'patients', '9-9-ogromnoe.jpg')));
  } finally { s.stop(); }
});

test('не картинка — не фотография; HEIC получает свой отказ, а не общий', async () => {
  const s = await setup();
  try {
    const cookie = await login(s.base, 'reg');

    const pdf = await put(s.base, cookie, patientPhoto('9-9-vypiska.pdf'), Buffer.from('%PDF-1.7'), 'application/pdf');
    assert.equal(pdf.status, 415);
    const jp = await pdf.json();
    assert.equal(jp.error.code, 'photo_not_an_image');
    assert.match(jp.error.message, /\.pdf/, 'отказ обязан назвать формат, который принесли');

    // HEIC — самый частый «непонятно почему не берёт»: айфон снимает так по
    // умолчанию, а Chrome на Windows такой файл не рисует. Ответ обязан
    // сказать, ЧТО ПЕРЕКЛЮЧИТЬ.
    const heic = await put(s.base, cookie, patientPhoto('9-9-IMG_0001.heic'), Buffer.from('ftypheic'), 'image/heic');
    assert.equal(heic.status, 415);
    const jh = await heic.json();
    assert.equal(jh.error.code, 'photo_heic');
    assert.match(jh.error.message, /JPEG/);

    for (const n of ['9-9-vypiska.pdf', '9-9-IMG_0001.heic']) {
      assert.ok(!fs.existsSync(path.join(s.dataDir, 'storage', 'patient-photos', 'patients', n)), 'файл всё же записан: ' + n);
    }
  } finally { s.stop(); }
});

// ---------------------------------------------------------------------------
// Резервная копия — против НАСТОЯЩЕГО кода копий.
// ---------------------------------------------------------------------------
test('фотография попадает в резервную копию вместе с базой', async () => {
  const s = await setup();
  try {
    const regCookie = await login(s.base, 'reg');
    const docCookie = await login(s.base, 'doc');
    assert.equal((await put(s.base, regCookie, patientPhoto(), Buffer.from('LICO-PACIENTA'))).status, 200);
    assert.equal((await put(s.base, docCookie, doctorPhoto(s.ids.doc), Buffer.from('LICO-VRACHA'))).status, 200);

    // Тот же createBackup, которым пользуется «Настройки → Резервные копии».
    const entry = await createBackup(s.db, s.dataDir, 'manual');
    assert.equal(entry.files, 2, 'снимок посчитал обе фотографии');

    const sidecar = path.join(s.dataDir, 'backups', entry.name.replace(/\.db$/, '') + '.files');
    const inBackup = (...segs) => path.join(sidecar, ...segs);
    assert.equal(fs.readFileSync(inBackup('patient-photos', 'patients', '1757000000000-abc123-photo.jpg'), 'utf8'),
      'LICO-PACIENTA', 'фото пациента в копии');
    assert.equal(fs.readFileSync(inBackup('doctor-photos', 'doctors', String(s.ids.doc), '1757000000000-abc123-photo.jpg'), 'utf8'),
      'LICO-VRACHA', 'фото врача в копии');
  } finally { s.stop(); }
});

// ---------------------------------------------------------------------------
// Замена.
// ---------------------------------------------------------------------------
test('новое фото заменяет прежнее, но не стирает его — и удалить фотографию нельзя', async () => {
  const s = await setup();
  try {
    const cookie = await login(s.base, 'reg');
    const first = patientPhoto('1757000000000-aaa111-photo.jpg');
    const second = patientPhoto('1757000009999-bbb222-photo.jpg');
    assert.equal((await put(s.base, cookie, first, Buffer.from('PERVOE'))).status, 200);
    assert.equal((await put(s.base, cookie, second, Buffer.from('VTOROE'))).status, 200);

    // Прежний файл на месте: на него ещё может указывать база после отката
    // резервной копии (backup.js сливает файлы, а строки откатывает).
    assert.equal(await (await get(s.base, cookie, first)).text(), 'PERVOE', 'прежнее фото исчезло');
    assert.equal(await (await get(s.base, cookie, second)).text(), 'VTOROE');

    // И стереть его нельзя — ни из экрана, ни curl'ом.
    const res = await del(s.base, cookie, first);
    assert.equal(res.status, 403);
    assert.match((await res.json()).error.message, /новая загрузка заменяет прежнюю/);
    assert.equal(await (await get(s.base, cookie, first)).text(), 'PERVOE', 'файл всё же удалён');

    // То же для фото врача.
    const docCookie = await login(s.base, 'doc');
    const dp = doctorPhoto(s.ids.doc);
    assert.equal((await put(s.base, docCookie, dp, Buffer.from('LICO'))).status, 200);
    assert.equal((await del(s.base, docCookie, dp)).status, 403);
  } finally { s.stop(); }
});

// ---------------------------------------------------------------------------
// Соседние корзины не пострадали: правило фотографий не должно было тронуть
// вложения карты пациента (у них СВОЙ предел 20 МБ и свой список форматов).
// ---------------------------------------------------------------------------
test('документы карты пациента живут по своим правилам — PDF туда по-прежнему кладут', async () => {
  const s = await setup();
  try {
    const cookie = await login(s.base, 'boss');
    const pid = s.db.prepare("INSERT INTO patients (full_name, mrn, branch_id) VALUES ('Пациент','MRN-1',1)").run().lastInsertRowid;
    const res = await put(s.base, cookie, `clinic-docs/patients/${pid}/docs/1757000000000-abc-napravlenie.pdf`,
      Buffer.from('%PDF-1.7'), 'application/pdf');
    assert.equal(res.status, 200, 'правило фотографий задело вложения карты');
  } finally { s.stop(); }
});
