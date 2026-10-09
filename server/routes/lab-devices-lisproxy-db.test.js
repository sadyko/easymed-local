// LIS_PROXY_V1 (ревью, Р21) — модель прибора за LIS Proxy и через /api/db —
// только BS-200, BC-780 или AutoLumo A1000 (решение владельца 2026-10-09, п. 6).
// RPC lis_device_add это уже требует, а правка строки через /api/db ставила
// строке прокси любую модель (и пустую): BS-240 читался бы правилами химии без
// своих номеров, «общий HL7» — без правил вовсе. Строки своего порта — как прежде.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { hashPassword } from '../services/auth.js';
import { createApp } from '../app.js';
import { licensedDataDir } from '../services/control/licensed-fixture.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';
import { PROXY_MODEL_REQUIRED } from '../services/rpc/lis.js';

async function startServer() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)')
    .run('laborant', hashPassword('password1'), 'Лаборант', 'lab');
  const server = await listen(createApp(db, { dataDir: licensedDataDir() }));
  return { db, server, base: `http://127.0.0.1:${server.address().port}` };
}

async function login(base) {
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'laborant', password: 'password1' }),
  });
  assert.equal(res.status, 200, 'вход лаборанта');
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

async function update(base, cookie, filters, values) {
  const res = await fetch(base + '/api/db', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ table: 'lab_devices', op: 'update', values, filters }),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
const byId = (id) => [{ col: 'id', op: 'eq', val: id }];
const profileOf = (db, id) => db.prepare('SELECT profile FROM lab_devices WHERE id = ?').get(id).profile;

function proxyRow(db, profile = 'mindray-bs-200') {
  return Number(db.prepare(`INSERT INTO lab_devices (name, profile, transport, host, enabled, discovered, added, model_confirmed, via, proxy_name, proxy_ip)
                            VALUES ('bs200', ?, 'mllp', '', 1, 1, 1, 1, 'lisproxy', 'bs200', '10.0.0.5')`).run(profile).lastInsertRowid);
}
function ownRow(db) {
  return Number(db.prepare(`INSERT INTO lab_devices (name, profile, transport, host, port, enabled, discovered, added)
                            VALUES ('BS-240', 'mindray-bs-240', 'mllp', '10.0.0.9', 2575, 1, 0, 1)`).run().lastInsertRowid);
}

test('Р21 через /api/db: строке LIS Proxy модель вне трёх (и пустая) — отказ словами, модель не меняется; из трёх — можно', async (t) => {
  const { db, server, base } = await startServer();
  t.after(() => { server.close(); db.close(); });
  const cookie = await login(base);
  const id = proxyRow(db);
  for (const profile of ['mindray-bs-240', 'mindray-cl-900i', '', null]) {
    const r = await update(base, cookie, byId(id), { profile });
    assert.equal(r.status, 409, String(profile));
    assert.deepEqual(r.json.error, { code: 'proxy_model_required', message: PROXY_MODEL_REQUIRED }, String(profile));
    assert.equal(profileOf(db, id), 'mindray-bs-200', String(profile));
  }
  assert.equal((await update(base, cookie, byId(id), { profile: 'mindray-bc-780' })).status, 200);
  assert.equal(profileOf(db, id), 'mindray-bc-780');
  assert.equal((await update(base, cookie, byId(id), { name: 'BC-780 лаборатории', enabled: 0 })).status, 200, 'правка без модели — как прежде');
});

test('Р21 через /api/db: пачка строк, среди которых строка LIS Proxy, — отказ целиком; строка своего порта — любая модель, как прежде', async (t) => {
  const { db, server, base } = await startServer();
  t.after(() => { server.close(); db.close(); });
  const cookie = await login(base);
  const pid = proxyRow(db);
  const oid = ownRow(db);
  const r = await update(base, cookie, [{ col: 'id', op: 'in', val: [pid, oid] }], { profile: 'mindray-cl-900i' });
  assert.equal(r.status, 409);
  assert.deepEqual([profileOf(db, pid), profileOf(db, oid)], ['mindray-bs-200', 'mindray-bs-240']);
  assert.equal((await update(base, cookie, byId(oid), { profile: 'mindray-cl-900i' })).status, 200);
  assert.equal(profileOf(db, oid), 'mindray-cl-900i');
});
