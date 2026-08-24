import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync, sign } from 'node:crypto';

import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { canonical } from './canonical.js';
import { controlState, __setPublicKeyForTests as __setStatePublicKeyForTests } from './state.js';
import { COUNTER_NAMES } from './metrics.js';
import {
  runCheckin,
  scheduleCheckin,
  checkinUrl,
  checkinIntervalMs,
  computeFingerprint,
  readAppVersion,
  readJsonFile,
  __setPublicKeyForTests,
} from './checkin.js';

// The acceptance test drives the REAL control plane, not a fake — see this
// file's own final test. Imported across the control-plane/ <-> server/
// boundary the same way control-plane/server/routes/checkin.route.test.js
// does it from the other side.
import { openDb as openCpDb } from '../../../control-plane/server/db/connection.js';
import { migrate as migrateCp } from '../../../control-plane/server/db/migrate.js';
import { createEnrollmentCode, redeemEnrollmentCode } from '../../../control-plane/server/services/enrollment.js';
import { createApp as createCpApp } from '../../../control-plane/server/app.js';
import { hashPassword } from '../../../control-plane/server/services/vendor-auth.js';

// --- test harness ------------------------------------------------------------
//
// THE RULE THAT OUTRANKS EVERY FEATURE IN THIS FILE: if the control plane is
// unreachable, broken, or lying, the clinic must not notice. Every test below
// is an attempt to make the client behave badly, and the only acceptable
// result — bar the two "acceptance"/happy-path tests — is "nothing changed,
// nothing thrown, a warning was logged".

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
__setPublicKeyForTests(publicKey); // checkin.js's own verifier seam, mirrors state.js's

const tmpDirs = [];
function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

test.after(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }
});

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

// A clinic data directory as it exists on disk: control.json + (maybe) licence.dat.
function workspace({ installToken = 'tok-1', clinicId = 'c-000047', subscription = 'active', licence, extraIdentity = {} } = {}) {
  const dir = tmpDir('em-checkin-');
  const identity = { clinic_id: clinicId, unlock_secret: 'secret', subscription, ...extraIdentity };
  if (installToken !== undefined) identity.install_token = installToken;
  fs.writeFileSync(path.join(dir, 'control.json'), JSON.stringify(identity));
  if (licence) fs.writeFileSync(path.join(dir, 'licence.dat'), JSON.stringify(licence));
  const db = openDb(':memory:');
  migrate(db);
  return { dir, db, identity };
}

function signedLicence(over = {}) {
  const payload = {
    clinic_id: 'c-000047', clinic_name: 'Test Clinic', modules: ['crm'],
    valid_until: '2099-01-01T00:00:00Z', issued_at: '2026-08-20T00:00:00Z', nonce: 'n1',
    ...over,
  };
  return { payload, sig: sign(null, Buffer.from(canonical(payload), 'utf8'), privateKey).toString('base64') };
}

// A standalone HTTP server standing in for the vendor's control plane.
// `handler(req, res, bodyText)` gets the parsed-as-text request body; the
// server also tracks how many requests it has received, since several tests
// (no install_token, idempotent resend) assert on call COUNT, not just on
// what a call did.
function fakeServer(handler) {
  const state = { count: 0, bodies: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      state.count += 1;
      state.bodies.push(body);
      handler(req, res, body);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, state, endpoint: `http://127.0.0.1:${server.address().port}` }));
  });
}

function jsonHandler(status, obj) {
  return (req, res) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
}

function seedModuleRequest(db, moduleKey) {
  db.prepare('INSERT INTO module_requests (module_key) VALUES (?)').run(moduleKey);
  return db.prepare('SELECT * FROM module_requests WHERE module_key = ?').get(moduleKey);
}

// --- happy path ---------------------------------------------------------------

test('happy path: a valid licence is written, sent requests are marked, subscription is stored', async (t) => {
  const { dir, db } = workspace({ subscription: 'active' });
  const pending = seedModuleRequest(db, 'telegram');
  const licence = signedLicence({ modules: ['crm', 'telegram'] });

  const { server, state, endpoint } = await fakeServer((req, res, body) => {
    const parsed = JSON.parse(body);
    assert.equal(parsed.install_token, 'tok-1');
    assert.equal(typeof parsed.version, 'string');
    assert.equal(typeof parsed.fingerprint, 'string');
    assert.deepEqual(parsed.module_requests, [{ module_key: 'telegram', requested_at: pending.requested_at }]);
    jsonHandler(200, { licence, subscription: 'active', collect: [] })(req, res);
  });
  t.after(() => server.close());

  await runCheckin(db, dir, { endpoint });

  assert.equal(state.count, 1);
  assert.deepEqual(JSON.parse(readText(path.join(dir, 'licence.dat'))), licence, 'the fresh licence must be written');

  const row = db.prepare('SELECT sent_at FROM module_requests WHERE module_key = ?').get('telegram');
  assert.ok(row.sent_at, 'the delivered request must be marked sent');

  const identity = JSON.parse(readText(path.join(dir, 'control.json')));
  assert.equal(identity.subscription, 'active');
  assert.equal(identity.clinic_id, 'c-000047', 'other identity fields must survive untouched');

  const lastCheckin = db.prepare("SELECT value FROM control_state WHERE key = 'last_checkin_at'").get();
  assert.ok(lastCheckin, 'a successful contact must be recorded');
  assert.ok(!Number.isNaN(new Date(lastCheckin.value).getTime()));
});

test('the version sent is read from package.json, not hardcoded', async (t) => {
  const { dir, db } = workspace();
  const version = readAppVersion();
  assert.match(version, /^\d+\.\d+\.\d+/, 'must look like a real semver, not a fallback placeholder');

  const { server, endpoint } = await fakeServer((req, res, body) => {
    assert.equal(JSON.parse(body).version, version);
    jsonHandler(200, { licence: null, subscription: 'active', collect: [] })(req, res);
  });
  t.after(() => server.close());
  await runCheckin(db, dir, { endpoint });
});

// --- no install_token: today's hand-licensed behaviour must not regress -----

test('no install_token at all: no request is made, nothing is touched', async (t) => {
  // NOT workspace({ installToken: undefined }) — default-parameter
  // destructuring treats an explicit `undefined` property the same as an
  // omitted one, so that call would silently fall back to workspace()'s own
  // default token and defeat the point of this test. Writing control.json
  // by hand here is what actually produces a file with NO install_token key.
  const dir = tmpDir('em-checkin-');
  const db = openDb(':memory:'); migrate(db);
  fs.writeFileSync(path.join(dir, 'control.json'), JSON.stringify({ clinic_id: 'c-000047', unlock_secret: 'secret', subscription: 'active' }));
  const before = readText(path.join(dir, 'control.json'));

  const { server, state, endpoint } = await fakeServer(jsonHandler(200, { licence: null, subscription: 'active', collect: [] }));
  t.after(() => server.close());

  await runCheckin(db, dir, { endpoint });

  assert.equal(state.count, 0, 'a hand-licensed install must never call home');
  assert.equal(readText(path.join(dir, 'control.json')), before);
});

test('an empty-string install_token is treated the same as no token', async (t) => {
  const { dir, db } = workspace({ installToken: '' });
  const { server, state, endpoint } = await fakeServer(jsonHandler(200, { licence: null, subscription: 'active', collect: [] }));
  t.after(() => server.close());
  await runCheckin(db, dir, { endpoint });
  assert.equal(state.count, 0);
});

test('no control.json file at all: no request is made, no throw', async (t) => {
  const dir = tmpDir('em-checkin-');
  const db = openDb(':memory:'); migrate(db);
  const { server, state, endpoint } = await fakeServer(jsonHandler(200, { licence: null, subscription: 'active', collect: [] }));
  t.after(() => server.close());
  await assert.doesNotReject(runCheckin(db, dir, { endpoint }));
  assert.equal(state.count, 0);
});

// --- connectivity failures: nothing changes, nothing thrown -----------------

test('connection refused: nothing changes, no throw', async () => {
  const { dir, db } = workspace({ licence: signedLicence() });
  const before = readText(path.join(dir, 'licence.dat'));

  // Claim a port, then close it immediately — nothing is listening there anymore.
  const { server, endpoint } = await fakeServer(() => {});
  await new Promise((r) => server.close(r));

  await assert.doesNotReject(runCheckin(db, dir, { endpoint }));
  assert.equal(readText(path.join(dir, 'licence.dat')), before);
});

test('timeout: nothing changes, no throw', async (t) => {
  const { dir, db } = workspace({ licence: signedLicence() });
  const before = readText(path.join(dir, 'licence.dat'));

  const { server, endpoint } = await fakeServer(() => { /* never responds */ });
  t.after(() => server.close());

  await assert.doesNotReject(runCheckin(db, dir, { endpoint, timeoutMs: 150 }));
  assert.equal(readText(path.join(dir, 'licence.dat')), before);
});

test('a 500 response: nothing changes, no throw', async (t) => {
  const { dir, db } = workspace({ licence: signedLicence() });
  const before = readText(path.join(dir, 'licence.dat'));

  const { server, endpoint } = await fakeServer((req, res) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'internal' } }));
  });
  t.after(() => server.close());

  await assert.doesNotReject(runCheckin(db, dir, { endpoint }));
  assert.equal(readText(path.join(dir, 'licence.dat')), before);
});

test('an HTML error page instead of JSON (200 status): nothing changes, no throw', async (t) => {
  const { dir, db } = workspace({ licence: signedLicence() });
  const before = readText(path.join(dir, 'licence.dat'));

  const { server, endpoint } = await fakeServer((req, res) => {
    // A misconfigured proxy answering 200 with an HTML body — worse than a
    // clean error status, because res.ok is true and only the body is bogus.
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body><h1>Just a moment...</h1></body></html>');
  });
  t.after(() => server.close());

  await assert.doesNotReject(runCheckin(db, dir, { endpoint }));
  assert.equal(readText(path.join(dir, 'licence.dat')), before);
});

test('truncated / invalid JSON: nothing changes, no throw', async (t) => {
  const { dir, db } = workspace({ licence: signedLicence() });
  const before = readText(path.join(dir, 'licence.dat'));

  const { server, endpoint } = await fakeServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"licence": {"payload": {"clinic_id": "c-000047"'); // cut off mid-object
  });
  t.after(() => server.close());

  await assert.doesNotReject(runCheckin(db, dir, { endpoint }));
  assert.equal(readText(path.join(dir, 'licence.dat')), before);
});

test('a gigantic response is discarded by a size bound, not buffered forever', async (t) => {
  const { dir, db } = workspace({ licence: signedLicence() });
  const before = readText(path.join(dir, 'licence.dat'));

  const { server, endpoint } = await fakeServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // Well-formed JSON, but padded far past any real licence response's size.
    res.end(JSON.stringify({ licence: signedLicence(), subscription: 'active', collect: [], pad: 'x'.repeat(5000) }));
  });
  t.after(() => server.close());

  await assert.doesNotReject(runCheckin(db, dir, { endpoint, maxResponseBytes: 1000 }));
  assert.equal(readText(path.join(dir, 'licence.dat')), before, 'oversized response must be discarded, not partially applied');
});

// --- verification: a bad licence is discarded, the good one survives byte-for-byte

test('a licence for a different clinic_id is discarded; the existing licence survives byte-for-byte', async (t) => {
  const goodLicence = signedLicence({ clinic_id: 'c-000047' });
  const { dir, db } = workspace({ clinicId: 'c-000047', licence: goodLicence });
  const before = readText(path.join(dir, 'licence.dat'));

  const wrongClinicLicence = signedLicence({ clinic_id: 'some-other-clinic' });
  const { server, endpoint } = await fakeServer(jsonHandler(200, { licence: wrongClinicLicence, subscription: 'active', collect: [] }));
  t.after(() => server.close());

  await runCheckin(db, dir, { endpoint });

  const after = readText(path.join(dir, 'licence.dat'));
  assert.equal(after, before, 'the licence on disk must be byte-for-byte unchanged');
});

test('a licence signed with the wrong key is discarded; the existing licence survives byte-for-byte', async (t) => {
  const goodLicence = signedLicence();
  const { dir, db } = workspace({ licence: goodLicence });
  const before = readText(path.join(dir, 'licence.dat'));

  const { privateKey: wrongKey } = generateKeyPairSync('ed25519');
  const payload = { ...goodLicence.payload, nonce: 'different-nonce' };
  const forged = { payload, sig: sign(null, Buffer.from(canonical(payload), 'utf8'), wrongKey).toString('base64') };

  const { server, endpoint } = await fakeServer(jsonHandler(200, { licence: forged, subscription: 'active', collect: [] }));
  t.after(() => server.close());

  await runCheckin(db, dir, { endpoint });

  const after = readText(path.join(dir, 'licence.dat'));
  assert.equal(after, before, 'the licence on disk must be byte-for-byte unchanged');
});

test('a malformed licence object (missing payload) is discarded; existing licence untouched', async (t) => {
  const goodLicence = signedLicence();
  const { dir, db } = workspace({ licence: goodLicence });
  const before = readText(path.join(dir, 'licence.dat'));

  const { server, endpoint } = await fakeServer(jsonHandler(200, { licence: { sig: 'not-even-real' }, subscription: 'active', collect: [] }));
  t.after(() => server.close());

  await runCheckin(db, dir, { endpoint });
  assert.equal(readText(path.join(dir, 'licence.dat')), before);
});

// --- licence: null (unpaid) --------------------------------------------------

test('licence: null (unpaid): existing licence untouched, but subscription is updated to unpaid', async (t) => {
  const goodLicence = signedLicence();
  const { dir, db } = workspace({ subscription: 'active', licence: goodLicence });
  const before = readText(path.join(dir, 'licence.dat'));

  const { server, endpoint } = await fakeServer(jsonHandler(200, { licence: null, subscription: 'unpaid', collect: [] }));
  t.after(() => server.close());

  await runCheckin(db, dir, { endpoint });

  assert.equal(readText(path.join(dir, 'licence.dat')), before, 'no licence arrived, so none should be written');
  const identity = JSON.parse(readText(path.join(dir, 'control.json')));
  assert.equal(identity.subscription, 'unpaid', 'the money wording must reach the ladder');
});

// --- module_requests: only marked sent on success, never resent ------------

test('module_requests are marked sent_at only after a successful call, never on failure', async (t) => {
  const { dir, db } = workspace();
  const pending = seedModuleRequest(db, 'marketing');

  const { server, endpoint } = await fakeServer((req, res) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'internal' } }));
  });
  t.after(() => server.close());

  await runCheckin(db, dir, { endpoint });

  const row = db.prepare('SELECT sent_at FROM module_requests WHERE id = ?').get(pending.id);
  assert.equal(row.sent_at, null, 'a failed call must never mark a request as delivered');
});

test('a request already marked sent is not sent again on the next check-in', async (t) => {
  const { dir, db } = workspace();
  seedModuleRequest(db, 'crm');

  const { server: server1, endpoint: endpoint1 } = await fakeServer(
    jsonHandler(200, { licence: null, subscription: 'active', collect: [] }),
  );
  await runCheckin(db, dir, { endpoint: endpoint1 });
  server1.close();

  const { server: server2, endpoint: endpoint2 } = await fakeServer((req, res, body) => {
    assert.deepEqual(JSON.parse(body).module_requests, [], 'an already-delivered request must not be resent');
    jsonHandler(200, { licence: null, subscription: 'active', collect: [] })(req, res);
  });
  await runCheckin(db, dir, { endpoint: endpoint2 });
  server2.close();
});

// --- attack: clock is wrong / valid_until already in the past ---------------

test('a licence whose valid_until is already in the past is still verified and written (expiry is the ladder\'s job, not the client\'s)', async (t) => {
  const { dir, db } = workspace();
  const expired = signedLicence({ valid_until: '2000-01-01T00:00:00Z' });

  const { server, endpoint } = await fakeServer(jsonHandler(200, { licence: expired, subscription: 'active', collect: [] }));
  t.after(() => server.close());

  await runCheckin(db, dir, { endpoint });

  assert.deepEqual(JSON.parse(readText(path.join(dir, 'licence.dat'))), expired,
    'the client must not "helpfully" refuse a licence just because it looks already-expired');
});

// --- attack: write ordering when control.json is unwritable ----------------

test('if storing the subscription fails after the licence was written, the licence write survives', async (t) => {
  const { dir, db } = workspace({ subscription: 'active' });
  const licence = signedLicence();

  const { server, endpoint } = await fakeServer(jsonHandler(200, { licence, subscription: 'unpaid', collect: [] }));
  t.after(() => server.close());

  // Force ONLY the control.json rename to fail — licence.dat's rename uses
  // the real fs.renameSync untouched, so this isolates exactly the ordering
  // question the task asks about.
  const realRename = fs.renameSync;
  const flakyRename = (src, dest) => {
    if (String(dest).endsWith('control.json')) throw new Error('simulated: disk full writing control.json');
    return realRename(src, dest);
  };

  await assert.doesNotReject(runCheckin(db, dir, { endpoint, renameSync: flakyRename }));

  assert.deepEqual(JSON.parse(readText(path.join(dir, 'licence.dat'))), licence,
    'the functionally important write (the renewed licence) must survive a later failure storing subscription wording');
});

// --- attack: two check-ins overlapping --------------------------------------

test('two overlapping check-ins never produce two concurrent network calls', async (t) => {
  const { dir, db } = workspace();
  let inFlightCount = 0;
  let maxConcurrent = 0;

  const { server, state, endpoint } = await fakeServer((req, res) => {
    inFlightCount += 1;
    maxConcurrent = Math.max(maxConcurrent, inFlightCount);
    setTimeout(() => {
      inFlightCount -= 1;
      jsonHandler(200, { licence: null, subscription: 'active', collect: [] })(req, res);
    }, 80);
  });
  t.after(() => server.close());

  await Promise.all([
    runCheckin(db, dir, { endpoint }),
    runCheckin(db, dir, { endpoint }),
  ]);

  assert.equal(maxConcurrent, 1, 'only one of the two overlapping calls may ever reach the network at once');
  assert.equal(state.count, 1, 'the second, overlapping call must be a no-op, not a second request');
});

// --- attack: response is a JSON array, or a bare string, or a number -------

test('a JSON response that is not an object (array, string, number) is discarded, not crashed on', async (t) => {
  const { dir, db } = workspace({ licence: signedLicence() });
  const before = readText(path.join(dir, 'licence.dat'));

  for (const bogus of ['[]', '"just a string"', '42', 'null']) {
    const { server, endpoint } = await fakeServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(bogus);
    });
    await assert.doesNotReject(runCheckin(db, dir, { endpoint }));
    server.close();
  }
  assert.equal(readText(path.join(dir, 'licence.dat')), before);
});

// --- fingerprint: stability across enumeration order, reboots --------------

test('fingerprint is stable regardless of network interface enumeration order', () => {
  const ifacesA = {
    Ethernet: [{ internal: false, mac: '00:11:22:33:44:55' }],
    Loopback: [{ internal: true, mac: '00:00:00:00:00:00' }],
  };
  const ifacesB = {
    Loopback: [{ internal: true, mac: '00:00:00:00:00:00' }],
    Ethernet: [{ internal: false, mac: '00:11:22:33:44:55' }],
  };
  assert.equal(
    computeFingerprint({ hostname: 'clinic-pc', interfaces: ifacesA }),
    computeFingerprint({ hostname: 'clinic-pc', interfaces: ifacesB }),
  );
});

test('fingerprint is deterministic for the same machine info (stable across "reboots")', () => {
  const interfaces = { Ethernet: [{ internal: false, mac: 'AA:BB:CC:DD:EE:FF' }] };
  const fp1 = computeFingerprint({ hostname: 'clinic-pc', interfaces });
  const fp2 = computeFingerprint({ hostname: 'clinic-pc', interfaces });
  assert.equal(fp1, fp2);
});

test('fingerprint changes if the hostname or MAC genuinely changes (evidence, not a lock)', () => {
  const base = computeFingerprint({ hostname: 'clinic-pc', interfaces: { Ethernet: [{ internal: false, mac: 'AA:BB:CC:DD:EE:F0' }] } });
  const otherHost = computeFingerprint({ hostname: 'other-pc', interfaces: { Ethernet: [{ internal: false, mac: 'AA:BB:CC:DD:EE:F0' }] } });
  const otherMac = computeFingerprint({ hostname: 'clinic-pc', interfaces: { Ethernet: [{ internal: false, mac: 'AA:BB:CC:DD:EE:F1' }] } });
  assert.notEqual(base, otherHost);
  assert.notEqual(base, otherMac);
});

// KNOWN LIMITATION, documented rather than hidden: sorting by interface NAME
// makes REORDERING of the same adapter set a non-issue (the test above this
// comment), but it does not make ADDING a new adapter safe. A docked laptop
// gaining a wired adapter that sorts alphabetically ahead of the existing
// Wi-Fi adapter's name changes which MAC gets picked, and therefore the
// fingerprint. See this file's report for why that is acceptable here
// (fingerprint is evidence, never a lock — checkin.js's own header) but worth
// knowing about rather than assuming away.
test('KNOWN LIMITATION: adding a new adapter that sorts before the existing one changes the fingerprint', () => {
  const before = computeFingerprint({ hostname: 'clinic-pc', interfaces: { WiFi: [{ internal: false, mac: 'AA:AA:AA:AA:AA:AA' }] } });
  const afterDocking = computeFingerprint({
    hostname: 'clinic-pc',
    interfaces: {
      WiFi: [{ internal: false, mac: 'AA:AA:AA:AA:AA:AA' }],
      Ethernet: [{ internal: false, mac: 'BB:BB:BB:BB:BB:BB' }], // 'Ethernet' < 'WiFi' alphabetically
    },
  });
  assert.notEqual(before, afterDocking, 'documented: docking a laptop CAN change the fingerprint');
});

test('computeFingerprint works against the real OS info without throwing', () => {
  assert.doesNotThrow(() => computeFingerprint());
});

// --- checkinUrl ---------------------------------------------------------------

test('checkinUrl defaults to settings.easymed.uz', () => {
  assert.equal(checkinUrl({}), 'https://settings.easymed.uz/cp/v1/checkin');
});

test('checkinUrl honours EASYMED_CONTROL_URL, trimming a trailing slash', () => {
  assert.equal(checkinUrl({ EASYMED_CONTROL_URL: 'https://cp.example.com/' }), 'https://cp.example.com/cp/v1/checkin');
});

// --- checkinIntervalMs ------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

test('checkinIntervalMs defaults to 24h when the override is absent', () => {
  assert.equal(checkinIntervalMs({}), DAY_MS);
});

test('checkinIntervalMs honours EASYMED_CHECKIN_INTERVAL_MS (one hour)', () => {
  assert.equal(checkinIntervalMs({ EASYMED_CHECKIN_INTERVAL_MS: '3600000' }), 3_600_000);
});

test('checkinIntervalMs treats garbage as "a normal clinic", never "no check-ins"', () => {
  // Number('') and Number(null) are both 0 — the blank-string guard is what
  // keeps an empty env var from meaning "poll every minute" by accident.
  for (const bad of ['soon', '', '   ', '-5', '0', 'NaN', 'Infinity']) {
    assert.equal(checkinIntervalMs({ EASYMED_CHECKIN_INTERVAL_MS: bad }), DAY_MS, JSON.stringify(bad));
  }
});

test('checkinIntervalMs clamps below one minute up to one minute', () => {
  assert.equal(checkinIntervalMs({ EASYMED_CHECKIN_INTERVAL_MS: '1' }), 60_000);
});

test('checkinIntervalMs clamps above 24h down to 24h', () => {
  assert.equal(checkinIntervalMs({ EASYMED_CHECKIN_INTERVAL_MS: String(7 * DAY_MS) }), DAY_MS);
});

// --- scheduleCheckin: never holds the process open, never fires early ------

test('scheduleCheckin arms unref\'d timers and never calls run before the delay elapses', () => {
  const { dir, db } = workspace();
  let calls = 0;
  const { initial, interval } = scheduleCheckin(db, dir, {
    initialDelayMs: 10_000_000,
    intervalMs: 10_000_000,
    fetchImpl: async () => { calls += 1; throw new Error('should never be called in this test'); },
  });
  try {
    assert.equal(initial.hasRef(), false, 'the initial delay timer must not hold the process open');
    assert.equal(interval.hasRef(), false, 'the 24h interval timer must not hold the process open');
    assert.equal(calls, 0);
  } finally {
    clearTimeout(initial);
    clearInterval(interval);
  }
});

// --- Task 3 (docs/plans/2026-08-22-statistics.md): remembering the vendor's
//     collect list, and reporting stats from it on the NEXT check-in --------

test('a collect array in the response is remembered in control_state (stats_collect), for the next check-in to read', async (t) => {
  const { dir, db } = workspace();
  const { server, endpoint } = await fakeServer(
    jsonHandler(200, { licence: null, subscription: 'active', collect: ['patients_total', 'visits_today'] }),
  );
  t.after(() => server.close());

  await runCheckin(db, dir, { endpoint });

  const stored = db.prepare("SELECT value FROM control_state WHERE key = 'stats_collect'").get();
  assert.ok(stored, 'the collect list must be persisted so the NEXT check-in can read it');
  assert.deepEqual(JSON.parse(stored.value), ['patients_total', 'visits_today']);
});

test('storing the collect list drops non-strings and caps the length, rather than trusting the wire', async (t) => {
  const { dir, db } = workspace();
  const oversized = Array.from({ length: 60 }, (_, i) => `counter_${i}`);
  const mixed = [...oversized, 123, null, { not: 'a string' }, true];
  const { server, endpoint } = await fakeServer(
    jsonHandler(200, { licence: null, subscription: 'active', collect: mixed }),
  );
  t.after(() => server.close());

  await runCheckin(db, dir, { endpoint });

  const stored = JSON.parse(db.prepare("SELECT value FROM control_state WHERE key = 'stats_collect'").get().value);
  assert.equal(stored.length, 50, 'the stored list must be capped at 50 names');
  assert.ok(stored.every((n) => typeof n === 'string'), 'every stored entry must be a string — no number/null/object ever written');
  assert.deepEqual(stored, oversized.slice(0, 50));
});

test('a non-array collect field (missing, or the wrong shape) leaves any previously-stored collect list untouched', async (t) => {
  const { dir, db } = workspace();
  db.prepare(`INSERT INTO control_state (key, value) VALUES ('stats_collect', ?)`).run(JSON.stringify(['patients_total']));

  for (const bogus of [undefined, 'not-an-array', 42, { also: 'not an array' }]) {
    const body = { licence: null, subscription: 'active', collect: bogus };
    if (bogus === undefined) delete body.collect;
    const { server, endpoint } = await fakeServer(jsonHandler(200, body));
    await runCheckin(db, dir, { endpoint });
    server.close();
  }

  const stored = JSON.parse(db.prepare("SELECT value FROM control_state WHERE key = 'stats_collect'").get().value);
  assert.deepEqual(stored, ['patients_total'], 'a malformed/missing collect field must never overwrite a good, previously-learned list');
});

test('the next check-in builds and sends stats from the collect list learned on the previous one', async (t) => {
  const { dir, db } = workspace();

  // Check-in #1: learns the collect list. Nothing was stored before this
  // call, so stats must go out empty — there is nothing to report yet.
  const { server: server1, endpoint: endpoint1 } = await fakeServer((req, res, body) => {
    assert.deepEqual(JSON.parse(body).stats, {}, 'the very first check-in has nothing stored yet, so stats must be empty');
    jsonHandler(200, { licence: null, subscription: 'active', collect: ['patients_total'] })(req, res);
  });
  await runCheckin(db, dir, { endpoint: endpoint1 });
  server1.close();

  // A real patient row for patients_total to actually count.
  db.prepare("INSERT INTO patients (full_name) VALUES ('A'), ('B')").run();

  // Check-in #2: reports patients_total, and ONLY patients_total — the
  // catalogue's other names were never in the learned collect list.
  const { server: server2, endpoint: endpoint2 } = await fakeServer((req, res, body) => {
    const parsed = JSON.parse(body);
    assert.deepEqual(parsed.stats, { patients_total: 2 });
    jsonHandler(200, { licence: null, subscription: 'active', collect: ['patients_total'] })(req, res);
  });
  await runCheckin(db, dir, { endpoint: endpoint2 });
  server2.close();
});

test('a stats builder that throws never blocks the check-in — the licence still renews (licensing outranks telemetry)', async (t) => {
  const { dir, db } = workspace();
  const licence = signedLicence();

  const { server, endpoint } = await fakeServer((req, res, body) => {
    const parsed = JSON.parse(body);
    assert.equal(typeof parsed.stats, 'object', 'a thrown builder must still leave `stats` as a safe, sendable value, never absent-and-crashing');
    jsonHandler(200, { licence, subscription: 'active', collect: [] })(req, res);
  });
  t.after(() => server.close());

  const throwingBuilder = () => { throw new Error('catalogue exploded'); };
  await assert.doesNotReject(runCheckin(db, dir, { endpoint, buildStatsPayload: throwingBuilder }));

  assert.deepEqual(JSON.parse(readText(path.join(dir, 'licence.dat'))), licence,
    'THE RULE THAT OUTRANKS EVERYTHING — a throwing stats catalogue must never cost the clinic its licence renewal');
});

test('a hand-corrupted stats_collect value in control_state is ignored, not a crash — falls back to sending no names', async (t) => {
  const { dir, db } = workspace();
  db.prepare(`INSERT INTO control_state (key, value) VALUES ('stats_collect', 'not json')`).run();

  const { server, endpoint } = await fakeServer((req, res, body) => {
    assert.deepEqual(JSON.parse(body).stats, {}, 'corrupt stored names must fall back to an empty request, never a throw');
    jsonHandler(200, { licence: null, subscription: 'active', collect: [] })(req, res);
  });
  t.after(() => server.close());

  await assert.doesNotReject(runCheckin(db, dir, { endpoint }));
});

// --- acceptance: real control plane, end to end -----------------------------

test('acceptance: a module granted in the control plane reaches the clinic on the next check-in', async (t) => {
  const registryDb = openCpDb(':memory:');
  migrateCp(registryDb);

  const { publicKey: vendorPublicKey, privateKey: vendorPrivateKey } = generateKeyPairSync('ed25519');
  const keyDir = tmpDir('em-checkin-key-');
  const keyPath = path.join(keyDir, 'vendor-private.pem');
  fs.writeFileSync(keyPath, vendorPrivateKey.export({ type: 'pkcs8', format: 'pem' }));
  process.env.EASYMED_SIGNING_KEY = keyPath;
  t.after(() => { delete process.env.EASYMED_SIGNING_KEY; });

  __setPublicKeyForTests(vendorPublicKey);        // checkin.js's own verifier
  __setStatePublicKeyForTests(vendorPublicKey);    // the clinic app's own verifier, for the final assertion

  const cpApp = createCpApp(registryDb);
  const cpServer = await new Promise((resolve) => {
    const s = cpApp.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => cpServer.close());
  const cpEndpoint = `http://127.0.0.1:${cpServer.address().port}`;

  // 1. Enrol a clinic on the real control-plane database, grant it crm.
  const clinicId = 'c-accept-1';
  const code = createEnrollmentCode(registryDb, { clinicId, name: 'Приёмка Тест' });
  const enrolled = redeemEnrollmentCode(registryDb, { code });
  registryDb.prepare('INSERT INTO clinic_modules (clinic_id, module_key) VALUES (?, ?)').run(clinicId, 'crm');

  // 2. Write the enrollment response into a temp dir, as a clinic would.
  const dataDir = tmpDir('em-checkin-accept-');
  fs.writeFileSync(path.join(dataDir, 'control.json'), JSON.stringify({
    clinic_id: enrolled.clinic_id,
    clinic_name: enrolled.clinic_name,
    install_token: enrolled.install_token,
    unlock_secret: enrolled.unlock_secret,
    subscription: enrolled.subscription,
  }));
  const clinicDb = openDb(':memory:');
  migrate(clinicDb);

  // 3. Run the check-in client against the real endpoint.
  await runCheckin(clinicDb, dataDir, { endpoint: cpEndpoint });

  // 4. controlState now reports unlocked with ['crm'].
  const state1 = controlState(clinicDb, dataDir);
  assert.equal(state1.locked, false, 'the clinic must be unlocked after the first real check-in');
  assert.deepEqual(state1.modules, ['crm']);

  // 5. Grant telegram in the control-plane database, run check-in again —
  //    the whole point of the feature: no file carried by hand.
  registryDb.prepare('INSERT INTO clinic_modules (clinic_id, module_key) VALUES (?, ?)').run(clinicId, 'telegram');
  await runCheckin(clinicDb, dataDir, { endpoint: cpEndpoint });

  const state2 = controlState(clinicDb, dataDir);
  assert.equal(state2.locked, false);
  assert.deepEqual([...state2.modules].sort(), ['crm', 'telegram'],
    'granting a module in the panel must reach the clinic on the very next check-in, unattended');
});

// --- UPDATE_DELIVERY_V1: the offer arriving, and the outcome leaving --------

function controlStateGet(db, key) {
  return db.prepare('SELECT value FROM control_state WHERE key = ?').get(key)?.value ?? null;
}

const UPDATE_OFFER = { version: '2.4.0', notes_ru: 'Тест', url: '/x.tar.gz', sha256: 'abc', manifest: { payload: {}, sig: 's' } };

test('an update offer in the response is stored in control_state', async (t) => {
  const { dir, db } = workspace();
  const { server, endpoint } = await fakeServer(jsonHandler(200, { licence: null, subscription: 'active', collect: [], update: UPDATE_OFFER }));
  t.after(() => server.close());
  await runCheckin(db, dir, { endpoint });
  assert.deepEqual(JSON.parse(controlStateGet(db, 'update_offer')), UPDATE_OFFER);
});

test('an explicit null update clears a previously stored offer', async (t) => {
  const { dir, db } = workspace();
  db.prepare(`INSERT INTO control_state (key, value) VALUES ('update_offer', ?)`).run(JSON.stringify(UPDATE_OFFER));

  const { server, endpoint } = await fakeServer(jsonHandler(200, { licence: null, subscription: 'active', collect: [], update: null }));
  t.after(() => server.close());
  await runCheckin(db, dir, { endpoint });
  assert.equal(controlStateGet(db, 'update_offer'), null, 'a clinic already on the latest version must not keep showing a stale offer');
});

test('a response with no `update` key at all leaves a previously stored offer untouched (back-compat)', async (t) => {
  const { dir, db } = workspace();
  db.prepare(`INSERT INTO control_state (key, value) VALUES ('update_offer', ?)`).run(JSON.stringify(UPDATE_OFFER));

  const { server, endpoint } = await fakeServer(jsonHandler(200, { licence: null, subscription: 'active', collect: [] }));
  t.after(() => server.close());
  await runCheckin(db, dir, { endpoint });
  assert.deepEqual(JSON.parse(controlStateGet(db, 'update_offer')), UPDATE_OFFER);
});

test('a malformed update field (wrong shape) is ignored, keeping whatever offer was already on file', async (t) => {
  const { dir, db } = workspace();
  db.prepare(`INSERT INTO control_state (key, value) VALUES ('update_offer', ?)`).run(JSON.stringify(UPDATE_OFFER));

  const { server, endpoint } = await fakeServer(jsonHandler(200, { licence: null, subscription: 'active', collect: [], update: 'not an object' }));
  t.after(() => server.close());
  await runCheckin(db, dir, { endpoint });
  assert.deepEqual(JSON.parse(controlStateGet(db, 'update_offer')), UPDATE_OFFER, 'garbage must never overwrite a good stored offer');
});

test('an update-result.json is attached to the next request, and renamed .sent after a successful send', async (t) => {
  const { dir, db } = workspace();
  fs.writeFileSync(path.join(dir, 'update-result.json'), JSON.stringify({ version: '2.4.0', ok: true }));

  let receivedUpdateResult;
  const { server, endpoint } = await fakeServer((req, res, body) => {
    receivedUpdateResult = JSON.parse(body).update_result;
    jsonHandler(200, { licence: null, subscription: 'active', collect: [] })(req, res);
  });
  t.after(() => server.close());
  await runCheckin(db, dir, { endpoint });

  assert.deepEqual(receivedUpdateResult, { version: '2.4.0', ok: true });
  assert.equal(fs.existsSync(path.join(dir, 'update-result.json')), false, 'the live file is gone — renamed, not duplicated');
  assert.deepEqual(JSON.parse(readText(path.join(dir, 'update-result.json.sent'))), { version: '2.4.0', ok: true });
});

test('a second check-in after the rename sends nothing — a result reaches the vendor exactly once', async (t) => {
  const { dir, db } = workspace();
  fs.writeFileSync(path.join(dir, 'update-result.json'), JSON.stringify({ version: '2.4.0', ok: true }));

  let calls = 0;
  const { server, endpoint } = await fakeServer((req, res, body) => {
    calls += 1;
    const parsed = JSON.parse(body);
    if (calls === 1) assert.ok(parsed.update_result, 'first call carries it');
    else assert.equal(parsed.update_result, undefined, 'second call must carry nothing — already sent');
    jsonHandler(200, { licence: null, subscription: 'active', collect: [] })(req, res);
  });
  t.after(() => server.close());

  await runCheckin(db, dir, { endpoint });
  await runCheckin(db, dir, { endpoint });
  assert.equal(calls, 2);
});

test('no update-result.json at all: the field is simply absent, no crash', async (t) => {
  const { dir, db } = workspace();
  let received;
  const { server, endpoint } = await fakeServer((req, res, body) => {
    received = JSON.parse(body);
    jsonHandler(200, { licence: null, subscription: 'active', collect: [] })(req, res);
  });
  t.after(() => server.close());
  await runCheckin(db, dir, { endpoint });
  assert.equal(received.update_result, undefined);
});

test('a corrupt update-result.json is never attached and never crashes the check-in', async (t) => {
  const { dir, db } = workspace();
  fs.writeFileSync(path.join(dir, 'update-result.json'), '{ not valid json');
  let received;
  const { server, endpoint } = await fakeServer((req, res, body) => {
    received = JSON.parse(body);
    jsonHandler(200, { licence: null, subscription: 'active', collect: [] })(req, res);
  });
  t.after(() => server.close());
  await assert.doesNotReject(runCheckin(db, dir, { endpoint }));
  assert.equal(received.update_result, undefined);
});

test('update-result.json is NOT renamed when the control plane cannot be reached — it survives for tomorrow', async () => {
  const { dir, db } = workspace();
  fs.writeFileSync(path.join(dir, 'update-result.json'), JSON.stringify({ version: '2.4.0', ok: true }));

  const { server, endpoint } = await fakeServer(() => {});
  await new Promise((r) => server.close(r)); // nothing listening

  await runCheckin(db, dir, { endpoint });
  assert.ok(fs.existsSync(path.join(dir, 'update-result.json')), 'a failed send must never rename the file — it has not reached the vendor');
  assert.equal(fs.existsSync(path.join(dir, 'update-result.json.sent')), false);
});

test('update-result.json is NOT renamed on a non-2xx response', async (t) => {
  const { dir, db } = workspace();
  fs.writeFileSync(path.join(dir, 'update-result.json'), JSON.stringify({ version: '2.4.0', ok: false }));

  const { server, endpoint } = await fakeServer((req, res) => { res.writeHead(500); res.end('{}'); });
  t.after(() => server.close());

  await runCheckin(db, dir, { endpoint });
  assert.ok(fs.existsSync(path.join(dir, 'update-result.json')), 'a server error means the vendor never durably recorded it — retry tomorrow');
  assert.equal(fs.existsSync(path.join(dir, 'update-result.json.sent')), false);
});

// --- Task 3 acceptance: the vendor ticks counters, the clinic reports the
//     numbers, and no patient data ever reaches the control plane — the
//     owner's own instruction, proven at the far end of the real wire -------

test('acceptance: vendor sets a collect subset, two check-ins later the numbers arrive, and the ZZTESTPATIENT marker is absent from every control-plane table', async (t) => {
  const MARKER = 'ZZTESTPATIENT_UNIQUE_9Q4';

  const registryDb = openCpDb(':memory:');
  migrateCp(registryDb);

  // Own throwaway signing key AND its own public-key override for both
  // verifier seams — never assume the module-level key from the top of this
  // file is still installed; restored in t.after so nothing after this test
  // (were one ever added) inherits this test's key by accident.
  const { publicKey: vendorPublicKey, privateKey: vendorPrivateKey } = generateKeyPairSync('ed25519');
  const keyDir = tmpDir('em-checkin-stats-key-');
  const keyPath = path.join(keyDir, 'vendor-private.pem');
  fs.writeFileSync(keyPath, vendorPrivateKey.export({ type: 'pkcs8', format: 'pem' }));
  process.env.EASYMED_SIGNING_KEY = keyPath;
  __setPublicKeyForTests(vendorPublicKey);
  __setStatePublicKeyForTests(vendorPublicKey);
  t.after(() => {
    delete process.env.EASYMED_SIGNING_KEY;
    __setPublicKeyForTests(publicKey);
    __setStatePublicKeyForTests(publicKey);
  });

  const cpApp = createCpApp(registryDb);
  const cpServer = await new Promise((resolve) => {
    const s = cpApp.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => cpServer.close());
  const cpEndpoint = `http://127.0.0.1:${cpServer.address().port}`;

  // A vendor account + a logged-in session cookie — exactly how the panel
  // itself would authenticate before calling the admin API.
  registryDb.prepare('INSERT INTO vendor_users (username, password_hash, full_name) VALUES (?,?,?)')
    .run('vendor', hashPassword('secret123'), 'Test Vendor');
  const loginRes = await fetch(`${cpEndpoint}/cp/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'vendor', password: 'secret123' }),
  });
  assert.equal(loginRes.status, 200, 'sanity check: vendor login must succeed for this harness');
  const setCookie = loginRes.headers.getSetCookie ? loginRes.headers.getSetCookie() : [loginRes.headers.get('set-cookie')];
  const cookie = setCookie.map((c) => c.split(';')[0]).join('; ');

  // --- 1. Enrol a clinic; seed its CLINIC-SIDE db with a marker patient, ---
  //        an invoice and payments.
  const clinicId = 'c-stats-accept-1';
  const code = createEnrollmentCode(registryDb, { clinicId, name: 'Статистика Тест' });
  const enrolled = redeemEnrollmentCode(registryDb, { code });

  const dataDir = tmpDir('em-checkin-stats-');
  fs.writeFileSync(path.join(dataDir, 'control.json'), JSON.stringify({
    clinic_id: enrolled.clinic_id,
    clinic_name: enrolled.clinic_name,
    install_token: enrolled.install_token,
    unlock_secret: enrolled.unlock_secret,
    subscription: enrolled.subscription,
  }));
  const clinicDb = openDb(':memory:');
  migrate(clinicDb);

  const pid = clinicDb.prepare('INSERT INTO patients (full_name, phone) VALUES (?, ?)')
    .run(`Иванов ${MARKER} Иван`, `+998${MARKER}`).lastInsertRowid;
  const inv = clinicDb.prepare("INSERT INTO invoices (patient_id, total_amount, paid_amount, status) VALUES (?,1500,1500,'paid')")
    .run(pid).lastInsertRowid;
  clinicDb.prepare("INSERT INTO payments (invoice_id, amount, method) VALUES (?,1500,'cash')").run(inv);

  // --- 2. Vendor sets collect_set to a subset via the admin API -----------
  const subset = ['patients_total', 'billed_today'];
  assert.ok(subset.every((n) => COUNTER_NAMES.includes(n)), 'sanity: the subset must be real catalogue names');
  const collectRes = await fetch(`${cpEndpoint}/cp/v1/admin/clinics/${clinicId}/collect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ names: subset }),
  });
  assert.equal(collectRes.status, 200, 'setting a valid collect subset must succeed');

  // --- 3. Clinic check-in #1 (learns the set) and #2 (reports) -----------
  await runCheckin(clinicDb, dataDir, { endpoint: cpEndpoint });
  const learned = JSON.parse(clinicDb.prepare("SELECT value FROM control_state WHERE key = 'stats_collect'").get().value);
  assert.deepEqual(learned.slice().sort(), subset.slice().sort(), 'the first check-in must learn exactly the vendor-picked subset');

  await runCheckin(clinicDb, dataDir, { endpoint: cpEndpoint });

  // --- 4. Admin API now shows latest_stats with the right keys -----------
  const detailRes = await fetch(`${cpEndpoint}/cp/v1/admin/clinics/${clinicId}`, { headers: { Cookie: cookie } });
  assert.equal(detailRes.status, 200);
  const detail = await detailRes.json();
  assert.ok(detail.clinic.latest_stats, 'the clinic must show reported stats after its second check-in');
  assert.deepEqual(Object.keys(detail.clinic.latest_stats).sort(), subset.slice().sort());
  assert.equal(detail.clinic.latest_stats.patients_total, 1, 'exactly the one seeded patient — never the marker itself');
  assert.equal(typeof detail.clinic.latest_stats.billed_today, 'number');
  assert.ok(Number.isFinite(detail.clinic.latest_stats.billed_today) && detail.clinic.latest_stats.billed_today >= 0,
    'a plausible (finite, non-negative) number, not NaN or a string');
  assert.ok(detail.clinic.latest_stats_at, 'a timestamp for when these numbers were reported');
  assert.deepEqual(detail.clinic.collect_set, subset);

  // --- 5. Dump EVERY control-plane table; the marker must appear NOWHERE --
  const tables = registryDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all().map((r) => r.name);
  const dump = {};
  for (const tableName of tables) {
    dump[tableName] = registryDb.prepare(`SELECT * FROM "${tableName}"`).all();
  }
  const dumpJson = JSON.stringify(dump);
  assert.ok(!dumpJson.includes(MARKER),
    `THE OWNER'S OWN INSTRUCTION — the marker leaked into the control plane's own database: ${dumpJson.slice(0, 2000)}`);

  // --- 6. A clinic whose stats builder throws still gets its licence -----
  //        renewed on that SAME check-in, against this SAME real control
  //        plane — "licensing outranks telemetry" proven end to end, not
  //        just against a fake server.
  const throwingClinicId = 'c-stats-accept-throws';
  const throwingCode = createEnrollmentCode(registryDb, { clinicId: throwingClinicId, name: 'Клиника с плохой статистикой' });
  const throwingEnrolled = redeemEnrollmentCode(registryDb, { code: throwingCode });
  const throwingDir = tmpDir('em-checkin-stats-throws-');
  fs.writeFileSync(path.join(throwingDir, 'control.json'), JSON.stringify({
    clinic_id: throwingEnrolled.clinic_id,
    clinic_name: throwingEnrolled.clinic_name,
    install_token: throwingEnrolled.install_token,
    unlock_secret: throwingEnrolled.unlock_secret,
    subscription: throwingEnrolled.subscription,
  }));
  const throwingClinicDb = openDb(':memory:');
  migrate(throwingClinicDb);

  await assert.doesNotReject(runCheckin(throwingClinicDb, throwingDir, {
    endpoint: cpEndpoint,
    buildStatsPayload: () => { throw new Error('catalogue exploded, for real this time'); },
  }));

  const throwingState = controlState(throwingClinicDb, throwingDir);
  assert.equal(throwingState.locked, false,
    'a throwing stats builder must never cost this clinic its licence renewal, even against the real control plane');
});

// --- readJsonFile: the BOM the retired PowerShell apply wrote -----------------
//
// Nothing WRITES a BOM any more (updater.js's writeOutcome is Node), but files
// the old apply-update.ps1 produced still sit in clinics' data\ folders — a
// clinic updating from one of those versions must be able to read the outcome
// of its own last update, so the reader can never stop stripping it.

test('readJsonFile: parses a file written WITH a UTF-8 BOM — what the retired PowerShell apply left on clinic disks', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-bom-'));
  const file = path.join(dir, 'update-result.json');
  // ﻿ prefix = exactly what PowerShell 5.1's Out-File wrote by default.
  fs.writeFileSync(file, '﻿' + JSON.stringify({ version: '1.2.3', ok: true }), 'utf8');
  // Proof the naive read this replaced could not do it:
  assert.throws(() => JSON.parse(fs.readFileSync(file, 'utf8')));
  const parsed = readJsonFile(file);
  assert.equal(parsed.version, '1.2.3');
  assert.equal(parsed.ok, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readJsonFile: plain JSON with no BOM still works', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-bom-'));
  const file = path.join(dir, 'x.json');
  fs.writeFileSync(file, JSON.stringify({ a: 1 }), 'utf8');
  assert.deepEqual(readJsonFile(file), { a: 1 });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readJsonFile: missing, corrupt, or non-object content is null — never a throw on a status path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-bom-'));
  assert.equal(readJsonFile(path.join(dir, 'nope.json')), null);
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, '{ not json');
  assert.equal(readJsonFile(bad), null);
  const arr = path.join(dir, 'arr.json');
  fs.writeFileSync(arr, '[1,2,3]');
  assert.equal(readJsonFile(arr), null, 'an array is not an outcome object');
  fs.rmSync(dir, { recursive: true, force: true });
});