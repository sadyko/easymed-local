import { test } from 'node:test';
import assert from 'node:assert';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { moduleRequest } from './licence.js';

// module_requests.requested_by is a real FK to users(id) (ON DELETE SET NULL —
// see 073_licensing.sql), so USER.id must reference an actual row or the
// INSERT throws SQLITE_CONSTRAINT_FOREIGNKEY before it ever reaches the
// unique-open-request logic under test. Every other rpc/*.test.js fresh()
// helper seeds a users row for the same reason (e.g. billing.free.test.js,
// accommodation.test.js) — bare migrate(db) alone never creates one.
const fresh = () => {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (1,'admin','x','Admin','admin')").run();
  return db;
};
const USER = { id: 1, role: 'admin' };

test('requesting a module records a lead for the vendor', () => {
  const db = fresh();
  const r = moduleRequest(db, { module_key: 'marketing' }, USER);
  assert.equal(r.ok, true);
  const row = db.prepare('SELECT * FROM module_requests').get();
  assert.equal(row.module_key, 'marketing');
  assert.equal(row.requested_by, 1);
});

test('clicking the button twice does not create two leads', () => {
  const db = fresh();
  moduleRequest(db, { module_key: 'marketing' }, USER);
  const second = moduleRequest(db, { module_key: 'marketing' }, USER);
  assert.equal(second.ok, true, 'the button must not show an error to the clinic');
  assert.equal(second.already, true);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM module_requests').get().n, 1);
});

test('the request date comes back so the button can show it', () => {
  const db = fresh();
  moduleRequest(db, { module_key: 'crm' }, USER);
  const again = moduleRequest(db, { module_key: 'crm' }, USER);
  assert.ok(again.requested_at, 'so the UI can say "Заявка отправлена <date>"');
});

test('an unknown module key is refused', () => {
  const db = fresh();
  assert.throws(() => moduleRequest(db, { module_key: 'not-a-module' }, USER), /module/i);
});

test('a missing module key is refused', () => {
  const db = fresh();
  assert.throws(() => moduleRequest(db, {}, USER), /module/i);
});

// --- attack-testing added beyond the spec's own list ------------------------

test('a requested_by that matches no user surfaces as a real error, not a false "already requested"', () => {
  // Regression test: an early version of the catch below matched ANY
  // SQLITE_CONSTRAINT at insert time (not just the unique index), which
  // silently relabelled a genuine foreign-key violation as a false-positive
  // {ok:true, already:true, requested_at:null} with no row ever written.
  // Found by running this very file's tests against a bare migrate()d db
  // with no users row for USER.id — see the comment on fresh() above.
  const db = fresh();
  assert.throws(() => moduleRequest(db, { module_key: 'crm' }, { id: 999 }), /FOREIGN KEY/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM module_requests').get().n, 0, 'no phantom row after a rejected insert');
});

test('the theoretical SELECT-then-INSERT race still answers cleanly, not a 500', () => {
  // moduleRequest is fully synchronous and better-sqlite3 is a single
  // synchronous connection per process, so two calls can never actually
  // interleave between the SELECT and the INSERT here — Node's event loop
  // will not preempt one synchronous handler to run another. This test does
  // not contradict that; it proves the defensive catch is safe IF that
  // reasoning is ever wrong (a future async rewrite, a second connection),
  // by simulating the interleave directly: the SELECT is stubbed to report
  // "nothing open" (as it would to two racing callers) while the INSERT is
  // stubbed to fail exactly as the real unique index would for the loser.
  const db = fresh();
  db.prepare('INSERT INTO module_requests (module_key, requested_by) VALUES (?, ?)').run('crm', 1); // the "winner"'s row

  let selectCount = 0;
  const racy = {
    prepare(sql) {
      if (sql.startsWith('SELECT')) {
        selectCount++;
        if (selectCount === 1) return { get: () => undefined }; // the racer's own pre-insert check
        return db.prepare(sql); // the post-catch re-read: sees the real winning row
      }
      if (sql.startsWith('INSERT')) {
        return { run: () => {
          const e = new Error('UNIQUE constraint failed: module_requests.module_key');
          e.code = 'SQLITE_CONSTRAINT_UNIQUE';
          throw e;
        } };
      }
      return db.prepare(sql);
    },
  };
  const r = moduleRequest(racy, { module_key: 'crm' }, USER);
  assert.equal(r.ok, true);
  assert.equal(r.already, true, 'the loser of the race must see "already requested", not a 500');
  assert.ok(r.requested_at);
});
