import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';

import { openDb } from './db/connection.js';
import { migrate } from './db/migrate.js';
import { hashPassword } from './services/vendor-auth.js';
import { expectedResponse } from '../../server/services/control/unlock.js';
import { createApp } from './app.js';

// CONTROL_PLANE_PANEL_V1 — the required "HTTP-level proof" from Task 6b: boot
// the REAL app (not a mock), including the static file serving app.js now
// does, and drive it exactly as a browser would — login, create a clinic,
// list, toggle a module, pull an unlock code, retire, work a request lead.
// Mirrors routes/admin.test.js's own harness shape rather than inventing a
// second one.

const ADMIN_BASE = '/cp/v1/admin';

function freshDb() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

const tmpDirs = [];
function useSigningKey() {
  const { privateKey } = generateKeyPairSync('ed25519');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-test-key-'));
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

function req(server, method, urlPath, { body, cookie, headers } = {}) {
  return fetch(`http://127.0.0.1:${server.address().port}${urlPath}`, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(headers || {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function cookieFrom(res) {
  const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')];
  return set.map((c) => c.split(';')[0]).join('; ');
}

async function harness(t) {
  useSigningKey();
  const db = freshDb();
  withVendorUser(db);
  const app = createApp(db);
  const server = await listen(app);
  t.after(() => server.close());
  return { db, server };
}

async function loggedInCookie(server, username = 'vendor', password = 'secret123') {
  const res = await req(server, 'POST', '/cp/v1/auth/login', { body: { username, password } });
  assert.equal(res.status, 200, 'sanity check: login must succeed for the test harness');
  return cookieFrom(res);
}

// --- static serving: the page itself must be reachable with NO session ------

test('static: GET /cp/ serves the panel page, reachable with zero vendor session', async (t) => {
  const { server } = await harness(t);
  const res = await fetch(`http://127.0.0.1:${server.address().port}/cp/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/html/);
  assert.equal(res.headers.get('cache-control'), 'no-cache', 'NO_STALE_CODE_V1: html must revalidate, never sit stale in the browser cache');
  const body = await res.text();
  assert.match(body, /panel-root/);
  assert.match(body, /panel\.js/);
});

test('static: GET /cp/panel.js serves the module with no-cache, reachable with zero vendor session', async (t) => {
  const { server } = await harness(t);
  const res = await fetch(`http://127.0.0.1:${server.address().port}/cp/panel.js`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /javascript/);
  assert.equal(res.headers.get('cache-control'), 'no-cache');
  const body = await res.text();
  assert.match(body, /panel-api\.js/, 'served file must be the real module, not an empty/placeholder response');
});

test('static: GET /cp/panel.css serves the stylesheet with no-cache', async (t) => {
  const { server } = await harness(t);
  const res = await fetch(`http://127.0.0.1:${server.address().port}/cp/panel.css`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /css/);
  assert.equal(res.headers.get('cache-control'), 'no-cache');
});

test('static: an unknown /cp path that is neither an API route nor a real file still answers JSON 404', async (t) => {
  const { server } = await harness(t);
  const res = await fetch(`http://127.0.0.1:${server.address().port}/cp/no-such-file.js`);
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error.code, 'not_found');
});

test('static: /cp/v1/admin/clinics is NOT shadowed by static serving (API still wins)', async (t) => {
  const { server } = await harness(t);
  const cookie = await loggedInCookie(server);
  const res = await req(server, 'GET', '/cp/v1/admin/clinics', { cookie });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.clinics));
});

// --- the real end-to-end flow the page drives --------------------------------

test('flow: login, create a clinic, list it, toggle a module, pull an unlock code, retire it', async (t) => {
  const { db, server } = await harness(t);

  // 1. login
  const cookie = await loggedInCookie(server);

  // 2. create clinic
  const createRes = await req(server, 'POST', `${ADMIN_BASE}/clinics`, {
    cookie, body: { name: 'Клиника у Панели', contact_name: 'Иван', contact_phone: '+998901234567' },
  });
  assert.equal(createRes.status, 201);
  const created = await createRes.json();
  assert.ok(created.clinic_id);
  assert.ok(created.enrollment_code);

  // The returned code must be the real thing — enroll with it exactly as a
  // fresh clinic install would, over the unauthenticated /cp/v1/enroll route.
  const enrollRes = await req(server, 'POST', '/cp/v1/enroll', { body: { code: created.enrollment_code } });
  assert.equal(enrollRes.status, 200);
  assert.equal((await enrollRes.json()).clinic_id, created.clinic_id);

  // 3. list — the new clinic appears with the fields the clinics-list view reads
  const listRes = await req(server, 'GET', `${ADMIN_BASE}/clinics`, { cookie });
  assert.equal(listRes.status, 200);
  const { clinics } = await listRes.json();
  const row = clinics.find((c) => c.id === created.clinic_id);
  assert.ok(row, 'the just-created clinic must appear in the list');
  assert.equal(row.name, 'Клиника у Панели');
  assert.equal(row.subscription, 'active');
  assert.deepEqual(row.modules, []);
  assert.equal(row.open_request_count, 0);
  assert.equal(row.fingerprint_changed, false);

  // 4. toggle a module on, then off
  const grantRes = await req(server, 'POST', `${ADMIN_BASE}/clinics/${created.clinic_id}/modules`, {
    cookie, body: { module_key: 'crm', granted: true },
  });
  assert.equal(grantRes.status, 200);
  const grantBody = await grantRes.json();
  assert.ok(grantBody.note, 'the panel needs this note to tell the owner the change is not instant');

  const detailRes = await req(server, 'GET', `${ADMIN_BASE}/clinics/${created.clinic_id}`, { cookie });
  assert.equal(detailRes.status, 200);
  const detail = await detailRes.json();
  assert.deepEqual(detail.clinic.modules, ['crm']);
  assert.equal(detail.checkins.length, 0);

  const revokeRes = await req(server, 'POST', `${ADMIN_BASE}/clinics/${created.clinic_id}/modules`, {
    cookie, body: { module_key: 'crm', granted: false },
  });
  assert.equal(revokeRes.status, 200);

  // ATTACK, driven through this same flow: marketing must still be refused
  // even mid-session, right after a legitimate grant/revoke pair succeeded.
  const marketingRes = await req(server, 'POST', `${ADMIN_BASE}/clinics/${created.clinic_id}/modules`, {
    cookie, body: { module_key: 'marketing', granted: true },
  });
  assert.equal(marketingRes.status, 400, 'marketing must never be grantable, even from a real logged-in session');

  // 5. subscription editor: set an explicit paid-until date
  const subRes = await req(server, 'POST', `${ADMIN_BASE}/clinics/${created.clinic_id}/subscription`, {
    cookie, body: { subscription: 'active', subscription_until: '2027-06-01' },
  });
  assert.equal(subRes.status, 200);
  const afterSub = await (await req(server, 'GET', `${ADMIN_BASE}/clinics/${created.clinic_id}`, { cookie })).json();
  assert.equal(afterSub.clinic.subscription_until, '2027-06-01');

  // ATTACK: clearing the date must send null, never "" — a blank date input
  // and "today" must be distinguishable all the way through to the database.
  const clearRes = await req(server, 'POST', `${ADMIN_BASE}/clinics/${created.clinic_id}/subscription`, {
    cookie, body: { subscription: 'active', subscription_until: null },
  });
  assert.equal(clearRes.status, 200);
  assert.equal(
    db.prepare("SELECT subscription_until FROM clinics WHERE clinic_id = ?").get(created.clinic_id).subscription_until,
    null,
  );

  // 6. unlock-code tool — must match expectedResponse() exactly
  const unlockRes = await req(server, 'POST', `${ADMIN_BASE}/clinics/${created.clinic_id}/unlock-code`, {
    cookie, body: { challenge: 'ABCDEF' },
  });
  assert.equal(unlockRes.status, 200);
  const { code } = await unlockRes.json();
  const secretRow = db.prepare('SELECT unlock_secret FROM clinics WHERE clinic_id = ?').get(created.clinic_id);
  assert.equal(code, expectedResponse({ clinicId: created.clinic_id, challenge: 'ABCDEF', secret: secretRow.unlock_secret }));

  // 7. retire — the row and id survive; there is still no delete
  const retireRes = await req(server, 'POST', `${ADMIN_BASE}/clinics/${created.clinic_id}/retire`, { cookie, body: {} });
  assert.equal(retireRes.status, 200);
  const afterRetire = await (await req(server, 'GET', `${ADMIN_BASE}/clinics/${created.clinic_id}`, { cookie })).json();
  assert.equal(afterRetire.clinic.active, false);
});

// --- requests inbox: list a lead, grant it, and see it reflected -------------

test('flow: the requests inbox lists an open lead and granting it updates both the request and the clinic', async (t) => {
  const { db, server } = await harness(t);
  const cookie = await loggedInCookie(server);

  const created = await (await req(server, 'POST', `${ADMIN_BASE}/clinics`, { cookie, body: { name: 'Клиника с заявкой' } })).json();
  db.prepare("INSERT INTO module_requests (clinic_id, module_key, requested_at) VALUES (?, 'telegram', '2026-08-20T00:00:00Z')")
    .run(created.clinic_id);

  const listRes = await req(server, 'GET', `${ADMIN_BASE}/requests`, { cookie });
  assert.equal(listRes.status, 200);
  const { requests } = await listRes.json();
  const lead = requests.find((r) => r.clinic_id === created.clinic_id);
  assert.ok(lead);
  assert.equal(lead.module_key, 'telegram');
  assert.equal(lead.clinic_name, 'Клиника с заявкой');

  const grantRes = await req(server, 'POST', `${ADMIN_BASE}/requests/${lead.id}/grant`, { cookie, body: {} });
  assert.equal(grantRes.status, 200);
  const grantBody = await grantRes.json();
  assert.equal(grantBody.already, false);
  assert.ok(grantBody.note);

  // ATTACK, driven through this same flow: double-click / double-submit must
  // be a harmless already:true, never a duplicate grant or a 500.
  const secondGrant = await req(server, 'POST', `${ADMIN_BASE}/requests/${lead.id}/grant`, { cookie, body: {} });
  assert.equal(secondGrant.status, 200);
  assert.equal((await secondGrant.json()).already, true);

  const detail = await (await req(server, 'GET', `${ADMIN_BASE}/clinics/${created.clinic_id}`, { cookie })).json();
  assert.deepEqual(detail.clinic.modules, ['telegram'], "the clinic's own chips reflect the grant on next fetch");

  const remaining = await (await req(server, 'GET', `${ADMIN_BASE}/requests`, { cookie })).json();
  assert.ok(!remaining.requests.some((r) => r.id === lead.id), 'a granted request must drop out of the open-requests inbox');
});

// --- 401 mid-session: the panel's own contract with panel-api.js's hook -----

test('a 401 from the admin API carries the standard {error:{code,message}} shape the panel relies on', async (t) => {
  const { server } = await harness(t);
  const res = await req(server, 'GET', `${ADMIN_BASE}/clinics`, {});
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error.code, 'unauthorized');
  assert.ok(body.error.message);
});
