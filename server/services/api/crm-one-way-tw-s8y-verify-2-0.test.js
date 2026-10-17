// CRM_ONE_WAY_V1 (2026-10-17) — повтор ревью «8a/zz-s8y-verify-2-0.test.js» (scratchpad crm-link-review), перенесён в клон
// настоящим тестом с ожиданиями одного направления (docs/plans/2026-10-17-crm-one-way.md, задача 6,
// таблица повторов). Изменённые ожидания помечены CRM_ONE_WAY_V1 и правилом O; устаревшие тесты убраны
// с причиной в плане.
// zz-s8y-verify-2-0 — skeptic #1 for "f0a22da5: 'done' CRM lines count as arrival permanently".
// Each scenario prints the partner-facing outcome; run in the 2eaa7ce0 export and in the dff1bcba baseline.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bookingSeed, localAt, apptItem } from '../../test-helpers/api-booking-seed.js';
import { ingestItem, confirmBooking } from './bookings.js';
import { syncVisitOutcomes } from './visit-events.js';
import { calendarBook } from '../rpc/calendar.js';

const NOW = localAt('2030-03-11', '09:00');
const START = localAt('2030-03-12', '10:00');
const one = (db, sql, ...a) => db.prepare(sql).get(...a);

async function booked() {
  const s = bookingSeed();
  s.db.prepare('UPDATE api_connections SET webhook_events = ? WHERE id = ?').run(JSON.stringify(['booking.confirmed', 'appointment.arrived']), s.connId);
  const r = await ingestItem(s.db, apptItem({ connId: s.connId, startMs: START, receivedMs: NOW }), { now: NOW, kekPath: s.kekPath });
  s.db.prepare("INSERT INTO patients (id, mrn, full_name, phone) VALUES (1, 'P-1', 'Абдурахмонов Фаррух', '+998901234567')").run();
  const c = await confirmBooking(s.db, { id: r.id, patientId: 1 }, s.reg, { now: NOW, kekPath: s.kekPath });
  return { s, id: r.id, visit: c.visit };
}
const state = (s, id, visitId) => ({
  req: one(s.db, 'SELECT status FROM api_requests WHERE id = ?', id).status,
  visit: one(s.db, 'SELECT status FROM visits WHERE id = ?', visitId).status,
  lines: s.db.prepare('SELECT status FROM crm_request_services WHERE visit_id = ?').all(visitId).map((l) => l.status).join(','),
  arrivedEvents: one(s.db, "SELECT COUNT(*) n FROM api_outbox WHERE event = 'appointment.arrived'").n,
});

test('CRM_ONE_WAY_V1 (повтор 8a) — V1: visit day — mis-click «Пришёл», corrected to «Записан» seconds later (tick at 09:55 before, 10:01 after); patient never comes', async () => {
  const { s, id, visit } = await booked();
  syncVisitOutcomes(s.db, { now: localAt('2030-03-12', '09:55'), kekPath: s.kekPath });
  await calendarBook(s.db, { visit_id: visit.id, start: visit.visit_date, status: 'arrived' }, s.reg);
  await calendarBook(s.db, { visit_id: visit.id, start: visit.visit_date, status: 'scheduled' }, s.reg);
  syncVisitOutcomes(s.db, { now: localAt('2030-03-12', '10:01'), kekPath: s.kekPath });
  const sameDay = state(s, id, visit.id);
  syncVisitOutcomes(s.db, { now: localAt('2030-03-13', '09:00'), kekPath: s.kekPath });
  const next = state(s, id, visit.id);
  console.log('V1 same day', JSON.stringify(sameDay), '| next morning', JSON.stringify(next));
  assert.equal(next.req, 'no_show');
  assert.equal(next.arrivedEvents, 0);
});

test('CRM_ONE_WAY_V1 (повтор 8a) — V2: visit day — mis-click «Пришёл», corrected straight to «Не пришёл» (visit itself says no_show)', async () => {
  const { s, id, visit } = await booked();
  syncVisitOutcomes(s.db, { now: localAt('2030-03-12', '09:55'), kekPath: s.kekPath });
  await calendarBook(s.db, { visit_id: visit.id, start: visit.visit_date, status: 'arrived' }, s.reg);
  await calendarBook(s.db, { visit_id: visit.id, start: visit.visit_date, status: 'no_show' }, s.reg);
  syncVisitOutcomes(s.db, { now: localAt('2030-03-12', '10:01'), kekPath: s.kekPath });
  const st = state(s, id, visit.id);
  console.log('V2', JSON.stringify(st));
  assert.equal(st.req, 'no_show');
  assert.equal(st.arrivedEvents, 0);
});

test('CRM_ONE_WAY_V1 (повтор 8a) — V3 (control): a tick DOES run while the wrong «Пришёл» stands — what does each tree say?', async () => {
  const { s, id, visit } = await booked();
  await calendarBook(s.db, { visit_id: visit.id, start: visit.visit_date, status: 'arrived' }, s.reg);
  syncVisitOutcomes(s.db, { now: localAt('2030-03-12', '10:00'), kekPath: s.kekPath });
  await calendarBook(s.db, { visit_id: visit.id, start: visit.visit_date, status: 'scheduled' }, s.reg);
  syncVisitOutcomes(s.db, { now: localAt('2030-03-13', '09:00'), kekPath: s.kekPath });
  console.log('V3', JSON.stringify(state(s, id, visit.id)));
});

test('CRM_ONE_WAY_V1 (повтор 8a) — V4: mis-click on the day BEFORE (calendar of tomorrow), reverted, no tick between; patient never comes', async () => {
  const { s, id, visit } = await booked();
  syncVisitOutcomes(s.db, { now: localAt('2030-03-11', '15:00'), kekPath: s.kekPath });
  await calendarBook(s.db, { visit_id: visit.id, start: visit.visit_date, status: 'arrived' }, s.reg);
  await calendarBook(s.db, { visit_id: visit.id, start: visit.visit_date, status: 'scheduled' }, s.reg);
  syncVisitOutcomes(s.db, { now: localAt('2030-03-11', '15:01'), kekPath: s.kekPath });
  const eve = state(s, id, visit.id);
  syncVisitOutcomes(s.db, { now: localAt('2030-03-12', '00:00'), kekPath: s.kekPath });
  const midnight = state(s, id, visit.id);
  syncVisitOutcomes(s.db, { now: localAt('2030-03-13', '09:00'), kekPath: s.kekPath });
  const next = state(s, id, visit.id);
  console.log('V4 eve', JSON.stringify(eve), '| 00:00', JSON.stringify(midnight), '| next', JSON.stringify(next));
  assert.equal(next.req, 'no_show');
});
