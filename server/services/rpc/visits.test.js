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

// ═══════════════════════════════════════════════════════════════════════════
// CRM_REAL_BOOKING_V1 (2026-09-21) — СОЗДАНИЕ ВИЗИТА ЭТО «ЗАПИСАН», А НЕ «ПРИШЁЛ»
// ═══════════════════════════════════════════════════════════════════════════
//
// ЧТО ЗДЕСЬ ПРОВЕРЯЛОСЬ РАНЬШЕ И ПОЧЕМУ ЭТО БЫЛО НЕПРАВДОЙ. Прежние тесты
// (CRM_AUTO_CAME_V1, CRM_FUTURE_LEAD_V2) пришпиливали такое правило: визит
// создан — строки заявки 'done', заявка в «Пришёл». То есть человек объявлялся
// дошедшим в тот миг, когда его ЗАПИСАЛИ: по телефону, за неделю до приёма.
// Воронка колл-центра считала конверсией собственную запись, и «Не пришёл» в
// ней появиться не мог, если оператор успел записать.
//
// Владелец (2026-09-21) развёл эти два факта: запись — это НАСТОЯЩИЙ слот
// (D1), «Пришёл» — это пациент ФИЗИЧЕСКИ пришёл (D2). Поэтому ensure_visit
// теперь делает ровно одно: строка заявки берёт себе визит, заявка уезжает в
// «Записан», строки остаются 'pending'. Закрытие строк и переход в «Пришёл»
// живут на отметке прихода — server/services/crm/visit-status.js.
const addReq = (db, { status = 'scheduled', date = null, patient = 1, name = 'Лид' } = {}) =>
  db.prepare('INSERT INTO crm_requests (full_name, phone, status, patient_id, scheduled_date) VALUES (?,?,?,?,?)')
    .run(name, '998900000000', status, patient, date).lastInsertRowid;
const addLine = (db, requestId, { date = null, status = 'pending', doctor = null, visit = null } = {}) =>
  db.prepare('INSERT INTO crm_request_services (request_id, service_id, scheduled_date, status, doctor_id, visit_id) VALUES (?,NULL,?,?,?,?)')
    .run(requestId, date, status, doctor, visit).lastInsertRowid;
const line = (db, id) => db.prepare('SELECT status, visit_id, doctor_id, scheduled_date FROM crm_request_services WHERE id=?').get(id);
const reqRow = (db, id) => db.prepare('SELECT status, scheduled_date FROM crm_requests WHERE id=?').get(id);

test('CRM_REAL_BOOKING_V1: визит заводится — строка берёт себе слот, заявка уходит в «Записан»', async () => {
  const db = freshDb();
  const rid = addReq(db, { status: 'in_process', date: '2026-08-09' });
  const lid = addLine(db, rid, { date: '2026-08-09' });

  const out = await ensureVisit(db, { patient_id: 1, date: '2026-08-09' }, REG);

  assert.equal(line(db, lid).visit_id, out.visit.id, 'строка заявки не запомнила визит, который её держит');
  assert.equal(line(db, lid).status, 'pending',
    'строка закрыта записью: в день приёма регистратуре нечего будет подставить в смету');
  assert.equal(reqRow(db, rid).status, 'scheduled',
    'заявка не уехала в «Записан» — доска колл-центра не покажет, что человек записан');
});

// САМОЕ ГЛАВНОЕ РЕШЕНИЕ ВЛАДЕЛЬЦА, ОДНОЙ ПРОВЕРКОЙ. «Пришёл» — это приход, а не
// запись. Ни один способ позвать ensure_visit не вправе объявить конверсию.
test('CRM_REAL_BOOKING_V1: создание визита НИКОГДА не ставит «Пришёл»', async () => {
  const db = freshDb();
  const dated = addReq(db, { status: 'in_process', date: '2026-08-09' });
  addLine(db, dated, { date: '2026-08-09' });
  const undated = addReq(db, { status: 'recall', name: 'без даты' });
  addLine(db, undated, { date: null });

  await ensureVisit(db, { patient_id: 1, date: '2026-08-09' }, REG);

  assert.equal(db.prepare("SELECT COUNT(*) n FROM crm_requests WHERE status='came'").get().n, 0,
    'визит объявил конверсию в тот миг, когда пациента только записали');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM crm_request_services WHERE status='done'").get().n, 0,
    'строки заявки закрыты записью, а не приходом');
});

test('CRM_REAL_BOOKING_V1: строка без даты — это «когда придёт», и она берёт визит дня', async () => {
  const db = freshDb();
  const rid = addReq(db, { status: 'in_process' });
  const nul = addLine(db, rid, { date: null });
  const blank = addLine(db, rid, { date: '' });

  const out = await ensureVisit(db, { patient_id: 1, date: '2026-08-09' }, REG);

  assert.equal(line(db, nul).visit_id, out.visit.id);
  assert.equal(line(db, blank).visit_id, out.visit.id, 'пустая строка даты — та же «без даты»');
  assert.equal(reqRow(db, rid).scheduled_date, '2026-08-09',
    'у заявки без даты не появилась дата визита: карточка и отчёт колл-центра останутся ни с чем');
});

test('CRM_REAL_BOOKING_V1: заявка на три дня — визит берёт ТОЛЬКО свой день', async () => {
  const db = freshDb();
  const rid = addReq(db, { status: 'in_process', date: '2026-08-09' });
  const d1 = addLine(db, rid, { date: '2026-08-09' });
  const d2 = addLine(db, rid, { date: '2026-08-10' });
  const d3 = addLine(db, rid, { date: '2026-08-11' });

  const first = await ensureVisit(db, { patient_id: 1, date: '2026-08-09' }, REG);

  assert.equal(line(db, d1).visit_id, first.visit.id);
  assert.equal(line(db, d2).visit_id, null, 'второй день заняли слотом первого — у него будет свой');
  assert.equal(line(db, d3).visit_id, null, 'третий день заняли слотом первого');
  assert.equal(reqRow(db, rid).status, 'scheduled');
  assert.equal(reqRow(db, rid).scheduled_date, '2026-08-09', 'дата заявки уехала вперёд ещё до приёма');

  // Второй день записывается своим визитом — и берёт ровно свою строку.
  const second = await ensureVisit(db, { patient_id: 1, date: '2026-08-10' }, REG);
  assert.equal(line(db, d2).visit_id, second.visit.id);
  assert.equal(line(db, d1).visit_id, first.visit.id, 'строку первого дня перецепили на второй визит');
  assert.equal(line(db, d3).visit_id, null);
});

test('CRM_REAL_BOOKING_V1: завтрашняя строка сегодняшним визитом не занимается', async () => {
  const db = freshDb();
  const rid = addReq(db, { status: 'approved', date: '2026-08-10' });
  const lid = addLine(db, rid, { date: '2026-08-10' });

  await ensureVisit(db, { patient_id: 1, date: '2026-08-09' }, REG);

  assert.equal(line(db, lid).visit_id, null,
    'завтрашняя услуга привязана к сегодняшнему визиту — завтра её слот пропадёт');
  const row = reqRow(db, rid);
  assert.equal(row.status, 'approved', 'заявку, у которой этот визит ничего не взял, всё-таки подвинули');
  assert.equal(row.scheduled_date, '2026-08-10', 'у завтрашней записи переписали дату');
});

// ПРОСРОЧЕННАЯ СТРОКА — ЭТО НЕ СЕГОДНЯШНЯЯ. Прежнее правило закрытия брало
// «не позже сегодня» (date(scheduled_date) <= date(day)), и вчерашняя
// несостоявшаяся запись молча прицепилась бы к сегодняшнему слоту: пациент
// пришёл сдать кровь, а продукт объявил бы, что он заодно был вчера у врача.
// У той строки был свой слот, и разбираться с ним человеку.
test('CRM_REAL_BOOKING_V1: вчерашняя строка не прицепляется к сегодняшнему визиту', async () => {
  const db = freshDb();
  const rid = addReq(db, { status: 'scheduled', date: '2026-08-08' });
  const overdue = addLine(db, rid, { date: '2026-08-08' });

  await ensureVisit(db, { patient_id: 1, date: '2026-08-09' }, REG);

  assert.equal(line(db, overdue).visit_id, null,
    'вчерашняя строка взяла сегодняшний визит: просроченная запись выдана за состоявшуюся');
  assert.equal(reqRow(db, rid).scheduled_date, '2026-08-08', 'дату просроченной заявки переписали задним числом');
});

// ВРАЧА СТРОКИ НЕ ТРОГАЕМ. В строке — тот, кого пообещали пациенту по телефону
// (миграция 058); у визита дня врач свой, первый, кто на этот день попался.
test('CRM_REAL_BOOKING_V1: врач строки остаётся тем, кого пообещали по телефону', async () => {
  const db = freshDb();
  const rid = addReq(db, { status: 'in_process', date: '2026-08-09' });
  const bare = addLine(db, rid, { date: '2026-08-09' });
  const named = addLine(db, rid, { date: '2026-08-09', doctor: 2 });

  await ensureVisit(db, { patient_id: 1, date: '2026-08-09', doctor_id: 2 }, REG);

  assert.equal(line(db, bare).doctor_id, null, 'строке проставили врача визита — регистратура подставит не того');
  assert.equal(line(db, named).doctor_id, 2);
});

test('CRM_REAL_BOOKING_V1: строка, занятая ЖИВЫМ визитом, не перецепляется', async () => {
  const db = freshDb();
  const rid = addReq(db, { status: 'scheduled', date: '2026-08-09' });
  // Пациент уже записан на завтра, и эта строка держит ТОТ слот.
  const tomorrow = await ensureVisit(db, { patient_id: 1, date: '2026-08-10' }, REG);
  const lid = addLine(db, rid, { date: '2026-08-09', visit: tomorrow.visit.id });

  const today = await ensureVisit(db, { patient_id: 1, date: '2026-08-09' }, REG);

  assert.equal(line(db, lid).visit_id, tomorrow.visit.id,
    'строку увели с живой записи: пациента ждут завтра, а слот у него отобрали');
  assert.notEqual(today.visit.id, tomorrow.visit.id);
});

// МЁРТВЫЙ ВИЗИТ СТРОКУ НЕ ДЕРЖИТ. Пациент не пришёл во вторник — его строка
// осталась со ссылкой на ту запись (неявка её НАМЕРЕННО не стирает: это след
// того, что запись была). В среду регистратура записывает его заново, и если
// бы правило смотрело только на «ссылка пуста», строка навсегда осталась бы
// висеть на несостоявшемся визите: в новый слот она бы не переехала никогда.
test('CRM_REAL_BOOKING_V1: строку с несостоявшейся записи можно записать заново', async () => {
  const db = freshDb();
  const rid = addReq(db, { status: 'scheduled', date: '2026-08-09' });
  const missed = await ensureVisit(db, { patient_id: 1, date: '2026-08-09' }, REG);
  const lid = addLine(db, rid, { date: '2026-08-09', visit: missed.visit.id });
  db.prepare("UPDATE visits SET status='no_show' WHERE id=?").run(missed.visit.id);
  // Перезапись двигает и дату строки — так это делает карточка заявки.
  db.prepare("UPDATE crm_request_services SET scheduled_date='2026-08-10' WHERE id=?").run(lid);

  const again = await ensureVisit(db, { patient_id: 1, date: '2026-08-10' }, REG);

  assert.equal(line(db, lid).visit_id, again.visit.id,
    'строка осталась на несостоявшемся визите — новый слот её не получил, и в четверг регистратура её не увидит');
  assert.equal(line(db, lid).status, 'pending');
});

// ЗАЯВКА БЕЗ СТРОК — ЛИД ИЗ ЗВОНКА. Взять visit_id ей нечем, и до этого
// прохода запись её не касалась вовсе: доска показывала «В обработке» у
// человека, которому уже назвали время.
test('CRM_REAL_BOOKING_V1: заявка без строк тоже уезжает в «Записан»', async () => {
  const db = freshDb();
  const bare = addReq(db, { status: 'in_process' });
  const other = addReq(db, { status: 'in_process', date: '2026-09-15', name: 'на сентябрь' });
  addLine(db, other, { date: '2026-09-15' });

  await ensureVisit(db, { patient_id: 1, date: '2026-08-09' }, REG);

  const row = reqRow(db, bare);
  assert.equal(row.status, 'scheduled', 'лид из звонка так и висит в «В обработке» у записанного пациента');
  assert.equal(row.scheduled_date, '2026-08-09', 'у лида без строк не появилась дата записи');
  assert.equal(reqRow(db, other).status, 'in_process',
    'заявку со строкой на сентябрь подвинула сегодняшняя запись');
});

test('CRM_REAL_BOOKING_V1: запись не воскрешает недошедшую заявку без строк', async () => {
  const db = freshDb();
  const missed = addReq(db, { status: 'no_show', name: 'не пришёл' });

  await ensureVisit(db, { patient_id: 1, date: '2026-08-09' }, REG);

  assert.equal(reqRow(db, missed).status, 'no_show',
    'запись объявила недошедшую заявку живой: воскресить её вправе только приход');
});

test('CRM_REAL_BOOKING_V1: второй ensure_visit того же дня досчитывает незанятую строку', async () => {
  const db = freshDb();
  const rid = addReq(db, { status: 'in_process', date: '2026-08-09' });
  const morning = addLine(db, rid, { date: '2026-08-09' });

  const a = await ensureVisit(db, { patient_id: 1, date: '2026-08-09T09:00:00Z' }, REG);
  // Оператор дописал в заявку вторую услугу того же дня — и снова записал.
  const evening = addLine(db, rid, { date: '2026-08-09' });
  const b = await ensureVisit(db, { patient_id: 1, date: '2026-08-09T16:30:00Z' }, REG);

  assert.equal(b.created, false, 'день пациента — один визит');
  assert.equal(b.visit.id, a.visit.id);
  assert.equal(line(db, morning).visit_id, a.visit.id);
  assert.equal(line(db, evening).visit_id, a.visit.id,
    'дописанная строка осталась без слота: визит дня уже был, и второй заход её не заметил');
});

// ВОРОНКА НАСТРАИВАЕТСЯ (миграция 077), поэтому «Записан» спрашивается у
// справочника. Клиника, добавившая свою колонку ПЕРЕД «Записан», обязана
// увидеть, как заявка из неё уезжает записью; клиника, у которой «Записан»
// вовсе нет, получает последнюю открытую колонку перед конверсией.
test('CRM_REAL_BOOKING_V1: заявка из СВОЕЙ колонки воронки уезжает в «Записан»', async () => {
  const db = freshDb();
  db.prepare("INSERT INTO crm_stages (key,label,color,position,is_active,kind) VALUES ('waiting_pay','Ждёт оплаты','info',0,1,'open')").run();
  const own = addReq(db, { status: 'waiting_pay', name: 'своя колонка' });
  addLine(db, own, { date: '2026-08-09' });

  await ensureVisit(db, { patient_id: 1, date: '2026-08-09' }, REG);

  assert.equal(reqRow(db, own).status, 'scheduled',
    'заявка из добавленной клиникой колонки не уехала в «Записан» — воронка настраивается только на вид');
});

test('CRM_REAL_BOOKING_V1: без колонки «Записан» заявка уезжает в последнюю открытую', async () => {
  const db = freshDb();
  db.prepare("DELETE FROM crm_stages WHERE key='scheduled'").run();
  const rid = addReq(db, { status: 'in_process' });
  addLine(db, rid, { date: '2026-08-09' });

  await ensureVisit(db, { patient_id: 1, date: '2026-08-09' }, REG);

  assert.equal(reqRow(db, rid).status, 'approved',
    'у клиники без сидовой колонки запись не нашла куда двинуть заявку');
});

test('CRM_REAL_BOOKING_V1: заявка не откатывается назад по воронке', async () => {
  const db = freshDb();
  const rid = addReq(db, { status: 'approved', date: '2026-08-09' });
  const lid = addLine(db, rid, { date: '2026-08-09' });

  const out = await ensureVisit(db, { patient_id: 1, date: '2026-08-09' }, REG);

  assert.equal(line(db, lid).visit_id, out.visit.id, 'строка согласованной заявки осталась без слота');
  assert.equal(reqRow(db, rid).status, 'approved',
    'согласованную заявку отбросило назад в «Записан» — доска потеряла шаг, который уже сделали');
});

test('CRM_REAL_BOOKING_V1: справочник ступеней пуст — визит не падает и берёт сидовую воронку', async () => {
  const db = freshDb();
  const rid = addReq(db, { status: 'in_process' });
  const lid = addLine(db, rid, { date: '2026-08-09' });
  // Справочник недоступен (пустая таблица — тот же исход, что отказ чтения):
  // ссылку на него снимаем, иначе удалить строки не даст внешний ключ.
  db.pragma('foreign_keys = OFF');
  db.prepare('DELETE FROM crm_stages').run();

  const out = await ensureVisit(db, { patient_id: 1, date: '2026-08-09' }, REG);

  assert.equal(out.created, true, 'пустой справочник CRM отказал в визите');
  assert.equal(line(db, lid).visit_id, out.visit.id, 'без справочника запись перестала связывать строку со слотом');
  assert.equal(reqRow(db, rid).status, 'scheduled', 'без справочника переход в «Записан» пропал совсем');
  db.pragma('foreign_keys = ON');
});

// ПРОИГРЫШНУЮ ЗАЯВКУ ЗАПИСЬ НЕ ВОСКРЕШАЕТ. «Не пришёл» в выборке есть — его
// строки записать заново можно и нужно, — но объявить заявку снова живой
// вправе только приход. «Обработка остановлена» не попадает в выборку вовсе:
// с ней осознанно перестали работать.
test('CRM_REAL_BOOKING_V1: запись не воскрешает проигрышные заявки', async () => {
  const db = freshDb();
  const stopped = addReq(db, { status: 'stopped', name: 'мёртвая' });
  const stoppedLine = addLine(db, stopped, { date: '2026-08-09' });
  const missed = addReq(db, { status: 'no_show', name: 'не пришёл в прошлый раз' });
  const missedLine = addLine(db, missed, { date: '2026-08-09' });

  const out = await ensureVisit(db, { patient_id: 1, date: '2026-08-09' }, REG);

  assert.equal(reqRow(db, stopped).status, 'stopped', 'заявку, с которой перестали работать, вернули в работу');
  assert.equal(line(db, stoppedLine).visit_id, null, 'строка остановленной заявки заняла слот');
  assert.equal(line(db, missedLine).visit_id, out.visit.id,
    'пациента, не пришедшего в прошлый раз, записали заново — а его строка слота не получила');
  assert.equal(reqRow(db, missed).status, 'no_show',
    'запись объявила недошедшую заявку живой: воскресить её вправе только приход');
});

// CRM_REAL_BOOKING_V1 — ОПЕРАТОР ЗАВОДИТ ВИЗИТ САМ. Раньше «Сохранить и
// записать» писало только услугу и дату, визита не появлялось, и эта дверь
// колл-центру была не нужна. Теперь запись — настоящий слот, и заводит его
// оператор той же дверью, что регистратура.
test('CRM_REAL_BOOKING_V1: колл-центр заводит визит, касса — по-прежнему нет', async () => {
  const db = freshDb();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_active) VALUES (5,'op','x','Оператор','callcenter',1)").run();
  const out = await ensureVisit(db, { patient_id: 1, date: '2026-08-09' }, { id: 5, role: 'callcenter' });
  assert.equal(out.created, true, 'оператор колл-центра не может записать пациента, которого сам же принял');
  await assert.rejects(() => ensureVisit(db, { patient_id: 1, date: '2026-08-10' }, { id: 9, role: 'cashier' }), /not allowed/);
});

// ═══════════════════════════════════════════════════════════════════════════
// CRM_REAL_BOOKING_V1 — ВИЗИТ ДНЯ УЖЕ ЕСТЬ, А ВРЕМЯ ВСЁ РАВНО НАДО ЗАНЯТЬ
// ═══════════════════════════════════════════════════════════════════════════
//
// ЧТО БЫЛО (разбор ревью, 2026-09-21). ensure_visit с `book:` на день, где у
// пациента уже есть живой визит, возвращал {created:false, booked:false} и
// НЕ звал calendar_book вовсе: выбранное оператором время не занималось
// ничем и никогда, а карточка считала это успехом. Человеку называли час, на
// который его никто не ждал.
//
// Теперь различаются два разных случая, и разница между ними — БЫЛА ЛИ ПО
// ЭТОМУ ВИЗИТУ РАБОТА:
//   пустой визит дня (ни услуг, ни счёта — заведён записью же) → запись
//     ПЕРЕНОСИТСЯ на новое время тем же calendar_book: это та же запись, у
//     неё просто поменялся час;
//   визит с работой (пациент уже пришёл, услуги в смете, счёт выставлен) →
//     честный отказ booked:false + reason, и в ответе лежит время того
//     визита — оператору есть что сказать вслух.
const hhmm = (iso) => { const d = new Date(iso); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };

test('CRM_REAL_BOOKING_V1: пустой визит дня ПЕРЕНОСИТСЯ на выбранное время', async () => {
  const db = freshDb();
  const rid = addReq(db, { status: 'in_process', date: '2026-08-09' });
  const lid = addLine(db, rid, { date: '2026-08-09' });
  // Визит дня уже заведён — например, прошлой записью этой же заявки.
  const first = await ensureVisit(db, { patient_id: 1, date: '2026-08-09T09:00:00Z' }, REG);
  assert.equal(first.created, true);

  const again = await ensureVisit(db, {
    patient_id: 1, date: '2026-08-09',
    book: { doctor_id: 2, start: '2026-08-09T14:30:00Z' },
  }, REG);

  assert.equal(again.created, false, 'день пациента — один визит');
  assert.equal(again.visit.id, first.visit.id);
  assert.equal(again.booked, true, 'выбранное оператором время молча не занято — пациента ждут не тогда, когда обещали');
  assert.equal(again.moved, true, 'перенос обязан быть назван переносом: карточке есть что показать');
  assert.equal(Date.parse(again.visit.visit_date), Date.parse('2026-08-09T14:30:00Z'));
  assert.equal(again.visit.doctor_id, 2);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM visits WHERE patient_id=1').get().n, 1, 'перенос завёл второй визит');
  assert.equal(line(db, lid).visit_id, first.visit.id,
    'строка заявки осталась без слота: перенос обязан связывать её так же, как первая запись');
  assert.equal(reqRow(db, rid).status, 'scheduled');
});

test('CRM_REAL_BOOKING_V1: визит дня с услугами не переносится молча — отказ называет время', async () => {
  const db = freshDb();
  const first = await ensureVisit(db, { patient_id: 1, date: '2026-08-09T09:00:00Z', doctor_id: 2 }, REG);
  // Пациент уже пришёл: услуга в смете.
  db.prepare("INSERT INTO visit_services (visit_id, service_id, status) VALUES (?, NULL, 'queued')").run(first.visit.id);

  const out = await ensureVisit(db, {
    patient_id: 1, date: '2026-08-09',
    book: { doctor_id: 2, start: '2026-08-09T14:30:00Z' },
  }, REG);

  assert.equal(out.created, false);
  assert.equal(out.booked, false, 'занятый визит дня объявлен записанным');
  assert.equal(out.moved, undefined);
  assert.equal(out.reason, 'day_visit_busy', 'отказ без причины экрану бесполезен');
  assert.equal(out.day_visit.id, first.visit.id);
  assert.equal(out.day_visit.start, hhmm(first.visit.visit_date),
    'в ответе нет времени существующего визита — оператору нечего сказать пациенту');
  assert.equal(out.day_visit.doctor_id, 2);
  assert.equal(out.day_visit.doctor_name, 'Doc');
  assert.equal(Date.parse(out.visit.visit_date), Date.parse(first.visit.visit_date),
    'время визита, по которому уже идёт работа, переписано записью');
});

test('CRM_REAL_BOOKING_V1: выставленный счёт делает визит дня занятым так же, как услуги', async () => {
  const db = freshDb();
  const first = await ensureVisit(db, { patient_id: 1, date: '2026-08-09T09:00:00Z', doctor_id: 2 }, REG);
  db.prepare(`INSERT INTO invoices (invoice_number, visit_id, patient_id, subtotal, total_amount, status)
    VALUES ('INV-9', ?, 1, 100000, 100000, 'unpaid')`).run(first.visit.id);

  const out = await ensureVisit(db, {
    patient_id: 1, date: '2026-08-09',
    book: { doctor_id: 2, start: '2026-08-09T14:30:00Z' },
  }, REG);

  assert.equal(out.booked, false);
  assert.equal(out.reason, 'day_visit_busy');
  assert.equal(Date.parse(out.visit.visit_date), Date.parse(first.visit.visit_date));
});
