// PUBLIC_API_V1 — личность клиники для публичного сервера: пара подписи и пара
// ящика создаются в клинике один раз и переживают перезапуск; подпись запроса
// проверяется открытой половиной и ломается от любой правки; запечатанное
// открывает только эта клиника; испорченный файл — копия, оба — отказ.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from '../../test-helpers/tmpdir.js';
import {
  SYNC_KEY_FILE, loadSyncIdentity, signRequest, verifyRequest, sealFor, openSealed, canonicalRequest, SyncIdentityError,
  syncKeyFingerprint,
} from './sync-identity.js';

const fresh = () => path.join(tmpDir('em-sync-id-'), SYNC_KEY_FILE);

test('создаётся по просьбе, читается тем же; без просьбы и без файла — null', () => {
  const p = fresh();
  assert.equal(loadSyncIdentity({ keyPath: p }), null);
  const a = loadSyncIdentity({ keyPath: p, create: true });
  assert.ok(fs.existsSync(p) && fs.existsSync(p + '.bak'));
  const b = loadSyncIdentity({ keyPath: p });
  assert.equal(b.signPublic, a.signPublic);
  assert.equal(b.boxPublic, a.boxPublic);
  assert.match(a.fingerprint, /^[0-9a-f]{32}$/);
  assert.ok(!fs.readFileSync(p, 'utf8').includes(a.signPublic), 'в файле — закрытые половины, не открытые');
});

test('подпись запроса: проверяется открытой половиной; правка метода, пути, времени или тела ломает её', () => {
  const id = loadSyncIdentity({ keyPath: fresh(), create: true });
  const parts = { method: 'PUT', path: '/_sync/v1/snapshot', time: '2030-03-11T04:00:00Z', body: '{"a":1}' };
  const sig = signRequest(id, parts);
  assert.equal(verifyRequest(id.signPublic, parts, sig), true);
  for (const over of [{ method: 'POST' }, { path: '/_sync/v1/keys' }, { time: '2030-03-11T04:00:01Z' }, { body: '{"a":2}' }]) {
    assert.equal(verifyRequest(id.signPublic, { ...parts, ...over }, sig), false, JSON.stringify(over));
  }
  const other = loadSyncIdentity({ keyPath: fresh(), create: true });
  assert.equal(verifyRequest(other.signPublic, parts, sig), false);
  assert.equal(canonicalRequest(parts).split('\n').length, 4);
});

test('ящик: запечатанное открывает только эта клиника; испорченное — отказ', () => {
  const id = loadSyncIdentity({ keyPath: fresh(), create: true });
  const sealed = sealFor(id.boxPublic, { name: 'Абдурахмонов Фаррух', phone: '+998901234567' });
  assert.ok(!sealed.includes('Абдурахмонов') && !sealed.includes('998901234567'));
  assert.deepEqual(openSealed(id, sealed), { name: 'Абдурахмонов Фаррух', phone: '+998901234567' });
  const other = loadSyncIdentity({ keyPath: fresh(), create: true });
  assert.throws(() => openSealed(other, sealed));
  const parts = sealed.split('.');
  parts[4] = Buffer.from('подмена').toString('base64');
  assert.throws(() => openSealed(id, parts.join('.')));
  assert.throws(() => openSealed(id, 'мусор'), SyncIdentityError);
});

test('испорченный файл — копия; испорчены оба — отказ, а не новая пара', () => {
  const p = fresh();
  const a = loadSyncIdentity({ keyPath: p, create: true });
  fs.writeFileSync(p, 'испорчено');
  assert.equal(loadSyncIdentity({ keyPath: p, create: true }).signPublic, a.signPublic);
  fs.writeFileSync(p + '.bak', '{"v":1,"sign":"xx","box":"yy"}');
  assert.throws(() => loadSyncIdentity({ keyPath: p, create: true }), SyncIdentityError);
});

// PUBLIC_LICENCE_V1 — отпечаток присланной открытой половины считается так же,
// как свой: его вписывает в лицензию сервер лицензий (шаг 8c).
test('syncKeyFingerprint: открытая половина → тот же отпечаток, что у клиники; ящик, мусор, лишние байты — пусто', () => {
  const id = loadSyncIdentity({ keyPath: fresh(), create: true });
  assert.equal(syncKeyFingerprint(id.signPublic), id.fingerprint);
  assert.match(id.fingerprint, /^[0-9a-f]{32}$/);
  const longer = Buffer.concat([Buffer.from(id.signPublic, 'base64'), Buffer.from([0])]).toString('base64');
  for (const bad of [id.boxPublic, '', 'не ключ', null, undefined, 42, {}, longer, 'A'.repeat(201)]) {
    assert.equal(syncKeyFingerprint(bad), '', String(bad).slice(0, 20));
  }
});
