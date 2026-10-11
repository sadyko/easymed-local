// PUBLIC_API_V1 — ПОДТВЕРЖДЕНИЕ ОНЛАЙН-ЗАПИСИ: регистратор выбрал карту — визит
// заводит ensure_visit (та же дверь, что у регистратуры): ровно один визит на
// выбранное время, строка консультации по цене кассы, карточка привязана,
// удержание снято, партнёр получает «booking.confirmed». Истёкшее не
// подтверждается; визит дня с работой — отказ до первой записи; гонка двух
// подтверждающих — один визит.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bookingSeed, localAt, apptItem } from '../../test-helpers/api-booking-seed.js';
import { ingestItem, confirmBooking, expireDue } from './bookings.js';
import { slotIsFree, calendarBook } from '../rpc/calendar.js';

const NOW = localAt('2030-03-11', '09:00');
const START = localAt('2030-03-12', '10:00');
const one = (db, sql, ...a) => db.prepare(sql).get(...a);
const refusal = async (p) => { try { await p; } catch (e) { return e; } return assert.fail('ожидался отказ'); };

async function pending(s, over = {}) {
  const r = await ingestItem(s.db, apptItem({ connId: s.connId, startMs: START, receivedMs: NOW - 60000, ...over }), { now: NOW, kekPath: s.kekPath });
  assert.equal(r.status, 'pending');
  return r.id;
}
const patient = (s, id = 1, name = 'Абдурахмонов Фаррух') =>
  s.db.prepare("INSERT INTO patients (id, mrn, full_name, phone) VALUES (?, ?, ?, '+998901234567')").run(id, 'P-' + id, name);

test('подтверждение: один визит на выбранное время у выбранного врача; строка консультации по общей цене вида; карточка привязана; удержание снято; партнёру — booking.confirmed', async () => {
  const s = bookingSeed();
  const id = await pending(s);
  patient(s);
  const out = await confirmBooking(s.db, { id, patientId: 1 }, s.reg, { now: NOW + 60000, kekPath: s.kekPath });
  const visits = s.db.prepare('SELECT * FROM visits').all();
  assert.equal(visits.length, 1);
  const v = visits[0];
  assert.deepEqual([v.patient_id, v.doctor_id, Date.parse(v.visit_date), v.duration_minutes, v.status], [1, 7, START, 30, 'scheduled']);
  assert.equal(out.visit.id, v.id);
  const req = one(s.db, 'SELECT * FROM api_requests WHERE id = ?', id);
  assert.deepEqual([req.status, req.visit_id, req.patient_id, req.handled_by], ['confirmed', v.id, 1, 2]);
  const line = one(s.db, 'SELECT consultation_type_id, doctor_id, unit_price, status FROM visit_services WHERE visit_id = ?', v.id);
  assert.deepEqual({ ...line }, { consultation_type_id: 1, doctor_id: 7, unit_price: 150000, status: 'added' }, 'цена — как у кассы (решение 8)');
  const card = one(s.db, 'SELECT * FROM crm_requests WHERE id = ?', req.crm_request_id);
  assert.equal(card.patient_id, 1);
  assert.equal(card.status, 'scheduled', 'карточка — в «Колонке записи», как у записи колл-центра');
  assert.equal(one(s.db, 'SELECT visit_id FROM crm_request_services WHERE request_id = ?', card.id).visit_id, v.id);
  assert.equal(one(s.db, 'SELECT COUNT(*) AS n FROM slot_holds WHERE api_request_id = ? AND released_at IS NULL', id).n, 0);
  assert.equal(one(s.db, 'SELECT release_reason FROM slot_holds WHERE api_request_id = ?', id).release_reason, 'confirmed');
  const ev = one(s.db, "SELECT * FROM api_outbox WHERE event = 'booking.confirmed'");
  const body = JSON.parse(ev.body);
  assert.deepEqual([body.status, body.request_id, body.doctor_id], ['booked', 'rq_test0001', 7]);
  assert.match(body.start, /^2030-03-12T10:00:00\+\d\d:\d\d$/);
  assert.ok(ev.signature.startsWith('sha256='));
  assert.equal(slotIsFree(s.db, { doctorId: 7, startMs: START, durationMin: 30, now: NOW }), false, 'теперь время держит визит');
});

test('повторное подтверждение — тот же визит; два подтверждающих одновременно — один визит', async () => {
  const s = bookingSeed();
  const id = await pending(s);
  patient(s);
  const [a, b] = await Promise.allSettled([
    confirmBooking(s.db, { id, patientId: 1 }, s.reg, { now: NOW, kekPath: s.kekPath }),
    confirmBooking(s.db, { id, patientId: 1 }, s.cc, { now: NOW, kekPath: s.kekPath }),
  ]);
  const ok = [a, b].filter((x) => x.status === 'fulfilled');
  assert.ok(ok.length >= 1);
  for (const x of [a, b]) if (x.status === 'rejected') assert.equal(x.reason.code, 'busy');
  const again = await confirmBooking(s.db, { id, patientId: 1 }, s.reg, { now: NOW, kekPath: s.kekPath });
  assert.equal(again.already, true);
  assert.equal(one(s.db, 'SELECT COUNT(*) AS n FROM visits').n, 1);
  assert.equal(one(s.db, "SELECT COUNT(*) AS n FROM api_outbox WHERE event = 'booking.confirmed'").n, 1);
});

test('время истекло: подтверждения нет, итог «expired», партнёру — отказ; время свободно', async () => {
  const s = bookingSeed();
  const id = await pending(s);
  patient(s);
  const e = await refusal(confirmBooking(s.db, { id, patientId: 1 }, s.reg, { now: NOW + 31 * 60000, kekPath: s.kekPath }));
  assert.equal(e.code, 'hold_expired');
  assert.equal(one(s.db, 'SELECT status FROM api_requests WHERE id = ?', id).status, 'expired');
  const body = JSON.parse(one(s.db, "SELECT body FROM api_outbox WHERE event = 'booking.declined'").body);
  assert.deepEqual([body.status, body.reason], ['expired', 'expired']);
  assert.equal(slotIsFree(s.db, { doctorId: 7, startMs: START, durationMin: 30, now: NOW }), true);
  assert.equal(one(s.db, 'SELECT COUNT(*) AS n FROM visits').n, 0);
  assert.equal(expireDue(s.db, { now: NOW + 40 * 60000, kekPath: s.kekPath }), 0, 'второй проход ничего не находит');
});

test('визит дня с работой: отказ до первой записи — строки заявки не уходят в чужую смету, карточку отказ не трогает', async () => {
  const s = bookingSeed();
  const id = await pending(s);
  patient(s);
  const dv = await calendarBook(s.db, { patient_id: 1, doctor_id: 8, start: new Date(localAt('2030-03-12', '08:00')).toISOString(), duration_minutes: 15 }, s.reg);
  s.db.prepare("INSERT INTO invoices (id, invoice_number, visit_id, patient_id, subtotal, total_amount) VALUES (1, 'INV-1', ?, 1, 1000, 1000)").run(dv.visit.id);
  const req = one(s.db, 'SELECT crm_request_id FROM api_requests WHERE id = ?', id);
  // Запись к Каримовой уже связала карточку по номеру (crm/visit-link.js, шаг D) — это правило CRM, не подтверждения.
  const cardBefore = { ...one(s.db, 'SELECT patient_id, status FROM crm_requests WHERE id = ?', req.crm_request_id) };
  const e = await refusal(confirmBooking(s.db, { id, patientId: 1 }, s.reg, { now: NOW, kekPath: s.kekPath }));
  assert.equal(e.code, 'day_visit_busy');
  assert.equal(e.status, 409);
  assert.equal(e.params.doctor, 'Каримова Нигора');
  assert.equal(one(s.db, 'SELECT status FROM api_requests WHERE id = ?', id).status, 'pending');
  assert.deepEqual({ ...one(s.db, 'SELECT patient_id, status FROM crm_requests WHERE id = ?', req.crm_request_id) }, cardBefore, 'карточку отказ не тронул');
  assert.equal(one(s.db, 'SELECT COUNT(*) AS n FROM visit_services WHERE visit_id = ? AND consultation_type_id = 1', dv.visit.id).n, 0, 'консультация заявки не ушла в смету визита Каримовой');
});

test('отказ двери записи (экстренная запись поверх удержания): заявка снова ждёт, карточка без карты, визита нет', async () => {
  const s = bookingSeed();
  const id = await pending(s);
  patient(s);
  patient(s, 2, 'Другой Пациент');
  await calendarBook(s.db, { patient_id: 2, doctor_id: 7, start: new Date(START).toISOString(), duration_minutes: 30, emergency: true, emergency_reason: 'боль' }, s.reg);
  const e = await refusal(confirmBooking(s.db, { id, patientId: 1 }, s.reg, { now: NOW, kekPath: s.kekPath }));
  assert.equal(e.code, 'slot_taken');
  assert.equal(one(s.db, 'SELECT status FROM api_requests WHERE id = ?', id).status, 'pending');
  assert.equal(one(s.db, 'SELECT COUNT(*) AS n FROM visits WHERE patient_id = 1').n, 0);
});

test('семья на одном номере: карточку по номеру связали с мамой — регистратор выбирает ребёнка, визит и консультация — у ребёнка', async () => {
  const s = bookingSeed();
  const id = await pending(s, { name: 'Абдурахмонова Мадина', comment: 'Записываю дочь' });
  patient(s, 1, 'Абдурахмонова Мадина');
  patient(s, 2, 'Абдурахмонова Лола');
  const req = one(s.db, 'SELECT crm_request_id FROM api_requests WHERE id = ?', id);
  s.db.prepare('UPDATE crm_requests SET patient_id = 1 WHERE id = ?').run(req.crm_request_id);
  const out = await confirmBooking(s.db, { id, patientId: 2 }, s.reg, { now: NOW, kekPath: s.kekPath });
  assert.equal(out.visit.patient_id, 2);
  assert.equal(one(s.db, 'SELECT patient_id FROM crm_requests WHERE id = ?', req.crm_request_id).patient_id, 2);
  assert.deepEqual({ ...one(s.db, 'SELECT consultation_type_id, unit_price FROM visit_services WHERE visit_id = ?', out.visit.id) },
    { consultation_type_id: 1, unit_price: 150000 });
});

test('отказы: не та заявка, без карты, чужая карта, не ждёт', async () => {
  const s = bookingSeed();
  const id = await pending(s);
  assert.equal((await refusal(confirmBooking(s.db, { id, patientId: null }, s.reg, { now: NOW }))).status, 400);
  assert.equal((await refusal(confirmBooking(s.db, { id, patientId: 99 }, s.reg, { now: NOW }))).status, 400);
  assert.equal((await refusal(confirmBooking(s.db, { id: 999, patientId: 1 }, s.reg, { now: NOW }))).status, 404);
  s.db.prepare("UPDATE api_requests SET status = 'declined', decline_reason = 'other' WHERE id = ?").run(id);
  assert.equal((await refusal(confirmBooking(s.db, { id, patientId: 1 }, s.reg, { now: NOW }))).status, 409);
});
