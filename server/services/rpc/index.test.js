// WIRING_GUARD_V1 — the RPC map is the one place where a handler can be
// registered without being wired up, and nothing else in the suite covers it:
// every other rpc test imports its handler straight from the module that
// defines it, so the map itself was never exercised.
//
// That is exactly how `create_invoice_for_admission` and
// `remove_admission_line_from_invoice` shipped broken while 349 tests stayed
// green — both were listed in the map but missing from the `billing.js` import
// list. A handler that references an unimported name STILL type-checks as a
// function; the ReferenceError only appears when it is called, and routes/rpc.js
// then reports it as an opaque 500 "RPC failed."
//
// So this test CALLS every handler once. It does not care whether a call
// succeeds — empty args are meant to be rejected — only that the failure is a
// deliberate one (RpcError, or SQLite complaining about the data) and never a
// ReferenceError, which is the signature of a broken wire.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { RPC, getRpc } from './index.js';

function seed() {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (1,'admin1','x','admin')").run();
  return db;
}

const admin = { id: 1, role: 'admin' };

test('every registered RPC is a function', () => {
  for (const [name, handler] of Object.entries(RPC)) {
    assert.equal(typeof handler, 'function', `RPC ${name} is not a function`);
  }
});

// TELEGRAM_BOT_V1 — `await` здесь обязателен с тех пор, как появился первый
// асинхронный обработчик (telegram_test_connection ходит в api.telegram.org).
// Без него отказ такого RPC уходил мимо catch и всплывал как
// unhandledRejection уже после конца теста, а ReferenceError внутри async-тела
// вообще не был бы замечен. На синхронных обработчиках await — no-op.
test('every registered RPC is reachable — no handler references an unimported name', async () => {
  const broken = [];
  for (const name of Object.keys(RPC)) {
    const db = seed();   // a fresh db per handler: some of them write
    try {
      await getRpc(name)(db, {}, admin);
    } catch (e) {
      // A ReferenceError means the handler body names something that was never
      // imported. TypeError "x is not a function" means it was imported as
      // undefined. Both are wiring faults, not input validation.
      if (e instanceof ReferenceError || /is not a function|is not defined/.test(e.message || '')) {
        broken.push(`${name}: ${e.message}`);
      }
    } finally {
      db.close();
    }
  }
  assert.deepEqual(broken, [], 'RPCs registered but not wired up:\n' + broken.join('\n'));
});

test('getRpc returns null for an unknown name and ignores inherited properties', () => {
  assert.equal(getRpc('no_such_rpc'), null);
  // Object.prototype keys must not resolve to a handler (prototype-pollution guard).
  assert.equal(getRpc('constructor'), null);
  assert.equal(getRpc('toString'), null);
});
