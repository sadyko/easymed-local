// PUBLIC_API_V1 — «Предложить другое время», «Отклонить», «Взять в работу»,
// истечение и ответы партнёра: время держится там, где надо, и только там;
// партнёр получает событие о каждом решении клиники; отмена пациентом
// освобождает время или отменяет визит без работы той же дверью календаря.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bookingSeed, localAt, apptItem } from '../../test-helpers/api-booking-seed.js';
import { ingestItem, confirmBooking, offerOtherTime, declineBooking, acceptRequest, expireDue } from './bookings.js';
import { slotIsFree } from '../rpc/calendar.js';
import { isoOf } from '../../../public/js/shared/api-booking.js';

const NOW = localAt('2030-03-11', '09:00');
const START = localAt('2030-03-12', '10:00');
const LATER = localAt('2030-03-12', '14:00');
const one = (db, sql, ...a) => db.prepare(sql).get(...a);
const free = (s, ms, now = NOW) => slotIsFree(s.db, { doctorId: 7, startMs: ms, durationMin: 30, now });
const events = (s) => s.db.prepare('SELECT event, body FROM api_outbox ORDER BY id').all().map((r) => [r.event, JSON.parse(r.body)]);
const refusal = (fn) => { try { fn(); } catch (e) { return e; } return assert.fail('ожидался отказ'); };
async function pending(s) {
  return (await ingestItem(s.db, apptItem({ connId: s.connId, startMs: START, receivedMs: NOW - 60000 }), { now: NOW, kekPath: s.kekPath })).id;
}
const inbox = (s, type, now) => ingestItem(s.db, { type, cursor: '9', public_id: 'rq_test0001', connection_id: s.connId }, { now, kekPath: s.kekPath });

test('другое время: прежнее освобождается, новое держится 30 минут; партнёр получает время и срок; согласие — снова ждёт подтверждения на новом времени', async () => {
  const s = bookingSeed();
  const id = await pending(s);
  const out = offerOtherTime(s.db, { id, start: new Date(LATER).toISOString() }, s.reg, { now: NOW + 60000, kekPath: s.kekPath });
  assert.deepEqual([out.status, out.offered_start, out.offer_until],
    ['offered', new Date(LATER).toISOString().replace('.000', ''), new Date(NOW + 31 * 60000).toISOString().replace('.000', '')]);
  assert.equal(free(s, START), true, 'прежнее время свободно');
  assert.equal(free(s, LATER), false, 'предложенное держится');
  const [ev, body] = events(s).at(-1);
  assert.equal(ev, 'booking.offered_other_time');
  assert.deepEqual([body.status, typeof body.offered_start, typeof body.offer_until], ['offered', 'string', 'string']);
  assert.match(body.offered_start, /^2030-03-12T14:00:00\+/);
  const acc = await inbox(s, 'offer.accept', NOW + 5 * 60000);
  assert.equal(acc.status, 'pending');
  const row = one(s.db, 'SELECT * FROM api_requests WHERE id = ?', id);
  assert.deepEqual([row.start_at, row.offered_start, row.hold_until],
    [new Date(LATER).toISOString().replace('.000', ''), null, new Date(NOW + 35 * 60000).toISOString().replace('.000', '')]);
  s.db.prepare("INSERT INTO patients (id, mrn, full_name, phone) VALUES (1, 'P-1', 'Абдурахмонов Фаррух', '+998901234567')").run();
  const c = await confirmBooking(s.db, { id, patientId: 1 }, s.reg, { now: NOW + 6 * 60000, kekPath: s.kekPath });
  assert.equal(Date.parse(c.visit.visit_date), LATER);
});

test('другое время: только свободное, в будущем и пока время держится', async () => {
  const s = bookingSeed();
  const id = await pending(s);
  assert.equal(refusal(() => offerOtherTime(s.db, { id, start: 'завтра' }, s.reg, { now: NOW })).status, 400);
  assert.equal(refusal(() => offerOtherTime(s.db, { id, start: new Date(NOW - 60000).toISOString() }, s.reg, { now: NOW })).status, 400);
  assert.equal(refusal(() => offerOtherTime(s.db, { id, start: new Date(localAt('2030-03-12', '10:07')).toISOString() }, s.reg, { now: NOW })).code, 'slot_taken');
  const late = refusal(() => offerOtherTime(s.db, { id, start: new Date(LATER).toISOString() }, s.reg, { now: NOW + 40 * 60000 }));
  assert.equal(late.status, 409);
  // То же время, что уже держит заявка, предложить можно (своё удержание не мешает).
  assert.equal(offerOtherTime(s.db, { id, start: new Date(localAt('2030-03-12', '10:15')).toISOString() }, s.reg, { now: NOW }).status, 'offered');
});

test('партнёр отказался от другого времени — отменено, время свободно; не ответил за 30 минут — истекло', async () => {
  const s = bookingSeed();
  const id = await pending(s);
  offerOtherTime(s.db, { id, start: new Date(LATER).toISOString() }, s.reg, { now: NOW, kekPath: s.kekPath });
  const r = await inbox(s, 'offer.decline', NOW + 60000);
  assert.equal(r.status, 'cancelled');
  assert.equal(free(s, LATER), true);

  const s2 = bookingSeed();
  const id2 = await pending(s2);
  offerOtherTime(s2.db, { id: id2, start: new Date(LATER).toISOString() }, s2.reg, { now: NOW, kekPath: s2.kekPath });
  assert.equal(expireDue(s2.db, { now: NOW + 31 * 60000, kekPath: s2.kekPath }), 1);
  assert.equal(one(s2.db, 'SELECT status FROM api_requests WHERE id = ?', id2).status, 'expired');
  assert.deepEqual(events(s2).at(-1).slice(0, 1), ['booking.declined']);
  assert.equal(events(s2).at(-1)[1].reason, 'expired');
});

test('«Отклонить»: время свободно, партнёр получает причину; причина — из трёх; повторно — нельзя', async () => {
  const s = bookingSeed();
  const id = await pending(s);
  assert.equal(refusal(() => declineBooking(s.db, { id, reason: 'duplicate' }, s.reg, { now: NOW })).status, 400);
  const out = declineBooking(s.db, { id, reason: 'doctor_unavailable' }, s.reg, { now: NOW, kekPath: s.kekPath });
  assert.deepEqual([out.status, out.decline_reason, out.handled_by], ['declined', 'doctor_unavailable', 2]);
  assert.equal(free(s, START), true);
  const [ev, body] = events(s).at(-1);
  assert.deepEqual([ev, body.status, body.reason], ['booking.declined', 'declined', 'doctor_unavailable']);
  assert.equal(refusal(() => declineBooking(s.db, { id, reason: 'other' }, s.reg, { now: NOW })).status, 409);
});

test('заявка без времени: «Взять в работу» — один раз, партнёру «request.accepted»', async () => {
  const s = bookingSeed();
  const r = await ingestItem(s.db, { ...apptItem({ connId: s.connId, publicId: 'rq_call0001', startMs: START, receivedMs: NOW }), type: 'request.new',
    data: { external_id: 'cb-1' } }, { now: NOW });
  const out = acceptRequest(s.db, { id: r.id }, s.cc, { now: NOW, kekPath: s.kekPath });
  assert.equal(out.status, 'accepted');
  assert.deepEqual([events(s).at(-1)[0], events(s).at(-1)[1].status], ['request.accepted', 'accepted']);
  assert.equal(refusal(() => acceptRequest(s.db, { id: r.id }, s.cc, { now: NOW })).status, 409);
});

test('отмена пациентом у партнёра: ждущая — время свободно; записанная без работы — визит отменён календарём, партнёру «appointment.cancelled»; с работой — визит не трогается', async () => {
  const s = bookingSeed();
  const id = await pending(s);
  const r = await inbox(s, 'appointment.cancel', NOW + 60000);
  assert.equal(r.status, 'cancelled');
  assert.equal(free(s, START), true);
  assert.ok(one(s.db, 'SELECT partner_cancel_at FROM api_requests WHERE id = ?', id).partner_cancel_at);

  const s2 = bookingSeed();
  const id2 = await pending(s2);
  s2.db.prepare("INSERT INTO patients (id, mrn, full_name, phone) VALUES (1, 'P-1', 'Абдурахмонов Фаррух', '+998901234567')").run();
  const c = await confirmBooking(s2.db, { id: id2, patientId: 1 }, s2.reg, { now: NOW, kekPath: s2.kekPath });
  const r2 = await ingestItem(s2.db, { type: 'appointment.cancel', cursor: '10', public_id: 'rq_test0001', connection_id: s2.connId }, { now: NOW + 60000, kekPath: s2.kekPath });
  assert.equal(r2.status, 'cancelled');
  assert.equal(one(s2.db, 'SELECT status FROM visits WHERE id = ?', c.visit.id).status, 'cancelled');
  assert.deepEqual([events(s2).at(-1)[0], events(s2).at(-1)[1].status], ['appointment.cancelled', 'cancelled']);

  const s3 = bookingSeed();
  const id3 = await pending(s3);
  s3.db.prepare("INSERT INTO patients (id, mrn, full_name, phone) VALUES (1, 'P-1', 'Абдурахмонов Фаррух', '+998901234567')").run();
  const c3 = await confirmBooking(s3.db, { id: id3, patientId: 1 }, s3.reg, { now: NOW, kekPath: s3.kekPath });
  s3.db.prepare("INSERT INTO invoices (id, invoice_number, visit_id, patient_id, subtotal, total_amount) VALUES (1, 'INV-1', ?, 1, 150000, 150000)").run(c3.visit.id);
  const r3 = await ingestItem(s3.db, { type: 'appointment.cancel', cursor: '11', public_id: 'rq_test0001', connection_id: s3.connId }, { now: NOW + 60000, kekPath: s3.kekPath });
  assert.deepEqual([r3.status, r3.needs_staff], ['confirmed', true]);
  assert.equal(one(s3.db, 'SELECT status FROM visits WHERE id = ?', c3.visit.id).status, 'scheduled');
  assert.ok(one(s3.db, 'SELECT partner_cancel_at FROM api_requests WHERE id = ?', id3).partner_cancel_at);

  // Отмена в ту секунду, когда регистратор подтверждает, — не теряется: пометка для регистратуры.
  const s4 = bookingSeed();
  const id4 = await pending(s4);
  s4.db.prepare("UPDATE api_requests SET status = 'confirming' WHERE id = ?").run(id4);
  const r4 = await ingestItem(s4.db, { type: 'appointment.cancel', cursor: '12', public_id: 'rq_test0001', connection_id: s4.connId }, { now: NOW + 60000, kekPath: s4.kekPath });
  assert.deepEqual([r4.applied, r4.status, r4.needs_staff], [true, 'confirming', true]);
  assert.ok(one(s4.db, 'SELECT partner_cancel_at FROM api_requests WHERE id = ?', id4).partner_cancel_at);
});

test('решение 18: предложение ждёт ПАРТНЁРА — 30 обычных минут; согласие партнёра снова ждёт регистратора — 30 рабочих минут', async () => {
  const s = bookingSeed();
  const HOURS = JSON.stringify(Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map((d) => [d, { on: true, from: '08:00', to: '18:00' }])));
  s.db.prepare('UPDATE branches SET working_hours = ? WHERE id = (SELECT branch_id FROM branch_identity WHERE id = 1)').run(HOURS);
  const t0 = localAt('2030-03-11', '17:45');
  const r = await ingestItem(s.db, apptItem({ connId: s.connId, startMs: START, receivedMs: t0 - 60000 }), { now: t0, kekPath: s.kekPath });
  assert.equal(r.hold_until, isoOf(localAt('2030-03-12', '08:15')), '15 минут сегодня и 15 завтра');
  const off = offerOtherTime(s.db, { id: r.id, start: new Date(LATER).toISOString() }, s.reg, { now: t0 + 5 * 60000, kekPath: s.kekPath });
  assert.equal(off.offer_until, isoOf(t0 + 35 * 60000), 'до 18:20, а не до утра');
  const acc = await inbox(s, 'offer.accept', t0 + 20 * 60000);
  assert.deepEqual([acc.status, acc.hold_until], ['pending', isoOf(localAt('2030-03-12', '08:30'))], 'согласие в 18:05 — держим до 08:30');
});

// ─── РЕВЬЮ 8a, I5: ДРУГОЕ ВРЕМЯ — НА ДРУГОЙ ДЕНЬ ────────────────────────────

test('I5: другое время на другой день — после согласия и подтверждения строка консультации в визите по цене кассы; на старом дне ничего не висит', async () => {
  const s = bookingSeed();
  const NEXT = localAt('2030-03-13', '11:00');
  const id = await pending(s);
  offerOtherTime(s.db, { id, start: new Date(NEXT).toISOString() }, s.reg, { now: NOW + 60000, kekPath: s.kekPath });
  assert.equal((await inbox(s, 'offer.accept', NOW + 5 * 60000)).status, 'pending');
  const cardId = one(s.db, 'SELECT crm_request_id AS c FROM api_requests WHERE id = ?', id).c;
  assert.equal(one(s.db, 'SELECT scheduled_date FROM crm_requests WHERE id = ?', cardId).scheduled_date, '2030-03-13', 'карточка — на день нового времени');
  assert.deepEqual(s.db.prepare('SELECT scheduled_date, status FROM crm_request_services WHERE request_id = ?').all(cardId).map((x) => ({ ...x })),
    [{ scheduled_date: '2030-03-13', status: 'pending' }]);
  s.db.prepare("INSERT INTO patients (id, mrn, full_name, phone) VALUES (1, 'P-1', 'Абдурахмонов Фаррух', '+998901234567')").run();
  const c = await confirmBooking(s.db, { id, patientId: 1 }, s.reg, { now: NOW + 6 * 60000, kekPath: s.kekPath });
  assert.equal(Date.parse(c.visit.visit_date), NEXT);
  assert.deepEqual(s.db.prepare('SELECT consultation_type_id, doctor_id, unit_price, status FROM visit_services WHERE visit_id = ?').all(c.visit.id).map((x) => ({ ...x })),
    [{ consultation_type_id: 1, doctor_id: 7, unit_price: 150000, status: 'added' }]);
  assert.equal(one(s.db, 'SELECT visit_id FROM crm_request_services WHERE request_id = ?', cardId).visit_id, c.visit.id);
  assert.equal(one(s.db, "SELECT COUNT(*) AS n FROM crm_request_services WHERE scheduled_date = '2030-03-12' AND visit_id IS NULL").n, 0);
});

test('I7: отмена партнёром не отменяет визит, на котором есть и чужая запись (строка или привязка другой карточки) — пометка «решите вручную»', async () => {
  const s = bookingSeed();
  const id = await pending(s);
  s.db.prepare("INSERT INTO patients (id, mrn, full_name, phone) VALUES (1, 'P-1', 'Абдурахмонов Фаррух', '+998901234567')").run();
  const c = await confirmBooking(s.db, { id, patientId: 1 }, s.reg, { now: NOW, kekPath: s.kekPath });
  // На тот же визит легла запись колл-центра (другая карточка): строка повторного приёма.
  const phone = Number(s.db.prepare("INSERT INTO crm_requests (full_name, phone, source, status, patient_id, scheduled_date) VALUES ('Абдурахмонов Фаррух', '+998901234567', 'call', 'scheduled', 1, '2030-03-12')").run().lastInsertRowid);
  s.db.prepare("INSERT INTO crm_request_services (request_id, consultation_type_id, doctor_id, scheduled_date, status, visit_id) VALUES (?, 2, 7, '2030-03-12', 'pending', ?)").run(phone, c.visit.id);
  const r = await inbox(s, 'appointment.cancel', NOW + 60000);
  assert.deepEqual([r.applied, r.status, r.needs_staff], [true, 'confirmed', true]);
  assert.equal(one(s.db, 'SELECT status FROM visits WHERE id = ?', c.visit.id).status, 'scheduled', 'визит с чужой записью не отменён');
  assert.ok(one(s.db, 'SELECT partner_cancel_at FROM api_requests WHERE id = ?', id).partner_cancel_at);
});
