// CLINIC_API_STEP7_V1 — ключи подключений API: выпуск (CSPRNG), KEK в каталоге
// данных, шифротекст с отпечатком KEK, отпечаток ключа для узнавания.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from '../../test-helpers/tmpdir.js';
import { KEY_RE, SECRET_RE } from '../../../public/js/shared/api-connections.js';
import { STRINGS } from '../../../public/js/admin/i18n-strings.js';
import {
  KEK_FILE, SECRET_MESSAGES, SecretBoxError, loadKek, kekId, seal, unseal, keyHash, newApiKey, newWebhookSecret, tailOf,
} from './secret-box.js';

const kekPath = () => path.join(tmpDir('em-apikek-'), KEK_FILE);
const refusal = (fn) => { try { fn(); } catch (e) { return e; } return assert.fail('ожидался отказ'); };

test('выпуск: формат, префикс, неповторимость', () => {
  const keys = new Set();
  for (let i = 0; i < 2000; i++) {
    const k = newApiKey();
    assert.match(k, KEY_RE);
    keys.add(k);
  }
  assert.equal(keys.size, 2000);
  assert.match(newWebhookSecret(), SECRET_RE);
  assert.equal(tailOf('em_live_abcdWXYZ'), 'WXYZ');
});

test('KEK: нет файла — null; create — 64 hex и копия .bak; повтор — тот же ключ', () => {
  const p = kekPath();
  assert.equal(loadKek({ kekPath: p }), null);
  const k1 = loadKek({ kekPath: p, create: true });
  assert.equal(k1.length, 32);
  assert.match(fs.readFileSync(p, 'utf8'), /^[0-9a-f]{64}$/);
  assert.equal(fs.readFileSync(p + '.bak', 'utf8'), fs.readFileSync(p, 'utf8'));
  assert.ok(loadKek({ kekPath: p, create: true }).equals(k1));
});

test('KEK: основной пропал или испорчен — читается копия; испорчены оба — отказ, а не новый ключ', () => {
  const p = kekPath();
  const k1 = loadKek({ kekPath: p, create: true });
  fs.unlinkSync(p);
  assert.ok(loadKek({ kekPath: p }).equals(k1), 'пропал основной — копия');
  fs.writeFileSync(p, 'мусор');
  assert.ok(loadKek({ kekPath: p }).equals(k1), 'испорчен основной — копия');
  fs.writeFileSync(p + '.bak', 'мусор');
  const e = refusal(() => loadKek({ kekPath: p, create: true }));
  assert.ok(e instanceof SecretBoxError);
  assert.equal(e.message, SECRET_MESSAGES.kekBroken);
  assert.equal(fs.readFileSync(p, 'utf8'), 'мусор', 'испорченный файл не перезаписан молча');
});

test('шифротекст: v1.<отпечаток KEK>.<…>; значения в нём нет; каждый раз другой; обратно — то же', () => {
  const kek = loadKek({ kekPath: kekPath(), create: true });
  const key = newApiKey();
  const a = seal(key, kek);
  const b = seal(key, kek);
  assert.match(a, new RegExp('^v1\\.' + kekId(kek) + '\\.[A-Za-z0-9+/=]+$'));
  assert.ok(!a.includes(key) && !a.includes(key.slice(8)), 'ключ виден в шифротексте');
  assert.notEqual(a, b, 'одинаковый шифротекст — повторный nonce');
  assert.equal(unseal(a, kek), key);
});

test('чужой KEK — «файл остался на прежнем компьютере»; правка байта — «повреждён»', () => {
  const kek = loadKek({ kekPath: kekPath(), create: true });
  const other = loadKek({ kekPath: kekPath(), create: true });
  const sealed = seal(newApiKey(), kek);
  for (const k of [other, null]) {
    const e = refusal(() => unseal(sealed, k));
    assert.equal(e.status, 409);
    assert.equal(e.message, SECRET_MESSAGES.kekMissing);
  }
  const [v, id, body] = sealed.split('.');
  const bad = v + '.' + id + '.' + (body[0] === 'A' ? 'B' : 'A') + body.slice(1);
  assert.equal(refusal(() => unseal(bad, kek)).message, SECRET_MESSAGES.sealBroken);
  assert.equal(refusal(() => unseal('', kek)).message, SECRET_MESSAGES.sealBroken);
});

test('отпечаток ключа: SHA-256 hex, разный у разных ключей', () => {
  const k = newApiKey();
  assert.match(keyHash(k), /^[0-9a-f]{64}$/);
  assert.equal(keyHash(k), keyHash(k));
  assert.notEqual(keyHash(k), keyHash(newApiKey()));
});

test('сообщения переведены', () => {
  for (const m of Object.values(SECRET_MESSAGES)) assert.ok(STRINGS[m] && STRINGS[m].uz && STRINGS[m].en, m);
});
