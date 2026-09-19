import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { ensureVisit } from './visits.js';

const REG = { id: 1, role: 'registrar' };

function freshDb() {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_active, specialty) VALUES (1,'r','x','Reg','registrar',1,'')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_active, specialty) VALUES (2,'d','x','Doc','doctor',1,'')").run();
  db.prepare("INSERT INTO patients (id, full_name) VALUES (1,'P')").run();
  return db;
}

test('ensure_visit: one visit per patient per day — same day reuses, next day creates', async () => {
  const db = freshDb();
  const a = await ensureVisit(db, { patient_id: 1, date: '2026-08-07T09:00:00Z', doctor_id: 2 }, REG);
  assert.equal(a.created, true);
  assert.equal(a.visit.visit_date, '2026-08-07T09:00:00Z');

  // afternoon service, SAME day -> same visit, no new row
  const b = await ensureVisit(db, { patient_id: 1, date: '2026-08-07T16:30:00Z' }, REG);
  assert.equal(b.created, false);
  assert.equal(b.visit.id, a.visit.id);

  // next day -> its own visit
  const c = await ensureVisit(db, { patient_id: 1, date: '2026-08-08T10:00:00Z' }, REG);
  assert.equal(c.created, true);
  assert.notEqual(c.visit.id, a.visit.id);

  // statistics: two day-visits exist
  assert.equal(db.prepare('SELECT COUNT(*) n FROM visits WHERE patient_id=1').get().n, 2);
});

test('ensure_visit: bare date works; doctor backfills onto a doctor-less day', async () => {
  const db = freshDb();
  const a = await ensureVisit(db, { patient_id: 1, date: '2026-08-09' }, REG);
  assert.equal(a.created, true);
  assert.equal(a.visit.doctor_id, null);
  const b = await ensureVisit(db, { patient_id: 1, date: '2026-08-09T12:00:00Z', doctor_id: 2 }, REG);
  assert.equal(b.created, false);
  assert.equal(b.visit.doctor_id, 2);   // first assigned doctor lands on the day visit
});

test('ensure_visit: cancelled day does not swallow a new booking', async () => {
  const db = freshDb();
  const a = await ensureVisit(db, { patient_id: 1, date: '2026-08-10T09:00:00Z' }, REG);
  db.prepare("UPDATE visits SET status='cancelled' WHERE id=?").run(a.visit.id);
  const b = await ensureVisit(db, { patient_id: 1, date: '2026-08-10T11:00:00Z' }, REG);
  assert.equal(b.created, true);
  assert.notEqual(b.visit.id, a.visit.id);
});

test('ensure_visit: validation + roles', async () => {
  const db = freshDb();
  await assert.rejects(() => ensureVisit(db, { patient_id: 999, date: '2026-08-07' }, REG), /patient not found/);
  await assert.rejects(() => ensureVisit(db, { patient_id: 1, date: 'nope' }, REG), /date must be ISO/);
  await assert.rejects(() => ensureVisit(db, { patient_id: 1, date: '2026-08-07' }, { id: 9, role: 'cashier' }), /not allowed/);
});

test('CRM_AUTO_CAME_V1: ensure_visit flips linked active CRM leads to came, leaves others alone', async () => {
  const db = freshDb();
  db.prepare("INSERT INTO patients (id, full_name) VALUES (2,'Other')").run();
  const ins = db.prepare("INSERT INTO crm_requests (full_name, phone, status, patient_id) VALUES (?,?,?,?)");
  ins.run('L1', '1', 'scheduled', 1);        // linked, active -> came
  ins.run('L2', '2', 'no_show', 1);          // linked, missed earlier -> came
  ins.run('L3', '3', 'stopped', 1);          // linked, dead -> untouched
  ins.run('L4', '4', 'scheduled', 2);        // other patient -> untouched
  ins.run('L5', '5', 'scheduled', null);     // unlinked -> untouched

  await ensureVisit(db, { patient_id: 1, date: '2026-08-09' }, REG);

  const st = (id) => db.prepare('SELECT status FROM crm_requests WHERE id=?').get(id).status;
  assert.equal(st(1), 'came');
  assert.equal(st(2), 'came');
  assert.equal(st(3), 'stopped');
  assert.equal(st(4), 'scheduled');
  assert.equal(st(5), 'scheduled');

  // reusing the same day's visit flips too (idempotent for already-came)
  await ensureVisit(db, { patient_id: 2, date: '2026-08-09' }, REG);
  assert.equal(st(4), 'came');
});

// CRM_FUTURE_LEAD_V2 — REGRESSION: turning up for one service closed EVERY open
// lead the patient had. A consultation booked for next month was marked «Пришёл»
// on the spot: it dropped off the scheduled list and the funnel counted a
// conversion that had not happened.
test('CRM_FUTURE_LEAD_V2: a visit closes today\'s and overdue leads, never a future booking', async () => {
  const db = freshDb();
  const ins = db.prepare("INSERT INTO crm_requests (full_name, phone, status, patient_id, scheduled_date) VALUES (?,?,?,?,?)");
  ins.run('today',    '1', 'scheduled', 1, '2026-08-09');   // booked for this very day -> came
  ins.run('overdue',  '2', 'scheduled', 1, '2026-08-01');   // missed earlier, now here -> came
  ins.run('undated',  '3', 'in_process', 1, null);          // walk-in lead, no date -> came
  ins.run('blank',    '4', 'recall', 1, '');                // empty string, treated as undated -> came
  ins.run('future',   '5', 'scheduled', 1, '2026-09-15');   // next month -> MUST stay scheduled
  ins.run('tomorrow', '6', 'approved', 1, '2026-08-10');    // tomorrow -> MUST stay approved

  await ensureVisit(db, { patient_id: 1, date: '2026-08-09' }, REG);

  const st = (id) => db.prepare('SELECT status FROM crm_requests WHERE id=?').get(id).status;
  assert.equal(st(1), 'came');
  assert.equal(st(2), 'came');
  assert.equal(st(3), 'came');
  assert.equal(st(4), 'came');
  assert.equal(st(5), 'scheduled', 'a lead booked for next month must survive today\'s visit');
  assert.equal(st(6), 'approved', 'tomorrow\'s appointment must survive today\'s visit');

  // …and when the patient turns up for it, it closes then.
  await ensureVisit(db, { patient_id: 1, date: '2026-09-15' }, REG);
  assert.equal(st(5), 'came');
  assert.equal(st(6), 'came');   // by then it is overdue, so it closes too
});

// CRM_LINKS_V1 (2026-09-20) — ВОРОНКА НАСТРАИВАЕТСЯ, А СПИСОК СТУПЕНЕЙ БЫЛ
// ЗАШИТ. Миграция 077 сделала колонки канбана ДАННЫМИ («добавить колонку "Ждёт
// оплаты" больше не значит выпустить релиз»), но переход «пациент дошёл»
// сверялся с константой из восьми сидовых ключей. Клиника заводила свою
// колонку — и заявка из неё не закрывалась ничем: пациент приходил, визит
// создавался, а лид оставался висеть и уходил в отчёт как недошедший.
test('CRM_LINKS_V1: заявка в СВОЕЙ колонке воронки тоже закрывается визитом', async () => {
  const db = freshDb();
  db.prepare("INSERT INTO crm_stages (key,label,color,position,is_active,kind) VALUES ('waiting_pay','Ждёт оплаты','info',9,1,'open')").run();
  const ins = db.prepare("INSERT INTO crm_requests (full_name, phone, status, patient_id) VALUES (?,?,?,?)");
  ins.run('своя колонка', '1', 'waiting_pay', 1);
  ins.run('сидовая',      '2', 'scheduled',   1);
  ins.run('мёртвая',      '3', 'stopped',     1);

  await ensureVisit(db, { patient_id: 1, date: '2026-08-09' }, REG);

  const st = (id) => db.prepare('SELECT status FROM crm_requests WHERE id=?').get(id).status;
  assert.equal(st(1), 'came', 'заявка из добавленной клиникой колонки не закрылась — воронка настраивается только на вид');
  assert.equal(st(2), 'came');
  assert.equal(st(3), 'stopped', 'закрытая заявка ожила');
});

// ═══════════════════════════════════════════════════════════════════════════
// CRM_LINKS_V1 (2026-09-20) — ЗАКРЫТИЕ СТРОК ЗАЯВКИ ЖИВЁТ ЗДЕСЬ, НА СЕРВЕРЕ
// ═══════════════════════════════════════════════════════════════════════════
//
// Заявка колл-центра — это НЕ одна дата. С миграции 057 у неё строки
// (crm_request_services), у каждой своя услуга и свой день: «УЗИ во вторник,
// анализы в среду» — одна заявка. А переход «Пришёл» смотрел ТОЛЬКО на
// родителя: первый же визит закрывал заявку целиком, и оставшиеся два дня
// исчезали у регистратуры — в смете ничего не подставлялось, в отчёте
// «запись вперёд» их не было.
//
// Зеркальная половина того же бага жила на клиенте: окно быстрой регистрации
// звало closeCrmLinesForPatient(), а та отбирала родителей по ОТКРЫТЫМ
// ступеням — после серверного перехода в «Пришёл» открытых уже не было, и
// строки оставались 'pending' навсегда. Код, который никогда ничего не делал.
//
// Правило теперь одно и стоит там, где заводится визит: строки этого дня (и
// просроченные) → 'done'; родитель уходит в «Пришёл» ТОЛЬКО когда ждать
// больше нечего, иначе остаётся в своей колонке с датой ближайшей оставшейся
// строки.
const addReq = (db, { status = 'scheduled', date = null, patient = 1, name = 'Лид' } = {}) =>
  db.prepare('INSERT INTO crm_requests (full_name, phone, status, patient_id, scheduled_date) VALUES (?,?,?,?,?)')
    .run(name, '998900000000', status, patient, date).lastInsertRowid;
const addLine = (db, requestId, { date = null, status = 'pending' } = {}) =>
  db.prepare('INSERT INTO crm_request_services (request_id, service_id, scheduled_date, status) VALUES (?,NULL,?,?)')
    .run(requestId, date, status).lastInsertRowid;
const lineStatus = (db, id) => db.prepare('SELECT status FROM crm_request_services WHERE id=?').get(id).status;
const reqRow = (db, id) => db.prepare('SELECT status, scheduled_date FROM crm_requests WHERE id=?').get(id);

test('CRM_LINKS_V1: заявка на один день — строка закрыта, заявка «Пришёл»', async () => {
  const db = freshDb();
  const rid = addReq(db, { date: '2026-08-09' });
  const lid = addLine(db, rid, { date: '2026-08-09' });

  await ensureVisit(db, { patient_id: 1, date: '2026-08-09' }, REG);

  assert.equal(lineStatus(db, lid), 'done',
    'строка заявки осталась «pending»: завтра регистратура снова увидит в смете уже оплаченную услугу');
  assert.equal(reqRow(db, rid).status, 'came', 'ждать больше нечего, а заявка не закрылась');
});

test('CRM_LINKS_V1: заявка на три дня переживает первый визит', async () => {
  const db = freshDb();
  const rid = addReq(db, { date: '2026-08-09' });
  const d1 = addLine(db, rid, { date: '2026-08-09' });
  const d2 = addLine(db, rid, { date: '2026-08-10' });
  const d3 = addLine(db, rid, { date: '2026-08-11' });

  await ensureVisit(db, { patient_id: 1, date: '2026-08-09' }, REG);

  assert.equal(lineStatus(db, d1), 'done', 'услуга первого дня оформлена, а её строка всё ещё ждёт');
  assert.equal(lineStatus(db, d2), 'pending', 'второй день закрылся вместе с первым — регистратура его не увидит');
  assert.equal(lineStatus(db, d3), 'pending', 'третий день закрылся вместе с первым');
  const after1 = reqRow(db, rid);
  assert.equal(after1.status, 'scheduled', 'заявка ушла в «Пришёл», хотя два дня ещё впереди');
  assert.equal(after1.scheduled_date, '2026-08-10',
    'дата заявки осталась вчерашней: ночная автоматика унесёт живую заявку в «Не пришёл»');

  await ensureVisit(db, { patient_id: 1, date: '2026-08-10' }, REG);
  assert.equal(lineStatus(db, d2), 'done');
  assert.equal(reqRow(db, rid).scheduled_date, '2026-08-11');
  assert.equal(reqRow(db, rid).status, 'scheduled');

  await ensureVisit(db, { patient_id: 1, date: '2026-08-11' }, REG);
  assert.equal(lineStatus(db, d3), 'done');
  assert.equal(reqRow(db, rid).status, 'came', 'последний день оформлен, а заявка так и не закрылась');
});

test('CRM_LINKS_V1: строка на завтра не закрывается сегодняшним визитом', async () => {
  const db = freshDb();
  const rid = addReq(db, { status: 'approved', date: '2026-08-10' });
  const lid = addLine(db, rid, { date: '2026-08-10' });

  await ensureVisit(db, { patient_id: 1, date: '2026-08-09' }, REG);

  assert.equal(lineStatus(db, lid), 'pending',
    'завтрашняя услуга закрыта сегодняшним приходом — завтра её никто не подставит');
  const row = reqRow(db, rid);
  assert.equal(row.status, 'approved', 'завтрашняя запись отмечена состоявшейся');
  assert.equal(row.scheduled_date, '2026-08-10', 'у завтрашней записи переписали дату');
});

test('CRM_LINKS_V1: справочник ступеней пуст — визит закрывает заявку сидовой воронкой', async () => {
  const db = freshDb();
  const rid = addReq(db, { status: 'scheduled' });
  const lid = addLine(db, rid, { date: '2026-08-09' });
  // Справочник недоступен (пустая таблица — тот же исход, что отказ чтения):
  // ссылку на него снимаем, иначе удалить строки не даст внешний ключ.
  db.pragma('foreign_keys = OFF');
  db.prepare('DELETE FROM crm_stages').run();

  await ensureVisit(db, { patient_id: 1, date: '2026-08-09' }, REG);

  assert.equal(lineStatus(db, lid), 'done', 'без справочника визит перестал закрывать строки');
  assert.equal(reqRow(db, rid).status, 'came', 'без справочника переход «Пришёл» пропал совсем');
  db.pragma('foreign_keys = ON');
});

// CRM_LINKS_V1 — «НЕ ПРИШЁЛ» ЭТО ИМЯ, А НЕ «ЛЮБАЯ ПРОИГРЫШНАЯ КОЛОНКА».
//
// Закрывать визитом надо и того, кто в прошлый раз не пришёл: он пришёл
// сейчас, и это та самая конверсия. Но запасной вариант noShowStageKey()
// отдаёт ПЕРВУЮ проигрышную колонку, когда сидовой нет, — и клиника,
// переименовавшая «Не пришёл», получала визит, воскрешающий «Обработка
// остановлена»: заявку, с которой осознанно перестали работать, продукт
// объявлял дошедшей.
test('CRM_LINKS_V1: визит не воскрешает «Обработка остановлена» вместо «Не пришёл»', async () => {
  const db = freshDb();
  const stopped = addReq(db, { status: 'stopped', name: 'мёртвая' });
  // Сидовой колонки «Не пришёл» в этой клинике больше нет — первой проигрышной
  // стала «Обработка остановлена».
  db.prepare("DELETE FROM crm_stages WHERE key = 'no_show'").run();

  await ensureVisit(db, { patient_id: 1, date: '2026-08-09' }, REG);

  assert.equal(reqRow(db, stopped).status, 'stopped',
    'визит объявил дошедшей заявку, с которой перестали работать: запасная проигрышная колонка попала в переход');
});
