import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import { canonical } from './canonical.js';
import { __setPublicKeyForTests } from './state.js';

// LICENCE_CORE_V1 — a data directory for tests that predate licensing and are
// not testing it.
//
// createApp(db) with no options now defaults dataDir to the real project
// ./data folder (server/app.js), because that is the correct default for
// server/index.js in production. But that folder is never enrolled on a dev
// machine or in CI — no control.json ever gets written there by a test — so
// controlState() reads it as 'not_enrolled' and every test that calls
// createApp(db) without an override started getting a 402 on every write and
// every RPC the day the gate in routes/db.js and routes/rpc.js went in. That
// is a real bug this fixture exists to close: dozens of tests across the
// suite assert that a write succeeds, or that an unknown RPC is a plain 501,
// and none of them have anything to do with licensing.
//
// Each node --test file runs in its own process (verified: printing
// process.pid from two files in one `node --test a.test.js b.test.js` run
// gives two different pids), so calling __setPublicKeyForTests here is safe
// per-file — it can never leak a throwaway key into a different test file's
// process.
// `modules` (TELEPHONY_V1): tests of licensed-module features (the telephony
// poller's callcenter gate) need a licence that GRANTS a module, signed the
// same way — defaulted to none so every existing caller keeps the exact
// fixture it always had.
export function licensedDataDir({ modules = [] } = {}) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  __setPublicKeyForTests(publicKey);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-licensed-'));
  fs.writeFileSync(path.join(dir, 'control.json'), JSON.stringify({
    clinic_id: 'test-clinic', unlock_secret: 'test-secret', subscription: 'active',
  }));
  const payload = {
    clinic_id: 'test-clinic', clinic_name: 'Test Clinic', modules,
    // Far enough out that no test suite will ever run past it.
    valid_until: '2099-01-01T00:00:00Z', issued_at: '2026-08-01T00:00:00Z', nonce: 'fixture',
  };
  fs.writeFileSync(path.join(dir, 'licence.dat'), JSON.stringify({
    payload, sig: sign(null, Buffer.from(canonical(payload), 'utf8'), privateKey).toString('base64'),
  }));
  return dir;
}
