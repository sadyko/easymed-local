// BRANCH_RECORDS_V1 (Задача 7) — ЗАПИСИ ЕЗДЯТ ПО РЕЛЕЮ: сеть из четырёх зданий,
// настоящая контрольная панель поставщика, настоящий HTTP, настоящие токены.
//
// Здесь проверяется ОБЕЩАНИЕ ВСЕЙ ФАЗЫ, а не транспорт: пациент, заведённый в
// одном филиале, обязан появиться в другом — и появиться через сервер
// поставщика, потому что здания на разных каналах друг друга не видят. Ничего
// не подменено: своя база и свой каталог данных у каждого узла, свои миграции,
// реальный fetch, реальное AES-256-GCM, реальный реестр клиник и реальная
// проверка области токена на той стороне.
//
// ПОЧЕМУ ЗДЕСЬ НЕТ HTTP-СЕРВЕРОВ КЛИНИК. services/control/config.js хранит
// каталог данных ОДНИМ значением на процесс, и его выставляет createApp(). Три
// установки в одном процессе означали бы три перекрывающих друг друга
// createApp; вместо этого сервисы вызываются с ЯВНЫМ каталогом (они его
// принимают параметром именно за этим), а перед runBranchSync — который читает
// getDataDir() — каталог переключается setDataDir(). Так же переключается он и
// в жизни: у каждой установки он свой.
//
// ГЛАВНЫЙ ФИЛИАЛ ЗДЕСЬ ВЫКЛЮЧЕН как HTTP-узел (main_url ведёт в закрытый порт),
// и это не упрощение, а ровно тот случай, ради которого Маршрут Б построен:
// прямой путь не удался — справочник и журналы едут через сервер поставщика.
//
// КРУГ — ЭТО ЧАСОВОЙ ТАКТ ВСЕЙ СЕТИ. Узлы синхронизируются здесь по очереди и
// ВСЕ, а не выборочно, потому что так это и работает вживую. Но пропустить
// такт с Задачи 7b не значит потерять работу: блоб узла по-прежнему один и
// замещается следующей выгрузкой, зато срез собирается от ПОДТВЕРЖДЁННОГО
// соседом горизонта и повторяет неподтверждённое, пока квитанция не придёт
// (см. заголовок publishJournal в relay.js и три теста про доставку ниже).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { setDataDir } from '../control/config.js';
import { writePairing, readPairing, encodeKey, pairWithKey, b64url, GROUP_KEY_BYTES } from './pairing.js';
import { mintRelayToken, publishCatalogue, fetchCatalogue, publishJournal, fetchJournals } from './relay.js';
import { applyCatalogue } from './catalogue.js';
import { buildBatch } from './journal.js';
import { runBranchSync } from '../rpc/branch-sync.js';

import { openDb as openCpDb } from '../../../control-plane/server/db/connection.js';
import { migrate as migrateCp } from '../../../control-plane/server/db/migrate.js';
import { createApp as createCpApp } from '../../../control-plane/server/app.js';
import { createEnrollmentCode, redeemEnrollmentCode } from '../../../control-plane/server/services/enrollment.js';

// Порт, на котором заведомо никто не слушает: прямой путь обязан отказать
// быстро (ECONNREFUSED), а не ждать таймаута.
const CLOSED_MAIN = 'http://127.0.0.1:1';

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function shutdown(server) {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

/** Каталог данных + база одной установки. */
function install(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-rec-' + tag + '-'));
  const db = openDb(path.join(dir, tag + '.db'));
  migrate(db);
  return { dir, db, tag };
}

/** Синхронизация ОТ ИМЕНИ узла: тот же вызов, что делает кнопка и часы. */
async function syncAt(node) {
  setDataDir(node.dir);
  return runBranchSync(node.db);
}

const count = (db, table) => db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
const patientNames = (db) => db.prepare('SELECT full_name FROM patients ORDER BY full_name').all().map((r) => r.full_name);
const shape = (db) => ({
  patients: patientNames(db),
  visits: count(db, 'visits'),
  visit_services: count(db, 'visit_services'),
  lab_results: count(db, 'lab_results'),
});

test('BRANCH_RECORDS_V1: пациенты и лабораторная очередь ездят между филиалами через релей', async (t) => {
  // --- поставщик ----------------------------------------------------------
  const cpDb = openCpDb(':memory:');
  migrateCp(cpDb);
  const cp = await listen(createCpApp(cpDb));
  // ОДНА активация на всю сеть — у главной клиники. Филиалы у поставщика не
  // активированы и активированы не будут: они подключались к клинике.
  const installToken = redeemEnrollmentCode(cpDb, {
    code: createEnrollmentCode(cpDb, { clinicId: 'cp-net', name: 'Сеть' }),
  }).install_token;

  const prevControlUrl = process.env.EASYMED_CONTROL_URL;
  process.env.EASYMED_CONTROL_URL = cp.base;

  // --- главная клиника A --------------------------------------------------
  const A = install('a');
  const groupKey = b64url(randomBytes(GROUP_KEY_BYTES));
  fs.writeFileSync(path.join(A.dir, 'control.json'),
    JSON.stringify({ clinic_id: 'cp-net', install_token: installToken }));
  writePairing(A.dir, {
    role: 'main',
    group_id: 'BR-REC0000001',
    secret: 'ssssssssssssssssssssssssssssssss',
    main_url: CLOSED_MAIN,
    group_key: groupKey,
    relay: true,   // согласие владельца: по этому каналу поедут пациенты
  });

  // Справочник главной клиники и список сети. Строка A уже есть (миграция 080).
  A.db.prepare("UPDATE branches SET name = 'Главная' WHERE letter = 'A'").run();
  for (const [name, letter] of [['Чиланзар', 'B'], ['Юнусабад', 'C'], ['Сергели', 'E']]) {
    A.db.prepare('INSERT INTO branches (name, letter) VALUES (?, ?)').run(name, letter);
  }
  A.db.prepare("INSERT INTO service_categories (name, code) VALUES ('Лаборатория','LAB')").run();
  A.db.prepare(`INSERT INTO services (name, code, price, type, category_id, active)
                VALUES ('Общий анализ крови','S-OAK',35000,'lab',1,1)`).run();

  const nodes = [A];
  t.after(async () => {
    await shutdown(cp.server);
    cpDb.close();
    for (const n of nodes) {
      n.db.close();
      fs.rmSync(n.dir, { recursive: true, force: true });
    }
    if (prevControlUrl === undefined) delete process.env.EASYMED_CONTROL_URL;
    else process.env.EASYMED_CONTROL_URL = prevControlUrl;
  });

  /** Завести филиал: выписать ему учётку у поставщика и связать ключом. */
  async function enrol(tag, letter, name) {
    const minted = await mintRelayToken(A.dir, { letters: ['A', 'B', 'C', 'D', 'E'] });
    assert.equal(minted.ok, true, 'учётку филиалу выписывает главная клиника: ' + JSON.stringify(minted));
    const node = install(tag);
    const key = encodeKey({ ...readPairing(A.dir), letter, relay_token: minted.token, branch_name: name });
    const paired = pairWithKey(node.dir, key, { db: node.db });
    assert.equal(paired.ok, true, JSON.stringify(paired));
    assert.equal(paired.identity.letter, letter, 'филиал обязан принять свою букву');
    // Учётки у поставщика у филиала нет и быть не должно — только токен из ключа.
    assert.equal(fs.existsSync(path.join(node.dir, 'control.json')), false);
    nodes.push(node);
    return node;
  }

  const B = await enrol('b', 'B', 'Чиланзар');
  const C = await enrol('c', 'C', 'Юнусабад');

  // Часовой такт сети: порядок один и тот же, участвуют все.
  const round = async () => { for (const n of [B, C, A]) await syncAt(n); };

  await t.test('главная клиника выкладывает справочник — филиалы узнают друг о друге', async () => {
    assert.equal((await publishCatalogue(A.db, A.dir)).ok, true);

    // Первая синхронизация каждого филиала: прямой путь отказывает (главная
    // недоступна), справочник приезжает релеем.
    for (const node of [B, C]) {
      const r = await syncAt(node);
      assert.equal(r.ok, true, node.tag + ': ' + JSON.stringify(r));
      assert.equal(r.route, 'relay', 'прямой путь закрыт — работает резервный');
    }

    // БЕЗ ЭТОГО ФАЗА НЕ РАБОТАЕТ В СЕТИ БОЛЬШЕ ДВУХ ЗДАНИЙ. Филиал заводит
    // только свою строку и знает засеянную строку главной; про соседей он
    // узнаёт из списка сети в справочнике, а адрес журнала соседа выводится
    // из его БУКВЫ.
    assert.deepEqual(
      B.db.prepare("SELECT letter FROM branches WHERE letter IS NOT NULL AND letter <> '' ORDER BY letter").all().map((r) => r.letter),
      ['A', 'B', 'C', 'E'],
      'филиал B обязан узнать буквы соседей — иначе журнал C он не прочитает никогда',
    );
    assert.equal(B.db.prepare("SELECT active FROM branches WHERE letter = 'C'").get().active, 0,
      'чужое здание не становится рабочим местом этой установки');
    assert.equal(B.db.prepare("SELECT price FROM services WHERE code = 'S-OAK'").get().price, 35000);
  });

  await t.test('пациент, заведённый в B, появляется в C — и подписан буквой B', async () => {
    B.db.prepare("INSERT INTO patients (full_name, phone) VALUES ('Иванов', '+998901112233')").run();
    const mrn = B.db.prepare("SELECT mrn FROM patients WHERE full_name = 'Иванов'").get().mrn;
    assert.match(mrn, /^B-/, 'номер выдан этим зданием');

    const sent = await syncAt(B);
    assert.equal(sent.records.published.C >= 1, true, 'срез для C обязан уехать: ' + JSON.stringify(sent.records));

    const got = await syncAt(C);
    assert.equal(got.records.fetched.B.applied >= 1, true, JSON.stringify(got.records));
    await syncAt(A);

    const p = C.db.prepare("SELECT phone, sync_origin, mrn FROM patients WHERE full_name = 'Иванов'").get();
    assert.ok(p, 'пациент обязан доехать');
    assert.equal(p.phone, '+998901112233');
    assert.equal(p.sync_origin, 'B', 'на строке видно, откуда она — не по MRN, а по метке происхождения');
    assert.equal(p.mrn, mrn, 'номер не перевыдаётся: он напечатан на карточке');
  });

  await t.test('лабораторная очередь: услуга и результат доезжают вместе с визитом', async () => {
    const pid = B.db.prepare("SELECT id FROM patients WHERE full_name = 'Иванов'").get().id;
    const sid = B.db.prepare("SELECT id FROM services WHERE code = 'S-OAK'").get().id;
    const vid = B.db.prepare("INSERT INTO visits (patient_id, visit_date, status) VALUES (?, '2026-09-02', 'arrived')")
      .run(pid).lastInsertRowid;
    const vsid = B.db.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, status) VALUES (?,?,1,'ordered')")
      .run(vid, sid).lastInsertRowid;
    B.db.prepare("INSERT INTO lab_results (visit_service_id, parameter, value, unit) VALUES (?, 'Гемоглобин', '132', 'г/л')")
      .run(vsid);

    await round();

    for (const node of [C, A]) {
      const row = node.db.prepare(`
        SELECT vs.status, s.code, lr.parameter, lr.value
          FROM visit_services vs
          JOIN services s ON s.id = vs.service_id
          JOIN lab_results lr ON lr.visit_service_id = vs.id
      `).get();
      assert.ok(row, node.tag + ': строка очереди обязана доехать целиком');
      assert.equal(row.status, 'ordered', 'очередь строится на статусе');
      // Ссылка на справочник едет ПО КОДУ услуги: локальные id у филиалов разные.
      assert.equal(row.code, 'S-OAK');
      assert.equal(row.parameter, 'Гемоглобин', 'без имени аналита панель схлопывается в одно безымянное число');
      assert.equal(row.value, '132');
    }
  });

  await t.test('правки в разрыве связи: телефон в B, адрес в C — выживают ОБА', async () => {
    // Главный инвариант фазы. Каждый узел правит СВОЮ колонку, не зная о другом.
    B.db.prepare("UPDATE patients SET phone = '+998909998877' WHERE full_name = 'Иванов'").run();
    C.db.prepare("UPDATE patients SET address = 'Ташкент, Юнусабад' WHERE full_name = 'Иванов'").run();

    await round();
    await round();

    const inB = B.db.prepare("SELECT phone, address FROM patients WHERE full_name = 'Иванов'").get();
    const inC = C.db.prepare("SELECT phone, address FROM patients WHERE full_name = 'Иванов'").get();
    assert.deepEqual(inB, inC, 'две базы обязаны сойтись к одному состоянию');
    assert.equal(inB.phone, '+998909998877', 'правка B не потеряна');
    assert.equal(inB.address, 'Ташкент, Юнусабад', 'правка C не потеряна');
  });

  await t.test('главная клиника — такой же узел: работа филиалов видна и в ней', async () => {
    const r = await syncAt(A);
    // Справочник главная не забирает (ей не у кого), а записи — забирает.
    assert.equal(r.reason, 'not_secondary', 'шаг справочника у главной по-прежнему не при делах');
    assert.ok(r.records, 'обмен записями обязан произойти и здесь: ' + JSON.stringify(r));
    const p = A.db.prepare("SELECT phone, address, sync_origin FROM patients WHERE full_name = 'Иванов'").get();
    assert.ok(p, 'пациент филиала обязан быть виден владельцу в главной клинике');
    assert.equal(p.phone, '+998909998877');
    assert.equal(p.address, 'Ташкент, Юнусабад', 'правка второго филиала доехала до главной тоже');
    assert.equal(p.sync_origin, 'B');
    assert.equal(count(A.db, 'lab_results'), 1);
  });

  await t.test('филиал, который ни разу не выгружался, не мешает остальным', async () => {
    // Филиал E заведён в списке сети, но его компьютер ещё не включали. Это
    // самый обычный случай в первый день, и он не должен выглядеть поломкой.
    const r = await syncAt(B);
    assert.equal(r.records.fetched.E.reason, 'relay_empty', JSON.stringify(r.records.fetched));
    assert.equal('reason' in r.records.fetched.C, false, 'сосед C от молчания E не пострадал');
    assert.equal('reason' in r.records.fetched.A, false, 'и главная тоже');
  });

  await t.test('деньги не уезжают: счетов у соседей не появляется', async () => {
    const pid = B.db.prepare("SELECT id FROM patients WHERE full_name = 'Иванов'").get().id;
    B.db.prepare("INSERT INTO invoices (invoice_number, patient_id, total_amount, status) VALUES ('B-INV-1', ?, 35000, 'unpaid')")
      .run(pid);
    await round();
    for (const node of [A, C]) {
      assert.equal(count(node.db, 'invoices'), 0, node.tag + ': счета — Фаза 3');
      assert.equal(count(node.db, 'invoice_items'), 0);
    }
  });

  await t.test('повторная синхронизация ничего не меняет и ничего не дублирует', async () => {
    const before = [A, B, C].map((n) => shape(n.db));
    await round();
    await round();
    assert.deepEqual([A, B, C].map((n) => shape(n.db)), before, 'приём обязан быть идемпотентным');
    for (const node of [A, B, C]) {
      assert.equal(count(node.db, 'sync_pending'), 0, node.tag + ': ничего не должно висеть в ожидании родителя');
    }
  });

  await t.test('филиал D, подключённый месяцем позже, получает ВСЁ — страницами', async () => {
    // Холодный засев: у D нет ни одной строки, а журнал B давно вычищен по
    // отметкам отправленного. Засев идёт из самих таблиц, страницами, и
    // страницы доезжают за НЕСКОЛЬКО выгрузок — так это и происходит на узком
    // канале большой клиники.
    A.db.prepare("INSERT INTO branches (name, letter) VALUES ('Мирзо-Улугбек', 'D')").run();
    assert.equal((await publishCatalogue(A.db, A.dir)).ok, true);
    const D = await enrol('d', 'D', 'Мирзо-Улугбек');

    // Справочник обоим: B узнаёт букву D, D узнаёт услуги (без них строка
    // лабораторной очереди легла бы в ожидание, а не в очередь).
    for (const node of [B, D]) {
      const cat = await fetchCatalogue(node.dir);
      assert.equal(cat.ok, true, node.tag + ': ' + JSON.stringify(cat));
      applyCatalogue(node.db, cat.catalogue);
    }

    let backups = 0;
    const backupImpl = async () => { backups++; };
    // limit = 2 — страница вдвое меньше самой маленькой порции: засев обязан
    // доехать за несколько кругов, а не потеряться после первого.
    for (let r = 0; r < 8; r++) {
      const pub = await publishJournal(B.db, B.dir, { limit: 2 });
      assert.notEqual(pub.ok, false, 'выгрузка не должна отказывать: ' + JSON.stringify(pub));
      const got = await fetchJournals(D.db, D.dir, { backupImpl });
      assert.equal(got.ok, true, JSON.stringify(got));
    }
    assert.ok(backups > 0, 'перед первым применением обязана сниматься резервная копия');
    assert.equal(B.db.prepare("SELECT seed_floor FROM sync_peers WHERE node = 'D'").get().seed_floor, null,
      'засев филиала D обязан завершиться, а не встать на первой странице');

    assert.deepEqual(patientNames(D.db), ['Иванов'], 'пациент доехал холодным засевом');
    assert.equal(count(D.db, 'visits'), 1, 'и его визит');
    assert.equal(count(D.db, 'visit_services'), 1, 'и его услуга');
    assert.equal(count(D.db, 'lab_results'), 1, 'и её результат');
    assert.equal(count(D.db, 'sync_pending'), 0, 'ничего не осталось ждать родителя');
    assert.equal(count(D.db, 'invoices'), 0, 'счета не едут даже засевом');
    const p = D.db.prepare("SELECT phone, address, sync_origin FROM patients WHERE full_name = 'Иванов'").get();
    assert.equal(p.phone, '+998909998877');
    assert.equal(p.address, 'Ташкент, Юнусабад');
    assert.equal(p.sync_origin, 'B', 'засев подписан отправителем, а не выдуман');
  });

  // ПОДТВЕРЖДЁННАЯ ДОСТАВКА (Задача 7b). Здесь стоял тест, закреплявший
  // ОБРАТНОЕ: «узел, пропустивший выгрузку соседа, её содержимое теряет».
  // Блоб узла по-прежнему один и по-прежнему замещается следующей выгрузкой —
  // изменилось то, что отправитель считает отданным. Отметка «выложено»
  // (pub_seq) и отметка «подтверждено соседом» (sent_seq) разведены, срез
  // собирается от ПОДТВЕРЖДЁННОЙ, и всё неподтверждённое повторяется в каждом
  // следующем блобе. Ночь без связи больше не стоит вечерних анализов.
  await t.test('пропущенная выгрузка не теряется: её содержимое едет в следующем блобе', async () => {
    B.db.prepare("INSERT INTO patients (full_name) VALUES ('Пропущенный')").run();
    await syncAt(B);   // выгрузка №1: в блобе есть «Пропущенный»

    // Вторая выгрузка про ДРУГУЮ таблицу: важно, что не теряется работа, а не
    // что «повторился последний пациент».
    const vsid = B.db.prepare('SELECT id FROM visit_services ORDER BY id LIMIT 1').get().id;
    B.db.prepare("INSERT INTO lab_results (visit_service_id, parameter, value, unit) VALUES (?, 'СОЭ', '7', 'мм/ч')")
      .run(vsid);
    await syncAt(B);   // выгрузка №2 ЗАМЕЩАЕТ блоб; C первую так и не читал

    await syncAt(C);
    const names = patientNames(C.db);
    assert.equal(names.includes('Пропущенный'), true,
      'пропущенная выгрузка обязана доехать со следующей — ради этого вся Задача 7b');
    assert.equal(C.db.prepare("SELECT value FROM lab_results WHERE parameter = 'СОЭ'").get()?.value, '7',
      'и последняя тоже: срез накопительный, а не «вместо»');
  });

  await t.test('квитанция возвращается: отправитель узнаёт, докуда сосед дошёл', async () => {
    // Подтверждение едет в блобе соседа, поэтому нужен ещё один такт: C
    // выкладывает свой блоб с квитанцией, B его забирает.
    await syncAt(C);
    await syncAt(B);

    const ack = C.db.prepare("SELECT recv_upto FROM sync_peers WHERE node = 'B'").get().recv_upto;
    const horizons = B.db.prepare("SELECT pub_seq, sent_seq FROM sync_peers WHERE node = 'C'").get();
    assert.ok(ack > 0, 'C обязан помнить, докуда он применил журнал B');
    assert.equal(horizons.sent_seq, ack,
      'подтверждённый горизонт B по соседу C — это ровно то число, что C прислал в квитанции');
    assert.ok(horizons.pub_seq >= horizons.sent_seq,
      'подтвердить больше выложенного нельзя: квитанция приезжает снаружи и ограничивается pub_seq');
    assert.deepEqual(buildBatch(B.db, { self: 'B', peer: 'C' }).records, [],
      'подтверждённое больше не повторяется: до квитанции срез для C был непустым в каждой выгрузке');
    // Хвост журнала при этом ещё лежит, и это правильно: чистка идёт по
    // МИНИМУМУ подтверждённого по ВСЕМ соседям, а филиал D в этом тесте
    // засеян, но ни разу не выкладывался и потому ничего не подтверждал.
    assert.ok(B.db.prepare('SELECT COUNT(*) n FROM sync_journal').get().n > 0,
      'неподтверждённый соседом хвост держится — иначе повторять было бы нечего');
  });

  await t.test('тот же блоб, забранный второй раз, не применяется заново', async () => {
    let backups = 0;
    const got = await fetchJournals(C.db, C.dir, { backupImpl: async () => { backups++; } });
    assert.equal(got.ok, true, JSON.stringify(got));
    assert.equal(got.peers.B.already, true, 'срез уже разобран: ' + JSON.stringify(got.peers.B));
    assert.equal(got.peers.B.applied, 0);
    assert.equal(backups, 0,
      'ради повтора, который сосед кладёт в каждый блоб, копию базы не снимают — иначе диск клиники завален');
  });

  await t.test('поставщик хранит шифротекст: ни имени пациента, ни телефона', () => {
    const rows = cpDb.prepare('SELECT relay_id, clinic_id, bytes FROM relay_blobs').all();
    assert.ok(rows.length >= 3, 'у каждого узла свой адрес — иначе они затирали бы друг друга');
    assert.equal(new Set(rows.map((r) => r.relay_id)).size, rows.length);
    for (const row of rows) {
      const text = row.bytes.toString('latin1');
      assert.equal(text.includes('Иванов'), false, 'имя пациента не должно покидать клинику читаемым');
      assert.equal(text.includes('998909998877'), false, 'телефон тоже');
      assert.equal(text.includes('patients'), false, 'не читаются даже имена таблиц');
      assert.equal(row.bytes.subarray(0, 4).toString('ascii'), 'EMR1', 'снаружи виден только формат');
    }
  });
});
