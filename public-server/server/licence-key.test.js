// PUBLIC_LICENCE_V1 — страж ключа лицензий публичного сервера: по умолчанию —
// вшитый ключ производителя (настоящий, server/services/control/vendor-key.test.js);
// чужой — только с явным разрешением стенда; запуск идёт через эту проверку.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveLicenceKey, keyFingerprint32 } from './licence-key.js';
import { vendorPublicKey } from '../../server/services/control/licence.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const pem = (key) => key.export({ format: 'pem', type: 'spki' });
const fileOf = (text) => () => text;

test('без PUBLIC_LICENCE_PUBLIC_KEY — вшитый ключ производителя', () => {
  const r = resolveLicenceKey({});
  assert.deepEqual(r, { key: null, source: 'compiled', fingerprint: keyFingerprint32(vendorPublicKey()) });
  assert.equal(r.fingerprint, '46de4fe9a62a7f1349bdd3658be1696a', 'настоящий ключ сервера лицензий (2026-08-22)');
});

test('файл с тем же ключом, что вшит, — тот же «вшитый»; чужой — отказ запуска с именем переменной; со стендовым разрешением — свой', () => {
  assert.equal(resolveLicenceKey({ path: '/etc/k.pem', readFile: fileOf(pem(vendorPublicKey())) }).source, 'compiled');
  const stand = crypto.generateKeyPairSync('ed25519').publicKey;
  assert.throws(() => resolveLicenceKey({ path: '/etc/k.pem', readFile: fileOf(pem(stand)) }), /PUBLIC_LICENCE_PUBLIC_KEY.*PUBLIC_ALLOW_FOREIGN_LICENCE_KEY=1/s);
  const r = resolveLicenceKey({ path: '/etc/k.pem', allowForeign: true, readFile: fileOf(pem(stand)) });
  assert.deepEqual([r.source, r.fingerprint], ['override', keyFingerprint32(stand)]);
  assert.equal(r.key.asymmetricKeyType, 'ed25519');
});

test('не ключ, ключ не Ed25519, нет файла — отказ запуска с именем переменной', () => {
  const x = crypto.generateKeyPairSync('x25519').publicKey;
  for (const readFile of [fileOf('мусор'), fileOf(pem(x)), () => { throw Object.assign(new Error('нет'), { code: 'ENOENT' }); }]) {
    assert.throws(() => resolveLicenceKey({ path: '/etc/k.pem', allowForeign: true, readFile }), /PUBLIC_LICENCE_PUBLIC_KEY: не открытый ключ Ed25519/);
  }
});

test('запуск службы берёт ключ только через resolveLicenceKey — без своего createPublicKey в обход стража', () => {
  const src = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8');
  assert.match(src, /resolveLicenceKey\(\{ path: cfg\.licenceKeyPath, allowForeign: cfg\.allowForeignLicenceKey \}\)/);
  assert.doesNotMatch(src, /createPublicKey/);
});
