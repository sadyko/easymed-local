// CRM_CONFIG_V1 — «звонок становится карточкой».
//
// Two failures this file exists to prevent, both of which would be reported as
// "the telephony integration is broken":
//   1. a missed call that never becomes a card — the most expensive call a
//      clinic gets, silently lost;
//   2. a patient who calls four times before lunch turning into four cards to
//      work through, which is how an operator stops trusting the board.
// Everything else here is the routing table being obeyed rather than guessed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { recordCall } from '../telephony/poller.js';
import { leadFromCall, openLeadForPhone } from './lead-from-call.js';
import { saveRouting, saveStages, listStages } from './config.js';

const fresh = () => { const db = openDb(':memory:'); migrate(db); return db; };

// A Binotel call as the poller/webhook hands it to recordCall.
const CALL = {
  generalCallID: 'GC-1', startTime: 1755950400, callType: 0,
  internalNumber: '901', externalNumber: '+998909610004',
  waitsec: '5', billsec: '73', disposition: 'ANSWER', isNewCall: '1',
};
const call = (over = {}) => ({ ...CALL, ...over });

const leads = (db) => db.prepare(`SELECT id, full_name, phone, source, status, patient_id, call_id
                                    FROM crm_requests ORDER BY id`).all();

// --------------------------------------------------------------------------
// The happy paths — the routing table, obeyed
// --------------------------------------------------------------------------

test('an answered call becomes a lead in the first open column, sourced «telephony»', () => {
  const db = fresh();
  assert.equal(recordCall(db, call(), 'poll'), true);
  const rows = leads(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'in_process');
  assert.equal(rows[0].source, 'telephony');
  assert.equal(rows[0].phone, '+998909610004');
  // Unknown caller: the number IS the name, because it is the only thing the
  // operator has, and unlike a name it is never empty.
  assert.equal(rows[0].full_name, '+998909610004');
  // Linked to the call it came from — that is what lets the card say
  // «звонок в 14:32».
  const callId = db.prepare("SELECT id FROM calls WHERE general_call_id = 'GC-1'").get().id;
  assert.equal(rows[0].call_id, callId);
});

test('a known patient gets their real name and their card on the lead', () => {
  const db = fresh();
  // Formatted in the database, bare from Binotel — the same mismatch the CRM
  // phone matcher exists for.
  const pid = db.prepare("INSERT INTO patients (full_name, phone) VALUES ('Иванов Иван', '+998 90 961 00 04')").run().lastInsertRowid;
  recordCall(db, call({ externalNumber: '998909610004' }), 'poll');
  const row = leads(db)[0];
  assert.equal(row.full_name, 'Иванов Иван');
  assert.equal(row.patient_id, pid);
});

test('a missed call lands in «Перезвонить», not in the general pile', () => {
  const db = fresh();
  for (const [i, d] of ['NOANSWER', 'BUSY', 'CANCEL'].entries()) {
    recordCall(db, call({ generalCallID: 'GC-M' + i, externalNumber: '99890000000' + i, disposition: d }), 'poll');
  }
  assert.deepEqual(leads(db).map((r) => r.status), ['recall', 'recall', 'recall']);
});

test('a TRANSFER is a conversation too', () => {
  const db = fresh();
  recordCall(db, call({ disposition: 'TRANSFER' }), 'poll');
  assert.equal(leads(db)[0].status, 'in_process');
});

// --------------------------------------------------------------------------
// The «ignore» half of the table
// --------------------------------------------------------------------------

test('line states and messages are not leads', () => {
  const db = fresh();
  const quiet = ['ONLINE', 'CONGESTION', 'CHANUNAVAIL', 'VM', 'VM-SUCCESS',
                 'SMS-SENDING', 'SMS-SUCCESS', 'SMS-FAILED', 'SUCCESS', 'FAILED'];
  quiet.forEach((d, i) => {
    assert.equal(recordCall(db, call({ generalCallID: 'GC-Q' + i, externalNumber: '99890111000' + i, disposition: d }), 'poll'), true);
  });
  // Every call was still FILED — the call log is the record; only the lead
  // was withheld.
  assert.equal(db.prepare('SELECT COUNT(*) n FROM calls').get().n, quiet.length);
  assert.equal(leads(db).length, 0);
});

test('a disposition the vendor invented later creates nothing until it is configured', () => {
  const db = fresh();
  recordCall(db, call({ disposition: 'ROBO-SCREENED' }), 'poll');
  // Silence rather than a guess: inventing leads out of an unknown vocabulary
  // is how a board fills with cards nobody asked for.
  assert.equal(leads(db).length, 0);

  saveRouting(db, [{ disposition: 'ROBO-SCREENED', action: 'create', stage_key: 'recall' }]);
  recordCall(db, call({ generalCallID: 'GC-2', disposition: 'ROBO-SCREENED' }), 'poll');
  assert.deepEqual(leads(db).map((r) => r.status), ['recall']);
});

test('a call with no external number is filed but produces no lead', () => {
  const db = fresh();
  recordCall(db, call({ externalNumber: '' }), 'poll');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM calls').get().n, 1);
  // Nothing to call back and nothing to de-duplicate on.
  assert.equal(leads(db).length, 0);
});

test('the owner turning a rule off stops the cards', () => {
  const db = fresh();
  saveRouting(db, [{ disposition: 'ANSWER', action: 'ignore' }]);
  recordCall(db, call(), 'poll');
  assert.equal(leads(db).length, 0);
});

test('the owner re-pointing a rule moves where the cards land', () => {
  const db = fresh();
  saveRouting(db, [{ disposition: 'ANSWER', action: 'create', stage_key: 'scheduled' }]);
  recordCall(db, call(), 'poll');
  assert.equal(leads(db)[0].status, 'scheduled');
});

test('a hand-edited rule aiming at a hidden column creates nothing', () => {
  const db = fresh();
  // saveStages already switches such rules off, so this is the belt: the
  // database is patched directly to reach the state it protects against.
  db.prepare("UPDATE crm_stages SET is_active = 0 WHERE key = 'in_process'").run();
  recordCall(db, call(), 'poll');
  // A lead in a column nobody can see reads exactly like a lost lead.
  assert.equal(leads(db).length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM calls').get().n, 1);
});

// --------------------------------------------------------------------------
// De-duplication — the chatty patient
// --------------------------------------------------------------------------

test('a patient who calls three times gets ONE card', () => {
  const db = fresh();
  for (let i = 0; i < 3; i++) {
    recordCall(db, call({ generalCallID: 'GC-C' + i, startTime: CALL.startTime + i * 60 }), 'poll');
  }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM calls').get().n, 3);
  assert.equal(leads(db).length, 1);
});

test('de-duplication compares digits, not formatting', () => {
  const db = fresh();
  db.prepare("INSERT INTO crm_requests (full_name, phone, source, status) VALUES ('Иванов','+998 90 961 00 04','call','in_process')").run();
  recordCall(db, call({ externalNumber: '998909610004' }), 'poll');
  // Formatted in the board, bare from Binotel — one number, one card.
  assert.equal(leads(db).length, 1);
  // And the local form is the same number too («90 961 00 04»).
  assert.ok(openLeadForPhone(db, '909610004'.padStart(9, '9')));
});

test('an operator already working the lead by hand blocks the call from adding a second', () => {
  const db = fresh();
  db.prepare("INSERT INTO crm_requests (full_name, phone, source, status) VALUES ('Записан вручную','998909610004','instagram','scheduled')").run();
  recordCall(db, call(), 'poll');
  const rows = leads(db);
  assert.equal(rows.length, 1);
  // Untouched: the existing card keeps its source and its column.
  assert.equal(rows[0].source, 'instagram');
  assert.equal(rows[0].status, 'scheduled');
});

test('a CLOSED lead does not block a new one — the patient is calling again', () => {
  const db = fresh();
  for (const status of ['came', 'no_show', 'stopped', 'not_qualified']) {
    const db2 = fresh();
    db2.prepare("INSERT INTO crm_requests (full_name, phone, source, status) VALUES ('Прошлый','998909610004','call',?)").run(status);
    recordCall(db2, call(), 'poll');
    // Only OPEN columns de-duplicate: somebody who came last month and rings
    // again is a new conversation, not a duplicate of an old one.
    assert.equal(leads(db2).length, 2, `status ${status}`);
  }
});

test('a column that gets hidden still de-duplicates its leads', () => {
  const db = fresh();
  db.prepare("INSERT INTO crm_requests (full_name, phone, source, status) VALUES ('В работе','998909610004','call','scheduled')").run();
  const next = listStages(db).map((s) => ({ ...s }));
  next.find((s) => s.key === 'scheduled').is_active = false;
  saveStages(db, next);
  recordCall(db, call(), 'poll');
  // Hidden is not closed: the card is still open work, and a second one for
  // the same person would be a duplicate the operator cannot even see.
  assert.equal(leads(db).length, 1);
});

// --------------------------------------------------------------------------
// Both delivery paths, one lead
// --------------------------------------------------------------------------

test('poll and webhook delivering the same call produce ONE lead', () => {
  const db = fresh();
  assert.equal(recordCall(db, call(), 'poll'), true);
  // The second delivery hits ON CONFLICT DO NOTHING and changes nothing — the
  // same constraint that de-duplicates the call also de-duplicates the lead.
  assert.equal(recordCall(db, call(), 'webhook'), false);
  assert.equal(leads(db).length, 1);
});

test('a call arriving only by webhook still becomes a lead', () => {
  const db = fresh();
  // recordCall is the shared writer both paths go through, so the routing
  // lives in exactly one place and cannot differ between them.
  recordCall(db, call({ generalCallID: 'GC-W', disposition: 'NOANSWER' }), 'webhook');
  assert.deepEqual(leads(db).map((r) => r.status), ['recall']);
});

test('a broken routing table never costs the clinic the call', () => {
  const db = fresh();
  // Sabotage the table the way only a hand edit or a half-applied migration
  // could: the lead cannot be filed, but the call must be.
  db.exec('DROP TABLE crm_call_routing');
  assert.equal(recordCall(db, call(), 'poll'), true);
  assert.equal(db.prepare("SELECT disposition FROM calls WHERE general_call_id = 'GC-1'").get().disposition, 'ANSWER');
});

// --------------------------------------------------------------------------
// leadFromCall called directly
// --------------------------------------------------------------------------

test('leadFromCall ignores a call row it cannot identify', () => {
  const db = fresh();
  assert.equal(leadFromCall(db, null), null);
  assert.equal(leadFromCall(db, { id: 0, disposition: 'ANSWER', external_number: '998909610004' }), null);
  assert.equal(leadFromCall(db, { id: 1, disposition: '', external_number: '998909610004' }), null);
  assert.equal(leads(db).length, 0);
});

test('leadFromCall keys the rule by the PBX the clinic actually runs', () => {
  const db = fresh();
  db.prepare("UPDATE telephony_settings SET provider = 'other_pbx' WHERE id = 1").run();
  recordCall(db, call(), 'poll');
  // The seeded rules belong to 'binotel'; another vendor's ANSWER may mean
  // something else entirely, so it is not assumed.
  assert.equal(leads(db).length, 0);

  saveRouting(db, [{ provider: 'other_pbx', disposition: 'ANSWER', action: 'create', stage_key: 'in_process' }]);
  recordCall(db, call({ generalCallID: 'GC-3' }), 'poll');
  assert.equal(leads(db).length, 1);
});
