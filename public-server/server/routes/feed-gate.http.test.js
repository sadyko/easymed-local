// PUBLIC_LICENCE_V1 — список производителя у входа: клиника, скрытая списком, —
// партнёрам 503 «временно недоступна» с телефоном; отозванный ключ партнёра —
// 401 key_disabled; запрос клиники отозванным ключом обмена — 401; скрытая
// клиника сама по-прежнему говорит с сервером (события по принятым записям).
import test from 'node:test';
import assert from 'node:assert/strict';
import { partnerStand } from '../test-helpers/partner-stand.js';
import { signTestFeed } from '../test-helpers/feed-fixture.js';
import { testDb, testVendor, testClinic, syncCall, NOW } from '../test-helpers/fixture.js';
import { createPublicServer } from '../app.js';
import { emptyFeed, applyFeedText } from '../store/feed.js';
import { keyHash } from '../../../server/services/api/secret-box.js';
import { listen } from '../../../control-plane/server/test-helpers/listen.js';
import { isoOf } from '../lib/time.js';

let tick = 0;
/** Подписанный список стенда, принятый в holder стенда (через проверку подписи). */
function feedFor(db, vendor, lists) {
  const h = emptyFeed();
  tick += 1;
  const r = applyFeedText(db, h, signTestFeed(vendor, { issuedAt: new Date(NOW + tick).toISOString(), ...lists }), { publicKey: vendor.publicKey, now: NOW });
  assert.equal(r.ok, true);
  return h;
}
const json = async (res) => ({ status: res.status, body: await res.json() });

test('партнёр: клиника в clinics_off или с отозванным ключом обмена — 503 с телефоном; ключ партнёра отозван — 401 key_disabled', async (t) => {
  const s = await partnerStand();
  t.after(s.close);
  assert.equal((await s.get('/shifo/v1/clinic')).status, 200);
  s.ctx.feed = feedFor(s.db, s.vendor, { clinicsOff: [s.clinicId] });
  const off = await json(await s.get('/shifo/v1/clinic'));
  assert.deepEqual([off.status, off.body.error.code, off.body.error.phone], [503, 'licence_lapsed', '+998712000000']);
  assert.equal(off.body.error.message, 'Клиника временно недоступна. Позвоните в клинику.', 'не «не оплатила»');
  s.ctx.feed = feedFor(s.db, s.vendor, { syncKeysRevoked: [s.clinic.identity.fingerprint] });
  assert.equal((await s.get('/shifo/v1/doctors')).status, 503);
  s.ctx.feed = feedFor(s.db, s.vendor, { partnerKeysRevoked: [keyHash(s.key)] });
  const revoked = await json(await s.get('/shifo/v1/clinic'));
  assert.deepEqual([revoked.status, revoked.body.error.code], [401, 'key_disabled']);
  assert.equal((await s.send('POST', '/shifo/v1/requests', { name: 'ТЕСТ', phone: '+998901234567' })).status, 401, 'и запись — тоже');
  s.ctx.feed = feedFor(s.db, s.vendor, { partnerKeysRevoked: ['ef'.repeat(32)], clinicsOff: ['c-000001'] });
  assert.equal((await s.get('/shifo/v1/clinic')).status, 200, 'чужие записи списка этой клинике не мешают');
});

test('канал клиники: отозванный ключ обмена — 401 invalid_signature; клиника, скрытая от партнёров, говорит с сервером как прежде', async (t) => {
  const { db, dir } = testDb();
  const vendor = testVendor();
  const s = createPublicServer({ db, dataDir: dir, now: () => NOW, licencePublicKey: vendor.publicKey, requireHttps: false, trustProxy: false });
  const server = await listen(s.app);
  t.after(() => new Promise((r) => server.close(r)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const c = testClinic(vendor);
  const call = () => syncCall(base, c, 'GET', '/_sync/v1/inbox?after=', undefined, { time: isoOf(NOW) });
  assert.equal((await call()).status, 200);
  s.ctx.feed = feedFor(db, vendor, { clinicsOff: [c.clinicId] });
  assert.equal((await call()).status, 200, 'не оплачено / выключено — события по принятым записям доходят');
  s.ctx.feed = feedFor(db, vendor, { syncKeysRevoked: [c.identity.fingerprint] });
  const r = await call();
  assert.deepEqual([r.status, r.json.error.code], [401, 'invalid_signature']);
  const other = testClinic(vendor, { clinicId: 'c-000778' });
  assert.equal((await syncCall(base, other, 'GET', '/_sync/v1/inbox?after=', undefined, { time: isoOf(NOW) })).status, 200, 'другие клиники — как прежде');
});
