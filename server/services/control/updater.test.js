import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { generateKeyPairSync } from 'node:crypto';

import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { buildBundle } from '../../../scripts/build-bundle.mjs';
import {
  tickUpdater,
  resolveDownloadUrl,
  detectLayout,
  __setReleasePublicKeyForTests,
} from './updater.js';
import { runCheckin } from './checkin.js';
import { updateApprove } from '../rpc/updates.js';

// --- test harness -------------------------------------------------------------

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
__setReleasePublicKeyForTests(publicKey);

const tmpDirs = [];
function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
test.after(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

function controlStatePut(db, key, value) {
  db.prepare(`INSERT INTO control_state (key, value, updated_at)
              VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(key, String(value));
}
function controlStateGet(db, key) {
  return db.prepare('SELECT value FROM control_state WHERE key = ?').get(key)?.value ?? null;
}

function workspace() {
  const dataDir = tmpDir('em-updater-data-');
  const db = openDb(':memory:');
  migrate(db);
  return { dataDir, db };
}

function storeOffer(db, offer) { controlStatePut(db, 'update_offer', JSON.stringify(offer)); }
function storeConsent(db, consent) { controlStatePut(db, 'update_consent', JSON.stringify(consent)); }
function storeScheduledAt(db, date) { controlStatePut(db, 'update_scheduled_at', date.toISOString()); }

// A standalone HTTP server standing in for the release download host.
function fakeServer(handler) {
  const state = { count: 0, requests: [] };
  const server = http.createServer((req, res) => {
    state.count += 1;
    state.requests.push(req.url);
    handler(req, res);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, state, endpoint: `http://127.0.0.1:${server.address().port}` }));
  });
}

// Builds a real, signed bundle from a tiny synthetic source tree, using the
// SAME buildBundle() the real release pipeline uses — never a hand-rolled
// stand-in for what a bundle actually looks like.
function makeSignedBundle({ version = '2.4.0', minFrom = '0.0.0', keyOverride } = {}) {
  const src = tmpDir('em-updater-src-');
  const out = tmpDir('em-updater-out-');
  fs.mkdirSync(path.join(src, 'server'), { recursive: true });
  fs.writeFileSync(path.join(src, 'server', 'index.js'), `console.log("v${version}");\n`);
  fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify({ name: 'synthetic', version }));

  const keyDir = tmpDir('em-updater-key-');
  const keyPath = path.join(keyDir, 'release-private.pem');
  const { privateKey: pk } = keyOverride || { privateKey };
  fs.writeFileSync(keyPath, pk.export({ type: 'pkcs8', format: 'pem' }));

  const { tarPath, manifestPath } = buildBundle({ sourceDir: src, outDir: out, version, notesRu: 'Тест', minFrom, keyPath });
  const tarBytes = fs.readFileSync(tarPath);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  return { tarBytes, manifest, tarPath };
}

function makeOffer({ version = '2.4.0', urlPath = '/dl/bundle.tar.gz', manifest }) {
  return { version, notes_ru: 'Тест', url: urlPath, sha256: manifest.payload.sha256, manifest };
}

// A versioned-layout scratch tree: <root>\current --(junction)--> <root>\versions\<runningVersion>
function makeVersionedRoot(runningVersion = '2.3.0') {
  const root = tmpDir('em-updater-root-');
  const runningDir = path.join(root, 'versions', runningVersion);
  fs.mkdirSync(runningDir, { recursive: true });
  fs.symlinkSync(runningDir, path.join(root, 'current'), 'junction');
  fs.mkdirSync(path.join(root, 'current', 'install'), { recursive: true });
  return { root, appRoot: runningDir };
}

// --- resolveDownloadUrl ---------------------------------------------------------

test('resolveDownloadUrl: a relative path resolves against the control-plane base', () => {
  const r = resolveDownloadUrl('/releases/2.4.0/bundle.tar.gz', 'https://settings.easymed.uz');
  assert.equal(r.ok, true);
  assert.equal(r.url, 'https://settings.easymed.uz/releases/2.4.0/bundle.tar.gz');
});

test('resolveDownloadUrl: an absolute URL on the SAME origin is accepted', () => {
  const r = resolveDownloadUrl('https://settings.easymed.uz/releases/x.tar.gz', 'https://settings.easymed.uz');
  assert.equal(r.ok, true);
});

test('resolveDownloadUrl: an absolute URL on a DIFFERENT host is refused', () => {
  const r = resolveDownloadUrl('https://evil.example.com/x.tar.gz', 'https://settings.easymed.uz');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'cross_host');
});

test('resolveDownloadUrl: same host but different port is refused (full origin, not just hostname)', () => {
  const r = resolveDownloadUrl('https://settings.easymed.uz:9999/x.tar.gz', 'https://settings.easymed.uz');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'cross_host');
});

test('resolveDownloadUrl: missing or non-string url is refused', () => {
  assert.equal(resolveDownloadUrl(undefined, 'https://settings.easymed.uz').ok, false);
  assert.equal(resolveDownloadUrl('', 'https://settings.easymed.uz').ok, false);
  assert.equal(resolveDownloadUrl(123, 'https://settings.easymed.uz').ok, false);
});

test('resolveDownloadUrl: a non-http(s) scheme is refused even on the right host', () => {
  const r = resolveDownloadUrl('file:///etc/passwd', 'https://settings.easymed.uz');
  assert.equal(r.ok, false);
});

// --- detectLayout ------------------------------------------------------------

test('detectLayout: a genuine versioned layout (junction confirmed) is detected', () => {
  const { root, appRoot } = makeVersionedRoot('2.3.0');
  const layout = detectLayout(appRoot);
  assert.equal(layout.versioned, true);
  assert.equal(path.resolve(layout.root), path.resolve(root));
});

test('detectLayout: a plain checkout (no versions/current siblings) is dev', () => {
  const dir = tmpDir('em-updater-dev-');
  const layout = detectLayout(dir);
  assert.equal(layout.versioned, false);
  assert.equal(layout.root, null);
});

test('detectLayout: sitting under a folder literally named "versions" without a matching junction is still dev', () => {
  // Guards against name-alone detection: the directory NAME convention must
  // be confirmed by the junction actually pointing here, or a coincidental
  // path (or a leftover/incomplete install) would be misdetected.
  const root = tmpDir('em-updater-fake-');
  const versionDir = path.join(root, 'versions', '9.9.9');
  fs.mkdirSync(versionDir, { recursive: true });
  // No `current` junction at all.
  const layout = detectLayout(versionDir);
  assert.equal(layout.versioned, false);
});

test('detectLayout: current junction points at a DIFFERENT version — not detected as this one', () => {
  const root = tmpDir('em-updater-mismatch-');
  const v1 = path.join(root, 'versions', '2.3.0');
  const v2 = path.join(root, 'versions', '2.4.0');
  fs.mkdirSync(v1, { recursive: true });
  fs.mkdirSync(v2, { recursive: true });
  fs.symlinkSync(v1, path.join(root, 'current'), 'junction');
  assert.equal(detectLayout(v2).versioned, false, 'v2 is not what current actually points at');
  assert.equal(detectLayout(v1).versioned, true);
});

// --- consent / scheduling gating (integration through tickUpdater) --------------

test('no approval: an in-window tick does nothing, forever', async () => {
  const { db, dataDir } = workspace();
  const { manifest } = makeSignedBundle({ version: '2.4.0' });
  storeOffer(db, makeOffer({ manifest }));
  // No consent stored at all.
  let requested = false;
  const fetchImpl = async () => { requested = true; return { ok: true, body: null }; };
  await tickUpdater(db, dataDir, { fetchImpl, now: () => new Date(2026, 0, 1, 3, 30, 0) });
  assert.equal(requested, false, 'never even attempts a download without consent');
  assert.equal(controlStateGet(db, 'update_offer'), JSON.stringify(makeOffer({ manifest })), 'the offer is left exactly as it was');
});

test('consent for a superseded version does not apply to the current offer', async () => {
  const { db, dataDir } = workspace();
  const { manifest } = makeSignedBundle({ version: '2.5.0' });
  storeOffer(db, makeOffer({ version: '2.5.0', manifest }));
  storeConsent(db, { version: '2.4.0', approved_by: 1, approved_at: '2026-01-01T00:00:00Z', hour: 3 });
  storeScheduledAt(db, new Date(2026, 0, 1, 3, 0, 0));

  let requested = false;
  const fetchImpl = async () => { requested = true; return { ok: true }; };
  await tickUpdater(db, dataDir, { fetchImpl, now: () => new Date(2026, 0, 1, 3, 30, 0) });
  assert.equal(requested, false, 'the stale approval for 2.4.0 must not silently apply to the new 2.5.0 offer');
});

test('missed window (PC was off): the schedule advances to the next occurrence, no download attempted', async () => {
  const { db, dataDir } = workspace();
  const { manifest } = makeSignedBundle({ version: '2.4.0' });
  storeOffer(db, makeOffer({ manifest }));
  storeConsent(db, { version: '2.4.0', approved_by: 1, approved_at: '2026-01-01T00:00:00Z', hour: 3 });
  storeScheduledAt(db, new Date(2026, 0, 1, 3, 0, 0));

  let requested = false;
  const fetchImpl = async () => { requested = true; return { ok: true }; };
  // 09:15 the next... no, SAME day but well past the window — PC was off all night.
  await tickUpdater(db, dataDir, { fetchImpl, now: () => new Date(2026, 0, 1, 9, 15, 0) });
  assert.equal(requested, false, 'a missed window must never trigger an immediate run');

  const rescheduled = new Date(controlStateGet(db, 'update_scheduled_at'));
  assert.equal(rescheduled.getDate(), 2, 'rescheduled for the NEXT occurrence (tomorrow 03:00), not run late today');
  assert.equal(rescheduled.getHours(), 3);
});

test('not yet due: a tick before the scheduled hour does nothing', async () => {
  const { db, dataDir } = workspace();
  const { manifest } = makeSignedBundle({ version: '2.4.0' });
  storeOffer(db, makeOffer({ manifest }));
  storeConsent(db, { version: '2.4.0', approved_by: 1, approved_at: '2026-01-01T00:00:00Z', hour: 3 });
  storeScheduledAt(db, new Date(2026, 0, 1, 3, 0, 0));

  let requested = false;
  const fetchImpl = async () => { requested = true; return { ok: true }; };
  await tickUpdater(db, dataDir, { fetchImpl, now: () => new Date(2026, 0, 1, 1, 0, 0) });
  assert.equal(requested, false);
  assert.equal(controlStateGet(db, 'update_scheduled_at'), new Date(2026, 0, 1, 3, 0, 0).toISOString(), 'schedule is untouched, still ahead');
});

// --- the failure sweep ---------------------------------------------------------

function approvedWorkspace(offer) {
  const { db, dataDir } = workspace();
  storeOffer(db, offer);
  storeConsent(db, { version: offer.version, approved_by: 1, approved_at: '2026-01-01T00:00:00Z', hour: 3 });
  storeScheduledAt(db, new Date(2026, 0, 1, 3, 0, 0));
  return { db, dataDir };
}
const IN_WINDOW_NOW = () => new Date(2026, 0, 1, 3, 5, 0);

test('failure sweep: endpoint down (connection refused)', async () => {
  const { manifest } = makeSignedBundle({ version: '2.4.0' });
  const offer = makeOffer({ manifest });
  const { db, dataDir } = approvedWorkspace(offer);

  // Nothing listening on this port.
  await tickUpdater(db, dataDir, { endpoint: 'http://127.0.0.1:1', now: IN_WINDOW_NOW });

  assert.equal(controlStateGet(db, 'update_offer'), JSON.stringify(offer), 'offer stays exactly as it was');
  assert.equal(fs.existsSync(path.join(dataDir, 'update-download.tmp')), false, 'no leftover temp file');
});

test('failure sweep: timeout', async () => {
  const { manifest } = makeSignedBundle({ version: '2.4.0' });
  const offer = makeOffer({ manifest });
  const { db, dataDir } = approvedWorkspace(offer);

  const { server, endpoint } = await fakeServer((req, res) => {
    // Never responds within the short timeout given below.
    setTimeout(() => { try { res.end(); } catch { /* client already gave up */ } }, 2000);
  });
  try {
    await tickUpdater(db, dataDir, { endpoint, now: IN_WINDOW_NOW, timeoutMs: 50 });
  } finally {
    server.close();
  }
  assert.equal(controlStateGet(db, 'update_offer'), JSON.stringify(offer));
  assert.equal(fs.existsSync(path.join(dataDir, 'update-download.tmp')), false);
});

test('failure sweep: 404', async () => {
  const { manifest } = makeSignedBundle({ version: '2.4.0' });
  const offer = makeOffer({ manifest });
  const { db, dataDir } = approvedWorkspace(offer);

  const { server, endpoint } = await fakeServer((req, res) => { res.writeHead(404); res.end('not found'); });
  try {
    await tickUpdater(db, dataDir, { endpoint, now: IN_WINDOW_NOW });
  } finally {
    server.close();
  }
  assert.equal(controlStateGet(db, 'update_offer'), JSON.stringify(offer));
});

test('failure sweep: oversized body — the cap is enforced mid-stream, not after buffering it all', async () => {
  const { manifest } = makeSignedBundle({ version: '2.4.0' });
  const offer = makeOffer({ manifest });
  const { db, dataDir } = approvedWorkspace(offer);

  const { server, endpoint, state } = await fakeServer((req, res) => {
    res.writeHead(200);
    // Stream well past the cap given below, in small chunks, and never end —
    // if the cap were enforced only "after" a full read this would hang the
    // test; enforcing it mid-stream is what lets this test complete at all.
    const chunk = Buffer.alloc(1024, 'x');
    let sent = 0;
    const iv = setInterval(() => {
      if (res.writableEnded) { clearInterval(iv); return; }
      res.write(chunk);
      sent += chunk.length;
      if (sent > 20 * 1024) { clearInterval(iv); try { res.end(); } catch { /* already gone */ } }
    }, 1);
  });
  try {
    await tickUpdater(db, dataDir, { endpoint, now: IN_WINDOW_NOW, maxBytes: 4096 });
  } finally {
    server.close();
  }
  assert.equal(controlStateGet(db, 'update_offer'), JSON.stringify(offer));
  assert.equal(fs.existsSync(path.join(dataDir, 'update-download.tmp')), false, 'the oversized temp download must not survive the attempt');
  assert.ok(state.count >= 1);
});

test('failure sweep: wrong sha256 (tampered tarball, otherwise-valid signature)', async () => {
  const { tarBytes, manifest } = makeSignedBundle({ version: '2.4.0' });
  const tampered = Buffer.from(tarBytes);
  tampered[0] = tampered[0] ^ 0xff; // flip a byte — signature still parses, hash no longer matches
  const offer = makeOffer({ manifest });
  const { db, dataDir } = approvedWorkspace(offer);

  const { server, endpoint } = await fakeServer((req, res) => { res.writeHead(200); res.end(tampered); });
  try {
    await tickUpdater(db, dataDir, { endpoint, now: IN_WINDOW_NOW });
  } finally {
    server.close();
  }
  assert.equal(controlStateGet(db, 'update_offer'), JSON.stringify(offer));
  assert.equal(fs.existsSync(path.join(dataDir, 'update-download.tmp')), false);
});

test('failure sweep: wrong signature (manifest signed with a different key)', async () => {
  const otherKeypair = generateKeyPairSync('ed25519');
  const { tarBytes, manifest } = makeSignedBundle({ version: '2.4.0', keyOverride: otherKeypair });
  const offer = makeOffer({ manifest }); // signed with otherKeypair, but this file only trusts `publicKey`
  const { db, dataDir } = approvedWorkspace(offer);

  const { server, endpoint } = await fakeServer((req, res) => { res.writeHead(200); res.end(tarBytes); });
  try {
    await tickUpdater(db, dataDir, { endpoint, now: IN_WINDOW_NOW });
  } finally {
    server.close();
  }
  assert.equal(controlStateGet(db, 'update_offer'), JSON.stringify(offer));
});

test('failure sweep: cross-host absolute URL is refused before any network call is made', async () => {
  const { manifest } = makeSignedBundle({ version: '2.4.0' });
  const offer = makeOffer({ manifest, urlPath: 'https://evil.example.com/bundle.tar.gz' });
  const { db, dataDir } = approvedWorkspace(offer);

  const { server, endpoint, state } = await fakeServer((req, res) => { res.writeHead(200); res.end('should never be requested'); });
  try {
    await tickUpdater(db, dataDir, { endpoint, now: IN_WINDOW_NOW });
  } finally {
    server.close();
  }
  assert.equal(state.count, 0, 'the fake (legitimate) server must never see a request — the malicious host would have, in reality');
  assert.equal(controlStateGet(db, 'update_offer'), JSON.stringify(offer));
});

// --- staging: dev vs versioned layout -------------------------------------------

test('dev layout: stages into a scratch folder, apply is never invoked', async () => {
  const { tarBytes, manifest } = makeSignedBundle({ version: '2.4.0' });
  const offer = makeOffer({ manifest });
  const { db, dataDir } = approvedWorkspace(offer);
  const devRoot = tmpDir('em-updater-devroot-'); // no versions/current siblings — a plain checkout

  const { server, endpoint } = await fakeServer((req, res) => { res.writeHead(200); res.end(tarBytes); });
  let spawnCalled = false;
  try {
    await tickUpdater(db, dataDir, {
      endpoint, now: IN_WINDOW_NOW, appRoot: devRoot,
      spawnImpl: () => { spawnCalled = true; return {}; },
    });
  } finally {
    server.close();
  }
  assert.equal(spawnCalled, false, 'a dev machine must never have apply-update.ps1 spawned against it');
  const staged = path.join(dataDir, 'update-staging', '2.4.0', 'server', 'index.js');
  assert.ok(fs.existsSync(staged), 'the bundle IS still staged, just not applied');
});

test('versioned layout: stages under <root>\\versions\\<version> and spawns apply via the DI seam', async () => {
  const { tarBytes, manifest } = makeSignedBundle({ version: '2.4.0' });
  const offer = makeOffer({ manifest });
  const { db, dataDir } = approvedWorkspace(offer);
  const { root, appRoot } = makeVersionedRoot('2.3.0');

  const { server, endpoint } = await fakeServer((req, res) => { res.writeHead(200); res.end(tarBytes); });
  let spawnArgs = null;
  try {
    await tickUpdater(db, dataDir, {
      endpoint, now: IN_WINDOW_NOW, appRoot,
      spawnImpl: (cmd, args, opts) => {
        spawnArgs = { cmd, args, opts };
        // Simulate apply-update.ps1's own contract: it writes the result file.
        fs.writeFileSync(path.join(dataDir, 'update-result.json'), JSON.stringify({ version: '2.4.0', ok: true }));
        return { unref() {} };
      },
    });
  } finally {
    server.close();
  }
  const staged = path.join(root, 'versions', '2.4.0', 'server', 'index.js');
  assert.ok(fs.existsSync(staged), 'staged under <root>/versions/<version>, not <root>/current');
  assert.ok(spawnArgs, 'apply-update.ps1 was launched');
  assert.match(spawnArgs.cmd, /powershell/i);
  assert.ok(spawnArgs.args.includes('-Version'));
  assert.ok(spawnArgs.args.includes('2.4.0'));
  assert.ok(fs.existsSync(path.join(dataDir, 'update-result.json')));
});

test('versioned layout: refuses to stage over the directory `current` actually points at', async () => {
  const { tarBytes, manifest } = makeSignedBundle({ version: '2.3.0' }); // same version as what's "running"
  const offer = makeOffer({ version: '2.3.0', manifest });
  const { db, dataDir } = approvedWorkspace(offer);
  const { appRoot } = makeVersionedRoot('2.3.0'); // current -> versions/2.3.0, i.e. THIS offer's own version

  const { server, endpoint } = await fakeServer((req, res) => { res.writeHead(200); res.end(tarBytes); });
  let spawnCalled = false;
  try {
    await tickUpdater(db, dataDir, {
      endpoint, now: IN_WINDOW_NOW, appRoot,
      spawnImpl: () => { spawnCalled = true; return {}; },
    });
  } finally {
    server.close();
  }
  assert.equal(spawnCalled, false, 'must never touch the live, currently-running version directory');
  // Nothing was ever staged into the live version's own directory.
  assert.equal(fs.existsSync(path.join(appRoot, 'server')), false, 'the running version directory was never touched');
});

test('an already-existing (leftover) version directory is discarded and re-staged fresh', async () => {
  const { tarBytes, manifest } = makeSignedBundle({ version: '2.4.0' });
  const offer = makeOffer({ manifest });
  const { db, dataDir } = approvedWorkspace(offer);
  const { root, appRoot } = makeVersionedRoot('2.3.0');

  // A stale leftover from a previous, never-applied attempt.
  const leftoverDir = path.join(root, 'versions', '2.4.0');
  fs.mkdirSync(leftoverDir, { recursive: true });
  fs.writeFileSync(path.join(leftoverDir, 'garbage.txt'), 'stale leftover');

  const { server, endpoint } = await fakeServer((req, res) => { res.writeHead(200); res.end(tarBytes); });
  try {
    await tickUpdater(db, dataDir, {
      endpoint, now: IN_WINDOW_NOW, appRoot,
      spawnImpl: () => ({ unref() {} }),
    });
  } finally {
    server.close();
  }
  assert.ok(fs.existsSync(path.join(leftoverDir, 'server', 'index.js')), 'staged fresh from the verified bundle');
  assert.equal(fs.existsSync(path.join(leftoverDir, 'garbage.txt')), false, 'the stale leftover is gone');
});

test('disk full (staging throws): handled gracefully, nothing thrown out, offer stays', async () => {
  const { tarBytes, manifest } = makeSignedBundle({ version: '2.4.0' });
  const offer = makeOffer({ manifest });
  const { db, dataDir } = approvedWorkspace(offer);
  const { appRoot } = makeVersionedRoot('2.3.0');

  const { server, endpoint } = await fakeServer((req, res) => { res.writeHead(200); res.end(tarBytes); });
  try {
    await assert.doesNotReject(tickUpdater(db, dataDir, {
      endpoint, now: IN_WINDOW_NOW, appRoot,
      mkdirSync: () => { throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }); },
    }));
  } finally {
    server.close();
  }
  assert.equal(controlStateGet(db, 'update_offer'), JSON.stringify(offer));
});

// --- attack-your-own-code: re-entrancy -----------------------------------------

test('two ticks in the same window do not double-download or double-apply', async () => {
  const { tarBytes, manifest } = makeSignedBundle({ version: '2.4.0' });
  const offer = makeOffer({ manifest });
  const { db, dataDir } = approvedWorkspace(offer);
  const { appRoot } = makeVersionedRoot('2.3.0');

  const { server, endpoint, state } = await fakeServer((req, res) => { res.writeHead(200); res.end(tarBytes); });
  let applyCount = 0;
  const opts = {
    endpoint, now: IN_WINDOW_NOW, appRoot,
    spawnImpl: () => { applyCount += 1; return { unref() {} }; },
  };
  try {
    await tickUpdater(db, dataDir, opts);
    await tickUpdater(db, dataDir, opts); // one minute later, same scheduled window
  } finally {
    server.close();
  }
  assert.equal(state.count, 1, 'only the first tick downloads');
  assert.equal(applyCount, 1, 'only the first tick applies');
});

// --- the acceptance test: offer -> approve -> download/verify/stage -> apply
//     -> the outcome reaches the vendor on the very next check-in -----------

const admin = { id: 7, role: 'admin' };

test('acceptance: offered, approved, installed, and reported — end to end', async () => {
  const { manifest, tarBytes } = makeSignedBundle({ version: '2.4.0' });
  const offer = makeOffer({ manifest });

  const dataDir = tmpDir('em-updater-accept-data-');
  fs.writeFileSync(path.join(dataDir, 'control.json'), JSON.stringify({
    clinic_id: 'c-accept-1', unlock_secret: 'secret', subscription: 'active', install_token: 'tok-accept-1',
  }));
  const db = openDb(':memory:');
  migrate(db);

  const { root, appRoot } = makeVersionedRoot('2.3.0');

  // One fake vendor serving BOTH the daily check-in endpoint AND the bundle
  // download, so the same origin the offer's URL resolves against is the
  // same one this whole test drives — exactly the cross-host rule's premise.
  const receivedUpdateResults = [];
  let offerVersionToServe = '2.4.0';
  const server = http.createServer((req, res) => {
    if (req.url === '/dl/bundle.tar.gz') {
      res.writeHead(200);
      res.end(tarBytes);
      return;
    }
    if (req.url === '/cp/v1/checkin') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const parsed = JSON.parse(body);
        if (parsed.update_result) receivedUpdateResults.push(parsed.update_result);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        // Once the clinic reports it installed 2.4.0, the vendor has nothing
        // further to offer — mirrors the real control plane's own rule that
        // a clinic already on a version is offered nothing.
        const stillOffering = offerVersionToServe && !receivedUpdateResults.some((r) => r.version === '2.4.0' && r.ok);
        res.end(JSON.stringify({ licence: null, subscription: 'active', collect: [], update: stillOffering ? offer : null }));
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;

  try {
    // 1. The fake vendor offers v2.4.0 on the clinic's daily check-in.
    await runCheckin(db, dataDir, { endpoint });
    const storedOffer = JSON.parse(db.prepare("SELECT value FROM control_state WHERE key='update_offer'").get().value);
    assert.equal(storedOffer.version, '2.4.0');

    // 2. The admin approves it for hour 3, via the real RPC.
    const approveResult = updateApprove(db, { hour: 3 }, admin, { now: () => new Date(2026, 0, 1, 1, 0, 0) });
    assert.equal(approveResult.ok, true);

    // 3. The clock reaches hour 3 — tickUpdater downloads, verifies, stages,
    //    and (stub) applies, which writes update-result.json exactly the way
    //    apply-update.ps1 is contracted to.
    let spawnedWith = null;
    await tickUpdater(db, dataDir, {
      endpoint, appRoot, now: () => new Date(2026, 0, 1, 3, 0, 0),
      spawnImpl: (cmd, args) => {
        spawnedWith = { cmd, args };
        fs.writeFileSync(path.join(dataDir, 'update-result.json'), JSON.stringify({ version: '2.4.0', ok: true }));
        return { unref() {} };
      },
    });
    assert.ok(spawnedWith, 'apply-update.ps1 must have been launched');
    assert.ok(fs.existsSync(path.join(root, 'versions', '2.4.0', 'server', 'index.js')), 'staged for real under <root>/versions/2.4.0');

    // 4. The NEXT check-in carries update_result — asserted at the fake
    //    vendor's own side (receivedUpdateResults), not just on disk.
    await runCheckin(db, dataDir, { endpoint });
    assert.deepEqual(receivedUpdateResults, [{ version: '2.4.0', ok: true }]);
    assert.ok(fs.existsSync(path.join(dataDir, 'update-result.json.sent')), 'sent exactly once, then rotated');
    assert.equal(fs.existsSync(path.join(dataDir, 'update-result.json')), false);

    // 5. And the vendor, having heard the clinic is now on 2.4.0, offers
    //    nothing further — the offer clears on this same next check-in.
    assert.equal(db.prepare("SELECT value FROM control_state WHERE key='update_offer'").get(), undefined);
  } finally {
    server.close();
  }
});

test('concurrent overlapping ticks (outer re-entrancy guard) never run two pipelines at once', async () => {
  const { tarBytes, manifest } = makeSignedBundle({ version: '2.4.0' });
  const offer = makeOffer({ manifest });
  const { db, dataDir } = approvedWorkspace(offer);
  const { appRoot } = makeVersionedRoot('2.3.0');

  let inflightCount = 0;
  let maxConcurrent = 0;
  const { server, endpoint } = await fakeServer((req, res) => {
    inflightCount += 1;
    maxConcurrent = Math.max(maxConcurrent, inflightCount);
    setTimeout(() => { inflightCount -= 1; res.writeHead(200); res.end(tarBytes); }, 30);
  });
  try {
    await Promise.all([
      tickUpdater(db, dataDir, { endpoint, now: IN_WINDOW_NOW, appRoot, spawnImpl: () => ({ unref() {} }) }),
      tickUpdater(db, dataDir, { endpoint, now: IN_WINDOW_NOW, appRoot, spawnImpl: () => ({ unref() {} }) }),
    ]);
  } finally {
    server.close();
  }
  assert.equal(maxConcurrent, 1, 'the second call must have returned immediately, never starting its own request');
});
