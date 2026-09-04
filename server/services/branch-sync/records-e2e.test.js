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
import { buildBatch, markSent } from './journal.js';
// Приём — напрямую: последний тест в файле гоняет ХОЛОДНЫЙ ЗАСЕВ двух зданий
// без релея (дефект живёт в засеве, а не в транспорте).
import { applyBatch } from './records.js';
import { runBranchSync } from '../rpc/branch-sync.js';
// Настоящие денежные RPC, а не INSERT руками: проверяется в том числе номер
// счёта с буквой здания (миграция 088) и запрет на правку чужих денег.
import { createInvoiceForVisit, recordPayment, markInvoiceDebt, removeUnpaidService } from '../rpc/billing.js';

import { openDb as openCpDb } from '../../../control-plane/server/db/connection.js';
import { migrate as migrateCp } from '../../../control-plane/server/db/migrate.js';
import { createApp as createCpApp } from '../../../control-plane/server/app.js';
import { createEnrollmentCode, redeemEnrollmentCode } from '../../../control-plane/server/services/enrollment.js';
import { listen as listenOnFreePort } from '../../../control-plane/server/test-helpers/listen.js';

// Порт, на котором заведомо никто не слушает: прямой путь обязан отказать
// быстро (ECONNREFUSED), а не ждать таймаута.
//
// НЕ ПОРТ 1: он сам стоит в списке WHATWG «bad ports», и fetch() отказывает
// на нём ДО всякой попытки соединения — «bad port» вместо ECONNREFUSED.
// Отказ выглядел так же, поэтому подмена и не замечалась, но проверялся при
// этом не тот путь, ради которого тест написан. 65535 вне списка и вне
// динамического диапазона этой машины (1024-14999), то есть свободен.
const CLOSED_MAIN = 'http://127.0.0.1:65535';

// Порт берётся ОБЩИМ помощником (FETCH_BAD_PORT_V1): fetch() отказывается
// соединяться с портами из списка WHATWG «bad ports», а динамический диапазон
// этой машины (1024-14999) содержит 14 таких. Свой app.listen(0) изредка
// вытягивал именно их, и тест падал с «bad port» — не поломкой кода, а
// невезением. Помощник перетягивает порт заново.
function listen(app) {
  return listenOnFreePort(app).then((server) => ({
    server, base: `http://127.0.0.1:${server.address().port}`,
  }));
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

  // ОБЕЩАНИЕ ФАЗЫ 3, ЦЕЛИКОМ. Здесь стоял тест, закреплявший ОБРАТНОЕ —
  // «счета у соседей не появляются», — и владелец видел ровно это: денежный
  // отчёт главной клиники показывал по филиалам не «мало», а ноль. Теперь счёт,
  // выставленный в филиале настоящей кассой, обязан доехать до главной со
  // своими позициями, платежами и НАСТОЯЩИМ днём выставления — и остаться там
  // неприкосновенным.
  await t.test('деньги едут: счёт филиала виден в главной клинике, и править его оттуда нельзя', async () => {
    // Регистратор и кассир филиала: created_by и cashier_id — настоящие внешние
    // ключи, и без строк в users счёт не выписать.
    B.db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (91,'reg-b','x','registrar')").run();
    B.db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (92,'cash-b','x','cashier')").run();
    const regB = { id: 91, role: 'registrar' };
    const cashB = { id: 92, role: 'cashier' };

    const vid = B.db.prepare('SELECT id FROM visits ORDER BY id LIMIT 1').get().id;
    const sid = B.db.prepare("SELECT id FROM services WHERE code = 'S-OAK'").get().id;
    const vs1 = B.db.prepare('SELECT id FROM visit_services ORDER BY id LIMIT 1').get().id;
    const vs2 = B.db.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, status) VALUES (?,?,1,'ordered')")
      .run(vid, sid).lastInsertRowid;

    const made = createInvoiceForVisit(B.db, { visit_id: vid, visit_service_ids: [vs1, vs2] }, regB);
    assert.match(made.invoice.invoice_number, /^INV-B-\d{2}-\d{5}$/,
      'номер несёт букву здания: без неё главная чеканит такой же и отвергает приехавший по UNIQUE');
    assert.equal(made.items.length, 2);
    assert.equal(made.invoice.total_amount, 70000);
    recordPayment(B.db, { invoice_id: made.invoice.id, amount: 35000, method: 'cash' }, cashB);

    await round();
    await round();

    for (const node of [A, C]) {
      const inv = node.db.prepare('SELECT * FROM invoices WHERE invoice_number = ?').get(made.invoice.invoice_number);
      assert.ok(inv, node.tag + ': счёт филиала обязан доехать — иначе денежный отчёт главной показывает ноль');
      assert.equal(inv.sync_origin, 'B', node.tag + ': на строке видно, чьё это здание');
      assert.equal(inv.total_amount, 70000, node.tag);
      assert.equal(inv.status, 'partial', node.tag + ': статус — решение кассы, и он едет как есть');
      assert.equal(inv.created_at, made.invoice.created_at,
        node.tag + ': день выставления настоящий, а не день доставки — иначе отчёт бьётся не тем днём');
      assert.equal(node.db.prepare('SELECT COUNT(*) n FROM invoice_items WHERE invoice_id = ?').get(inv.id).n, 2,
        node.tag + ': обе позиции счёта');
      assert.equal(node.db.prepare('SELECT COALESCE(SUM(amount),0) s FROM payments WHERE invoice_id = ?').get(inv.id).s,
        35000, node.tag + ': платёж');
      assert.equal(inv.paid_amount, 35000,
        node.tag + ': оплачено ровно столько, сколько платежей сюда доехало — сумма считается здесь, а не приезжает');

      // Локальные ссылки соседа сюда не приехали, и отчёт обязан это знать.
      assert.equal(inv.created_by, null, node.tag + ': id пользователя соседа указывал бы в пустоту');
      assert.equal(inv.branch_id, null, node.tag + ': «здание» считается по sync_origin, а не по внутреннему branch_id');
      const pay = node.db.prepare('SELECT * FROM payments WHERE invoice_id = ?').get(inv.id);
      assert.equal(pay.cashier_id, null, node.tag + ': имени кассира чужого здания в отчёте не будет — и это честно');
      assert.equal(pay.shift_id, null, node.tag + ': смена кассы остаётся в своём здании');
      assert.equal(pay.method, 'cash', node.tag + ': а способ оплаты кассовому отчёту нужен, и он едет');
    }

    // ПРАВИТЬ ЧУЖИЕ ДЕНЬГИ ОТСЮДА НЕЛЬЗЯ. Главная их видит — за этим они и
    // едут, — но касса, взявшая их, стоит в филиале.
    A.db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (93,'cash-a','x','cashier')").run();
    const cashA = { id: 93, role: 'cashier' };
    const invA = A.db.prepare('SELECT * FROM invoices WHERE invoice_number = ?').get(made.invoice.invoice_number);
    const vsA = A.db.prepare("SELECT id FROM visit_services WHERE sync_origin = 'B' ORDER BY id LIMIT 1").get().id;
    assert.throws(() => recordPayment(A.db, { invoice_id: invA.id, amount: 1000 }, cashA), /Чиланзар \(B\)/,
      'две несовместимые правды об одной сумме — это и есть потеря денег');
    assert.throws(() => markInvoiceDebt(A.db, { invoice_id: invA.id }, cashA), /Чиланзар \(B\)/);
    assert.throws(() => removeUnpaidService(A.db, { visit_service_id: vsA }, { id: 93, role: 'admin' }), /Чиланзар \(B\)/,
      'удаление здесь означало бы надгробие в журнале — строка исчезла бы и в филиале');
    assert.equal(A.db.prepare('SELECT paid_amount FROM invoices WHERE id = ?').get(invA.id).paid_amount, 35000,
      'ни один отказ не тронул сумму');
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
    // limit = 2 — по две строки на страницу: засев обязан доехать за несколько
    // кругов. Число это теперь и вправду соблюдается (ревью, I3): раньше его
    // молча поднимали до 100, и «постраничный» засев уезжал одной выгрузкой.
    //
    // КРУГ ЗДЕСЬ ПОЛНЫЙ, с квитанцией: страница засева подтверждается номером,
    // и без выгрузки D (в ней и едет квитанция) курсор B не сдвинется. Это не
    // усложнение теста, а то, как теперь работает доставка.
    //
    // НА ВТОРОМ КРУГЕ D ВЫКЛЮЧЕН — то самое, ради чего всё и делалось: блоб B
    // замещается следующей выгрузкой, и раньше эта страница пропала бы у D
    // навсегда. Теперь неподтверждённая страница уезжает снова.
    let done = 0;
    let pages = 0;
    for (let r = 0; r < 14 && !done; r++) {
      const pub = await publishJournal(B.db, B.dir, { limit: 2 });
      assert.notEqual(pub.ok, false, 'выгрузка не должна отказывать: ' + JSON.stringify(pub));
      if (r === 1) continue;   // D выключен: чужой блоб он не забирает

      const got = await fetchJournals(D.db, D.dir, { backupImpl });
      assert.equal(got.ok, true, JSON.stringify(got));
      await publishJournal(D.db, D.dir, {});          // в блобе D едет квитанция
      await fetchJournals(B.db, B.dir, { backupImpl });   // B её забирает

      const peer = B.db.prepare("SELECT seed_floor, seed_page FROM sync_peers WHERE node = 'D'").get();
      pages = Math.max(pages, peer.seed_page);
      if (peer.seed_floor === null) done = r + 1;
    }
    assert.ok(backups > 0, 'перед первым применением обязана сниматься резервная копия');
    assert.ok(done > 0, 'засев филиала D обязан завершиться, а не встать на первой странице');
    assert.ok(pages >= 2, 'при limit = 2 засев обязан занять НЕСКОЛЬКО страниц, иначе тест ничего не проверяет; страниц: ' + pages);
    assert.equal(B.db.prepare("SELECT seed_floor FROM sync_peers WHERE node = 'D'").get().seed_floor, null,
      'подтверждённый до конца засев закрывается');

    assert.deepEqual(patientNames(D.db), ['Иванов'], 'пациент доехал холодным засевом');
    assert.equal(count(D.db, 'visits'), 1, 'и его визит');
    assert.equal(count(D.db, 'visit_services'), 2, 'и обе его услуги');
    assert.equal(count(D.db, 'lab_results'), 1, 'и её результат');
    assert.equal(count(D.db, 'sync_pending'), 0, 'ничего не осталось ждать родителя');
    // ДЕНЬГИ ЕДУТ И ЗАСЕВОМ. Иначе здание, подключённое позже, не увидело бы ни
    // одного счёта, выписанного до его подключения, — а это вся история клиники.
    assert.equal(count(D.db, 'invoices'), 1, 'счёт доехал холодным засевом');
    assert.equal(count(D.db, 'invoice_items'), 2, 'обе позиции');
    assert.equal(count(D.db, 'payments'), 1, 'и платёж');
    assert.equal(D.db.prepare('SELECT paid_amount FROM invoices LIMIT 1').get().paid_amount, 35000,
      'оплачено пересчитано из приехавшего платежа, а не принято на веру');
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

  // ОДНОИМЁННАЯ ПРАВКА (ревью 7/7b, C1) — сценарий целиком, как он был найден.
  // B правит телефон в 09:00 и выкладывается; A этот блоб не забирал. В 09:50 A
  // правит ТОТ ЖЕ телефон. В 10:00 у A обычный такт: сперва ВЫГРУЗКА (pub_seq
  // уходит за правку A, защита снимается в тот же миг), потом ВЫБОРКА — и
  // вчерашний блоб B ложился поверх свежей правки A. Откат этот в журнал не
  // пишется, а B к тому времени уже применил значение A: у A телефон B, у B
  // телефон A, и так навсегда. Перестановкой выгрузки и выборки это не
  // лечится — лечится тем, что у местной правки появилась метка.
  //
  // ЧАСЫ ЗДЕСЬ ВЫСТАВЛЯЮТСЯ ЯВНО, и без этого тест проверял бы не то. Весь
  // файл укладывается в одну-две миллисекунды, а метка, которую узел чеканит
  // выгрузкой, идёт от его часов HLC — то есть от времени ОТПРАВКИ. «Час
  // назад» и «сейчас» надо задать, иначе обе метки совпадают до миллисекунды
  // и сравнивать нечего. Вживую этот час набегает сам: узлы синхронизируются
  // раз в час.
  await t.test('одноимённая правка: свежая местная переживает вчерашний блоб соседа', async () => {
    const setClock = (node, msAgo) => node.db.prepare(
      `INSERT INTO control_state (key, value, updated_at)
       VALUES ('sync_clock', ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(JSON.stringify({ ms: Date.now() - msAgo, cnt: 0 }));
    const phoneIn = (node) => node.db.prepare("SELECT phone FROM patients WHERE full_name = 'Иванов'").get().phone;

    // 09:00 — B правит телефон и выкладывается. Его часы (а с ними и метка
    // записи) отстают на час: блоб пролежит на сервере нетронутым.
    setClock(B, 3600000);
    B.db.prepare("UPDATE patients SET phone = '+998900000900' WHERE full_name = 'Иванов'").run();
    assert.equal((await publishJournal(B.db, B.dir, {})).ok, true, 'блоб B лежит на сервере, A его не забирал');

    // 09:50 — A правит ТОТ ЖЕ телефон. A с тех пор синхронизировался с сетью,
    // поэтому его часы — «сейчас».
    setClock(A, 0);
    A.db.prepare("UPDATE patients SET phone = '+998900000950' WHERE full_name = 'Иванов'").run();

    await syncAt(A);   // ВЫГРУЗКА, затем ВЫБОРКА — тот самый порядок
    assert.equal(phoneIn(A), '+998900000950',
      'своя правка 09:50 обязана пережить приехавшую 09:00 — иначе откат, о котором никто не узнает');

    await syncAt(B);
    assert.equal(phoneIn(B), '+998900000950', 'и сосед приходит к тому же значению');
    assert.equal(phoneIn(A), phoneIn(B), 'две базы обязаны сойтись');
  });

  // РЕЗЕРВНЫЕ КОПИИ НЕ НАКАПЛИВАЮТСЯ (ревью 7/7b, I1). Копия снимается перед
  // КАЖДЫМ обменом, в котором есть что применять, — у клиники с тремя
  // филиалами это десятки файлов в сутки, а на порции, которую база отвергает,
  // и вовсе по копии в час бесконечно. Чистка же по видам вызывалась только
  // при старте и внутри суточной копии, то есть могла не случиться неделями:
  // диск заполнялся молча. Теперь она идёт сразу за копией.
  await t.test('копии перед приёмом чистятся, а не копятся', async () => {
    const safety = (node) => {
      let files = [];
      try { files = fs.readdirSync(path.join(node.dir, 'backups')); } catch { /* ещё не было */ }
      return files.filter((f) => f.startsWith('safety-'));
    };
    // За этот тест каждый узел принимал чужие записи много раз — заведомо
    // больше пяти (KEEP_BY_KIND.safety).
    let seen = 0;
    for (const node of [A, B, C]) {
      const kept = safety(node);
      seen += kept.length;
      assert.ok(kept.length <= 5,
        node.tag + ': копий безопасности осталось ' + kept.length + ' — чистка не сработала');
    }
    assert.ok(seen > 0, 'хотя бы одна копия обязана была сняться: иначе тест ничего не проверяет');
  });

  // ОДНОИМЁННАЯ ПРАВКА В ОДИН ТАКТ (Задача 7d). До неё это был единственный
  // случай, который не сходился вовсе: каждый узел отказывал другому по своей
  // неподтверждённой правке, оба подтверждали приём среза — и оставались при
  // своём НАВСЕГДА. Теперь у колонки есть метка её собственного времени
  // правки, обе стороны сравнивают ОДНИ И ТЕ ЖЕ две строки и выбирают одного
  // победителя — позже правившего.
  await t.test('оба филиала правят один телефон: побеждает тот, кто правил ПОЗЖЕ', async () => {
    // Время правки проставляется явно: весь файл укладывается в секунду, а
    // спор идёт именно о том, кто правил ПОЗЖЕ. Отсчёт — ВПЕРЁД от «сейчас», и
    // это не хитрость: за предыдущие подтесты тот же телефон уже правили и
    // принимали, sync_seen помнит те метки, и правка «час назад» честно
    // проиграла бы им. Здесь важен порядок двух новых правок между собой.
    //
    // Переставляются прежние правки ТОГО ЖЕ ТЕЛЕФОНА: журнал помнит их все, а
    // сравнивается последняя. И только телефона — тронув записи про адрес или
    // про заведение строки ('*'), тест назначил бы этому узлу авторство и над
    // ними, и следующий подтест разбирал бы уже не свой спор.
    const editAt = (node, secondsAhead, value) => {
      node.db.prepare("UPDATE patients SET phone = ? WHERE full_name = 'Иванов'").run(value);
      const uid = node.db.prepare("SELECT uid FROM patients WHERE full_name = 'Иванов'").get().uid;
      const at = new Date(Date.now() + secondsAhead * 1000).toISOString();
      node.db.prepare("UPDATE sync_journal SET at = ? WHERE tbl = 'patients' AND uid = ? AND cols = 'phone'")
        .run(at, uid);
      // И в АВТОРСТВО: с Задачи 7e спор решает sync_authored, а журнал только
      // говорит, ЧТО отдавать, — время он больше не хранит.
      node.db.prepare("UPDATE sync_authored SET at = ? WHERE tbl = 'patients' AND uid = ? AND col = 'phone'")
        .run(at, uid);
    };
    const phoneIn = (node) => node.db.prepare("SELECT phone FROM patients WHERE full_name = 'Иванов'").get().phone;

    // B правил раньше, C — позже; такт у обоих один, порядок обхода B → C.
    editAt(B, 10, '+998900000900');
    editAt(C, 20, '+998900000950');
    await round();
    await round();
    assert.equal(phoneIn(B), '+998900000950', 'у B');
    assert.equal(phoneIn(C), '+998900000950', 'у C');
    assert.equal(phoneIn(A), '+998900000950', 'и у главной клиники');

    // ТОТ ЖЕ СПОР В ОБРАТНОМ ПОРЯДКЕ: позже правит B, а такт по-прежнему
    // начинается с него. Победить обязано время правки, а не очерёдность.
    editAt(C, 30, '+998900001900');
    editAt(B, 40, '+998900001950');
    await round();
    await round();
    assert.equal(phoneIn(B), '+998900001950', 'у B');
    assert.equal(phoneIn(C), '+998900001950', 'у C');
    assert.equal(phoneIn(A), '+998900001950', 'и у главной клиники');
  });

  // ПОЗДНИЙ ЗАСЕВ НЕ ЗАТИРАЕТ ЧУЖИЕ СВЕЖИЕ ПРАВКИ (Задача 7d, gap iii).
  // Засев отдаёт снимок ВСЕЙ строки, и раньше — под свежей меткой «сейчас».
  // Значит филиал, засеявший соседа позже, откатывал у него колонку, которую
  // тот успел принять от третьего здания. Теперь у каждой колонки в засеве
  // метка её настоящего времени: своя — из строки, чужая — из sync_seen, то
  // есть та, под которой мы её сами приняли.
  await t.test('засев не откатывает колонку, принятую соседом от третьего филиала', async () => {
    // C правит адрес и доносит его до B (и до A).
    C.db.prepare("UPDATE patients SET address = 'Юнусабад, свежий' WHERE full_name = 'Иванов'").run();
    await round();
    await round();
    assert.equal(
      B.db.prepare("SELECT address FROM patients WHERE full_name = 'Иванов'").get().address,
      'Юнусабад, свежий', 'предпосылка: B принял свежий адрес от C');

    // Филиал F подключают только сейчас. Его засевает B — и в снимке B адрес
    // ПРИНЯТЫЙ от C, а не свой. Подписать его «сейчас» значило бы объявить B
    // автором чужой правки.
    A.db.prepare("INSERT INTO branches (name, letter) VALUES ('Яшнабад', 'F')").run();
    assert.equal((await publishCatalogue(A.db, A.dir)).ok, true);
    const F = await enrol('f', 'F', 'Яшнабад');
    for (const node of [B, F]) {
      const cat = await fetchCatalogue(node.dir);
      assert.equal(cat.ok, true, node.tag + ': ' + JSON.stringify(cat));
      applyCatalogue(node.db, cat.catalogue);
    }
    const backupImpl = async () => {};
    for (let r = 0; r < 8; r++) {
      await publishJournal(B.db, B.dir, {});
      await fetchJournals(F.db, F.dir, { backupImpl });
      await publishJournal(F.db, F.dir, {});
      await fetchJournals(B.db, B.dir, { backupImpl });
    }
    assert.equal(
      F.db.prepare("SELECT address FROM patients WHERE full_name = 'Иванов'").get().address,
      'Юнусабад, свежий', 'засеянный филиал получает АКТУАЛЬНЫЙ адрес, а не снимок «как было у B»');

    // И обратно: засев F не откатил адрес ни у кого.
    await round();
    for (const node of [A, B, C]) {
      assert.equal(
        node.db.prepare("SELECT address FROM patients WHERE full_name = 'Иванов'").get().address,
        'Юнусабад, свежий', node.tag + ': поздний засев не откатывает чужую правку');
    }
  });

  // C-1 ЦЕЛИКОМ (ревью 7d → Задача 7e). Один обычный сбой: у филиала PUT
  // отвечает 500, а GET работает. Раньше это кончалось так: B забирает срез A,
  // ничего из него не применяет (её правка новее), НО квитанцию всё равно
  // пишет; A читает квитанцию, двигает sent_seq, pruneJournal сносит
  // журнальную строку — и метка правки A исчезает вместе с ней, потому что
  // жила только в журнале. Дальше B присылает своё СТАРОЕ значение, и A его
  // принимает: сеть сходится на более ранней правке, оба журнала пусты, искать
  // нечего. Теперь авторство лежит в sync_authored и чистку переживает.
  await t.test('C-1: сбой выгрузки у соседа не откатывает более позднюю правку', async () => {
    const phoneIn = (node) => node.db.prepare("SELECT phone FROM patients WHERE full_name = 'Иванов'").get().phone;
    const editAt = (node, secondsAhead, value) => {
      node.db.prepare("UPDATE patients SET phone = ? WHERE full_name = 'Иванов'").run(value);
      const uid = node.db.prepare("SELECT uid FROM patients WHERE full_name = 'Иванов'").get().uid;
      const at = new Date(Date.now() + secondsAhead * 1000).toISOString();
      node.db.prepare("UPDATE sync_journal SET at = ? WHERE tbl = 'patients' AND uid = ? AND cols = 'phone'")
        .run(at, uid);
      node.db.prepare("UPDATE sync_authored SET at = ? WHERE tbl = 'patients' AND uid = ? AND col = 'phone'")
        .run(at, uid);
    };

    // B правит телефон, A — секундой ПОЗЖЕ. Отсчёт вперёд от «сейчас» и с
    // запасом: предыдущие подтесты уже оставили в сети метки на полминуты
    // вперёд, и правка «десять секунд вперёд» была бы честно старше их.
    editAt(B, 120, '+998900001000');
    editAt(A, 121, '+998900001100');

    // Выгрузка B один раз не удалась: блоб на сервере остался прежним, отметка
    // «выложено» не сдвинулась. Забирать чужое B при этом продолжает.
    const failingFetch = async () => { throw new Error('PUT failed: 500'); };
    const pub = await publishJournal(B.db, B.dir, { fetchImpl: failingFetch });
    assert.equal(pub.ok, false, 'выгрузка обязана честно отказать: ' + JSON.stringify(pub));
    await fetchJournals(B.db, B.dir, { backupImpl: async () => {} });

    // Шесть чистых кругов — больше чем достаточно, чтобы всё устоялось.
    for (let i = 0; i < 6; i++) await round();

    assert.equal(phoneIn(A), '+998900001100', 'правка A позже — она и остаётся у A');
    assert.equal(phoneIn(B), '+998900001100', 'и у B: сеть сходится на ПОЗДНЕЙ правке, а не на ранней');
    assert.equal(phoneIn(C), '+998900001100', 'и у третьего филиала');
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

// ---------------------------------------------------------------------------
// BRANCH_NUMBER_REMINT_V1 (ревью Фазы 3, C2) — ХОЛОДНЫЙ ЗАСЕВ ДВУХ ЗДАНИЙ,
// КОТОРЫЕ ДО ПАРЫ РАБОТАЛИ ПОРОЗНЬ.
//
// Здесь нет ни релея, ни поставщика, и это не упрощение: дефект живёт не в
// транспорте, а в самом первом обмене — засеве. Оба здания годами работали
// самостоятельно, счётчик у каждого шёл с единицы, обе установки считали себя
// зданием A, а миграции 088 и 080 нарочно не переименовали УЖЕ ВЫДАННЫЕ
// номера: они напечатаны на чеке и на карте. Значит у обоих зданий есть
// 'INV-26-00001' и 'P-26-00001', и на первом же засеве UNIQUE-индекс
// принимающей базы отвергал приехавшие строки — НАВСЕГДА, потому что
// квитанция уезжала всё равно и сосед второй раз их не слал.
//
// Проверяется всё обещание целиком, а не одна колонка: доехал ли счёт, нашли
// ли его позиция и платёж, сошлась ли оплата, цел ли пациент со своим визитом,
// и осталась ли нетронутой бумага ПРИНИМАЮЩЕГО здания.
// ---------------------------------------------------------------------------

/** Установка, отработавшая год в одиночку: своя услуга и свои номера с единицы. */
function standalone(letter) {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare('UPDATE branch_identity SET letter = ? WHERE id = 1').run(letter);
  db.prepare("INSERT INTO services (name, code, price, active) VALUES ('Приём','S-1',65000,1)").run();
  return db;
}

/** Пациент с ДОобновленческой картой, его визит и оплаченный счёт. */
function paperworkFromBefore(db, name) {
  const sid = db.prepare("SELECT id FROM services WHERE code = 'S-1'").get().id;
  const pid = db.prepare("INSERT INTO patients (full_name, mrn) VALUES (?, 'P-26-00001')").run(name).lastInsertRowid;
  const vid = db.prepare("INSERT INTO visits (patient_id, visit_date, status) VALUES (?, '2026-08-01', 'confirmed')")
    .run(pid).lastInsertRowid;
  const iid = db.prepare(`INSERT INTO invoices (patient_id, visit_id, invoice_number, subtotal, total_amount, paid_amount, status)
                          VALUES (?, ?, 'INV-26-00001', 65000, 65000, 65000, 'paid')`).run(pid, vid).lastInsertRowid;
  db.prepare(`INSERT INTO invoice_items (invoice_id, service_id, description, quantity, unit_price, total)
              VALUES (?, ?, 'Приём', 1, 65000, 65000)`).run(iid, sid);
  db.prepare("INSERT INTO payments (invoice_id, amount, method) VALUES (?, 65000, 'cash')").run(iid);
  return db.prepare('SELECT * FROM invoices WHERE id = ?').get(iid);
}

/** Засев целиком: страница за страницей, ровно как его гоняет relay.js. */
function coldSeed(from, fromLetter, to, toLetter) {
  const stats = { applied: 0, refused: 0, reminted: 0, deferred: 0 };
  for (let page = 0; page < 50; page++) {
    const b = buildBatch(from, { self: fromLetter, peer: toLetter, limit: 3 });
    const r = applyBatch(to, b.records, {
      self: toLetter, peer: fromLetter, upto: b.upto,
      seed: !!b.seed, seedPage: b.seed ? b.seed.page : 0,
    });
    for (const k of Object.keys(stats)) stats[k] += r[k] || 0;
    markSent(from, toLetter, b.upto, b.clock, b.seed);
    if (!b.seed || b.seed.done) break;
  }
  return stats;
}

test('BRANCH_NUMBER_REMINT_V1: засев не теряет счёт соседа с таким же старым номером', () => {
  const A = standalone('A');
  const B = standalone('B');
  const ownA = paperworkFromBefore(A, 'Абдуллаев');
  const ownB = paperworkFromBefore(B, 'Бекмуратов');
  assert.equal(ownA.invoice_number, ownB.invoice_number,
    'предпосылка теста и всей беды: у двух зданий один и тот же старый номер');

  const stats = coldSeed(B, 'B', A, 'A');

  assert.equal(stats.refused, 0, 'отказ — это потерянные насовсем деньги: сосед второй раз строку не пришлёт');
  assert.equal(A.prepare('SELECT COUNT(*) n FROM sync_refused').get().n, 0);
  assert.ok(stats.reminted >= 2, 'перечеканены оба столкнувшихся номера: счёта и карты, было ' + stats.reminted);

  // --- приехавшее ---------------------------------------------------------
  const theirs = A.prepare('SELECT * FROM invoices WHERE uid = ?').get(ownB.uid);
  assert.ok(theirs, 'счёт соседа обязан доехать — иначе его нет в отчёте главной клиники');
  assert.equal(theirs.invoice_number, 'INV-26-00001-B', 'приехавший номер несёт букву здания, откуда он');
  assert.equal(theirs.total_amount, 65000);
  assert.equal(theirs.sync_origin, 'B');
  const items = A.prepare('SELECT COUNT(*) n, SUM(total) s FROM invoice_items WHERE invoice_id = ?').get(theirs.id);
  assert.equal(items.n, 1, 'позиция нашла свой счёт: она привязана по uid, а не по номеру');
  assert.equal(items.s, 65000);
  const pay = A.prepare('SELECT COUNT(*) n, SUM(amount) s FROM payments WHERE invoice_id = ?').get(theirs.id);
  assert.equal(pay.n, 1, 'и платёж тоже — иначе он ждал бы родителя, которого нет, и был бы выселен через 30 дней');
  assert.equal(pay.s, 65000);
  assert.equal(theirs.paid_amount, 65000, 'оплата сошлась: paid_amount считается из доехавших платежей');

  const theirPatient = A.prepare("SELECT * FROM patients WHERE full_name = 'Бекмуратов'").get();
  assert.ok(theirPatient, 'пациент соседа обязан доехать: без него у счёта нет родителя вовсе');
  assert.equal(theirPatient.mrn, 'P-26-00001-B', 'старая карта сталкивается ровно так же, и лечится так же');
  assert.equal(A.prepare('SELECT COUNT(*) n FROM visits WHERE patient_id = ?').get(theirPatient.id).n, 1,
    'и его визит приехал за ним');

  // --- наше -------------------------------------------------------------
  const mine = A.prepare('SELECT * FROM invoices WHERE id = ?').get(ownA.id);
  assert.equal(mine.invoice_number, 'INV-26-00001', 'НАШ номер напечатан на чеке — засев соседа его не трогает');
  assert.equal(mine.paid_amount, 65000, 'и наша оплата на месте');
  assert.equal(A.prepare("SELECT mrn FROM patients WHERE full_name = 'Абдуллаев'").get().mrn, 'P-26-00001',
    'наша карта — тоже');
  assert.equal(A.prepare('SELECT COUNT(*) n FROM invoices').get().n, 2, 'счетов ровно два, ни один не потерян и не задвоен');

  // --- ЕЩЁ ОДИН ЗАСЕВ ТОГО ЖЕ САМОГО ------------------------------------
  // Засев повторяется в жизни: сосед не подтвердил страницу, обмен пошёл
  // заново. Перечеканка обязана быть идемпотентной, иначе каждый круг двигал
  // бы номер на шаг вперёд ('-B', '-B2', '-B3') и документ терял бы имя.
  A.prepare("DELETE FROM sync_peers WHERE node = 'B'").run();
  B.prepare("DELETE FROM sync_peers WHERE node = 'A'").run();
  const again = coldSeed(B, 'B', A, 'A');
  assert.equal(again.refused, 0);
  assert.equal(A.prepare('SELECT invoice_number FROM invoices WHERE uid = ?').get(ownB.uid).invoice_number,
    'INV-26-00001-B', 'тот же засев — тот же номер');
  assert.equal(A.prepare("SELECT mrn FROM patients WHERE full_name = 'Бекмуратов'").get().mrn, 'P-26-00001-B');
  assert.equal(A.prepare('SELECT COUNT(*) n FROM invoices').get().n, 2, 'и по-прежнему ровно два счёта');

  // --- ОБРАТНЫЙ ЗАСЕВ ----------------------------------------------------
  // A засевает B — и везёт ОБРАТНО строку самого B под перечеканенным
  // номером: засев отдаёт все строки, включая чужие. Принять её значило бы
  // переименовать у соседа его собственный, напечатанный чек.
  const back = coldSeed(A, 'A', B, 'B');
  assert.equal(back.refused, 0);
  assert.equal(B.prepare('SELECT invoice_number FROM invoices WHERE uid = ?').get(ownB.uid).invoice_number,
    'INV-26-00001', 'номер здания-автора не меняется ничем и никогда');
  assert.equal(B.prepare("SELECT mrn FROM patients WHERE full_name = 'Бекмуратов'").get().mrn, 'P-26-00001');
  assert.equal(B.prepare('SELECT invoice_number FROM invoices WHERE uid = ?').get(ownA.uid).invoice_number,
    'INV-26-00001-A', 'а счёт A у себя получает букву A — симметрично');
  assert.equal(B.prepare('SELECT COUNT(*) n FROM invoices').get().n, 2);

  A.close(); B.close();
});
