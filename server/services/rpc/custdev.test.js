// CUSTDEV_V1 — граница: кто может смотреть, кто может оценивать, и как отказ
// доходит до экрана.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { custdevList, custdevSync, custdevRate, custdevMark, custdevReport } from './custdev.js';
import { RpcError } from './crm-config.js';
import { getRpc } from './index.js';
import { isReadOnlyRpc } from '../control/gate.js';
import { tableEntry, canRead, canWrite } from '../../db/schema-registry.js';

const dayOffset = (db, n) => db.prepare("SELECT date('now','localtime',? || ' days') d").get(String(n)).d;

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, full_name, role) VALUES (?,?,?,?,?)');
  u.run(1, 'adm', 'x', 'Владелец', 'admin');
  u.run(2, 'cc', 'x', 'Оператор', 'callcenter');
  u.run(3, 'doc', 'x', 'Врач В.', 'doctor');
  db.prepare("INSERT INTO patients (id, full_name) VALUES (1, 'Иванов И.')").run();
  return db;
}

const admin = { id: 1, role: 'admin' };
const operator = { id: 2, role: 'callcenter' };
const doctor = { id: 3, role: 'doctor' };

function paidVisit(db, id, day) {
  db.prepare("INSERT INTO visits (id, patient_id, doctor_id, visit_date, status) VALUES (?,1,3,?,'arrived')")
    .run(id, day + 'T09:00:00Z');
  db.prepare("INSERT INTO invoices (id, visit_id, patient_id, paid_amount, status, created_by) VALUES (?,?,1,1000,'paid',1)")
    .run(id, id);
  db.prepare('INSERT INTO payments (invoice_id, amount, cashier_id) VALUES (?,1000,1)').run(id);
}

const period = (db) => ({ from: dayOffset(db, -30), to: dayOffset(db, 0) });

test('custdev_cards НЕДОСТУПНА через /api/db — на этом держится вся защита', () => {
  // Реестр — allow-list, поэтому отсутствие в нём и есть защита: тот же приём,
  // что у telephony_settings (076). Если таблицу однажды зарегистрируют «чтобы
  // было удобнее», врач сможет прочитать оценки о себе обычным запросом мимо
  // галочки в «Настройки → Роли». Этот тест — единственное, что стоит на пути.
  assert.equal(tableEntry('custdev_cards'), null);
  for (const role of ['admin', 'callcenter', 'doctor', 'registrar', 'cashier', 'nurse', 'lab', 'inventory']) {
    assert.equal(canRead('custdev_cards', role), false, role + ' не должен читать таблицу напрямую');
    for (const op of ['insert', 'update', 'delete']) {
      assert.equal(canWrite('custdev_cards', op, role), false);
    }
  }
});

test('пять RPC зарегистрированы под ожидаемыми именами', () => {
  for (const name of ['custdev_list', 'custdev_sync', 'custdev_rate', 'custdev_mark', 'custdev_report']) {
    assert.equal(typeof getRpc(name), 'function', name + ' не зарегистрирован');
  }
});

test('чтение доски и отчёт работают при просроченной лицензии, запись — нет', () => {
  // Клиника с лапнувшей лицензией читает, но не пишет. Доска без чтения была бы
  // пустым экраном, а не «режимом только для чтения».
  assert.equal(isReadOnlyRpc('custdev_list'), true);
  assert.equal(isReadOnlyRpc('custdev_report'), true);
  assert.equal(isReadOnlyRpc('custdev_rate'), false);
  assert.equal(isReadOnlyRpc('custdev_sync'), false);
});

test('роль без выданного ключа не проходит никуда', () => {
  const db = fresh();
  for (const call of [custdevList, custdevSync, custdevReport]) {
    assert.throws(() => call(db, period(db), doctor),
      (e) => e instanceof RpcError && e.status === 403,
      'врач не должен читать оценки о себе');
  }
});

test('колл-центр видит доску и может оценивать', () => {
  const db = fresh();
  paidVisit(db, 1, dayOffset(db, -1));
  assert.equal(custdevSync(db, period(db), operator).created, 1);

  const rows = custdevList(db, period(db), operator);
  assert.equal(rows.length, 1);

  const card = rows[0];
  const out = custdevRate(db, {
    card_id: card.id, registrar: 'good', cashier: 'good', doctor: 'good', comment: '',
  }, operator);
  assert.equal(out.status, 'satisfied');

  const saved = db.prepare('SELECT * FROM custdev_cards WHERE id = ?').get(card.id);
  assert.equal(saved.status, 'satisfied');
  assert.equal(saved.called_by, 2, 'штамп «кто звонил» ставит сервер');
  assert.ok(saved.called_at);
});

test('уровень «Только просмотр» читает, но оценивать не может', () => {
  const db = fresh();
  paidVisit(db, 1, dayOffset(db, -1));
  custdevSync(db, period(db), operator);
  const cardId = custdevList(db, period(db), operator)[0].id;

  // Понижаем колл-центр до просмотра — ровно то, что владелец делает галочкой.
  // CALLCENTER_OPERATOR_V1: галочка обязана действовать и ПОСЛЕ появления строк
  // матрицы. Поэтому миграция 141 ключей Cust Dev не выдаёт вовсе: выданный
  // `custdev.rate: edit` заморозил бы оценки в положении «можно» и отменил бы
  // решение, принятое клиникой старой галочкой, — то самое молчаливое
  // расширение прав, которого обновление делать не вправе.
  db.prepare(`UPDATE role_permissions SET permissions = json_set(permissions, '$.levels.custdev', 'viewer')
               WHERE role = 'callcenter'`).run();

  assert.equal(custdevList(db, period(db), operator).length, 1);
  assert.throws(() => custdevRate(db, {
    card_id: cardId, registrar: 'good', cashier: 'good', doctor: 'good',
  }, operator), (e) => e instanceof RpcError && e.status === 403);
});

// CALLCENTER_OPERATOR_V1 — раздел появился в справочнике прав, и его ворота
// живут по тому же правилу перехода, что и стационар: пока роль ключ не
// трогала, решает ПРЕЖНЯЯ галочка раздела, а не пустая матрица.
test('строки матрицы главнее старой галочки — но только там, где их настроили', () => {
  const db = fresh();
  paidVisit(db, 1, dayOffset(db, -1));
  custdevSync(db, period(db), operator);
  const cardId = custdevList(db, period(db), operator)[0].id;

  // Врач раздела не имеет и ключей не настраивал — отказ, как и был.
  assert.throws(() => custdevList(db, period(db), doctor), (e) => e.status === 403);

  // Клиника выдала врачу доску СТРОКОЙ МАТРИЦЫ — старого раздела ему так и не
  // дали, и раньше выдать одну доску было нечем.
  db.prepare(`UPDATE role_permissions
                 SET permissions = json_patch(permissions, '{"grants":{"custdev.list":"view"}}')
               WHERE role = 'doctor'`).run();
  assert.equal(custdevList(db, period(db), doctor).length, 1, 'выданная строка доску не открыла');

  // Оценивать он всё равно не может: custdev.rate ему не выдавали, а старой
  // галочки раздела у него нет — правило перехода отвечает «как было».
  assert.throws(() => custdevRate(db, {
    card_id: cardId, registrar: 'good', cashier: 'good', doctor: 'good',
  }, doctor), (e) => e.status === 403);
});

// CALLCENTER_OPERATOR_V1 — ЗАКРЫТЫЙ РАЗДЕЛ НЕ ОТКРЫВАЕТСЯ ИЗНУТРИ.
//
// Экран «Роли» гасит окна и действия раздела, поставленного в «Нет», но
// ЗНАЧЕНИЯ у них при этом остаются прежние и так и уезжают в базу: матрица
// «custdev: Нет, custdev.list: Просмотр» — обычная её запись, а не выдумка.
// Спроси ворота только про окно — и закрытый раздел откроется изнутри: до
// появления строк матрицы одна галочка раздела отказывала, а после стала бы
// пускать. Правило одно на все ворота (grants.js): раздел «Нет» перевешивает
// всё, что в нём осталось.
test('раздел, закрытый строкой матрицы, не открывается оставшимся уровнем своего окна', () => {
  const db = fresh();
  paidVisit(db, 1, dayOffset(db, -1));
  custdevSync(db, period(db), admin);

  db.prepare(`UPDATE role_permissions
                 SET permissions = json_patch(permissions, '{"grants":{"custdev":"none","custdev.list":"view","custdev.rate":"edit"}}')
               WHERE role = 'callcenter'`).run();

  assert.throws(() => custdevList(db, period(db), operator),
    (e) => e instanceof RpcError && e.status === 403,
    'закрытый раздел открылся уровнем, оставшимся у его окна');
  assert.throws(() => custdevReport(db, period(db), operator), (e) => e.status === 403);
});

// ADMIN_DOCTOR_V1 — у администратора клиники основная роль сплошь и рядом
// `doctor`, а `admin` стоит дополнительной, и матрица читается по ОБЕИМ. «Нет»,
// поставленное врачам, не должно запирать владельца в его же отчёте: ворота
// пускают администратора тем же предикатом, что и везде (grants.js isAdminUser).
test('администратор-врач ведёт обзвон, даже когда врачам раздел закрыт строкой матрицы', () => {
  const db = fresh();
  paidVisit(db, 1, dayOffset(db, -1));
  custdevSync(db, period(db), admin);
  const cardId = custdevList(db, period(db), admin)[0].id;
  db.prepare(`UPDATE role_permissions
                 SET permissions = json_patch(permissions, '{"grants":{"custdev.list":"none","custdev.rate":"none"}}')
               WHERE role = 'doctor'`).run();

  const adminDoctor = { id: 1, role: 'doctor', extra_roles: ['admin'] };
  assert.equal(custdevList(db, period(db), adminDoctor).length, 1, 'владелец заперт «Нет», записанным врачам');
  assert.equal(custdevRate(db, {
    card_id: cardId, registrar: 'good', cashier: 'good', doctor: 'good',
  }, adminDoctor).status, 'satisfied');

  // Рядовому врачу — по-прежнему нет.
  assert.throws(() => custdevList(db, period(db), doctor), (e) => e.status === 403);
});

test('жалоба без комментария отклоняется с текстом для оператора', () => {
  const db = fresh();
  paidVisit(db, 1, dayOffset(db, -1));
  custdevSync(db, period(db), operator);
  const cardId = custdevList(db, period(db), operator)[0].id;

  assert.throws(() => custdevRate(db, {
    card_id: cardId, registrar: 'good', cashier: 'good', doctor: 'bad', comment: '',
  }, operator), (e) => e.status === 400 && /не устроило/.test(e.message));
});

test('custdev_mark ставит «Не дозвонились» и не трогает оценки', () => {
  const db = fresh();
  paidVisit(db, 1, dayOffset(db, -1));
  custdevSync(db, period(db), operator);
  const cardId = custdevList(db, period(db), operator)[0].id;

  custdevMark(db, { card_id: cardId, status: 'unreachable' }, operator);
  const row = db.prepare('SELECT * FROM custdev_cards WHERE id = ?').get(cardId);
  assert.equal(row.status, 'unreachable');
  assert.equal(row.score_doctor, 'unrated');

  // Вычисляемый статус руками не ставится — иначе колонка разошлась бы с оценками.
  assert.throws(() => custdevMark(db, { card_id: cardId, status: 'satisfied' }, operator),
    (e) => e instanceof RpcError && e.status === 400);
});

test('оценка несуществующей карточки — 404, а не молчание', () => {
  const db = fresh();
  assert.throws(() => custdevRate(db, {
    card_id: 999, registrar: 'good', cashier: 'good', doctor: 'good',
  }, operator), (e) => e instanceof RpcError && e.status === 404);
});

test('владелец видит доску и отчёт', () => {
  const db = fresh();
  paidVisit(db, 1, dayOffset(db, -1));
  custdevSync(db, period(db), admin);
  assert.equal(custdevList(db, period(db), admin).length, 1);
  assert.equal(custdevReport(db, period(db), admin).total, 1);
});
