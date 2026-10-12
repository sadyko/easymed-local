// PUBLIC_LICENCE_V1 — решения сервера лицензий для публичного сервера: какую
// лицензию выдать, какой ключ обмена принять, что видят партнёры.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { createEnrollmentCode } from './enrollment.js';
import {
  licenceTerms, noteSyncKey, acceptPendingSyncKey, syncKeyPending, partnersSee, recordIssued, isRevoked, isoSeconds,
  NEW_SYNC_KEY_NEEDS_CONFIRMATION,
} from './public-api.js';

const FP1 = '11'.repeat(16);
const FP2 = '22'.repeat(16);
const NOW = Date.parse('2026-10-12T10:00:00Z');
const LIVE = '2026-10-20T10:00:00.000Z';

function freshDb() {
  const db = openDb(':memory:');
  migrate(db);
  createEnrollmentCode(db, { clinicId: 'c-1', name: 'Клиника' });
  return db;
}
const row = (db) => db.prepare('SELECT * FROM clinics WHERE clinic_id = ?').get('c-1');

test('licenceTerms: оплачено — active, ключ только при включённом API; не оплачено — лицензии нет, как до 8c, даже если последняя выданная жива (Р14)', () => {
  assert.deepEqual(licenceTerms({ entitled: true, apiEnabled: false, apiSyncKey: FP1 }), { subscription: 'active', apiSyncKey: null });
  assert.deepEqual(licenceTerms({ entitled: true, apiEnabled: true, apiSyncKey: FP1, lastIssuedAt: '2026-10-12T09:00:00.000Z' }),
    { subscription: 'active', apiSyncKey: FP1, issuedAfter: '2026-10-12T09:00:00.000Z' });
  assert.deepEqual(licenceTerms({ entitled: true, apiEnabled: true, apiSyncKey: 'не отпечаток' }), { subscription: 'active', apiSyncKey: null });
  assert.deepEqual(licenceTerms({ entitled: true, apiEnabled: false, apiSyncKey: null, lastIssuedAt: 'мусор' }), { subscription: 'active', apiSyncKey: null });
  for (const o of [
    { entitled: false, apiEnabled: true, apiSyncKey: FP1, lastIssuedAt: '2026-10-12T09:00:00.000Z', lastValidUntil: LIVE, now: NOW },
    { entitled: false, apiEnabled: false, apiSyncKey: null },
  ]) assert.equal(licenceTerms(o), null, JSON.stringify(o).slice(0, 60));
});

test('noteSyncKey: первый ключ принимается сам; тот же — без записи; другой — ждёт подтверждения', () => {
  assert.equal(NEW_SYNC_KEY_NEEDS_CONFIRMATION, true, 'вопрос владельцу 1 — построено с подтверждением');
  const db = freshDb();
  assert.deepEqual(noteSyncKey(db, row(db), '', NOW), { apiSyncKey: null, changed: false });
  assert.equal(row(db).api_sync_key_seen, null, 'нет ключа — ничего не пишется');
  assert.deepEqual(noteSyncKey(db, row(db), FP1, NOW), { apiSyncKey: FP1, changed: true });
  let r = row(db);
  assert.deepEqual([r.api_sync_key, r.api_sync_key_seen, r.api_sync_key_accepted_at, r.api_sync_key_seen_at],
    [FP1, FP1, '2026-10-12T10:00:00Z', '2026-10-12T10:00:00Z']);
  assert.deepEqual(noteSyncKey(db, row(db), FP1, NOW + 3600000), { apiSyncKey: FP1, changed: false });
  assert.equal(row(db).api_sync_key_seen_at, '2026-10-12T10:00:00Z', 'тот же ключ — «появился» не сдвигается');
  assert.deepEqual(noteSyncKey(db, row(db), FP2, NOW + 7200000), { apiSyncKey: FP1, changed: true });
  r = row(db);
  assert.deepEqual([r.api_sync_key, r.api_sync_key_seen, r.api_sync_key_seen_at], [FP1, FP2, '2026-10-12T12:00:00Z']);
  assert.equal(syncKeyPending(db, r), true);
});

test('noteSyncKey: отозванный ключ не принимается никогда — даже первым', () => {
  const db = freshDb();
  db.prepare("INSERT INTO revocations (clinic_id, kind, value) VALUES ('c-1', 'sync_key', ?)").run(FP1);
  assert.deepEqual(noteSyncKey(db, row(db), FP1, NOW), { apiSyncKey: null, changed: true });
  assert.deepEqual([row(db).api_sync_key, row(db).api_sync_key_seen], [null, FP1]);
  assert.equal(syncKeyPending(db, row(db)), false, 'отозванный не «ждёт подтверждения»');
  assert.equal(isRevoked(db, 'sync_key', FP1), true);
  assert.equal(isRevoked(db, 'sync_key', FP2), false);
  assert.equal(isRevoked(db, 'sync_key', ''), false);
});

test('acceptPendingSyncKey: только тот, что видел человек, и не отозванный', () => {
  const db = freshDb();
  assert.deepEqual(acceptPendingSyncKey(db, 'c-1', FP1, NOW), { error: 'not_pending' });
  noteSyncKey(db, row(db), FP1, NOW);
  noteSyncKey(db, row(db), FP2, NOW);
  assert.deepEqual(acceptPendingSyncKey(db, 'c-1', FP1, NOW), { error: 'changed' }, 'клиника с тех пор прислала другой');
  db.prepare("INSERT INTO revocations (clinic_id, kind, value) VALUES ('c-1', 'sync_key', ?)").run(FP2);
  assert.deepEqual(acceptPendingSyncKey(db, 'c-1', FP2, NOW), { error: 'revoked' });
  db.prepare('UPDATE revocations SET removed_at = ?').run(isoSeconds(NOW));
  assert.deepEqual(acceptPendingSyncKey(db, 'c-1', FP2, NOW + 1000), { ok: true });
  assert.deepEqual([row(db).api_sync_key, row(db).api_sync_key_accepted_at], [FP2, '2026-10-12T10:00:01Z']);
  assert.deepEqual(acceptPendingSyncKey(db, 'c-1', FP2, NOW), { error: 'not_pending' });
  assert.deepEqual(acceptPendingSyncKey(db, 'c-нет', FP2, NOW), { error: 'not_pending' });
});

test('partnersSee: снята, не оплачено, выключено, нет ключа — скрыта; иначе видна', () => {
  const c = { active: 1, api_enabled: 1, api_sync_key: FP1 };
  assert.equal(partnersSee(c, { entitled: true }), 'visible');
  assert.equal(partnersSee({ ...c, active: 0 }, { entitled: true }), 'retired');
  assert.equal(partnersSee(c, { entitled: false }), 'unpaid');
  assert.equal(partnersSee({ ...c, api_enabled: 0 }, { entitled: true }), 'off');
  assert.equal(partnersSee({ ...c, api_sync_key: null }, { entitled: true }), 'no_key');
});

test('recordIssued: запоминает выданное; испорченное или сбой базы — не бросает', () => {
  const db = freshDb();
  recordIssued(db, 'c-1', { issued_at: '2026-10-12T10:00:00.000Z', valid_until: LIVE, subscription: 'active', api_sync_key: FP1 });
  const r = row(db);
  assert.deepEqual([r.licence_issued_at, r.licence_valid_until, r.licence_subscription, r.licence_api_sync_key],
    ['2026-10-12T10:00:00.000Z', LIVE, 'active', FP1]);
  recordIssued(db, 'c-1', { issued_at: 5, valid_until: {} });
  assert.equal(row(db).licence_issued_at, null);
  assert.doesNotThrow(() => recordIssued({ prepare() { throw new Error('база закрыта'); } }, 'c-1', {}));
});
