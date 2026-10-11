// PUBLIC_SERVER_V1 — клиники: самая новая лицензия решает, ключи заменяются
// целиком (неверное поле не роняет список), имя в адресе — занятость и 30 дней
// прежнему, старое присланное не откатывает новое; файлы снимка.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { admitClinic, saveKeys, saveSnapshot, saveSlots, resolveSlug, snapshotOf, connectionByHash, originAllowedForClinic, markUsed, clinicRow }
  from './clinics.js';
import { missingMedia, putMedia, mediaFile, gcMedia } from './media.js';
import { testDb, testVendor, testClinic, NOW } from '../test-helpers/fixture.js';
import { fakePng } from '../../../server/test-helpers/fake-png.js';
import { isoOf } from '../lib/time.js';

const vendor = testVendor();
const auth = (c, licence = {}) => ({ clinicId: c.clinicId, fingerprint: c.identity.fingerprint,
  licence: { issued_at: '2030-03-10T00:00:00Z', valid_until: '2030-04-01T00:00:00Z', subscription: 'active', ...licence } });
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
const keysBody = (c, conns, at = NOW) => ({ generated_at: isoOf(at), box_key: c.identity.boxPublic, connections: conns });
const conn = (over = {}) => ({ id: 3, kind: 'partner', active: true, key_hash: hash('k3'), scopes: ['clinic', 'doctors'], rate_limit: 60,
  key_expires_at: null, ip_allow: [], origins: ['https://med24.uz'], ...over });
const snap = (slug, at = NOW) => ({ version: 1, generated_at: isoOf(at), slug, clinic: { name: { ru: 'Шифо' } }, branches: [], doctors: [], services: [], packages: [] });

test('лицензия: первая записывается; новее — заменяет; старее с тем же ключом — только «виделись»; старее с чужим ключом — отказ', () => {
  const { db } = testDb();
  const c = testClinic(vendor);
  assert.equal(admitClinic(db, auth(c), NOW).ok, true);
  admitClinic(db, auth(c, { issued_at: '2030-03-11T00:00:00Z', subscription: 'unpaid' }), NOW + 1000);
  assert.equal(clinicRow(db, c.clinicId).licence_subscription, 'unpaid');
  const back = admitClinic(db, auth(c, { issued_at: '2030-03-09T00:00:00Z', subscription: 'active' }), NOW + 2000);
  assert.equal(back.ok, true);
  assert.equal(back.clinic.licence_subscription, 'unpaid', 'старая лицензия без отметки не снимает «не оплачено» (решение 17)');
  assert.equal(back.clinic.last_seen_at, isoOf(NOW + 2000));
  const stolen = testClinic(vendor);
  const r = admitClinic(db, { ...auth(stolen, { issued_at: '2030-03-09T00:00:00Z' }), clinicId: c.clinicId }, NOW);
  assert.deepEqual(r, { ok: false, code: 'licence_outdated' });
});

test('новый ключ клиники в новой лицензии — прежний ящик забыт до нового PUT /keys', () => {
  const { db } = testDb();
  const c = testClinic(vendor);
  admitClinic(db, auth(c), NOW);
  saveKeys(db, c.clinicId, keysBody(c, [conn()]), NOW);
  assert.equal(clinicRow(db, c.clinicId).box_key, c.identity.boxPublic);
  const fresh = testClinic(vendor);
  admitClinic(db, { ...auth(fresh, { issued_at: '2030-03-12T00:00:00Z' }), clinicId: c.clinicId }, NOW);
  const row = clinicRow(db, c.clinicId);
  assert.equal(row.key_fp, fresh.identity.fingerprint);
  assert.equal(row.box_key, null);
});

test('ключи: список заменяется целиком, «последний запрос» переживает замену, мусор не роняет список', () => {
  const { db } = testDb();
  const c = testClinic(vendor);
  admitClinic(db, auth(c), NOW);
  assert.deepEqual(saveKeys(db, c.clinicId, keysBody(c, [conn(), conn({ id: 4, key_hash: hash('k4') })]), NOW), { ok: true, connections: 2 });
  markUsed(db, c.clinicId, 3, NOW);
  saveKeys(db, c.clinicId, keysBody(c, [conn({ active: false, scopes: ['clinic', 'чужое'], key_expires_at: 'не дата', origins: ['javascript:x', 'https://Med24.uz'] }),
    { id: 9, key_hash: 'нет' }], NOW + 1000), NOW + 1000);
  const k = connectionByHash(db, c.clinicId, hash('k3'));
  assert.equal(k.active, 0);
  assert.deepEqual(k.scopes, ['clinic']);
  assert.equal(k.key_expires_at, '1970-01-01T00:00:00Z', 'неверный срок — истёк');
  assert.deepEqual(k.origins, ['https://med24.uz']);
  assert.equal(k.last_used_at, isoOf(NOW));
  assert.equal(connectionByHash(db, c.clinicId, hash('k4')), null, 'удалённое подключение исчезло');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM connections').get().n, 1, 'подключение без отпечатка пропущено');
  assert.deepEqual(saveKeys(db, c.clinicId, keysBody(c, [conn()], NOW), NOW + 2000), { ok: true, ignored: true }, 'старое не откатывает новое');
  assert.equal(connectionByHash(db, c.clinicId, hash('k3')).active, 0);
  assert.deepEqual(saveKeys(db, c.clinicId, { ...keysBody(c, []), box_key: 'мусор' }, NOW), { error: 'bad_request' });
  assert.equal(originAllowedForClinic(db, c.clinicId, 'https://med24.uz'), false, 'выключенное подключение сайт не открывает');
});

test('имя в адресе: занятость другой клиникой, прежнее имя 30 дней, своё прежнее — можно вернуть', () => {
  const { db } = testDb();
  const a = testClinic(vendor);
  const b = testClinic(vendor, { clinicId: 'c-000778' });
  admitClinic(db, auth(a), NOW);
  admitClinic(db, auth(b), NOW);
  assert.deepEqual(saveSnapshot(db, a.clinicId, snap('shifo'), NOW), { ok: true });
  assert.deepEqual(saveSnapshot(db, b.clinicId, snap('shifo'), NOW), { error: 'slug_taken' });
  assert.deepEqual(saveSnapshot(db, a.clinicId, snap('shifo-med', NOW + 1000), NOW + 1000), { ok: true });
  assert.equal(resolveSlug(db, 'shifo', NOW + 2000).clinic_id, a.clinicId, 'прежнее имя ещё работает');
  assert.equal(resolveSlug(db, 'SHIFO-MED', NOW + 2000).clinic_id, a.clinicId);
  assert.deepEqual(saveSnapshot(db, b.clinicId, snap('shifo'), NOW + 3000), { error: 'slug_taken' }, 'прежнее имя 30 дней занято');
  const later = NOW + 31 * 86400000;
  assert.equal(resolveSlug(db, 'shifo', later), null);
  assert.deepEqual(saveSnapshot(db, b.clinicId, snap('shifo', later), later), { ok: true });
  assert.deepEqual(saveSnapshot(db, a.clinicId, snap('api', later), later), { error: 'bad_slug' });
  assert.deepEqual(saveSnapshot(db, a.clinicId, { slug: 'x' }, later), { error: 'bad_request' });
  assert.deepEqual(saveSnapshot(db, a.clinicId, snap('shifo-med', NOW), later), { ok: true, ignored: true });
  assert.equal(snapshotOf(clinicRow(db, a.clinicId)).clinic.name.ru, 'Шифо');
});

test('время: сохраняется, старое не откатывает новое', () => {
  const { db } = testDb();
  const c = testClinic(vendor);
  admitClinic(db, auth(c), NOW);
  assert.deepEqual(saveSlots(db, c.clinicId, { generated_at: isoOf(NOW), slot_minutes: 15, doctors: {} }, NOW), { ok: true });
  assert.deepEqual(saveSlots(db, c.clinicId, { generated_at: isoOf(NOW - 1000), doctors: {} }, NOW), { ok: true, ignored: true });
  assert.deepEqual(saveSlots(db, c.clinicId, { doctors: [] }, NOW), { error: 'bad_request' });
});

test('файлы: только чего нет; отпечаток и вид сверяются; партнёр получает только файл из текущего снимка; уборка', () => {
  const { db, dir } = testDb();
  const c = testClinic(vendor);
  admitClinic(db, auth(c), NOW);
  const png = fakePng(64, 64);
  const sha = crypto.createHash('sha256').update(png).digest('hex');
  assert.deepEqual(missingMedia(db, c.clinicId, [sha, 'мусор']), [sha]);
  assert.deepEqual(putMedia(db, dir, c.clinicId, sha, 'png', Buffer.from('<html>'), NOW), { error: 'bad_request' }, 'отпечаток не тот');
  assert.deepEqual(putMedia(db, dir, c.clinicId, sha, 'jpg', png, NOW), { error: 'bad_request' }, 'PNG под видом JPEG');
  assert.deepEqual(putMedia(db, dir, c.clinicId, sha, 'png', png, NOW), { ok: true });
  assert.deepEqual(missingMedia(db, c.clinicId, [sha]), []);
  assert.equal(mediaFile(db, dir, clinicRow(db, c.clinicId), sha, 'png'), null, 'в снимке его ещё нет');
  saveSnapshot(db, c.clinicId, { ...snap('shifo'), clinic: { logo: { square: 'media/' + sha + '.png' } } }, NOW);
  const f = mediaFile(db, dir, clinicRow(db, c.clinicId), sha, 'png');
  assert.equal(f.type, 'image/png');
  assert.deepEqual(fs.readFileSync(f.file), png);
  saveSnapshot(db, c.clinicId, snap('shifo', NOW + 1000), NOW + 1000);
  assert.deepEqual(gcMedia(db, dir, NOW + 2 * 86400000), { rows: 1, files: 1 });
  assert.equal(fs.existsSync(f.file), false);
});
