import { test } from 'node:test';
import assert from 'node:assert';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

const fresh = () => { const db = openDb(':memory:'); migrate(db); return db; };

test('073 creates control_state as a key/value store', () => {
  const db = fresh();
  db.prepare("INSERT INTO control_state (key, value) VALUES ('clock_high_water', '2026-08-20T00:00:00Z')").run();
  const row = db.prepare("SELECT value FROM control_state WHERE key = 'clock_high_water'").get();
  assert.equal(row.value, '2026-08-20T00:00:00Z');
});

test('073 control_state keys are unique', () => {
  const db = fresh();
  db.prepare("INSERT INTO control_state (key, value) VALUES ('k', '1')").run();
  assert.throws(
    () => db.prepare("INSERT INTO control_state (key, value) VALUES ('k', '2')").run(),
    /UNIQUE|PRIMARY KEY/
  );
});

test('073 records module access requests with who and when', () => {
  const db = fresh();
  const uid = db.prepare("SELECT id FROM users LIMIT 1").get()?.id ?? null;
  db.prepare('INSERT INTO module_requests (module_key, requested_by) VALUES (?, ?)').run('marketing', uid);
  const row = db.prepare('SELECT * FROM module_requests').get();
  assert.equal(row.module_key, 'marketing');
  assert.ok(row.requested_at, 'requested_at defaults to now');
  assert.equal(row.sent_at, null, 'not yet reported to the vendor');
});

test('073 keeps only one open request per module', () => {
  const db = fresh();
  db.prepare('INSERT INTO module_requests (module_key) VALUES (?)').run('crm');
  assert.throws(
    () => db.prepare('INSERT INTO module_requests (module_key) VALUES (?)').run('crm'),
    /UNIQUE/,
    'a second unsent request for the same module must be refused'
  );
});

test('073 the partial index permits a new request once the previous one is sent', () => {
  const db = fresh();
  db.prepare('INSERT INTO module_requests (module_key) VALUES (?)').run('crm');
  db.prepare("UPDATE module_requests SET sent_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE module_key = 'crm'").run();
  // Should not throw: the prior request for 'crm' is no longer open (sent_at is set),
  // so the partial unique index does not cover it and a fresh request is allowed.
  assert.doesNotThrow(
    () => db.prepare('INSERT INTO module_requests (module_key) VALUES (?)').run('crm'),
    'a module can be requested again once the previous request has been delivered'
  );
  const rows = db.prepare('SELECT * FROM module_requests WHERE module_key = ? ORDER BY id').all('crm');
  assert.equal(rows.length, 2);
  assert.ok(rows[0].sent_at, 'first request is marked sent');
  assert.equal(rows[1].sent_at, null, 'second request is open again');
});
