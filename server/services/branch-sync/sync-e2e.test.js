// BRANCH_SYNC_V1 — НАСТОЯЩАЯ синхронизация между ДВУМЯ установками Easy-Med.
//
// Не заглушки и не проверка аргументов: в одном процессе поднимаются две
// полноценные установки — свой каталог данных, своя база, свои миграции, свой
// HTTP-сервер на своём порту, — связываются ключом и обмениваются справочником
// через обычный fetch по сети. Ровно то, что произойдёт в клинике, где во
// втором здании стоит второй компьютер.
//
// Почему это единственный честный способ: в предыдущей жизни проекта четыре
// релиза подряд не устанавливали НИЧЕГО, потому что каждый тест проверял
// аргументы вызова, а не результат (docs/FOR-NEW-CONTRIBUTORS.md). Здесь
// проверяется результат: строки в базе принимающего филиала.
//
// Ловушка окружения, которую этот файл обходит намеренно: services/control/
// config.js хранит каталог данных ОДНИМ значением на процесс (RPC-обработчики
// получают (db, args, user) и не видят req). createApp() выставляет его.
// Поэтому порядок ниже жёсткий: сначала поднимается ГЛАВНЫЙ филиал и у него
// же берётся ключ, и только потом — вторичный, после чего все RPC в процессе
// адресуют каталог вторичного. Раздача справочника от этого не зависит:
// routes/branch-sync.js получает свой каталог параметром при монтировании.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { createApp } from '../../app.js';
import { hashPassword } from '../auth.js';
import { licensedDataDir } from '../control/licensed-fixture.js';
import { readPairing, writePairing, signRequest, CATALOGUE_PATH } from './pairing.js';
import { isReadOnlyRpc, isAlwaysAllowedRpc } from '../control/gate.js';
import { listen as listenOnFreePort } from '../../../control-plane/server/test-helpers/listen.js';

const MARKER = 'ZZPATIENTMARKER';

// ---------------------------------------------------------------------------
// одна установка Easy-Med
// ---------------------------------------------------------------------------
function install(dataDir, name) {
  const db = openDb(path.join(dataDir, name + '.db'));
  migrate(db);
  db.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)')
    .run('boss', hashPassword('password1'), 'Boss', 'admin');
  return db;
}

// Порт берётся ОБЩИМ помощником (FETCH_BAD_PORT_V1): fetch() отказывается
// соединяться с портами из списка WHATWG «bad ports», а динамический диапазон
// этой машины (1024-14999) содержит 14 таких. Свой listen(0) изредка вытягивал
// именно их, и тест падал с «bad port» — не поломкой кода, а невезением.
function listen(db, dataDir) {
  return listenOnFreePort(createApp(db, { dataDir })).then((server) => ({
    server, base: `http://127.0.0.1:${server.address().port}`,
  }));
}

// Закрывать надо вместе с живыми keep-alive соединениями: fetch держит их
// открытыми, и голый close() ждал бы их вечно — тест повис бы на «главный
// филиал недоступен», который он же и проверяет.
function shutdown(server) {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

async function login(base) {
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'boss', password: 'password1' }),
  });
  assert.equal(res.status, 200, 'администратор должен войти');
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

async function rpc(base, cookie, name, args = {}) {
  const res = await fetch(base + '/api/rpc/' + name, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(args),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, data: json.data ?? null, error: json.error ?? null };
}

/** Справочник + клинические данные, которых во втором филиале быть не должно. */
function seedMain(db) {
  db.prepare("UPDATE doc_settings SET clinic_name='Клиника Луч', address='ул. Главная, 1', phone='+998901112233', accent_color='#0d5f57', license='LIC-77' WHERE id=1").run();
  db.prepare("INSERT INTO service_categories (name, code) VALUES ('Кардиология','CARD')").run();
  db.prepare(`INSERT INTO services (name, code, price, type, category_id, active)
              VALUES ('Приём кардиолога','S-CARD',250000,'consultation',1,1)`).run();
  db.prepare(`INSERT INTO services (name, code, price, type, is_lab, active)
              VALUES ('Биохимия крови','S-BIO',180000,'lab',1,1)`).run();
  const bio = db.prepare("SELECT id FROM services WHERE code='S-BIO'").get().id;
  db.prepare('INSERT INTO lab_panels (name, code, service_id) VALUES (?,?,?)').run('Биохимия', 'P-BIO', bio);
  const panel = db.prepare("SELECT id FROM lab_panels WHERE code='P-BIO'").get().id;
  db.prepare(`INSERT INTO lab_panel_analytes (panel_id, code, name, unit, ref_low, ref_high, sort_order)
              VALUES (?,'GLU','Глюкоза','ммоль/л',3.9,5.9,1)`).run(panel);

  db.prepare('INSERT INTO patients (full_name, phone, notes) VALUES (?,?,?)')
    .run(MARKER + ' Петров', '+998900000001', 'жалобы ' + MARKER);
  db.prepare("INSERT INTO visits (patient_id, visit_date, notes) VALUES (1,'2026-08-29',?)").run(MARKER);
  db.prepare('INSERT INTO invoices (invoice_number, patient_id, total_amount) VALUES (?,1,250000)').run(MARKER + '-7');
  db.prepare('INSERT INTO invoice_items (invoice_id, service_id, description, unit_price) VALUES (1,1,?,250000)').run(MARKER);
  db.prepare('INSERT INTO visit_services (visit_id, service_id, unit_price) VALUES (1,?,180000)').run(bio);
  db.prepare('INSERT INTO lab_results (visit_service_id, notes) VALUES (1,?)').run(MARKER);
}

const backups = (dir) => {
  try { return fs.readdirSync(path.join(dir, 'backups')); } catch { return []; }
};
const clinicalCounts = (db) => ({
  patients: db.prepare('SELECT COUNT(*) n FROM patients').get().n,
  visits: db.prepare('SELECT COUNT(*) n FROM visits').get().n,
  invoices: db.prepare('SELECT COUNT(*) n FROM invoices').get().n,
  invoice_items: db.prepare('SELECT COUNT(*) n FROM invoice_items').get().n,
  payments: db.prepare('SELECT COUNT(*) n FROM payments').get().n,
  visit_services: db.prepare('SELECT COUNT(*) n FROM visit_services').get().n,
  lab_results: db.prepare('SELECT COUNT(*) n FROM lab_results').get().n,
});

test('два филиала: связывание, перенос справочника и всё, что должно пойти не так', async (t) => {
  // Оба каталога данных лицензированы одним и тем же временным ключом:
  // licensedDataDir() выдаёт новый ключ на каждый вызов, поэтому второй
  // каталог получается копированием файлов первого, а не вторым вызовом —
  // иначе лицензия первой установки перестала бы проверяться.
  const secDir = licensedDataDir();
  const mainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-branch-main-'));
  for (const f of ['control.json', 'licence.dat']) fs.copyFileSync(path.join(secDir, f), path.join(mainDir, f));

  const dbMain = install(mainDir, 'main');
  seedMain(dbMain);
  const main = await listen(dbMain, mainDir);

  const dbSec = install(secDir, 'sec');
  // Автоинкремент разведён намеренно: если бы перенос копировал чужие id,
  // совпадение ниже было бы случайным и тест ничего бы не доказал.
  dbSec.prepare("UPDATE sqlite_sequence SET seq = 700 WHERE name = 'services'").run();

  // Вторичная установка поднимается ПОЗЖЕ, уже после того как у главного взят
  // ключ: её createApp() перекладывает единственный на процесс getDataDir()
  // на свой каталог, и branch_sync_make_key после этого записал бы файл пары
  // не туда. В клинике это две разные машины и вопроса не возникает — здесь
  // порядок и есть замена двум машинам.
  let sec = null;
  let secCookie = null;

  t.after(async () => {
    if (sec) await shutdown(sec.server);
    await shutdown(main.server);
    dbSec.close();
    dbMain.close();
    fs.rmSync(mainDir, { recursive: true, force: true });
    fs.rmSync(secDir, { recursive: true, force: true });
  });

  const mainCookie = await login(main.base);

  let key = null;

  await t.test('пока филиал никем не назначен, раздачи справочника нет', async () => {
    const res = await fetch(main.base + CATALOGUE_PATH);
    assert.equal(res.status, 404, 'наличие роли не должно быть видно тому, кто щупает порт');
  });

  await t.test('главный филиал выдаёт ключ подключения', async () => {
    // ВАЖНО: вызывается ДО поднятия RPC вторичного филиала в этом процессе —
    // см. заголовок файла про единственный getDataDir() на процесс.
    const r = await rpc(main.base, mainCookie, 'branch_sync_make_key', { url: main.base });
    assert.equal(r.status, 200, JSON.stringify(r.error));
    assert.equal(r.data.role, 'main');
    assert.match(r.data.key, /^EMB1-/);
    key = r.data.key;
    assert.equal(readPairing(mainDir).role, 'main');
  });

  await t.test('раздача справочника закрыта для того, кто не знает секрета', async () => {
    const bare = await fetch(main.base + CATALOGUE_PATH);
    assert.equal(bare.status, 401, 'без подписи — отказ');

    const ts = String(Date.now());
    const forged = await fetch(main.base + CATALOGUE_PATH, {
      headers: {
        'x-em-branch-group': readPairing(mainDir).group_id,
        'x-em-branch-ts': ts,
        'x-em-branch-sig': signRequest({ secret: 'подобранный-секрет', groupId: readPairing(mainDir).group_id, ts, requestPath: CATALOGUE_PATH }),
      },
    });
    assert.equal(forged.status, 401, 'подпись на чужом секрете не должна подходить');
  });

  await t.test('по сети едет справочник и НИ ОДНОГО клинического байта', async () => {
    const pairing = readPairing(mainDir);
    const ts = String(Date.now());
    const res = await fetch(main.base + CATALOGUE_PATH, {
      headers: {
        'x-em-branch-group': pairing.group_id,
        'x-em-branch-ts': ts,
        'x-em-branch-sig': signRequest({ secret: pairing.secret, groupId: pairing.group_id, ts, requestPath: CATALOGUE_PATH }),
      },
    });
    assert.equal(res.status, 200);
    const wire = await res.text();
    // Маркер посажен в имя пациента, в жалобы, в номер счёта, в описание
    // строки счёта и в примечание к анализу. Проверяется ВЕСЬ переданный текст.
    assert.equal(wire.includes(MARKER), false, 'клинические данные не должны уходить из клиники');
    const body = JSON.parse(wire);
    assert.equal(body.ok, true);
    assert.ok(body.catalogue.services.some((s) => s.code === 'S-CARD'));
    for (const t2 of ['patients', 'visits', 'invoices', 'invoice_items', 'payments', 'lab_results', 'visit_services']) {
      assert.equal(t2 in body.catalogue, false, t2 + ' не входит в Этап 1');
    }
  });

  await t.test('вторичный филиал принимает ключ', async () => {
    sec = await listen(dbSec, secDir);
    secCookie = await login(sec.base);
    const r = await rpc(sec.base, secCookie, 'branch_sync_pair', { key });
    assert.equal(r.status, 200, JSON.stringify(r.error));
    assert.equal(r.data.role, 'secondary');
    assert.equal(readPairing(secDir).main_url, main.base);
  });

  await t.test('первая синхронизация: справочник приехал, клиника — нет', async () => {
    const before = clinicalCounts(dbSec);
    const r = await rpc(sec.base, secCookie, 'branch_sync_now');
    assert.equal(r.status, 200, JSON.stringify(r.error));
    assert.equal(r.data.ok, true, JSON.stringify(r.data));
    assert.ok(r.data.changed > 0);

    const card = dbSec.prepare("SELECT * FROM services WHERE code='S-CARD'").get();
    assert.ok(card, 'услуга главного филиала должна появиться');
    assert.equal(card.price, 250000);
    assert.ok(card.id > 700, 'id выдала принимающая база, чужой не переносился');
    const cat = dbSec.prepare("SELECT * FROM service_categories WHERE code='CARD'").get();
    assert.equal(card.category_id, cat.id, 'ссылка переведена на местную категорию');

    const panel = dbSec.prepare("SELECT * FROM lab_panels WHERE code='P-BIO'").get();
    assert.ok(panel);
    const glu = dbSec.prepare("SELECT * FROM lab_panel_analytes WHERE code='GLU'").get();
    assert.equal(glu.panel_id, panel.id);
    assert.equal(glu.ref_high, 5.9, 'референсные значения — часть панели');

    assert.equal(dbSec.prepare('SELECT clinic_name FROM doc_settings WHERE id=1').get().clinic_name, 'Клиника Луч');

    // Главное отрицательное утверждение всего этапа.
    assert.deepEqual(clinicalCounts(dbSec), before, 'ни одна клиническая строка не должна была приехать');
    assert.equal(before.patients, 0);

    // И резервная копия перед изменением справочника действительно снята.
    assert.equal(backups(secDir).filter((f) => f.startsWith('safety-')).length, 1,
      'перед приёмом справочника снимается копия базы (services/backup.js)');
  });

  await t.test('вторая синхронизация ничего не делает и не снимает копию', async () => {
    const beforeBackups = backups(secDir).length;
    const beforeServices = dbSec.prepare('SELECT COUNT(*) n FROM services').get().n;

    const r = await rpc(sec.base, secCookie, 'branch_sync_now');
    assert.equal(r.data.ok, true);
    assert.equal(r.data.changed, 0, 'повторный запуск обязан быть пустышкой');
    assert.equal(dbSec.prepare('SELECT COUNT(*) n FROM services').get().n, beforeServices, 'прайс не удвоился');
    assert.equal(backups(secDir).length, beforeBackups, 'копия ради ничего не снимается');
  });

  await t.test('изменение цены в главном филиале доезжает следующим запуском', async () => {
    dbMain.prepare("UPDATE services SET price = 320000 WHERE code='S-CARD'").run();
    const r = await rpc(sec.base, secCookie, 'branch_sync_now');
    assert.equal(r.data.ok, true);
    assert.equal(r.data.updated.services, 1);
    assert.equal(dbSec.prepare("SELECT price FROM services WHERE code='S-CARD'").get().price, 320000);
  });

  await t.test('неверный секрет: отказ, и принимающая база не тронута', async () => {
    const good = readPairing(secDir);
    writePairing(secDir, { ...good, secret: 'подменённый-секрет' });
    const snapshot = dbSec.prepare('SELECT id, code, price FROM services ORDER BY id').all();
    const beforeBackups = backups(secDir).length;

    const r = await rpc(sec.base, secCookie, 'branch_sync_now');
    assert.equal(r.status, 200, 'отказ главного филиала — это ответ, а не 500');
    assert.equal(r.data.ok, false);
    assert.equal(r.data.reason, 'unauthorized');
    assert.match(r.data.message, /ключ/i, 'владельцу должно быть понятно, что чинить');

    assert.deepEqual(dbSec.prepare('SELECT id, code, price FROM services ORDER BY id').all(), snapshot);
    assert.equal(backups(secDir).length, beforeBackups);
    writePairing(secDir, good);
  });

  await t.test('часы разъехались: отдельная причина, а не «неверный ключ»', async () => {
    const pairing = readPairing(mainDir);
    const ts = String(Date.now() - 60 * 60 * 1000);   // час назад
    const res = await fetch(main.base + CATALOGUE_PATH, {
      headers: {
        'x-em-branch-group': pairing.group_id,
        'x-em-branch-ts': ts,
        'x-em-branch-sig': signRequest({ secret: pairing.secret, groupId: pairing.group_id, ts, requestPath: CATALOGUE_PATH }),
      },
    });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.code, 'clock_skew');
  });

  await t.test('статус экрана рассказывает и про успех, и про последнюю неудачу', async () => {
    const r = await rpc(sec.base, secCookie, 'branch_sync_status');
    assert.equal(r.status, 200);
    assert.equal(r.data.role, 'secondary');
    assert.equal(r.data.main_url, main.base);
    assert.ok(r.data.last_ok?.at, 'дата последней УДАВШЕЙСЯ синхронизации');
    assert.ok(r.data.last_attempt?.at);
    assert.equal(JSON.stringify(r.data).includes(readPairing(secDir).secret), false,
      'секрет не должен уходить на экран — статус читают все, кому открыты настройки');
  });

  // BRANCH_SYNC_HOURLY_V1 — правило ПЕРЕВЁРНУТО, осознанно.
  //
  // Раньше здесь проверялось, что медсестра получает 403. Решение владельца
  // 2026-09-02: кнопка «Синхронизация» появляется в окне регистратуры и
  // лаборатории, то есть у людей без прав администратора. Отдавать им это
  // безопасно ровно потому, что ровно то же самое каждый час выполняют часы
  // (schedule-pull.js) вообще без человека: кнопка не даёт новых возможностей,
  // она лишь избавляет от ожидания до следующего часа.
  //
  // Граница осталась и проверяется здесь же: НАСТРОЙКА связи по-прежнему
  // администраторская. Подтянуть справочник — можно всем вошедшим; отвязать
  // филиал — нельзя.
  await t.test('синхронизировать может любой сотрудник, настраивать связь — нет', async () => {
    dbSec.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)')
      .run('nurse1', hashPassword('password1'), 'Nurse', 'nurse');
    const res = await fetch(sec.base + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'nurse1', password: 'password1' }),
    });
    const nurseCookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');

    const sync = await rpc(sec.base, nurseCookie, 'branch_sync_now');
    assert.notEqual(sync.status, 403, 'медсестре не нужен админ, чтобы подтянуть данные');

    const unpair = await rpc(sec.base, nurseCookie, 'branch_sync_unpair');
    assert.equal(unpair.status, 403, 'а вот отвязать филиал — по-прежнему только администратор');
  });

  await t.test('главный филиал выключен: честный отказ, база не тронута', async () => {
    const snapshot = dbSec.prepare('SELECT id, code, price FROM services ORDER BY id').all();
    const beforeBackups = backups(secDir).length;
    await shutdown(main.server);

    const r = await rpc(sec.base, secCookie, 'branch_sync_now');
    assert.equal(r.status, 200, 'офлайн — это норма, а не ошибка сервера');
    assert.equal(r.data.ok, false);
    assert.equal(r.data.reason, 'offline');
    assert.match(r.data.message, /связи/i);

    assert.deepEqual(dbSec.prepare('SELECT id, code, price FROM services ORDER BY id').all(), snapshot);
    assert.equal(backups(secDir).length, beforeBackups);

    // Экран должен уметь показать «получилось вчера, сегодня нет связи».
    const st = await rpc(sec.base, secCookie, 'branch_sync_status');
    assert.equal(st.data.last_attempt.ok, false);
    assert.equal(st.data.last_ok.ok, true);
  });

  await t.test('«Отвязать» рвёт связь, но оставляет приехавший справочник', async () => {
    const r = await rpc(sec.base, secCookie, 'branch_sync_unpair');
    assert.equal(r.data.ok, true);
    assert.equal(readPairing(secDir), null);
    assert.equal(dbSec.prepare('SELECT COUNT(*) n FROM branch_sync_map').get().n, 0);
    assert.ok(dbSec.prepare("SELECT 1 FROM services WHERE code='S-CARD'").get(),
      'услуги, по которым филиал уже работает, никуда не деваются');

    const after = await rpc(sec.base, secCookie, 'branch_sync_now');
    assert.equal(after.data.ok, false);
    assert.equal(after.data.reason, 'not_paired');
  });
});

// Классификация в control/gate.js — часть контракта, а не деталь: она решает,
// что видит и чего не может клиника с просроченной лицензией. Правило шлюза
// «всё незаписанное считается записью» работает молча, поэтому намерение
// закрепляется здесь явно.
test('лицензионный шлюз: смотреть можно всегда, принимать справочник — нет', () => {
  assert.equal(isReadOnlyRpc('branch_sync_status'), true,
    'заблокированная клиника обязана видеть, почему справочник не приезжает');
  assert.equal(isAlwaysAllowedRpc('branch_sync_status'), false);
  // BRANCH_SYNC_RELAY_V1 — три вызова Маршрута Б стоят в том же ряду: согласие
  // на выгрузку и перевыпуск ключа пишут на диск, ручная выгрузка ведёт наружу
  // от имени клиники. Ни один не должен работать сквозь блокировку лицензии.
  for (const name of ['branch_sync_now', 'branch_sync_pair', 'branch_sync_make_key', 'branch_sync_unpair',
    'branch_sync_relay_set', 'branch_sync_relay_publish', 'branch_sync_regenerate_key']) {
    assert.equal(isReadOnlyRpc(name), false, name + ' пишет в базу или на диск');
    assert.equal(isAlwaysAllowedRpc(name), false, name + ' не должен проходить сквозь блокировку');
  }
});
