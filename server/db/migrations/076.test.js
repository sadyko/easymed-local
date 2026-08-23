import { test } from 'node:test';
import assert from 'node:assert';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

const fresh = () => { const db = openDb(':memory:'); migrate(db); return db; };

test('076 telephony_settings is a single seeded row with safe defaults', () => {
  const db = fresh();
  const row = db.prepare('SELECT * FROM telephony_settings WHERE id = 1').get();
  // Off by default, twice over: neither the poller nor the webhooks may do
  // anything on a clinic that never opened the telephony screen.
  assert.equal(row.enabled, 0);
  assert.equal(row.webhooks_enabled, 0);
  assert.equal(row.provider, 'binotel');
  assert.equal(row.api_key, '');
  assert.equal(row.api_secret, '');
  assert.equal(row.poll_interval_sec, 30);
  assert.equal(row.public_base_url, '');
  // Empty by default: no Company ID issued yet means "don't check", never
  // "refuse everything" — the tenant check arms only when the id is typed in.
  assert.equal(row.company_id, '');
  assert.equal(row.last_poll_at, null);
  assert.equal(row.last_call_at, null);
  assert.equal(row.last_error, '');
  // CHECK (id = 1) — a second row is impossible by schema, so no code path
  // can ever fork the settings into two disagreeing rows.
  assert.throws(() => db.prepare('INSERT INTO telephony_settings (id) VALUES (2)').run());
});

test('076 calls: UNIQUE(general_call_id) makes double delivery idempotent', () => {
  const db = fresh();
  const ins = db.prepare(`INSERT INTO calls (general_call_id, started_at, source)
                          VALUES (?, ?, ?) ON CONFLICT(general_call_id) DO NOTHING`);
  // The same generalCallID arriving from the poll AND the webhook — the exact
  // double delivery the plan makes idempotent by construction.
  assert.equal(ins.run('BC-1', '2026-08-23T10:00:00Z', 'poll').changes, 1);
  assert.equal(ins.run('BC-1', '2026-08-23T10:00:00Z', 'webhook').changes, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM calls').get().n, 1);
  // First writer wins — the webhook copy changed nothing, including source.
  assert.equal(db.prepare("SELECT source FROM calls WHERE general_call_id = 'BC-1'").get().source, 'poll');
});

test('076 calls.source only speaks the two known words', () => {
  const db = fresh();
  assert.throws(
    () => db.prepare("INSERT INTO calls (general_call_id, started_at, source) VALUES ('BC-2','2026-08-23T10:00:00Z','sms')").run(),
    /CHECK/,
  );
});

test('076 deleting a matched patient keeps the call, unlinked', () => {
  const db = fresh();
  const pid = db.prepare("INSERT INTO patients (full_name, phone) VALUES ('Тест Пациент', '+998 90 961 00 04')").run().lastInsertRowid;
  db.prepare("INSERT INTO calls (general_call_id, started_at, patient_id) VALUES ('BC-3','2026-08-23T10:00:00Z', ?)").run(pid);
  db.prepare('DELETE FROM patients WHERE id = ?').run(pid);
  const row = db.prepare("SELECT patient_id FROM calls WHERE general_call_id = 'BC-3'").get();
  // ON DELETE SET NULL: the fact that a call happened outlives the card.
  assert.equal(row.patient_id, null);
});

test('076 deleting the saving user keeps the settings row', () => {
  const db = fresh();
  const uid = db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('tel-admin','x','admin')").run().lastInsertRowid;
  db.prepare('UPDATE telephony_settings SET updated_by = ? WHERE id = 1').run(uid);
  // Staff administration must never fail because of a telephony table — the
  // trap 073's module_requests documents, avoided the same way (SET NULL).
  db.prepare('DELETE FROM users WHERE id = ?').run(uid);
  assert.equal(db.prepare('SELECT updated_by FROM telephony_settings WHERE id = 1').get().updated_by, null);
});
