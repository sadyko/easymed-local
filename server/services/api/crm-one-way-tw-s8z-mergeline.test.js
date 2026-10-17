// CRM_ONE_WAY_V1 (2026-10-17) — повтор ревью «8a/zz-s8z-mergeline.test.js» (scratchpad crm-link-review), перенесён в клон
// настоящим тестом с ожиданиями одного направления (docs/plans/2026-10-17-crm-one-way.md, задача 6,
// таблица повторов). Изменённые ожидания помечены CRM_ONE_WAY_V1 и правилом O; устаревшие тесты убраны
// с причиной в плане.
// Repro: own-line move (5b2ef1f3) after a merge whose dedupe cancelled the
// online booking's own line (crm_line_id -> cancelled row).
import test from 'node:test';
import assert from 'node:assert/strict';
import { bookingSeed, localAt, apptItem } from '../../test-helpers/api-booking-seed.js';
import { ingestItem, confirmBooking, offerOtherTime } from './bookings.js';
import { crmMergeLeads } from '../rpc/crm-merge.js';

const NOW = localAt('2030-03-11', '09:00');
const START = localAt('2030-03-12', '10:00');
const D2 = localAt('2030-03-14', '11:00');
const one = (db, sql, ...a) => db.prepare(sql).get(...a);

for (const keepOnline of [false, true]) {
  test(`CRM_ONE_WAY_V1 (повтор 8a) — merge (keep ${keepOnline ? 'online' : 'call'} card) dedupe cancels online line; offer other day; accept; confirm -> consultation in visit`, async () => {
    const s = bookingSeed();
    s.db.prepare("INSERT INTO patients (id, mrn, full_name, phone) VALUES (1, 'P-1', 'Абдурахмонов Фаррух', '+998901234567')").run();
    // Call-centre card first (lower line id): same consultation, same doctor, same day.
    const cc = Number(s.db.prepare("INSERT INTO crm_requests (full_name, phone, source, status, scheduled_date) VALUES ('Абдурахмонов Фаррух', '+998901234567', 'call', 'in_process', '2030-03-12')").run().lastInsertRowid);
    s.db.prepare("INSERT INTO crm_request_services (request_id, consultation_type_id, doctor_id, scheduled_date, status) VALUES (?, 1, 7, '2030-03-12', 'pending')").run(cc);
    const r = await ingestItem(s.db, apptItem({ connId: s.connId, startMs: START, receivedMs: NOW - 60000 }), { now: NOW, kekPath: s.kekPath });
    assert.equal(r.status, 'pending');
    const online = one(s.db, 'SELECT crm_request_id AS c, NULL AS l FROM api_requests WHERE id = ?', r.id);
    crmMergeLeads(s.db, keepOnline ? { keep_id: online.c, merge_ids: [cc] } : { keep_id: cc, merge_ids: [online.c] }, s.admin);
    const after = one(s.db, 'SELECT crm_request_id AS c, NULL AS l FROM api_requests WHERE id = ?', r.id);
    console.log('own line after merge:', after.l == null ? null : { ...one(s.db, 'SELECT id, status, scheduled_date FROM crm_request_services WHERE id = ?', after.l) });
    console.log('card lines after merge:', s.db.prepare('SELECT id, status, scheduled_date, consultation_type_id FROM crm_request_services WHERE request_id = ?').all(after.c).map((x) => ({ ...x })));
    offerOtherTime(s.db, { id: r.id, start: new Date(D2).toISOString() }, s.reg, { now: NOW + 60000, kekPath: s.kekPath });
    const acc = await ingestItem(s.db, { type: 'offer.accept', cursor: '9', public_id: 'rq_test0001', connection_id: s.connId }, { now: NOW + 5 * 60000, kekPath: s.kekPath });
    assert.equal(acc.status, 'pending');
    const c = await confirmBooking(s.db, { id: r.id, patientId: 1 }, s.reg, { now: NOW + 6 * 60000, kekPath: s.kekPath });
    const vlines = s.db.prepare("SELECT consultation_type_id, unit_price FROM visit_services WHERE visit_id = ? AND status <> 'cancelled'").all(c.visit.id).map((x) => ({ ...x }));
    const left = s.db.prepare("SELECT id, status, scheduled_date, visit_id FROM crm_request_services WHERE request_id = ? AND status = 'pending'").all(after.c).map((x) => ({ ...x }));
    console.log('visit day', c.visit.visit_date, 'lines', vlines, 'pending card lines', left);
    assert.deepEqual(vlines, [{ consultation_type_id: 1, unit_price: 150000 }], 'the confirmed 03-14 visit carries the booked consultation');
  });
}
