import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { setDataDir } from '../control/config.js';
import { licensedDataDir } from '../control/licensed-fixture.js';
import { pollOnce, recordCall, callList, nextDelayMs } from './poller.js';

const fresh = () => { const db = openDb(':memory:'); migrate(db); return db; };

// enabled + credentials, written straight to the row: saveSettings' own
// validation is settings.test.js's subject, not this file's.
function armed(db) {
  db.prepare("UPDATE telephony_settings SET enabled = 1, api_key = 'k', api_secret = 's' WHERE id = 1").run();
  return db;
}

// A Binotel stats answer: callDetails keyed by generalCallID, per the docs.
const statsAnswer = (calls) => ({
  ok: true, status: 200, body: null,
  text: async () => JSON.stringify({ status: 'success', callDetails: Object.fromEntries(calls.map((c) => [c.generalCallID, c])) }),
});
const CALL = {
  generalCallID: 'GC-100', startTime: 1755950400, callType: 0,
  internalNumber: '901', externalNumber: '+998909610004',
  waitsec: '5', billsec: '73', disposition: 'ANSWER', isNewCall: '1',
};

test('disabled: the tick asks nothing of the network', async () => {
  const db = fresh();
  let called = 0;
  await pollOnce(db, { fetchImpl: async () => { called++; throw new Error('must not be reached'); }, hasModule: () => true });
  assert.equal(called, 0);
  // And leaves no proof-of-life either: a disabled poller is silent, not "erroring".
  assert.equal(db.prepare('SELECT last_poll_at FROM telephony_settings').get().last_poll_at, null);
});

test('enabled but module not granted: skipped the same silent way', async () => {
  const db = armed(fresh());
  let called = 0;
  await pollOnce(db, { fetchImpl: async () => { called++; }, hasModule: () => false });
  assert.equal(called, 0);
});

test('the default module gate reads the real licence: granted polls, ungranted does not', async () => {
  // No hasModule injection here on purpose — this drives controlState over a
  // REAL signed licence (the fixture), proving the wrapper asks the licence
  // the right question, not just that injection works.
  const db = armed(fresh());
  setDataDir(licensedDataDir({ modules: ['callcenter'] }));
  let calls = 0;
  await pollOnce(db, { fetchImpl: async () => { calls++; return statsAnswer([]); } });
  assert.equal(calls, 2);   // incoming + outgoing

  setDataDir(licensedDataDir());   // same clinic, no modules granted
  await pollOnce(db, { fetchImpl: async () => { calls++; return statsAnswer([]); } });
  assert.equal(calls, 2);
});

test('a poll captures both directions, matches the patient, stamps proof-of-life', async () => {
  const db = armed(fresh());
  // Stored formatted, as registration writes it; Binotel sends digits — the
  // match must cross that formatting gap (crm-phone-match's whole point).
  const pid = db.prepare("INSERT INTO patients (full_name, phone) VALUES ('Иванов Иван', '+998 90 961 00 04')").run().lastInsertRowid;

  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, body: JSON.parse(init.body) });
    return url.includes('incoming') ? statsAnswer([CALL]) : statsAnswer([]);
  };
  await pollOnce(db, { fetchImpl, hasModule: () => true });

  assert.equal(seen.length, 2);
  assert.ok(seen[0].url.includes('all-incoming-calls-since.json'));
  assert.ok(seen[1].url.includes('all-outgoing-calls-since.json'));

  const row = db.prepare("SELECT * FROM calls WHERE general_call_id = 'GC-100'").get();
  assert.equal(row.source, 'poll');
  assert.equal(row.patient_id, pid);
  assert.equal(row.disposition, 'ANSWER');
  assert.equal(row.billsec, 73);
  assert.equal(row.started_at, new Date(CALL.startTime * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'));

  const s = db.prepare('SELECT last_poll_at, last_call_at, last_error FROM telephony_settings').get();
  assert.ok(s.last_poll_at);
  assert.equal(s.last_call_at, row.started_at);
  assert.equal(s.last_error, '');
});

test('the cursor is MAX(started_at) minus the 120s overlap; first poll looks back a day', async () => {
  const db = armed(fresh());
  const timestamps = [];
  const fetchImpl = async (_url, init) => { timestamps.push(JSON.parse(init.body).timestamp); return statsAnswer([]); };

  const before = Math.floor(Date.now() / 1000) - 24 * 60 * 60;
  await pollOnce(db, { fetchImpl, hasModule: () => true });
  const after = Math.floor(Date.now() / 1000) - 24 * 60 * 60;
  assert.ok(timestamps[0] >= before && timestamps[0] <= after, 'first poll = now minus one day');

  db.prepare("INSERT INTO calls (general_call_id, started_at) VALUES ('GC-1', '2026-08-23T10:00:00Z')").run();
  timestamps.length = 0;
  await pollOnce(db, { fetchImpl, hasModule: () => true });
  const maxUnix = Math.floor(Date.parse('2026-08-23T10:00:00Z') / 1000);
  assert.deepEqual(timestamps, [maxUnix - 120, maxUnix - 120]);
});

test('re-polling the overlap window cannot duplicate a call', async () => {
  const db = armed(fresh());
  const fetchImpl = async (url) => (url.includes('incoming') ? statsAnswer([CALL]) : statsAnswer([]));
  await pollOnce(db, { fetchImpl, hasModule: () => true });
  await pollOnce(db, { fetchImpl, hasModule: () => true });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM calls').get().n, 1);
});

test('an unreachable Binotel becomes last_error, never a throw', async () => {
  const db = armed(fresh());
  await pollOnce(db, { fetchImpl: async () => { throw new Error('ENOTFOUND api.binotel.com'); }, hasModule: () => true });
  const s = db.prepare('SELECT last_poll_at, last_error FROM telephony_settings').get();
  assert.equal(s.last_error, 'offline');
  assert.ok(s.last_poll_at, 'the attempt itself is still proof the loop is alive');
});

test('recordCall skips what it cannot file and coerces what it can', () => {
  const db = fresh();
  assert.equal(recordCall(db, null, 'poll'), false);
  assert.equal(recordCall(db, { startTime: 1755950400 }, 'poll'), false);          // no generalCallID
  assert.equal(recordCall(db, { generalCallID: 'x', startTime: 'soon' }, 'poll'), false); // unusable time
  // Numeric fields arrive as strings from Binotel; '' means "not reported".
  assert.equal(recordCall(db, { generalCallID: 'GC-2', startTime: 1755950400, waitsec: '', billsec: '7' }, 'webhook'), true);
  const row = db.prepare("SELECT * FROM calls WHERE general_call_id = 'GC-2'").get();
  assert.equal(row.waitsec, null);
  assert.equal(row.billsec, 7);
  assert.equal(row.source, 'webhook');
});

test('callList accepts the documented object shape and the defensive array one', () => {
  assert.deepEqual(callList({ callDetails: { a: { generalCallID: '1' } } }), [{ generalCallID: '1' }]);
  assert.deepEqual(callList({ callDetails: [{ generalCallID: '2' }, null] }), [{ generalCallID: '2' }]);
  assert.deepEqual(callList({}), []);
  assert.deepEqual(callList(null), []);
});

test('nextDelayMs: the configured pace when enabled, a slow idle breath when not', () => {
  const db = fresh();
  assert.equal(nextDelayMs(db), 30_000);   // disabled → idle recheck
  armed(db);
  db.prepare('UPDATE telephony_settings SET poll_interval_sec = 45').run();
  assert.equal(nextDelayMs(db), 45_000);
});
