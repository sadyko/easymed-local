import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import {
  publicSettings, saveSettings, getCredentials, recordPoll, noteCallSeen,
  SettingsError, MIN_POLL_INTERVAL_SEC, MAX_POLL_INTERVAL_SEC,
} from './settings.js';

const fresh = () => { const db = openDb(':memory:'); migrate(db); return db; };

test('publicSettings never contains the secret, only api_secret_set', () => {
  const db = fresh();
  saveSettings(db, { api_key: 'k1', api_secret: 'the-secret' });
  const pub = publicSettings(db);
  assert.equal(pub.api_secret_set, true);
  assert.equal(pub.api_key, 'k1');
  // The whole serialized shape — not just a named field — must be free of the
  // value: a future field added carelessly gets caught here too.
  assert.ok(!JSON.stringify(pub).includes('the-secret'));
  assert.equal('api_secret' in pub, false);
});

test('an ordinary save with an empty secret field keeps the saved secret', () => {
  const db = fresh();
  saveSettings(db, { api_key: 'k1', api_secret: 'keep-me' });
  // The masked field posts '' when the admin saves a toggle — the classic
  // empty-password-field wipe this patch semantics exists to prevent.
  saveSettings(db, { api_secret: '', webhooks_enabled: true });
  assert.equal(getCredentials(db).secret, 'keep-me');
  assert.equal(publicSettings(db).webhooks_enabled, true);
  // A real new value replaces it.
  saveSettings(db, { api_secret: 'new-one' });
  assert.equal(getCredentials(db).secret, 'new-one');
});

test('polling cannot be enabled without both credentials', () => {
  const db = fresh();
  assert.throws(() => saveSettings(db, { enabled: true }), SettingsError);
  saveSettings(db, { api_key: 'k' });
  assert.throws(() => saveSettings(db, { enabled: true }), SettingsError);
  saveSettings(db, { api_secret: 's' });
  assert.equal(saveSettings(db, { enabled: true }).enabled, true);
});

test('poll interval: clamped to [10, 3600], garbage refused', () => {
  const db = fresh();
  assert.equal(saveSettings(db, { poll_interval_sec: 30 }).poll_interval_sec, 30);
  // A typo like "1" must degrade to the floor, never hammer Binotel…
  assert.equal(saveSettings(db, { poll_interval_sec: 1 }).poll_interval_sec, MIN_POLL_INTERVAL_SEC);
  // …and an absurd value must not turn the poller into silence.
  assert.equal(saveSettings(db, { poll_interval_sec: 999999 }).poll_interval_sec, MAX_POLL_INTERVAL_SEC);
  assert.throws(() => saveSettings(db, { poll_interval_sec: 'soon' }), SettingsError);
});

test('public_base_url is stored without trailing slashes', () => {
  const db = fresh();
  saveSettings(db, { public_base_url: 'https://clinic.example.uz///' });
  // Stripped once at save time so every URL-building call site can just
  // concatenate — none of them has to remember to strip.
  assert.equal(publicSettings(db).public_base_url, 'https://clinic.example.uz');
});

test('company_id: carried, trimmed, kept on partial saves', () => {
  const db = fresh();
  saveSettings(db, { company_id: ' 12345 ' });
  assert.equal(publicSettings(db).company_id, '12345');
  // Patch semantics like every other field: saving a toggle keeps it.
  saveSettings(db, { webhooks_enabled: true });
  assert.equal(publicSettings(db).company_id, '12345');
});

test('recordPoll writes proof-of-life; success clears the previous error', () => {
  const db = fresh();
  recordPoll(db, { ok: false, error: 'offline' });
  let pub = publicSettings(db);
  assert.equal(pub.last_error, 'offline');
  assert.ok(pub.last_poll_at);
  recordPoll(db, { ok: true });
  assert.equal(publicSettings(db).last_error, '');
});

test('noteCallSeen only ever moves forward', () => {
  const db = fresh();
  noteCallSeen(db, '2026-08-23T10:00:00Z');
  // The 120s overlap window re-delivers older calls — they must not rewind
  // the "последний звонок" line on the settings screen.
  noteCallSeen(db, '2026-08-23T09:59:00Z');
  assert.equal(publicSettings(db).last_call_at, '2026-08-23T10:00:00Z');
  noteCallSeen(db, '2026-08-23T10:01:00Z');
  assert.equal(publicSettings(db).last_call_at, '2026-08-23T10:01:00Z');
});
