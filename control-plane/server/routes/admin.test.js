import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';

import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { hashPassword } from '../services/vendor-auth.js';
import { createEnrollmentCode, redeemEnrollmentCode } from '../services/enrollment.js';
import { checkIn } from '../services/checkin.js';
import { createApp } from '../app.js';
import { expectedResponse } from '../../../server/services/control/unlock.js';
import { SELLABLE_MODULES } from '../../../server/services/rpc/licence.js';
import { ADMIN_ROUTE_TABLE } from './admin.js';

// --- test harness ------------------------------------------------------------

const ADMIN_BASE = '/cp/v1/admin';

function freshDb() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

// POST /clinics and POST /clinics/:id/subscription (indirectly, via a real
// enrol()) both end up calling through to signLicence() — enroll.js's own
// beforeCommit hook — so any test that exercises a real /cp/v1/enroll needs a
// signing key configured, exactly like routes/enroll.test.js's own
// useSigningKey().
const tmpDirs = [];
function useSigningKey() {
  const { privateKey } = generateKeyPairSync('ed25519');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-test-key-'));
  tmpDirs.push(dir);
  const p = path.join(dir, 'vendor-private.pem');
  fs.writeFileSync(p, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  process.env.EASYMED_SIGNING_KEY = p;
}

test.after(() => {
  delete process.env.EASYMED_SIGNING_KEY;
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort temp cleanup */ }
  }
});

function withVendorUser(db, username = 'vendor', password = 'secret123') {
  db.prepare('INSERT INTO vendor_users (username, password_hash, full_name) VALUES (?,?,?)')
    .run(username, hashPassword(password), 'Test Vendor');
  return db;
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function req(server, method, path, { body, cookie } = {}) {
  return fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function cookieFrom(res) {
  const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')];
  return set.map((c) => c.split(';')[0]).join('; ');
}

async function loggedInCookie(server, username = 'vendor', password = 'secret123') {
  const res = await req(server, 'POST', '/cp/v1/auth/login', { body: { username, password } });
  assert.equal(res.status, 200, 'sanity check: login must succeed for the test harness');
  return cookieFrom(res);
}

function enrol(db, clinicId, name = 'Test Clinic') {
  const code = createEnrollmentCode(db, { clinicId, name });
  return redeemEnrollmentCode(db, { code }).install_token;
}

async function harness(t, { withUser = true } = {}) {
  useSigningKey();
  const db = freshDb();
  if (withUser) withVendorUser(db);
  const app = createApp(db);
  const server = await listen(app);
  t.after(() => server.close());
  return { db, app, server };
}

// --- adversarial: EVERY admin route rejects an anonymous caller -------------

test('every route in ADMIN_ROUTE_TABLE rejects an anonymous caller with 401', async (t) => {
  assert.ok(ADMIN_ROUTE_TABLE.length >= 9, 'sanity check: the route table should list every admin route from the spec');
  const { db, server } = await harness(t);
  enrol(db, 'c-1', 'Clinic One');
  db.prepare("INSERT INTO module_requests (clinic_id, module_key, requested_at) VALUES ('c-1','crm','2026-08-20T00:00:00Z')").run();
  const requestId = db.prepare('SELECT id FROM module_requests').get().id;

  for (const { method, path } of ADMIN_ROUTE_TABLE) {
    const filled = path.replace(':id', method === 'POST' && path.includes('/requests/') ? String(requestId) : 'c-1');
    const resolved = ADMIN_BASE + filled;
    const res = await req(server, method, resolved, method === 'POST' ? { body: {} } : {});
    assert.equal(res.status, 401, `${method} ${resolved} must reject an anonymous caller (got ${res.status})`);
  }
});

// --- enroll and checkin remain unauthenticated -------------------------------

test('control: /cp/v1/enroll and /cp/v1/checkin still work with no vendor session at all', async (t) => {
  const { db, server } = await harness(t, { withUser: false }); // not even a vendor account exists
  const code = createEnrollmentCode(db, { clinicId: 'c-1', name: 'Clinic' });

  const enrollRes = await req(server, 'POST', '/cp/v1/enroll', { body: { code } });
  assert.equal(enrollRes.status, 200, 'enroll must still work with zero vendor sessions in play');
  const installToken = (await enrollRes.json()).install_token;

  const checkinRes = await req(server, 'POST', '/cp/v1/checkin', { body: { install_token: installToken } });
  assert.equal(checkinRes.status, 200, 'checkin must still work with zero vendor sessions in play');
});

// --- GET /clinics -------------------------------------------------------------

test('GET /clinics lists clinics with subscription, modules, last check-in info, and open-request count', async (t) => {
  const { db, server } = await harness(t);
  const cookie = await loggedInCookie(server);
  const installToken = enrol(db, 'c-1', 'Клиника Один');
  db.prepare("INSERT INTO clinic_modules (clinic_id, module_key) VALUES ('c-1','crm')").run();
  checkIn(db, { installToken, version: '1.2.3', fingerprint: 'fp-a' });
  db.prepare("INSERT INTO module_requests (clinic_id, module_key, requested_at) VALUES ('c-1','telegram','2026-08-20T00:00:00Z')").run();

  const res = await req(server, 'GET', '/cp/v1/admin/clinics', { cookie });
  assert.equal(res.status, 200);
  const { clinics } = await res.json();
  const c1 = clinics.find((c) => c.id === 'c-1');
  assert.ok(c1);
  assert.equal(c1.name, 'Клиника Один');
  assert.equal(c1.subscription, 'active');
  assert.deepEqual(c1.modules, ['crm']);
  assert.equal(c1.last_version, '1.2.3');
  assert.ok(c1.last_seen_at);
  assert.equal(c1.open_request_count, 1);
  assert.equal(c1.fingerprint_changed, false);
});

test('GET /clinics flags a clinic whose fingerprint changed on its most recent check-in', async (t) => {
  const { db, server } = await harness(t);
  const cookie = await loggedInCookie(server);
  const installToken = enrol(db, 'c-1');
  checkIn(db, { installToken, fingerprint: 'fp-a' });
  checkIn(db, { installToken, fingerprint: 'fp-b' }); // changed

  const res = await req(server, 'GET', '/cp/v1/admin/clinics', { cookie });
  const { clinics } = await res.json();
  assert.equal(clinics.find((c) => c.id === 'c-1').fingerprint_changed, true);
});

// --- GET /clinics/:id ---------------------------------------------------------

test('GET /clinics/:id returns one clinic with its most recent check-ins, and never leaks install_token/unlock_secret', async (t) => {
  const { db, server } = await harness(t);
  const cookie = await loggedInCookie(server);
  const installToken = enrol(db, 'c-1', 'Клиника Один');
  for (let i = 0; i < 3; i++) checkIn(db, { installToken, version: `1.0.${i}` });

  const res = await req(server, 'GET', '/cp/v1/admin/clinics/c-1', { cookie });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.clinic.id, 'c-1');
  assert.equal(body.clinic.name, 'Клиника Один');
  assert.equal(body.checkins.length, 3);
  const dump = JSON.stringify(body);
  assert.ok(!dump.includes(installToken), 'install_token must never be returned to the panel');
  assert.ok(!dump.includes('unlock_secret') || !JSON.stringify(body.clinic).match(/[A-Za-z0-9+/]{20,}={0,2}/), 'unlock_secret value must not leak');
});

test('GET /clinics/:id caps check-in history at 50, most recent first', async (t) => {
  const { db, server } = await harness(t);
  const cookie = await loggedInCookie(server);
  const installToken = enrol(db, 'c-1');
  for (let i = 0; i < 60; i++) checkIn(db, { installToken, version: `v${i}` });

  const res = await req(server, 'GET', '/cp/v1/admin/clinics/c-1', { cookie });
  const body = await res.json();
  assert.equal(body.checkins.length, 50);
  assert.equal(body.checkins[0].version, 'v59', 'most recent check-in must be first');
});

test('GET /clinics/:id 404s for an unknown clinic', async (t) => {
  const { server } = await harness(t);
  const cookie = await loggedInCookie(server);
  const res = await req(server, 'GET', '/cp/v1/admin/clinics/no-such-clinic', { cookie });
  assert.equal(res.status, 404);
});

// --- POST /clinics (create) ---------------------------------------------------

test('POST /clinics creates a clinic and returns an enrollment code that actually enrolls', async (t) => {
  const { db, server } = await harness(t);
  const cookie = await loggedInCookie(server);

  const res = await req(server, 'POST', '/cp/v1/admin/clinics', { cookie, body: { name: 'Новая клиника' } });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.ok(body.clinic_id);
  assert.ok(body.enrollment_code);

  const enrollRes = await req(server, 'POST', '/cp/v1/enroll', { body: { code: body.enrollment_code } });
  assert.equal(enrollRes.status, 200, 'the returned code must be a real, working enrollment code');
  assert.equal((await enrollRes.json()).clinic_id, body.clinic_id);
});

test('POST /clinics rejects a missing name', async (t) => {
  const { server } = await harness(t);
  const cookie = await loggedInCookie(server);
  const res = await req(server, 'POST', '/cp/v1/admin/clinics', { cookie, body: {} });
  assert.equal(res.status, 400);
});

test('POST /clinics twice never collides on clinic_id', async (t) => {
  const { server } = await harness(t);
  const cookie = await loggedInCookie(server);
  const first = await req(server, 'POST', '/cp/v1/admin/clinics', { cookie, body: { name: 'A' } });
  const second = await req(server, 'POST', '/cp/v1/admin/clinics', { cookie, body: { name: 'B' } });
  const [a, b] = [await first.json(), await second.json()];
  assert.notEqual(a.clinic_id, b.clinic_id);
});

// --- POST /clinics/:id/modules ------------------------------------------------

test('POST /clinics/:id/modules grants and revokes a real sellable module', async (t) => {
  const { db, server } = await harness(t);
  const cookie = await loggedInCookie(server);
  enrol(db, 'c-1');

  const grant = await req(server, 'POST', '/cp/v1/admin/clinics/c-1/modules', {
    cookie, body: { module_key: 'crm', granted: true },
  });
  assert.equal(grant.status, 200);
  assert.ok((await grant.json()).note, 'a mutating response should carry something the UI can use to explain the delay');
  assert.deepEqual(
    db.prepare("SELECT module_key FROM clinic_modules WHERE clinic_id='c-1'").all().map((r) => r.module_key),
    ['crm'],
  );

  const revoke = await req(server, 'POST', '/cp/v1/admin/clinics/c-1/modules', {
    cookie, body: { module_key: 'crm', granted: false },
  });
  assert.equal(revoke.status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM clinic_modules WHERE clinic_id='c-1'").get().n, 0);
});

test('POST /clinics/:id/modules granting the same module twice does not throw (idempotent)', async (t) => {
  const { db, server } = await harness(t);
  const cookie = await loggedInCookie(server);
  enrol(db, 'c-1');
  await req(server, 'POST', '/cp/v1/admin/clinics/c-1/modules', { cookie, body: { module_key: 'crm', granted: true } });
  const second = await req(server, 'POST', '/cp/v1/admin/clinics/c-1/modules', { cookie, body: { module_key: 'crm', granted: true } });
  assert.equal(second.status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM clinic_modules WHERE clinic_id='c-1'").get().n, 1);
});

// --- ATTACK: marketing must never be grantable, even posted directly --------

test('ATTACK: module_key="marketing" cannot be granted via POST /clinics/:id/modules, even bypassing the UI', async (t) => {
  const { db, server } = await harness(t);
  const cookie = await loggedInCookie(server);
  enrol(db, 'c-1');
  assert.ok(SELLABLE_MODULES.has('marketing'), 'sanity check: marketing IS in the sellable vocabulary');

  const res = await req(server, 'POST', '/cp/v1/admin/clinics/c-1/modules', {
    cookie, body: { module_key: 'marketing', granted: true },
  });
  assert.equal(res.status, 400, 'marketing must be rejected, not silently granted');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM clinic_modules WHERE clinic_id='c-1' AND module_key='marketing'").get().n, 0);
});

test('ATTACK: a module key that is not sellable at all is rejected', async (t) => {
  const { db, server } = await harness(t);
  const cookie = await loggedInCookie(server);
  enrol(db, 'c-1');
  const res = await req(server, 'POST', '/cp/v1/admin/clinics/c-1/modules', {
    cookie, body: { module_key: 'not-a-real-module', granted: true },
  });
  assert.equal(res.status, 400);
});

// --- POST /clinics/:id/subscription -------------------------------------------

test('POST /clinics/:id/subscription updates subscription and subscription_until', async (t) => {
  const { db, server } = await harness(t);
  const cookie = await loggedInCookie(server);
  enrol(db, 'c-1');

  const res = await req(server, 'POST', '/cp/v1/admin/clinics/c-1/subscription', {
    cookie, body: { subscription: 'active', subscription_until: '2027-01-01' },
  });
  assert.equal(res.status, 200);
  const row = db.prepare("SELECT subscription, subscription_until FROM clinics WHERE clinic_id='c-1'").get();
  assert.equal(row.subscription, 'active');
  assert.equal(row.subscription_until, '2027-01-01');
});

test('POST /clinics/:id/subscription rejects an invalid subscription value', async (t) => {
  const { server } = await harness(t);
  const cookie = await loggedInCookie(server);
  const enrolled = await req(server, 'POST', '/cp/v1/admin/clinics', { cookie, body: { name: 'X' } });
  const { clinic_id } = await enrolled.json();
  const res = await req(server, 'POST', `/cp/v1/admin/clinics/${clinic_id}/subscription`, {
    cookie, body: { subscription: 'aktive' },
  });
  assert.equal(res.status, 400);
});

// --- ATTACK: subscription_until in the past is allowed, and check-in honours it ---

test('ATTACK: subscription_until set in the past is accepted by the API, and check-in then refuses to re-arm', async (t) => {
  const { db, server } = await harness(t);
  const cookie = await loggedInCookie(server);
  const installToken = enrol(db, 'c-1');

  const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);
  const res = await req(server, 'POST', '/cp/v1/admin/clinics/c-1/subscription', {
    cookie, body: { subscription: 'active', subscription_until: yesterday },
  });
  assert.equal(res.status, 200, 'a past subscription_until is a deliberate, allowed way to end a subscription');

  // Cross-check against the real check-in service (services/checkin.js) —
  // not a re-implementation of its date logic.
  const result = checkIn(db, { installToken });
  assert.equal(result.licence, null, 'a lapsed subscription_until must not re-arm the licence');
  assert.equal(result.subscription, 'unpaid', 'check-in must report unpaid even though the column still says active');
});

// --- POST /clinics/:id/retire, and no delete route ---------------------------

test('POST /clinics/:id/retire sets active=0; the row and clinic_id survive', async (t) => {
  const { db, server } = await harness(t);
  const cookie = await loggedInCookie(server);
  enrol(db, 'c-1');

  const res = await req(server, 'POST', '/cp/v1/admin/clinics/c-1/retire', { cookie, body: {} });
  assert.equal(res.status, 200);
  const row = db.prepare("SELECT active FROM clinics WHERE clinic_id='c-1'").get();
  assert.equal(row.active, 0);
  assert.ok(row, 'the row itself must still exist — retire is not delete');
});

test('there is no DELETE route for a clinic', async (t) => {
  const { server } = await harness(t);
  const cookie = await loggedInCookie(server);
  const res = await fetch(`http://127.0.0.1:${server.address().port}/cp/v1/admin/clinics/c-1`, {
    method: 'DELETE', headers: { Cookie: cookie },
  });
  assert.notEqual(res.status, 200, 'DELETE must not be a working way to remove a clinic');
});

// --- POST /clinics/:id/unlock-code --------------------------------------------

test('POST /clinics/:id/unlock-code returns exactly expectedResponse() from services/control/unlock.js', async (t) => {
  const { db, server } = await harness(t);
  const cookie = await loggedInCookie(server);
  enrol(db, 'c-1');
  const clinic = db.prepare("SELECT unlock_secret FROM clinics WHERE clinic_id='c-1'").get();

  const res = await req(server, 'POST', '/cp/v1/admin/clinics/c-1/unlock-code', {
    cookie, body: { challenge: 'ABCDEF' },
  });
  assert.equal(res.status, 200);
  const { code } = await res.json();
  const expected = expectedResponse({ clinicId: 'c-1', challenge: 'ABCDEF', secret: clinic.unlock_secret });
  assert.equal(code, expected, 'the response code must match expectedResponse() exactly — never a reimplementation');
});

test('POST /clinics/:id/unlock-code requires a challenge', async (t) => {
  const { db, server } = await harness(t);
  const cookie = await loggedInCookie(server);
  enrol(db, 'c-1');
  const res = await req(server, 'POST', '/cp/v1/admin/clinics/c-1/unlock-code', { cookie, body: {} });
  assert.equal(res.status, 400);
});

// --- GET /requests, and grant idempotency -------------------------------------

test('GET /requests lists open module_requests with the clinic name attached', async (t) => {
  const { db, server } = await harness(t);
  const cookie = await loggedInCookie(server);
  enrol(db, 'c-1', 'Клиника Один');
  db.prepare("INSERT INTO module_requests (clinic_id, module_key, requested_at) VALUES ('c-1','crm','2026-08-20T00:00:00Z')").run();

  const res = await req(server, 'GET', '/cp/v1/admin/requests', { cookie });
  assert.equal(res.status, 200);
  const { requests } = await res.json();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].module_key, 'crm');
  assert.equal(requests[0].clinic_name, 'Клиника Один');
});

test('POST /requests/:id/grant grants the module AND marks the request granted, atomically', async (t) => {
  const { db, server } = await harness(t);
  const cookie = await loggedInCookie(server);
  enrol(db, 'c-1');
  db.prepare("INSERT INTO module_requests (clinic_id, module_key, requested_at) VALUES ('c-1','crm','2026-08-20T00:00:00Z')").run();
  const id = db.prepare('SELECT id FROM module_requests').get().id;

  const res = await req(server, 'POST', `/cp/v1/admin/requests/${id}/grant`, { cookie, body: {} });
  assert.equal(res.status, 200);
  assert.ok((await res.json()).note);
  assert.equal(db.prepare("SELECT status FROM module_requests WHERE id=?").get(id).status, 'granted');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM clinic_modules WHERE clinic_id='c-1' AND module_key='crm'").get().n, 1);
});

// --- ATTACK: granting a request twice — a double click, or a double-submit --

test('ATTACK: POST /requests/:id/grant twice in a row (double click) is idempotent, not an error or a duplicate grant', async (t) => {
  const { db, server } = await harness(t);
  const cookie = await loggedInCookie(server);
  enrol(db, 'c-1');
  db.prepare("INSERT INTO module_requests (clinic_id, module_key, requested_at) VALUES ('c-1','telegram','2026-08-20T00:00:00Z')").run();
  const id = db.prepare('SELECT id FROM module_requests').get().id;

  const first = await req(server, 'POST', `/cp/v1/admin/requests/${id}/grant`, { cookie, body: {} });
  const second = await req(server, 'POST', `/cp/v1/admin/requests/${id}/grant`, { cookie, body: {} });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200, 'a second grant of the same request must not error');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM clinic_modules WHERE clinic_id='c-1' AND module_key='telegram'").get().n, 1,
    'the entitlement must not be duplicated (and clinic_modules has no room for a duplicate row anyway)');
});

// --- ATTACK: a 'marketing' request must never be grantable via this route either ---

test('ATTACK: a module_request for "marketing" cannot be granted through POST /requests/:id/grant', async (t) => {
  const { db, server } = await harness(t);
  const cookie = await loggedInCookie(server);
  enrol(db, 'c-1');
  db.prepare("INSERT INTO module_requests (clinic_id, module_key, requested_at) VALUES ('c-1','marketing','2026-08-20T00:00:00Z')").run();
  const id = db.prepare('SELECT id FROM module_requests').get().id;

  const res = await req(server, 'POST', `/cp/v1/admin/requests/${id}/grant`, { cookie, body: {} });
  assert.equal(res.status, 400, 'granting a marketing lead must be refused, not silently accepted');
  assert.equal(db.prepare("SELECT status FROM module_requests WHERE id=?").get(id).status, 'open', 'the request must stay open, not be marked granted');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM clinic_modules WHERE clinic_id='c-1' AND module_key='marketing'").get().n, 0);
});

test('POST /requests/:id/grant 404s for an unknown request id', async (t) => {
  const { server } = await harness(t);
  const cookie = await loggedInCookie(server);
  const res = await req(server, 'POST', '/cp/v1/admin/requests/999999/grant', { cookie, body: {} });
  assert.equal(res.status, 404);
});
