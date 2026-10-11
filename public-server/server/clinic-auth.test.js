// PUBLIC_SERVER_V1 — личность клиники: лицензия производителя с отпечатком её
// ключа, время и подпись запроса. Подделка любой части — отказ с кодом.
import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyClinicRequest, verifyClinicHeaders, verifyClinicSignature, keyFingerprint } from './clinic-auth.js';
import { testVendor, testClinic, signedHeaders, NOW } from './test-helpers/fixture.js';

const vendor = testVendor();
const opts = { licencePublicKey: vendor.publicKey, now: NOW };
const time = new Date(NOW).toISOString();
const lower = (h) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
const req = (clinic, { method = 'PUT', url = '/_sync/v1/keys', body = '{"a":1}', at = time, headers = {} } = {}) => ({
  method, url, body: Buffer.from(body), headers: { ...lower(signedHeaders(clinic, { method, path: url, body, time: at })), ...headers },
});

test('настоящая клиника: лицензия, отпечаток, время и подпись сходятся', () => {
  const c = testClinic(vendor, { subscription: 'unpaid' });
  const r = verifyClinicRequest(req(c), opts);
  assert.equal(r.ok, true);
  assert.equal(r.clinicId, c.clinicId);
  assert.equal(r.fingerprint, c.identity.fingerprint);
  assert.equal(keyFingerprint(c.identity.signPublic), c.identity.fingerprint, 'отпечаток считается так же, как в клинике');
  assert.deepEqual(r.licence, { issued_at: '2030-03-10T00:00:00Z', valid_until: '2030-04-01T00:00:00Z', subscription: 'unpaid' });
  const q = verifyClinicRequest(req(c, { method: 'GET', url: '/_sync/v1/inbox?after=12', body: '' }), opts);
  assert.equal(q.ok, true, 'путь подписан вместе с query, тело пустое');
});

test('подделка любой части — отказ', () => {
  const c = testClinic(vendor);
  const other = testClinic(vendor);
  const strange = testClinic(testVendor());
  const cases = [
    ['чужая подпись производителя', verifyClinicRequest(req(strange), opts), 'licence_invalid'],
    ['лицензия другой клиники', verifyClinicRequest(req(c, { headers: { 'x-easymed-clinic': 'c-000778' } }), opts), 'licence_invalid'],
    ['ключ не тот, что в лицензии', verifyClinicRequest(req(c, { headers: { 'x-easymed-key': other.identity.signPublic } }), opts), 'invalid_signature'],
    ['подменили тело', verifyClinicRequest({ ...req(c), body: Buffer.from('{"a":2}') }, opts), 'invalid_signature'],
    ['подменили путь', verifyClinicRequest({ ...req(c), url: '/_sync/v1/snapshot' }, opts), 'invalid_signature'],
    ['подменили метод', verifyClinicRequest({ ...req(c), method: 'POST' }, opts), 'invalid_signature'],
    ['нет лицензии', verifyClinicRequest(req(c, { headers: { 'x-easymed-licence': '' } }), opts), 'licence_invalid'],
    ['мусор в id клиники', verifyClinicRequest(req(c, { headers: { 'x-easymed-clinic': '../x' } }), opts), 'invalid_signature'],
  ];
  for (const [why, r, code] of cases) assert.deepEqual([why, r.ok, r.code], [why, false, code]);
});

test('часы клиники дальше допуска — clock_skew со временем сервера; в допуске — да', () => {
  const c = testClinic(vendor);
  const late = verifyClinicRequest(req(c, { at: new Date(NOW - 16 * 60000).toISOString() }), opts);
  assert.equal(late.code, 'clock_skew');
  assert.equal(late.server_time, '2030-03-11T04:00:00Z');
  assert.equal(verifyClinicRequest(req(c, { at: new Date(NOW + 14 * 60000).toISOString() }), opts).ok, true);
  assert.equal(verifyClinicRequest(req(c, { at: new Date(NOW - 50 * 60000).toISOString() }), { ...opts, skewMs: 3600000 }).ok, true);
});

test('ревью 8b, C1: заголовки проверяются без тела, подпись — отдельно', () => {
  const c = testClinic(vendor);
  const r = req(c);
  const pre = verifyClinicHeaders({ headers: r.headers }, opts);
  assert.equal(pre.ok, true);
  assert.equal(pre.fingerprint, c.identity.fingerprint);
  assert.equal(verifyClinicHeaders({ headers: { ...r.headers, 'x-easymed-licence': '' } }, opts).code, 'licence_invalid');
  assert.equal(verifyClinicSignature(r), true);
  assert.equal(verifyClinicSignature({ ...r, body: Buffer.from('{"a":2}') }), false);
});
