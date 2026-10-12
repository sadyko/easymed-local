// PUBLIC_LICENCE_V1 — СТРАЖ КЛЮЧА ПРОИЗВОДИТЕЛЯ. Какой открытый ключ вшит в
// программу, решает, чьи лицензии принимает каждая клиника и публичный сервер
// api.easymed.uz. Сверено 2026-10-12: вшит НАСТОЯЩИЙ ключ сервера лицензий
// (коммит 6cd66c5c от 2026-08-22, закрытая половина — только на сервере
// лицензий, /etc/easymed-cp/vendor-private.pem); ключ разработки 2026-08-20
// снят тогда же. Замена ключа — сознательный шаг с правкой этого теста.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { vendorPublicKey, verifyLicence } from './licence.js';
import { canonical } from './canonical.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fp = (key) => crypto.createHash('sha256').update(key.export({ format: 'der', type: 'spki' })).digest('hex').slice(0, 32);

/** DER-SHA-256 (первые 32 hex) настоящего ключа сервера лицензий. */
const PRODUCTION_VENDOR_KEY_FP = '46de4fe9a62a7f1349bdd3658be1696a';
/** Ключ разработки 2026-08-20 (закрытая половина лежала в песочнице) и заглушка до него. */
const RETIRED_KEY_FPS = ['d1deb8cc45ab46637ab1ecd9ec8a20fd'];
const PLACEHOLDER_PEM = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAGb9ECWmEzf6FQbrBZ9w7lshQhqowtrbLDFw4rXAxZuE=\n-----END PUBLIC KEY-----';

test('в программу вшит настоящий ключ сервера лицензий — не ключ разработки и не заглушка', () => {
  const k = vendorPublicKey();
  assert.equal(k.asymmetricKeyType, 'ed25519');
  assert.equal(fp(k), PRODUCTION_VENDOR_KEY_FP);
  assert.ok(!RETIRED_KEY_FPS.includes(fp(k)));
  assert.notEqual(fp(k), fp(crypto.createPublicKey(PLACEHOLDER_PEM)));
});

test('verifyLicence без ключа в параметрах проверяет именно этим ключом: чужая подпись — bad_signature', () => {
  const other = crypto.generateKeyPairSync('ed25519');
  const payload = { clinic_id: 'c-000047', clinic_name: 'X', modules: [], valid_until: '2099-01-01T00:00:00Z', issued_at: '2026-10-12T00:00:00Z', nonce: 'TESTONLY' };
  const doc = JSON.stringify({ payload, sig: crypto.sign(null, Buffer.from(canonical(payload)), other.privateKey).toString('base64') });
  assert.deepEqual(verifyLicence(doc, { clinicId: 'c-000047' }), { ok: false, reason: 'bad_signature' });
  assert.equal(verifyLicence(doc, { clinicId: 'c-000047', publicKey: other.publicKey }).ok, true, 'тот же документ своим ключом — да');
});

test('в исходниках licence.js ровно один открытый ключ, и в шапке нет ссылки на снятую проверку DEV_KEY_FINGERPRINT как на действующую', () => {
  const src = fs.readFileSync(path.join(HERE, 'licence.js'), 'utf8');
  assert.equal((src.match(/BEGIN PUBLIC KEY/g) || []).length, 1);
  assert.match(src, /THIS IS THE PRODUCTION KEY/);
  assert.doesNotMatch(src, /logs a warning at every boot while it is in\s*\n?\s*\/\/\s*place/);
});
