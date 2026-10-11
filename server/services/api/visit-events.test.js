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
  const ev = one(s2.db, "SELECT note FROM api_outbox WHERE event = 'appointment.arrived'");
  assert.equal(ev.note, 'not_subscribed', 'партнёр «пришёл» не выбирал — статус есть, уведомления нет');
});

test('день прошёл без прихода — «Не пришёл»; оплата, доехавшая позже, — «Пришёл»', async () => {
  const s = bookingSeed();
  const { id, visit } = await confirmed(s);
  syncVisitOutcomes(s.db, { now: localAt('2030-03-13', '09:00'), kekPath: s.kekPath });
  assert.equal(one(s.db, 'SELECT status FROM api_requests WHERE id = ?', id).status, 'no_show');
  s.db.prepare("INSERT INTO invoices (id, invoice_number, visit_id, patient_id, subtotal, total_amount, paid_amount, status) VALUES (1, 'INV-1', ?, 1, 150000, 150000, 150000, 'paid')").run(visit.id);
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
