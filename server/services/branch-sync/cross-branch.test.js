// CROSS_BRANCH_CALENDAR_V1 — «видеть и записывать в любой филиал» (решение
// владельца 2026-09-05, Задача 6).
//
// Здесь проверяется то, ЧЕГО СТОИЛО это решение, а не то, что код запускается.
// Пять утверждений, и каждое стоит своей строки в шапке, потому что каждое
// однажды было сформулировано как «нельзя, поэтому не делаем»:
//
//   1. ВРАЧ ЕДЕТ С ЗАПИСЬЮ И ПРИЕЗЖАЕТ В СВОЮ КОЛОНКУ. Раньше doctor_id не
//      ехал намеренно: локальный id указывал бы у соседа в пустоту. Теперь он
//      едет ЛОГИНОМ (users.username — единственная колонка таблицы с UNIQUE),
//      и тест ставит у соседа ДРУГИЕ id, иначе он не отличил бы «разрешили по
//      логину» от «случайно совпали числа».
//   2. НЕЗНАКОМЫЙ ЛОГИН НЕ ОТМЕНЯЕТ ЗАПИСЬ. Она заводится без врача и видна в
//      «Не назначено» — а НЕ уходит ждать в sync_pending, откуда через 30 дней
//      её выселили бы совсем. Справочник сотрудников едет отдельным каналом со
//      своим тактом, поэтому обгон — норма, а не поломка.
//   3. КАБИНЕТ НЕ ЕЗДИТ. Правило владельца: кабинеты — принадлежность здания.
//      Тест смотрит на СОДЕРЖИМОЕ порции, а не на результат: «у соседа не
//      появился кабинет» верно и тогда, когда порция его везёт, а вставка
//      молча роняет.
//   4. СЛОТ ЗАНЯТ У ОБЕИХ СТОРОН. Приехавшая запись обязана мешать записать
//      второго человека к тому же врачу на то же время — это и есть весь
//      смысл того, что врач поехал.
//   5. НАСТОЯЩЕЕ СТОЛКНОВЕНИЕ РАЗРЕШАЕТСЯ ОДИНАКОВО В ОБОИХ ЗДАНИЯХ. Два
//      оператора заняли один слот внутри часа между обменами. Проверяется не
//      «программа не дала» (она физически не могла не дать), а что после
//      обмена ОБА здания называют проигравшим ОДНУ И ТУ ЖЕ запись. Разойдись
//      они — каждое ждало бы своего пациента, и это хуже самого столкновения.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { buildBatch, markSent } from './journal.js';
import { applyBatch } from './records.js';
import { calendarWindows, calendarBook } from '../rpc/calendar.js';

const registrar = { id: 900, role: 'registrar', extra_roles: [] };
const DAY = '2026-09-07';
const at = (hh, mm = 0) => new Date(2026, 8, 7, hh, mm, 0, 0).toISOString();
const WH = JSON.stringify({ mon: { enabled: true, from: '09:00', to: '18:00' } });

/**
 * Одно здание: база, буква, две строки в `branches` (своя и соседняя) и общий
 * набор логинов. ID сотрудников РАЗНЫЕ в двух зданиях — намеренно.
 */
function house(letter, { doctorId, otherId }) {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare('UPDATE branches SET name = ?, letter = ? WHERE id = (SELECT MIN(id) FROM branches)')
    .run(letter === 'A' ? 'Главный корпус' : 'Второй корпус', letter);
  const own = db.prepare('SELECT MIN(id) AS id FROM branches').get().id;
  const peer = letter === 'A' ? 'B' : 'A';
  db.prepare("INSERT INTO branches (name, letter, active) VALUES (?, ?, 0)")
    .run(peer === 'A' ? 'Главный корпус' : 'Второй корпус', peer);
  const peerId = db.prepare('SELECT id FROM branches WHERE letter = ?').get(peer).id;
  db.prepare('UPDATE branch_identity SET letter = ?, role = ?, branch_id = ? WHERE id = 1')
    .run(letter, letter === 'A' ? 'main' : 'secondary', own);
  // Один человек — один логин в любом здании (справочник, natural: username).
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, working_hours, branch_id) VALUES (?, 'petrov','x','Петров П.П.','doctor',1,?,?)")
    .run(doctorId, WH, letter === 'A' ? own : own);
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, working_hours, branch_id) VALUES (?, 'karimov','x','Каримов Р.','doctor',1,?,?)")
    .run(otherId, WH, own);
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (900,'reg','x','Регистратор','registrar')").run();
  return { db, letter, own, peerId, peer };
}

/** Перевезти всё накопленное из одного здания в другое. */
function ship(from, to) {
  const batch = buildBatch(from.db, { self: from.letter, peer: to.letter, limit: 5000 });
  const stats = applyBatch(to.db, batch.records, { self: to.letter, peer: from.letter, upto: batch.upto, seed: batch.seed });
  markSent(from.db, to.letter, batch.upto, batch.clock, batch.seed);
  return { batch, stats };
}

const visitBy = (db, uid) => db.prepare('SELECT * FROM visits WHERE uid = ?').get(uid);
const uidOf = (db, id) => db.prepare('SELECT uid FROM visits WHERE id = ?').get(id).uid;

// ─── 1. врач едет ───────────────────────────────────────────────────────────

test('запись из соседнего здания приезжает С ВРАЧОМ — он разрешается по логину', async () => {
  const A = house('A', { doctorId: 7, otherId: 8 });
  const B = house('B', { doctorId: 71, otherId: 81 });   // те же логины, ДРУГИЕ id

  A.db.prepare("INSERT INTO patients (id, full_name) VALUES (3,'Иванов Иван')").run();
  const out = await calendarBook(A.db, { patient_id: 3, doctor_id: 7, start: at(10) }, registrar);
  const uid = uidOf(A.db, out.visit.id);

  const { batch } = ship(A, B);
  const rec = batch.records.find((r) => r.tbl === 'visits' && r.uid === uid);
  assert.equal(rec.refs.doctor_login, 'petrov', 'врач обязан ехать ЛОГИНОМ, а не id');
  assert.ok(!('doctor_id' in rec.data), 'локальный id врача в порции — это указатель в пустоту');

  const there = visitBy(B.db, uid);
  assert.ok(there, 'запись не доехала вовсе');
  assert.equal(there.doctor_id, 71, 'у соседа запись обязана попасть к ЕГО строке того же врача');
  assert.equal(there.sync_origin, 'A');
  A.db.close(); B.db.close();
});

test('booked_at едет: обе стороны видят одно и то же время записи', async () => {
  const A = house('A', { doctorId: 7, otherId: 8 });
  const B = house('B', { doctorId: 71, otherId: 81 });
  A.db.prepare("INSERT INTO patients (id, full_name) VALUES (3,'Иванов Иван')").run();
  const out = await calendarBook(A.db, { patient_id: 3, doctor_id: 7, start: at(10) }, registrar);
  const uid = uidOf(A.db, out.visit.id);
  assert.ok(out.visit.booked_at, 'запись обязана нести момент, когда её сделали');

  ship(A, B);
  assert.equal(visitBy(B.db, uid).booked_at, out.visit.booked_at,
    'без общего booked_at здания не смогут назвать одного и того же «первого»');
  A.db.close(); B.db.close();
});

// ─── 2. незнакомый логин ────────────────────────────────────────────────────

test('незнакомый врач — запись заводится БЕЗ него, а не откладывается и не теряется', async () => {
  const A = house('A', { doctorId: 7, otherId: 8 });
  const B = house('B', { doctorId: 71, otherId: 81 });
  // У соседа этого человека ещё нет: справочник сотрудников едет отдельным
  // каналом и своим тактом, поэтому запись обгоняет его буднично.
  B.db.prepare("DELETE FROM users WHERE username = 'petrov'").run();

  A.db.prepare("INSERT INTO patients (id, full_name) VALUES (3,'Иванов Иван')").run();
  const out = await calendarBook(A.db, { patient_id: 3, doctor_id: 7, start: at(10) }, registrar);
  const uid = uidOf(A.db, out.visit.id);

  ship(A, B);
  const there = visitBy(B.db, uid);
  assert.ok(there, 'запись отвергнута целиком из-за неизвестного логина — так нельзя');
  assert.equal(there.doctor_id, null, 'врача нет — колонка пуста, и никто не выдуман');
  assert.equal(there.status, 'scheduled', 'всё остальное приехало');
  assert.equal(B.db.prepare('SELECT COUNT(*) n FROM sync_pending').get().n, 0,
    'ожидание здесь означало бы выселение через 30 дней, то есть потерянную запись');

  // А когда человек доедет справочником, следующая же правка проставит врача.
  B.db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, working_hours) VALUES (71,'petrov','x','Петров П.П.','doctor',1,?)").run(WH);
  await calendarBook(A.db, { visit_id: out.visit.id, start: at(11) }, registrar);
  ship(A, B);
  assert.equal(visitBy(B.db, uid).doctor_id, 71, 'после приезда справочника врач обязан проставиться');
  A.db.close(); B.db.close();
});

// ─── 3. кабинет остаётся дома ───────────────────────────────────────────────

test('room_id по-прежнему НЕ едет — кабинет принадлежит зданию', async () => {
  const A = house('A', { doctorId: 7, otherId: 8 });
  const B = house('B', { doctorId: 71, otherId: 81 });
  A.db.prepare("INSERT INTO patients (id, full_name) VALUES (3,'Иванов Иван')").run();
  A.db.prepare("INSERT INTO rooms (id, name) VALUES (11,'Кабинет 201')").run();
  B.db.prepare("INSERT INTO rooms (id, name) VALUES (11,'Процедурная')").run();   // тот же id, другая комната
  const out = await calendarBook(A.db, { patient_id: 3, doctor_id: 7, room_id: 11, start: at(10) }, registrar);
  const uid = uidOf(A.db, out.visit.id);

  const { batch } = ship(A, B);
  const rec = batch.records.find((r) => r.tbl === 'visits' && r.uid === uid);
  assert.ok(!('room_id' in rec.data), 'кабинет попал в порцию — у соседа это чужая комната');
  assert.ok(!('room_id' in (rec.refs || {})));
  assert.equal(visitBy(B.db, uid).room_id, null, 'и не проставился у соседа');
  A.db.close(); B.db.close();
});

// ─── 4. слот занят у обеих сторон ───────────────────────────────────────────

test('приехавшая запись ДЕРЖИТ СЛОТ: второго на то же время к тому же врачу не записать', async () => {
  const A = house('A', { doctorId: 7, otherId: 8 });
  const B = house('B', { doctorId: 71, otherId: 81 });
  A.db.prepare("INSERT INTO patients (id, full_name) VALUES (3,'Иванов Иван')").run();
  B.db.prepare("INSERT INTO patients (id, full_name) VALUES (4,'Сидорова Мария')").run();

  await calendarBook(A.db, { patient_id: 3, doctor_id: 7, start: at(10), duration_minutes: 30 }, registrar);
  ship(A, B);

  await assert.rejects(
    () => calendarBook(B.db, { patient_id: 4, doctor_id: 71, start: at(10, 15), duration_minutes: 30 }, registrar),
    /занято/,
    'запись соседнего здания обязана занимать время врача — иначе врач поехал зря',
  );
  A.db.close(); B.db.close();
});

// ─── 5. настоящее столкновение ──────────────────────────────────────────────

test('столкновение внутри часа: оба здания называют ОДНОГО проигравшего', async () => {
  const A = house('A', { doctorId: 7, otherId: 8 });
  const B = house('B', { doctorId: 71, otherId: 81 });
  A.db.prepare("INSERT INTO patients (id, full_name) VALUES (3,'Иванов Иван')").run();
  B.db.prepare("INSERT INTO patients (id, full_name) VALUES (4,'Сидорова Мария')").run();

  // Два оператора занимают один слот, не зная друг о друге: обмена между ними
  // ещё не было. Ни один из них при этом ничего не нарушил.
  const inA = await calendarBook(A.db, { patient_id: 3, doctor_id: 7, start: at(10), duration_minutes: 30 }, registrar);
  const inB = await calendarBook(B.db, { patient_id: 4, doctor_id: 71, start: at(10), duration_minutes: 30 }, registrar);
  // A записал РАНЬШЕ: его booked_at заведомо меньше.
  A.db.prepare("UPDATE visits SET booked_at = '2026-09-05T09:00:00.000Z' WHERE id = ?").run(inA.visit.id);
  B.db.prepare("UPDATE visits SET booked_at = '2026-09-05T09:00:01.000Z' WHERE id = ?").run(inB.visit.id);
  const uidA = uidOf(A.db, inA.visit.id);
  const uidB = uidOf(B.db, inB.visit.id);

  ship(A, B);
  ship(B, A);

  const args = { doctor_ids: [7], date: DAY, days: 1 };
  const seenByA = calendarWindows(A.db, args, registrar).cross.visits;
  const seenByB = calendarWindows(B.db, { ...args, doctor_ids: [71] }, registrar).cross.visits;

  const idA_here = inA.visit.id;
  const idA_there = B.db.prepare('SELECT id FROM visits WHERE uid = ?').get(uidA).id;
  const idB_here = inB.visit.id;
  const idB_there = A.db.prepare('SELECT id FROM visits WHERE uid = ?').get(uidB).id;

  assert.equal(seenByA[idA_here].collision.loses, false, 'A записал раньше — его запись выигрывает');
  assert.equal(seenByA[idB_there].collision.loses, true);
  assert.equal(seenByB[idA_there].collision.loses, false, 'и в здании B ответ обязан быть ТОТ ЖЕ');
  assert.equal(seenByB[idB_here].collision.loses, true,
    'здания назвали разных проигравших — каждое ждало бы своего пациента');

  // Проигравшая запись НЕ УДАЛЕНА и не подменена: обе видны в обоих зданиях,
  // разрешение спора — работа человека, а не молчаливое стирание строки.
  assert.equal(A.db.prepare('SELECT COUNT(*) n FROM visits').get().n, 2);
  assert.equal(B.db.prepare('SELECT COUNT(*) n FROM visits').get().n, 2);
  A.db.close(); B.db.close();
});
