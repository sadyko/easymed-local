// PUBLIC_SERVER_V1 — СТРАЖИ РЕШЕНИЯ ВЛАДЕЛЬЦА 16 (сервер в Сингапуре, правовой
// риск принят): данных пациента на сервере — только шифротекст, и тела
// запросов не попадают ни в журнал процесса, ни в ответы.
//
//   1. Поток партнёра со всем, что может прийти: верные запись и заявка,
//      испорченный JSON, неверные поля, слишком большое тело, мусорный адрес
//      и параметры — метки пациента не находятся ни в одной ячейке базы, ни в
//      байтах её файлов, ни в журнале процесса, ни в ответах сервера.
//   2. Исходники: ни один вызов журнала не получает тело, запрос, данные
//      пациента или сообщение ошибки (у ошибки разбора JSON в сообщении — кусок тела).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicServer } from './app.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';
import { keyHash, newApiKey } from '../../server/services/api/secret-box.js';
import { admitClinic, saveKeys, saveSnapshot, saveSlots } from './store/clinics.js';
import { snapshotFixture, slotsFixture } from './test-helpers/partner-stand.js';
import { testDb, testVendor, testClinic, NOW } from './test-helpers/fixture.js';
import { isoOf } from './lib/time.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NAME = 'ИМЯ_ПАЦИЕНТА_СТРАЖ';
const PHONE = '998907654321';
const NOTE = 'ДИАГНОЗ_СТРАЖ';

test('поток партнёра с данными пациента: в базе, её файлах, журнале и ответах — только шифротекст', async (t) => {
  const logged = [];
  const log = {};
  for (const m of ['log', 'info', 'warn', 'error', 'debug']) log[m] = (...a) => logged.push(a.map(String).join(' '));
  const orig = {};
  for (const m of Object.keys(log)) { orig[m] = console[m]; console[m] = log[m]; }
  t.after(() => { for (const m of Object.keys(orig)) console[m] = orig[m]; });

  const { db, dir } = testDb();
  const vendor = testVendor();
  const clinic = testClinic(vendor);
  admitClinic(db, { clinicId: clinic.clinicId, fingerprint: clinic.identity.fingerprint,
    licence: { issued_at: '2030-03-10T00:00:00Z', valid_until: '2030-04-01T00:00:00Z', subscription: 'active' } }, NOW);
  const key = newApiKey();
  saveKeys(db, clinic.clinicId, { generated_at: isoOf(NOW), box_key: clinic.identity.boxPublic, connections: [{ id: 3, kind: 'partner', active: true,
    key_hash: keyHash(key), scopes: ['clinic', 'doctors', 'slots', 'requests', 'appointments', 'cancel'], rate_limit: 300, key_expires_at: null, ip_allow: [], origins: [] }] }, NOW);
  saveSnapshot(db, clinic.clinicId, snapshotFixture(), NOW);
  saveSlots(db, clinic.clinicId, slotsFixture(), NOW);
  const { app } = createPublicServer({ db, dataDir: dir, now: () => NOW, licencePublicKey: vendor.publicKey, offsetMin: 300, baseUrl: 'https://api.test',
    requireHttps: false, trustProxy: false, log });
  const server = await listen(app);
  t.after(() => new Promise((r) => server.close(r)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const answers = [];
  const send = async (method, p, body, type = 'application/json') => {
    const res = await fetch(base + p, { method, headers: { Authorization: 'Bearer ' + key, 'Content-Type': type }, body });
    answers.push(res.status + ' ' + await res.text());
    return res.status;
  };
  const patient = { name: NAME, phone: '+' + PHONE, comment: NOTE };
  assert.equal(await send('POST', '/shifo/v1/appointments', JSON.stringify({ doctor_id: 7, consultation: 'initial', start: '2030-03-12T09:00:00+05:00', patient })), 201);
  assert.equal(await send('POST', '/shifo/v1/requests', JSON.stringify({ ...patient, external_id: 'g-1' })), 201);
  assert.equal(await send('POST', '/shifo/v1/appointments', '{"patient":{"name":"' + NAME + '","phone":"' + PHONE), 400);
  assert.equal(await send('POST', '/shifo/v1/appointments', JSON.stringify({ doctor_id: 7, consultation: 'initial', start: NAME, patient })), 400);
  assert.equal(await send('POST', '/shifo/v1/appointments', JSON.stringify({ doctor_id: 7, consultation: 'initial', start: '2030-03-12T10:00:00+05:00',
    patient: { name: NAME, phone: NOTE } })), 400);
  assert.equal(await send('POST', '/shifo/v1/requests', JSON.stringify({ ...patient, pad: 'x'.repeat(40000) })), 413);
  assert.equal(await send('POST', '/shifo/v1/requests', NAME, 'text/plain'), 400);
  assert.equal(await send('GET', '/shifo/v1/' + encodeURIComponent(NAME) + '?name=' + encodeURIComponent(NAME) + '&phone=' + PHONE), 404);
  assert.equal(await send('POST', '/_sync/v1/events', JSON.stringify({ events: [{ seq: 1, body: NAME }] })), 401);

  db.pragma('wal_checkpoint(TRUNCATE)');
  const cells = [];
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) {
    for (const row of db.prepare(`SELECT * FROM ${name}`).all()) cells.push(...Object.values(row).map(String));
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM inbox WHERE sealed IS NOT NULL').get().n, 2, 'обе заявки — шифротекстом');
  const files = fs.readdirSync(dir).filter((f) => f.startsWith('public.db')).map((f) => fs.readFileSync(path.join(dir, f)));
  for (const mark of [NAME, PHONE, NOTE]) {
    assert.ok(!cells.some((c) => c.includes(mark)), 'в базе: ' + mark);
    assert.ok(!files.some((b) => b.includes(Buffer.from(mark, 'utf8'))), 'в файле базы: ' + mark);
    assert.ok(!logged.some((l) => l.includes(mark)), 'в журнале процесса: ' + mark);
    assert.ok(!answers.some((a) => a.includes(mark)), 'в ответе сервера: ' + mark);
  }
});

function sources(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'test-helpers' && e.name !== 'node_modules') sources(p, out); }
    else if (e.name.endsWith('.js') && !e.name.endsWith('.test.js')) out.push(p);
  }
  return out;
}

test('исходники: вызовы журнала не получают тело, запрос, пациента и сообщение ошибки; журнала запросов процесса нет', () => {
  const offenders = [];
  for (const file of sources(HERE)) {
    const rel = path.relative(HERE, file).split(path.sep).join('/');
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (/^\s*\/\//.test(line)) return;
      if (/\b(?:console|log)\.(?:log|info|warn|error|debug)\(/.test(line)) {
        if (/req\.|\bbody\b|\braw\b|patient|sealed|query|headers/.test(line)) offenders.push(rel + ':' + (i + 1) + ' — запрос/тело в журнале');
        if (/\.message\b/.test(line) && rel !== 'index.js') offenders.push(rel + ':' + (i + 1) + ' — сообщение ошибки в журнале');
      }
      if (/\bmorgan\b|express\.logger/.test(line)) offenders.push(rel + ':' + (i + 1) + ' — журнал запросов процесса');
    });
  }
  assert.deepEqual(offenders, []);
  assert.ok(sources(HERE).length >= 15, 'страж видит исходники');
});
