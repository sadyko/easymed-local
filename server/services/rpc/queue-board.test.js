// QUEUE_BOARD_V1 — читающая сторона очереди.
//
// Доска обязана совпадать с талоном в руках пациента: тот же номер, та же
// подпись назначения, тот же день. Поэтому здесь проверяется не «функция что-то
// вернула», а конкретные утверждения, на которые сотрудник будет полагаться,
// глядя на экран и на бумажку одновременно.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { issueQueueNumbers, queueBoard } from './queue.js';

const REG = { id: 1, role: 'registrar' };
const DOC = { id: 2, role: 'doctor' };
const DAY = '2026-08-07';

function freshDb() {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_active) VALUES (1,'r','x','Reg','registrar',1)").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_active, is_doctor) VALUES (2,'d1','x','Др. Азиза','doctor',1,1)").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_active, is_doctor) VALUES (3,'d2','x','Др. Борис','doctor',1,1)").run();
  db.prepare("INSERT INTO services (id, name, price, type) VALUES (1,'Приём терапевта',50000,'consultation')").run();
  db.prepare("INSERT INTO services (id, name, price, type) VALUES (2,'Приём ЛОРа',60000,'consultation')").run();
  db.prepare("INSERT INTO services (id, name, price, type, is_lab) VALUES (3,'ОАК',30000,'lab',1)").run();
  db.prepare("INSERT INTO services (id, name, price, type, is_lab) VALUES (4,'Биохимия',40000,'lab',1)").run();
  db.prepare("INSERT INTO services (id, name, price, type) VALUES (5,'Капельница',20000,'procedure')").run();
  db.prepare("INSERT INTO patients (id, full_name) VALUES (1,'Алиев А.')").run();
  db.prepare("INSERT INTO patients (id, full_name) VALUES (2,'Каримов К.')").run();
  db.prepare(`INSERT INTO visits (id, patient_id, visit_date, status) VALUES (1,1,'${DAY}T09:00:00Z','scheduled')`).run();
  db.prepare(`INSERT INTO visits (id, patient_id, visit_date, status) VALUES (2,2,'${DAY}T10:00:00Z','scheduled')`).run();
  return db;
}

// FREE_SERVICE_V1 — цена у строки теперь ЗНАЧИМА: услуга за 0 сум не ждёт
// кассу, и 'added' у неё читается как обычное ожидание, а не «ожидает оплату».
// Фикстура заводила все строки с total = 0, то есть бесплатными, — и тест про
// неоплаченный талон проверял на самом деле бесплатный. Ставим настоящую цену.
function addLine(db, { visit = 1, svc, doctor = null, price = 60000 }) {
  return db.prepare(
    "INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status) VALUES (?,?,?,1,?,?,'added')")
    .run(visit, svc, doctor, price, price).lastInsertRowid;
}
const setStatus = (db, id, st) => db.prepare('UPDATE visit_services SET status=? WHERE id=?').run(st, id);
const board = (db, user = REG) => queueBoard(db, { day: DAY }, user);
const groupOf = (b, label) => b.groups.find((g) => g.label === label);

test('раздел не выдан — доска не отдаётся', () => {
  const db = freshDb();
  // Роль без раздела 'queue' в role_permissions.
  db.prepare("DELETE FROM role_permissions WHERE role='registrar'").run();
  assert.throws(() => board(db), /Очередь/);
  db.close();
});

test('065 выдаёт раздел администратору и рабочим ролям', () => {
  const db = freshDb();
  for (const role of ['admin', 'registrar', 'doctor', 'nurse', 'cashier']) {
    const row = db.prepare('SELECT permissions FROM role_permissions WHERE role=?').get(role);
    assert.ok(row, role + ' должен существовать');
    const perms = JSON.parse(row.permissions);
    assert.ok(perms.sections.includes('queue'), role + ' должен видеть очередь');
  }
  const cc = db.prepare("SELECT permissions FROM role_permissions WHERE role='callcenter'").get();
  if (cc) {
    assert.ok(!JSON.parse(cc.permissions).sections.includes('queue'),
      'call-центр работает с теми, кто ещё не в клинике');
  }
  db.close();
});

test('очередь врача: номера по порядку, подпись — имя врача', () => {
  const db = freshDb();
  const a = addLine(db, { visit: 1, svc: 1, doctor: 2 });
  const b = addLine(db, { visit: 2, svc: 1, doctor: 2 });
  issueQueueNumbers(db, { p_ids: [a, b] }, REG);

  const g = groupOf(board(db), 'Др. Азиза');
  assert.ok(g, 'группа врача должна называться его именем — как на талоне');
  assert.equal(g.kind, 'doctor');
  assert.deepEqual(g.tickets.map((t) => t.number), [1, 2]);
  assert.deepEqual(g.tickets.map((t) => t.patient_name), ['Алиев А.', 'Каримов К.']);
  db.close();
});

test('врачи идут первыми, лаборатория и процедуры — следом', () => {
  const db = freshDb();
  const lab = addLine(db, { visit: 1, svc: 3 });
  const proc = addLine(db, { visit: 1, svc: 5 });
  const cons = addLine(db, { visit: 1, svc: 1, doctor: 2 });
  issueQueueNumbers(db, { p_ids: [lab, proc, cons] }, REG);

  const kinds = board(db).groups.map((g) => g.kind);
  assert.equal(kinds[0], 'doctor', 'ради врачей раздел и заводился');
  assert.ok(kinds.indexOf('procedure') < kinds.indexOf('lab'));
  db.close();
});

test('несколько анализов одного пациента — ОДИН талон с перечнем услуг', () => {
  const db = freshDb();
  const l1 = addLine(db, { visit: 1, svc: 3 });
  const l2 = addLine(db, { visit: 1, svc: 4 });
  issueQueueNumbers(db, { p_ids: [l1, l2] }, REG);

  const g = groupOf(board(db), 'Лаборатория');
  assert.equal(g.tickets.length, 1, 'пациент стоит в лабораторию один раз');
  assert.equal(g.total, 1);
  assert.deepEqual(g.tickets[0].services.sort(), ['Биохимия', 'ОАК']);
  db.close();
});

test('«сейчас» — это принимаемый номер, а не первый в списке', () => {
  const db = freshDb();
  const a = addLine(db, { visit: 1, svc: 1, doctor: 2 });
  const b = addLine(db, { visit: 2, svc: 1, doctor: 2 });
  issueQueueNumbers(db, { p_ids: [a, b] }, REG);
  setStatus(db, a, 'completed');
  setStatus(db, b, 'in_progress');

  const g = groupOf(board(db), 'Др. Азиза');
  assert.deepEqual(g.now, [2]);
  assert.equal(g.serving_count, 1);
  assert.equal(g.done_count, 1);
  assert.equal(g.waiting_count, 0);
  db.close();
});

test('неоплаченный талон виден отдельно, а не как обычное ожидание', () => {
  const db = freshDb();
  const paid = addLine(db, { visit: 1, svc: 1, doctor: 2 });
  const unpaid = addLine(db, { visit: 2, svc: 1, doctor: 2 });
  issueQueueNumbers(db, { p_ids: [paid, unpaid] }, REG);
  setStatus(db, paid, 'queued');           // оплачен, ждёт
  setStatus(db, unpaid, 'added');          // номер есть, счёт не оплачен

  const g = groupOf(board(db), 'Др. Азиза');
  assert.equal(g.waiting_count, 1);
  assert.equal(g.unpaid_count, 1);
  assert.equal(g.tickets.find((t) => t.number === 1).state, 'waiting');
  assert.equal(g.tickets.find((t) => t.number === 2).state, 'unpaid');
  db.close();
});

test('талон закрыт только когда закрыты все его услуги', () => {
  const db = freshDb();
  const l1 = addLine(db, { visit: 1, svc: 3 });
  const l2 = addLine(db, { visit: 1, svc: 4 });
  issueQueueNumbers(db, { p_ids: [l1, l2] }, REG);
  setStatus(db, l1, 'completed');
  setStatus(db, l2, 'queued');

  let g = groupOf(board(db), 'Лаборатория');
  assert.equal(g.tickets[0].state, 'waiting', 'один анализ готов — пациент всё ещё в очереди');
  assert.equal(g.done_count, 0);

  setStatus(db, l2, 'completed');
  g = groupOf(board(db), 'Лаборатория');
  assert.equal(g.tickets[0].state, 'done');
  assert.equal(g.done_count, 1);
  db.close();
});

test('лабораторные промежуточные статусы считаются работой, а не ожиданием', () => {
  const db = freshDb();
  const l = addLine(db, { visit: 1, svc: 3 });
  issueQueueNumbers(db, { p_ids: [l] }, REG);
  for (const st of ['collected', 'resulted']) {
    setStatus(db, l, st);
    const g = groupOf(board(db), 'Лаборатория');
    assert.equal(g.tickets[0].state, 'serving', st + ': проба уже в работе, человек не стоит');
  }
  db.close();
});

test('чужой день на доску не попадает', () => {
  const db = freshDb();
  const a = addLine(db, { visit: 1, svc: 1, doctor: 2 });
  issueQueueNumbers(db, { p_ids: [a] }, REG);

  assert.ok(board(db).groups.length > 0, 'свой день виден');
  assert.deepEqual(queueBoard(db, { day: '2026-08-08' }, REG).groups, [], 'соседний день пуст');
  db.close();
});

test('день по умолчанию — клинический сегодня, а не UTC-полночь', () => {
  const db = freshDb();
  const expected = db.prepare("SELECT date('now','localtime') d").get().d;
  assert.equal(queueBoard(db, {}, REG).day, expected);
  assert.equal(queueBoard(db, { day: 'мусор' }, REG).day, expected, 'мусорную дату игнорируем');
  db.close();
});

test('врач видит доску (раздел выдан ролью, а не списком ролей в коде)', () => {
  const db = freshDb();
  const a = addLine(db, { visit: 1, svc: 1, doctor: 2 });
  issueQueueNumbers(db, { p_ids: [a] }, REG);
  assert.ok(queueBoard(db, { day: DAY }, DOC).groups.length > 0);
  db.close();
});

test('два врача — две отдельные очереди, нумерация у каждой своя', () => {
  const db = freshDb();
  const a = addLine(db, { visit: 1, svc: 1, doctor: 2 });
  const b = addLine(db, { visit: 2, svc: 2, doctor: 3 });
  issueQueueNumbers(db, { p_ids: [a, b] }, REG);

  const azi = groupOf(board(db), 'Др. Азиза');
  const bor = groupOf(board(db), 'Др. Борис');
  assert.deepEqual(azi.tickets.map((t) => t.number), [1]);
  assert.deepEqual(bor.tickets.map((t) => t.number), [1], 'у каждого врача своя линия с №1');
  assert.notEqual(azi.key, bor.key);
  db.close();
});

