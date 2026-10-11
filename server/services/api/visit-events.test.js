// PUBLIC_API_V1 — сверка заявок из API с их визитами: перенос, отмена, приход
// (отметкой и деньгами), «не пришёл» после дня записи и его исправление
// приходом; заявка «перезвоните», по чьей карточке записали визит, —
// «appointment.created». Второй проход ничего не меняет.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bookingSeed, localAt, apptItem } from '../../test-helpers/api-booking-seed.js';
import { ingestItem, confirmBooking } from './bookings.js';
import { syncVisitOutcomes } from './visit-events.js';
import { calendarBook } from '../rpc/calendar.js';
import { ensureVisit } from '../rpc/visits.js';

const NOW = localAt('2030-03-11', '09:00');
const START = localAt('2030-03-12', '10:00');
const one = (db, sql, ...a) => db.prepare(sql).get(...a);
const last = (s) => { const r = one(s.db, 'SELECT event, body FROM api_outbox ORDER BY id DESC LIMIT 1'); return [r.event, JSON.parse(r.body)]; };
const count = (s) => one(s.db, 'SELECT COUNT(*) AS n FROM api_outbox').n;

async function confirmed(s) {
  const r = await ingestItem(s.db, apptItem({ connId: s.connId, startMs: START, receivedMs: NOW }), { now: NOW, kekPath: s.kekPath });
  s.db.prepare("INSERT INTO patients (id, mrn, full_name, phone) VALUES (1, 'P-1', 'Абдурахмонов Фаррух', '+998901234567')").run();
  const c = await confirmBooking(s.db, { id: r.id, patientId: 1 }, s.reg, { now: NOW, kekPath: s.kekPath });
  return { id: r.id, visit: c.visit };
}

test('перенос календарём: партнёр получает новое время (rescheduled); повторный проход молчит', async () => {
  const s = bookingSeed();
  const { id, visit } = await confirmed(s);
  await calendarBook(s.db, { visit_id: visit.id, start: new Date(localAt('2030-03-12', '15:00')).toISOString() }, s.reg);
  assert.equal(syncVisitOutcomes(s.db, { now: NOW, kekPath: s.kekPath }), 1);
  const [ev, body] = last(s);
  assert.equal(ev, 'appointment.created');
  assert.equal(body.rescheduled, true);
  assert.match(body.start, /^2030-03-12T15:00:00\+/);
  assert.equal(one(s.db, 'SELECT start_at FROM api_requests WHERE id = ?', id).start_at, new Date(localAt('2030-03-12', '15:00')).toISOString().replace('.000', ''));
  const n = count(s);
  assert.equal(syncVisitOutcomes(s.db, { now: NOW, kekPath: s.kekPath }), 0);
  assert.equal(count(s), n);
});

test('отмена визита клиникой — «appointment.cancelled»; приход отметкой — «appointment.arrived»', async () => {
  const s = bookingSeed();
  const { id, visit } = await confirmed(s);
  await calendarBook(s.db, { visit_id: visit.id, start: visit.visit_date, status: 'cancelled' }, s.reg);
  syncVisitOutcomes(s.db, { now: NOW, kekPath: s.kekPath });
  assert.equal(one(s.db, 'SELECT status FROM api_requests WHERE id = ?', id).status, 'cancelled');
  assert.deepEqual([last(s)[0], last(s)[1].status], ['appointment.cancelled', 'cancelled']);

  const s2 = bookingSeed();
  const b = await confirmed(s2);
  await calendarBook(s2.db, { visit_id: b.visit.id, start: b.visit.visit_date, status: 'arrived' }, s2.reg);
  syncVisitOutcomes(s2.db, { now: NOW, kekPath: s2.kekPath });
  assert.equal(one(s2.db, 'SELECT status FROM api_requests WHERE id = ?', b.id).status, 'arrived');
  // Ревью 8a, I1: партнёр «пришёл» не выбирал — статус в клинике есть, наружу не
  // уходит ничего: ни уведомления, ни статуса на публичный сервер (врачебная тайна,
  // дизайн §7 и §12).
  assert.equal(one(s2.db, "SELECT COUNT(*) AS n FROM api_outbox WHERE event = 'appointment.arrived' OR status = 'arrived'").n, 0);
});

test('день прошёл без прихода — «Не пришёл»; оплата, доехавшая позже, — «Пришёл»', async () => {
  const s = bookingSeed();
  const { id, visit } = await confirmed(s);
  syncVisitOutcomes(s.db, { now: localAt('2030-03-13', '09:00'), kekPath: s.kekPath });
  assert.equal(one(s.db, 'SELECT status FROM api_requests WHERE id = ?', id).status, 'no_show');
  s.db.prepare("INSERT INTO invoices (id, invoice_number, visit_id, patient_id, subtotal, total_amount, paid_amount, status) VALUES (1, 'INV-1', ?, 1, 150000, 150000, 150000, 'paid')").run(visit.id);
  // Повторная проверка 8a, п. 6: приход доказывает ПЛАТЁЖ в день визита или позже (cameSurely).
  s.db.prepare('INSERT INTO payments (invoice_id, amount, method, paid_at) VALUES (1, 150000, ?, ?)').run('cash', new Date(localAt('2030-03-13', '09:30')).toISOString());
  syncVisitOutcomes(s.db, { now: localAt('2030-03-13', '10:00'), kekPath: s.kekPath });
  assert.equal(one(s.db, 'SELECT status FROM api_requests WHERE id = ?', id).status, 'arrived');
});

test('заявка «перезвоните»: оператор записал по карточке — партнёру «appointment.created» со временем и врачом', async () => {
  const s = bookingSeed();
  const r = await ingestItem(s.db, { ...apptItem({ connId: s.connId, publicId: 'rq_call0001', startMs: START, receivedMs: NOW }), type: 'request.new',
    data: { external_id: 'cb-1', service_id: 301 } }, { now: NOW });
  const card = one(s.db, 'SELECT crm_request_id AS c FROM api_requests WHERE id = ?', r.id).c;
  s.db.prepare("INSERT INTO patients (id, mrn, full_name, phone) VALUES (1, 'P-1', 'Абдурахмонов Фаррух', '+998901234567')").run();
  s.db.prepare('UPDATE crm_requests SET patient_id = 1 WHERE id = ?').run(card);
  s.db.prepare("UPDATE crm_request_services SET scheduled_date = '2030-03-12', doctor_id = 7 WHERE request_id = ?").run(card);
  const ev = await ensureVisit(s.db, { patient_id: 1, date: '2030-03-12', book: { doctor_id: 7, start: new Date(START).toISOString(), duration_minutes: 15, service_id: 301 } }, s.cc);
  assert.equal(ev.booked, true);
  assert.equal(syncVisitOutcomes(s.db, { now: NOW, kekPath: s.kekPath }), 1);
  const row = one(s.db, 'SELECT * FROM api_requests WHERE id = ?', r.id);
  assert.deepEqual([row.status, row.visit_id, row.doctor_id, row.patient_id], ['confirmed', ev.visit.id, 7, 1]);
  const [name, body] = last(s);
  assert.deepEqual([name, body.status, body.doctor_id], ['appointment.created', 'booked', 7]);
  assert.match(body.start, /^2030-03-12T10:00:00\+/);
});

// ─── РЕВЬЮ 8a, I1: «ПРИШЁЛ» — ТОЛЬКО ПОДПИСАННОМУ ПАРТНЁРУ И НЕ РАНЬШЕ ДНЯ ВИЗИТА ─

test('I1: партнёр, включивший «пришёл», получает appointment.arrived; не включивший — ничего', async () => {
  const s = bookingSeed();
  s.db.prepare('UPDATE api_connections SET webhook_events = ? WHERE id = ?').run(JSON.stringify(['booking.confirmed', 'appointment.arrived']), s.connId);
  const { visit } = await confirmed(s);
  await calendarBook(s.db, { visit_id: visit.id, start: visit.visit_date, status: 'arrived' }, s.reg);
  syncVisitOutcomes(s.db, { now: NOW, kekPath: s.kekPath });
  const ev = one(s.db, "SELECT note, status FROM api_outbox WHERE event = 'appointment.arrived'");
  assert.deepEqual({ ...ev }, { note: '', status: 'arrived' });
});

test('I1 (повторная проверка, п. 6): предоплата накануне — не приход ни накануне, ни в день визита; платёж в день визита — приход', async () => {
  const s = bookingSeed();
  const { id, visit } = await confirmed(s);
  s.db.prepare("INSERT INTO invoices (id, invoice_number, visit_id, patient_id, subtotal, total_amount, paid_amount, status) VALUES (1, 'INV-1', ?, 1, 150000, 150000, 150000, 'paid')").run(visit.id);
  s.db.prepare('INSERT INTO payments (invoice_id, amount, method, paid_at) VALUES (1, 150000, ?, ?)').run('cash', new Date(localAt('2030-03-11', '12:00')).toISOString());
  assert.equal(syncVisitOutcomes(s.db, { now: localAt('2030-03-11', '18:00'), kekPath: s.kekPath }), 0);
  assert.equal(one(s.db, 'SELECT status FROM api_requests WHERE id = ?', id).status, 'confirmed', 'накануне оплата — ещё не приход');
  syncVisitOutcomes(s.db, { now: localAt('2030-03-12', '09:30'), kekPath: s.kekPath });
  assert.equal(one(s.db, 'SELECT status FROM api_requests WHERE id = ?', id).status, 'confirmed', 'и в день визита предоплата — не приход');
  s.db.prepare('INSERT INTO payments (invoice_id, amount, method, paid_at) VALUES (1, 150000, ?, ?)').run('cash', new Date(localAt('2030-03-12', '10:05')).toISOString());
  syncVisitOutcomes(s.db, { now: localAt('2030-03-12', '10:10'), kekPath: s.kekPath });
  assert.equal(one(s.db, 'SELECT status FROM api_requests WHERE id = ?', id).status, 'arrived', 'платёж в день визита — пациент в клинике');
});

// ─── РЕВЬЮ 8a, M5: СВЕРКА НЕ ПЕРЕБИРАЕТ ВСЮ ИСТОРИЮ КАЖДЫЙ ТАКТ ──────────────

test('M5: «не пришёл» сверяется 14 дней после визита (оплата позже — «пришёл»); старше — нет', async () => {
  const s = bookingSeed();
  const { id, visit } = await confirmed(s);
  syncVisitOutcomes(s.db, { now: localAt('2030-03-13', '09:00'), kekPath: s.kekPath });
  assert.equal(one(s.db, 'SELECT status FROM api_requests WHERE id = ?', id).status, 'no_show');
  s.db.prepare("INSERT INTO invoices (id, invoice_number, visit_id, patient_id, subtotal, total_amount, paid_amount, status) VALUES (1, 'INV-1', ?, 1, 150000, 150000, 150000, 'paid')").run(visit.id);
  s.db.prepare('INSERT INTO payments (invoice_id, amount, method, paid_at) VALUES (1, 150000, ?, ?)').run('cash', new Date(localAt('2030-03-20', '08:30')).toISOString());
  assert.equal(syncVisitOutcomes(s.db, { now: localAt('2030-03-30', '09:00'), kekPath: s.kekPath }), 0, '18 дней спустя — не пересматривается');
  assert.equal(one(s.db, 'SELECT status FROM api_requests WHERE id = ?', id).status, 'no_show');
  assert.equal(syncVisitOutcomes(s.db, { now: localAt('2030-03-20', '09:00'), kekPath: s.kekPath }), 1, 'в пределах 14 дней — исправляется');
  assert.equal(one(s.db, 'SELECT status FROM api_requests WHERE id = ?', id).status, 'arrived');
});

test('M5: заявка «перезвоните» ищет запись по карточке 30 дней от прихода заявки; старше — нет', async () => {
  const s = bookingSeed();
  const r = await ingestItem(s.db, { ...apptItem({ connId: s.connId, publicId: 'rq_call0001', startMs: START, receivedMs: localAt('2030-01-20', '09:00') }), type: 'request.new',
    data: { external_id: 'cb-1', service_id: 301 } }, { now: localAt('2030-01-20', '09:00') });
  const card = one(s.db, 'SELECT crm_request_id AS c FROM api_requests WHERE id = ?', r.id).c;
  s.db.prepare("INSERT INTO patients (id, mrn, full_name, phone) VALUES (1, 'P-1', 'Абдурахмонов Фаррух', '+998901234567')").run();
  s.db.prepare('UPDATE crm_requests SET patient_id = 1 WHERE id = ?').run(card);
  s.db.prepare("UPDATE crm_request_services SET scheduled_date = '2030-03-12', doctor_id = 7 WHERE request_id = ?").run(card);
  const ev = await ensureVisit(s.db, { patient_id: 1, date: '2030-03-12', book: { doctor_id: 7, start: new Date(START).toISOString(), duration_minutes: 15, service_id: 301 } }, s.cc);
  assert.equal(ev.booked, true);
  assert.equal(syncVisitOutcomes(s.db, { now: NOW, kekPath: s.kekPath }), 0, 'заявке 50 дней — не сверяется');
  s.db.prepare("UPDATE api_requests SET received_at = '2030-03-01T04:00:00Z' WHERE id = ?").run(r.id);
  assert.equal(syncVisitOutcomes(s.db, { now: NOW, kekPath: s.kekPath }), 1);
});

// ─── ПОВТОРНАЯ ПРОВЕРКА 8a, п. 2: «ПЕРЕЗВОНИТЕ» НЕ БЕРЁТ СТАРЫЙ ВИЗИТ СЛИТОЙ КАРТОЧКИ ─

test('рр-2: после слияния с карточкой январского визита заявка «перезвоните» не привязывается к нему — партнёру ничего; новая запись по карточке — привязывается', async () => {
  const { crmMergeLeads } = await import('../rpc/crm-merge.js');
  for (const keepApi of [true, false]) {
    const s = bookingSeed();
    s.db.prepare("INSERT INTO patients (id, mrn, full_name, phone) VALUES (1, 'P-1', 'Абдурахмонов Фаррух', '+998901234567')").run();
    const OLD = localAt('2030-01-10', '10:00');
    const vOld = Number(s.db.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date, status) VALUES (1, 8, ?, 'arrived')").run(new Date(OLD).toISOString()).lastInsertRowid);
    const old = Number(s.db.prepare("INSERT INTO crm_requests (full_name, phone, source, status, patient_id, scheduled_date, created_at) VALUES ('Абдурахмонов Фаррух', '+998901234567', 'call', 'in_process', 1, '2030-01-10', '2030-01-09T09:00:00Z')").run().lastInsertRowid);
    s.db.prepare("INSERT INTO crm_request_services (request_id, consultation_type_id, doctor_id, scheduled_date, status, visit_id) VALUES (?, 2, 8, '2030-01-10', 'done', ?)").run(old, vOld);
    const r = await ingestItem(s.db, { ...apptItem({ connId: s.connId, publicId: 'rq_call0001', startMs: NOW, receivedMs: NOW }), type: 'request.new',
      data: { external_id: 'cb-1', service_id: 301 } }, { now: NOW });
    const apiCard = one(s.db, 'SELECT crm_request_id AS c FROM api_requests WHERE id = ?', r.id).c;
    crmMergeLeads(s.db, keepApi ? { keep_id: apiCard, merge_ids: [old] } : { keep_id: old, merge_ids: [apiCard] }, s.admin);
    assert.equal(syncVisitOutcomes(s.db, { now: NOW + 60000, kekPath: s.kekPath }), 0, 'keepApi=' + keepApi);
    assert.equal(one(s.db, 'SELECT status FROM api_requests WHERE id = ?', r.id).status, 'new');
    assert.equal(count(s), 0, 'о январском визите партнёру не уходит ничего');
    const card = one(s.db, 'SELECT crm_request_id AS c FROM api_requests WHERE id = ?', r.id).c;
    s.db.prepare("UPDATE crm_request_services SET scheduled_date = '2030-03-12', doctor_id = 7 WHERE request_id = ? AND status = 'pending'").run(card);
    const ev = await ensureVisit(s.db, { patient_id: 1, date: '2030-03-12', book: { doctor_id: 7, start: new Date(START).toISOString(), duration_minutes: 15, service_id: 301 } }, s.cc);
    assert.equal(syncVisitOutcomes(s.db, { now: NOW + 120000, kekPath: s.kekPath }), 1);
    assert.equal(one(s.db, 'SELECT visit_id FROM api_requests WHERE id = ?', r.id).visit_id, ev.visit.id, 'настоящая запись — привязана');
  }
});

// ─── ПОВТОРНАЯ ПРОВЕРКА 8a, п. 6: ПРЕДОПЛАТА — НЕ ПРИХОД; ДЕНЬ ВИЗИТА НЕ «ЗАМОРАЖИВАЕТ» ЗАЯВКУ ─

async function prepaid(s, startHhmm = '17:00') {
  const r = await ingestItem(s.db, apptItem({ connId: s.connId, startMs: localAt('2030-03-12', startHhmm), receivedMs: NOW }), { now: NOW, kekPath: s.kekPath });
  s.db.prepare("INSERT INTO patients (id, mrn, full_name, phone) VALUES (1, 'P-1', 'Абдурахмонов Фаррух', '+998901234567')").run();
  const c = await confirmBooking(s.db, { id: r.id, patientId: 1 }, s.reg, { now: NOW, kekPath: s.kekPath });
  s.db.prepare("INSERT INTO invoices (id, invoice_number, visit_id, patient_id, subtotal, total_amount, paid_amount, status) VALUES (1, 'INV-1', ?, 1, 150000, 150000, 150000, 'paid')").run(c.visit.id);
  s.db.prepare('INSERT INTO payments (invoice_id, amount, method, paid_at) VALUES (1, 150000, ?, ?)').run('cash', new Date(localAt('2030-03-11', '12:00')).toISOString());
  syncVisitOutcomes(s.db, { now: localAt('2030-03-12', '00:05'), kekPath: s.kekPath });
  return { id: r.id, visit: c.visit };
}

test('рр-6: предоплата накануне — утром в день визита клиника отменяет или переносит визит, партнёр узнаёт (не «пришёл» с полуночи)', async () => {
  const s = bookingSeed();
  const a = await prepaid(s);
  assert.equal(one(s.db, 'SELECT status FROM api_requests WHERE id = ?', a.id).status, 'confirmed', '00:05 — пациента ещё нет');
  await calendarBook(s.db, { visit_id: a.visit.id, start: a.visit.visit_date, status: 'cancelled' }, s.reg);
  syncVisitOutcomes(s.db, { now: localAt('2030-03-12', '09:00'), kekPath: s.kekPath });
  assert.deepEqual([last(s)[0], last(s)[1].status], ['appointment.cancelled', 'cancelled']);

  const s2 = bookingSeed();
  const b = await prepaid(s2);
  await calendarBook(s2.db, { visit_id: b.visit.id, start: new Date(localAt('2030-03-19', '11:00')).toISOString() }, s2.reg);
  syncVisitOutcomes(s2.db, { now: localAt('2030-03-12', '09:00'), kekPath: s2.kekPath });
  assert.deepEqual([last(s2)[0], last(s2)[1].rescheduled], ['appointment.created', true]);
});

test('рр-6: предоплата накануне — пациент отменяет у партнёра утром в день визита: отмена не теряется (пометка для регистратуры)', async () => {
  const s = bookingSeed();
  const a = await prepaid(s);
  const out = await ingestItem(s.db, { type: 'appointment.cancel', cursor: '9', public_id: 'rq_test0001', connection_id: s.connId }, { now: localAt('2030-03-12', '08:00'), kekPath: s.kekPath });
  assert.equal(out.applied, true);
  assert.ok(one(s.db, 'SELECT partner_cancel_at FROM api_requests WHERE id = ?', a.id).partner_cancel_at);
});

test('рр-6: пришедший пациент отменил у партнёра — отмена тоже не теряется: пометка, визит не трогается', async () => {
  const s = bookingSeed();
  const { id, visit } = await confirmed(s);
  await calendarBook(s.db, { visit_id: visit.id, start: visit.visit_date, status: 'arrived' }, s.reg);
  syncVisitOutcomes(s.db, { now: localAt('2030-03-12', '10:30'), kekPath: s.kekPath });
  assert.equal(one(s.db, 'SELECT status FROM api_requests WHERE id = ?', id).status, 'arrived');
  const out = await ingestItem(s.db, { type: 'appointment.cancel', cursor: '9', public_id: 'rq_test0001', connection_id: s.connId }, { now: localAt('2030-03-12', '10:40'), kekPath: s.kekPath });
  assert.deepEqual([out.applied, out.needs_staff], [true, true]);
  assert.equal(one(s.db, 'SELECT status FROM visits WHERE id = ?', visit.id).status, 'arrived');
});

// ─── ФИНАЛЬНАЯ ПРОВЕРКА 8a, п. 3: «ПРИШЁЛ» — ТОЛЬКО ПО ТВЁРДЫМ ПРИЗНАКАМ ───────
// Строки карточки, закрытые приходом ('done'), — не признак: исправленная
// ошибочная отметка «Пришёл» их не открывает.

const subscribed = (s) => s.db.prepare('UPDATE api_connections SET webhook_events = ? WHERE id = ?')
  .run(JSON.stringify(['booking.confirmed', 'appointment.arrived']), s.connId);
const arrivedEvents = (s) => one(s.db, "SELECT COUNT(*) AS n FROM api_outbox WHERE event = 'appointment.arrived'").n;
const statusOf = (s, id) => one(s.db, 'SELECT status FROM api_requests WHERE id = ?', id).status;

test('фп-3: «Пришёл» нажали по ошибке и исправили на «Записан» до такта — партнёру не «пришёл» ни накануне, ни в день визита; пациент не пришёл — наутро «не пришёл»', async () => {
  const s = bookingSeed();
  subscribed(s);
  const { id, visit } = await confirmed(s);
  await calendarBook(s.db, { visit_id: visit.id, start: visit.visit_date, status: 'arrived' }, s.reg);
  await calendarBook(s.db, { visit_id: visit.id, start: visit.visit_date, status: 'scheduled' }, s.reg);
  for (const [day, hhmm] of [['2030-03-11', '18:00'], ['2030-03-12', '00:05'], ['2030-03-12', '10:30']]) {
    syncVisitOutcomes(s.db, { now: localAt(day, hhmm), kekPath: s.kekPath });
    assert.equal(statusOf(s, id), 'confirmed', `${day} ${hhmm}`);
  }
  syncVisitOutcomes(s.db, { now: localAt('2030-03-13', '09:00'), kekPath: s.kekPath });
  assert.equal(statusOf(s, id), 'no_show');
  assert.equal(arrivedEvents(s), 0, 'партнёру «пришёл» не уходило');
});

test('фп-3: «Пришёл» по ошибке исправили на «Не пришёл» — заявка «не пришёл», партнёру не «пришёл»', async () => {
  const s = bookingSeed();
  subscribed(s);
  const { id, visit } = await confirmed(s);
  await calendarBook(s.db, { visit_id: visit.id, start: visit.visit_date, status: 'arrived' }, s.reg);
  await calendarBook(s.db, { visit_id: visit.id, start: visit.visit_date, status: 'no_show' }, s.reg);
  syncVisitOutcomes(s.db, { now: localAt('2030-03-12', '10:30'), kekPath: s.kekPath });
  assert.equal(statusOf(s, id), 'no_show');
  assert.equal(arrivedEvents(s), 0);
});

test.todo('фп-3: регистрация на стойке в день визита без оплаты и без работы (бесплатная консультация, неоплаченный счёт) — партнёр наутро видит «не пришёл»; известная щель строгого правила, принята (visit-events.js)');
