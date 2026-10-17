// CRM_ONE_WAY_V1 (2026-10-17) — повтор ревью «8a/zz-s8y-donesticky.test.js» (scratchpad crm-link-review), перенесён в клон
// настоящим тестом с ожиданиями одного направления (docs/plans/2026-10-17-crm-one-way.md, задача 6,
// таблица повторов). Изменённые ожидания помечены CRM_ONE_WAY_V1 и правилом O; устаревшие тесты убраны
// с причиной в плане.
// zz-s8y — f0a22da5: 'done' CRM lines count as arrival on the visit day; is the mark sticky after a corrected «Пришёл»?
import test from 'node:test';
import assert from 'node:assert/strict';
import { bookingSeed, localAt, apptItem } from '../../test-helpers/api-booking-seed.js';
import { ingestItem, confirmBooking } from './bookings.js';
import { syncVisitOutcomes } from './visit-events.js';
import { calendarBook } from '../rpc/calendar.js';

const NOW = localAt('2030-03-11', '09:00');
const START = localAt('2030-03-12', '10:00');
const one = (db, sql, ...a) => db.prepare(sql).get(...a);

test('CRM_ONE_WAY_V1 (повтор 8a) — S8Y-D: «Пришёл» clicked by mistake and corrected back to «Записан» (no tick in between); patient never comes — partner answer', async () => {
  const s = bookingSeed();
  s.db.prepare('UPDATE api_connections SET webhook_events = ? WHERE id = ?').run(JSON.stringify(['booking.confirmed', 'appointment.arrived']), s.connId);
  const r = await ingestItem(s.db, apptItem({ connId: s.connId, startMs: START, receivedMs: NOW }), { now: NOW, kekPath: s.kekPath });
  s.db.prepare("INSERT INTO patients (id, mrn, full_name, phone) VALUES (1, 'P-1', 'Абдурахмонов Фаррух', '+998901234567')").run();
  const c = await confirmBooking(s.db, { id: r.id, patientId: 1 }, s.reg, { now: NOW, kekPath: s.kekPath });
  const visit = c.visit;
  await calendarBook(s.db, { visit_id: visit.id, start: visit.visit_date, status: 'arrived' }, s.reg);
  await calendarBook(s.db, { visit_id: visit.id, start: visit.visit_date, status: 'scheduled' }, s.reg);
  console.log('visit', one(s.db, 'SELECT status FROM visits WHERE id = ?', visit.id).status, 'lines', JSON.stringify(s.db.prepare('SELECT status FROM crm_request_services WHERE visit_id = ?').all(visit.id)));
  syncVisitOutcomes(s.db, { now: localAt('2030-03-12', '08:00'), kekPath: s.kekPath });
  const atDay = one(s.db, 'SELECT status FROM api_requests WHERE id = ?', r.id).status;
  syncVisitOutcomes(s.db, { now: localAt('2030-03-13', '09:00'), kekPath: s.kekPath });
  const next = one(s.db, 'SELECT status FROM api_requests WHERE id = ?', r.id).status;
  console.log('visit day 08:00 →', atDay, '; next morning →', next, '; arrived events', one(s.db, "SELECT COUNT(*) n FROM api_outbox WHERE event = 'appointment.arrived'").n);
  assert.equal(next, 'no_show');
});
