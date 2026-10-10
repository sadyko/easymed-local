// CRM_REAL_BOOKING_V1 — «ПРИШЁЛ» СТАВИТ ПРИХОД, А НЕ ЗАПИСЬ.
//
// Здесь проверяется вторая половина правила: что происходит с заявкой, когда у
// ЕЁ визита меняется статус. Первая половина (запись берёт слот, заявка уезжает
// в «Записан») живёт в rpc/visits.js и проверяется в visits.test.js.
//
// Словарь статусов визита — пять слов из миграции 003: scheduled, confirmed,
// arrived, cancelled, no_show. Ни 'in_progress', ни 'completed' у визита нет,
// поэтому приход здесь ровно один — 'arrived'.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { crmVisitStatus, crmVisitEvidence, crmInvoiceEvidence, crmServiceEvidence, ARRIVED_STATUSES, EVIDENCE_SERVICE_STATUSES } from './visit-status.js';
// Деньги проверяются НАСТОЯЩЕЙ кассой, а не имитацией платежа: доказательством
// является то, что делает record_payment, а не то, что мы про него думаем.
import { recordPayment, markInvoiceDebt, createInvoiceForVisit } from '../rpc/billing.js';
// CROSS_BRANCH_CALENDAR_V1 — вторая дверь, через которую статус визита может
// смениться: порция обмена от соседнего здания (branch-sync/records.js).
import { applyBatch } from '../branch-sync/records.js';

// CRM_UNIFY_V1 (проверка ревью задачи 3) — ИНВАРИАНТ: строка заявки закрывается
// ('done'), только если её услуга действительно в визите. Поэтому строки здесь —
// с услугой (90, анализ): приход ставит её в визит (placeHeldLines) и только
// тогда закрывает. Прежде строки были без услуги и закрывались без строки визита.
const LINE_SVC = 90;
function freshDb() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO patients (id, full_name) VALUES (1,'Пациент')").run();
  db.prepare("INSERT INTO services (id, name, price, type, is_lab) VALUES (?, 'Анализ (заявка)', 30000, 'lab', 1)").run(LINE_SVC);
  return db;
}
const addVisit = (db, date = '2026-08-09T09:00:00Z', status = 'scheduled') =>
  db.prepare('INSERT INTO visits (patient_id, visit_date, status) VALUES (1,?,?)').run(date, status).lastInsertRowid;
const addReq = (db, { status = 'scheduled', date = null, name = 'Лид' } = {}) =>
  db.prepare('INSERT INTO crm_requests (full_name, phone, status, patient_id, scheduled_date) VALUES (?,?,?,1,?)')
    .run(name, '998900000000', status, date).lastInsertRowid;
const addLine = (db, requestId, { date = null, status = 'pending', visit = null, svc = LINE_SVC } = {}) =>
  db.prepare('INSERT INTO crm_request_services (request_id, service_id, scheduled_date, status, visit_id) VALUES (?,?,?,?,?)')
    .run(requestId, svc, date, status, visit).lastInsertRowid;
const line = (db, id) => db.prepare('SELECT status, visit_id FROM crm_request_services WHERE id=?').get(id);
/** Строка визита, которую держит строка заявки (null — услуги в визите нет). */
const lineVs = (db, id) => db.prepare(`SELECT vs.visit_id, vs.service_id, vs.status FROM crm_request_services l
                                         JOIN visit_services vs ON vs.id = l.visit_service_id WHERE l.id = ?`).get(id) || null;
const reqRow = (db, id) => db.prepare('SELECT status, scheduled_date FROM crm_requests WHERE id=?').get(id);

test('словарь прихода — это статус визита «arrived», и он один', () => {
  assert.deepEqual([...ARRIVED_STATUSES], ['arrived']);
});

// ─── ПРИШЁЛ ────────────────────────────────────────────────────────────────

test('пришёл: строки визита закрываются, заявка становится конверсией', () => {
  const db = freshDb();
  const vid = addVisit(db);
  const rid = addReq(db, { date: '2026-08-09' });
  const lid = addLine(db, rid, { date: '2026-08-09', visit: vid });

  crmVisitStatus(db, { visitId: vid, from: 'scheduled', to: 'arrived' });

  assert.equal(line(db, lid).status, 'done', 'пациент пришёл, а строка заявки так и ждёт');
  // CRM_UNIFY_V1 (инвариант) — строка закрыта, потому что её услуга в визите.
  assert.deepEqual(lineVs(db, lid), { visit_id: vid, service_id: LINE_SVC, status: 'added' },
    'строка закрыта, а услуги в визите нет — касса её не увидит');
  assert.equal(reqRow(db, rid).status, 'came', 'ждать больше нечего, а конверсии нет');
  db.close();
});

// CRM_UNIFY_V1 (проверка ревью задачи 3) — ИНВАРИАНТ: услугу, которую в визит
// поставить нельзя (снята с продажи), приход не закрывает — строка ждёт; карточка
// при этом закрывается (ступень от строк не зависит).
test('CRM_UNIFY_V1: строка без услуги в визите приходом не закрывается — ждёт; карточка закрыта', () => {
  const db = freshDb();
  db.prepare("INSERT INTO services (id, name, price, type, active) VALUES (91, 'Снятая', 10000, 'procedure', 0)").run();
  const vid = addVisit(db);
  const rid = addReq(db, { date: '2026-08-09' });
  const lid = addLine(db, rid, { date: '2026-08-09', visit: vid, svc: 91 });

  crmVisitStatus(db, { visitId: vid, from: 'scheduled', to: 'arrived' });

  assert.deepEqual([line(db, lid).status, lineVs(db, lid)], ['pending', null], 'строка закрыта без услуги в визите');
  assert.equal(reqRow(db, rid).status, 'came');
  db.close();
});

// CRM_UNIFY_V1 — первый приход закрывает карточку (решение владельца 1); строки
// других дней остаются в карточке и в календаре как записи. Прежде здесь было
// «заявка на три дня закрывается последним днём» — правило отменено владельцем.
test('пришёл: первый приход закрывает заявку на три дня — строки других дней остаются записями', () => {
  const db = freshDb();
  const v1 = addVisit(db, '2026-08-09T09:00:00Z');
  const v2 = addVisit(db, '2026-08-10T09:00:00Z');
  const rid = addReq(db, { date: '2026-08-09' });
  const d1 = addLine(db, rid, { date: '2026-08-09', visit: v1 });
  const d2 = addLine(db, rid, { date: '2026-08-10', visit: v2 });
  const d3 = addLine(db, rid, { date: '2026-08-11' });

  crmVisitStatus(db, { visitId: v1, from: 'scheduled', to: 'arrived' });

  assert.equal(reqRow(db, rid).status, 'came', 'пациент пришёл, а карточка ждёт последнего дня');
  assert.equal(line(db, d1).status, 'done');
  assert.deepEqual(line(db, d2), { status: 'pending', visit_id: v2 }, 'запись второго дня пропала из карточки');
  assert.equal(line(db, d3).status, 'pending');

  // Второй приход ничего не ломает: карточка закрыта, строка его дня — 'done'.
  crmVisitStatus(db, { visitId: v2, from: 'scheduled', to: 'arrived' });
  assert.equal(reqRow(db, rid).status, 'came');
  assert.equal(line(db, d2).status, 'done');
  db.close();
});

test('пришёл: недошедшая в прошлый раз заявка воскресает приходом', () => {
  const db = freshDb();
  const vid = addVisit(db);
  const rid = addReq(db, { status: 'no_show', name: 'не пришёл в прошлый раз' });
  addLine(db, rid, { date: '2026-08-09', visit: vid });

  crmVisitStatus(db, { visitId: vid, from: 'scheduled', to: 'arrived' });

  assert.equal(reqRow(db, rid).status, 'came',
    'человек, не пришедший в прошлый раз, пришёл сейчас — это и есть конверсия');
  db.close();
});

// CRM_UNIFY_V1 — первый приход закрывает карточку (решение владельца 1); строки
// других дней остаются в карточке и в календаре как записи. Прежде заявка
// дальше «Записан» с ждущей строкой оставалась на своей ступени.
test('пришёл: заявка дальше «Записан» тоже закрывается приходом', () => {
  const db = freshDb();
  const vid = addVisit(db);
  const rid = addReq(db, { status: 'approved', date: '2026-08-09' });
  addLine(db, rid, { date: '2026-08-09', visit: vid });
  const later = addLine(db, rid, { date: '2026-08-15' });   // строка другого дня

  crmVisitStatus(db, { visitId: vid, from: 'scheduled', to: 'arrived' });

  assert.equal(reqRow(db, rid).status, 'came', 'пациент пришёл, а «Согласован» так и стоит');
  assert.equal(line(db, later).status, 'pending', 'строка другого дня закрылась вместе с приходом');
  db.close();
});

test('CRM_UNIFY_V1: приход закрывает и карточку, привязанную к визиту только записью (без строк)', () => {
  const db = freshDb();
  const vid = addVisit(db);
  const rid = addReq(db, { status: 'scheduled', date: '2026-07-01' });   // дата карточки — другая
  db.prepare("INSERT INTO crm_booking_links (visit_id, request_id, source) VALUES (?, ?, 'match')").run(vid, rid);
  crmVisitStatus(db, { visitId: vid, from: 'scheduled', to: 'arrived' });
  assert.equal(reqRow(db, rid).status, 'came', 'запись календаря без строк заявки так и не закрылась приходом');
  db.close();
});

test('CRM_UNIFY_V1: приход не трогает «Отказ» и прочие закрытые — ни по строке, ни по привязке', () => {
  const db = freshDb();
  const vid = addVisit(db);
  const stopped = addReq(db, { status: 'stopped' });
  addLine(db, stopped, { date: '2026-08-09', visit: vid });
  const unqualified = addReq(db, { status: 'not_qualified' });
  db.prepare("INSERT INTO crm_booking_links (visit_id, request_id, source) VALUES (?, ?, 'match')").run(vid, unqualified);
  crmVisitStatus(db, { visitId: vid, from: 'scheduled', to: 'arrived' });
  assert.equal(reqRow(db, stopped).status, 'stopped', 'приход открыл закрытую «Отказ»');
  assert.equal(reqRow(db, unqualified).status, 'not_qualified');
  db.close();
});

test('пришёл дважды — второй раз не делает ничего', () => {
  const db = freshDb();
  const vid = addVisit(db);
  const rid = addReq(db, { date: '2026-08-09' });
  addLine(db, rid, { date: '2026-08-09', visit: vid });

  crmVisitStatus(db, { visitId: vid, from: 'scheduled', to: 'arrived' });
  const after = reqRow(db, rid);
  const stamp = db.prepare('SELECT updated_at FROM crm_requests WHERE id=?').get(rid).updated_at;
  // Тот же статус второй раз — это не событие.
  crmVisitStatus(db, { visitId: vid, from: 'arrived', to: 'arrived' });
  assert.deepEqual(reqRow(db, rid), after);
  assert.equal(db.prepare('SELECT updated_at FROM crm_requests WHERE id=?').get(rid).updated_at, stamp,
    'повторная отметка переписала заявку заново');
  db.close();
});

// ─── НЕ ПРИШЁЛ ─────────────────────────────────────────────────────────────

test('не пришёл: заявка уходит в «Не пришёл», строки остаются', () => {
  const db = freshDb();
  const vid = addVisit(db);
  const rid = addReq(db, { date: '2026-08-09' });
  const lid = addLine(db, rid, { date: '2026-08-09', visit: vid });

  crmVisitStatus(db, { visitId: vid, from: 'scheduled', to: 'no_show' });

  assert.equal(reqRow(db, rid).status, 'no_show');
  assert.equal(line(db, lid).status, 'pending', 'строка закрыта неявкой — услуги не было');
  db.close();
});

test('не пришёл: уже дошедшую заявку неявка не переписывает', () => {
  const db = freshDb();
  const vid = addVisit(db);
  const rid = addReq(db, { status: 'came', date: '2026-08-09' });
  addLine(db, rid, { date: '2026-08-09', visit: vid, status: 'done' });

  crmVisitStatus(db, { visitId: vid, from: 'arrived', to: 'no_show' });

  assert.equal(reqRow(db, rid).status, 'came', 'конверсия, которая уже случилась, отменена задним числом');
  db.close();
});

// CRM_UNIFY_V1 (Р9, задача 5) — неявка видит и карточку, привязанную к визиту
// только записью (crm_booking_links, без строк), как и приход. Закрытые — нет.
test('CRM_UNIFY_V1: не пришёл — и карточка, привязанная только записью; закрытые не трогаются', () => {
  const db = freshDb();
  const vid = addVisit(db);
  const rid = addReq(db, { status: 'scheduled', date: '2026-07-01' });   // дата карточки — другая
  const won = addReq(db, { status: 'came' });
  const link = db.prepare("INSERT INTO crm_booking_links (visit_id, request_id, source) VALUES (?, ?, 'match')");
  link.run(vid, rid);
  const vid2 = addVisit(db, '2026-08-10T09:00:00Z');
  link.run(vid2, won);
  crmVisitStatus(db, { visitId: vid, from: 'scheduled', to: 'no_show' });
  crmVisitStatus(db, { visitId: vid2, from: 'scheduled', to: 'no_show' });
  assert.equal(reqRow(db, rid).status, 'no_show', 'неявка по записи календаря без строк до карточки не дошла');
  assert.equal(reqRow(db, won).status, 'came', 'неявка переписала закрытую карточку');
  db.close();
});

// «Не пришёл» берётся ТОЛЬКО сидовым именем: запасной вариант noShowStageKey()
// отдаёт первую проигрышную колонку, и у клиники без сидовой неявка уносила бы
// заявку в «Обработка остановлена» — совсем другой факт о ней.
test('не пришёл: без сидовой колонки заявка не уезжает в первую попавшуюся проигрышную', () => {
  const db = freshDb();
  const vid = addVisit(db);
  const rid = addReq(db, { date: '2026-08-09' });
  addLine(db, rid, { date: '2026-08-09', visit: vid });
  db.prepare("DELETE FROM crm_stages WHERE key = 'no_show'").run();

  crmVisitStatus(db, { visitId: vid, from: 'scheduled', to: 'no_show' });

  assert.equal(reqRow(db, rid).status, 'scheduled',
    'неявка объявила заявку остановленной: запасная проигрышная колонка попала в переход');
  db.close();
});

// ─── ОТМЕНА ────────────────────────────────────────────────────────────────

test('отмена: строки возвращаются к ожиданию, заявка откатывается из «Записан»', () => {
  const db = freshDb();
  const vid = addVisit(db);
  const rid = addReq(db, { date: '2026-08-09' });
  const lid = addLine(db, rid, { date: '2026-08-09', visit: vid });

  crmVisitStatus(db, { visitId: vid, from: 'scheduled', to: 'cancelled' });

  assert.equal(line(db, lid).visit_id, null, 'строка держит слот отменённого визита — записать её заново нечем');
  assert.equal(line(db, lid).status, 'pending');
  const row = reqRow(db, rid);
  assert.equal(row.status, 'in_process', 'отменённая запись осталась «записанной» — оператор её не увидит в работе');
  // CRM_UNIFY_V1 (финальное ревью, A-I4) — ОБНОВЛЕНО НАМЕРЕННО: живой записи не осталось —
  // дата карточки стирается (строка свою дату хранит): иначе отменённый приём
  // становился «Не пришёл».
  assert.equal(row.scheduled_date, null, 'у карточки осталась дата отменённой записи');
  assert.equal(line(db, lid).visit_id, null);
  db.close();
});

test('отмена одного дня из трёх: заявка остаётся записанной', () => {
  const db = freshDb();
  const v1 = addVisit(db, '2026-08-09T09:00:00Z');
  const v2 = addVisit(db, '2026-08-10T09:00:00Z');
  const rid = addReq(db, { date: '2026-08-09' });
  const d1 = addLine(db, rid, { date: '2026-08-09', visit: v1 });
  addLine(db, rid, { date: '2026-08-10', visit: v2 });

  crmVisitStatus(db, { visitId: v1, from: 'scheduled', to: 'cancelled' });

  assert.equal(line(db, d1).visit_id, null);
  const row = reqRow(db, rid);
  assert.equal(row.status, 'scheduled', 'второй день никуда не делся — заявка всё ещё записана');
  assert.equal(row.scheduled_date, '2026-08-09', 'дата обязана остаться ближайшей ждущей строкой');
  db.close();
});

test('отмена: у заявки без дат дата обнуляется, а не остаётся от прошлой записи', () => {
  const db = freshDb();
  const vid = addVisit(db);
  const rid = addReq(db, { date: '2026-08-09' });
  addLine(db, rid, { date: null, visit: vid });

  crmVisitStatus(db, { visitId: vid, from: 'scheduled', to: 'cancelled' });

  assert.equal(reqRow(db, rid).scheduled_date, null,
    'у заявки осталась дата отменённой записи: карточка и отчёт покажут приём, которого не будет');
  db.close();
});

test('отмена: закрытую строку и дошедшую заявку отмена визита не трогает', () => {
  const db = freshDb();
  const vid = addVisit(db);
  const rid = addReq(db, { status: 'came', date: '2026-08-09' });
  const lid = addLine(db, rid, { date: '2026-08-09', visit: vid, status: 'done' });

  crmVisitStatus(db, { visitId: vid, from: 'arrived', to: 'cancelled' });

  assert.equal(line(db, lid).visit_id, vid, 'у закрытой строки отобрали её визит — приём был, и он был на этом слоте');
  assert.equal(reqRow(db, rid).status, 'came', 'отмена визита отменила конверсию, которая уже случилась');
  db.close();
});

// ─── ГРАНИЦЫ ───────────────────────────────────────────────────────────────

test('подтверждение и перенос заявку не трогают: конверсия — это приход', () => {
  const db = freshDb();
  const vid = addVisit(db);
  const rid = addReq(db, { date: '2026-08-09' });
  const lid = addLine(db, rid, { date: '2026-08-09', visit: vid });

  crmVisitStatus(db, { visitId: vid, from: 'scheduled', to: 'confirmed' });

  assert.equal(reqRow(db, rid).status, 'scheduled',
    '«подтверждён по телефону» объявлено приходом: человек всё ещё дома');
  assert.equal(line(db, lid).status, 'pending');
  db.close();
});

test('визит не из заявки: хук молчит и ничего не ищет', () => {
  const db = freshDb();
  const vid = addVisit(db);
  const rid = addReq(db, { date: '2026-08-09' });
  addLine(db, rid, { date: '2026-08-09' });   // строка без визита — чужая

  crmVisitStatus(db, { visitId: vid, from: 'scheduled', to: 'arrived' });

  assert.equal(reqRow(db, rid).status, 'scheduled', 'приход по чужому визиту закрыл заявку');
  db.close();
});

// НЕ БРОСАЕТСЯ НИКОГДА. Заявка — это учёт работы колл-центра, а не условие
// приёма пациента: отказ воронки не вправе отменить отметку прихода.
test('хук не бросается ни на пустой воронке, ни на сломанной базе, ни на мусоре', () => {
  const db = freshDb();
  const vid = addVisit(db);
  const rid = addReq(db, { date: '2026-08-09' });
  const lid = addLine(db, rid, { date: '2026-08-09', visit: vid });

  // Справочника колонок нет вовсе — остаётся сидовая воронка.
  db.pragma('foreign_keys = OFF');
  db.prepare('DELETE FROM crm_stages').run();
  crmVisitStatus(db, { visitId: vid, from: 'scheduled', to: 'arrived' });
  assert.equal(line(db, lid).status, 'done', 'без справочника приход перестал закрывать строки');
  assert.equal(reqRow(db, rid).status, 'came', 'без справочника конверсия пропала совсем');

  // Мусор на входе и таблица заявок, которой нет, — тоже молча.
  assert.doesNotThrow(() => crmVisitStatus(db, {}));
  assert.doesNotThrow(() => crmVisitStatus(db, { visitId: 0, to: 'arrived' }));
  assert.doesNotThrow(() => crmVisitStatus(db, { visitId: 'нет', to: 'arrived' }));
  assert.doesNotThrow(() => crmVisitStatus(db, { visitId: vid, from: null, to: null }));
  db.prepare('DROP TABLE crm_request_services').run();
  assert.doesNotThrow(() => crmVisitStatus(db, { visitId: vid, from: 'scheduled', to: 'arrived' }),
    'отказ базы по заявкам обязан оставаться в логе, а не отменять отметку прихода');
  db.pragma('foreign_keys = ON');
  db.close();
});

// ─── ВТОРАЯ ДВЕРЬ: ПРИХОД, ОТМЕЧЕННЫЙ В СОСЕДНЕМ ЗДАНИИ ─────────────────────
//
// План называл calendar_book «единственным местом, где меняется visits.status».
// Для человека за экраном это правда: реестр таблиц статус визита браузеру не
// отдаёт вовсе (schema-registry, visits.update). Но есть вторая дорога, у
// которой человека нет, — обмен между зданиями: status перечислен в SHIPPED, и
// приехавшая правка кладётся общим применителем (branch-sync/records.js).
// Оператор колл-центра записывает пациента в ЛЮБОЕ здание, а строка заявки с её
// visit_id остаётся у нас: доска заявок своя у каждого здания. Значит «пришёл»,
// нажатый там, обязан закрыть заявку здесь — иначе она вечно стоит в «Записан».
test('приход, приехавший из соседнего здания, закрывает заявку здесь', () => {
  const db = freshDb();
  const stamp = (ms) => Math.floor(ms).toString(16).padStart(12, '0') + '-0000-C';
  const T0 = Date.now() - 24 * 3600000;
  const put = (tbl, uid, st, data, refs = {}) => ({ tbl, uid, op: 'put', stamp: st, data, refs, origin: 'C' });

  // Пациент и запись приезжают обменом — так выглядит наша же запись,
  // вернувшаяся из здания, куда её сделали.
  applyBatch(db, [put('patients', 'p1', stamp(T0), { full_name: 'Пациент' })], { self: 'B' });
  applyBatch(db, [put('visits', 'v1', stamp(T0 + 1000), { visit_date: '2026-08-09T09:00:00Z', status: 'scheduled' }, { patient_id: 'p1' })], { self: 'B' });
  const vid = db.prepare("SELECT id FROM visits WHERE uid = 'v1'").get().id;
  const pid = db.prepare("SELECT id FROM patients WHERE uid = 'p1'").get().id;
  const rid = db.prepare(
    "INSERT INTO crm_requests (full_name, phone, status, patient_id, scheduled_date) VALUES (?,?,?,?,?)",
  ).run('Лид', '998900000000', 'scheduled', pid, '2026-08-09').lastInsertRowid;
  const lid = addLine(db, rid, { date: '2026-08-09', visit: vid });

  applyBatch(db, [put('visits', 'v1', stamp(T0 + 2000), { status: 'arrived' })], { self: 'B' });

  assert.equal(db.prepare('SELECT status FROM visits WHERE id=?').get(vid).status, 'arrived');
  // CRM_UNIFY_V1 (инвариант) — услуги этой строки в визите соседнего здания нет,
  // а ставить её туда отсюда нельзя (BRANCH_MONEY_GUARD_V1): строка ждёт, а не
  // закрывается без услуги. Карточка закрывается — ступень от строк не зависит.
  assert.equal(line(db, lid).status, 'pending', 'строка закрыта без услуги в визите');
  assert.equal(reqRow(db, rid).status, 'came',
    'заявка осталась в «Записан»: ночная автоматика унесёт дошедшего пациента в «Не пришёл»');
  db.close();
});

// ─── ЗАЯВКА БЕЗ СТРОК: ЛИД ИЗ ЗВОНКА ───────────────────────────────────────
//
// У лида, заведённого из звонка (crm/lead-from-call.js), нет ни одной строки
// услуг: оператор поговорил с человеком, и всё. Взять visit_id такой заявке
// нечем, то есть ссылочное правило до неё не дотягивается НИКОГДА — а до сих
// пор её закрывал приход. Без этого прохода она висела бы вечно и уезжала бы
// в отчёт недошедшей.
test('пришёл: заявка без строк закрывается приходом того же пациента', () => {
  const db = freshDb();
  const vid = addVisit(db);
  const bare = addReq(db, { status: 'in_process', name: 'лид из звонка' });
  const dated = addReq(db, { status: 'scheduled', date: '2026-08-09', name: 'на сегодня' });
  // CRM_UNIFY_V1 (финальное ревью, A-I3) — ОБНОВЛЕНО НАМЕРЕННО: приход закрывает только
  // карточку, заведённую в день визита (2026-08-09) или раньше.
  db.prepare("UPDATE crm_requests SET created_at = '2026-08-09T03:00:00Z' WHERE id IN (?, ?)").run(bare, dated);

  crmVisitStatus(db, { visitId: vid, from: 'scheduled', to: 'arrived' });

  assert.equal(reqRow(db, bare).status, 'came', 'лид из звонка не закрылся приходом — он не закроется уже ничем');
  assert.equal(reqRow(db, dated).status, 'came', 'заявка на сегодня без строк тоже обязана закрыться');
  db.close();
});

test('пришёл: заявка без строк на ДРУГОЙ день сегодняшним приходом не закрывается', () => {
  const db = freshDb();
  const vid = addVisit(db);   // визит 2026-08-09
  const future = addReq(db, { status: 'scheduled', date: '2026-09-15', name: 'на сентябрь' });
  const overdue = addReq(db, { status: 'scheduled', date: '2026-08-01', name: 'просрочена' });

  crmVisitStatus(db, { visitId: vid, from: 'scheduled', to: 'arrived' });

  assert.equal(reqRow(db, future).status, 'scheduled',
    'консультация, записанная на месяц вперёд, объявлена состоявшейся сегодняшним приходом');
  assert.equal(reqRow(db, overdue).status, 'scheduled',
    'вчерашняя несостоявшаяся заявка закрыта сегодняшним визитом: у неё был свой день');
  db.close();
});

test('пришёл: заявка без строк у ДРУГОГО пациента не трогается', () => {
  const db = freshDb();
  db.prepare("INSERT INTO patients (id, full_name) VALUES (2,'Другой')").run();
  const vid = addVisit(db);
  const other = db.prepare(
    "INSERT INTO crm_requests (full_name, phone, status, patient_id) VALUES ('Чужой','998900000002','in_process',2)",
  ).run().lastInsertRowid;

  crmVisitStatus(db, { visitId: vid, from: 'scheduled', to: 'arrived' });

  assert.equal(reqRow(db, other).status, 'in_process', 'закрылась заявка чужого пациента');
  db.close();
});

// CRM_UNIFY_V1 (ревью задачи 3, R5) — заявка без строк и без даты закрывается
// приходом, только если двигалась в окне повторного обращения (72 ч). Заявка на
// день визита — любой давности, как прежде.
test('CRM_UNIFY_V1: старая заявка без строк и без даты приходом не закрывается; на день визита — закрывается', () => {
  const db = freshDb();
  const vid = addVisit(db);   // визит 2026-08-09
  const stale = addReq(db, { status: 'in_process', name: 'лид трёхмесячной давности' });
  const fresh = addReq(db, { status: 'in_process', name: 'лид вчерашний' });
  const dated = addReq(db, { status: 'recall', date: '2026-08-09', name: 'на день визита, старая' });
  const set = db.prepare(`UPDATE crm_requests SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now', ?),
                                                  created_at = strftime('%Y-%m-%dT%H:%M:%SZ','now', ?) WHERE id = ?`);
  set.run('-90 days', '-90 days', stale);
  // CRM_UNIFY_V1 (финальное ревью, A-I3) — ОБНОВЛЕНО НАМЕРЕННО: «вчерашний» лид двигался
  // вчера, но заведён до визита (иначе приход 2026-08-09 его бы не закрыл).
  set.run('-1 days', '-90 days', fresh);
  set.run('-90 days', '-90 days', dated);

  crmVisitStatus(db, { visitId: vid, from: 'scheduled', to: 'arrived' });

  assert.equal(reqRow(db, stale).status, 'in_process', 'приход закрыл лид о другом обращении трёхмесячной давности');
  assert.equal(reqRow(db, fresh).status, 'came');
  assert.equal(reqRow(db, dated).status, 'came');
  db.close();
});

// ─── ДОКАЗАТЕЛЬСТВА ПРИХОДА, КОТОРЫЕ НЕ ЯВЛЯЮТСЯ СТАТУСОМ ВИЗИТА ───────────
//
// Кнопку «Пришёл» в клинике не нажимает никто: на боевой базе ВСЕ 390 визитов
// стоят в 'scheduled' и ни один в 'arrived', при этом 389 счетов оплачены
// (разбор — в шапке custdev/sync.js). Вешать правило «Пришёл = пришёл» на одну
// эту кнопку значило бы оставить воронку колл-центра пустой навсегда.

test('словарь доказательной работы — четыре статуса услуги из миграции 041', () => {
  assert.deepEqual([...EVIDENCE_SERVICE_STATUSES], ['collected', 'in_progress', 'resulted', 'completed']);
});

test('деньги: оплата счёта визита закрывает заявку', () => {
  const db = freshDb();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (9,'kassa','x','Кассир','cashier')").run();
  const vid = addVisit(db);
  const rid = addReq(db, { date: '2026-08-09' });
  const lid = addLine(db, rid, { date: '2026-08-09', visit: vid });
  const inv = db.prepare(`INSERT INTO invoices
      (invoice_number, visit_id, patient_id, subtotal, discount_amount, total_amount, paid_amount, status, created_by)
    VALUES ('INV-1', ?, 1, 100000, 0, 100000, 0, 'unpaid', 9)`).run(vid).lastInsertRowid;

  recordPayment(db, { invoice_id: inv, amount: 100000, method: 'cash' }, { id: 9, role: 'cashier' });

  assert.equal(line(db, lid).status, 'done',
    'пациент заплатил на кассе — заочно это не происходит, — а строка заявки так и ждёт');
  assert.equal(reqRow(db, rid).status, 'came', 'оплата не закрыла заявку: воронка колл-центра останется пустой');
  db.close();
});

// CRM_UNIFY_V1 — первый приход закрывает карточку (решение владельца 1); строки
// других дней остаются в карточке и в календаре как записи. Прежде оплата
// одного дня оставляла заявку на три дня в «Записан».
test('деньги: у заявки на три дня оплата первого дня закрывает её — второй день остаётся записью', () => {
  const db = freshDb();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (9,'kassa','x','Кассир','cashier')").run();
  const vid = addVisit(db);
  const rid = addReq(db, { date: '2026-08-09' });
  const d1 = addLine(db, rid, { date: '2026-08-09', visit: vid });
  const d2 = addLine(db, rid, { date: '2026-08-12' });
  const inv = db.prepare(`INSERT INTO invoices
      (invoice_number, visit_id, patient_id, subtotal, discount_amount, total_amount, paid_amount, status, created_by)
    VALUES ('INV-2', ?, 1, 50000, 0, 50000, 0, 'unpaid', 9)`).run(vid).lastInsertRowid;

  // Частичная оплата — те же деньги у того же окна.
  recordPayment(db, { invoice_id: inv, amount: 20000, method: 'cash' }, { id: 9, role: 'cashier' });

  assert.equal(line(db, d1).status, 'done');
  assert.equal(line(db, d2).status, 'pending', 'второй день закрылся вместе с оплатой первого');
  assert.equal(reqRow(db, rid).status, 'came', 'пациент заплатил у окна, а карточка ждёт второго дня');
  db.close();
});

test('деньги: оплата по ОТМЕНЁННОМУ визиту доказательством не является', () => {
  const db = freshDb();
  const vid = addVisit(db, '2026-08-09T09:00:00Z', 'cancelled');
  const rid = addReq(db, { date: '2026-08-09' });
  const lid = addLine(db, rid, { date: '2026-08-09', visit: vid });
  const inv = db.prepare(`INSERT INTO invoices
      (invoice_number, visit_id, patient_id, subtotal, discount_amount, total_amount, paid_amount, status)
    VALUES ('INV-3', ?, 1, 100000, 0, 100000, 100000, 'paid')`).run(vid).lastInsertRowid;

  crmInvoiceEvidence(db, inv);

  assert.equal(line(db, lid).status, 'pending',
    'предоплата по отменённой записи выдана за приход: деньги вносят заранее, а возвращают потом');
  assert.equal(reqRow(db, rid).status, 'scheduled');
  db.close();
});

test('деньги: выставленный, но НЕ оплаченный счёт ничего не доказывает', () => {
  const db = freshDb();
  const vid = addVisit(db);
  const rid = addReq(db, { date: '2026-08-09' });
  const lid = addLine(db, rid, { date: '2026-08-09', visit: vid });
  const inv = db.prepare(`INSERT INTO invoices
      (invoice_number, visit_id, patient_id, subtotal, discount_amount, total_amount, paid_amount, status)
    VALUES ('INV-4', ?, 1, 100000, 0, 100000, 0, 'unpaid')`).run(vid).lastInsertRowid;

  crmInvoiceEvidence(db, inv);

  assert.equal(line(db, lid).status, 'pending', 'счёт заводят заочно — доказательством являются деньги, а не документ');
  db.close();
});

test('работа: начатая услуга визита закрывает заявку, а внесённая в смету — нет', () => {
  const db = freshDb();
  db.prepare("INSERT INTO services (id, name, price) VALUES (30,'Приём',100000)").run();
  const vid = addVisit(db);
  const rid = addReq(db, { date: '2026-08-09' });
  const lid = addLine(db, rid, { date: '2026-08-09', visit: vid });
  const vs = db.prepare(
    "INSERT INTO visit_services (visit_id, service_id, status) VALUES (?, 30, 'added')",
  ).run(vid).lastInsertRowid;

  // «Внесли в смету» — это ещё не работа: строку заводят заочно.
  crmServiceEvidence(db, [vs]);
  assert.equal(line(db, lid).status, 'pending');

  // «Приём начат» человеком не бывает заочным.
  db.prepare("UPDATE visit_services SET status = 'in_progress' WHERE id = ?").run(vs);
  crmServiceEvidence(db, [vs]);

  assert.equal(line(db, lid).status, 'done', 'врач начал приём, а строка заявки так и ждёт');
  assert.equal(reqRow(db, rid).status, 'came');
  db.close();
});

test('доказательство после отметки прихода ничего не делает второй раз', () => {
  const db = freshDb();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (9,'kassa','x','Кассир','cashier')").run();
  const vid = addVisit(db);
  const rid = addReq(db, { date: '2026-08-09' });
  addLine(db, rid, { date: '2026-08-09', visit: vid });
  crmVisitStatus(db, { visitId: vid, from: 'scheduled', to: 'arrived' });
  const after = reqRow(db, rid);
  const stamp = db.prepare('SELECT updated_at FROM crm_requests WHERE id=?').get(rid).updated_at;

  const inv = db.prepare(`INSERT INTO invoices
      (invoice_number, visit_id, patient_id, subtotal, discount_amount, total_amount, paid_amount, status, created_by)
    VALUES ('INV-5', ?, 1, 100000, 0, 100000, 0, 'unpaid', 9)`).run(vid).lastInsertRowid;
  recordPayment(db, { invoice_id: inv, amount: 100000, method: 'cash' }, { id: 9, role: 'cashier' });
  crmVisitEvidence(db, vid);

  assert.deepEqual(reqRow(db, rid), after, 'второе доказательство переписало уже закрытую заявку');
  assert.equal(db.prepare('SELECT updated_at FROM crm_requests WHERE id=?').get(rid).updated_at, stamp);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM crm_request_services WHERE status='done'").get().n, 1);
  db.close();
});

test('доказательства не бросаются на мусоре и на несуществующих строках', () => {
  const db = freshDb();
  assert.doesNotThrow(() => crmVisitEvidence(db, null));
  assert.doesNotThrow(() => crmVisitEvidence(db, 'нет'));
  assert.doesNotThrow(() => crmVisitEvidence(db, 999999));
  assert.doesNotThrow(() => crmInvoiceEvidence(db, 999999));
  assert.doesNotThrow(() => crmServiceEvidence(db, []));
  assert.doesNotThrow(() => crmServiceEvidence(db, [999999]));
  assert.doesNotThrow(() => crmServiceEvidence(db, null));
  db.close();
});

// ДЕНЬГИ ТОЖЕ ПРИЕЗЖАЮТ ИЗ СОСЕДНЕГО ЗДАНИЯ. invoices и payments перечислены
// в SHIPPED (branch-sync/journal.js), то есть оплата, принятая там, ложится
// сюда общим применителем — без человека и мимо record_payment. Для заявки
// колл-центра это то же доказательство прихода, и оно обязано дойти.
test('оплата, приехавшая из соседнего здания, закрывает заявку здесь', () => {
  const db = freshDb();
  const stamp = (ms) => Math.floor(ms).toString(16).padStart(12, '0') + '-0000-C';
  const T0 = Date.now() - 24 * 3600000;
  const put = (tbl, uid, st, data, refs = {}) => ({ tbl, uid, op: 'put', stamp: st, data, refs, origin: 'C' });

  applyBatch(db, [put('patients', 'p9', stamp(T0), { full_name: 'Пациент' })], { self: 'B' });
  applyBatch(db, [put('visits', 'v9', stamp(T0 + 1000), { visit_date: '2026-08-09T09:00:00Z', status: 'scheduled' }, { patient_id: 'p9' })], { self: 'B' });
  const vid = db.prepare("SELECT id FROM visits WHERE uid = 'v9'").get().id;
  const pid = db.prepare("SELECT id FROM patients WHERE uid = 'p9'").get().id;
  const rid = db.prepare(
    "INSERT INTO crm_requests (full_name, phone, status, patient_id, scheduled_date) VALUES (?,?,?,?,?)",
  ).run('Лид', '998900000009', 'scheduled', pid, '2026-08-09').lastInsertRowid;
  const lid = addLine(db, rid, { date: '2026-08-09', visit: vid });

  // Счёт и платёж по нему — одной порцией, как их и везёт обмен.
  applyBatch(db, [
    put('invoices', 'i9', stamp(T0 + 2000), { invoice_number: 'B-1', subtotal: 100000, total_amount: 100000, status: 'paid' }, { patient_id: 'p9', visit_id: 'v9' }),
    put('payments', 'pay9', stamp(T0 + 3000), { amount: 100000, method: 'cash' }, { invoice_id: 'i9' }),
  ], { self: 'B' });

  assert.equal(db.prepare("SELECT paid_amount FROM invoices WHERE uid = 'i9'").get().paid_amount, 100000,
    'платёж не доехал — проверять нечего');
  // CRM_UNIFY_V1 (инвариант) — в визите соседнего здания этой услуги нет:
  // строка ждёт, карточка закрыта.
  assert.equal(line(db, lid).status, 'pending', 'строка закрыта без услуги в визите');
  assert.equal(reqRow(db, rid).status, 'came',
    'заявка осталась открытой: деньги приехали, а воронка их не заметила');
  db.close();
});

test('работа над услугой, приехавшая из соседнего здания, тоже закрывает заявку', () => {
  const db = freshDb();
  const stamp = (ms) => Math.floor(ms).toString(16).padStart(12, '0') + '-0000-C';
  const T0 = Date.now() - 24 * 3600000;
  const put = (tbl, uid, st, data, refs = {}) => ({ tbl, uid, op: 'put', stamp: st, data, refs, origin: 'C' });
  db.prepare("INSERT INTO services (id, code, name, price) VALUES (31,'A1','Анализ',50000)").run();

  applyBatch(db, [put('patients', 'p8', stamp(T0), { full_name: 'Пациент' })], { self: 'B' });
  applyBatch(db, [put('visits', 'v8', stamp(T0 + 1000), { visit_date: '2026-08-09T09:00:00Z', status: 'scheduled' }, { patient_id: 'p8' })], { self: 'B' });
  const vid = db.prepare("SELECT id FROM visits WHERE uid = 'v8'").get().id;
  const pid = db.prepare("SELECT id FROM patients WHERE uid = 'p8'").get().id;
  const rid = db.prepare(
    "INSERT INTO crm_requests (full_name, phone, status, patient_id, scheduled_date) VALUES (?,?,?,?,?)",
  ).run('Лид', '998900000008', 'scheduled', pid, '2026-08-09').lastInsertRowid;
  // CRM_UNIFY_V1 (инвариант) — строка заявки на ту же услугу (31), что приехала в
  // визите соседа: приход берёт её строку визита и только тогда закрывает строку.
  const lid = addLine(db, rid, { date: '2026-08-09', visit: vid, svc: 31 });

  applyBatch(db, [put('visit_services', 'vs8', stamp(T0 + 2000), { quantity: 1, status: 'added' }, { visit_id: 'v8', service_code: 'A1' })], { self: 'B' });
  assert.equal(line(db, lid).status, 'pending', 'строка в смете — это ещё не работа над пациентом');

  applyBatch(db, [put('visit_services', 'vs8', stamp(T0 + 3000), { status: 'completed' }, { visit_id: 'v8' })], { self: 'B' });

  assert.equal(line(db, lid).status, 'done', 'услугу выдали в соседнем здании, а строка заявки так и ждёт');
  assert.deepEqual(lineVs(db, lid), { visit_id: vid, service_id: 31, status: 'completed' }, 'строка закрыта без услуги в визите');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM visit_services WHERE visit_id = ?').get(vid).n, 1,
    'в визит соседнего здания поставлена строка отсюда');
  assert.equal(reqRow(db, rid).status, 'came');
  db.close();
});

// ─── ДЕНЬГИ, КОТОРЫХ КАССА НЕ ВИДИТ ────────────────────────────────────────
//
// Разбор ревью: у консультации по акту (счёт выставлен контрагенту,
// COVERAGE_SPLIT_V1) денег на кассе не будет НИКОГДА — такие счета из списка
// кассы исключены, — а строки её услуг остаются в 'added', потому что в
// очередь их переводит только оплата. Врачебное «Начать приём» при этом
// заперто счётом. Итог: ни одного из трёх доказательств не наступает, и
// заявка по такому пациенту висит вечно.
//
// Но в тот миг, когда счёт по акту ВЫСТАВЛЯЕТСЯ по визиту, пациент стоит у
// стойки: акт подписывают с человеком, а не заочно. Это и есть событие.
test('счёт по акту (контрагенту) — сам по себе доказательство прихода', () => {
  const db = freshDb();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (9,'reg','x','Регистратор','registrar')").run();
  db.prepare("INSERT INTO services (id, name, price) VALUES (40,'Консультация',100000)").run();
  db.prepare("INSERT INTO payers (id, name, kind, active) VALUES (3,'Завод','contract',1)").run();
  const vid = addVisit(db);
  const rid = addReq(db, { date: '2026-08-09' });
  const lid = addLine(db, rid, { date: '2026-08-09', visit: vid });
  const vs = db.prepare(
    "INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status) VALUES (?,40,1,100000,100000,'added')",
  ).run(vid).lastInsertRowid;

  createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs], payer_id: 3 }, { id: 9, role: 'registrar' });

  assert.equal(line(db, lid).status, 'done',
    'акт по визиту выставлен, а строка заявки ждёт: денег на кассе по нему не будет никогда');
  assert.equal(reqRow(db, rid).status, 'came');
  db.close();
});

test('обычный счёт пациенту доказательством НЕ является — он ждёт денег', () => {
  const db = freshDb();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (9,'reg','x','Регистратор','registrar')").run();
  db.prepare("INSERT INTO services (id, name, price) VALUES (40,'Консультация',100000)").run();
  const vid = addVisit(db);
  const rid = addReq(db, { date: '2026-08-09' });
  const lid = addLine(db, rid, { date: '2026-08-09', visit: vid });
  const vs = db.prepare(
    "INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status) VALUES (?,40,1,100000,100000,'added')",
  ).run(vid).lastInsertRowid;

  createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs] }, { id: 9, role: 'registrar' });

  assert.equal(line(db, lid).status, 'pending',
    'счёт пациенту заводят заранее — приходом является оплата, а не документ');
  assert.equal(reqRow(db, rid).status, 'scheduled');
  db.close();
});

test('долг у кассы — тоже доказательство: человек стоял у окна', () => {
  const db = freshDb();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (9,'kassa','x','Кассир','cashier')").run();
  const vid = addVisit(db);
  const rid = addReq(db, { date: '2026-08-09' });
  const lid = addLine(db, rid, { date: '2026-08-09', visit: vid });
  const inv = db.prepare(`INSERT INTO invoices
      (invoice_number, visit_id, patient_id, subtotal, discount_amount, total_amount, paid_amount, status, created_by)
    VALUES ('INV-D', ?, 1, 100000, 0, 100000, 0, 'unpaid', 9)`).run(vid).lastInsertRowid;

  markInvoiceDebt(db, { invoice_id: inv }, { id: 9, role: 'cashier' });

  assert.equal(line(db, lid).status, 'done',
    'кассир оформил долг — пациент стоял перед ним, — а строка заявки так и ждёт');
  assert.equal(reqRow(db, rid).status, 'came');
  db.close();
});

test('долг по ОТМЕНЁННОМУ визиту доказательством не является', () => {
  const db = freshDb();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (9,'kassa','x','Кассир','cashier')").run();
  const vid = addVisit(db, '2026-08-09T09:00:00Z', 'cancelled');
  const rid = addReq(db, { date: '2026-08-09' });
  const lid = addLine(db, rid, { date: '2026-08-09', visit: vid });
  const inv = db.prepare(`INSERT INTO invoices
      (invoice_number, visit_id, patient_id, subtotal, discount_amount, total_amount, paid_amount, status, created_by)
    VALUES ('INV-D2', ?, 1, 100000, 0, 100000, 0, 'unpaid', 9)`).run(vid).lastInsertRowid;

  markInvoiceDebt(db, { invoice_id: inv }, { id: 9, role: 'cashier' });

  assert.equal(line(db, lid).status, 'pending');
  assert.equal(reqRow(db, rid).status, 'scheduled');
  db.close();
});

// CRM_UNIFY_V1 — первый приход закрывает карточку (решение владельца 1); строки
// других дней остаются в карточке и в календаре как записи. Прежде счёт по
// акту одного дня оставлял заявку в «Записан» с ближайшей датой.
test('счёт по акту у заявки на три дня закрывает её — второй день остаётся записью', () => {
  const db = freshDb();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (9,'reg','x','Регистратор','registrar')").run();
  db.prepare("INSERT INTO services (id, name, price) VALUES (40,'Консультация',100000)").run();
  db.prepare("INSERT INTO payers (id, name, kind, active) VALUES (3,'Завод','contract',1)").run();
  const vid = addVisit(db);
  const rid = addReq(db, { date: '2026-08-09' });
  const d1 = addLine(db, rid, { date: '2026-08-09', visit: vid });
  const d2 = addLine(db, rid, { date: '2026-08-14' });
  const vs = db.prepare(
    "INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status) VALUES (?,40,1,100000,100000,'added')",
  ).run(vid).lastInsertRowid;

  createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs], payer_id: 3 }, { id: 9, role: 'registrar' });

  assert.equal(line(db, d1).status, 'done');
  assert.equal(line(db, d2).status, 'pending');
  assert.equal(reqRow(db, rid).status, 'came');
  db.close();
});

// ─── ДОКАЗАТЕЛЬСТВО НЕ МОЖЕТ ОПЕРЕЖАТЬ ДЕНЬ ВИЗИТА ─────────────────────────
//
// Разбор ревью (критическое). Мастер визита выставляет счёт по акту В ТОТ ЖЕ
// КЛИК, что и записывает, — на каждый день корзины, включая будущие
// (visit-wizard.js, raiseInvoice включён по умолчанию). Счёт с payer_id →
// доказательство → заявка на следующий вторник становилась «Пришёл» сегодня,
// её строки — done, а лиды без строк на тот день — выигранными.
//
// Сторож стоит ВНУТРИ crmVisitEvidence и crmVisitStatus, а не у одной из
// дверей: дверей шесть, и любая новая обязана получить его даром. День —
// местный день клиники (domain/day.js), как у кассы, дневника и документов.
const dayShift = (db, days) => db.prepare("SELECT date('now','localtime', ? || ' days') d").get(String(days)).d;
const noonOf = (day) => day + 'T12:00:00Z';   // в любом поясе ±12 ч это тот же местный день

function payerInvoiceFor(db, vid) {
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (9,'reg','x','Регистратор','registrar')").run();
  db.prepare("INSERT INTO services (id, name, price) VALUES (40,'Консультация',100000)").run();
  db.prepare("INSERT INTO payers (id, name, kind, active) VALUES (3,'Завод','contract',1)").run();
  const vs = db.prepare(
    "INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status) VALUES (?,40,1,100000,100000,'added')",
  ).run(vid).lastInsertRowid;
  createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [vs], payer_id: 3 }, { id: 9, role: 'registrar' });
}

test('будущий визит: счёт по акту сегодня НЕ делает заявку дошедшей', () => {
  const db = freshDb();
  const day = dayShift(db, 22);
  const vid = addVisit(db, noonOf(day));
  const rid = addReq(db, { date: day });
  const lid = addLine(db, rid, { date: day, visit: vid });
  const bare = addReq(db, { status: 'in_process', date: day, name: 'лид без строк на тот же день' });

  payerInvoiceFor(db, vid);

  assert.equal(line(db, lid).status, 'pending', 'строка на следующий вторник закрыта сегодня');
  assert.equal(reqRow(db, rid).status, 'scheduled', 'заявка на будущий день объявлена дошедшей — воронка считает конверсию, которой не было');
  assert.equal(reqRow(db, bare).status, 'in_process', 'лид без строк на будущий день выигран сегодняшним актом');
  db.close();
});

test('сегодняшний визит: счёт по акту — приход', () => {
  const db = freshDb();
  const day = dayShift(db, 0);
  const vid = addVisit(db, noonOf(day));
  const rid = addReq(db, { date: day });
  const lid = addLine(db, rid, { date: day, visit: vid });

  payerInvoiceFor(db, vid);

  assert.equal(line(db, lid).status, 'done');
  assert.equal(reqRow(db, rid).status, 'came', 'сегодняшний акт не засчитан приходом');
  db.close();
});

test('вчерашний визит, оплаченный сегодня, — приход: деньги за прошлое законны', () => {
  const db = freshDb();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (8,'kassa','x','Кассир','cashier')").run();
  const day = dayShift(db, -1);
  const vid = addVisit(db, noonOf(day));
  const rid = addReq(db, { date: day });
  const lid = addLine(db, rid, { date: day, visit: vid });
  const inv = db.prepare(`INSERT INTO invoices
      (invoice_number, visit_id, patient_id, subtotal, discount_amount, total_amount, paid_amount, status, created_by)
    VALUES ('INV-Y', ?, 1, 100000, 0, 100000, 0, 'unpaid', 8)`).run(vid).lastInsertRowid;

  recordPayment(db, { invoice_id: inv, amount: 100000, method: 'cash' }, { id: 8, role: 'cashier' });

  assert.equal(line(db, lid).status, 'done');
  assert.equal(reqRow(db, rid).status, 'came', 'оплата вчерашнего приёма не засчитана');
  db.close();
});

// CRM_UNIFY_V1 (2026-10-10, замечание владельца) — ОБНОВЛЕНО НАМЕРЕННО. Прежде:
// «будущий визит: отметка «пришёл» тоже не засчитывается». Владелец записал из
// карточки на завтра, а пациент пришёл сегодня: регистратура приняла, врач
// подписал — карточка осталась ждать. Отметка «Пришёл» — прямое слово человека
// у стойки: приход в любой день визита СВОЕГО здания. Визит соседнего здания —
// по-прежнему (правила crmFromSync не меняются).
test('CRM_UNIFY_V1: будущий визит своего здания — отметка «пришёл» засчитывается; соседнего — нет', () => {
  const db = freshDb();
  const day = dayShift(db, 3);
  const vid = addVisit(db, noonOf(day));
  const rid = addReq(db, { date: day });
  const lid = addLine(db, rid, { date: day, visit: vid });

  crmVisitStatus(db, { visitId: vid, from: 'scheduled', to: 'arrived' });

  assert.equal(line(db, lid).status, 'done', 'человек отметил «Пришёл», а строка ждёт дня записи');
  assert.equal(reqRow(db, rid).status, 'came', 'отметка «Пришёл» на визите завтрашнего дня не дошла до карточки');

  // Визит соседнего здания (sync_origin) — прежнее правило: будущий не приход.
  const foreign = Number(db.prepare("INSERT INTO visits (patient_id, visit_date, status, sync_origin) VALUES (1, ?, 'scheduled', 'B')").run(noonOf(day)).lastInsertRowid);
  const rid2 = addReq(db, { date: day, name: 'запись в соседнее здание' });
  const lid2 = addLine(db, rid2, { date: day, visit: foreign });
  crmVisitStatus(db, { visitId: foreign, from: 'scheduled', to: 'arrived' });
  assert.equal(line(db, lid2).status, 'pending', 'будущий визит соседнего здания засчитан приходом');
  assert.equal(reqRow(db, rid2).status, 'scheduled');

  // Неявка и отмена будущего визита — законные события, как и прежде.
  const vid3 = addVisit(db, noonOf(day));
  const rid3 = addReq(db, { date: day, name: 'отменят' });
  const lid3 = addLine(db, rid3, { date: day, visit: vid3 });
  crmVisitStatus(db, { visitId: vid3, from: 'scheduled', to: 'cancelled' });
  assert.equal(line(db, lid3).visit_id, null, 'отмена будущей записи обязана освободить строку');
  db.close();
});

// CRM_UNIFY_V1 (2026-10-10, замечание владельца) — РАБОТА НАД УСЛУГОЙ — ПРИХОД В
// ЛЮБОЙ ДЕНЬ ВИЗИТА; ДЕНЬГИ — НЕТ. Пробу взяли, приём начали, результат внесли,
// услугу выдали — пациент физически здесь, на какой бы день ни был записан
// визит. Оплата будущего визита по-прежнему предоплата, а не приход.
test('CRM_UNIFY_V1: будущий визит — оплата сегодня не приход, выполненная услуга — приход сразу', () => {
  const db = freshDb();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (8,'kassa','x','Кассир','cashier')").run();
  db.prepare("INSERT INTO services (id, name, price) VALUES (30,'Диагностика',150000)").run();
  const day = dayShift(db, 1);
  const vid = addVisit(db, noonOf(day));
  const rid = addReq(db, { date: day });
  const lid = addLine(db, rid, { date: day, visit: vid });
  const vs = Number(db.prepare(
    "INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status) VALUES (?,30,1,150000,150000,'added')",
  ).run(vid).lastInsertRowid);
  const inv = db.prepare(`INSERT INTO invoices
      (invoice_number, visit_id, patient_id, subtotal, discount_amount, total_amount, paid_amount, status, created_by)
    VALUES ('INV-F', ?, 1, 150000, 0, 150000, 0, 'unpaid', 8)`).run(vid).lastInsertRowid;

  recordPayment(db, { invoice_id: inv, amount: 150000, method: 'cash' }, { id: 8, role: 'cashier' });
  assert.equal(line(db, lid).status, 'pending', 'оплата завтрашнего визита закрыла строку — предоплата не приход');
  assert.equal(reqRow(db, rid).status, 'scheduled', 'оплата завтрашнего визита объявлена приходом');

  db.prepare("UPDATE visit_services SET status = 'completed' WHERE id = ?").run(vs);
  crmServiceEvidence(db, [vs]);
  assert.equal(line(db, lid).status, 'done', 'услуга выполнена сегодня, а строка ждёт завтрашнего дня');
  assert.equal(reqRow(db, rid).status, 'came', 'врач подписал услугу на визите завтрашнего дня — карточка не в «Пришёл»');
  assert.equal(db.prepare('SELECT status FROM visits WHERE id = ?').get(vid).status, 'scheduled', 'доказательство переписало статус визита');
  db.close();
});

test('CRM_UNIFY_V1: будущий визит соседнего здания — работа над услугой по-прежнему не приход', () => {
  const db = freshDb();
  db.prepare("INSERT INTO services (id, name, price) VALUES (30,'Диагностика',150000)").run();
  const day = dayShift(db, 1);
  const vid = Number(db.prepare("INSERT INTO visits (patient_id, visit_date, status, sync_origin) VALUES (1, ?, 'scheduled', 'B')").run(noonOf(day)).lastInsertRowid);
  const rid = addReq(db, { date: day });
  const lid = addLine(db, rid, { date: day, visit: vid });
  const vs = Number(db.prepare("INSERT INTO visit_services (visit_id, service_id, status) VALUES (?,30,'completed')").run(vid).lastInsertRowid);
  crmServiceEvidence(db, [vs]);
  assert.equal(line(db, lid).status, 'pending');
  assert.equal(reqRow(db, rid).status, 'scheduled', 'будущий визит соседнего здания засчитан приходом');
  // Отменённый визит своего здания — доказательством не бывает никогда.
  const dead = addVisit(db, noonOf(day), 'cancelled');
  const rid2 = addReq(db, { date: day, name: 'отменённая' });
  addLine(db, rid2, { date: day, visit: dead });
  const vs2 = Number(db.prepare("INSERT INTO visit_services (visit_id, service_id, status) VALUES (?,30,'completed')").run(dead).lastInsertRowid);
  crmServiceEvidence(db, [vs2]);
  assert.equal(reqRow(db, rid2).status, 'scheduled', 'работа по отменённому визиту засчитана приходом');
  db.close();
});
