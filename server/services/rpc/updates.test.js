import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { setDataDir, setAppVersion } from '../control/config.js';
import { updateStatus, updateApprove, updateCancel, updateCheckNow, RpcError } from './updates.js';

const admin = { id: 1, role: 'admin' };
const registrar = { id: 2, role: 'registrar' };
// ADMIN_DOCTOR_V1-class user: primary role is doctor, admin is an EXTRA role.
// A `user.role === 'admin'` check would lock this exact account out.
const doctorAdmin = { id: 3, role: 'doctor', extra_roles: ['admin'] };

function freshDb() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

function put(db, key, value) {
  db.prepare(`INSERT INTO control_state (key, value, updated_at)
              VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(key, String(value));
}
function get(db, key) {
  return db.prepare('SELECT value FROM control_state WHERE key = ?').get(key)?.value ?? null;
}
function storeOffer(db, offer) { put(db, 'update_offer', JSON.stringify(offer)); }

const OFFER = { version: '2.4.0', notes_ru: 'Тест', url: '/x.tar.gz', sha256: 'abc', manifest: { payload: {}, sig: 's' } };

test.beforeEach(() => {
  setDataDir(fs.mkdtempSync(path.join(os.tmpdir(), 'em-updates-rpc-')));
  // UPDATE_DELIVERY_V1 (Task 6) — a fixed test version, independent of this
  // checkout's real package.json, same DI-via-config.js seam setDataDir uses.
  setAppVersion('2.3.0');
});

// --- update_status ---------------------------------------------------------

test('update_status: nothing offered, nothing approved — every field is empty/false', () => {
  const db = freshDb();
  const s = updateStatus(db, {}, admin);
  assert.deepEqual(s, { current_version: '2.3.0', offer: null, approved: false, hour: null, scheduled_at: null, last_result: null });
});

test('update_status: current_version reflects the running app, independent of any offer', () => {
  const db = freshDb();
  setAppVersion('9.9.9');
  const s = updateStatus(db, {}, admin);
  assert.equal(s.current_version, '9.9.9');
});

test('update_status: no app version ever set — falls back to "0.0.0", never undefined/throws', () => {
  const db = freshDb();
  setAppVersion(null);
  const s = updateStatus(db, {}, admin);
  assert.equal(s.current_version, '0.0.0');
});

test('update_status: an offer with no approval yet', () => {
  const db = freshDb();
  storeOffer(db, OFFER);
  const s = updateStatus(db, {}, admin);
  assert.deepEqual(s.offer, OFFER);
  assert.equal(s.approved, false);
  assert.equal(s.hour, null);
  assert.equal(s.scheduled_at, null);
});

test('update_status: approved for THIS offer reports hour and scheduled_at', () => {
  const db = freshDb();
  storeOffer(db, OFFER);
  updateApprove(db, { hour: 3 }, admin, { now: () => new Date(2026, 0, 1, 1, 0, 0) });
  const s = updateStatus(db, {}, admin);
  assert.equal(s.approved, true);
  assert.equal(s.hour, 3);
  assert.ok(s.scheduled_at);
  assert.equal(new Date(s.scheduled_at).getHours(), 3);
});

test('update_status: consent for a version the offer has moved past reads as NOT approved', () => {
  const db = freshDb();
  storeOffer(db, OFFER);
  updateApprove(db, { hour: 3 }, admin, { now: () => new Date(2026, 0, 1, 1, 0, 0) });
  // The control plane replaced the offer with a newer release.
  storeOffer(db, { ...OFFER, version: '2.5.0' });
  const s = updateStatus(db, {}, admin);
  assert.equal(s.approved, false, 'the old approval for 2.4.0 must not read as approving 2.5.0');
  assert.equal(s.hour, null);
  assert.equal(s.scheduled_at, null);
});

test('update_status: last_result reads the not-yet-sent file first', () => {
  const db = freshDb();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-updates-lr-'));
  setDataDir(dataDir);
  fs.writeFileSync(path.join(dataDir, 'update-result.json'), JSON.stringify({ version: '2.4.0', ok: true }));
  fs.writeFileSync(path.join(dataDir, 'update-result.json.sent'), JSON.stringify({ version: '2.3.0', ok: false }));
  const s = updateStatus(db, {}, admin);
  assert.deepEqual(s.last_result, { version: '2.4.0', ok: true });
});

test('update_status: last_result falls back to the .sent file once the live one is gone', () => {
  const db = freshDb();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-updates-lr2-'));
  setDataDir(dataDir);
  fs.writeFileSync(path.join(dataDir, 'update-result.json.sent'), JSON.stringify({ version: '2.4.0', ok: false }));
  const s = updateStatus(db, {}, admin);
  assert.deepEqual(s.last_result, { version: '2.4.0', ok: false });
});

test('update_status: no result file at all — last_result is null, never throws', () => {
  const db = freshDb();
  const s = updateStatus(db, {}, admin);
  assert.equal(s.last_result, null);
});

// --- update_approve ----------------------------------------------------------

test('update_approve: a plain registrar is refused (403)', () => {
  const db = freshDb();
  storeOffer(db, OFFER);
  assert.throws(() => updateApprove(db, { hour: 3 }, registrar), (e) => e instanceof RpcError && e.status === 403);
});

test('update_approve: an admin held only via extra_roles is accepted — the twice-shipped bug', () => {
  const db = freshDb();
  storeOffer(db, OFFER);
  const r = updateApprove(db, { hour: 3 }, doctorAdmin, { now: () => new Date(2026, 0, 1, 1, 0, 0) });
  assert.equal(r.ok, true);
});

test('update_approve: no offer on file — refused, nothing to consent to', () => {
  const db = freshDb();
  assert.throws(() => updateApprove(db, { hour: 3 }, admin), (e) => e instanceof RpcError && e.status === 400);
});

test('update_approve: rejects an invalid hour', () => {
  const db = freshDb();
  storeOffer(db, OFFER);
  for (const bad of [-1, 24, 3.5, 'три', undefined, null]) {
    assert.throws(() => updateApprove(db, { hour: bad }, admin), (e) => e instanceof RpcError && e.status === 400, `hour=${bad} must be refused`);
  }
});

test('update_approve: records who and when, stores hour, schedules correctly', () => {
  const db = freshDb();
  storeOffer(db, OFFER);
  const now = new Date(2026, 0, 1, 14, 0, 0); // 14:00 — hour 3 has passed today
  const r = updateApprove(db, { hour: 3 }, admin, { now: () => now });
  assert.equal(r.hour, 3);
  assert.equal(r.version, '2.4.0');
  assert.equal(new Date(r.scheduled_at).getDate(), 2, 'rolls to tomorrow — today\'s 03:00 already passed');

  const consent = JSON.parse(get(db, 'update_consent'));
  assert.equal(consent.version, '2.4.0');
  assert.equal(consent.approved_by, 1);
  assert.equal(consent.hour, 3);
  assert.ok(consent.approved_at);
});

test('update_approve: re-approving replaces the previous consent (changeable right up until it runs)', () => {
  const db = freshDb();
  storeOffer(db, OFFER);
  updateApprove(db, { hour: 3 }, admin, { now: () => new Date(2026, 0, 1, 1, 0, 0) });
  updateApprove(db, { hour: 5 }, admin, { now: () => new Date(2026, 0, 1, 1, 0, 0) });
  const consent = JSON.parse(get(db, 'update_consent'));
  assert.equal(consent.hour, 5, 'the later approval wins');
});

// --- update_cancel -------------------------------------------------------------

test('update_cancel: a plain registrar is refused (403)', () => {
  const db = freshDb();
  assert.throws(() => updateCancel(db, {}, registrar), (e) => e instanceof RpcError && e.status === 403);
});

test('update_cancel: clears the approval and schedule, leaves the offer untouched', () => {
  const db = freshDb();
  storeOffer(db, OFFER);
  updateApprove(db, { hour: 3 }, admin, { now: () => new Date(2026, 0, 1, 1, 0, 0) });
  const r = updateCancel(db, {}, admin);
  assert.equal(r.ok, true);
  assert.equal(get(db, 'update_consent'), null);
  assert.equal(get(db, 'update_scheduled_at'), null);
  const s = updateStatus(db, {}, admin);
  assert.deepEqual(s.offer, OFFER, 'cancelling consent must not touch the offer itself');
  assert.equal(s.approved, false);
});

test('update_cancel: cancelling with nothing approved is a harmless no-op', () => {
  const db = freshDb();
  const r = updateCancel(db, {}, admin);
  assert.equal(r.ok, true);
});

// --- update_check_now ----------------------------------------------------------

test('update_check_now: a plain registrar is refused (403) and the check-in never runs', async () => {
  const db = freshDb();
  let ran = 0;
  await assert.rejects(
    () => updateCheckNow(db, {}, registrar, { runImpl: async () => { ran++; } }),
    (e) => e instanceof RpcError && e.status === 403,
  );
  assert.equal(ran, 0, 'the role guard must sit BEFORE the network-touching call');
});

test('update_check_now: runs one check-in against the real data dir and returns the fresh status', async () => {
  const db = freshDb();
  storeOffer(db, OFFER);
  const calls = [];
  // The seam mutates state the way a real check-in would (a new offer landed),
  // proving the returned status is read AFTER the check-in, not before.
  const r = await updateCheckNow(db, {}, admin, {
    runImpl: async (gotDb, gotDir) => {
      calls.push({ gotDb, gotDir });
      storeOffer(db, { ...OFFER, version: '2.5.0' });
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].gotDb, db);
  assert.equal(typeof calls[0].gotDir, 'string');
  assert.equal(r.ok, true);
  assert.equal(r.offer.version, '2.5.0', 'status must reflect what the check-in just fetched');
  assert.equal(r.current_version, '2.3.0');
});

test('update_check_now: extra_roles admin passes the guard (ADMIN_DOCTOR_V1)', async () => {
  const db = freshDb();
  const r = await updateCheckNow(db, {}, doctorAdmin, { runImpl: async () => {} });
  assert.equal(r.ok, true);
});

test('update_check_now: a broken check-in reports ok:false but still returns the status', async () => {
  const db = freshDb();
  storeOffer(db, OFFER);
  const r = await updateCheckNow(db, {}, admin, { runImpl: async () => { throw new Error('boom'); } });
  assert.equal(r.ok, false, 'the admin must not read success off a check that never happened');
  assert.deepEqual(r.offer, OFFER, 'the local status needs nothing from the network');
});
