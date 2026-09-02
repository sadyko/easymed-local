import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';

import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { createEnrollmentCode, redeemEnrollmentCode } from '../services/enrollment.js';
import { createApp } from '../app.js';
import { DEPLOY_PATH, MIN_TOKEN_CHARS } from './deploy.js';
import { listen } from '../test-helpers/listen.js';

// AUTO_ROLLOUT_V1 — the CI-facing publish endpoint. The one thing this whole
// file is protecting: a token that can publish to EVERY clinic in the country
// in one call. So the tests below care as much about what must NOT happen (no
// file written, no row inserted, no ring moved) as about the happy path.

// --- test harness ------------------------------------------------------------

// Long enough to be accepted (see MIN_TOKEN_CHARS) and obviously fake — no
// real secret ever appears in this repository, test files included.
const TOKEN = 'test-token-not-a-real-secret-0123456789';

const tmpDirs = [];
function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

// enrol() below signs a licence, exactly like routes/admin.test.js's own
// useSigningKey() — a throwaway key per run, never the production one.
function useSigningKey() {
  const { privateKey } = generateKeyPairSync('ed25519');
  const p = path.join(tmpDir('deploy-test-key-'), 'vendor-private.pem');
  fs.writeFileSync(p, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  process.env.EASYMED_SIGNING_KEY = p;
}

test.after(() => {
  delete process.env.EASYMED_SIGNING_KEY;
  delete process.env.EASYMED_CP_DEPLOY_TOKEN;
  delete process.env.EASYMED_CP_RELEASES_DIR;
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort temp cleanup */ }
  }
});

// The token and the releases directory are read when the router is BUILT, so
// every test sets them before createApp() — the same way the real service
// reads its environment once at boot.
async function harness(t, { token = TOKEN, releasesDir } = {}) {
  useSigningKey();
  if (token === null) delete process.env.EASYMED_CP_DEPLOY_TOKEN;
  else process.env.EASYMED_CP_DEPLOY_TOKEN = token;

  const dir = releasesDir || tmpDir('deploy-test-releases-');
  process.env.EASYMED_CP_RELEASES_DIR = dir;

  const db = openDb(':memory:');
  migrate(db);
  const server = await listen(createApp(db));
  t.after(() => {
    server.close();
    delete process.env.EASYMED_CP_DEPLOY_TOKEN;
    delete process.env.EASYMED_CP_RELEASES_DIR;
  });
  return { db, server, dir };
}

function url(server, p) {
  return `http://127.0.0.1:${server.address().port}${p}`;
}

function deploy(server, body, { token = TOKEN, headers } = {}) {
  return fetch(url(server, DEPLOY_PATH), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function checkin(server, body) {
  return fetch(url(server, '/cp/v1/checkin'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function enrol(db, clinicId = 'c-1', name = 'Test Clinic') {
  const code = createEnrollmentCode(db, { clinicId, name });
  return redeemEnrollmentCode(db, { code }).install_token;
}

// A real gzip stream, not random bytes: the route rejects anything that is not
// gzip-shaped, and a test that faked that would never catch a regression in it.
function tarball(contents = 'pretend this is easymed-2.4.0.tar.gz') {
  return zlib.gzipSync(Buffer.from(contents));
}
const b64 = (buf) => buf.toString('base64');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function manifest(overrides = {}) {
  return { payload: { version: '2.4.0', sha256: 'abc123' }, sig: 'base64-looking-signature', ...overrides };
}

function body({ version = '2.4.0', tar = tarball(), ...rest } = {}) {
  return { version, manifest: manifest(), tar_base64: b64(tar), ...rest };
}

function tarPath(dir, version = '2.4.0') {
  return path.join(dir, version, `easymed-${version}.tar.gz`);
}

// Everything the releases directory holds, recursively — used by every
// "NOTHING was written" assertion below.
function filesUnder(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else out.push(p);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

function releaseRows(db) {
  return db.prepare('SELECT version, url, sha256, ring, halted FROM releases').all();
}

// --- happy path ---------------------------------------------------------------

test('a signed bundle posted with the deploy token lands on disk, is registered at ring 2, and is then offered to a ring-2 clinic', async (t) => {
  const { db, server, dir } = await harness(t);
  const installToken = enrol(db);           // clinics default to ring 2 — migration 004
  const tar = tarball();

  const res = await deploy(server, body({ tar, notes_ru: 'Печать направлений больше не обрывается.' }));
  assert.equal(res.status, 201);
  const json = await res.json();
  assert.equal(json.ok, true);
  assert.equal(json.already, false);
  assert.equal(json.ring, 2);
  assert.equal(json.version, '2.4.0');
  assert.equal(json.sha256, sha256(tar));

  // 1. the bytes are on disk, byte-for-byte, where the URL says they are
  assert.deepEqual(fs.readFileSync(tarPath(dir)), tar, 'the stored tarball must be the bytes CI sent');
  assert.equal(json.url, '/releases/2.4.0/easymed-2.4.0.tar.gz');

  // 2. the release row is registered exactly as POST /releases would have done
  const rows = releaseRows(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].version, '2.4.0');
  assert.equal(rows[0].url, '/releases/2.4.0/easymed-2.4.0.tar.gz');
  assert.equal(rows[0].sha256, sha256(tar), 'the hash is computed from the bytes received, never taken from the request');
  assert.equal(rows[0].ring, 2, 'ring 2 = every clinic, including ones enrolled later');
  assert.equal(rows[0].halted, 0);
  assert.deepEqual(JSON.parse(db.prepare('SELECT manifest FROM releases WHERE version = ?').get('2.4.0').manifest), manifest());

  // 3. THE POINT OF THE WHOLE FEATURE: a clinic that did nothing is offered it
  const offer = (await (await checkin(server, { install_token: installToken, version: '2.0.0' })).json()).update;
  assert.equal(offer.version, '2.4.0');
  assert.equal(offer.url, '/releases/2.4.0/easymed-2.4.0.tar.gz');
  assert.equal(offer.sha256, sha256(tar));
  assert.equal(offer.notes_ru, 'Печать направлений больше не обрывается.', 'the clinic admin reads these on the approval screen');
  assert.deepEqual(offer.manifest, manifest());
});

// --- authentication -----------------------------------------------------------

test('a wrong token is refused and NOTHING is written — no file, no release row', async (t) => {
  const { db, server, dir } = await harness(t);
  const res = await deploy(server, body(), { token: 'wrong-token-wrong-token-wrong-token-xxxx' });
  assert.equal(res.status, 401);
  assert.deepEqual(filesUnder(dir), [], 'a refused upload must never touch the releases directory');
  assert.equal(releaseRows(db).length, 0);
});

test('a token of a DIFFERENT LENGTH is refused, not a 500 — timingSafeEqual throws on unequal buffers', async (t) => {
  const { db, server, dir } = await harness(t);
  for (const token of ['x', TOKEN.slice(0, -1), TOKEN + 'x', TOKEN + 'x'.repeat(500)]) {
    const res = await deploy(server, body(), { token });
    assert.equal(res.status, 401, `token of length ${token.length} must be refused with 401, never crash`);
  }
  assert.deepEqual(filesUnder(dir), []);
  assert.equal(releaseRows(db).length, 0);
});

test('no Authorization header at all is refused, and so is a non-Bearer scheme', async (t) => {
  const { db, server, dir } = await harness(t);
  assert.equal((await deploy(server, body(), { token: null })).status, 401);
  assert.equal((await deploy(server, body(), { token: null, headers: { Authorization: `Basic ${TOKEN}` } })).status, 401);
  assert.equal((await deploy(server, body(), { token: null, headers: { Authorization: TOKEN } })).status, 401);
  assert.deepEqual(filesUnder(dir), []);
  assert.equal(releaseRows(db).length, 0);
});

test('a vendor session cookie is NOT enough — this endpoint authenticates by bearer token only', async (t) => {
  const { db, server, dir } = await harness(t);
  // Not even attempting a login: the point is that whatever a browser session
  // could carry, it is never what opens this route. A cookie is offered and
  // ignored.
  const res = await fetch(url(server, DEPLOY_PATH), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: 'cpvsid=anything-at-all' },
    body: JSON.stringify(body()),
  });
  assert.equal(res.status, 401);
  assert.deepEqual(filesUnder(dir), []);
  assert.equal(releaseRows(db).length, 0);
});

// --- invisible when unconfigured ---------------------------------------------

test('with no token configured the endpoint answers 404, byte-identical to any unknown /cp path', async (t) => {
  const { db, server, dir } = await harness(t, { token: null });

  const res = await deploy(server, body());
  assert.equal(res.status, 404);

  const unknown = await fetch(url(server, '/cp/v1/no-such-endpoint'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(unknown.status, 404);
  assert.deepEqual(await res.json(), await unknown.json(), 'an unconfigured install must not reveal that this endpoint exists at all');

  assert.deepEqual(filesUnder(dir), []);
  assert.equal(releaseRows(db).length, 0);
});

test('a token shorter than the minimum counts as NOT configured — a guessable token must not be able to publish to every clinic', async (t) => {
  const short = 'a'.repeat(MIN_TOKEN_CHARS - 1);
  const { db, server, dir } = await harness(t, { token: short });
  const res = await deploy(server, body(), { token: short });
  assert.equal(res.status, 404);
  assert.deepEqual(filesUnder(dir), []);
  assert.equal(releaseRows(db).length, 0);
});

// --- the version string becomes a path segment -------------------------------

test('a version that is not exactly N.N.N is refused before it can become a filename', async (t) => {
  const { db, server, dir } = await harness(t);
  const attacks = [
    '../../../etc/passwd', '..', '../2.4.0', '2.4.0/../../x', '2.4.0/x',
    '2.4.0\\..\\..\\x', 'v2.4.0', '2.4', '2.4.0-rc1', '2.4.0 ', ' 2.4.0', '',
    'C:\\windows\\x', '2.4.0%2f..%2fx', 42, null, {},
  ];
  for (const version of attacks) {
    const res = await deploy(server, body({ version }));
    assert.equal(res.status, 400, `version ${JSON.stringify(version)} must be refused`);
  }
  assert.deepEqual(filesUnder(dir), [], 'no rejected version may leave anything on disk');
  assert.equal(releaseRows(db).length, 0);
});

test('a manifest that is not {payload, sig}-shaped is refused, and a body that is not a gzip stream is refused', async (t) => {
  const { db, server, dir } = await harness(t);

  for (const bad of [null, {}, { payload: {} }, { sig: 'x' }, { payload: {}, sig: '' }, 'not-an-object']) {
    const res = await deploy(server, { version: '2.4.0', manifest: bad, tar_base64: b64(tarball()) });
    assert.equal(res.status, 400, `manifest=${JSON.stringify(bad)} must be refused`);
  }
  for (const bad of [b64(Buffer.from('this is not gzipped at all')), '', 'not-base64-!!!', 42, null]) {
    const res = await deploy(server, { version: '2.4.0', manifest: manifest(), tar_base64: bad });
    assert.equal(res.status, 400, `tar_base64=${String(bad).slice(0, 30)} must be refused`);
  }

  assert.deepEqual(filesUnder(dir), []);
  assert.equal(releaseRows(db).length, 0);
});

// --- idempotency: re-running a workflow is normal ----------------------------

test('re-running the same version with the SAME bytes succeeds and changes nothing', async (t) => {
  const { db, server, dir } = await harness(t);
  const tar = tarball();

  assert.equal((await deploy(server, body({ tar }))).status, 201);
  const before = fs.readFileSync(tarPath(dir));

  const again = await deploy(server, body({ tar }));
  assert.equal(again.status, 200, 'a re-run of a workflow must not fail the workflow');
  const json = await again.json();
  assert.equal(json.ok, true);
  assert.equal(json.already, true);
  assert.equal(json.ring, 2);

  assert.equal(releaseRows(db).length, 1, 'still exactly one release row');
  assert.deepEqual(fs.readFileSync(tarPath(dir)), before);
});

test('re-running the same version with DIFFERENT bytes is refused — two bundles cannot claim one version', async (t) => {
  const { db, server, dir } = await harness(t);
  const first = tarball('the real 2.4.0');
  assert.equal((await deploy(server, body({ tar: first }))).status, 201);

  const res = await deploy(server, body({ tar: tarball('a DIFFERENT 2.4.0') }));
  assert.equal(res.status, 409);
  const json = await res.json();
  assert.match(json.error.message, /already registered|different/i, 'the error must say plainly what went wrong');

  assert.deepEqual(fs.readFileSync(tarPath(dir)), first, 'the bundle already published must never be overwritten');
  const rows = releaseRows(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sha256, sha256(first));
});

test('a re-run never un-halts a release — the automatic halt is the only safety net left', async (t) => {
  const { db, server, dir } = await harness(t);
  const tar = tarball();
  await deploy(server, body({ tar }));

  // Two reported failures would do this via services/checkin.js; setting the
  // same column directly keeps this test about the deploy route.
  db.prepare("UPDATE releases SET halted = 1 WHERE version = '2.4.0'").run();

  const again = await deploy(server, body({ tar }));
  assert.equal(again.status, 200);
  assert.equal((await again.json()).halted, true, 'the answer must say the release is halted, not pretend it published');
  assert.equal(releaseRows(db)[0].halted, 1, 're-running CI must never resurrect a halted release');
  assert.ok(fs.existsSync(tarPath(dir)));
});

test('a release whose file was lost is restored by a re-run, without disturbing the row', async (t) => {
  const { db, server, dir } = await harness(t);
  const tar = tarball();
  await deploy(server, body({ tar }));
  fs.rmSync(tarPath(dir));

  assert.equal((await deploy(server, body({ tar }))).status, 200);
  assert.deepEqual(fs.readFileSync(tarPath(dir)), tar);
  assert.equal(releaseRows(db).length, 1);
});

// --- size caps ----------------------------------------------------------------

test('a bundle over the hard cap is refused with 413 and nothing is written', async (t) => {
  const { db, server, dir } = await harness(t);
  process.env.EASYMED_CP_MAX_BUNDLE_BYTES = '64';   // read per-request so a test can shrink it
  t.after(() => { delete process.env.EASYMED_CP_MAX_BUNDLE_BYTES; });

  // Random bytes, not repeated ones: gzip would squeeze 5000 x's down to 40
  // bytes and the "oversized" bundle would sail straight through the cap.
  const res = await deploy(server, body({ tar: tarball(randomBytes(5000).toString('hex')) }));
  assert.equal(res.status, 413);
  assert.deepEqual(filesUnder(dir), []);
  assert.equal(releaseRows(db).length, 0);
});

// --- the rest of the control plane is untouched -------------------------------

test('mounting the deploy route does not widen the body limit of any other /cp endpoint', async (t) => {
  const { server } = await harness(t);
  const res = await fetch(url(server, '/cp/v1/checkin'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ install_token: 'x', fingerprint: 'y'.repeat(200 * 1024) }),
  });
  assert.equal(res.status, 413, 'check-in must still be capped at 100kb');
});
