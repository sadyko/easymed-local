// PATIENT_FILE_ATTACH_V1 — «МЫ НЕ МОЖЕМ ЗАГРУЗИТЬ В КАРТУ ПАЦИЕНТА».
//
// Владелец приложил файл к карте и получил «not implemented». Единственный
// источник этих слов в продукте — 501 rpc_not_implemented (routes/rpc.js),
// то есть экран позвал обработчик, которого у ЕГО сервера нет. Отсюда первая
// проверка ниже: путь загрузки проверяется ЦЕЛИКОМ и по HTTP — экран, маршрут
// хранилища и RPC вместе, — потому что по отдельности каждое звено работало и
// именно стык был сломан.
//
// Остальное — то, чего у вложений не было вовсе и без чего обещание «файл в
// карте» клиника выполнить не может:
//   • предел размера и список форматов, с ПОНЯТНЫМ отказом (регистратура
//     прикладывает 40-мегабайтные фотографии с телефона — это норма, а не
//     край);
//   • закрытая вкладка «Документы» (7ff82a6) закрывает и ФАЙЛ: путь
//     `patients/<id>/docs/…` предсказуем, и без проверки на маршруте закрытая
//     вкладка обходилась прямой ссылкой;
//   • автора ставит сервер, а не тело запроса;
//   • документ ОТЗЫВАЕТСЯ, а не удаляется (как отметки медсестры и счета);
//   • файл переживает перезапуск сервера;
//   • файла с другого компьютера НЕТ — и карта об этом говорит, а не
//     показывает ссылку, открывающую пустоту.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { hashPassword } from '../auth.js';
import { createApp } from '../../app.js';
import { licensedDataDir } from '../control/licensed-fixture.js';
import { listen } from '../../../control-plane/server/test-helpers/listen.js';
import { MAX_PATIENT_FILE_BYTES } from '../../../public/js/shared/patient-file-limits.js';

function seedDb(dataDir) {
  const db = openDb(path.join(dataDir, 'easymed.db'));
  migrate(db);
  db.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)')
    .run('boss', hashPassword('password1'), 'Главврач Каримов', 'admin');
  db.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)')
    .run('reg', hashPassword('password1'), 'Регистратор Ли', 'registrar');
  const pid = db.prepare("INSERT INTO patients (full_name, mrn, branch_id) VALUES ('Пациент','MRN-1',1)").run().lastInsertRowid;
  return { db, pid };
}

async function start(db, dataDir) {
  const server = await listen(createApp(db, { dataDir }));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function login(base, username) {
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'password1' }),
  });
  assert.equal(res.status, 200, 'вход ' + username);
  return (res.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
}

const objectUrl = (base, objPath) =>
  base + '/api/storage/clinic-docs/' + objPath.split('/').map(encodeURIComponent).join('/');

const putFile = (base, cookie, objPath, body, type = 'image/png') =>
  fetch(objectUrl(base, objPath), { method: 'POST', headers: { 'Content-Type': type, Cookie: cookie }, body });

const rpc = (base, cookie, name, args) =>
  fetch(base + '/api/rpc/' + name, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(args),
  });

const docPath = (pid, name) => `patients/${pid}/docs/1757000000000-abc123-${name}`;

// Прикладываем файл так, как это делает карта пациента: сначала байты в
// хранилище, потом строка через RPC.
async function attach(base, cookie, pid, name, bytes, type = 'image/png') {
  const p = docPath(pid, name);
  const up = await putFile(base, cookie, p, bytes, type);
  if (!up.ok) return { step: 'storage', res: up, body: await up.json().catch(() => ({})) };
  const row = {
    patient_id: pid, title: name, file_name: name, file_path: p,
    file_size: bytes.length, content_type: type, doc_type: 'upload',
  };
  const add = await rpc(base, cookie, 'patient_card_doc_add', { patient_id: pid, row });
  return { step: 'rpc', res: add, body: await add.json().catch(() => ({})), path: p };
}

const setTabs = (db, role, tabs) => {
  const row = db.prepare('SELECT permissions FROM role_permissions WHERE role = ?').get(role);
  const p = JSON.parse(row.permissions);
  p.patient_tabs = tabs;
  db.prepare('UPDATE role_permissions SET permissions = ? WHERE role = ?').run(JSON.stringify(p), role);
};

const setup = async () => {
  const dataDir = licensedDataDir();
  const { db, pid } = seedDb(dataDir);
  const { server, base } = await start(db, dataDir);
  return {
    db, pid, server, base, dataDir,
    stop() { server.close(); db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); },
  };
};

// ---------------------------------------------------------------------------

test('обычный файл прикладывается и виден в карте — с автором и временем', async () => {
  const s = await setup();
  try {
    const cookie = await login(s.base, 'boss');
    const out = await attach(s.base, cookie, s.pid, 'napravlenie.png', Buffer.from('PNG-BYTES'));
    assert.equal(out.res.status, 200, JSON.stringify(out.body));

    // Байты действительно на диске клиники, внутри её папки данных.
    const abs = path.join(s.dataDir, 'storage', 'clinic-docs', ...out.path.split('/'));
    assert.ok(fs.existsSync(abs), 'файл лежит в <dataDir>/storage/clinic-docs/…');

    const card = await (await rpc(s.base, cookie, 'patient_card', { patient_id: s.pid })).json();
    const doc = card.data.docs.find((d) => d.file_name === 'napravlenie.png');
    assert.ok(doc, 'документ в карте');
    assert.equal(doc.created_by_name, 'Главврач Каримов', 'видно, КТО приложил');
    assert.match(doc.created_at, /^\d{4}-\d{2}-\d{2}T/, 'видно, КОГДА приложили');
    assert.equal(doc.file_available, true);
    assert.equal(doc.voided_at, null);

    // …и файл действительно отдаётся по своей ссылке.
    const got = await fetch(objectUrl(s.base, out.path), { headers: { Cookie: cookie } });
    assert.equal(got.status, 200);
    assert.equal(await got.text(), 'PNG-BYTES');
  } finally { s.stop(); }
});

test('автора ставит сервер: подписаться чужим именем через тело запроса нельзя', async () => {
  const s = await setup();
  try {
    const cookie = await login(s.base, 'reg');
    const p = docPath(s.pid, 'scan.pdf');
    assert.equal((await putFile(s.base, cookie, p, Buffer.from('%PDF-1.4'), 'application/pdf')).status, 200);
    const other = s.db.prepare("SELECT id FROM users WHERE username = 'boss'").get().id;
    const add = await rpc(s.base, cookie, 'patient_card_doc_add', {
      patient_id: s.pid,
      row: { file_name: 'scan.pdf', file_path: p, file_size: 8, doc_type: 'upload', created_by: other },
    });
    assert.equal(add.status, 200);
    const row = s.db.prepare('SELECT created_by FROM visit_documents WHERE file_path = ?').get(p);
    const me = s.db.prepare("SELECT id FROM users WHERE username = 'reg'").get().id;
    assert.equal(row.created_by, me, 'автор — тот, кто вошёл, а не тот, кого назвали в теле');
  } finally { s.stop(); }
});

test('40-мегабайтная фотография с телефона: отказ называет размер и предел', async () => {
  const s = await setup();
  try {
    const cookie = await login(s.base, 'boss');
    // Не льём 40 МБ по сети в тесте: правило проверяется на обеих сторонах —
    // маршрут (по реальному телу чуть выше предела) и RPC (по заявленному
    // размеру), а express-ный 413 на теле >20 МБ проверяет отдельная строка.
    const tooBig = Buffer.alloc(MAX_PATIENT_FILE_BYTES + 1, 0x41);
    const up = await putFile(s.base, cookie, docPath(s.pid, 'foto.jpg'), tooBig, 'image/jpeg');
    assert.equal(up.status, 413);
    const upBody = await up.json();
    assert.equal(upBody.error.code, 'file_too_large');
    assert.match(upBody.error.message, /20 МБ/, 'отказ называет предел');

    // Тот же отказ у RPC — байты можно положить в обход экрана, строку нельзя.
    const add = await rpc(s.base, cookie, 'patient_card_doc_add', {
      patient_id: s.pid,
      row: { file_name: 'foto.jpg', file_path: docPath(s.pid, 'foto.jpg'), file_size: 42 * 1024 * 1024, doc_type: 'upload' },
    });
    assert.equal(add.status, 413);
    const addBody = await add.json();
    assert.equal(addBody.error.code, 'file_too_large');
    assert.match(addBody.error.message, /44\.0 МБ|МБ/, 'отказ называет размер файла');
    assert.equal(s.db.prepare('SELECT COUNT(*) n FROM visit_documents').get().n, 0, 'строки не появилось');
  } finally { s.stop(); }
});

test('запрещённый тип: .exe не ложится на диск, отказ объясняет, что подойдёт', async () => {
  const s = await setup();
  try {
    const cookie = await login(s.base, 'boss');
    const p = docPath(s.pid, 'setup.exe');
    const up = await putFile(s.base, cookie, p, Buffer.from('MZ'), 'application/octet-stream');
    assert.equal(up.status, 415);
    assert.equal((await up.json()).error.code, 'file_type_not_allowed');
    assert.ok(!fs.existsSync(path.join(s.dataDir, 'storage', 'clinic-docs', ...p.split('/'))), 'на диск ничего не легло');

    // …и .zip (не исполняемый, но и не документ) тоже не документ пациента.
    const z = docPath(s.pid, 'arhiv.zip');
    const upZip = await putFile(s.base, cookie, z, Buffer.from('PK'), 'application/zip');
    assert.equal(upZip.status, 415);
    assert.match((await upZip.json()).error.message, /PDF/, 'отказ говорит, ЧТО подойдёт');

    const add = await rpc(s.base, cookie, 'patient_card_doc_add', {
      patient_id: s.pid, row: { file_name: 'setup.exe', file_path: p, file_size: 2, doc_type: 'upload' },
    });
    assert.equal(add.status, 415);
    assert.equal(s.db.prepare('SELECT COUNT(*) n FROM visit_documents').get().n, 0);
  } finally { s.stop(); }
});

test('роль без вкладки «Документы» не может ни загрузить файл, ни прочитать чужой', async () => {
  const s = await setup();
  try {
    const boss = await login(s.base, 'boss');
    const out = await attach(s.base, boss, s.pid, 'analiz.pdf', Buffer.from('%PDF-1.4'), 'application/pdf');
    assert.equal(out.res.status, 200);

    setTabs(s.db, 'registrar', { docs: 'none' });
    const reg = await login(s.base, 'reg');

    // 1. читать файл по прямой ссылке — нельзя (путь предсказуем, и без этой
    //    проверки закрытая вкладка обходилась бы адресной строкой).
    const get = await fetch(objectUrl(s.base, out.path), { headers: { Cookie: reg } });
    assert.equal(get.status, 403);
    assert.match((await get.json()).error.message, /Вкладка «Документы» закрыта/);

    // 2. загрузить свой — тоже нельзя.
    const up = await putFile(s.base, reg, docPath(s.pid, 'moe.png'), Buffer.from('PNG'));
    assert.equal(up.status, 403);

    // 3. и карта документов ему не отдаёт.
    const card = await (await rpc(s.base, reg, 'patient_card', { patient_id: s.pid })).json();
    assert.equal(card.data.docs, null, 'закрытая вкладка приходит null, а не пустым списком');

    // «Только просмотр» читает, но не пишет.
    setTabs(s.db, 'registrar', { docs: 'view' });
    const reg2 = await login(s.base, 'reg');
    assert.equal((await fetch(objectUrl(s.base, out.path), { headers: { Cookie: reg2 } })).status, 200);
    assert.equal((await putFile(s.base, reg2, docPath(s.pid, 'moe.png'), Buffer.from('PNG'))).status, 403);
  } finally { s.stop(); }
});

test('файл переживает перезапуск сервера — он на диске клиники, а не в памяти', async () => {
  const dataDir = licensedDataDir();
  const { db, pid } = seedDb(dataDir);
  let s1 = await start(db, dataDir);
  let objPath;
  try {
    const cookie = await login(s1.base, 'boss');
    const out = await attach(s1.base, cookie, pid, 'ekg.png', Buffer.from('EKG-BYTES'));
    assert.equal(out.res.status, 200);
    objPath = out.path;
  } finally { s1.server.close(); db.close(); }

  // Полный перезапуск: новый процесс открыл бы ту же папку данных и ту же базу.
  const db2 = openDb(path.join(dataDir, 'easymed.db'));
  const s2 = await start(db2, dataDir);
  try {
    const cookie = await login(s2.base, 'boss');
    const got = await fetch(objectUrl(s2.base, objPath), { headers: { Cookie: cookie } });
    assert.equal(got.status, 200);
    assert.equal(await got.text(), 'EKG-BYTES');
    const card = await (await rpc(s2.base, cookie, 'patient_card', { patient_id: pid })).json();
    assert.equal(card.data.docs[0].file_available, true);
  } finally {
    s2.server.close(); db2.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('документ отзывается, а не удаляется — и сервер это соблюдает', async () => {
  const s = await setup();
  try {
    const cookie = await login(s.base, 'boss');
    const out = await attach(s.base, cookie, s.pid, 'spravka.pdf', Buffer.from('%PDF-1.4'), 'application/pdf');
    const docId = out.body.data.id;

    // 1. Удалить файл напрямую нельзя — маршрут отказывает, даже curl'ом.
    const del = await fetch(objectUrl(s.base, out.path), { method: 'DELETE', headers: { Cookie: cookie } });
    assert.equal(del.status, 403);
    assert.ok(fs.existsSync(path.join(s.dataDir, 'storage', 'clinic-docs', ...out.path.split('/'))));

    // 2. Отзыв: строка остаётся, помечается, и файл перестаёт открываться.
    const voided = await rpc(s.base, cookie, 'patient_card_doc_void',
      { patient_id: s.pid, document_id: docId, reason: 'приложен не тому пациенту' });
    assert.equal(voided.status, 200);
    const row = s.db.prepare('SELECT voided_at, voided_by, void_reason FROM visit_documents WHERE id = ?').get(docId);
    assert.ok(row.voided_at, 'запись осталась и помечена');
    assert.equal(row.void_reason, 'приложен не тому пациенту');
    assert.ok(row.voided_by, 'записано, кто отозвал');

    const got = await fetch(objectUrl(s.base, out.path), { headers: { Cookie: cookie } });
    assert.equal(got.status, 410, 'ссылка, разосланная до отзыва, больше не отдаёт файл');
    assert.equal((await got.json()).error.code, 'document_voided');

    // 3. Карта по-прежнему ЗНАЕТ про документ — в этом весь смысл отзыва.
    const card = await (await rpc(s.base, cookie, 'patient_card', { patient_id: s.pid })).json();
    const d = card.data.docs.find((x) => x.id === docId);
    assert.ok(d && d.voided_at, 'отозванный документ виден в карте, а не исчез');
  } finally { s.stop(); }
});

test('вложение другого здания: карта говорит, что файла здесь нет, а не даёт битую ссылку', async () => {
  const s = await setup();
  try {
    const cookie = await login(s.base, 'boss');
    // Так выглядит документ, приехавший из другого здания: строка есть, файла
    // на этой машине нет (файлы не ездят по каналу синхронизации).
    const foreign = `patients/${s.pid}/docs/1757000000000-zzz999-iz-drugogo-zdaniya.pdf`;
    s.db.prepare("INSERT INTO visit_documents (patient_id, title, file_name, file_path, file_size, content_type, doc_type)"
      + " VALUES (?,?,?,?,?,?, 'upload')")
      .run(s.pid, 'Направление', 'iz-drugogo-zdaniya.pdf', foreign, 12, 'application/pdf');

    const card = await (await rpc(s.base, cookie, 'patient_card', { patient_id: s.pid })).json();
    const d = card.data.docs.find((x) => x.file_path === foreign);
    assert.equal(d.file_available, false, 'карта ЗНАЕТ, что файла тут нет — экран покажет это вместо ссылки');

    // Ссылка на него честно отвечает «нет такого файла», а не отдаёт чужой.
    assert.equal((await fetch(objectUrl(s.base, foreign), { headers: { Cookie: cookie } })).status, 404);
  } finally { s.stop(); }
});
