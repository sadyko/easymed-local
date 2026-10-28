// FIX_318_V1 (C3) — СКВОЗНОЙ ПРОГОН АДРЕСА СТАНЦИИ: настоящая клиника БЕЗ API
// партнёров (ни имени в адресе, ни подключений) ↔ настоящий публичный сервер.
//
// Раньше ключи с секретом адреса станции уходили только у клиники с API
// партнёров: экран «Телефония» говорил «готово», а сервер секрета не знал (или
// знал прежний) — станция получала 404 на новый адрес, а прежний работал. Здесь
// закреплено, что протокол публичного сервера принимает ключи без снимка и
// подключений (PUT /_sync/v1/keys {connections: [], ring_token}), что «готово»
// клиники совпадает с тем, что сервер принимает, и что смена адреса отключает
// прежний секрет в ближайший такт. Событие доходит до клиники длинным опросом.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from '../../server/db/connection.js';
import { migrate } from '../../server/db/migrate.js';
import { tmpDir } from '../../server/test-helpers/tmpdir.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';
import { loadSyncIdentity, SYNC_KEY_FILE } from '../../server/services/api/sync-identity.js';
import { syncOnce, ringRelayStatus, buildSyncContext } from '../../server/services/api/public-sync.js';
import { pullOnce, resetLive, liveCalls } from '../../server/services/telephony/live.js';
import { createPublicServer } from './app.js';
import { testDb, testVendor, signTestLicence } from './test-helpers/fixture.js';

process.env.LIS_ENABLED = '0';

test('FIX_318_V1: клиника без API партнёров — секрет адреса станции доходит до сервера, «готово» честное, смена адреса отключает прежний', async (t) => {
  const db = openDb(':memory:');
  migrate(db);
  const dataDir = tmpDir('em-pub-ring-');
  const keyPath = path.join(dataDir, SYNC_KEY_FILE);
  const identity = loadSyncIdentity({ keyPath, create: true });
  const vendor = testVendor();
  fs.writeFileSync(path.join(dataDir, 'licence.dat'), signTestLicence(vendor, { clinic_id: 'c-000777', clinic_name: 'Шифо', modules: [],
    valid_until: '2030-04-01T00:00:00Z', issued_at: '2030-03-10T00:00:00Z', nonce: 'ring-e2e', api_sync_key: identity.fingerprint }));
  fs.writeFileSync(path.join(dataDir, 'control.json'), JSON.stringify({ clinic_id: 'c-000777' }));

  let clock = Date.parse('2030-03-11T04:00:00Z');
  const pub = testDb();
  const { app } = createPublicServer({ db: pub.db, dataDir: pub.dir, now: () => clock, licencePublicKey: vendor.publicKey,
    baseUrl: 'https://api.test', requireHttps: false, trustProxy: false, version: 'e2e' });
  const server = await listen(app);
  t.after(() => new Promise((r) => server.close(r)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const env = { EASYMED_PUBLIC_URL: base };
  const sync = async () => { const r = await syncOnce(db, dataDir, { fetchImpl: globalThis.fetch, env, now: () => clock, keyPath }); clock += 15000; return r; };
  const ready = () => ringRelayStatus(db, dataDir, { keyPath });
  let n = 0;
  const hook = (token) => fetch(base + '/_pbx/v1/c-000777/' + token, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: 'call_start', direction: 'inbound', uuid: 'u-' + (++n), caller: '998901112233', callee: '101' }) });
  const A = 'a1'.repeat(16);
  const B = 'b2'.repeat(16);

  db.prepare('UPDATE telephony_settings SET ring_token = ? WHERE id = 1').run(A);
  assert.equal(ready().reason, 'pending');
  assert.equal((await hook(A)).status, 404, 'сервер знает секрет до такта');
  const first = await sync();
  assert.deepEqual(first, { ok: false, reason: 'no_slug' }, 'ключи не приняты сервером: ' + JSON.stringify(first));
  assert.equal(ready().ready, true);
  assert.equal((await hook(A)).status, 200, '«готово» на клинике, а сервер секрет не принимает');

  // Событие доходит до клиники подписанным каналом — тем же ключом и лицензией.
  resetLive();
  const ctx = buildSyncContext(db, dataDir, { fetchImpl: globalThis.fetch, env, now: () => clock, keyPath, createKey: false });
  assert.equal(ctx.blocked, undefined);
  const pulled = await pullOnce(ctx, { now: () => clock });
  assert.ok(pulled.count >= 1);
  assert.ok(liveCalls(clock).some((c) => c.caller === '998901112233' && c.state === 'ringing'));
  resetLive();

  // Сменили адрес: пока такт не донёс — «не готово», прежний работает, новый — 404.
  db.prepare('UPDATE telephony_settings SET ring_token = ? WHERE id = 1').run(B);
  assert.deepEqual([ready().ready, ready().reason], [false, 'pending']);
  assert.equal((await hook(B)).status, 404);
  await sync();
  assert.equal(ready().ready, true);
  assert.equal((await hook(B)).status, 200, 'новый адрес не заработал после такта');
  assert.equal((await hook(A)).status, 404, 'прежний адрес продолжает работать после смены');
  assert.deepEqual(pub.db.prepare("SELECT clinic_id, slug FROM clinics WHERE clinic_id = 'c-000777'").get(), { clinic_id: 'c-000777', slug: null },
    'клиника без API партнёров получила имя в адресе');
  assert.equal(pub.db.prepare("SELECT COUNT(*) AS n FROM connections WHERE clinic_id = 'c-000777'").get().n, 0);
});
