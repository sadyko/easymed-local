// CRM_ONE_WAY_V1 (2026-10-17) — повтор ревью «8a/zz-s8z-verify-api-flow-0-0.test.js» (scratchpad crm-link-review), перенесён в клон
// настоящим тестом с ожиданиями одного направления (docs/plans/2026-10-17-crm-one-way.md, задача 6,
// таблица повторов). Изменённые ожидания помечены CRM_ONE_WAY_V1 и правилом O; устаревшие тесты убраны
// с причиной в плане.
// Skeptic #1 verification of finding api-flow-0: own-line move (5b2ef1f3) loses
// its line after the card window's "Сохранить" (saveLines full replace) or after
// a «Дубликаты» merge. The card save goes through the /api/db door logic
// (compile + mirrorBefore + run + mirrorAfter), not raw SQL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bookingSeed, localAt, apptItem } from '../../test-helpers/api-booking-seed.js';
import { ingestItem, confirmBooking, offerOtherTime } from './bookings.js';
import { compile } from '../../db/query-compiler.js';
import { mirrorBefore, mirrorAfter } from '../crm/booking-mirror-db.js';
import { crmMergeLeads } from '../rpc/crm-merge.js';

const NOW = localAt('2030-03-11', '09:00');
const START = localAt('2030-03-12', '10:00');
const D2 = localAt('2030-03-14', '11:00');

// /api/db door, in-process (no port).
function door(db, body, user) {
  const c = compile(body, user, { db });
  const m = mirrorBefore(db, c.meta, body, user);
  if (m.refusal) throw new Error('refused: ' + m.refusal);
  if (c.meta.op === 'insert' && c.meta.multi) {
    db.transaction(() => { for (const st of c.statements) db.prepare(st.sql).run(...st.params); })();
    mirrorAfter(db, m, c.meta, body, user);
    return;
  }
  const info = db.prepare(c.sql).run(...c.params);
  mirrorAfter(db, m, c.meta, body, user, c.meta.op === 'insert' ? { insertedId: Number(info.lastInsertRowid) } : {});
}

// crm.js saveLines (2427-2501) for a card with only plain (visit-less) lines.
function cardWindowSave(db, cardId, user) {
  const picked = db.prepare("SELECT service_id, consultation_type_id, doctor_id, scheduled_date FROM crm_request_services WHERE request_id = ? AND status = 'pending' AND visit_id IS NULL").all(cardId);
  door(db, { table: 'crm_request_services', op: 'update', values: { status: 'cancelled' },
    filters: [{ col: 'request_id', op: 'eq', val: cardId }, { col: 'status', op: 'eq', val: 'pending' }, { col: 'visit_id', op: 'is', val: null }] }, user);
  door(db, { table: 'crm_request_services', op: 'insert', values: picked.map((p) => ({
    request_id: cardId, service_id: p.service_id, ...(p.consultation_type_id ? { consultation_type_id: p.consultation_type_id } : {}),
    scheduled_date: p.scheduled_date || null, doctor_id: p.doctor_id || null, status: 'pending' })) }, user);
}

async function offerAcceptConfirm(s, id) {
  offerOtherTime(s.db, { id, start: new Date(D2).toISOString() }, s.reg, { now: NOW + 60000, kekPath: s.kekPath });
  const acc = await ingestItem(s.db, { type: 'offer.accept', cursor: '9', public_id: 'rq_test0001', connection_id: s.connId }, { now: NOW + 5 * 60000, kekPath: s.kekPath });
  assert.equal(acc.status, 'pending');
  return confirmBooking(s.db, { id, patientId: 1 }, s.reg, { now: NOW + 6 * 60000, kekPath: s.kekPath });
}
const vlines = (db, vid) => db.prepare("SELECT consultation_type_id, unit_price FROM visit_services WHERE visit_id = ? AND status <> 'cancelled'").all(vid).map((x) => ({ ...x }));

test('CRM_ONE_WAY_V1 (повтор 8a) — V1 card window save, then other day accepted + confirmed: consultation in the 03-14 visit', async () => {
  const s = bookingSeed();
  s.db.prepare("INSERT INTO patients (id, mrn, full_name, phone) VALUES (1, 'P-1', 'Абдурахмонов Фаррух', '+998901234567')").run();
  const r = await ingestItem(s.db, apptItem({ connId: s.connId, startMs: START, receivedMs: NOW - 60000 }), { now: NOW, kekPath: s.kekPath });
  assert.equal(r.status, 'pending');
  const cardId = s.db.prepare('SELECT crm_request_id AS c FROM api_requests WHERE id = ?').get(r.id).c;
  console.log('lines before save', s.db.prepare('SELECT id, status, scheduled_date, consultation_type_id, doctor_id FROM crm_request_services WHERE request_id = ?').all(cardId).map((x) => ({ ...x })));
  cardWindowSave(s.db, cardId, s.reg);
  console.log('lines after save', s.db.prepare('SELECT id, status, scheduled_date, consultation_type_id, doctor_id FROM crm_request_services WHERE request_id = ?').all(cardId).map((x) => ({ ...x })));
  const c = await offerAcceptConfirm(s, r.id);
  const left = s.db.prepare("SELECT id, scheduled_date, visit_id FROM crm_request_services WHERE request_id = ? AND status = 'pending'").all(cardId).map((x) => ({ ...x }));
  console.log('confirmed visit', c.visit.visit_date, 'lines', vlines(s.db, c.visit.id), 'pending card lines', left);
  assert.deepEqual(vlines(s.db, c.visit.id), [{ consultation_type_id: 1, unit_price: 150000 }]);
});

test('CRM_ONE_WAY_V1 (повтор 8a) — V2 same, then a 03-12 walk-in visit of that patient picks up the online consultation', async () => {
  const { ensureVisit } = await import('../rpc/visits.js');
  const s = bookingSeed();
  s.db.prepare("INSERT INTO patients (id, mrn, full_name, phone) VALUES (1, 'P-1', 'Абдурахмонов Фаррух', '+998901234567')").run();
  const r = await ingestItem(s.db, apptItem({ connId: s.connId, startMs: START, receivedMs: NOW - 60000 }), { now: NOW, kekPath: s.kekPath });
  const cardId = s.db.prepare('SELECT crm_request_id AS c FROM api_requests WHERE id = ?').get(r.id).c;
  cardWindowSave(s.db, cardId, s.reg);
  const c = await offerAcceptConfirm(s, r.id);
  const lab = await ensureVisit(s.db, { patient_id: 1, date: '2030-03-12' }, s.reg);
  console.log('03-12 visit lines', vlines(s.db, lab.visit.id), '03-14 visit lines', vlines(s.db, c.visit.id));
  assert.deepEqual(vlines(s.db, lab.visit.id), []);
});

for (const keepOnline of [false, true]) {
  test(`CRM_ONE_WAY_V1 (повтор 8a) — V3 merge (keep ${keepOnline ? 'online' : 'call'} card), other day accepted + confirmed: consultation in the 03-14 visit`, async () => {
    const s = bookingSeed();
    s.db.prepare("INSERT INTO patients (id, mrn, full_name, phone) VALUES (1, 'P-1', 'Абдурахмонов Фаррух', '+998901234567')").run();
    const cc = Number(s.db.prepare("INSERT INTO crm_requests (full_name, phone, source, status, scheduled_date) VALUES ('Абдурахмонов Фаррух', '+998901234567', 'call', 'in_process', '2030-03-12')").run().lastInsertRowid);
    s.db.prepare("INSERT INTO crm_request_services (request_id, consultation_type_id, doctor_id, scheduled_date, status) VALUES (?, 1, 7, '2030-03-12', 'pending')").run(cc);
    const r = await ingestItem(s.db, apptItem({ connId: s.connId, startMs: START, receivedMs: NOW - 60000 }), { now: NOW, kekPath: s.kekPath });
    assert.equal(r.status, 'pending');
    const onlineCard = s.db.prepare('SELECT crm_request_id AS c FROM api_requests WHERE id = ?').get(r.id).c;
    crmMergeLeads(s.db, keepOnline ? { keep_id: onlineCard, merge_ids: [cc] } : { keep_id: cc, merge_ids: [onlineCard] }, s.admin);
    const card = s.db.prepare('SELECT crm_request_id AS c FROM api_requests WHERE id = ?').get(r.id).c;
    console.log('merged card lines', s.db.prepare('SELECT id, status, scheduled_date FROM crm_request_services WHERE request_id = ?').all(card).map((x) => ({ ...x })));
    const c = await offerAcceptConfirm(s, r.id);
    const left = s.db.prepare("SELECT id, scheduled_date, visit_id FROM crm_request_services WHERE request_id = ? AND status = 'pending'").all(card).map((x) => ({ ...x }));
    console.log('confirmed visit', c.visit.visit_date, 'lines', vlines(s.db, c.visit.id), 'pending card lines', left);
    assert.deepEqual(vlines(s.db, c.visit.id), [{ consultation_type_id: 1, unit_price: 150000 }]);
  });
}

test('CRM_ONE_WAY_V1 (повтор 8a) — V0 control: no save, no merge -> consultation follows to 03-14', async () => {
  const s = bookingSeed();
  s.db.prepare("INSERT INTO patients (id, mrn, full_name, phone) VALUES (1, 'P-1', 'Абдурахмонов Фаррух', '+998901234567')").run();
  const r = await ingestItem(s.db, apptItem({ connId: s.connId, startMs: START, receivedMs: NOW - 60000 }), { now: NOW, kekPath: s.kekPath });
  const c = await offerAcceptConfirm(s, r.id);
  assert.deepEqual(vlines(s.db, c.visit.id), [{ consultation_type_id: 1, unit_price: 150000 }]);
});
