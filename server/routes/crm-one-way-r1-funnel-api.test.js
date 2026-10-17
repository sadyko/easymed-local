// CRM_ONE_WAY_V1 (2026-10-17) — повтор ревью «r1/zz-funnel-api.test.js» (scratchpad crm-link-review), перенесён в клон
// настоящим тестом с ожиданиями одного направления (docs/plans/2026-10-17-crm-one-way.md, задача 6,
// таблица повторов). Изменённые ожидания помечены CRM_ONE_WAY_V1 и правилом O; устаревшие тесты убраны
// с причиной в плане.
// ADVERSARIAL REVIEW (privacy lens) — C′ links ANY booking of the patient to a stale live card; if that card is a
// partner's callback card (public API), the partner is told about the clinic's booking and may cancel it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bookingSeed, localAt, apptItem } from '../test-helpers/api-booking-seed.js';
import { ingestItem } from '../services/api/bookings.js';
import { syncVisitOutcomes } from '../services/api/visit-events.js';
import { calendarBook } from '../services/rpc/calendar.js';

const NOW = localAt('2030-03-11', '09:00');
const one = (db, sql, ...a) => db.prepare(sql).get(...a);

test('CRM_ONE_WAY_V1 (повтор r1) — API-1: partner callback card (patient linked, >72h old) — a DOCTOR\'s own follow-up booking must not be reported to / cancellable by the partner', async () => {
  const s = bookingSeed();
  const r = await ingestItem(s.db, { ...apptItem({ connId: s.connId, publicId: 'rq_call0001', startMs: NOW, receivedMs: NOW }), type: 'request.new',
    data: { external_id: 'cb-1', service_id: 301 } }, { now: NOW });
  const card = one(s.db, 'SELECT crm_request_id AS c FROM api_requests WHERE id = ?', r.id).c;
  s.db.prepare("INSERT INTO patients (id, mrn, full_name, phone) VALUES (1, 'P-1', 'Абдурахмонов Фаррух', '+998901234567')").run();
  // operator linked the callback card to the patient; nothing booked; card stale (5 days, real clock)
  const old = new Date(Date.now() - 5 * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  s.db.prepare('UPDATE crm_requests SET patient_id = 1, updated_at = ?, created_at = ? WHERE id = ?').run(old, old, card);
  console.log('API-1 card before', JSON.stringify(one(s.db, 'SELECT id, status, scheduled_date FROM crm_requests WHERE id = ?', card)),
    JSON.stringify(s.db.prepare('SELECT service_id, scheduled_date, status FROM crm_request_services WHERE request_id = ?').all(card)));
  // the doctor books his own follow-up (УЗИ) for a later day — nothing to do with the partner's callback
  const doctor = { id: 7, role: 'doctor', extra_roles: [] };
  const b = await calendarBook(s.db, { patient_id: 1, doctor_id: 7, service_id: 302, start: new Date(localAt('2030-03-20', '11:00')).toISOString(), duration_minutes: 20, status: 'scheduled' }, doctor);
  const vid = b.visit.id;
  console.log('API-1 link', JSON.stringify(one(s.db, 'SELECT * FROM crm_booking_links WHERE visit_id = ?', vid)),
    'card after', JSON.stringify(one(s.db, 'SELECT id, status, scheduled_date FROM crm_requests WHERE id = ?', card)));
  syncVisitOutcomes(s.db, { now: NOW, kekPath: s.kekPath });
  const row = one(s.db, 'SELECT status, visit_id, doctor_id FROM api_requests WHERE id = ?', r.id);
  const out = s.db.prepare('SELECT event, body FROM api_outbox ORDER BY id').all().map((x) => x.event);
  console.log('API-1 api_request', JSON.stringify(row), 'outbox', JSON.stringify(out));
  // partner (patient at the aggregator) cancels "their" appointment
  const c = await ingestItem(s.db, { type: 'appointment.cancel', cursor: '9', public_id: 'rq_call0001', connection_id: s.connId }, { now: NOW + 60000, kekPath: s.kekPath });
  console.log('API-1 partner cancel', JSON.stringify(c), 'doctor visit status', one(s.db, 'SELECT status FROM visits WHERE id = ?', vid).status);
  assert.notEqual(row.visit_id, vid, 'the partner\'s callback request got bound to the doctor\'s own follow-up visit');
  assert.equal(one(s.db, 'SELECT status FROM visits WHERE id = ?', vid).status, 'scheduled', 'the partner cancelled the doctor\'s booking');
});
