// CRM_ONE_WAY_V1 (2026-10-17) — повтор ревью «8a/zz-s8z-cardsave.test.js» (scratchpad crm-link-review), перенесён в клон
// настоящим тестом с ожиданиями одного направления (docs/plans/2026-10-17-crm-one-way.md, задача 6,
// таблица повторов). Изменённые ожидания помечены CRM_ONE_WAY_V1 и правилом O; устаревшие тесты убраны
// с причиной в плане.
// Repro: own-line move (5b2ef1f3) after the CRM card was saved in the card window.
// The card editor's saveLines (public/js/admin/views/crm.js:2427-2501) is a full
// replace through /api/db: every pending line WITHOUT visit_id is set 'cancelled'
// and the picked set is INSERTed again as new rows (new ids). /api/db's mirror
// hooks (booking-mirror-db.js) do nothing for visit-less lines, so the two SQL
// statements below are exactly what the server executes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bookingSeed, localAt, apptItem } from '../../test-helpers/api-booking-seed.js';
import { ingestItem, confirmBooking, offerOtherTime } from './bookings.js';

const NOW = localAt('2030-03-11', '09:00');
const START = localAt('2030-03-12', '10:00');
const D2 = localAt('2030-03-14', '11:00');
const one = (db, sql, ...a) => db.prepare(sql).get(...a);

function saveCardLikeTheCardWindow(db, cardId) {
  const picked = db.prepare("SELECT service_id, consultation_type_id, doctor_id, scheduled_date FROM crm_request_services WHERE request_id = ? AND status = 'pending' AND visit_id IS NULL").all(cardId);
  db.prepare("UPDATE crm_request_services SET status = 'cancelled' WHERE request_id = ? AND status = 'pending' AND visit_id IS NULL").run(cardId);
  const ins = db.prepare("INSERT INTO crm_request_services (request_id, service_id, consultation_type_id, scheduled_date, doctor_id, status) VALUES (?, ?, ?, ?, ?, 'pending')");
  for (const p of picked) ins.run(cardId, p.service_id, p.consultation_type_id, p.scheduled_date, p.doctor_id);
}

test('CRM_ONE_WAY_V1 (повтор 8a) — card saved (e.g. a note) while the online booking waits; partner accepts another day; confirm -> the consultation must be in the 03-14 visit', async () => {
  const s = bookingSeed();
  s.db.prepare("INSERT INTO patients (id, mrn, full_name, phone) VALUES (1, 'P-1', 'Абдурахмонов Фаррух', '+998901234567')").run();
  const r = await ingestItem(s.db, apptItem({ connId: s.connId, startMs: START, receivedMs: NOW - 60000 }), { now: NOW, kekPath: s.kekPath });
  assert.equal(r.status, 'pending');
  const cardId = one(s.db, 'SELECT crm_request_id AS c FROM api_requests WHERE id = ?', r.id).c;
  saveCardLikeTheCardWindow(s.db, cardId);
  offerOtherTime(s.db, { id: r.id, start: new Date(D2).toISOString() }, s.reg, { now: NOW + 60000, kekPath: s.kekPath });
  const acc = await ingestItem(s.db, { type: 'offer.accept', cursor: '9', public_id: 'rq_test0001', connection_id: s.connId }, { now: NOW + 5 * 60000, kekPath: s.kekPath });
  assert.equal(acc.status, 'pending');
  const c = await confirmBooking(s.db, { id: r.id, patientId: 1 }, s.reg, { now: NOW + 6 * 60000, kekPath: s.kekPath });
  const vlines = s.db.prepare("SELECT consultation_type_id, unit_price FROM visit_services WHERE visit_id = ? AND status <> 'cancelled'").all(c.visit.id).map((x) => ({ ...x }));
  const left = s.db.prepare("SELECT id, scheduled_date, visit_id FROM crm_request_services WHERE request_id = ? AND status = 'pending'").all(cardId).map((x) => ({ ...x }));
  console.log('visit', c.visit.visit_date, 'lines', JSON.stringify(vlines), 'pending card lines', JSON.stringify(left));
  assert.deepEqual(vlines, [{ consultation_type_id: 1, unit_price: 150000 }], 'the confirmed 03-14 visit carries the booked consultation');
  assert.deepEqual(left.map((l) => l.scheduled_date), ['2030-03-14'], 'no pending consultation left behind on 03-12');
});

test('CRM_ONE_WAY_V1 (повтор 8a) — ...and the line left on 03-12 is billed into another visit of that patient on 03-12', async () => {
  const { ensureVisit } = await import('../rpc/visits.js');
  const s = bookingSeed();
  s.db.prepare("INSERT INTO patients (id, mrn, full_name, phone) VALUES (1, 'P-1', 'Абдурахмонов Фаррух', '+998901234567')").run();
  const r = await ingestItem(s.db, apptItem({ connId: s.connId, startMs: START, receivedMs: NOW - 60000 }), { now: NOW, kekPath: s.kekPath });
  const cardId = one(s.db, 'SELECT crm_request_id AS c FROM api_requests WHERE id = ?', r.id).c;
  saveCardLikeTheCardWindow(s.db, cardId);
  offerOtherTime(s.db, { id: r.id, start: new Date(D2).toISOString() }, s.reg, { now: NOW + 60000, kekPath: s.kekPath });
  await ingestItem(s.db, { type: 'offer.accept', cursor: '9', public_id: 'rq_test0001', connection_id: s.connId }, { now: NOW + 5 * 60000, kekPath: s.kekPath });
  const c = await confirmBooking(s.db, { id: r.id, patientId: 1 }, s.reg, { now: NOW + 6 * 60000, kekPath: s.kekPath });
  // On 03-12 the patient walks in for a blood test (registrar, visit wizard: ensure_visit without book).
  const lab = await ensureVisit(s.db, { patient_id: 1, date: '2030-03-12' }, s.reg);
  const labLines = s.db.prepare("SELECT consultation_type_id, service_id, unit_price FROM visit_services WHERE visit_id = ? AND status <> 'cancelled'").all(lab.visit.id).map((x) => ({ ...x }));
  console.log('03-12 visit lines', JSON.stringify(labLines), '03-14 visit lines', JSON.stringify(s.db.prepare('SELECT consultation_type_id FROM visit_services WHERE visit_id = ?').all(c.visit.id)));
  assert.deepEqual(labLines, [], 'the online consultation (now booked for 03-14) is not billed on the 03-12 visit');
});
