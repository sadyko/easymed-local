import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { telephonyWebhooks, normalizeIp, BINOTEL_SOURCE_IPS } from './webhooks.js';

const fresh = () => { const db = openDb(':memory:'); migrate(db); return db; };

// A minimal host app shaped like app.js around the mount point: the /api
// JSON parser and attachControl's req.control, both of which the router
// relies on being upstream. control defaults to "callcenter granted" so each
// test states only what it is about.
function startHook(db, { allowedIps, control = { has: (k) => k === 'callcenter' } } = {}) {
  const app = express();
  app.use('/api', express.json({ limit: '100kb' }));
  app.use((req, res, next) => { req.control = control; next(); });
  app.use('/api/telephony/binotel', telephonyWebhooks(db, { allowedIps }));
  return new Promise((resolve) => {
    // Wait for 'listening' before reading address() — app.test.js's rule for
    // this Node/Windows combination.
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, base: `http://127.0.0.1:${server.address().port}/api/telephony/binotel` });
    });
  });
}

// Binotel POSTs application/x-www-form-urlencoded (support's letter, 2026-08).
// URLSearchParams sets that content type by itself.
const postForm = (base, fields) => fetch(base, { method: 'POST', body: new URLSearchParams(fields) });

const enableHooks = (db, extra = '') =>
  db.prepare(`UPDATE telephony_settings SET webhooks_enabled = 1 ${extra} WHERE id = 1`).run();

const NOT_FOUND_BODY = { error: { code: 'not_found', message: 'Unknown API endpoint.' } };

test('webhooks disabled: 404 with the app-standard body, even from an allowlisted address', async () => {
  const db = fresh();
  const { server, base } = await startHook(db, { allowedIps: ['127.0.0.1'] });
  try {
    const res = await postForm(base, { requestType: 'apiCallSettings', externalNumber: '998909610004' });
    // 404 and not 403: the off state must not advertise that the endpoint exists.
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), NOT_FOUND_BODY);
  } finally { server.close(); }
});

test('module not granted: the same non-advertising 404', async () => {
  const db = fresh();
  enableHooks(db);
  const { server, base } = await startHook(db, { allowedIps: ['127.0.0.1'], control: { has: () => false } });
  try {
    const res = await postForm(base, { requestType: 'apiCallSettings', externalNumber: '998909610004' });
    assert.equal(res.status, 404);
  } finally { server.close(); }
});

test('a non-allowlisted source is refused — and X-Forwarded-For cannot talk its way in', async () => {
  const db = fresh();
  enableHooks(db);
  // The allowlist names a Binotel-style address; the test connects from
  // 127.0.0.1, so the socket says "not Binotel" no matter what headers claim.
  const { server, base } = await startHook(db, { allowedIps: ['203.0.113.5'] });
  try {
    const res = await fetch(base, {
      method: 'POST',
      headers: { 'X-Forwarded-For': '203.0.113.5' },
      body: new URLSearchParams({ requestType: 'apiCallSettings', externalNumber: '998909610004' }),
    });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), NOT_FOUND_BODY);
  } finally { server.close(); }
});

test('apiCallSettings (urlencoded): matched patient → name + customerData in the letter’s shape', async () => {
  const db = fresh();
  enableHooks(db, ", public_base_url = 'https://clinic.example.uz'");
  const pid = db.prepare("INSERT INTO patients (full_name, phone) VALUES ('Иванов Иван', '+998 90 961 00 04')").run().lastInsertRowid;
  const { server, base } = await startHook(db, { allowedIps: ['127.0.0.1'] });
  try {
    const res = await postForm(base, { requestType: 'apiCallSettings', externalNumber: '998909610004', companyID: '77' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      name: 'Иванов Иван',
      customerData: {
        assignedToEmployeeNumber: '',
        assignedToEmployeeEmail: '',
        linkToCrmUrl: `https://clinic.example.uz/admin#patient=${pid}`,
        linkToCrmTitle: 'Карта пациента: Иванов Иван',
      },
    });
  } finally { server.close(); }
});

test('apiCallSettings: unknown caller gets the generic empty-name answer, not an error', async () => {
  const db = fresh();
  enableHooks(db);
  const { server, base } = await startHook(db, { allowedIps: ['127.0.0.1'] });
  try {
    const res = await postForm(base, { requestType: 'apiCallSettings', externalNumber: '998900000000' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { name: '' });
  } finally { server.close(); }
});

test('company_id set: a payload for another company (or none) is refused; the right one passes', async () => {
  const db = fresh();
  enableHooks(db, ", company_id = '95710'");
  const { server, base } = await startHook(db, { allowedIps: ['127.0.0.1'] });
  try {
    assert.equal((await postForm(base, { requestType: 'apiCallSettings', externalNumber: '1', companyID: '11111' })).status, 404);
    // Missing companyID while one is expected IS a mismatch — same refusal.
    assert.equal((await postForm(base, { requestType: 'apiCallSettings', externalNumber: '1' })).status, 404);
    assert.equal((await postForm(base, { requestType: 'apiCallSettings', externalNumber: '1', companyID: '95710' })).status, 200);
  } finally { server.close(); }
});

test('apiCallCompleted (urlencoded bracket keys): files the call and answers the exact literal', async () => {
  const db = fresh();
  enableHooks(db);
  const { server, base } = await startHook(db, { allowedIps: ['127.0.0.1'] });
  try {
    // extended:true is what turns callDetails[…] into a nested object — the
    // wire shape Binotel's letter describes.
    const res = await postForm(base, {
      requestType: 'apiCallCompleted',
      'callDetails[generalCallID]': 'GC-500',
      'callDetails[startTime]': '1755950400',
      'callDetails[callType]': '0',
      'callDetails[externalNumber]': '998909610004',
      'callDetails[internalNumber]': '901',
      'callDetails[billsec]': '42',
      'callDetails[disposition]': 'ANSWER',
    });
    assert.equal(res.status, 200);
    // EXACT bytes — Binotel matches the body and retries anything else.
    assert.equal(await res.text(), '{"status":"success"}');
    const row = db.prepare("SELECT * FROM calls WHERE general_call_id = 'GC-500'").get();
    assert.equal(row.source, 'webhook');
    assert.equal(row.billsec, 42);
    assert.equal(row.disposition, 'ANSWER');
  } finally { server.close(); }
});

test('apiCallCompleted still accepts JSON — the pre-letter shape stays valid defensively', async () => {
  const db = fresh();
  enableHooks(db);
  const { server, base } = await startHook(db, { allowedIps: ['127.0.0.1'] });
  try {
    const res = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestType: 'apiCallCompleted', callDetails: { generalCallID: 'GC-501', startTime: 1755950500 } }),
    });
    assert.equal(await res.text(), '{"status":"success"}');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM calls WHERE general_call_id = 'GC-501'").get().n, 1);
  } finally { server.close(); }
});

test('poll first, webhook second: still one row — double delivery is idempotent end-to-end', async () => {
  const db = fresh();
  enableHooks(db);
  db.prepare("INSERT INTO calls (general_call_id, started_at, source) VALUES ('GC-500','2026-08-23T10:00:00Z','poll')").run();
  const { server, base } = await startHook(db, { allowedIps: ['127.0.0.1'] });
  try {
    const res = await postForm(base, {
      requestType: 'apiCallCompleted',
      'callDetails[generalCallID]': 'GC-500',
      'callDetails[startTime]': '1755950400',
    });
    // The duplicate is still a success — Binotel already delivered it once;
    // retrying would change nothing.
    assert.equal(await res.text(), '{"status":"success"}');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM calls').get().n, 1);
    assert.equal(db.prepare("SELECT source FROM calls WHERE general_call_id='GC-500'").get().source, 'poll');
  } finally { server.close(); }
});

test('unknown requestType and non-POST both get the non-advertising 404', async () => {
  const db = fresh();
  enableHooks(db);
  const { server, base } = await startHook(db, { allowedIps: ['127.0.0.1'] });
  try {
    assert.equal((await postForm(base, { requestType: 'somethingNew' })).status, 404);
    assert.equal((await fetch(base)).status, 404);
  } finally { server.close(); }
});

test('the shipped allowlist is frozen and holds nothing but IPv4 dotted quads', () => {
  // The paste-point contract: BINOTEL_SOURCE_IPS is the ONLY place the vendor
  // addresses go, so garbage pasted there must scream here. Empty is legal —
  // and is the shipped state until the vendor list is retrieved (see the
  // comment on the constant): empty fails CLOSED, refusing everything.
  assert.ok(Object.isFrozen(BINOTEL_SOURCE_IPS));
  for (const ip of BINOTEL_SOURCE_IPS) {
    assert.match(ip, /^(\d{1,3})(\.\d{1,3}){3}$/);
  }
});

test('normalizeIp strips only the IPv4-mapped prefix', () => {
  assert.equal(normalizeIp('::ffff:194.213.98.1'), '194.213.98.1');
  assert.equal(normalizeIp('194.213.98.1'), '194.213.98.1');
  assert.equal(normalizeIp('::1'), '::1');
  assert.equal(normalizeIp(undefined), '');
});

test('through the REAL app: mounted before session auth, refusals fail closed at the IP gate', async () => {
  // The whole point of the mount slot: a cookie-less Binotel POST must never
  // meet a 401 — it has to reach the router's own gates. With webhooks
  // enabled and the module granted through a real signed licence, the
  // default (shipped-empty) allowlist is what refuses — proven by the warn
  // line, which only the IP gate prints.
  const { createApp } = await import('../../app.js');
  const { licensedDataDir } = await import('../control/licensed-fixture.js');
  const db = fresh();
  enableHooks(db);
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  try {
    const app = createApp(db, { dataDir: licensedDataDir({ modules: ['callcenter'] }) });
    const { server, port } = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve({ server: s, port: s.address().port }));
    });
    try {
      const res = await postForm(`http://127.0.0.1:${port}/api/telephony/binotel`, {
        requestType: 'apiCallCompleted', 'callDetails[generalCallID]': 'GC-1', 'callDetails[startTime]': '1755950400',
      });
      assert.notEqual(res.status, 401, 'session auth must never see this route');
      assert.equal(res.status, 404, 'the empty shipped allowlist fails closed');
      assert.ok(warns.some((w) => w.includes('non-Binotel address refused')),
        'the request reached the IP gate — past the toggle and the module check');
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM calls').get().n, 0);
    } finally { server.close(); }
  } finally { console.warn = origWarn; }
});
