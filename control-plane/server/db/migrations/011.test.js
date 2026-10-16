import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { createEnrollmentCode } from '../../services/enrollment.js';

// PUBLIC_LICENCE_V1 — 011_public_api.sql: переключатель онлайн-записи, отпечаток
// ключа обмена, последняя выданная лицензия, срочный отзыв ключей.

function freshDb() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}
const FP = 'ab'.repeat(16);
const HASH = 'cd'.repeat(32);

test('011: новая клиника — онлайн-запись выключена, ключа и выданной лицензии нет', () => {
  const db = freshDb();
  createEnrollmentCode(db, { clinicId: 'c-1', name: 'Клиника' });
  const row = db.prepare('SELECT * FROM clinics WHERE clinic_id = ?').get('c-1');
  assert.equal(row.api_enabled, 0);
  for (const c of ['api_sync_key', 'api_sync_key_accepted_at', 'api_sync_key_seen', 'api_sync_key_seen_at',
    'licence_issued_at', 'licence_valid_until', 'licence_subscription', 'licence_api_sync_key']) assert.equal(row[c], null, c);
  assert.throws(() => db.prepare('UPDATE clinics SET api_enabled = 2 WHERE clinic_id = ?').run('c-1'), /CHECK/);
});

test('011: отзыв — только два вида и только hex своей длины; одна действующая запись на ключ, снятых — сколько угодно', () => {
  const db = freshDb();
  const add = (kind, value) => db.prepare('INSERT INTO revocations (clinic_id, kind, value, created_by) VALUES (?, ?, ?, ?)').run('c-1', kind, value, 'vendor');
  add('partner_key', HASH);
  add('sync_key', FP);
  for (const [kind, value] of [['partner_key', FP], ['sync_key', HASH], ['partner_key', 'CD'.repeat(32)], ['sync_key', 'zz'.repeat(16)],
    ['clinic', FP], ['partner_key', 'em_live_' + 'x'.repeat(56)]]) {
    assert.throws(() => add(kind, value), /CHECK/, kind + ' ' + value);
  }
  assert.throws(() => add('partner_key', HASH), /UNIQUE/);
  db.prepare("UPDATE revocations SET removed_at = '2026-10-12T00:00:00Z' WHERE value = ?").run(HASH);
  add('partner_key', HASH);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM revocations WHERE value = ?').get(HASH).n, 2);
});

test('011: удаление клиники не стирает историю её блокировок', () => {
  const db = freshDb();
  createEnrollmentCode(db, { clinicId: 'c-1', name: 'Клиника' });
  db.prepare("INSERT INTO revocations (clinic_id, kind, value) VALUES ('c-1', 'sync_key', ?)").run(FP);
  db.prepare("UPDATE clinics SET active = 0 WHERE clinic_id = 'c-1'").run();
  db.prepare("INSERT INTO deleted_clinics (clinic_id, name) VALUES ('c-1', 'Клиника')").run();
  db.prepare("DELETE FROM clinics WHERE clinic_id = 'c-1'").run();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM revocations').get().n, 1);
});

// PUBLIC_LICENCE_V1 (ревью 8c, п. 1) — каждый отпечаток ключа обмена, который
// принесла сверка этой установки, помнится отдельно: «Принять новый ключ»
// видит, сколько разных ключей пришло с тех пор, как ключ принимали последний раз.
test('011: sync_keys_seen — по строке на ключ клиники, только 32 hex, три состояния', () => {
  const db = freshDb();
  const add = (clinic, fp, state = 'candidate') => db.prepare(
    "INSERT INTO sync_keys_seen (clinic_id, fp, first_seen, last_seen, state, state_at) VALUES (?, ?, '2026-10-12T10:00:00Z', '2026-10-12T10:00:00Z', ?, '2026-10-12T10:00:00Z')",
  ).run(clinic, fp, state);
  add('c-1', FP);
  add('c-2', FP, 'accepted');
  add('c-1', 'cd'.repeat(16), 'replaced');
  assert.throws(() => add('c-1', FP), /UNIQUE|PRIMARY/);
  for (const [fp, state] of [['AB'.repeat(16), 'candidate'], ['ab'.repeat(15), 'candidate'], ['zz'.repeat(16), 'candidate'], ['ef'.repeat(16), 'new']]) {
    assert.throws(() => add('c-1', fp, state), /CHECK/, fp + ' ' + state);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sync_keys_seen').get().n, 3);
});
